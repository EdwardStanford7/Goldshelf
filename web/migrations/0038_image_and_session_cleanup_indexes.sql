CREATE INDEX idx_user_stored_image ON "user"(image) WHERE image IS NOT NULL;
CREATE INDEX idx_categories_dirty_counts ON categories(user_id, data_revision) WHERE count_dirty = 1;
CREATE INDEX idx_ranking_closed_payloads ON ranking_sessions(completed_at)
  WHERE status IN ('completed', 'cancelled') AND (undo_state IS NOT NULL OR operation_state IS NOT NULL);
CREATE INDEX idx_repair_closed_payloads ON repair_sessions(completed_at)
  WHERE status IN ('completed', 'cancelled') AND (undo_state IS NOT NULL OR operation_state IS NOT NULL);
