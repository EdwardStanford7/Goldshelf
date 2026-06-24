ALTER TABLE ranking_sessions
  ADD COLUMN undo_state TEXT;

ALTER TABLE repair_sessions
  ADD COLUMN undo_state TEXT;
