-- Sotto's copy of product events (ADR-0179). `body` is the event as the Worker rebuilt it. No IP address or header is stored.
CREATE TABLE IF NOT EXISTS product_events (
  uuid TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  event TEXT NOT NULL,
  body TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS product_events_received_at ON product_events (received_at);
