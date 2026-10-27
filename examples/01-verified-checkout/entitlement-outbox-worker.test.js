"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createEntitlementOutboxWorker } = require("./entitlement-outbox-worker");

function fakePool({ row = {
  projection_key: "order:o1:entitlement:v1",
  order_id: "o1",
  app_user_id: "player-internal-1",
  product_key: "lantern_pack",
  desired_status: "active",
  source_version: "1",
  attempts: 0,
}, updateRowCount = 1 } = {}) {
  const clientCalls = [];
  const poolCalls = [];
  const client = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      clientCalls.push({ sql: normalized, params });
      if (normalized.startsWith("SELECT projection_key")) {
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (normalized.startsWith("UPDATE cookbook_entitlement_outbox")) {
        return { rows: row ? [{ ...row, attempts: Number(row.attempts) + 1, lease_token: params[2] }] : [], rowCount: row ? 1 : 0 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() { clientCalls.push({ sql: "RELEASE", params: [] }); },
  };
  return {
    clientCalls,
    poolCalls,
    pool: {
      async connect() { return client; },
      async query(sql, params = []) {
        poolCalls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
        return { rowCount: updateRowCount, rows: [] };
      },
    },
  };
}

test("delivers one claimed item and marks it delivered with the matching lease", async () => {
  const fake = fakePool();
  const projected = [];
  const worker = createEntitlementOutboxWorker({
    pool: fake.pool,
    projectEntitlement: async (item) => projected.push(item),
  });
  const result = await worker.deliverOne();
  assert.equal(result.status, "delivered");
  assert.equal(projected.length, 1);
  assert.deepEqual(projected[0], {
    projectionKey: "order:o1:entitlement:v1",
    orderId: "o1",
    appUserId: "player-internal-1",
    productKey: "lantern_pack",
    status: "active",
    sourceVersion: 1,
  });
  assert.ok(fake.clientCalls.some((c) => c.sql === "BEGIN"));
  assert.ok(fake.clientCalls.some((c) => c.sql === "COMMIT"));
  assert.ok(fake.poolCalls[0].sql.includes("SET delivery_status = 'delivered'"));
  assert.match(fake.poolCalls[0].params[1], /^[0-9a-f-]{36}$/i);
});

test("returns idle when no eligible outbox item exists", async () => {
  const fake = fakePool({ row: null });
  let calls = 0;
  const worker = createEntitlementOutboxWorker({
    pool: fake.pool,
    projectEntitlement: async () => { calls += 1; },
  });
  assert.deepEqual(await worker.deliverOne(), { status: "idle" });
  assert.equal(calls, 0);
  assert.ok(fake.clientCalls.some((c) => c.sql === "COMMIT"));
});

test("projection failure schedules a bounded retry without storing arbitrary error text", async () => {
  const fake = fakePool();
  const worker = createEntitlementOutboxWorker({
    pool: fake.pool,
    projectEntitlement: async () => {
      const error = new Error("token=secret should not be persisted");
      error.code = "ETIMEDOUT";
      throw error;
    },
    baseRetrySeconds: 7,
    maxRetrySeconds: 30,
  });
  const result = await worker.deliverOne();
  assert.equal(result.status, "retry_scheduled");
  assert.equal(result.attempts, 1);
  assert.equal(result.retryAfterSeconds, 7);
  assert.equal(result.errorCode, "ETIMEDOUT");
  const update = fake.poolCalls[0];
  assert.ok(update.sql.includes("SET delivery_status = $3"));
  assert.equal(update.params[2], "pending");
  assert.equal(update.params[3], 7);
  assert.equal(update.params[4], "ETIMEDOUT");
  assert.ok(!update.params.includes("token=secret should not be persisted"));
});

test("dead-letters after the configured attempt limit", async () => {
  const fake = fakePool({ row: {
    projection_key: "order:o1:entitlement:v1",
    order_id: "o1",
    app_user_id: "player-internal-1",
    product_key: "lantern_pack",
    desired_status: "active",
    source_version: "1",
    attempts: 7,
  } });
  const worker = createEntitlementOutboxWorker({
    pool: fake.pool,
    projectEntitlement: async () => { throw new Error("permanent failure"); },
    maxAttempts: 8,
  });
  const result = await worker.deliverOne();
  assert.equal(result.status, "dead_letter");
  assert.equal(result.attempts, 8);
  assert.equal(result.retryAfterSeconds, null);
  assert.equal(fake.poolCalls[0].params[2], "dead_letter");
});

test("rejects missing pool/projector and invalid worker limits", () => {
  assert.throws(() => createEntitlementOutboxWorker({ pool: {}, projectEntitlement: async () => {} }), /PostgreSQL pool/);
  const fake = fakePool();
  assert.throws(() => createEntitlementOutboxWorker({ pool: fake.pool }), /projectEntitlement/);
  assert.throws(() => createEntitlementOutboxWorker({
    pool: fake.pool, projectEntitlement: async () => {}, leaseSeconds: 0,
  }), /leaseSeconds/);
});
