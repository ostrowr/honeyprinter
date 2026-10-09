-- Quiet-minute reports are webpage-only; keep them out of the print outbox.
DROP INDEX receipts_pending;
CREATE INDEX receipts_pending ON receipts(id) WHERE enqueued_at_ms IS NULL AND probe_count > 0;
