"use strict";

const REJECTED = (reason) => ({ status: "rejected", reason });

function createPostgresFulfillmentStore(pool) {
  if (!pool || typeof pool.connect !== "function") {
    throw new TypeError("A PostgreSQL pool implementing connect() is required.");
  }

  return {
    async fulfillPaidCheckout({ eventId, eventType, session }) {
      if (typeof eventId !== "string" || !eventId || typeof eventType !== "string" ||
          !session || typeof session.id !== "string" || typeof session.metadata?.order_id !== "string") {
        throw new TypeError("A verified event ID, event type, and Checkout Session with order_id are required.");
      }

      const client = await pool.connect();
      let inTransaction = false;
      try {
        await client.query("BEGIN");
        inTransaction = true;

        // Claim the event atomically. A concurrent duplicate waits for the first
        // transaction, then observes its committed outcome through this unique key.
        const claim = await client.query(
          `INSERT INTO cookbook_stripe_events (event_id, session_id, event_type, outcome)
           VALUES ($1, $2, $3, 'processing')
           ON CONFLICT (event_id) DO NOTHING
           RETURNING event_id`,
          [eventId, session.id, eventType],
        );

        if (claim.rowCount === 0) {
          const existing = await client.query(
            "SELECT session_id, event_type, outcome, reason FROM cookbook_stripe_events WHERE event_id = $1",
            [eventId],
          );
          await client.query("COMMIT");
          inTransaction = false;
          const prior = existing.rows[0];
          if (!prior) {
            throw new Error("Duplicate event claim conflicted but the stored event could not be read.");
          }
          // An event ID is an idempotency key, not permission to substitute a
          // different session or event type on a later delivery.
          if (prior.session_id !== session.id || prior.event_type !== eventType) {
            return REJECTED("event_id_reuse_mismatch");
          }
          if (prior.outcome === "rejected") {
            return REJECTED(prior.reason || "previously_rejected");
          }
          return { status: "already_fulfilled" };
        }

        const orderResult = await client.query(
          `SELECT id, app_user_id, product_key, stripe_session_id,
                  expected_amount_total, expected_currency, expected_customer_id, status
           FROM cookbook_orders
           WHERE id = $1
           FOR UPDATE`,
          [session.metadata.order_id],
        );
        const order = orderResult.rows[0];
        let reason = null;
        if (!order) reason = "order_not_found";
        else if (order.stripe_session_id !== session.id) reason = "session_mismatch";
        else if (order.status === "fulfilled") {
          await client.query(
            "UPDATE cookbook_stripe_events SET outcome = 'already_fulfilled', completed_at = now() WHERE event_id = $1",
            [eventId],
          );
          await client.query("COMMIT");
          inTransaction = false;
          return { status: "already_fulfilled" };
        } else if (order.status !== "pending") reason = "order_not_pending";
        else if (Number(order.expected_amount_total) !== session.amount_total) reason = "amount_mismatch";
        else if (order.expected_currency !== session.currency) reason = "currency_mismatch";
        else if (order.expected_customer_id && order.expected_customer_id !== session.customer) reason = "customer_mismatch";
        else if (session.payment_status !== "paid" || session.mode !== "payment") reason = "session_not_paid";
        else if (session.object !== "checkout.session") reason = "invalid_session_object";

        if (reason) {
          await client.query(
            "UPDATE cookbook_stripe_events SET outcome = 'rejected', reason = $2, completed_at = now() WHERE event_id = $1",
            [eventId, reason],
          );
          await client.query("COMMIT");
          inTransaction = false;
          return REJECTED(reason);
        }

        await client.query(
          `INSERT INTO cookbook_entitlements (order_id, app_user_id, product_key)
           VALUES ($1, $2, $3)
           ON CONFLICT (order_id) DO NOTHING`,
          [order.id, order.app_user_id, order.product_key],
        );
        // Persist the downstream projection request in this same transaction.
        // Stable key + (order_id, source_version) uniqueness make retries idempotent.
        await client.query(
          `INSERT INTO cookbook_entitlement_outbox
             (projection_key, order_id, app_user_id, product_key, desired_status, source_version)
           VALUES ($1, $2, $3, $4, 'active', 1)
           ON CONFLICT (projection_key) DO NOTHING`,
          [`order:${order.id}:entitlement:v1`, order.id, order.app_user_id, order.product_key],
        );
        await client.query(
          "UPDATE cookbook_orders SET status = 'fulfilled', fulfilled_at = now() WHERE id = $1",
          [order.id],
        );
        await client.query(
          "UPDATE cookbook_stripe_events SET outcome = 'fulfilled', completed_at = now() WHERE event_id = $1",
          [eventId],
        );
        await client.query("COMMIT");
        inTransaction = false;
        return { status: "fulfilled" };
      } catch (error) {
        if (inTransaction) {
          try { await client.query("ROLLBACK"); } catch { /* Preserve the original database error. */ }
        }
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

module.exports = { createPostgresFulfillmentStore };
