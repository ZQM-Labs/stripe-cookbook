# 01 — Verified Checkout fulfillment

This recipe demonstrates Stripe webhook signature verification, paid-session checks, delayed-payment handling, and a server-controlled fulfillment boundary. The included in-memory store is **for tests only**. It demonstrates the interface contract; it is not durable, transactional storage and must not be used for real entitlements.

## Run tests

Requires Node.js 20+ and network access to install the pinned direct dependencies:

```sh
npm install --prefix examples/01-verified-checkout
npm test --prefix examples/01-verified-checkout
```

Tests use Stripe SDK-generated test signatures and synthetic event objects. They do not contact Stripe or grant real access.

## Handler behavior

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

## Deployment notes

- Mount this route before any `express.json()` middleware so the SDK receives the exact raw body.
- Set the webhook endpoint secret independently from the Stripe API secret key.
- Keep live and test mode configuration separate.
- Configure only the event types the integration needs.
- Alert on rejected orders and repeated fulfillment failures; do not log secrets or full payment details.
- A success redirect is not proof of payment. Grant access only from the verified server-side flow.

## Limits

The tests prove handler behavior against synthetic events and a fake store. They do not validate a real Stripe account, live webhook endpoint, database transaction, purchase fulfillment, or production security configuration.
