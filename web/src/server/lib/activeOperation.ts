export type ActiveOperationKind = "ranking" | "repair";

/**
 * Claims a user's one interactive-operation slot. This statement must share a
 * D1 batch with its session INSERT/restore so the database, not a preceding
 * read, is the concurrency boundary.
 */
export function claimActiveOperationStatement(
    db: D1Database,
    userId: string,
    kind: ActiveOperationKind,
    sessionId: string,
    createdAt: number
) {
    return db
        .prepare(
            `INSERT INTO active_user_operations (user_id, kind, session_id, created_at)
             VALUES (?, ?, ?, ?)`
        )
        .bind(userId, kind, sessionId, createdAt);
}
