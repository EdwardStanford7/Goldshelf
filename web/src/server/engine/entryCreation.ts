import { assertOwned, first, getDb, newId, now } from "@/server/lib/db";
import { MAX_ENTRY_NAME_LENGTH, normalizeRequiredText } from "@/server/lib/validation";
import { getOwnedCategory } from "../stores/categoryStore";
import { getActiveEntryCount, getOwnedEntry } from "../stores/entryStore";
import {
    consumeQueuedEntryStatement,
    queuedEntryStartedStatement
} from "../stores/queueStore";
import {
    getActiveSessionRow,
    prepareBinarySession,
    repairInterruptedRankingState
} from "./rankingSessions";
import {
    emptyRankingOperationState,
    parseRankingOperationState,
    serializeRankingOperationState
} from "./rankingState";

export async function createEntryWithBinaryRankingForUser(
    userId: string,
    input: {
        categoryId: string;
        name: string;
        createdAt?: number | null;
        ignoredQueuedEntryId?: string;
        imageKey?: string | null;
        queuedEntryId?: string;
        queueStartedAt?: number;
    }
) {
    const db = getDb();
    const category = await getOwnedCategory(userId, input.categoryId);
    assertOwned(category, "Category");

    const cleanName = normalizeRequiredText(input.name, "Entry name", MAX_ENTRY_NAME_LENGTH);

    await repairInterruptedRankingState(userId);
    const activeSession = await getActiveSessionRow(userId);
    if (activeSession) {
        const activeSubject = await getOwnedEntry(userId, activeSession.subject_entry_id);
        if (
            activeSession.source === "new_entry" &&
            activeSession.category_id === input.categoryId &&
            activeSubject?.name === cleanName
        ) {
            if (input.queuedEntryId) {
                const operationState = parseRankingOperationState(activeSession.operation_state);
                if (!operationState.queuedEntryId || operationState.queuedEntryId === input.queuedEntryId) {
                    operationState.queuedEntryId = input.queuedEntryId;
                    await db.batch([
                        queuedEntryStartedStatement(
                            db,
                            userId,
                            input.queuedEntryId,
                            input.queueStartedAt ?? now()
                        ),
                        db
                            .prepare(
                                `UPDATE ranking_sessions
                 SET operation_state = ?
                 WHERE id = ? AND user_id = ? AND status = 'active'`
                            )
                            .bind(serializeRankingOperationState(operationState), activeSession.id, userId)
                    ]);
                }
            }

            return {
                kind: "session" as const,
                entryId: activeSession.subject_entry_id,
                sessionId: activeSession.id
            };
        }

        throw new Error("Finish or cancel the active ranking before starting another one");
    }

    await assertEntryNameAvailable(userId, input.categoryId, cleanName, input.ignoredQueuedEntryId);

    const activeCount = await getActiveEntryCount(userId, input.categoryId);
    const operationCreatedAt = now();
    const entryCreatedAt = normalizeCreatedAt(input.createdAt) ?? operationCreatedAt;
    const entryId = newId("entry");
    const status = activeCount === 0 ? "active" : "ranking";
    const statements = [
        db
            .prepare(
                `INSERT INTO entries (
           id, user_id, category_id, name, rank_position, status, image_key,
           created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(
                entryId,
                userId,
                input.categoryId,
                cleanName,
                activeCount,
                status,
                input.imageKey ?? null,
                entryCreatedAt,
                operationCreatedAt
            )
    ];

    let sessionId: string | null = null;
    if (activeCount > 0) {
        const operationState = emptyRankingOperationState();
        operationState.queuedEntryId = input.queuedEntryId ?? null;
        const session = await prepareBinarySession(db, {
            userId,
            categoryId: input.categoryId,
            subjectEntryId: entryId,
            source: "new_entry",
            opponentCount: activeCount,
            operationState: serializeRankingOperationState(operationState),
            createdAt: operationCreatedAt
        });
        sessionId = session.sessionId;
        statements.push(session.statement);
    }

    if (input.queuedEntryId) {
        statements.push(
            activeCount === 0
                ? consumeQueuedEntryStatement(db, userId, input.queuedEntryId)
                : queuedEntryStartedStatement(
                    db,
                    userId,
                    input.queuedEntryId,
                    input.queueStartedAt ?? operationCreatedAt
                )
        );
    }

    await db.batch(statements);

    if (activeCount === 0) {
        return { kind: "completed" as const, entryId, sessionId: null };
    }

    if (!sessionId) {
        throw new Error("Ranking session was not created");
    }

    return { kind: "session" as const, entryId, sessionId };
}

function normalizeCreatedAt(value: number | null | undefined) {
    return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : null;
}

export async function assertEntryNameAvailable(
    userId: string,
    categoryId: string,
    name: string,
    ignoredQueuedEntryId?: string
) {
    await repairInterruptedRankingState(userId);

    const existingEntry = await first<{ id: string }>(
        getDb()
            .prepare(
                `SELECT id
         FROM entries
         WHERE user_id = ? AND category_id = ? AND name = ? AND status != 'deleted'`
            )
            .bind(userId, categoryId, name)
    );
    if (existingEntry) {
        throw new Error("That entry already exists in this category");
    }

    const existingQueuedEntry = await first<{ id: string }>(
        getDb()
            .prepare(
                `SELECT id
         FROM entry_queue
         WHERE user_id = ? AND category_id = ? AND name = ? AND status = 'queued'
           AND (? IS NULL OR id != ?)`
            )
            .bind(userId, categoryId, name, ignoredQueuedEntryId ?? null, ignoredQueuedEntryId ?? null)
    );
    if (existingQueuedEntry) {
        throw new Error("That entry is already queued in this category");
    }
}
