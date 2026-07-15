import { parseRankingOperationState } from "./rankingState";
import { all, first, runBatches } from "@/server/lib/db";

const MAX_EXISTENCE_CHECK_IDS = 90;
const UNDO_RESTORE_BATCH_SIZE = 10;

interface EntryStateSnapshot {
    id: string;
    categoryId: string;
    status: string;
    rankPosition: number;
    updatedAt: number;
}

interface QueueRowSnapshot {
    id: string;
    userId: string;
    categoryId: string;
    name: string;
    imageKey: string | null;
    status: string;
    createdAt: number;
    updatedAt: number;
}

interface RankingSessionSnapshot {
    id: string;
    categoryId: string;
    subjectEntryId: string;
    source: string;
    fromCategoryId: string | null;
    lowerBound: number;
    upperBound: number;
    pivotEntryId: string | null;
    pivotRankPosition: number | null;
    finalRankPosition: number | null;
    originalRankPosition: number | null;
    comparisonCount: number;
    phase: string;
    operationKind: string;
    secondaryEntryId: string | null;
    secondaryOriginalRankPosition: number | null;
    operationState: string | null;
}

interface RepairSessionSnapshot {
    id: string;
    scope: string;
    scopeCategoryId: string | null;
    activeCategoryId: string;
    entryAId: string | null;
    entryBId: string | null;
    phase: string;
    strategy: string;
    comparisonCount: number;
    repairCount: number;
    operationState: string | null;
    updatedAt: number;
}

interface RankingUndoSnapshot {
    kind: "ranking_match_undo";
    version: 1;
    session: RankingSessionSnapshot;
    entries: EntryStateSnapshot[];
    queuedEntry: QueueRowSnapshot | null;
}

interface RepairUndoSnapshot {
    kind: "repair_match_undo";
    version: 1;
    session: RepairSessionSnapshot;
    entries: EntryStateSnapshot[];
}

interface EntryStateRow {
    id: string;
    category_id: string;
    status: string;
    rank_position: number;
    updated_at: number;
}

interface QueueSnapshotRow {
    id: string;
    user_id: string;
    category_id: string;
    name: string;
    image_key: string | null;
    status: string;
    created_at: number;
    updated_at: number;
}

export interface RankingUndoSourceRow {
    id: string;
    category_id: string;
    subject_entry_id: string;
    source: string;
    from_category_id: string | null;
    lower_bound: number;
    upper_bound: number;
    pivot_entry_id: string | null;
    pivot_rank_position: number | null;
    final_rank_position: number | null;
    original_rank_position?: number | null;
    comparison_count?: number | null;
    phase?: string | null;
    operation_kind?: string | null;
    secondary_entry_id?: string | null;
    secondary_original_rank_position?: number | null;
    operation_state?: string | null;
}

export interface RepairUndoSourceRow {
    id: string;
    scope: string;
    scope_category_id: string | null;
    active_category_id: string;
    entry_a_id: string | null;
    entry_b_id: string | null;
    phase: string;
    strategy: string;
    comparison_count: number;
    repair_count: number;
    operation_state: string | null;
    updated_at: number;
}

export async function saveRankingMatchUndoState(
    db: D1Database,
    userId: string,
    session: RankingUndoSourceRow
) {
    const operationState = parseRankingOperationState(session.operation_state);
    const undoState: RankingUndoSnapshot = {
        kind: "ranking_match_undo",
        version: 1,
        session: {
            id: session.id,
            categoryId: session.category_id,
            subjectEntryId: session.subject_entry_id,
            source: session.source,
            fromCategoryId: session.from_category_id,
            lowerBound: session.lower_bound,
            upperBound: session.upper_bound,
            pivotEntryId: session.pivot_entry_id,
            pivotRankPosition: session.pivot_rank_position,
            finalRankPosition: session.final_rank_position,
            originalRankPosition: session.original_rank_position ?? null,
            comparisonCount: session.comparison_count ?? 0,
            phase: session.phase ?? "binary",
            operationKind: session.operation_kind ?? "single",
            secondaryEntryId: session.secondary_entry_id ?? null,
            secondaryOriginalRankPosition: session.secondary_original_rank_position ?? null,
            operationState: session.operation_state ?? null
        },
        entries: await snapshotCategoryEntries(db, userId, session.category_id),
        queuedEntry: operationState.queuedEntryId
            ? await snapshotQueuedEntry(db, userId, operationState.queuedEntryId)
            : null
    };

    await db
        .prepare(
            `UPDATE ranking_sessions
             SET undo_state = ?
             WHERE id = ? AND user_id = ? AND status = 'active'`
        )
        .bind(JSON.stringify(undoState), session.id, userId)
        .run();
}

export async function saveRepairMatchUndoState(
    db: D1Database,
    userId: string,
    session: RepairUndoSourceRow
) {
    const undoState: RepairUndoSnapshot = {
        kind: "repair_match_undo",
        version: 1,
        session: {
            id: session.id,
            scope: session.scope,
            scopeCategoryId: session.scope_category_id,
            activeCategoryId: session.active_category_id,
            entryAId: session.entry_a_id,
            entryBId: session.entry_b_id,
            phase: session.phase,
            strategy: session.strategy,
            comparisonCount: session.comparison_count,
            repairCount: session.repair_count,
            operationState: session.operation_state,
            updatedAt: session.updated_at
        },
        entries: await snapshotCategoryEntries(db, userId, session.active_category_id)
    };

    await db
        .prepare(
            `UPDATE repair_sessions
             SET undo_state = ?
             WHERE id = ? AND user_id = ? AND status = 'active'`
        )
        .bind(JSON.stringify(undoState), session.id, userId)
        .run();
}

export async function restoreRankingMatchUndoState(
    db: D1Database,
    userId: string,
    undoStateValue: string
) {
    const undoState = parseRankingUndoState(undoStateValue);
    await assertSnapshotEntriesStillExist(db, userId, undoState.entries);
    const statements: D1PreparedStatement[] = [
        ...restoreEntryStatements(db, userId, undoState.entries)
    ];

    if (undoState.queuedEntry) {
        statements.push(upsertQueueSnapshotStatement(db, undoState.queuedEntry));
    }

    statements.push(
        db
            .prepare(
                `UPDATE ranking_sessions
                 SET category_id = ?,
                     subject_entry_id = ?,
                     source = ?,
                     from_category_id = ?,
                     lower_bound = ?,
                     upper_bound = ?,
                     pivot_entry_id = ?,
                     pivot_rank_position = ?,
                     status = 'active',
                     final_rank_position = ?,
                     completed_at = NULL,
                     original_rank_position = ?,
                     comparison_count = ?,
                     phase = ?,
                     operation_kind = ?,
                     secondary_entry_id = ?,
                     secondary_original_rank_position = ?,
                     operation_state = ?,
                     undo_state = NULL
                 WHERE id = ? AND user_id = ?`
            )
            .bind(
                undoState.session.categoryId,
                undoState.session.subjectEntryId,
                undoState.session.source,
                undoState.session.fromCategoryId,
                undoState.session.lowerBound,
                undoState.session.upperBound,
                undoState.session.pivotEntryId,
                undoState.session.pivotRankPosition,
                undoState.session.finalRankPosition,
                undoState.session.originalRankPosition,
                undoState.session.comparisonCount,
                undoState.session.phase,
                undoState.session.operationKind,
                undoState.session.secondaryEntryId,
                undoState.session.secondaryOriginalRankPosition,
                undoState.session.operationState,
                undoState.session.id,
                userId
            )
    );

    await runUndoRestoreBatches(db, statements);
    return {
        sessionId: undoState.session.id,
        categoryId: undoState.session.categoryId
    };
}

export async function restoreRepairMatchUndoState(
    db: D1Database,
    userId: string,
    undoStateValue: string
) {
    const undoState = parseRepairUndoState(undoStateValue);
    await assertSnapshotEntriesStillExist(db, userId, undoState.entries);
    await runUndoRestoreBatches(db, [
        ...restoreEntryStatements(db, userId, undoState.entries),
        db
            .prepare(
                `UPDATE repair_sessions
                 SET scope = ?,
                     scope_category_id = ?,
                     active_category_id = ?,
                     entry_a_id = ?,
                     entry_b_id = ?,
                     status = 'active',
                     phase = ?,
                     strategy = ?,
                     comparison_count = ?,
                     repair_count = ?,
                     operation_state = ?,
                     updated_at = ?,
                     completed_at = NULL,
                     undo_state = NULL
                 WHERE id = ? AND user_id = ?`
            )
            .bind(
                undoState.session.scope,
                undoState.session.scopeCategoryId,
                undoState.session.activeCategoryId,
                undoState.session.entryAId,
                undoState.session.entryBId,
                undoState.session.phase,
                undoState.session.strategy,
                undoState.session.comparisonCount,
                undoState.session.repairCount,
                undoState.session.operationState,
                undoState.session.updatedAt,
                undoState.session.id,
                userId
            )
    ]);

    return {
        sessionId: undoState.session.id,
        categoryId: undoState.session.activeCategoryId
    };
}

function parseRankingUndoState(value: string): RankingUndoSnapshot {
    const parsed = JSON.parse(value) as RankingUndoSnapshot;
    if (parsed.kind !== "ranking_match_undo" || parsed.version !== 1) {
        throw new Error("That match can't be undone anymore.");
    }
    return parsed;
}

function parseRepairUndoState(value: string): RepairUndoSnapshot {
    const parsed = JSON.parse(value) as RepairUndoSnapshot;
    if (parsed.kind !== "repair_match_undo" || parsed.version !== 1) {
        throw new Error("That match can't be undone anymore.");
    }
    return parsed;
}

async function snapshotCategoryEntries(db: D1Database, userId: string, categoryId: string) {
    const rows = await all<EntryStateRow>(
        db
            .prepare(
                `SELECT id, category_id, status, rank_position, updated_at
                 FROM entries
                 WHERE user_id = ? AND category_id = ? AND status IN ('active', 'ranking')
                 ORDER BY rank_position ASC, id ASC`
            )
            .bind(userId, categoryId)
    );

    return rows.map((row) => ({
        id: row.id,
        categoryId: row.category_id,
        status: row.status,
        rankPosition: row.rank_position,
        updatedAt: row.updated_at
    }));
}

async function snapshotQueuedEntry(db: D1Database, userId: string, queuedEntryId: string) {
    const row = await first<QueueSnapshotRow>(
        db
            .prepare(
                `SELECT id, user_id, category_id, name, image_key,
                        status, created_at, updated_at
                 FROM entry_queue
                 WHERE id = ? AND user_id = ?`
            )
            .bind(queuedEntryId, userId)
    );

    return row
        ? {
            id: row.id,
            userId: row.user_id,
            categoryId: row.category_id,
            name: row.name,
            imageKey: row.image_key,
            status: row.status,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        }
        : null;
}

async function assertSnapshotEntriesStillExist(
    db: D1Database,
    userId: string,
    entries: EntryStateSnapshot[]
) {
    if (entries.length === 0) {
        throw new Error("That match can't be undone anymore.");
    }

    let foundCount = 0;
    for (const chunk of chunks(entries, MAX_EXISTENCE_CHECK_IDS)) {
        const placeholders = chunk.map(() => "?").join(", ");
        const row = await first<{ count: number }>(
            db
                .prepare(
                    `SELECT COUNT(*) AS count
                     FROM entries
                     WHERE user_id = ? AND id IN (${placeholders})`
                )
                .bind(userId, ...chunk.map((entry) => entry.id))
        );
        foundCount += row?.count ?? 0;
    }

    if (foundCount !== entries.length) {
        throw new Error("That match can't be undone anymore.");
    }
}

function restoreEntryStatements(
    db: D1Database,
    userId: string,
    entries: EntryStateSnapshot[]
) {
    return entries.map((entry) =>
        db
            .prepare(
                `UPDATE entries
                 SET status = ?, rank_position = ?, updated_at = ?
                 WHERE user_id = ? AND id = ? AND category_id = ?`
            )
            .bind(
                entry.status,
                entry.rankPosition,
                entry.updatedAt,
                userId,
                entry.id,
                entry.categoryId
            )
    );
}

function upsertQueueSnapshotStatement(db: D1Database, queuedEntry: QueueRowSnapshot) {
    return db
        .prepare(
            `INSERT OR REPLACE INTO entry_queue (
                 id, user_id, category_id, name, image_key,
                 status, created_at, updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
            queuedEntry.id,
            queuedEntry.userId,
            queuedEntry.categoryId,
            queuedEntry.name,
            queuedEntry.imageKey,
            queuedEntry.status,
            queuedEntry.createdAt,
            queuedEntry.updatedAt
        );
}

async function runUndoRestoreBatches(db: D1Database, statements: D1PreparedStatement[]) {
    for (const chunk of chunks(statements, UNDO_RESTORE_BATCH_SIZE)) {
        await runBatches(db, chunk);
    }
}

function chunks<T>(items: T[], size: number) {
    const result: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
        result.push(items.slice(index, index + size));
    }
    return result;
}
