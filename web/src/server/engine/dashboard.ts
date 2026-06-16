import { orderEntries } from "@/lib/ranking";
import type { DashboardData, Entry } from "@/lib/types";
import { all, getDb } from "@/server/lib/db";
import { type CategoryRow } from "@/server/stores/categoryStore";
import { type EntryRow, mapEntry } from "@/server/stores/entryStore";
import { getQueueSettings, listQueuedEntries } from "@/server/stores/queueStore";
import { ensureUserProfile, mapCurrentUserProfile } from "@/server/stores/profileStore";
import { getActiveBinarySession, repairInterruptedRankingState } from "@/server/engine/rankingSessions";
import { getActiveRepairSession, repairInterruptedRepairState } from "@/server/engine/repairSessions";
import { purgeExpiredDeletedItems } from "@/server/engine/maintenance";

/**
 * Assembles the full dashboard payload for a user: categories with ordered
 * entries, the ranking queue, any active binary-ranking session, and the
 * current-user profile. Server-only; shared by the `loadDashboard` server
 * function and the `/` route's `loadHome` (which resolves the session once).
 */
export async function buildDashboard(userId: string): Promise<DashboardData> {
    const db = getDb();
    await repairInterruptedRankingState(userId);
    await repairInterruptedRepairState(userId);
    await purgeExpiredDeletedItems(userId);
    const profile = await ensureUserProfile(userId);
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
        return {
            categories: [],
            queueSettings,
            queuedEntries,
            activeBinarySession,
            activeRepairSession,
            profile: mapCurrentUserProfile(profile)
        };
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

    return {
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
}
