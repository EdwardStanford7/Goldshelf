-- A user can have one interactive ranking or repair operation at a time.
-- This row is claimed in the same D1 batch that creates or restores a session.
CREATE TABLE IF NOT EXISTS active_user_operations (
  user_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('ranking', 'repair')),
  session_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES "user"(id) ON DELETE CASCADE
);

-- Preserve currently resumable operations when applying this migration.
INSERT OR IGNORE INTO active_user_operations (user_id, kind, session_id, created_at)
SELECT user_id, 'ranking', id, created_at FROM ranking_sessions WHERE status = 'active';

INSERT OR IGNORE INTO active_user_operations (user_id, kind, session_id, created_at)
SELECT user_id, 'repair', id, created_at FROM repair_sessions WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS idx_ranking_sessions_one_active_per_user
  ON ranking_sessions(user_id) WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS idx_repair_sessions_one_active_per_user
  ON repair_sessions(user_id) WHERE status = 'active';

CREATE TRIGGER IF NOT EXISTS release_active_ranking_operation_on_status_change
AFTER UPDATE OF status ON ranking_sessions
WHEN OLD.status = 'active' AND NEW.status != 'active'
BEGIN
  DELETE FROM active_user_operations
  WHERE user_id = NEW.user_id AND kind = 'ranking' AND session_id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS release_active_repair_operation_on_status_change
AFTER UPDATE OF status ON repair_sessions
WHEN OLD.status = 'active' AND NEW.status != 'active'
BEGIN
  DELETE FROM active_user_operations
  WHERE user_id = NEW.user_id AND kind = 'repair' AND session_id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS release_active_ranking_operation_on_delete
AFTER DELETE ON ranking_sessions
BEGIN
  DELETE FROM active_user_operations
  WHERE user_id = OLD.user_id AND kind = 'ranking' AND session_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS release_active_repair_operation_on_delete
AFTER DELETE ON repair_sessions
BEGIN
  DELETE FROM active_user_operations
  WHERE user_id = OLD.user_id AND kind = 'repair' AND session_id = OLD.id;
END;
