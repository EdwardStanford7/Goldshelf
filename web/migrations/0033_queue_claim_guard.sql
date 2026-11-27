-- Transaction-local assertions: successful batches remove their guard row;
-- failed checks roll back the entire queue-to-ranking transition.
CREATE TABLE queue_claim_guards (
  id TEXT PRIMARY KEY,
  available INTEGER NOT NULL CONSTRAINT queue_entry_changed CHECK (available = 1)
);
