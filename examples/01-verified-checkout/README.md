# 01 — Verified Checkout fulfillment

This recipe demonstrates Stripe webhook signature verification, paid-session checks, delayed-payment handling, and a server-controlled fulfillment boundary. The included in-memory store is **for tests only**. A PostgreSQL adapter and example schema are provided as a stronger reference, but still require review, database-backed integration tests, operational controls, and adaptation to your application before production use.

## Run tests

Requires Node.js 20+ and network access to install the pinned direct dependencies:

```sh
npm install --prefix examples/01-verified-checkout
npm test --prefix examples/01-verified-checkout
```

Tests use Stripe SDK-generated test signatures and synthetic event objects. They do not contact Stripe or grant real access.

## Handler behavior

- Requires an explicit `expectedLiveMode` setting and rejects signed events whose `livemode` flag does not match it.
- Verifies the signature against the raw request body before trusting event fields.
- Returns 400 for missing raw body/signature, invalid signature, or an invalid paid-session shape.
- Ignores unsupported event types.
- Does not fulfill a `checkout.session.completed` event while `payment_status` is unpaid; delayed payment methods should be handled when `checkout.session.async_payment_succeeded` arrives.
- Sends paid sessions to an explicit store interface.
- Returns 500 when fulfillment storage fails so Stripe can retry.

## Required production store contract

Replace the test store with a durable database implementation that performs all of the following in one transaction:

1. Claim the Stripe event ID and Checkout Session ID under unique constraints so webhook retries cannot duplicate work.
2. Load the server-created order by `session.metadata.order_id`; never trust an arbitrary client-supplied order ID as sufficient authorization.
3. Compare the stored expected Stripe session, product/price mapping, amount, currency, customer/order context, and payment state with the verified event.
4. Verify the order has not already been fulfilled, then create the entitlement and mark the order fulfilled atomically.
5. Return `fulfilled`, `already_fulfilled`, or `rejected`. A permanent mismatch must be recorded for investigation without granting access; transient database failures should throw so the handler returns 500.
6. Ensure two concurrent deliveries cannot both grant an entitlement. A process-local Set or in-memory cache is not sufficient.

The handler validates signature and basic session shape, but the durable store remains responsible for order-level authorization and idempotency. Do not deploy with the included test store.

## PostgreSQL reference adapter

Files:

- `schema.postgres.sql` — isolated example tables for pending orders, Stripe event outcomes, and entitlements.
- `postgres-store.js` — a PostgreSQL implementation of the fulfillment-store interface.
- `postgres-store.test.js` — unit tests using a fake pool; these do not connect to PostgreSQL.

Apply the schema only to a dedicated development/test database that you control. The order must be created by your trusted server before Checkout and contain the expected Checkout Session ID, amount, currency, application user ID, and product key. Never create authoritative orders from client-submitted values alone.

Minimal server-side wiring (keep `DATABASE_URL` in your secret manager and configure TLS according to your database provider):

```js
const { Pool } = require("pg");
const { createPostgresFulfillmentStore } = require("./postgres-store");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = createPostgresFulfillmentStore(pool);
// Pass this store to createApp({ stripe, endpointSecret, expectedLiveMode, store }).
// Close the pool during graceful shutdown with await pool.end().
```

Before the webhook can fulfill an order, your checkout-creation path must persist the server-created order and its actual Stripe Checkout Session ID. Adapt the sample schema to your account model and product/price catalog. Do not copy production order data into cookbook tests.

The adapter claims the event ID, locks the order row, compares the expected session ID, amount, currency, optional customer ID, payment status, and Checkout mode, then writes the entitlement and marks the order fulfilled inside one database transaction. Unique constraints prevent more than one entitlement per order. Database errors roll back and propagate so the webhook responds with a retryable 500. Permanent order mismatches are recorded as rejected and never grant access.

The adapter is an educational reference, not a drop-in production system. The included tests exercise transaction paths with a fake client, not PostgreSQL locking or real concurrent webhook deliveries. Before production, add integration tests against the same PostgreSQL major version as deployment, concurrency tests, migration/backup procedures, pool timeouts, least-privilege database roles, monitoring, and a reviewed policy for rejected-event replay. Confirm the schema and business rules with your application.

## Deployment notes

- Mount this route before any `express.json()` middleware so the SDK receives the exact raw body.
- Set the webhook endpoint secret independently from the Stripe API secret key.
- Set `expectedLiveMode: false` for test mode and `expectedLiveMode: true` for live mode; the handler refuses to start if this boolean is omitted. Keep endpoint secrets and runtime configuration separate for each mode.
- Configure only the event types the integration needs.
- Alert on rejected orders and repeated fulfillment failures; do not log secrets or full payment details.
- A success redirect is not proof of payment. Grant access only from the verified server-side flow.

## Limits

The tests prove handler behavior against synthetic events and exercise adapter decisions with a fake PostgreSQL client. They do not validate a real Stripe account, live webhook endpoint, actual PostgreSQL transaction isolation/locking, purchase fulfillment, or production security configuration.
