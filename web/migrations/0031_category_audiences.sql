-- Preserve the effective audience of existing shelves.
ALTER TABLE categories ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'
  CHECK(visibility IN ('private', 'followers', 'public'));

UPDATE categories
SET visibility = CASE
  WHEN is_public = 0 THEN 'private'
  WHEN EXISTS (
    SELECT 1 FROM user_profiles
    WHERE user_profiles.user_id = categories.user_id
      AND user_profiles.is_public = 1
  ) THEN 'public'
  ELSE 'followers'
END;

CREATE INDEX IF NOT EXISTS idx_categories_user_visibility_sort
  ON categories(user_id, visibility, sort_order, name);
