import { orderEntries } from "@/lib/ranking";
import type { DashboardData, Entry } from "@/lib/types";
import { all, getDb } from "@/server/lib/db";
import { type CategoryRow } from "@/server/stores/categoryStore";
import { type EntryRow, mapEntry } from "@/server/stores/entryStore";
import { getQueueSettings, listQueuedEntries } from "@/server/stores/queueStore";
import { ensureUserProfile, mapCurrentUserProfile } from "@/server/stores/profileStore";
import { getActiveBinarySession, repairInterruptedRankingState } from "@/server/engine/rankingSessions";
import { getActiveRepairSession, repairInterruptedRepairState } from "@/server/engine/repairSessions";

const SLOW_DASHBOARD_LOAD_MS = 750;
const LARGE_DASHBOARD_CATEGORY_COUNT = 100;
const LARGE_DASHBOARD_ENTRY_COUNT = 1_000;
const LARGE_DASHBOARD_QUEUE_COUNT = 500;

interface DashboardFreshnessRow {
    category_updated_at: number;
    entry_updated_at: number;
    queue_updated_at: number;
    queue_settings_updated_at: number;
    profile_updated_at: number;
    ranking_state: string;
    repair_state: string;
}

interface DashboardRecoveryCheckRow {
    has_active_ranking_session: number;
    has_active_repair_session: number;
    has_orphaned_ranking_entry: number;
}

export async function getDashboardRevision(userId: string) {
    const row = await getDb()
        .prepare(
            `SELECT
               COALESCE((
                 SELECT updated_at FROM categories
                 WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1
               ), 0) AS category_updated_at,
               COALESCE((
                 SELECT updated_at FROM entries
                 WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1
               ), 0) AS entry_updated_at,
               COALESCE((
                 SELECT updated_at FROM entry_queue
                 WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1
               ), 0) AS queue_updated_at,
               COALESCE((
                 SELECT updated_at FROM queue_settings WHERE user_id = ?
               ), 0) AS queue_settings_updated_at,
               COALESCE((
                 SELECT updated_at FROM user_profiles WHERE user_id = ?
               ), 0) AS profile_updated_at,
               COALESCE((
                 SELECT id || ':' || comparison_count || ':' || phase || ':' ||
                        lower_bound || ':' || upper_bound || ':' ||
                        COALESCE(pivot_entry_id, '')
                 FROM ranking_sessions
                 WHERE user_id = ? AND status = 'active'
                 ORDER BY created_at DESC LIMIT 1
               ), '') AS ranking_state,
               COALESCE((
                 SELECT id || ':' || updated_at
                 FROM repair_sessions
                 WHERE user_id = ? AND status = 'active'
                 ORDER BY created_at DESC LIMIT 1
               ), '') AS repair_state`
        )
        .bind(userId, userId, userId, userId, userId, userId, userId)
        .first<DashboardFreshnessRow>();

    return JSON.stringify([
        row?.category_updated_at ?? 0,
        row?.entry_updated_at ?? 0,
        row?.queue_updated_at ?? 0,
        row?.queue_settings_updated_at ?? 0,
        row?.profile_updated_at ?? 0,
        row?.ranking_state ?? "",
        row?.repair_state ?? ""
    ]);
}

/**
 * Assembles the full dashboard payload for a user: categories with ordered
 * entries, the ranking queue, any active binary-ranking session, and the
 * current-user profile. Server-only; shared by the `loadDashboard` server
 * function and the `/` route's `loadHome` (which resolves the session once).
 */
export async function buildDashboard(userId: string): Promise<DashboardData> {
    const startedAt = Date.now();
    const db = getDb();
    await repairDashboardStateIfNeeded(userId);
    const profile = await ensureUserProfile(userId);
    const revision = await getDashboardRevision(userId);
    const queueSettings = await getQueueSettings(userId);
    const queuedEntries = await listQueuedEntries(userId);
    const activeBinarySession = await getActiveBinarySession(userId);
    const activeRepairSession = await getActiveRepairSession(userId);
    const categories = await all<CategoryRow>(
        db
            .prepare(
                `SELECT id, name, sort_order, created_at, is_public
             FROM categories
             WHERE user_id = ?
             ORDER BY sort_order ASC, name ASC`
            )
            .bind(userId)
    );

    if (categories.length === 0) {
        const dashboard = {
            revision,
            categories: [],
            queueSettings,
            queuedEntries,
            activeBinarySession,
            activeRepairSession,
            profile: mapCurrentUserProfile(profile)
        };
        logDashboardLoadIfNeeded(startedAt, {
            categoryCount: 0,
            entryCount: 0,
            queuedEntryCount: queuedEntries.length,
            hasActiveBinarySession: Boolean(activeBinarySession),
            hasActiveRepairSession: Boolean(activeRepairSession)
        });
        return dashboard;
    }

    const entryRows = await all<EntryRow>(
        db
            .prepare(
                `SELECT id, category_id, name, rank_position, image_key, created_at
             FROM entries
             WHERE user_id = ? AND status = 'active'
             ORDER BY category_id ASC, rank_position ASC`
            )
            .bind(userId)
    );
    const entriesByCategory = new Map<string, Entry[]>();
    for (const row of entryRows) {
        const entries = entriesByCategory.get(row.category_id) ?? [];
        entries.push(mapEntry(row));
        entriesByCategory.set(row.category_id, entries);
    }

    const dashboard = {
        revision,
        categories: categories.map((category) => ({
            id: category.id,
            name: category.name,
            sortOrder: category.sort_order,
            createdAt: category.created_at,
            isPublic: Boolean(category.is_public),
            entries: orderEntries(entriesByCategory.get(category.id) ?? [])
        })),
        queueSettings,
        queuedEntries,
        activeBinarySession,
        activeRepairSession,
        profile: mapCurrentUserProfile(profile)
    };
    logDashboardLoadIfNeeded(startedAt, {
        categoryCount: categories.length,
        entryCount: entryRows.length,
        queuedEntryCount: queuedEntries.length,
        hasActiveBinarySession: Boolean(activeBinarySession),
        hasActiveRepairSession: Boolean(activeRepairSession)
    });
    return dashboard;
}

/**
 * Recovery is essential when a prior ranking request was interrupted, but the
 * detailed recovery joins are needlessly expensive for the normal dashboard
 * path. A single indexed existence check lets ordinary page loads skip them.
 */
async function repairDashboardStateIfNeeded(userId: string) {
    const row = await getDb()
        .prepare(
            `SELECT
               EXISTS(
                 SELECT 1 FROM ranking_sessions
                 WHERE user_id = ? AND status = 'active'
               ) AS has_active_ranking_session,
               EXISTS(
                 SELECT 1 FROM repair_sessions
                 WHERE user_id = ? AND status = 'active'
               ) AS has_active_repair_session,
               EXISTS(
                 SELECT 1 FROM entries
                 WHERE user_id = ? AND status = 'ranking'
               ) AS has_orphaned_ranking_entry`
        )
        .bind(userId, userId, userId)
        .first<DashboardRecoveryCheckRow>();

    if (row?.has_active_ranking_session || row?.has_orphaned_ranking_entry) {
        await repairInterruptedRankingState(userId);
    }
    if (row?.has_active_repair_session) {
        await repairInterruptedRepairState(userId);
    }
}

function logDashboardLoadIfNeeded(
    startedAt: number,
    metrics: {
        categoryCount: number;
        entryCount: number;
        queuedEntryCount: number;
        hasActiveBinarySession: boolean;
        hasActiveRepairSession: boolean;
    }
) {
    const durationMs = Date.now() - startedAt;
    if (
        durationMs < SLOW_DASHBOARD_LOAD_MS &&
        metrics.categoryCount < LARGE_DASHBOARD_CATEGORY_COUNT &&
        metrics.entryCount < LARGE_DASHBOARD_ENTRY_COUNT &&
        metrics.queuedEntryCount < LARGE_DASHBOARD_QUEUE_COUNT
    ) {
        return;
    }

    console.warn("[goldshelf] dashboard_load_heavy", {
        durationMs,
        ...metrics
    });
}
