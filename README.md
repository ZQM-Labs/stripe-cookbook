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

**Status:** Newly initialized, public — implementation patterns are being added. Do not treat this repository as a production integration until a specific recipe has executable tests against its stated dependencies and storage model.

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

### 01 — Verified Checkout fulfillment (in progress)

A first recipe is being added for signature verification, replay-safe processing, and server-controlled entitlement fulfillment. It will explicitly separate an executable test adapter from the durable storage requirements of production.

## Contributing

Each recipe should include exact dependency versions, executable tests, an explicit trust boundary, failure/retry behavior, and known limitations. Do not include live API keys, customer data, or production webhook payloads.

Report security issues to <zqmcomputing@gmail.com> — please do not open a public issue for those.
