ALTER TABLE image_assets ADD COLUMN deleting INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER fence_entry_image_insert BEFORE INSERT ON entries
WHEN (NEW.image_key LIKE 'entry-images/sha256/%' AND NOT EXISTS(SELECT 1 FROM image_assets WHERE object_key = NEW.image_key AND deleting = 0))
BEGIN SELECT RAISE(ABORT, 'Image cleanup is in progress. Please try again.'); END;
CREATE TRIGGER fence_entry_image_update BEFORE UPDATE OF image_key ON entries
WHEN (NEW.image_key LIKE 'entry-images/sha256/%' AND NOT EXISTS(SELECT 1 FROM image_assets WHERE object_key = NEW.image_key AND deleting = 0))
BEGIN SELECT RAISE(ABORT, 'Image cleanup is in progress. Please try again.'); END;
CREATE TRIGGER fence_queue_image_insert BEFORE INSERT ON entry_queue
WHEN (NEW.image_key LIKE 'entry-images/sha256/%' AND NOT EXISTS(SELECT 1 FROM image_assets WHERE object_key = NEW.image_key AND deleting = 0))
BEGIN SELECT RAISE(ABORT, 'Image cleanup is in progress. Please try again.'); END;
CREATE TRIGGER fence_queue_image_update BEFORE UPDATE OF image_key ON entry_queue
WHEN (NEW.image_key LIKE 'entry-images/sha256/%' AND NOT EXISTS(SELECT 1 FROM image_assets WHERE object_key = NEW.image_key AND deleting = 0))
BEGIN SELECT RAISE(ABORT, 'Image cleanup is in progress. Please try again.'); END;
CREATE TRIGGER fence_user_image_update BEFORE UPDATE OF image ON "user"
WHEN (NEW.image LIKE 'entry-images/sha256/%' AND NOT EXISTS(SELECT 1 FROM image_assets WHERE object_key = NEW.image AND deleting = 0))
BEGIN SELECT RAISE(ABORT, 'Image cleanup is in progress. Please try again.'); END;
