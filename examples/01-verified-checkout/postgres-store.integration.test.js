"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { Pool } = require("pg");
const { createPostgresFulfillmentStore } = require("./postgres-store");

const enabled = process.env.STRIPE_COOKBOOK_PG_TEST === "1";

function validateTarget(connectionString) {
  if (!connectionString) throw new Error("DATABASE_URL is required when PostgreSQL integration tests are enabled.");
  let url;
  try { url = new URL(connectionString); } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use postgres:// or postgresql://.");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!/(test|cookbook)/i.test(database)) {
    throw new Error("Refusing database name without 'test' or 'cookbook'; use a dedicated disposable test database.");
  }
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "postgres"]);
  if (!localHosts.has(url.hostname) && process.env.STRIPE_COOKBOOK_PG_TEST_ALLOW_REMOTE !== "1") {
    throw new Error("Refusing non-local PostgreSQL target; set STRIPE_COOKBOOK_PG_TEST_ALLOW_REMOTE=1 only for a dedicated disposable test instance.");
  }
  return url;
}

test("PostgreSQL fulfillment integration (opt-in, dedicated test database)", {
  skip: !enabled && "Set STRIPE_COOKBOOK_PG_TEST=1 with a dedicated test database to run PostgreSQL integration tests.",
}, async (t) => {
  validateTarget(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10, connectionTimeoutMillis: 5000 });
  const store = createPostgresFulfillmentStore(pool);
  const schema = await readFile(path.join(__dirname, "schema.postgres.sql"), "utf8");
  const runId = randomUUID().replaceAll("-", "");
  const createdOrderIds = [];
  const createdEventIds = [];
  const createdSessionIds = [];
  const failureFunction = `cookbook_test_fail_entitlement_${runId}`;
  const failureTrigger = `cookbook_test_fail_entitlement_trigger_${runId}`;
  let failureTriggerInstalled = false;

  async function seedOrder(overrides = {}) {
    const orderId = `it_order_${runId}_${createdOrderIds.length}`;
    const sessionId = `cs_test_${runId}_${createdOrderIds.length}`;
    createdOrderIds.push(orderId);
    createdSessionIds.push(sessionId);
    await pool.query(
      `INSERT INTO cookbook_orders
        (id, app_user_id, product_key, stripe_session_id, expected_amount_total,
         expected_currency, expected_customer_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
      [orderId, `it_user_${runId}`, "integration_product", sessionId, 2500, "usd", `cus_test_${runId}`],
    );
    return {
      orderId,
      session: {
        object: "checkout.session",
        id: sessionId,
        mode: "payment",
        payment_status: "paid",
        amount_total: 2500,
        currency: "usd",
        customer: `cus_test_${runId}`,
        metadata: { order_id: orderId },
        ...overrides,
      },
    };
  }

  function eventId() {
    const id = `evt_it_${runId}_${createdEventIds.length}`;
    createdEventIds.push(id);
    return id;
  }

  try {
    await pool.query(schema);

    await t.test("paid session grants one entitlement and commits order state", async () => {
      const { orderId, session } = await seedOrder();
      const result = await store.fulfillPaidCheckout({
        eventId: eventId(), eventType: "checkout.session.completed", session,
      });
      assert.deepEqual(result, { status: "fulfilled" });
      const order = await pool.query("SELECT status FROM cookbook_orders WHERE id = $1", [orderId]);
      const entitlement = await pool.query("SELECT order_id FROM cookbook_entitlements WHERE order_id = $1", [orderId]);
      assert.equal(order.rows[0].status, "fulfilled");
      assert.equal(entitlement.rowCount, 1);
    });

    await t.test("repeated delivery of the same event is idempotent", async () => {
      const { orderId, session } = await seedOrder();
      const id = eventId();
      const input = { eventId: id, eventType: "checkout.session.completed", session };
      assert.deepEqual(await store.fulfillPaidCheckout(input), { status: "fulfilled" });
      assert.deepEqual(await store.fulfillPaidCheckout(input), { status: "already_fulfilled" });
      const entitlement = await pool.query("SELECT order_id FROM cookbook_entitlements WHERE order_id = $1", [orderId]);
      assert.equal(entitlement.rowCount, 1);
    });

    await t.test("reusing an event ID with a different session is rejected", async () => {
      const first = await seedOrder();
      const second = await seedOrder();
      const id = eventId();
      const firstResult = await store.fulfillPaidCheckout({
        eventId: id, eventType: "checkout.session.completed", session: first.session,
      });
      assert.deepEqual(firstResult, { status: "fulfilled" });

      const replay = await store.fulfillPaidCheckout({
        eventId: id, eventType: "checkout.session.completed", session: second.session,
      });
      assert.deepEqual(replay, { status: "rejected", reason: "event_id_reuse_mismatch" });

      const firstEntitlement = await pool.query(
        "SELECT order_id FROM cookbook_entitlements WHERE order_id = $1", [first.orderId],
      );
      const secondEntitlement = await pool.query(
        "SELECT order_id FROM cookbook_entitlements WHERE order_id = $1", [second.orderId],
      );
      assert.equal(firstEntitlement.rowCount, 1, "the original event's entitlement remains intact");
      assert.equal(secondEntitlement.rowCount, 0, "a replayed event ID must not grant a second order");
    });

    await t.test("an unpaid session is rejected without granting access", async () => {
      const { orderId, session } = await seedOrder({ payment_status: "unpaid" });
      const id = eventId();
      const result = await store.fulfillPaidCheckout({
        eventId: id, eventType: "checkout.session.completed", session,
      });
      assert.deepEqual(result, { status: "rejected", reason: "session_not_paid" });
      const entitlement = await pool.query(
        "SELECT order_id FROM cookbook_entitlements WHERE order_id = $1", [orderId],
      );
      assert.equal(entitlement.rowCount, 0);
    });

    await t.test("concurrent retries of the same event create one event record and one entitlement", async () => {
      const { orderId, session } = await seedOrder();
      const input = {
        eventId: eventId(),
        eventType: "checkout.session.completed",
        session,
      };
      const results = await Promise.all([
        store.fulfillPaidCheckout(input),
        store.fulfillPaidCheckout(input),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), ["already_fulfilled", "fulfilled"].sort());
      const events = await pool.query(
        "SELECT count(*)::int AS count FROM cookbook_stripe_events WHERE event_id = $1",
        [input.eventId],
      );
      const entitlements = await pool.query(
        "SELECT count(*)::int AS count FROM cookbook_entitlements WHERE order_id = $1",
        [orderId],
      );
      assert.equal(events.rows[0].count, 1);
      assert.equal(entitlements.rows[0].count, 1);
    });

    await t.test("concurrent distinct events for one order grant only one entitlement", async () => {
      const { orderId, session } = await seedOrder();
      const results = await Promise.all([
        store.fulfillPaidCheckout({ eventId: eventId(), eventType: "checkout.session.completed", session }),
        store.fulfillPaidCheckout({ eventId: eventId(), eventType: "checkout.session.async_payment_succeeded", session }),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), ["already_fulfilled", "fulfilled"].sort());
      const entitlement = await pool.query("SELECT order_id FROM cookbook_entitlements WHERE order_id = $1", [orderId]);
      assert.equal(entitlement.rowCount, 1);
    });

    await t.test("amount, currency, and customer mismatches do not grant access", async () => {
      for (const [label, override, expectedReason] of [
        ["amount", { amount_total: 1 }, "amount_mismatch"],
        ["currency", { currency: "eur" }, "currency_mismatch"],
        ["customer", { customer: "cus_wrong" }, "customer_mismatch"],
      ]) {
        const { orderId, session } = await seedOrder(override);
        const id = eventId();
        const result = await store.fulfillPaidCheckout({
          eventId: id, eventType: "checkout.session.completed", session,
        });
        assert.deepEqual(result, { status: "rejected", reason: expectedReason }, label);
        const entitlement = await pool.query("SELECT order_id FROM cookbook_entitlements WHERE order_id = $1", [orderId]);
        assert.equal(entitlement.rowCount, 0, label);
        const event = await pool.query("SELECT outcome, reason FROM cookbook_stripe_events WHERE event_id = $1", [id]);
        assert.equal(event.rows[0].outcome, "rejected", label);
        assert.equal(event.rows[0].reason, expectedReason, label);
      }
    });

    await t.test("an entitlement insert failure rolls back event and order mutations", async () => {
      const { orderId, session } = await seedOrder();
      const id = eventId();

      await pool.query(`
        CREATE FUNCTION ${failureFunction}() RETURNS trigger
        LANGUAGE plpgsql AS $test$
        BEGIN
          RAISE EXCEPTION 'synthetic entitlement insert failure';
        END;
        $test$
      `);
      await pool.query(`
        CREATE TRIGGER ${failureTrigger}
        BEFORE INSERT ON cookbook_entitlements
        FOR EACH ROW EXECUTE FUNCTION ${failureFunction}()
      `);
      failureTriggerInstalled = true;

      await assert.rejects(
        store.fulfillPaidCheckout({
          eventId: id,
          eventType: "checkout.session.completed",
          session,
        }),
        /synthetic entitlement insert failure/,
      );

      const order = await pool.query("SELECT status FROM cookbook_orders WHERE id = $1", [orderId]);
      const entitlement = await pool.query("SELECT order_id FROM cookbook_entitlements WHERE order_id = $1", [orderId]);
      const event = await pool.query("SELECT event_id FROM cookbook_stripe_events WHERE event_id = $1", [id]);
      assert.equal(order.rows[0].status, "pending", "order update must roll back");
      assert.equal(entitlement.rowCount, 0, "failed entitlement insert must leave no entitlement");
      assert.equal(event.rowCount, 0, "event claim must roll back with fulfillment");
    });

  } finally {
    if (failureTriggerInstalled) {
      await pool.query(`DROP TRIGGER IF EXISTS ${failureTrigger} ON cookbook_entitlements`);
    }
    await pool.query(`DROP FUNCTION IF EXISTS ${failureFunction}()`);
    // Delete only rows created by this test run; never truncate shared tables.
    if (createdOrderIds.length) {
      await pool.query("DELETE FROM cookbook_entitlements WHERE order_id = ANY($1::text[])", [createdOrderIds]);
      await pool.query("DELETE FROM cookbook_orders WHERE id = ANY($1::text[])", [createdOrderIds]);
    }
    if (createdEventIds.length) {
      await pool.query("DELETE FROM cookbook_stripe_events WHERE event_id = ANY($1::text[])", [createdEventIds]);
    }
    await pool.end();
  }
});
