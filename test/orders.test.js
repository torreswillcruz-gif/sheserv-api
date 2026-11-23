const assert = require("node:assert/strict");
const { after, before, beforeEach, describe, test } = require("node:test");
const { resetDatabase, queriesMatching, startServer } = require("./helpers/testApp");

const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const PROVIDER_ID = "22222222-2222-4222-8222-222222222222";
const ORDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SERVICE_ID = "99999999-9999-4999-8999-999999999999";

const customer = { userId: CUSTOMER_ID, roles: ["cliente"] };
const provider = { userId: PROVIDER_ID, roles: ["prestadora"] };

let server;
let order;

before(async () => { server = await startServer(); });
after(async () => { await server.close(); });

beforeEach(() => {
  order = {
    id: ORDER_ID,
    friendly_id: "ABCD2345",
    customer_id: CUSTOMER_ID,
    provider_id: PROVIDER_ID,
    service_id: SERVICE_ID,
    status: "requested",
    service_location: "at_customer",
    total_amount: "180.00",
    checkin_code: "0427",
  };
  resetDatabase([
    { pattern: /^SELECT \* FROM orders WHERE id=\$1 FOR UPDATE/, rows: () => [order] },
    { pattern: /^SELECT orders\.id,/, rows: () => [{ id: ORDER_ID }] },
  ]);
});

const changeStatus = (user, status) =>
  server.call("PATCH", `/api/v1/orders/${ORDER_ID}/status`, { ...user, body: { status } });

describe("PATCH /orders/:id/status", () => {
  test("provider accepts a requested order", async () => {
    const response = await changeStatus(provider, "accepted");
    assert.equal(response.status, 200);
    assert.deepEqual(queriesMatching(/^UPDATE orders SET status/)[0].params, ["accepted", ORDER_ID]);
  });

  test("customer cannot accept an order", async () => {
    const response = await changeStatus(customer, "accepted");
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "invalid_transition");
  });

  test("only the customer marks on_the_way when the service is at the provider", async () => {
    order.status = "accepted";
    order.service_location = "at_provider";
    assert.equal((await changeStatus(provider, "on_the_way")).status, 409);
    assert.equal((await changeStatus(customer, "on_the_way")).status, 200);
  });

  test("cancelling releases a held payment", async () => {
    await changeStatus(customer, "cancelled");
    assert.equal(queriesMatching(/^UPDATE payments SET status='released'/).length, 1);
  });

  test("completion captures payment and records payout and receivable for the full amount", async () => {
    order.status = "in_progress";
    const response = await changeStatus(provider, "completed");
    assert.equal(response.status, 200);
    assert.equal(queriesMatching(/^UPDATE payments SET status='captured'/).length, 1);
    assert.equal(queriesMatching(/^INSERT INTO payouts/)[0].params[2], 180);
    assert.equal(queriesMatching(/^INSERT INTO financial_entries/)[0].params[1], 180);
  });

  test("a non-participant gets 404", async () => {
    const response = await changeStatus({ userId: "33333333-3333-4333-8333-333333333333", roles: ["cliente"] }, "cancelled");
    assert.equal(response.status, 404);
  });
});

describe("POST /orders/:id/check-ins", () => {
  const checkIn = (type, code) =>
    server.call("POST", `/api/v1/orders/${ORDER_ID}/check-ins`, { ...provider, body: { type, code } });

  test("entry with the right code starts the service", async () => {
    order.status = "on_the_way";
    const response = await checkIn("entry", "0427");
    assert.equal(response.status, 201);
    assert.deepEqual(queriesMatching(/^UPDATE orders SET status/)[0].params, ["in_progress", ORDER_ID]);
  });

  test("a wrong code is refused", async () => {
    order.status = "on_the_way";
    const response = await checkIn("entry", "9999");
    assert.equal(response.status, 422);
    assert.equal(queriesMatching(/^UPDATE orders/).length, 0);
  });
});

describe("POST /orders", () => {
  test("charges the service base price with no platform commission", async () => {
    resetDatabase([
      { pattern: /^SELECT service\.\*, provider_profile\.activation_status/, rows: [{
        id: SERVICE_ID, provider_id: PROVIDER_ID, base_price: "120.00", duration_minutes: 60,
        service_location: "at_provider", activation_status: "active",
      }] },
      { pattern: /^INSERT INTO orders/, rows: [{ id: ORDER_ID }] },
      { pattern: /^SELECT orders\.id,/, rows: [{ id: ORDER_ID }] },
    ]);
    const response = await server.call("POST", "/api/v1/orders", {
      ...customer,
      body: {
        serviceId: SERVICE_ID,
        scheduledAt: new Date(Date.now() + 86400000).toISOString(),
        paymentMethod: { type: "pix" },
      },
    });
    assert.equal(response.status, 201);
    const insert = queriesMatching(/^INSERT INTO orders/)[0];
    assert.equal(insert.params[7], 120); // total_amount
    assert.equal(insert.params[8], 0); // commission
  });
});
