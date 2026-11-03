-- Sotto's copy of product events (ADR-0179). `body` is the event as the Worker rebuilt it. No IP address or header is stored.
CREATE TABLE IF NOT EXISTS product_events (
  uuid TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  event TEXT NOT NULL,
  body TEXT NOT NULL,
  -- 1 only while PostHog still has to take it. A row kept before there was a key stays 0, so setting the key sends none of them.
  forward_due INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS product_events_received_at ON product_events (received_at);
CREATE INDEX IF NOT EXISTS product_events_forward_due ON product_events (received_at) WHERE forward_due = 1;
