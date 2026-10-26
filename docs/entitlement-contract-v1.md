# Cross-service entitlement contract (v1)

**Status:** design contract for integration work; this is not an implemented Stripe-to-PocketBase bridge.

This contract defines the minimum data and trust boundary for applications combining the Stripe Cookbook's verified Checkout flow with PocketBase player identity. The cookbook examples remain independently runnable. An application must implement and test the adapter explicitly.

## Authority and flow

1. A trusted server creates an order and binds it to an authenticated internal player, an allowlisted product/entitlement key, expected amount/currency, and the actual Stripe Checkout Session.
2. Stripe's signed webhook is the payment signal. A success redirect, client request, PocketBase profile field, or client-supplied product key is not proof of payment.
3. The Stripe-side durable store validates the event against the server-created order and records the fulfillment decision transactionally.
4. A trusted server-side adapter projects the authoritative entitlement into PocketBase, or access checks consult the authoritative entitlement store directly. Player clients must never create, grant, change, or revoke paid entitlements.
5. If projection fails after payment is recorded, retry/reconcile from durable state. A PostgreSQL transaction and a PocketBase write are not one atomic transaction.

## Logical contract fields

| Field | Meaning | Invariant |
|---|---|---|
| `contract_version` | Version, initially `1` | Reject unsupported versions |
| `order_id` | Stable internal order ID | Created server-side; unique per purchase attempt |
| `player_id` | Stable internal player ID | Resolved from trusted auth context; never display name/email |
| `product_key` | Product/entitlement identifier | Server-owned allowlist; not arbitrary client input |
| `status` | `active` or `revoked` | Changed only by trusted server processing |
| `stripe_session_id` | Checkout Session for the order | Must match the stored order |
| `stripe_event_id` | Event used for processing/audit | Persist; deduplicate event processing |
| `granted_at` | Activation time | Server-generated |
| `revoked_at` | Revocation time, nullable | Set when status becomes revoked |
| `source_updated_at` | Last authoritative state change | Server-generated; used for reconciliation |

The Stripe PostgreSQL example calls its player identifier `app_user_id`; PocketBase uses its own record IDs. Do not assume those identifiers are interchangeable. Define and validate an explicit identity mapping before wiring the systems together.

## Idempotency and reconciliation

- Enforce a unique logical entitlement key in the authoritative store. The current Stripe sample allows one entitlement per `order_id`; subscriptions or repeatable purchases may need a different key.
- Deduplicate Stripe events by event ID, validate session/order consistency, and do not rely on event arrival order.
- Make PocketBase projection idempotent with a stable external key. Retries must update the same logical entitlement rather than create duplicates.
- Never overwrite newer state with an older event. Reconciliation compares authoritative state and version/timestamp, not merely event arrival time.
- Define refund, dispute, cancellation, partial-refund, chargeback, and manual-revocation policy before claiming revocation is automated.
- Detect both paid orders lacking projected entitlements and projected entitlements whose authoritative source is no longer entitled.

## PocketBase security boundary

The PocketBase player-auth recipe does not currently define an entitlement collection or a Stripe adapter. If an entitlement collection is added, deny ordinary player clients create/update/delete access; scope reads to the owning player or an authorized server; and keep paid-entitlement truth out of client-editable profile or role fields. Test collection rules on a disposable instance with synthetic Player A and Player B. Static CI cannot prove deployed rules.

## Required integration tests before production

Use disposable services and synthetic players/orders only:

- A valid paid order projects the correct player and product entitlement.
- Duplicate and concurrent webhook delivery creates one logical entitlement.
- Wrong player, product, order, session, amount, currency, or unpaid status never grants access.
- Projection failure is retryable; reconciliation repairs the gap without duplicate grants.
- Player A cannot read Player B's entitlement or mutate either player's entitlement.
- Refund/revocation, older-event replay, and manual revocation follow a documented policy.
- Re-running reconciliation is safe and cannot accidentally restore revoked access.

## Current implementation boundary

The Stripe Cookbook has a PostgreSQL reference fulfillment store; the PocketBase Cookbook has opt-in player-profile access tests. Neither currently implements this bridge. Existing tests do not prove PocketBase collection rules, deployed routing, production database behavior, or end-to-end purchase fulfillment.

Keep this contract aligned across both repositories until a versioned shared contract artifact is adopted.
