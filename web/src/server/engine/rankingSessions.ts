import {
    advanceBubbleRepairState,
    chooseBinaryPivot,
    startBubbleRepairState
} from "@/lib/ranking";
import type {
    ActiveBinarySession,
    BinarySessionView,
    Entry,
    RankingOperationKind,
    RankingSource
} from "@/lib/types";
import { env } from "cloudflare:workers";
import { hasStoredImage } from "@/lib/images";
import { all, assertOwned, first, getDb, newId, now, runBatches } from "@/server/lib/db";
import { getOwnedCategory } from "../stores/categoryStore";
import {
    getNextActiveRankPosition,
    getOwnedEntry,
    listActiveEntries,
    placeRankedEntryStatements,
    rewriteCategoryOrderStatements
} from "../stores/entryStore";
import {
    consumeQueuedEntryStatement,
    getStartedQueuedEntryForRanking,
    restoreStartedQueuedEntryStatement
} from "../stores/queueStore";
import {
    type RankingOperationStateEnvelope,
    addCachedComparison,
    clampInsertionIndex,
    normalizeOperationKind,
    parseRankingOperationState,
    serializeRankingOperationState
} from "./rankingState";
import { repairInterruptedRepairState } from "./repairSessions";

export interface SessionRow {
    id: string;
    user_id: string;
    category_id: string;
    subject_entry_id: string;
    source: RankingSource;
    from_category_id: string | null;
    lower_bound: number;
    upper_bound: number;
    pivot_entry_id: string | null;
    pivot_rank_position: number | null;
    final_rank_position: number | null;
    original_rank_position?: number | null;
    created_at: number;
    comparison_count?: number;
    phase?: string;
    operation_kind?: RankingOperationKind | string;
    secondary_entry_id?: string | null;
    secondary_original_rank_position?: number | null;
    operation_state?: string | null;
    undo_state?: string | null;
}

interface ActiveBinarySessionRow {
    id: string;
    category_id: string;
    category_name: string;
    subject_name: string;
    source: RankingSource;
    operation_kind?: RankingOperationKind | string;
}

interface ActiveSessionRepairRow {
    id: string;
    category_id: string;
    subject_entry_id: string;
    source: RankingSource;
    lower_bound: number;
    upper_bound: number;
    pivot_entry_id: string | null;
    pivot_rank_position: number | null;
    created_at: number;
    category_exists: string | null;
    subject_id: string | null;
    subject_name: string | null;
    subject_category_id: string | null;
    subject_image_key: string | null;
    subject_status: string | null;
    pivot_id: string | null;
    pivot_category_id: string | null;
    pivot_status: string | null;
    original_rank_position?: number | null;
    phase?: string;
    operation_kind?: RankingOperationKind | string;
    secondary_entry_id?: string | null;
    secondary_original_rank_position?: number | null;
    operation_state?: string | null;
    secondary_id?: string | null;
    secondary_category_id?: string | null;
    secondary_status?: string | null;
}

interface OrphanedRankingEntryRow {
    id: string;
    category_id: string;
    name: string;
    image_key: string | null;
    session_source: RankingSource | null;
}

export async function submitLocalRepairWinner(
    db: D1Database,
    userId: string,
    session: SessionRow,
    winnerId: string,
    updatedAt: number
) {
    const subjectWon = winnerId === session.subject_entry_id;
    const currentFinalRank = session.final_rank_position ?? session.lower_bound;
    const pivotRank = session.pivot_rank_position ?? currentFinalRank;

    if (session.phase === "repair_up") {
        if (subjectWon) {
            return continueUpwardRepairOrCommit(db, userId, session, pivotRank, updatedAt, true);
        }

        const wasInitialLeftCheck = pivotRank === currentFinalRank - 1;
        if (wasInitialLeftCheck) {
            return startLocalRepairOrCommit(db, userId, session, currentFinalRank, updatedAt, {
                countCurrentComparison: true,
                allowUpwardCheck: false
            });
        }

        return completeRankingSession(db, userId, session, currentFinalRank, updatedAt, true);
    }

    if (!subjectWon) {
        return continueDownwardRepairOrCommit(db, userId, session, pivotRank + 1, updatedAt, true);
    }

    return completeRankingSession(db, userId, session, currentFinalRank, updatedAt, true);
}

export async function submitBubbleRepairWinner(
    db: D1Database,
    userId: string,
    session: SessionRow,
    winnerId: string,
    updatedAt: number
) {
    const operationState = parseRankingOperationState(session.operation_state);
    const bubbleRepair = operationState.bubbleRepair;
    const currentComparison = bubbleRepair?.currentComparison;
    if (!bubbleRepair || !currentComparison) {
        throw new Error("Ranking session has no active repair matchup");
    }

    if (
        winnerId !== currentComparison.entryAId &&
        winnerId !== currentComparison.entryBId
    ) {
        throw new Error("Winner must be one of the active matchup entries");
    }

    const loserId = winnerId === currentComparison.entryAId
        ? currentComparison.entryBId
        : currentComparison.entryAId;
    const nextOperationState = addCachedComparison(operationState, winnerId, loserId);
    const result = advanceBubbleRepairState(bubbleRepair, nextOperationState.comparisons);
    nextOperationState.bubbleRepair = result.state;

    if (result.complete) {
        return completeBubbleRepairSession(
            db,
            userId,
            session,
            result.state.workingOrderIds,
            updatedAt,
            nextOperationState,
            true
        );
    }

    await updateBubbleRepairPrompt(db, userId, session, nextOperationState, true);
    return { kind: "session" as const, sessionId: session.id };
}

export async function startBubbleRepairOrCommit(
    db: D1Database,
    userId: string,
    session: SessionRow,
    finalRankPosition: number,
    updatedAt: number,
    operationState: RankingOperationStateEnvelope,
    countCurrentComparison: boolean
) {
    const entries = await listActiveEntries(userId, session.category_id);
    const workingOrderIds = entries.map((entry) => entry.id);
    workingOrderIds.splice(
        clampInsertionIndex(finalRankPosition, workingOrderIds.length),
        0,
        session.subject_entry_id
    );

    const bubbleRepair = startBubbleRepairState(workingOrderIds, session.subject_entry_id);
    const result = advanceBubbleRepairState(bubbleRepair, operationState.comparisons);
    operationState.bubbleRepair = result.state;

    if (result.complete) {
        return completeBubbleRepairSession(
            db,
            userId,
            session,
            result.state.workingOrderIds,
            updatedAt,
            operationState,
            countCurrentComparison
        );
    }

    await updateBubbleRepairPrompt(db, userId, session, operationState, countCurrentComparison);
    return { kind: "session" as const, sessionId: session.id };
}

async function updateBubbleRepairPrompt(
    db: D1Database,
    userId: string,
    session: SessionRow,
    operationState: RankingOperationStateEnvelope,
    countCurrentComparison: boolean
) {
    const comparison = operationState.bubbleRepair?.currentComparison;
    const bubbleRepair = operationState.bubbleRepair;
    if (!comparison || !bubbleRepair) {
        throw new Error("Bubble repair has no active matchup");
    }

    const opponent = await getOwnedEntry(userId, comparison.entryBId);
    assertOwned(opponent, "Repair opponent");

    await db
        .prepare(
            `UPDATE ranking_sessions
       SET phase = 'bubble_repair',
           final_rank_position = ?,
           pivot_entry_id = ?,
           pivot_rank_position = ?,
           operation_state = ?,
           comparison_count = comparison_count + ?
       WHERE id = ? AND user_id = ? AND status = 'active'`
        )
        .bind(
            bubbleRepair.workingOrderIds.indexOf(session.subject_entry_id),
            comparison.entryBId,
            opponent.rankPosition,
            serializeRankingOperationState(operationState),
            countCurrentComparison ? 1 : 0,
            session.id,
            userId
        )
        .run();
}

async function completeBubbleRepairSession(
    db: D1Database,
    userId: string,
    session: SessionRow,
    workingOrderIds: string[],
    updatedAt: number,
    operationState: RankingOperationStateEnvelope,
    countCurrentComparison: boolean
) {
    const finalRankPosition = workingOrderIds.indexOf(session.subject_entry_id);
    if (finalRankPosition < 0) {
        throw new Error("Ranked entry is missing from the repaired order");
    }

    operationState.bubbleRepair = null;
    await db.batch([
        ...rewriteCategoryOrderStatements(db, userId, session.category_id, workingOrderIds, updatedAt),
        ...consumeQueuedEntryOnCompletionStatements(db, userId, session, operationState),
        db
            .prepare(
                `UPDATE ranking_sessions
       SET status = 'completed', final_rank_position = ?, completed_at = ?,
           pivot_entry_id = NULL, pivot_rank_position = NULL,
           phase = 'binary',
           operation_state = ?,
           comparison_count = comparison_count + ?
       WHERE id = ? AND user_id = ?`
            )
            .bind(
                finalRankPosition,
                updatedAt,
                serializeRankingOperationState(operationState),
                countCurrentComparison ? 1 : 0,
                session.id,
                userId
            )
    ]);

    return { kind: "completed" as const, sessionId: session.id, finalRankPosition };
}

async function startLocalRepairOrCommit(
    db: D1Database,
    userId: string,
    session: SessionRow,
    finalRankPosition: number,
    updatedAt: number,
    options: {
        countCurrentComparison: boolean;
        allowUpwardCheck: boolean;
    }
) {
    const entries = await listActiveEntries(userId, session.category_id);

    if (options.allowUpwardCheck) {
        const upwardPivot = entries[finalRankPosition - 1];
        if (upwardPivot) {
            await updateRankingSessionPivot(
                db,
                userId,
                session.id,
                "repair_up",
                finalRankPosition,
                upwardPivot,
                options.countCurrentComparison
            );
            return { kind: "session" as const, sessionId: session.id };
        }
    }

    const downwardPivot = entries[finalRankPosition];
    if (downwardPivot) {
        await updateRankingSessionPivot(
            db,
            userId,
            session.id,
            "repair_down",
            finalRankPosition,
            downwardPivot,
            options.countCurrentComparison
        );
        return { kind: "session" as const, sessionId: session.id };
    }

    return completeRankingSession(
        db,
        userId,
        session,
        finalRankPosition,
        updatedAt,
        options.countCurrentComparison
    );
}

async function continueUpwardRepairOrCommit(
    db: D1Database,
    userId: string,
    session: SessionRow,
    finalRankPosition: number,
    updatedAt: number,
    countCurrentComparison: boolean
) {
    const entries = await listActiveEntries(userId, session.category_id);
    const nextPivot = entries[finalRankPosition - 1];
    if (nextPivot) {
        await updateRankingSessionPivot(
            db,
            userId,
            session.id,
            "repair_up",
            finalRankPosition,
            nextPivot,
            countCurrentComparison
        );
        return { kind: "session" as const, sessionId: session.id };
    }

    return completeRankingSession(db, userId, session, finalRankPosition, updatedAt, countCurrentComparison);
}

async function continueDownwardRepairOrCommit(
    db: D1Database,
    userId: string,
    session: SessionRow,
    finalRankPosition: number,
    updatedAt: number,
    countCurrentComparison: boolean
) {
    const entries = await listActiveEntries(userId, session.category_id);
    const nextPivot = entries[finalRankPosition];
    if (nextPivot) {
        await updateRankingSessionPivot(
            db,
            userId,
            session.id,
            "repair_down",
            finalRankPosition,
            nextPivot,
            countCurrentComparison
        );
        return { kind: "session" as const, sessionId: session.id };
    }

    return completeRankingSession(db, userId, session, finalRankPosition, updatedAt, countCurrentComparison);
}

async function updateRankingSessionPivot(
    db: D1Database,
    userId: string,
    sessionId: string,
    phase: "repair_up" | "repair_down",
    finalRankPosition: number,
    pivot: Entry,
    countCurrentComparison: boolean
) {
    await db
        .prepare(
            `UPDATE ranking_sessions
       SET phase = ?,
           final_rank_position = ?,
           pivot_entry_id = ?,
           pivot_rank_position = ?,
           comparison_count = comparison_count + ?
       WHERE id = ? AND user_id = ? AND status = 'active'`
        )
        .bind(
            phase,
            finalRankPosition,
            pivot.id,
            pivot.rankPosition,
            countCurrentComparison ? 1 : 0,
            sessionId,
            userId
        )
        .run();
}

async function completeRankingSession(
    db: D1Database,
    userId: string,
    session: SessionRow,
    finalRankPosition: number,
    updatedAt: number,
    countCurrentComparison: boolean
) {
    await db.batch([
        ...placeRankedEntryStatements(
            db,
            userId,
            session.subject_entry_id,
            session.category_id,
            finalRankPosition,
            updatedAt
        ),
        ...consumeQueuedEntryOnCompletionStatements(db, userId, session),
        db
            .prepare(
                `UPDATE ranking_sessions
       SET status = 'completed', final_rank_position = ?, completed_at = ?,
           pivot_entry_id = NULL, pivot_rank_position = NULL,
           phase = 'binary',
           comparison_count = comparison_count + ?
       WHERE id = ? AND user_id = ?`
            )
            .bind(finalRankPosition, updatedAt, countCurrentComparison ? 1 : 0, session.id, userId)
    ]);

    return { kind: "completed" as const, sessionId: session.id, finalRankPosition };
}

function consumeQueuedEntryOnCompletionStatements(
    db: D1Database,
    userId: string,
    session: SessionRow,
    operationState = parseRankingOperationState(session.operation_state)
) {
    if (session.source !== "new_entry" || !operationState.queuedEntryId) {
        return [];
    }

    return [consumeQueuedEntryStatement(db, userId, operationState.queuedEntryId)];
}

export async function getActiveBinarySession(userId: string): Promise<ActiveBinarySession | null> {
    const row = await first<ActiveBinarySessionRow>(
        getDb()
            .prepare(
                `SELECT ranking_sessions.id, ranking_sessions.category_id,
                categories.name AS category_name, entries.name AS subject_name,
                ranking_sessions.source, ranking_sessions.operation_kind
         FROM ranking_sessions
         INNER JOIN categories ON categories.id = ranking_sessions.category_id
         INNER JOIN entries ON entries.id = ranking_sessions.subject_entry_id
         WHERE ranking_sessions.user_id = ? AND ranking_sessions.status = 'active'
         ORDER BY ranking_sessions.created_at DESC
         LIMIT 1`
            )
            .bind(userId)
    );

    return row
        ? {
            id: row.id,
            categoryId: row.category_id,
            categoryName: row.category_name,
            subjectName: row.subject_name,
            source: row.source,
            operationKind: normalizeOperationKind(row.operation_kind)
        }
        : null;
}

export async function getActiveSessionRow(userId: string) {
    return first<SessionRow>(
        getDb()
            .prepare(
                `SELECT id, user_id, category_id, subject_entry_id, source, from_category_id,
                lower_bound, upper_bound, pivot_entry_id, pivot_rank_position,
                final_rank_position, created_at, operation_kind, secondary_entry_id,
                secondary_original_rank_position, operation_state
         FROM ranking_sessions
         WHERE user_id = ? AND status = 'active'
         ORDER BY created_at DESC
         LIMIT 1`
            )
            .bind(userId)
    );
}

export async function assertNoActiveBinarySession(userId: string) {
    await repairInterruptedRankingState(userId);
    await repairInterruptedRepairState(userId);
    const activeSession = await getActiveSessionRow(userId);
    if (activeSession) {
        throw new Error("Finish or cancel the active ranking before starting another one");
    }

    const activeRepairSession = await first<{ id: string }>(
        getDb()
            .prepare(
                `SELECT id
                 FROM repair_sessions
                 WHERE user_id = ? AND status = 'active'
                 LIMIT 1`
            )
            .bind(userId)
    );
    if (activeRepairSession) {
        throw new Error("Finish or Exit Repair Mode mode before starting another ranking");
    }
}

export async function repairInterruptedRankingState(userId: string) {
    await cancelStaleActiveRankingSessions(userId);
    await recoverInterruptedRankingEntries(userId);
}

async function cancelStaleActiveRankingSessions(userId: string) {
    const db = getDb();
    const activeSessions = await all<ActiveSessionRepairRow>(
        db
            .prepare(
                `SELECT ranking_sessions.id, ranking_sessions.category_id,
                ranking_sessions.subject_entry_id, ranking_sessions.source,
                ranking_sessions.lower_bound, ranking_sessions.upper_bound,
                ranking_sessions.pivot_entry_id, ranking_sessions.pivot_rank_position,
                ranking_sessions.created_at, ranking_sessions.original_rank_position,
                ranking_sessions.phase, ranking_sessions.operation_kind,
                ranking_sessions.secondary_entry_id,
                ranking_sessions.secondary_original_rank_position,
                ranking_sessions.operation_state,
                categories.id AS category_exists,
                subject.id AS subject_id, subject.name AS subject_name,
                subject.category_id AS subject_category_id,
                subject.image_key AS subject_image_key,
                subject.status AS subject_status,
                pivot.id AS pivot_id, pivot.category_id AS pivot_category_id,
                pivot.status AS pivot_status,
                secondary.id AS secondary_id,
                secondary.category_id AS secondary_category_id,
                secondary.status AS secondary_status
         FROM ranking_sessions
         LEFT JOIN categories
           ON categories.id = ranking_sessions.category_id
          AND categories.user_id = ranking_sessions.user_id
         LEFT JOIN entries subject
           ON subject.id = ranking_sessions.subject_entry_id
          AND subject.user_id = ranking_sessions.user_id
         LEFT JOIN entries pivot
           ON pivot.id = ranking_sessions.pivot_entry_id
          AND pivot.user_id = ranking_sessions.user_id
         LEFT JOIN entries secondary
           ON secondary.id = ranking_sessions.secondary_entry_id
          AND secondary.user_id = ranking_sessions.user_id
         WHERE ranking_sessions.user_id = ? AND ranking_sessions.status = 'active'
         ORDER BY ranking_sessions.created_at DESC`
            )
            .bind(userId)
    );

    if (activeSessions.length === 0) {
        return;
    }

    const updatedAt = now();
    const nextRankByCategory = new Map<string, number>();
    const statements: D1PreparedStatement[] = [];
    const imageKeysToDelete: string[] = [];
    let keptActiveSessionId: string | null = null;

    for (const session of activeSessions) {
        const canResume = canResumeActiveSession(session);
        if (canResume && keptActiveSessionId === null) {
            keptActiveSessionId = session.id;
            continue;
        }

        statements.push(
            db
                .prepare(
                    `UPDATE ranking_sessions
           SET status = 'cancelled', completed_at = ?,
               pivot_entry_id = NULL, pivot_rank_position = NULL
           WHERE id = ? AND user_id = ? AND status = 'active'`
                )
                .bind(updatedAt, session.id, userId)
        );

        if (
            session.subject_id &&
            session.subject_status === "ranking" &&
            session.subject_category_id
        ) {
            if (session.source === "new_entry") {
                statements.push(
                    db
                        .prepare(
                            `UPDATE entries
             SET status = 'deleted', updated_at = ?
             WHERE user_id = ? AND id = ? AND status = 'ranking'`
                        )
                        .bind(updatedAt, userId, session.subject_entry_id)
                );

                const startedQueuedEntry = session.subject_name
                    ? await getStartedQueuedEntryForRanking(
                        db,
                        userId,
                        session.subject_category_id,
                        session.subject_name
                    )
                    : null;
                if (startedQueuedEntry && session.subject_name) {
                    statements.push(
                        restoreStartedQueuedEntryStatement(
                            db,
                            userId,
                            startedQueuedEntry.id,
                            session.subject_category_id,
                            session.subject_name,
                            updatedAt
                        )
                    );
                } else if (hasStoredImage(session.subject_image_key)) {
                    imageKeysToDelete.push(session.subject_image_key);
                }

                continue;
            }

            let nextRank = nextRankByCategory.get(session.subject_category_id);
            if (nextRank === undefined) {
                nextRank = await getNextActiveRankPosition(userId, session.subject_category_id);
            }

            statements.push(
                db
                    .prepare(
                        `UPDATE entries
             SET status = 'active', rank_position = ?, updated_at = ?
             WHERE user_id = ? AND id = ? AND status = 'ranking'`
                    )
                    .bind(nextRank, updatedAt, userId, session.subject_entry_id)
            );
            nextRankByCategory.set(session.subject_category_id, nextRank + 1);
        }
    }

    await runBatches(db, statements);
    await Promise.all(
        Array.from(new Set(imageKeysToDelete)).map((imageKey) => env.IMAGES.delete(imageKey).catch(() => undefined))
    );
}

function canResumeActiveSession(session: ActiveSessionRepairRow) {
    const hasValidBounds = session.phase && session.phase !== "binary"
        ? session.lower_bound >= 0
        : session.lower_bound >= 0 && session.upper_bound > session.lower_bound;
    const hasValidStagedSubject = Boolean(
        session.subject_id &&
        session.subject_category_id === session.category_id &&
        session.subject_status === "ranking"
    );

    return Boolean(
        session.category_exists &&
        hasValidStagedSubject &&
        session.pivot_entry_id &&
        session.pivot_id &&
        session.pivot_category_id === session.category_id &&
        session.pivot_status === "active" &&
        session.pivot_rank_position !== null &&
        hasValidBounds
    );
}

async function recoverInterruptedRankingEntries(userId: string) {
    const db = getDb();
    const orphanedEntries = await all<OrphanedRankingEntryRow>(
        db
            .prepare(
                `SELECT entries.id, entries.category_id, entries.name, entries.image_key,
                (
                  SELECT ranking_sessions.source
                  FROM ranking_sessions
                  WHERE ranking_sessions.user_id = entries.user_id
                    AND (
                      ranking_sessions.subject_entry_id = entries.id OR
                      ranking_sessions.secondary_entry_id = entries.id
                    )
                  ORDER BY ranking_sessions.created_at DESC
                  LIMIT 1
                ) AS session_source
         FROM entries
         LEFT JOIN ranking_sessions
           ON ranking_sessions.user_id = entries.user_id
          AND (
            ranking_sessions.subject_entry_id = entries.id OR
            ranking_sessions.secondary_entry_id = entries.id
          )
          AND ranking_sessions.status = 'active'
         WHERE entries.user_id = ? AND entries.status = 'ranking'
           AND ranking_sessions.id IS NULL
         ORDER BY entries.created_at ASC`
            )
            .bind(userId)
    );

    if (orphanedEntries.length === 0) {
        return;
    }

    const updatedAt = now();
    const nextRankByCategory = new Map<string, number>();
    const statements: D1PreparedStatement[] = [];
    const imageKeysToDelete: string[] = [];

    for (const entry of orphanedEntries) {
        const startedQueuedEntry = await getStartedQueuedEntryForRanking(
            db,
            userId,
            entry.category_id,
            entry.name
        );

        if (entry.session_source === "new_entry" || startedQueuedEntry) {
            statements.push(
                db
                    .prepare(
                        `UPDATE entries
           SET status = 'deleted', updated_at = ?
           WHERE user_id = ? AND id = ? AND status = 'ranking'`
                    )
                    .bind(updatedAt, userId, entry.id)
            );

            if (startedQueuedEntry) {
                statements.push(
                    restoreStartedQueuedEntryStatement(
                        db,
                        userId,
                        startedQueuedEntry.id,
                        entry.category_id,
                        entry.name,
                        updatedAt
                    )
                );
            } else if (hasStoredImage(entry.image_key)) {
                imageKeysToDelete.push(entry.image_key);
            }

            continue;
        }

        let nextRank = nextRankByCategory.get(entry.category_id);
        if (nextRank === undefined) {
            nextRank = await getNextActiveRankPosition(userId, entry.category_id);
        }

        statements.push(
            db
                .prepare(
                    `UPDATE entries
           SET status = 'active', rank_position = ?, updated_at = ?
           WHERE user_id = ? AND id = ? AND status = 'ranking'`
                )
                .bind(nextRank, updatedAt, userId, entry.id)
        );
        nextRankByCategory.set(entry.category_id, nextRank + 1);
    }

    await runBatches(db, statements);
    await Promise.all(
        Array.from(new Set(imageKeysToDelete)).map((imageKey) => env.IMAGES.delete(imageKey).catch(() => undefined))
    );
}

export async function prepareBinarySession(
    db: D1Database,
    input: {
        userId: string;
        categoryId: string;
        subjectEntryId: string;
        source: RankingSource;
        fromCategoryId?: string;
        opponentCount: number;
        excludedEntryId?: string;
        initialRankPosition?: number | null;
        lowerBound?: number;
        upperBound?: number;
        operationKind?: RankingOperationKind;
        secondaryEntryId?: string | null;
        secondaryOriginalRankPosition?: number | null;
        operationState?: string | null;
        createdAt: number;
    }
) {
    const opponents = await listActiveEntries(
        input.userId,
        input.categoryId,
        input.excludedEntryId
    );
    const lowerBound = input.lowerBound ?? 0;
    const upperBound = input.upperBound ?? input.opponentCount;
    if (lowerBound < 0 || upperBound > opponents.length || lowerBound >= upperBound) {
        throw new Error("Invalid ranking bounds");
    }

    const pivotIndex = chooseBinaryPivot(lowerBound, upperBound);
    const pivot = opponents[pivotIndex];
    assertOwned(pivot, "Pivot entry");

    const sessionId = newId("rank");
    return {
        sessionId,
        statement: db
            .prepare(
                `INSERT INTO ranking_sessions (
           id, user_id, category_id, subject_entry_id, source, from_category_id, lower_bound,
           upper_bound, pivot_entry_id, pivot_rank_position, final_rank_position,
           original_rank_position, status, created_at, operation_kind, secondary_entry_id,
           secondary_original_rank_position, operation_state
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'active', ?, ?, ?, ?, ?)`
            )
            .bind(
                sessionId,
                input.userId,
                input.categoryId,
                input.subjectEntryId,
                input.source,
                input.fromCategoryId ?? null,
                lowerBound,
                upperBound,
                pivot.id,
                pivot.rankPosition,
                input.initialRankPosition ?? null,
                input.createdAt,
                input.operationKind ?? "single",
                input.secondaryEntryId ?? null,
                input.secondaryOriginalRankPosition ?? null,
                input.operationState ?? null
            )
    };
}
