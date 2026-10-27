# Stripe Cookbook

<!-- ZQM-START -->
<!-- markdownlint-disable MD033 -->
<p align="center">
  <strong>ZQM Labs</strong><br>
  <a href="https://github.com/ZQM-Labs">ZQM Labs</a>
</p>
<!-- markdownlint-enable MD033 -->
<!-- ZQM-END -->

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

A **Stripe cookbook** for game commerce: checkout, webhook verification, idempotent fulfillment, refunds, and entitlement boundaries. The primary use case is selling game kits and hosted-game access without trusting client-controlled purchase state.

## Repository role and status

**Status:** Includes a verified webhook-handler recipe, synthetic tests, a PostgreSQL fulfillment adapter/schema, and an opt-in PostgreSQL 16 integration suite covering duplicate replay, concurrent fulfillment, event-ID reuse with a mismatched session, unpaid sessions, and order/session/payment mismatches. The reference adapter is educational and is not a live payment integration; application-specific security review, deployment-version parity, operational reconciliation, and end-to-end integration with the consuming backend remain required.

**What this repository is:** Security-conscious, testable Stripe integration patterns for game products and digital entitlements.

**What it contributes:** Part of the ZQM Labs game-development portfolio. It complements the PocketBase Cookbook by documenting payment-provider events and the server-controlled entitlement boundary.

## Cross-service integration

The companion [PocketBase Cookbook](https://github.com/ZQM-Labs/pocketbase-cookbook) covers player identity and access rules. The shared design boundary for paid access is documented in [Entitlement Contract v1](docs/entitlement-contract-v1.md). It specifies identity mapping, idempotent projection, revocation/reconciliation requirements, and the integration tests still needed. This is a design contract, **not** a deployed Stripe-to-PocketBase bridge.

## Security invariants

- Never accept client-supplied claims that a checkout has been paid.
- Verify webhook signatures using the exact raw request body and endpoint secret.
- Handle duplicate and out-of-order events safely; use durable idempotency keys and transactional storage.
- Grant an entitlement only after validating the Checkout Session, payment state, product/order mapping, and expected customer/order context.
- Keep secret keys and webhook secrets in a secret manager or protected environment; never commit them.
- Treat redirecting the buyer to a success page as UX, not proof of payment.
- Test with Stripe test-mode objects before any live-mode rollout.

## Patterns

### 01 — Verified Checkout fulfillment (implemented test harness)

[Open the recipe](examples/01-verified-checkout/). Requires an explicit test/live mode setting, verifies webhook signatures against the raw request body, handles paid and delayed-payment Checkout Session events, rejects mode mismatches and malformed session data, and returns a retryable 500 on transient storage errors. Tests use synthetic signed events; adapter unit tests use a fake PostgreSQL client. The PostgreSQL reference adapter is documented separately and is not production-certified.

## Quick start

From the repository root:

```sh
npm install --prefix examples/01-verified-checkout
npm test --prefix examples/01-verified-checkout
```

CI runs these tests on pull requests and pushes to main. The direct dependencies are pinned in the example manifest, but a committed lockfile is still needed to freeze transitive dependency resolution.

## Repository layout

```text
stripe-cookbook/
├── .github/workflows/examples.yml
├── docs/
│   └── entitlement-contract-v1.md
├── examples/
│   └── 01-verified-checkout/
│       ├── app.js
│       ├── app.test.js
│       ├── postgres-store.js
│       ├── postgres-store.test.js
│       ├── postgres-store.integration.test.js
│       ├── schema.postgres.sql
│       ├── package.json
│       └── README.md
└── README.md
```

## Production store requirements

Before adapting the handler for live purchases, verify that the production database version and schema match the chosen adapter, enforce uniqueness for event/session/order fulfillment, and define retry/reconciliation behavior for downstream entitlement projection. Run the opt-in PostgreSQL integration suite against an isolated disposable database and retain its exact-head CI evidence. The tests do not certify production configuration or a Stripe-to-PocketBase bridge. Never use the included in-memory store for live entitlements.

## How this cookbook connects to the ZQM Labs stack

Stripe owns **payment-event verification and fulfillment decisions** in the reference architecture. It does not replace player authentication or resource authorization.

| Concern | Related cookbook | Handoff contract |
|---|---|---|
| Game client and purchase UX | [Godot Cookbook](https://github.com/ZQM-Labs/godot-cookbook) | The client may initiate checkout and display outcomes, but must not grant paid access based on query parameters or a success-page redirect. |
| Browser purchase-flow regression tests | [Playwright Cookbook](https://github.com/ZQM-Labs/playwright-cookbook) | Test UI flow separately from webhook and durable-store tests; full integration requires a disposable environment and synthetic orders. |
| Player identity and protected content | [PocketBase Cookbook](https://github.com/ZQM-Labs/pocketbase-cookbook) | Map verified fulfillment to a server-controlled entitlement associated with a stable internal player identity. Access checks must be enforced server-side. |

### Entitlement handoff requirements

Before connecting this recipe to a game backend, define the canonical order ID, internal player ID, product/entitlement mapping, unique fulfillment constraints, idempotent event handling, refund/revocation policy, and reconciliation path. Keep Stripe secrets and entitlement writes on trusted server infrastructure.

This repository's PostgreSQL adapter and tests are reference material, **not a production-certified bridge to PocketBase**. The cookbooks currently do not share a deployment, database schema, credentials, or integrated end-to-end pipeline. Prove each contract against isolated test services before any live-mode rollout.

## Contributing

Each recipe should include exact dependency versions, executable tests, an explicit trust boundary, failure/retry behavior, and known limitations. Do not include live API keys, customer data, or production webhook payloads.

Report security issues to <zqmcomputing@gmail.com> — please do not open a public issue for those.
