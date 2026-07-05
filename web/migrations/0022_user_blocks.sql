CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_user_id TEXT NOT NULL,
  blocked_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(blocker_user_id, blocked_user_id),
  CHECK(blocker_user_id != blocked_user_id),
  FOREIGN KEY(blocker_user_id) REFERENCES "user"(id) ON DELETE CASCADE,
  FOREIGN KEY(blocked_user_id) REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked_user_id
  ON user_blocks(blocked_user_id, blocker_user_id);
