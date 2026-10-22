CREATE INDEX IF NOT EXISTS idx_categories_user_updated
  ON categories(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_entries_user_updated
  ON entries(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_entry_queue_user_updated
  ON entry_queue(user_id, updated_at DESC);
