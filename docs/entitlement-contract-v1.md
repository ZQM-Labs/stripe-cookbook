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

## Durable projection outbox (required integration seam)

The PostgreSQL fulfillment transaction and a PocketBase write cannot commit atomically. The integration should therefore use a transactional outbox rather than attempting an untracked second write after the Stripe webhook has already returned success.

- In the same PostgreSQL transaction that creates the entitlement and marks the order fulfilled, insert an outbox row describing the authoritative entitlement state to project. If the transaction rolls back, the outbox row must roll back too.
- Give each logical projection a stable unique key, such as `order_id + contract_version` for this one-time-purchase example. Do not use a newly generated key on each retry.
- Store the stable `order_id`, internal `player_id` mapping reference, `product_key`, desired status, source version or monotonic update sequence, creation time, attempt count, and delivery metadata. Avoid storing secrets or unnecessary payment details in the payload.
- A worker claims pending rows with a bounded lease/claim timeout, calls a trusted server-side PocketBase adapter, and marks delivery complete only after the adapter confirms the expected state. Expired leases and transient errors must be retryable.
- The PocketBase projection must be idempotent under the stable external key. A timeout after PocketBase commits but before the worker records success must not create a second entitlement on retry.
- Apply only authoritative, newer state. A delayed retry must not reactivate an entitlement after a later revocation; compare a source version/sequence or re-read the authoritative PostgreSQL state before applying.
- Keep the webhook response independent of PocketBase availability once the authoritative PostgreSQL transaction succeeds. Alert on outbox age, repeated failures, and dead-letter/manual-review conditions; document safe replay and reconciliation procedures.
- Do not treat an outbox row as proof that the player can access content. Access checks must still enforce the server-controlled entitlement state and owner boundary.

The outbox is a recommended integration component, **not currently implemented by either cookbook**. Do not claim end-to-end fulfillment until the worker, PocketBase collection rules, identity mapping, reconciliation, and disposable-service tests exist.

### Outbox acceptance tests

- The entitlement, fulfilled order, event outcome, and outbox row commit together; injected failure leaves none of those partial writes behind.
- Concurrent duplicate webhook deliveries create one logical entitlement and one logical outbox item.
- Worker retry after a simulated PocketBase timeout converges to one entitlement.
- A worker crash after the PocketBase write but before marking delivery complete is safe to retry.
- Revocation followed by replay of an older pending projection cannot restore access.
- A missing or ambiguous player identity mapping fails closed and remains visible for operator resolution.
- Re-running reconciliation is idempotent and reports paid-but-unprojected and projected-but-no-longer-authorized records.

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
