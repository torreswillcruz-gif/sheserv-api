const assert = require("node:assert/strict");
const { after, before, beforeEach, describe, test } = require("node:test");
const { resetDatabase, queriesMatching, startServer } = require("./helpers/testApp");
const { formatWhen } = require("../src/notifications");

const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const PROVIDER_ID = "22222222-2222-4222-8222-222222222222";
const ORDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SERVICE_ID = "99999999-9999-4999-8999-999999999999";

const customer = { userId: CUSTOMER_ID, roles: ["cliente"] };
const provider = { userId: PROVIDER_ID, roles: ["prestadora"] };

const DAY = 24 * 60 * 60 * 1000;
// Horários futuros em hora cheia, para não depender de quando o teste roda
const atHour = (daysAhead, hourUtc) => {
  const date = new Date(Date.now() + daysAhead * DAY);
  date.setUTCHours(hourUtc, 0, 0, 0);
  return date;
};
const ORIGINAL = atHour(3, 13);
const PROPOSED = atHour(3, 19);

let server;
let order;

before(async () => { server = await startServer(); });
after(async () => { await server.close(); });

const names = {
  pattern: /^SELECT name FROM users WHERE id=\$1/,
  rows: (params) => [{ name: params[0] === CUSTOMER_ID ? "Ana Lima" : "Carla Souza" }],
};
const notifications = () => queriesMatching(/^INSERT INTO notifications/).map(({ params }) => ({
  userId: params[0], type: params[1], title: params[2], body: params[3], data: params[4], area: params[5],
}));
const events = () => queriesMatching(/^INSERT INTO order_events/).map(({ sql, params }) => ({
  type: sql.match(/VALUES \(\$1,\$2,'(\w+)'/)[1], data: params[2],
}));

function baseRules(extra = []) {
  return [
    ...extra,
    names,
    { pattern: /^SELECT \* FROM orders WHERE id=\$1 FOR UPDATE/, rows: () => [order] },
    { pattern: /^SELECT orders\.id,/, rows: () => [{ id: ORDER_ID }] },
  ];
}

beforeEach(() => {
  order = {
    id: ORDER_ID, customer_id: CUSTOMER_ID, provider_id: PROVIDER_ID, service_id: SERVICE_ID,
    status: "requested", service_location: "at_customer", total_amount: "180.00", checkin_code: "0427",
    scheduled_at: ORIGINAL.toISOString(), duration_minutes: 60,
    proposed_scheduled_at: null, proposal_reason: null,
  };
  resetDatabase(baseRules());
});

const propose = (user, body) =>
  server.call("POST", `/api/v1/orders/${ORDER_ID}/time-proposal`, { ...user, body });
const answer = (user, action) =>
  server.call("POST", `/api/v1/orders/${ORDER_ID}/time-proposal/${action}`, { ...user, body: {} });

describe("cancel with a reason", () => {
  test("provider declining a requested order sends the reason to the customer", async () => {
    const response = await server.call("PATCH", `/api/v1/orders/${ORDER_ID}/status`, {
      ...provider, body: { status: "cancelled", reason: "  Estou sem agenda nesse dia  " },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(queriesMatching(/^UPDATE orders SET cancellation_reason/)[0].params, ["Estou sem agenda nesse dia", ORDER_ID]);
    const [sent] = notifications();
    assert.equal(sent.userId, CUSTOMER_ID);
    assert.equal(sent.type, "order_cancelled");
    assert.equal(sent.title, "Pedido recusado");
    assert.equal(sent.body, `Carla Souza recusou seu pedido de ${formatWhen(ORIGINAL)}. Motivo: Estou sem agenda nesse dia`);
    assert.equal(queriesMatching(/^UPDATE payments SET status='released'/).length, 1);
    assert.deepEqual(events()[0].data.reason, "Estou sem agenda nesse dia");
  });

  test("cancelling after acceptance keeps the 'cancelled' wording", async () => {
    order.status = "accepted";
    await server.call("PATCH", `/api/v1/orders/${ORDER_ID}/status`, { ...provider, body: { status: "cancelled" } });
    assert.equal(notifications()[0].title, "Pedido cancelado");
    assert.equal(queriesMatching(/^UPDATE orders SET cancellation_reason/).length, 0);
  });

  test("a reason is only accepted when cancelling", async () => {
    const response = await server.call("PATCH", `/api/v1/orders/${ORDER_ID}/status`, {
      ...provider, body: { status: "accepted", reason: "ok" },
    });
    assert.equal(response.status, 422);
  });
});

describe("POST /orders/:id/time-proposal", () => {
  test("provider suggests another time and the customer is notified", async () => {
    const response = await propose(provider, { scheduledAt: PROPOSED.toISOString(), reason: "Ocupada até as 15h" });
    assert.equal(response.status, 200);
    const update = queriesMatching(/^UPDATE orders SET proposed_scheduled_at/)[0];
    assert.equal(new Date(update.params[0]).getTime(), PROPOSED.getTime());
    assert.deepEqual(update.params.slice(1), ["Ocupada até as 15h", ORDER_ID]);
    // A agenda ignora o próprio pedido ao conferir o novo horário
    for (const busyCheck of queriesMatching(/^SELECT 1 FROM orders WHERE/)) assert.equal(busyCheck.params[4], ORDER_ID);
    assert.deepEqual(notifications(), [{
      userId: CUSTOMER_ID, type: "order_reschedule_proposed", title: "Nova sugestão de horário",
      body: `Carla Souza não pode em ${formatWhen(ORIGINAL)} e sugeriu ${formatWhen(PROPOSED)}. Motivo: Ocupada até as 15h`,
      data: { orderId: ORDER_ID }, area: "customer",
    }]);
    assert.equal(events()[0].type, "time_proposed");
  });

  test("only orders not yet accepted get another time", async () => {
    order.status = "accepted";
    const response = await propose(provider, { scheduledAt: PROPOSED.toISOString() });
    assert.equal(response.status, 409);
    assert.equal(queriesMatching(/^UPDATE orders/).length, 0);
  });

  test("the customer cannot suggest a time", async () => {
    assert.equal((await propose(customer, { scheduledAt: PROPOSED.toISOString() })).status, 403);
  });

  test("rejects the same time, a time too soon and a busy slot", async () => {
    assert.equal((await propose(provider, { scheduledAt: ORIGINAL.toISOString() })).status, 422);

    const soon = new Date(Date.now() + 30 * 60000);
    assert.equal((await propose(provider, { scheduledAt: soon.toISOString() })).status, 422);

    resetDatabase(baseRules([{ pattern: /^SELECT 1 FROM orders WHERE provider_id=\$1/, rows: [{ "?column?": 1 }] }]));
    const busy = await propose(provider, { scheduledAt: PROPOSED.toISOString() });
    assert.equal(busy.status, 409);
    assert.equal(busy.body.error.code, "slot_unavailable");
    assert.equal(notifications().length, 0);
  });

  test("the new time must fit the service hours", async () => {
    // Serviço atende só aos domingos 06:00-07:00 em Brasília: o horário sugerido não cabe
    resetDatabase(baseRules([{
      pattern: /^SELECT availability FROM services/,
      rows: [{ availability: [{ weekday: 7, start: "06:00", end: "07:00" }] }],
    }]));
    const response = await propose(provider, { scheduledAt: atHour(3, 15).toISOString() });
    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, "outside_service_hours");
  });
});

describe("answering a time proposal", () => {
  beforeEach(() => {
    order.proposed_scheduled_at = PROPOSED.toISOString();
    order.proposal_reason = "Ocupada até as 15h";
  });

  test("customer accepts: new time, order accepted, payment hold moved", async () => {
    const response = await answer(customer, "accept");
    assert.equal(response.status, 200);
    const update = queriesMatching(/^UPDATE orders SET scheduled_at=\$1, status='accepted'/)[0];
    assert.equal(new Date(update.params[0]).getTime(), PROPOSED.getTime());
    const hold = queriesMatching(/^UPDATE payments SET held_until/)[0];
    assert.equal(new Date(hold.params[0]).getTime(), PROPOSED.getTime() + 60 * 60000);
    assert.deepEqual(events().map((event) => event.type), ["time_proposal_accepted", "status_changed"]);
    assert.deepEqual(notifications(), [{
      userId: PROVIDER_ID, type: "order_reschedule_accepted", title: "Novo horário aceito",
      body: `Ana Lima aceitou ${formatWhen(PROPOSED)}. O pedido está confirmado.`,
      data: { orderId: ORDER_ID }, area: "provider",
    }]);
  });

  test("accepting checks the slot again", async () => {
    resetDatabase(baseRules([{ pattern: /^SELECT 1 FROM orders WHERE \(customer_id=\$1 OR provider_id=\$1\)/, rows: [{ "?column?": 1 }] }]));
    const response = await answer(customer, "accept");
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "schedule_conflict");
    assert.equal(queriesMatching(/^UPDATE orders/).length, 0);
  });

  test("an expired proposal cannot be accepted", async () => {
    order.proposed_scheduled_at = new Date(Date.now() + 30 * 60000).toISOString();
    const response = await answer(customer, "accept");
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "proposal_expired");
  });

  test("customer declines: order cancelled, payment released, one notice to the provider", async () => {
    const response = await answer(customer, "decline");
    assert.equal(response.status, 200);
    assert.deepEqual(queriesMatching(/^UPDATE orders SET status=\$1/)[0].params, ["cancelled", ORDER_ID]);
    assert.equal(queriesMatching(/^UPDATE payments SET status='released'/).length, 1);
    assert.deepEqual(notifications(), [{
      userId: PROVIDER_ID, type: "order_reschedule_declined", title: "Horário sugerido recusado",
      body: `Ana Lima recusou ${formatWhen(PROPOSED)}. O pedido foi cancelado.`,
      data: { orderId: ORDER_ID }, area: "provider",
    }]);
  });

  test("only the customer answers, and only while there is a proposal", async () => {
    assert.equal((await answer(provider, "accept")).status, 403);
    order.proposed_scheduled_at = null;
    const response = await answer(customer, "decline");
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "no_time_proposal");
  });

  test("provider accepting the original time drops the proposal", async () => {
    await server.call("PATCH", `/api/v1/orders/${ORDER_ID}/status`, { ...provider, body: { status: "accepted" } });
    assert.match(queriesMatching(/^UPDATE orders SET status=\$1/)[0].sql, /proposed_scheduled_at=NULL/);
  });
});

test("slots can ignore one of the caller's own orders", async () => {
  resetDatabase([
    { pattern: /FROM services service JOIN provider_profiles/, rows: [{ id: SERVICE_ID, provider_id: PROVIDER_ID, duration_minutes: 60, availability: [] }] },
  ]);
  const date = PROPOSED.toISOString().slice(0, 10);
  const response = await server.call("GET", `/api/v1/services/${SERVICE_ID}/slots?date=${date}&excludeOrderId=${ORDER_ID}`, provider);
  assert.equal(response.status, 200);
  const busyQuery = queriesMatching(/^SELECT scheduled_at, duration_minutes, provider_id, customer_id FROM orders/)[0];
  assert.equal(busyQuery.params[5], ORDER_ID);
});
