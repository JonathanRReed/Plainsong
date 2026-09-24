-- D1 schema for the Plainsong Plus Worker. Counters, subscription status and
-- (Stripe billing only) license key hashes; no audio, transcript or prompt
-- text is ever written.
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

-- Stripe billing only: Polar keeps its own license keys and activations.
CREATE TABLE IF NOT EXISTS licenses (
  key_hash TEXT PRIMARY KEY,         -- SHA-256 of the key; the key itself is never stored
  customer_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activations (
  key_hash TEXT NOT NULL,
  activation_id TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (key_hash, activation_id)
);
