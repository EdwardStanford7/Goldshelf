CREATE TABLE IF NOT EXISTS image_assets (
  content_hash TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_referenced_at INTEGER NOT NULL,
  unreferenced_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_image_assets_unreferenced
  ON image_assets(unreferenced_at)
  WHERE unreferenced_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_entries_image_key
  ON entries(image_key)
  WHERE image_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_entry_queue_image_key
  ON entry_queue(image_key)
  WHERE image_key IS NOT NULL;
