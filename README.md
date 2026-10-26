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

**Status:** Initialized with a first executable webhook-handler recipe and synthetic tests. The included storage adapter is test-only; no production payment integration is provided.

**What this repository is:** Security-conscious, testable Stripe integration patterns for game products and digital entitlements.

**What it contributes:** Part of the ZQM Labs game-development portfolio. It complements the PocketBase Cookbook by documenting payment-provider events and the server-controlled entitlement boundary.

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

[Open the recipe](examples/01-verified-checkout/). Verifies webhook signatures against the raw request body, handles paid and delayed-payment Checkout Session events, rejects malformed session data, and returns a retryable 500 on transient storage errors. Tests use synthetic signed events and an in-memory idempotency adapter; production requires a durable transactional store.

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
├── examples/
│   └── 01-verified-checkout/
│       ├── app.js
│       ├── app.test.js
│       ├── package.json
│       └── README.md
└── README.md
```

## Production store requirements

Before adapting the handler for live purchases, implement a durable database transaction that validates the server-created order against the Checkout Session, enforces uniqueness for event/session/order fulfillment, and grants the entitlement atomically. Never use the included in-memory store for live entitlements.

## Contributing

Each recipe should include exact dependency versions, executable tests, an explicit trust boundary, failure/retry behavior, and known limitations. Do not include live API keys, customer data, or production webhook payloads.

Report security issues to <zqmcomputing@gmail.com> — please do not open a public issue for those.
