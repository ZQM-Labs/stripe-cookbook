"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const { createPostgresFulfillmentStore } = require("./postgres-store");

const enabled = process.env.STRIPE_COOKBOOK_PG_INTEGRATION === "1";
const connectionString = process.env.DATABASE_URL || "";
let pool;
let schemaApplied;
let sequence = 0;

function assertSafeTarget() {
  if (!enabled) return;
  let url;
  try { url = new URL(connectionString); } catch {
    throw new Error("PostgreSQL integration tests require a valid DATABASE_URL.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("Refusing integration tests: DATABASE_URL must use PostgreSQL.");
  }
  if (url.pathname !== "/stripe_cookbook_test") {
    throw new Error("Refusing integration tests: database name must be exactly stripe_cookbook_test.");
  }
  const host = url.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error("Refusing non-loopback PostgreSQL target; use a local disposable test database.");
  }
}

async function setup() {
  assertSafeTarget();
  if (!enabled) return;
  pool = new Pool({ connectionString, max: 8, connectionTimeoutMillis: 5000 });
  schemaApplied = fs.promises.readFile(path.join(__dirname, "schema.postgres.sql"), "utf8")
    .then((sql) => pool.query(sql));
  await schemaApplied;
}

function uniqueId(prefix) {
  sequence += 1;
  return `${prefix}_${process.pid}_${Date.now()}_${sequence}`;
}

async function createOrder(overrides = {}) {
  const id = uniqueId("order");
  const sessionId = uniqueId("cs_test");
  const values = {
    id,
    app_user_id: "integration_player",
    product_key: "integration_pack",
    stripe_session_id: sessionId,
    expected_amount_total: 2500,
    expected_currency: "usd",
    expected_customer_id: "cus_integration",
    status: "pending",
    ...overrides,
  };
  await pool.query(
    `INSERT INTO cookbook_orders
      (id, app_user_id, product_key, stripe_session_id, expected_amount_total,
       expected_currency, expected_customer_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [values.id, values.app_user_id, values.product_key, values.stripe_session_id,
     values.expected_amount_total, values.expected_currency, values.expected_customer_id, values.status],
  );
  return values;
}

function sessionFor(order, overrides = {}) {
  return {
    object: "checkout.session",
    id: order.stripe_session_id,
    mode: "payment",
    payment_status: "paid",
    amount_total: 2500,
    currency: "usd",
    customer: "cus_integration",
    metadata: { order_id: order.id },
    ...overrides,
  };
}

async function cleanup(order) {
  if (!pool || !order) return;
  await pool.query("DELETE FROM cookbook_stripe_events WHERE session_id = $1", [order.stripe_session_id]);
  await pool.query("DELETE FROM cookbook_entitlements WHERE order_id = $1", [order.id]);
  await pool.query("DELETE FROM cookbook_orders WHERE id = $1", [order.id]);
}

test("PostgreSQL integration suite is explicitly opt-in", async (t) => {
  if (!enabled) {
    t.skip("Set STRIPE_COOKBOOK_PG_INTEGRATION=1 and a local disposable DATABASE_URL to run PostgreSQL integration tests.");
    return;
  }
  await setup();
  t.after(async () => { await pool?.end(); });
});

test("real PostgreSQL persists fulfillment and makes concurrent duplicate events idempotent", { skip: !enabled }, async (t) => {
  await setup();
  t.after(async () => { await pool?.end(); });
  const order = await createOrder();
  t.after(() => cleanup(order));
  const store = createPostgresFulfillmentStore(pool);
  const session = sessionFor(order);

  const results = await Promise.all([
    store.fulfillPaidCheckout({ eventId: uniqueId("evt"), eventType: "checkout.session.completed", session }),
    store.fulfillPaidCheckout({ eventId: uniqueId("evt"), eventType: "checkout.session.completed", session }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["already_fulfilled", "fulfilled"]);
  const state = await pool.query(
    `SELECT o.status, count(DISTINCT e.id)::int AS entitlement_count
     FROM cookbook_orders o LEFT JOIN cookbook_entitlements e ON e.order_id = o.id
     WHERE o.id = $1 GROUP BY o.status`,
    [order.id],
  );
  assert.equal(state.rows[0].status, "fulfilled");
  assert.equal(state.rows[0].entitlement_count, 1);
});

test("same Stripe event delivered concurrently creates only one event record and entitlement", { skip: !enabled }, async (t) => {
  await setup();
  t.after(async () => { await pool?.end(); });
  const order = await createOrder();
  t.after(() => cleanup(order));
  const store = createPostgresFulfillmentStore(pool);
  const input = { eventId: uniqueId("evt"), eventType: "checkout.session.completed", session: sessionFor(order) };

  const results = await Promise.all([
    store.fulfillPaidCheckout(input),
    store.fulfillPaidCheckout(input),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "already_fulfilled").length, 1);
  const counts = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM cookbook_stripe_events WHERE event_id = $1) AS events,
       (SELECT count(*)::int FROM cookbook_entitlements WHERE order_id = $2) AS entitlements`,
    [input.eventId, order.id],
  );
  assert.equal(counts.rows[0].events, 1);
  assert.equal(counts.rows[0].entitlements, 1);
});

test("amount and currency mismatches are durably rejected without entitlement", { skip: !enabled }, async (t) => {
  await setup();
  t.after(async () => { await pool?.end(); });
  const amountOrder = await createOrder();
  const currencyOrder = await createOrder({ expected_currency: "eur" });
  t.after(async () => { await cleanup(amountOrder); await cleanup(currencyOrder); });
  const store = createPostgresFulfillmentStore(pool);

  const amountResult = await store.fulfillPaidCheckout({
    eventId: uniqueId("evt"), eventType: "checkout.session.completed",
    session: sessionFor(amountOrder, { amount_total: 1 }),
  });
  const currencyResult = await store.fulfillPaidCheckout({
    eventId: uniqueId("evt"), eventType: "checkout.session.completed",
    session: sessionFor(currencyOrder),
  });
  assert.deepEqual(amountResult, { status: "rejected", reason: "amount_mismatch" });
  assert.deepEqual(currencyResult, { status: "rejected", reason: "currency_mismatch" });
  const entitlements = await pool.query(
    "SELECT count(*)::int AS count FROM cookbook_entitlements WHERE order_id = ANY($1::text[])",
    [[amountOrder.id, currencyOrder.id]],
  );
  assert.equal(entitlements.rows[0].count, 0);
});
