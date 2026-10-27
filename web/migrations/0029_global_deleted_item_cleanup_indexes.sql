-- The scheduled retention cleanup is global: it filters deleted rows by age,
-- not by user. Keep a matching partial index so it can find the next cleanup
-- batch without scanning the per-user deleted-row indexes.
CREATE INDEX IF NOT EXISTS idx_entries_deleted_updated_cleanup
  ON entries(updated_at)
  WHERE status = 'deleted';

CREATE INDEX IF NOT EXISTS idx_entry_queue_deleted_updated_cleanup
  ON entry_queue(updated_at)
  WHERE status = 'deleted';
