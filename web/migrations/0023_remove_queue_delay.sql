DROP INDEX IF EXISTS idx_entry_queue_user_status_available;

ALTER TABLE queue_settings DROP COLUMN delay_days;
ALTER TABLE entry_queue DROP COLUMN available_at;

CREATE INDEX IF NOT EXISTS idx_entry_queue_user_status_created
  ON entry_queue(user_id, status, created_at);
