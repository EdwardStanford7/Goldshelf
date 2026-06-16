import {
    REPAIR_ADJACENT_GAP_THRESHOLD,
    addRecentRepairPair,
    addRepairComparison,
    advancePairRepairState,
    chooseRepairMatchup,
    emptyRepairOperationState,
    parseRepairOperationState,
    pickWeightedRepairCategory,
    serializeRepairOperationState,
    startAdjacentRepairState,
    startBinaryReinsertRepairState,
    type RepairOperationState,
    type RepairScope,
    type RepairSessionPhase,
    type RepairStrategy
} from "@/lib/repair";
import type { ActiveRepairSession, RepairSessionView } from "@/lib/types";
import { all, assertOwned, first, getDb, newId, now } from "@/server/lib/db";
import { getOwnedCategory } from "@/server/stores/categoryStore";
import {
    getOwnedEntry,
    listActiveEntries,
    rewriteCategoryOrderStatements
} from "@/server/stores/entryStore";

interface RepairSessionRow {
    id: string;
    user_id: string;
    scope: RepairScope;
    scope_category_id: string | null;
    active_category_id: string;
    entry_a_id: string | null;
    entry_b_id: string | null;
    status: "active" | "completed" | "cancelled";
    phase: RepairSessionPhase;
    strategy: RepairStrategy;
    comparison_count: number;
    repair_count: number;
    operation_state: string | null;
    created_at: number;
    updated_at: number;
    completed_at: number | null;
}

interface ActiveRepairSessionRow {
    id: string;
    scope: RepairScope;
    scope_category_id: string | null;
    active_category_id: string;
    category_name: string;
}

interface RepairCategoryCandidate {
    id: string;
    name: string;
    entryCount: number;
}

interface RepairMatchup {
    categoryId: string;
    categoryName: string;
    higherEntryId: string;
    lowerEntryId: string;
    gap: number;
}

interface RepairValidityRow {
    id: string;
    active_category_exists: string | null;
    entry_a_exists: string | null;
    entry_b_exists: string | null;
    scope_category_exists: string | null;
    scope_category_id: string | null;
}

export async function getActiveRepairSession(userId: string): Promise<ActiveRepairSession | null> {
    const row = await first<ActiveRepairSessionRow>(
        getDb()
            .prepare(
                `SELECT repair_sessions.id, repair_sessions.scope,
                        repair_sessions.scope_category_id,
                        repair_sessions.active_category_id,
                        categories.name AS category_name
                 FROM repair_sessions
                 INNER JOIN categories
                   ON categories.id = repair_sessions.active_category_id
                  AND categories.user_id = repair_sessions.user_id
                 WHERE repair_sessions.user_id = ?
                   AND repair_sessions.status = 'active'
                 ORDER BY repair_sessions.created_at DESC
                 LIMIT 1`
            )
            .bind(userId)
    );

    return row
        ? {
            id: row.id,
            scope: row.scope,
            scopeCategoryId: row.scope_category_id,
            categoryId: row.active_category_id,
            categoryName: row.category_name
        }
        : null;
}

export async function getRepairSessionView(
    userId: string,
    sessionId: string
): Promise<RepairSessionView | null> {
    const row = await getActiveRepairRow(userId, sessionId);
    if (!row?.entry_a_id || !row.entry_b_id) {
        return null;
    }

    const category = await getOwnedCategory(userId, row.active_category_id);
    const subject = await getOwnedEntry(userId, row.entry_a_id);
    const opponent = await getOwnedEntry(userId, row.entry_b_id);
    if (!category || !subject || !opponent) {
        return null;
    }

    return {
        id: row.id,
        scope: row.scope,
        scopeCategoryId: row.scope_category_id,
        categoryId: category.id,
        categoryName: category.name,
        phase: row.phase,
        strategy: row.strategy,
        subject,
        opponent,
        comparisonCount: row.comparison_count,
        repairCount: row.repair_count
    };
}

export async function startRepairSession(
    userId: string,
    input: { categoryId?: string | null }
) {
    await repairInterruptedRepairState(userId);
    await assertNoActiveBinaryRankingSession(userId);
    await assertNoActiveRepairSession(userId);

    const scopeCategoryId = input.categoryId?.trim() || null;
    if (scopeCategoryId) {
        const category = await getOwnedCategory(userId, scopeCategoryId);
        assertOwned(category, "Category");
    }

    const state = emptyRepairOperationState();
    const scope: RepairScope = scopeCategoryId ? "category" : "all";
    const matchup = await chooseNextRepairMatchup(userId, scope, scopeCategoryId, state);
    if (!matchup) {
        throw new Error(scopeCategoryId
            ? "This category needs at least two ranked entries before repair mode can start."
            : "Add at least two ranked entries to a category before starting repair mode.");
    }

    applyMatchupToState(state, matchup);

    const db = getDb();
    const sessionId = newId("repair");
    const createdAt = now();
    await db
        .prepare(
            `INSERT INTO repair_sessions (
               id, user_id, scope, scope_category_id, active_category_id,
               entry_a_id, entry_b_id, status, phase, strategy,
               comparison_count, repair_count, operation_state, created_at, updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'checking', 'none', 0, 0, ?, ?, ?)`
        )
        .bind(
            sessionId,
            userId,
            scope,
            scopeCategoryId,
            matchup.categoryId,
            matchup.higherEntryId,
            matchup.lowerEntryId,
            serializeRepairOperationState(state),
            createdAt,
            createdAt
        )
        .run();

    return {
        kind: "session" as const,
        sessionId,
        categoryId: matchup.categoryId
    };
}

export async function submitRepairWinner(
    userId: string,
    input: { sessionId: string; winnerId: string }
) {
    const db = getDb();
    const row = await getActiveRepairRow(userId, input.sessionId);
    assertOwned(row, "Repair session");
    const state = parseRepairOperationState(row.operation_state);
    const currentComparison = currentRepairComparison(row, state);
    if (!currentComparison) {
        throw new Error("Repair session has no active matchup");
    }

    if (
        input.winnerId !== currentComparison.entryAId &&
        input.winnerId !== currentComparison.entryBId
    ) {
        throw new Error("Winner must be one of the active repair entries");
    }

    const loserId = input.winnerId === currentComparison.entryAId
        ? currentComparison.entryBId
        : currentComparison.entryAId;
    const nextState = addRepairComparison(state, input.winnerId, loserId);
    const updatedAt = now();

    if (row.phase === "checking") {
        return submitRepairCheckWinner(db, userId, row, nextState, input.winnerId, updatedAt);
    }

    return submitActiveRepairWinner(db, userId, row, nextState, updatedAt);
}

export async function skipRepairMatchup(
    userId: string,
    input: { sessionId: string }
) {
    const db = getDb();
    const row = await getActiveRepairRow(userId, input.sessionId);
    assertOwned(row, "Repair session");
    if (row.phase !== "checking") {
        throw new Error("Finish the active repair before skipping.");
    }

    const state = parseRepairOperationState(row.operation_state);
    const nextMatchup = await chooseNextRepairMatchup(userId, row.scope, row.scope_category_id, state);
    if (!nextMatchup) {
        await completeRepairSession(db, userId, row.id, now());
        return { kind: "completed" as const, sessionId: row.id };
    }

    applyMatchupToState(state, nextMatchup);
    await updateSessionWithMatchup(db, userId, row, state, nextMatchup, {
        comparisonIncrement: 0,
        repairIncrement: 0,
        updatedAt: now()
    });
    return { kind: "session" as const, sessionId: row.id };
}

export async function cancelRepairSession(
    userId: string,
    input: { sessionId: string }
) {
    const db = getDb();
    const row = await getActiveRepairRow(userId, input.sessionId);
    assertOwned(row, "Repair session");
    await db
        .prepare(
            `UPDATE repair_sessions
             SET status = 'cancelled',
                 completed_at = ?,
                 updated_at = ?
             WHERE id = ? AND user_id = ? AND status = 'active'`
        )
        .bind(now(), now(), row.id, userId)
        .run();
}

export async function repairInterruptedRepairState(userId: string) {
    const db = getDb();
    const rows = await all<RepairValidityRow>(
        db
            .prepare(
                `SELECT repair_sessions.id,
                        repair_sessions.scope_category_id,
                        active_category.id AS active_category_exists,
                        scope_category.id AS scope_category_exists,
                        entry_a.id AS entry_a_exists,
                        entry_b.id AS entry_b_exists
                 FROM repair_sessions
                 LEFT JOIN categories active_category
                   ON active_category.id = repair_sessions.active_category_id
                  AND active_category.user_id = repair_sessions.user_id
                 LEFT JOIN categories scope_category
                   ON scope_category.id = repair_sessions.scope_category_id
                  AND scope_category.user_id = repair_sessions.user_id
                 LEFT JOIN entries entry_a
                   ON entry_a.id = repair_sessions.entry_a_id
                  AND entry_a.user_id = repair_sessions.user_id
                  AND entry_a.status = 'active'
                 LEFT JOIN entries entry_b
                   ON entry_b.id = repair_sessions.entry_b_id
                  AND entry_b.user_id = repair_sessions.user_id
                  AND entry_b.status = 'active'
                 WHERE repair_sessions.user_id = ?
                   AND repair_sessions.status = 'active'`
            )
            .bind(userId)
    );

    const invalidRows = rows.filter((row) =>
        !row.active_category_exists ||
        !row.entry_a_exists ||
        !row.entry_b_exists ||
        (row.scope_category_id && !row.scope_category_exists)
    );
    if (invalidRows.length === 0) {
        return;
    }

    const updatedAt = now();
    await db.batch(invalidRows.map((row) =>
        db
            .prepare(
                `UPDATE repair_sessions
                 SET status = 'cancelled',
                     completed_at = ?,
                     updated_at = ?
                 WHERE id = ? AND user_id = ? AND status = 'active'`
            )
            .bind(updatedAt, updatedAt, row.id, userId)
    ));
}

export async function assertNoActiveRepairSession(userId: string) {
    const activeRepair = await getActiveRepairSession(userId);
    if (activeRepair) {
        throw new Error("Finish or cancel the active repair mode before starting another ranking.");
    }
}

async function submitRepairCheckWinner(
    db: D1Database,
    userId: string,
    row: RepairSessionRow,
    state: RepairOperationState,
    winnerId: string,
    updatedAt: number
) {
    const check = state.currentCheck;
    if (!check) {
        throw new Error("Repair session has no active check");
    }

    if (winnerId === check.higherEntryId) {
        const nextMatchup = await chooseNextRepairMatchup(userId, row.scope, row.scope_category_id, state);
        if (!nextMatchup) {
            await completeRepairSession(db, userId, row.id, updatedAt);
            return { kind: "completed" as const, sessionId: row.id };
        }

        applyMatchupToState(state, nextMatchup);
        await updateSessionWithMatchup(db, userId, row, state, nextMatchup, {
            comparisonIncrement: 1,
            repairIncrement: 0,
            updatedAt
        });
        return { kind: "session" as const, sessionId: row.id };
    }

    if (winnerId !== check.lowerEntryId) {
        throw new Error("Winner must be one of the active repair entries");
    }

    const entries = await listActiveEntries(userId, check.categoryId);
    const orderedEntryIds = entries.map((entry) => entry.id);
    const repair = check.gap <= REPAIR_ADJACENT_GAP_THRESHOLD
        ? startAdjacentRepairState(orderedEntryIds, check.lowerEntryId, check.higherEntryId)
        : startBinaryReinsertRepairState(orderedEntryIds, check.lowerEntryId, check.higherEntryId);
    const result = advancePairRepairState(repair, state.comparisons);
    state.currentCheck = null;
    state.repair = result.state;

    if (result.complete) {
        return commitRepairAndContinue(db, userId, row, state, result.state.workingOrderIds, {
            comparisonIncrement: 1,
            repairIncrement: 1,
            updatedAt
        });
    }

    await updateSessionWithRepairPrompt(db, userId, row, state, result.state, {
        comparisonIncrement: 1,
        repairIncrement: 1,
        updatedAt
    });
    return { kind: "session" as const, sessionId: row.id };
}

async function submitActiveRepairWinner(
    db: D1Database,
    userId: string,
    row: RepairSessionRow,
    state: RepairOperationState,
    updatedAt: number
) {
    if (!state.repair) {
        throw new Error("Repair session has no active repair state");
    }

    const result = advancePairRepairState(state.repair, state.comparisons);
    state.repair = result.state;
    if (result.complete) {
        return commitRepairAndContinue(db, userId, row, state, result.state.workingOrderIds, {
            comparisonIncrement: 1,
            repairIncrement: 0,
            updatedAt
        });
    }

    await updateSessionWithRepairPrompt(db, userId, row, state, result.state, {
        comparisonIncrement: 1,
        repairIncrement: 0,
        updatedAt
    });
    return { kind: "session" as const, sessionId: row.id };
}

async function commitRepairAndContinue(
    db: D1Database,
    userId: string,
    row: RepairSessionRow,
    state: RepairOperationState,
    orderedEntryIds: string[],
    options: {
        comparisonIncrement: number;
        repairIncrement: number;
        updatedAt: number;
    }
) {
    await db.batch([
        ...rewriteCategoryOrderStatements(db, userId, row.active_category_id, orderedEntryIds, options.updatedAt),
        db
            .prepare(
                `UPDATE repair_sessions
                 SET comparison_count = comparison_count + ?,
                     repair_count = repair_count + ?,
                     updated_at = ?
                 WHERE id = ? AND user_id = ? AND status = 'active'`
            )
            .bind(
                options.comparisonIncrement,
                options.repairIncrement,
                options.updatedAt,
                row.id,
                userId
            )
    ]);

    state.repair = null;
    state.currentCheck = null;
    const nextMatchup = await chooseNextRepairMatchup(userId, row.scope, row.scope_category_id, state);
    if (!nextMatchup) {
        await completeRepairSession(db, userId, row.id, options.updatedAt);
        return { kind: "completed" as const, sessionId: row.id };
    }

    applyMatchupToState(state, nextMatchup);
    await updateSessionWithMatchup(db, userId, row, state, nextMatchup, {
        comparisonIncrement: 0,
        repairIncrement: 0,
        updatedAt: now()
    });
    return { kind: "session" as const, sessionId: row.id };
}

async function updateSessionWithRepairPrompt(
    db: D1Database,
    userId: string,
    row: RepairSessionRow,
    state: RepairOperationState,
    repair: NonNullable<RepairOperationState["repair"]>,
    options: {
        comparisonIncrement: number;
        repairIncrement: number;
        updatedAt: number;
    }
) {
    const comparison = repair.currentComparison;
    if (!comparison) {
        throw new Error("Repair state has no active matchup");
    }

    await db
        .prepare(
            `UPDATE repair_sessions
             SET active_category_id = ?,
                 entry_a_id = ?,
                 entry_b_id = ?,
                 phase = ?,
                 strategy = ?,
                 operation_state = ?,
                 comparison_count = comparison_count + ?,
                 repair_count = repair_count + ?,
                 updated_at = ?
             WHERE id = ? AND user_id = ? AND status = 'active'`
        )
        .bind(
            row.active_category_id,
            comparison.entryAId,
            comparison.entryBId,
            repair.kind === "adjacent" ? "local_repair" : "binary_repair",
            repair.kind === "adjacent" ? "adjacent" : "binary_reinsert",
            serializeRepairOperationState(state),
            options.comparisonIncrement,
            options.repairIncrement,
            options.updatedAt,
            row.id,
            userId
        )
        .run();
}

async function updateSessionWithMatchup(
    db: D1Database,
    userId: string,
    row: Pick<RepairSessionRow, "id">,
    state: RepairOperationState,
    matchup: RepairMatchup,
    options: {
        comparisonIncrement: number;
        repairIncrement: number;
        updatedAt: number;
    }
) {
    await db
        .prepare(
            `UPDATE repair_sessions
             SET active_category_id = ?,
                 entry_a_id = ?,
                 entry_b_id = ?,
                 phase = 'checking',
                 strategy = 'none',
                 operation_state = ?,
                 comparison_count = comparison_count + ?,
                 repair_count = repair_count + ?,
                 updated_at = ?
             WHERE id = ? AND user_id = ? AND status = 'active'`
        )
        .bind(
            matchup.categoryId,
            matchup.higherEntryId,
            matchup.lowerEntryId,
            serializeRepairOperationState(state),
            options.comparisonIncrement,
            options.repairIncrement,
            options.updatedAt,
            row.id,
            userId
        )
        .run();
}

async function chooseNextRepairMatchup(
    userId: string,
    scope: RepairScope,
    scopeCategoryId: string | null,
    state: RepairOperationState
): Promise<RepairMatchup | null> {
    if (scope === "category" && scopeCategoryId) {
        const category = await getOwnedCategory(userId, scopeCategoryId);
        if (!category) {
            return null;
        }

        const entries = await listActiveEntries(userId, category.id);
        const choice = chooseRepairMatchup(entries, state.recentPairs);
        return choice
            ? {
                categoryId: category.id,
                categoryName: category.name,
                ...choice
            }
            : null;
    }

    const candidates = await all<RepairCategoryCandidate>(
        getDb()
            .prepare(
                `SELECT categories.id, categories.name, COUNT(entries.id) AS entryCount
                 FROM categories
                 INNER JOIN entries
                   ON entries.category_id = categories.id
                  AND entries.user_id = categories.user_id
                  AND entries.status = 'active'
                 WHERE categories.user_id = ?
                 GROUP BY categories.id, categories.name
                 HAVING entryCount >= 2
                 ORDER BY categories.sort_order ASC, categories.name ASC`
            )
            .bind(userId)
    );
    if (candidates.length === 0) {
        return null;
    }

    for (let attempt = 0; attempt < 10; attempt += 1) {
        const category = pickWeightedRepairCategory(candidates);
        if (!category) {
            return null;
        }

        const entries = await listActiveEntries(userId, category.id);
        const choice = chooseRepairMatchup(entries, state.recentPairs);
        if (choice) {
            return {
                categoryId: category.id,
                categoryName: category.name,
                ...choice
            };
        }
    }

    const fallbackCategory = candidates[0];
    if (!fallbackCategory) {
        return null;
    }

    const entries = await listActiveEntries(userId, fallbackCategory.id);
    const fallbackChoice = chooseRepairMatchup(entries, state.recentPairs);
    return fallbackChoice
        ? {
            categoryId: fallbackCategory.id,
            categoryName: fallbackCategory.name,
            ...fallbackChoice
        }
        : null;
}

function applyMatchupToState(state: RepairOperationState, matchup: RepairMatchup) {
    state.currentCheck = {
        categoryId: matchup.categoryId,
        higherEntryId: matchup.higherEntryId,
        lowerEntryId: matchup.lowerEntryId,
        gap: matchup.gap
    };
    state.repair = null;
    state.recentPairs = addRecentRepairPair(
        state.recentPairs,
        matchup.higherEntryId,
        matchup.lowerEntryId
    );
}

function currentRepairComparison(
    row: RepairSessionRow,
    state: RepairOperationState
) {
    if (row.phase === "checking") {
        return state.currentCheck
            ? {
                entryAId: state.currentCheck.higherEntryId,
                entryBId: state.currentCheck.lowerEntryId
            }
            : null;
    }

    return state.repair?.currentComparison ?? null;
}

async function completeRepairSession(
    db: D1Database,
    userId: string,
    sessionId: string,
    updatedAt: number
) {
    await db
        .prepare(
            `UPDATE repair_sessions
             SET status = 'completed',
                 completed_at = ?,
                 updated_at = ?
             WHERE id = ? AND user_id = ? AND status = 'active'`
        )
        .bind(updatedAt, updatedAt, sessionId, userId)
        .run();
}

async function getActiveRepairRow(userId: string, sessionId: string) {
    return first<RepairSessionRow>(
        getDb()
            .prepare(
                `SELECT id, user_id, scope, scope_category_id, active_category_id,
                        entry_a_id, entry_b_id, status, phase, strategy,
                        comparison_count, repair_count, operation_state,
                        created_at, updated_at, completed_at
                 FROM repair_sessions
                 WHERE id = ? AND user_id = ? AND status = 'active'`
            )
            .bind(sessionId, userId)
    );
}

async function assertNoActiveBinaryRankingSession(userId: string) {
    const activeRanking = await first<{ id: string }>(
        getDb()
            .prepare(
                `SELECT id
                 FROM ranking_sessions
                 WHERE user_id = ? AND status = 'active'
                 LIMIT 1`
            )
            .bind(userId)
    );
    if (activeRanking) {
        throw new Error("Finish or cancel the active ranking before starting repair mode.");
    }
}
