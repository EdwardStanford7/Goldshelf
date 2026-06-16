CREATE TABLE IF NOT EXISTS repair_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('all', 'category')),
  scope_category_id TEXT,
  active_category_id TEXT NOT NULL,
  entry_a_id TEXT,
  entry_b_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'cancelled')),
  phase TEXT NOT NULL DEFAULT 'checking',
  strategy TEXT NOT NULL DEFAULT 'none',
  comparison_count INTEGER NOT NULL DEFAULT 0,
  repair_count INTEGER NOT NULL DEFAULT 0,
  operation_state TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY(scope_category_id) REFERENCES categories(id) ON DELETE CASCADE,
  FOREIGN KEY(active_category_id) REFERENCES categories(id) ON DELETE CASCADE,
  FOREIGN KEY(entry_a_id) REFERENCES entries(id) ON DELETE SET NULL,
  FOREIGN KEY(entry_b_id) REFERENCES entries(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_repair_sessions_user_status
  ON repair_sessions(user_id, status, created_at DESC);
