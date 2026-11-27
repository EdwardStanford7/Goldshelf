CREATE TABLE user_data_versions (user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE, revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE mutation_guards (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, valid INTEGER NOT NULL CONSTRAINT stale_mutation CHECK(valid = 1));
CREATE INDEX mutation_guards_user ON mutation_guards(user_id);
ALTER TABLE categories ADD COLUMN data_revision TEXT NOT NULL DEFAULT '';
ALTER TABLE ranking_sessions ADD COLUMN matchup_version TEXT NOT NULL DEFAULT '';
ALTER TABLE repair_sessions ADD COLUMN matchup_version TEXT NOT NULL DEFAULT '';
CREATE TRIGGER ranking_matchup_version AFTER UPDATE ON ranking_sessions
WHEN NEW.matchup_version = OLD.matchup_version BEGIN
  UPDATE ranking_sessions SET matchup_version = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;
CREATE TRIGGER repair_matchup_version AFTER UPDATE ON repair_sessions
WHEN NEW.matchup_version = OLD.matchup_version BEGIN
  UPDATE repair_sessions SET matchup_version = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;
CREATE TRIGGER entries_category_revision_insert AFTER INSERT ON entries BEGIN
  -- Reuse the transaction's guard token so a bulk rewrite stamps each shelf
  -- once. Unscoped maintenance/seed writes receive a fresh opaque token.
  UPDATE categories SET data_revision = COALESCE(
    (SELECT id FROM mutation_guards WHERE user_id = NEW.user_id LIMIT 1), lower(hex(randomblob(16))))
  WHERE id = NEW.category_id AND data_revision IS NOT
    (SELECT id FROM mutation_guards WHERE user_id = NEW.user_id LIMIT 1);
END;
CREATE TRIGGER entries_category_revision_update AFTER UPDATE ON entries BEGIN
  UPDATE categories SET data_revision = COALESCE(
    (SELECT id FROM mutation_guards WHERE user_id = NEW.user_id LIMIT 1), lower(hex(randomblob(16))))
  WHERE id IN (OLD.category_id, NEW.category_id) AND data_revision IS NOT
    (SELECT id FROM mutation_guards WHERE user_id = NEW.user_id LIMIT 1);
END;
CREATE TRIGGER entries_category_revision_delete AFTER DELETE ON entries BEGIN
  UPDATE categories SET data_revision = COALESCE(
    (SELECT id FROM mutation_guards WHERE user_id = OLD.user_id LIMIT 1), lower(hex(randomblob(16))))
  WHERE id = OLD.category_id AND data_revision IS NOT
    (SELECT id FROM mutation_guards WHERE user_id = OLD.user_id LIMIT 1);
END;
