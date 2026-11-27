/** Keep live/latest-valid Undo and the small session records used for recovery. */
export function pruneSessionPayloadsStatement(db: D1Database, table: "ranking_sessions" | "repair_sessions", limit = 500) {
    return db.prepare(`UPDATE ${table} SET undo_state = NULL, undo_revision = NULL, operation_state = NULL
      WHERE id IN (
        SELECT id FROM ${table}
        WHERE status IN ('completed', 'cancelled')
          AND (undo_state IS NOT NULL OR operation_state IS NOT NULL)
          AND (status = 'cancelled' OR COALESCE(undo_revision, -1)
            != COALESCE((SELECT revision FROM user_data_versions WHERE user_id = ${table}.user_id), 0))
        ORDER BY completed_at LIMIT ?
      )`).bind(limit);
}
