CREATE INDEX IF NOT EXISTS idx_entries_ranking_status
  ON entries(user_id)
  WHERE status = 'ranking';
