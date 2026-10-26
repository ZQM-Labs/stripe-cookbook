const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const Stripe = require("stripe");
const { createApp } = require("./app");

const stripe = new Stripe("sk_test_cookbook_fixture_only");
const secret = "whsec_test_cookbook_fixture_only";
const baseSession = {
  object: "checkout.session",
  id: "cs_test_synthetic_123",
  mode: "payment",
  payment_status: "paid",
  amount_total: 1200,
  currency: "usd",
  metadata: { order_id: "order_synthetic_123" },
};

function makeEvent(type = "checkout.session.completed", overrides = {}) {
  return {
    id: "evt_synthetic_123",
    object: "event",
    api_version: "2025-09-30.clover",
    created: 1_760_000_000,
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type,
    data: { object: { ...baseSession, ...overrides } },
  };
}

async function withServer(store, callback, onRejected = () => {}) {
  const server = createServer(createApp({ stripe, endpointSecret: secret, expectedLiveMode: false, store, onRejected }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await callback(`http://127.0.0.1:${address.port}/webhooks/stripe`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function signedHeader(body, endpointSecret = secret) {
  return stripe.webhooks.generateTestHeaderString({ payload: body, secret: endpointSecret });
}

async function send(url, event, signatureOverride) {
  const body = JSON.stringify(event);
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": signatureOverride || signedHeader(body),
    },
    body,
  });
}

function memoryStore() {
  const processed = new Set();
  const fulfilledOrders = new Set();
  const calls = [];
  return {
    calls,
    async fulfillPaidCheckout({ eventId, session }) {
      calls.push({ eventId, sessionId: session.id });
      if (processed.has(eventId) || fulfilledOrders.has(session.metadata.order_id)) {
        return { status: "already_fulfilled" };
      }
      processed.add(eventId);
      fulfilledOrders.add(session.metadata.order_id);
      return { status: "fulfilled" };
    },
  };
}

test("valid signed paid session reaches the fulfillment boundary", async () => {
  const store = memoryStore();
  await withServer(store, async (url) => {
    const response = await send(url, makeEvent());
    assert.equal(response.status, 200);
    assert.equal((await response.json()).fulfillment, "fulfilled");
    assert.equal(store.calls.length, 1);
  });
});

test("duplicate event does not grant a second entitlement in the test store", async () => {
  const store = memoryStore();
  await withServer(store, async (url) => {
    const event = makeEvent();
    const first = await send(url, event);
    const second = await send(url, event);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal((await second.json()).fulfillment, "already_fulfilled");
    assert.equal(store.calls.length, 2);
  });
});

test("invalid webhook signature is rejected before fulfillment", async () => {
  const store = memoryStore();
  await withServer(store, async (url) => {
    const response = await send(url, makeEvent(), "t=1,v1=invalid");
    assert.equal(response.status, 400);
    assert.equal(store.calls.length, 0);
  });
});

test("unsettled completed session does not grant access", async () => {
  const store = memoryStore();
  await withServer(store, async (url) => {
    const response = await send(url, makeEvent("checkout.session.completed", { payment_status: "unpaid" }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ignored, "payment_not_settled");
    assert.equal(store.calls.length, 0);
  });
});

test("delayed-payment success event can reach fulfillment", async () => {
  const store = memoryStore();
  await withServer(store, async (url) => {
    const response = await send(url, makeEvent("checkout.session.async_payment_succeeded"));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).fulfillment, "fulfilled");
    assert.equal(store.calls.length, 1);
  });
});

test("transient storage failure returns 500 so Stripe can retry", async () => {
  const store = { async fulfillPaidCheckout() { throw new Error("synthetic storage outage"); } };
  await withServer(store, async (url) => {
    const response = await send(url, makeEvent());
    assert.equal(response.status, 500);
  });
});

test("missing order metadata fails closed", async () => {
  const store = memoryStore();
  const rejected = [];
  await withServer(store, async (url) => {
    const response = await send(url, makeEvent("checkout.session.completed", { metadata: {} }));
    assert.equal(response.status, 400);
    assert.equal(store.calls.length, 0);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason, "invalid_paid_session_shape");
  }, (entry) => rejected.push(entry));
});

test("live-mode event is rejected by a test-mode endpoint configuration", async () => {
  const store = memoryStore();
  await withServer(store, async (url) => {
    const response = await send(url, { ...makeEvent(), livemode: true });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "webhook_mode_mismatch");
    assert.equal(store.calls.length, 0);
  });
});

test("unsupported signed events are acknowledged without fulfillment", async () => {
  const store = memoryStore();
  await withServer(store, async (url) => {
    const response = await send(url, makeEvent("customer.updated"));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ignored, "unsupported_event");
    assert.equal(store.calls.length, 0);
  });
});
