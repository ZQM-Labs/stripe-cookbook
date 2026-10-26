const express = require("express");

const FULFILLMENT_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
]);

function createApp({ stripe, endpointSecret, store, onRejected = () => {} }) {
  if (!stripe || typeof stripe.webhooks?.constructEvent !== "function") {
    throw new TypeError("A Stripe SDK client is required.");
  }
  if (!endpointSecret) throw new TypeError("A webhook endpoint secret is required.");
  if (!store || typeof store.fulfillPaidCheckout !== "function") {
    throw new TypeError("A fulfillment store implementing fulfillPaidCheckout is required.");
  }

  const app = express();

  // Register this raw-body route before any JSON body parser.
  app.post("/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
    const signature = req.headers["stripe-signature"];
    if (!Buffer.isBuffer(req.body) || typeof signature !== "string") {
      return res.status(400).json({ error: "invalid_webhook_request" });
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, signature, endpointSecret);
    } catch {
      return res.status(400).json({ error: "invalid_webhook_signature" });
    }

    if (!FULFILLMENT_EVENTS.has(event.type)) {
      return res.status(200).json({ received: true, ignored: "unsupported_event" });
    }

    const session = event.data?.object;
    // checkout.session.completed can precede settlement for delayed payment methods.
    // Wait for checkout.session.async_payment_succeeded before granting access.
    if (event.type === "checkout.session.completed" && session?.payment_status !== "paid") {
      return res.status(200).json({ received: true, ignored: "payment_not_settled" });
    }

    if (
      session?.object !== "checkout.session" ||
      session?.mode !== "payment" ||
      session?.payment_status !== "paid" ||
      typeof session?.id !== "string" ||
      typeof session?.metadata?.order_id !== "string" ||
      !session.metadata.order_id
    ) {
      onRejected({ eventId: event.id, eventType: event.type, reason: "invalid_paid_session_shape" });
      return res.status(400).json({ error: "invalid_paid_session" });
    }

    try {
      // This operation MUST atomically validate the stored order and claim event/session
      // idempotency, then grant the entitlement. See README for the required contract.
      const result = await store.fulfillPaidCheckout({
        eventId: event.id,
        eventType: event.type,
        session,
      });
      if (!result || !["fulfilled", "already_fulfilled", "rejected"].includes(result.status)) {
        throw new Error("Fulfillment store returned an invalid result.");
      }
      if (result.status === "rejected") {
        onRejected({ eventId: event.id, eventType: event.type, reason: result.reason || "order_rejected" });
      }
      return res.status(200).json({ received: true, fulfillment: result.status });
    } catch {
      // A 5xx response asks Stripe to retry. Do not acknowledge a transient storage failure.
      return res.status(500).json({ error: "fulfillment_temporarily_unavailable" });
    }
  });

  return app;
}

module.exports = { createApp };
