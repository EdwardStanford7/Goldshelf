-- Activity is opt-in and is derived from entries.created_at at read time.  This
-- avoids a second write/event-retention system for every entry a person adds.
ALTER TABLE user_profiles
  ADD COLUMN activity_visibility TEXT NOT NULL DEFAULT 'off'
  CHECK(activity_visibility IN ('off', 'followers', 'public'));

-- Explore/feed queries start from shared categories and then select a bounded
-- newest-first set of active entries.
CREATE INDEX IF NOT EXISTS idx_entries_category_status_created
  ON entries(category_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_profiles_explore
  ON user_profiles(is_public, activity_visibility, updated_at DESC, user_id);
