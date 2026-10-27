"use strict";

const { randomUUID } = require("node:crypto");

function createEntitlementOutboxWorker({
  pool,
  projectEntitlement,
  leaseSeconds = 60,
  maxAttempts = 8,
  baseRetrySeconds = 5,
  maxRetrySeconds = 900,
}) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") {
    throw new TypeError("A PostgreSQL pool implementing connect() and query() is required.");
  }
  if (typeof projectEntitlement !== "function") {
    throw new TypeError("projectEntitlement must be a trusted server-side function.");
  }
  for (const [name, value] of Object.entries({ leaseSeconds, maxAttempts, baseRetrySeconds, maxRetrySeconds })) {
    if (!Number.isInteger(value) || value < 1) throw new TypeError(name + " must be a positive integer.");
  }

  async function claimOne() {
    const client = await pool.connect();
    let inTransaction = false;
    try {
      await client.query("BEGIN");
      inTransaction = true;
      const selected = await client.query(
        `SELECT projection_key, order_id, app_user_id, product_key, desired_status,
                source_version, attempts
           FROM cookbook_entitlement_outbox
          WHERE (delivery_status = 'pending' AND available_at <= now())
             OR (delivery_status = 'in_progress' AND locked_until < now())
          ORDER BY available_at, created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
      );
      const row = selected.rows[0];
      if (!row) {
        await client.query("COMMIT");
        inTransaction = false;
        return null;
      }

      const leaseToken = randomUUID();
      const claimed = await client.query(
        `UPDATE cookbook_entitlement_outbox
            SET delivery_status = 'in_progress',
                attempts = attempts + 1,
                locked_until = now() + ($2 * interval '1 second'),
                lease_token = $3,
                last_error = NULL
          WHERE projection_key = $1
          RETURNING projection_key, order_id, app_user_id, product_key, desired_status,
                    source_version, attempts, lease_token`,
        [row.projection_key, leaseSeconds, leaseToken],
      );
      await client.query("COMMIT");
      inTransaction = false;
      return claimed.rows[0] || null;
    } catch (error) {
      if (inTransaction) {
        try { await client.query("ROLLBACK"); } catch { /* Preserve the original error. */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function deliverOne() {
    const row = await claimOne();
    if (!row) return { status: "idle" };

    // The projector must upsert by projection_key and enforce source_version ordering.
    // Never pass Stripe secrets or client-controlled entitlement fields to this adapter.
    try {
      await projectEntitlement({
        projectionKey: row.projection_key,
        orderId: row.order_id,
        appUserId: row.app_user_id,
        productKey: row.product_key,
        status: row.desired_status,
        sourceVersion: Number(row.source_version),
      });
      const result = await pool.query(
        `UPDATE cookbook_entitlement_outbox
            SET delivery_status = 'delivered',
                delivered_at = now(),
                locked_until = NULL,
                lease_token = NULL,
                last_error = NULL
          WHERE projection_key = $1
            AND delivery_status = 'in_progress'
            AND lease_token = $2`,
        [row.projection_key, row.lease_token],
      );
      // A newer worker may have reclaimed an expired lease. The projection must
      // be idempotent/version-aware; a stale worker cannot overwrite its lease state.
      if (result.rowCount === 0) return { status: "lease_lost", projectionKey: row.projection_key };
      return { status: "delivered", projectionKey: row.projection_key };
    } catch (error) {
      const attempts = Number(row.attempts);
      const deadLetter = attempts >= maxAttempts;
      const delaySeconds = Math.min(maxRetrySeconds, baseRetrySeconds * (2 ** Math.min(attempts - 1, 20)));
      // Store only a bounded error class/code, not arbitrary messages that may contain
      // URLs, tokens, or response bodies.
      const errorCode = typeof error?.code === "string" && /^[A-Z0-9_-]{1,40}$/i.test(error.code)
        ? error.code
        : (typeof error?.name === "string" && /^[A-Z0-9_-]{1,40}$/i.test(error.name) ? error.name : "ProjectionError");
      await pool.query(
        `UPDATE cookbook_entitlement_outbox
            SET delivery_status = $3,
                available_at = CASE WHEN $3 = 'pending'
                  THEN now() + ($4 * interval '1 second') ELSE available_at END,
                locked_until = NULL,
                lease_token = NULL,
                last_error = $5
          WHERE projection_key = $1
            AND delivery_status = 'in_progress'
            AND lease_token = $2`,
        [row.projection_key, row.lease_token, deadLetter ? "dead_letter" : "pending", delaySeconds, errorCode],
      );
      return {
        status: deadLetter ? "dead_letter" : "retry_scheduled",
        projectionKey: row.projection_key,
        attempts,
        retryAfterSeconds: deadLetter ? null : delaySeconds,
        errorCode,
      };
    }
  }

  return { deliverOne };
}

module.exports = { createEntitlementOutboxWorker };
