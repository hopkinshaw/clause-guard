BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS billing_wallets (
  id uuid PRIMARY KEY,
  free_used integer NOT NULL DEFAULT 0 CHECK (free_used >= 0),
  paid_balance integer NOT NULL DEFAULT 0 CHECK (paid_balance >= 0)
);

CREATE TABLE IF NOT EXISTS billing_networks (
  id text PRIMARY KEY,
  free_used integer NOT NULL DEFAULT 0 CHECK (free_used >= 0)
);

CREATE TABLE IF NOT EXISTS billing_daily (
  day date PRIMARY KEY,
  attempts integer NOT NULL DEFAULT 0,
  free_attempts integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS billing_reservations (
  wallet_id uuid PRIMARY KEY REFERENCES billing_wallets(id),
  id uuid UNIQUE NOT NULL,
  network_id text REFERENCES billing_networks(id),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS billing_reservations_network_expiry
  ON billing_reservations (network_id, expires_at) WHERE network_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS billing_purchases (
  session_id text PRIMARY KEY,
  wallet_id uuid NOT NULL REFERENCES billing_wallets(id),
  pack_id text NOT NULL,
  credits integer NOT NULL CHECK (credits > 0),
  amount integer NOT NULL CHECK (amount > 0),
  credited_at timestamptz
);

-- Upgrade existing installations without resetting balances or crediting a checkout again.
ALTER TABLE billing_wallets
  ADD COLUMN IF NOT EXISTS used_analyses bigint CHECK (used_analyses >= 0),
  ADD COLUMN IF NOT EXISTS purchased_credits bigint CHECK (purchased_credits >= 0),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;

WITH historical_credits AS (
  SELECT wallet_id, SUM(credits) AS purchased
  FROM billing_purchases
  WHERE credited_at IS NOT NULL
  GROUP BY wallet_id
), balances_to_upgrade AS (
  SELECT w.id, w.free_used, w.paid_balance,
         GREATEST(COALESCE(h.purchased, 0), w.paid_balance) AS purchased
  FROM billing_wallets w
  LEFT JOIN historical_credits h ON h.wallet_id = w.id
  WHERE w.used_analyses IS NULL OR w.purchased_credits IS NULL OR w.updated_at IS NULL
)
UPDATE billing_wallets w
SET used_analyses = COALESCE(w.used_analyses, legacy.free_used + legacy.purchased - legacy.paid_balance),
    purchased_credits = COALESCE(w.purchased_credits, legacy.purchased),
    updated_at = COALESCE(w.updated_at, now())
FROM balances_to_upgrade legacy
WHERE w.id = legacy.id;

ALTER TABLE billing_wallets
  ALTER COLUMN used_analyses SET DEFAULT 0,
  ALTER COLUMN used_analyses SET NOT NULL,
  ALTER COLUMN purchased_credits SET DEFAULT 0,
  ALTER COLUMN purchased_credits SET NOT NULL,
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET NOT NULL;

COMMIT;
