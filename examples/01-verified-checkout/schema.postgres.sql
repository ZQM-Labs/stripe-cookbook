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

-- Durable projection queue: written in the same transaction as fulfillment.
-- A separate trusted worker must deliver these records to PocketBase.
CREATE TABLE IF NOT EXISTS cookbook_entitlement_outbox (
  projection_key TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES cookbook_orders(id),
  app_user_id TEXT NOT NULL,
  product_key TEXT NOT NULL,
  desired_status TEXT NOT NULL CHECK (desired_status IN ('active', 'revoked')),
  source_version BIGINT NOT NULL CHECK (source_version > 0),
  delivery_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending', 'in_progress', 'delivered', 'dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  UNIQUE (order_id, source_version)
);

CREATE INDEX IF NOT EXISTS cookbook_entitlement_outbox_pending_idx
  ON cookbook_entitlement_outbox (available_at, created_at)
  WHERE delivery_status IN ('pending', 'in_progress');
