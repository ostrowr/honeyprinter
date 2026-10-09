-- Compact minute totals are independent of raw-event retention.
CREATE TABLE activity_minutes (
  minute_ms INTEGER NOT NULL,
  port INTEGER NOT NULL,
  service TEXT NOT NULL,
  outcome TEXT NOT NULL,
  probes INTEGER NOT NULL,
  PRIMARY KEY (minute_ms, port, service, outcome)
) WITHOUT ROWID;
ALTER TABLE summary_state ADD COLUMN activity_json TEXT;
-- A separate cursor lets the first new cron include already consumed traffic,
-- even if the old Worker generated receipts between migration and deployment.
ALTER TABLE summary_state ADD COLUMN activity_last_event_id INTEGER NOT NULL DEFAULT 0;
