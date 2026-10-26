const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createPostgresFulfillmentStore } = require("./postgres-store");

const session = {
  object: "checkout.session",
  id: "cs_test_order_1",
  mode: "payment",
  payment_status: "paid",
  amount_total: 2500,
  currency: "usd",
  customer: "cus_test_1",
  metadata: { order_id: "order_1" },
};

const order = {
  id: "order_1",
  app_user_id: "player_1",
  product_key: "lantern_pack",
  stripe_session_id: "cs_test_order_1",
  expected_amount_total: "2500",
  expected_currency: "usd",
  expected_customer_id: "cus_test_1",
  status: "pending",
};

function fakePool({ existingEvent = null, foundOrder = order, failAt = null } = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });
      if (failAt && normalized.startsWith(failAt)) throw new Error("synthetic database outage");
      if (normalized.startsWith("INSERT INTO cookbook_stripe_events")) {
        return existingEvent
          ? { rowCount: 0, rows: [] }
          : { rowCount: 1, rows: [{ event_id: params[0] }] };
      }
      if (normalized.startsWith("SELECT outcome, reason")) {
        return { rowCount: existingEvent ? 1 : 0, rows: existingEvent ? [existingEvent] : [] };
      }
      if (normalized.startsWith("SELECT id, app_user_id")) {
        return { rowCount: foundOrder ? 1 : 0, rows: foundOrder ? [foundOrder] : [] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() { calls.push({ sql: "RELEASE", params: [] }); },
  };
  return { calls, pool: { async connect() { return client; } } };
}

test("fulfills a matching paid session in one committed transaction", async () => {
  const { pool, calls } = fakePool();
  const store = createPostgresFulfillmentStore(pool);
  const result = await store.fulfillPaidCheckout({
    eventId: "evt_1",
    eventType: "checkout.session.completed",
    session,
  });
  assert.deepEqual(result, { status: "fulfilled" });
  assert.ok(calls.some((c) => c.sql === "BEGIN"));
  assert.ok(calls.some((c) => c.sql.includes("FOR UPDATE")));
  assert.ok(calls.some((c) => c.sql.startsWith("INSERT INTO cookbook_entitlements")));
  assert.ok(calls.some((c) => c.sql.startsWith("UPDATE cookbook_orders SET status = 'fulfilled'")));
  assert.ok(calls.some((c) => c.sql === "COMMIT"));
  assert.ok(!calls.some((c) => c.sql === "ROLLBACK"));
  assert.equal(calls.at(-1).sql, "RELEASE");
});

test("amount mismatch is recorded as rejected without entitlement creation", async () => {
  const { pool, calls } = fakePool();
  const store = createPostgresFulfillmentStore(pool);
  const result = await store.fulfillPaidCheckout({
    eventId: "evt_bad_amount",
    eventType: "checkout.session.completed",
    session: { ...session, amount_total: 1 },
  });
  assert.deepEqual(result, { status: "rejected", reason: "amount_mismatch" });
  assert.ok(calls.some((c) => c.sql.includes("outcome = 'rejected'")));
  assert.ok(!calls.some((c) => c.sql.startsWith("INSERT INTO cookbook_entitlements")));
  assert.ok(calls.some((c) => c.sql === "COMMIT"));
});

test("duplicate event returns the previously recorded outcome without granting again", async () => {
  const { pool, calls } = fakePool({ existingEvent: { outcome: "fulfilled", reason: null } });
  const store = createPostgresFulfillmentStore(pool);
  const result = await store.fulfillPaidCheckout({
    eventId: "evt_1",
    eventType: "checkout.session.completed",
    session,
  });
  assert.deepEqual(result, { status: "already_fulfilled" });
  assert.ok(!calls.some((c) => c.sql.startsWith("SELECT id, app_user_id")));
  assert.ok(!calls.some((c) => c.sql.startsWith("INSERT INTO cookbook_entitlements")));
  assert.ok(calls.some((c) => c.sql === "COMMIT"));
});

test("database failures roll back and propagate for webhook retry", async () => {
  const { pool, calls } = fakePool({ failAt: "SELECT id, app_user_id" });
  const store = createPostgresFulfillmentStore(pool);
  await assert.rejects(
    store.fulfillPaidCheckout({
      eventId: "evt_db_error",
      eventType: "checkout.session.completed",
      session,
    }),
    /synthetic database outage/,
  );
  assert.ok(calls.some((c) => c.sql === "ROLLBACK"));
  assert.equal(calls.at(-1).sql, "RELEASE");
});

test("constructor requires a PostgreSQL pool", () => {
  assert.throws(() => createPostgresFulfillmentStore({}), /connect\(\)/);
});


test("failures during entitlement, order update, event update, and commit all roll back", async () => {
  const failurePoints = [
    "INSERT INTO cookbook_entitlements",
    "UPDATE cookbook_orders SET status = 'fulfilled'",
    "UPDATE cookbook_stripe_events SET outcome = 'fulfilled'",
    "COMMIT",
  ];

  for (const failAt of failurePoints) {
    const { pool, calls } = fakePool({ failAt });
    const store = createPostgresFulfillmentStore(pool);
    await assert.rejects(
      store.fulfillPaidCheckout({
        eventId: `evt_failure_${failurePoints.indexOf(failAt)}`,
        eventType: "checkout.session.completed",
        session,
      }),
      /synthetic database outage/,
      `failure at ${failAt} must propagate`,
    );

    const rollbackIndex = calls.findIndex((call) => call.sql === "ROLLBACK");
    const failureIndex = calls.findIndex((call) => call.sql.startsWith(failAt));
    assert.notEqual(failureIndex, -1, `expected failure point ${failAt} was reached`);
    assert.ok(rollbackIndex > failureIndex, `failure at ${failAt} must trigger rollback`);
    assert.equal(calls.at(-1).sql, "RELEASE", "connection must be released after rollback");
    // The fake logs the failed SQL attempt too; the invariant is that the store
    // issues ROLLBACK and propagates the failure instead of returning success.
  }
});
