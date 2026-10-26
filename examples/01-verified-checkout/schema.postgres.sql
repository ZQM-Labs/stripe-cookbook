-- Example schema for the Stripe Cookbook only.
-- Apply to a dedicated database/schema; adapt names and retention to your application.
CREATE TABLE IF NOT EXISTS cookbook_orders (
  id TEXT PRIMARY KEY,
  app_user_id TEXT NOT NULL,
  product_key TEXT NOT NULL,
  stripe_session_id TEXT NOT NULL UNIQUE,
  expected_amount_total BIGINT NOT NULL CHECK (expected_amount_total >= 0),
  expected_currency TEXT NOT NULL CHECK (expected_currency = lower(expected_currency)),
  expected_customer_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fulfilled', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  fulfilled_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS cookbook_stripe_events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('processing', 'fulfilled', 'already_fulfilled', 'rejected')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS cookbook_entitlements (
  id BIGSERIAL PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES cookbook_orders(id),
  app_user_id TEXT NOT NULL,
  product_key TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cookbook_stripe_events_created_at_idx
  ON cookbook_stripe_events (created_at);
