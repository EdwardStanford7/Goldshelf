export type ActiveOperationKind = "ranking" | "repair";

/** Acquire and release the operation slot inside the same atomic batch as a
 * structural edit. A concurrent session either wins first or starts after
 * the edit commits; it can never start between the check and the write. */
export async function runIdleMutation(db: D1Database, userId: string, statements: D1PreparedStatement[]) {
    if (statements.length === 0) return [];
    const token = `mutation_${crypto.randomUUID()}`;
    try {
        const results = await db.batch([
            claimActiveOperationStatement(db, userId, "ranking", token, Date.now()),
            ...statements,
            db.prepare("DELETE FROM active_user_operations WHERE user_id = ? AND session_id = ?").bind(userId, token)
        ]);
        return results.slice(1, -1);
    } catch (error) {
        if (String(error).includes("active_user_operations.user_id")) {
            throw new Error("Finish or cancel the active ranking or repair session before changing ranked entries.");
        }
        throw error;
    }
}

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
