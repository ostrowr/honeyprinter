CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  received_at_ms INTEGER NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  source_ip TEXT NOT NULL,
  service TEXT NOT NULL,
  outcome TEXT NOT NULL,
  payload TEXT NOT NULL
);
-- Cursor reads and retention use the integer primary key; no per-field indexes.
CREATE TABLE summary_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_event_id INTEGER NOT NULL DEFAULT 0,
  last_receipt_ms INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until_ms INTEGER NOT NULL DEFAULT 0
);
INSERT INTO summary_state (id) VALUES (1);
CREATE TABLE receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL,
  first_event_id INTEGER NOT NULL,
  last_event_id INTEGER NOT NULL,
  probe_count INTEGER NOT NULL,
  payload TEXT NOT NULL,
  enqueued_at_ms INTEGER
);
CREATE INDEX receipts_pending ON receipts(id) WHERE enqueued_at_ms IS NULL;
