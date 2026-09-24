-- D1 schema for the Plainsong Plus Worker. Counters and subscription status
-- only; no audio, transcript or prompt text is ever written.
CREATE TABLE IF NOT EXISTS usage (
  customer_id TEXT NOT NULL,
  period TEXT NOT NULL,              -- YYYY-MM, UTC
  dictation_seconds INTEGER NOT NULL DEFAULT 0,
  meeting_seconds INTEGER NOT NULL DEFAULT 0,
  llm_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (customer_id, period)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  customer_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,              -- active | canceled | past_due | revoked
  updated_at TEXT NOT NULL           -- ISO timestamp of the webhook event
);
