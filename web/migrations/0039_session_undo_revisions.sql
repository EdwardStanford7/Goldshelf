-- Keep maintenance comparisons out of the potentially large Undo JSON blobs.
ALTER TABLE ranking_sessions ADD COLUMN undo_revision INTEGER;
ALTER TABLE repair_sessions ADD COLUMN undo_revision INTEGER;
UPDATE ranking_sessions SET undo_revision = CASE WHEN json_valid(undo_state)
  THEN json_extract(undo_state, '$.expectedRevision') END WHERE undo_state IS NOT NULL;
UPDATE repair_sessions SET undo_revision = CASE WHEN json_valid(undo_state)
  THEN json_extract(undo_state, '$.expectedRevision') END WHERE undo_state IS NOT NULL;
DROP INDEX idx_ranking_closed_payloads;
DROP INDEX idx_repair_closed_payloads;
CREATE INDEX idx_ranking_closed_payloads ON ranking_sessions(completed_at, user_id, undo_revision, status)
  WHERE status IN ('completed', 'cancelled') AND (undo_state IS NOT NULL OR operation_state IS NOT NULL);
CREATE INDEX idx_repair_closed_payloads ON repair_sessions(completed_at, user_id, undo_revision, status)
  WHERE status IN ('completed', 'cancelled') AND (undo_state IS NOT NULL OR operation_state IS NOT NULL);

-- Compatibility for an older Worker during rollout. New code supplies both
-- fields together, so these triggers do not add another write in normal use.
CREATE TRIGGER ranking_sessions_undo_revision_update AFTER UPDATE OF undo_state ON ranking_sessions
WHEN NEW.undo_revision IS NOT (CASE WHEN json_valid(NEW.undo_state) THEN json_extract(NEW.undo_state, '$.expectedRevision') END)
BEGIN
  UPDATE ranking_sessions SET undo_revision = CASE WHEN json_valid(NEW.undo_state)
    THEN json_extract(NEW.undo_state, '$.expectedRevision') END WHERE id = NEW.id;
END;
CREATE TRIGGER ranking_sessions_undo_revision_insert AFTER INSERT ON ranking_sessions
WHEN NEW.undo_state IS NOT NULL AND NEW.undo_revision IS NOT (CASE WHEN json_valid(NEW.undo_state)
  THEN json_extract(NEW.undo_state, '$.expectedRevision') END)
BEGIN
  UPDATE ranking_sessions SET undo_revision = CASE WHEN json_valid(NEW.undo_state)
    THEN json_extract(NEW.undo_state, '$.expectedRevision') END WHERE id = NEW.id;
END;
CREATE TRIGGER repair_sessions_undo_revision_update AFTER UPDATE OF undo_state ON repair_sessions
WHEN NEW.undo_revision IS NOT (CASE WHEN json_valid(NEW.undo_state) THEN json_extract(NEW.undo_state, '$.expectedRevision') END)
BEGIN
  UPDATE repair_sessions SET undo_revision = CASE WHEN json_valid(NEW.undo_state)
    THEN json_extract(NEW.undo_state, '$.expectedRevision') END WHERE id = NEW.id;
END;
CREATE TRIGGER repair_sessions_undo_revision_insert AFTER INSERT ON repair_sessions
WHEN NEW.undo_state IS NOT NULL AND NEW.undo_revision IS NOT (CASE WHEN json_valid(NEW.undo_state)
  THEN json_extract(NEW.undo_state, '$.expectedRevision') END)
BEGIN
  UPDATE repair_sessions SET undo_revision = CASE WHEN json_valid(NEW.undo_state)
    THEN json_extract(NEW.undo_state, '$.expectedRevision') END WHERE id = NEW.id;
END;
