-- Counts stay accurate without recounting the whole library on each page load.
-- Scoped writes mark affected shelves once; deleting their mutation guard
-- recounts dirty shelves once in the same transaction. Unscoped maintenance writes
-- apply their count delta directly.
ALTER TABLE categories ADD COLUMN active_entry_count INTEGER NOT NULL DEFAULT 0 CHECK(active_entry_count >= 0);
ALTER TABLE categories ADD COLUMN count_dirty INTEGER NOT NULL DEFAULT 0;
UPDATE categories SET active_entry_count = (
  SELECT COUNT(*) FROM entries WHERE entries.user_id = categories.user_id
    AND entries.category_id = categories.id AND entries.status = 'active'
);
DROP TRIGGER entries_category_revision_insert;
DROP TRIGGER entries_category_revision_update;
DROP TRIGGER entries_category_revision_delete;
CREATE TRIGGER entries_category_revision_insert AFTER INSERT ON entries BEGIN
  UPDATE categories SET
    data_revision = COALESCE((SELECT id FROM mutation_guards WHERE user_id = NEW.user_id LIMIT 1), lower(hex(randomblob(16)))),
    active_entry_count = active_entry_count + CASE WHEN (SELECT id FROM mutation_guards WHERE user_id = NEW.user_id LIMIT 1) IS NULL THEN (CASE WHEN NEW.status = 'active' THEN 1 ELSE 0 END) ELSE 0 END,
    count_dirty = CASE WHEN (SELECT id FROM mutation_guards WHERE user_id = NEW.user_id LIMIT 1) IS NOT NULL AND (CASE WHEN NEW.status = 'active' THEN 1 ELSE 0 END) != 0 THEN 1 ELSE count_dirty END
  WHERE id = NEW.category_id AND (data_revision IS NOT (SELECT id FROM mutation_guards WHERE user_id = NEW.user_id LIMIT 1) OR (count_dirty = 0 AND (CASE WHEN NEW.status = 'active' THEN 1 ELSE 0 END) != 0));
END;
-- The previous Worker already deletes guards at the end of each write batch.
-- Keeping this invariant in SQL also makes migration-before-deploy safe.
CREATE TRIGGER flush_shelf_counts_before_guard_delete BEFORE DELETE ON mutation_guards
WHEN EXISTS (SELECT 1 FROM categories WHERE user_id = OLD.user_id
  AND data_revision = OLD.id AND count_dirty = 1)
BEGIN
  UPDATE categories SET active_entry_count = (
    SELECT COUNT(*) FROM entries WHERE entries.user_id = categories.user_id
      AND entries.category_id = categories.id AND entries.status = 'active'
  ), count_dirty = 0
  WHERE user_id = OLD.user_id AND data_revision = OLD.id AND count_dirty = 1;
END;
CREATE TRIGGER entries_category_revision_update AFTER UPDATE ON entries BEGIN
  UPDATE categories SET
    data_revision = COALESCE((SELECT id FROM mutation_guards WHERE user_id = NEW.user_id LIMIT 1), lower(hex(randomblob(16)))),
    active_entry_count = active_entry_count + CASE WHEN (SELECT id FROM mutation_guards WHERE user_id = NEW.user_id LIMIT 1) IS NULL THEN (CASE WHEN id = NEW.category_id AND NEW.status = 'active' THEN 1 ELSE 0 END - CASE WHEN id = OLD.category_id AND OLD.status = 'active' THEN 1 ELSE 0 END) ELSE 0 END,
    count_dirty = CASE WHEN (SELECT id FROM mutation_guards WHERE user_id = NEW.user_id LIMIT 1) IS NOT NULL AND (CASE WHEN id = NEW.category_id AND NEW.status = 'active' THEN 1 ELSE 0 END - CASE WHEN id = OLD.category_id AND OLD.status = 'active' THEN 1 ELSE 0 END) != 0 THEN 1 ELSE count_dirty END
  WHERE id IN (OLD.category_id, NEW.category_id) AND (data_revision IS NOT (SELECT id FROM mutation_guards WHERE user_id = NEW.user_id LIMIT 1) OR (count_dirty = 0 AND (CASE WHEN id = NEW.category_id AND NEW.status = 'active' THEN 1 ELSE 0 END - CASE WHEN id = OLD.category_id AND OLD.status = 'active' THEN 1 ELSE 0 END) != 0));
END;
CREATE TRIGGER entries_category_revision_delete AFTER DELETE ON entries BEGIN
  UPDATE categories SET
    data_revision = COALESCE((SELECT id FROM mutation_guards WHERE user_id = OLD.user_id LIMIT 1), lower(hex(randomblob(16)))),
    active_entry_count = active_entry_count + CASE WHEN (SELECT id FROM mutation_guards WHERE user_id = OLD.user_id LIMIT 1) IS NULL THEN (CASE WHEN OLD.status = 'active' THEN -1 ELSE 0 END) ELSE 0 END,
    count_dirty = CASE WHEN (SELECT id FROM mutation_guards WHERE user_id = OLD.user_id LIMIT 1) IS NOT NULL AND (CASE WHEN OLD.status = 'active' THEN -1 ELSE 0 END) != 0 THEN 1 ELSE count_dirty END
  WHERE id = OLD.category_id AND (data_revision IS NOT (SELECT id FROM mutation_guards WHERE user_id = OLD.user_id LIMIT 1) OR (count_dirty = 0 AND (CASE WHEN OLD.status = 'active' THEN -1 ELSE 0 END) != 0));
END;
