-- Directory search is read-heavy and previously used a leading-wildcard LIKE
-- scan. Keep a small FTS index in sync with handles and display names.
CREATE VIRTUAL TABLE IF NOT EXISTS profile_search USING fts5(
  user_id UNINDEXED,
  slug,
  name,
  tokenize = 'unicode61 remove_diacritics 2'
);

INSERT INTO profile_search (user_id, slug, name)
SELECT user_profiles.user_id, user_profiles.slug, "user".name
FROM user_profiles
INNER JOIN "user" ON "user".id = user_profiles.user_id;

CREATE TRIGGER IF NOT EXISTS profile_search_after_profile_insert
AFTER INSERT ON user_profiles
BEGIN
  INSERT INTO profile_search (user_id, slug, name)
  SELECT NEW.user_id, NEW.slug, name FROM "user" WHERE id = NEW.user_id;
END;

CREATE TRIGGER IF NOT EXISTS profile_search_after_profile_slug_update
AFTER UPDATE OF slug ON user_profiles
BEGIN
  DELETE FROM profile_search WHERE user_id = NEW.user_id;
  INSERT INTO profile_search (user_id, slug, name)
  SELECT NEW.user_id, NEW.slug, name FROM "user" WHERE id = NEW.user_id;
END;

CREATE TRIGGER IF NOT EXISTS profile_search_after_profile_delete
AFTER DELETE ON user_profiles
BEGIN
  DELETE FROM profile_search WHERE user_id = OLD.user_id;
END;

CREATE TRIGGER IF NOT EXISTS profile_search_after_user_name_update
AFTER UPDATE OF name ON "user"
WHEN EXISTS (SELECT 1 FROM user_profiles WHERE user_id = NEW.id)
BEGIN
  DELETE FROM profile_search WHERE user_id = NEW.id;
  INSERT INTO profile_search (user_id, slug, name)
  SELECT user_profiles.user_id, user_profiles.slug, NEW.name
  FROM user_profiles WHERE user_id = NEW.id;
END;

-- Supports the public-shelf and accepted-follower aggregations used by the
-- trending directory query.
CREATE INDEX IF NOT EXISTS idx_categories_visibility_user
  ON categories(visibility, user_id);

CREATE INDEX IF NOT EXISTS idx_user_follows_status_followed
  ON user_follows(status, followed_user_id);
