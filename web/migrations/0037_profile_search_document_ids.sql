-- Stable document IDs avoid a scan of the FTS table on each profile edit.
CREATE TABLE profile_search_ids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL UNIQUE REFERENCES user_profiles(user_id) ON DELETE CASCADE
);
INSERT INTO profile_search_ids (user_id) SELECT user_id FROM user_profiles;
DELETE FROM profile_search;
INSERT INTO profile_search (rowid, user_id, slug, name)
SELECT docs.id, p.user_id, p.slug, u.name FROM user_profiles p
JOIN "user" u ON u.id = p.user_id JOIN profile_search_ids docs ON docs.user_id = p.user_id;

DROP TRIGGER profile_search_after_profile_insert;
DROP TRIGGER profile_search_after_profile_slug_update;
DROP TRIGGER profile_search_after_profile_delete;
DROP TRIGGER profile_search_after_user_name_update;

CREATE TRIGGER profile_search_after_profile_insert AFTER INSERT ON user_profiles BEGIN
  INSERT INTO profile_search_ids (user_id) VALUES (NEW.user_id);
  INSERT INTO profile_search (rowid, user_id, slug, name)
    SELECT docs.id, NEW.user_id, NEW.slug, u.name FROM "user" u
    JOIN profile_search_ids docs ON docs.user_id = u.id WHERE u.id = NEW.user_id;
END;
CREATE TRIGGER profile_search_after_profile_slug_update AFTER UPDATE OF slug ON user_profiles
WHEN OLD.slug IS NOT NEW.slug BEGIN
  DELETE FROM profile_search WHERE rowid = (SELECT id FROM profile_search_ids WHERE user_id = NEW.user_id);
  INSERT INTO profile_search (rowid, user_id, slug, name)
    SELECT docs.id, NEW.user_id, NEW.slug, u.name FROM "user" u
    JOIN profile_search_ids docs ON docs.user_id = u.id WHERE u.id = NEW.user_id;
END;
CREATE TRIGGER profile_search_before_profile_delete BEFORE DELETE ON user_profiles BEGIN
  DELETE FROM profile_search WHERE rowid = (SELECT id FROM profile_search_ids WHERE user_id = OLD.user_id);
END;
CREATE TRIGGER profile_search_after_user_name_update AFTER UPDATE OF name ON "user"
WHEN OLD.name IS NOT NEW.name BEGIN
  DELETE FROM profile_search WHERE rowid = (SELECT id FROM profile_search_ids WHERE user_id = NEW.id);
  INSERT INTO profile_search (rowid, user_id, slug, name)
    SELECT docs.id, p.user_id, p.slug, NEW.name FROM user_profiles p
    JOIN profile_search_ids docs ON docs.user_id = p.user_id WHERE p.user_id = NEW.id;
END;
