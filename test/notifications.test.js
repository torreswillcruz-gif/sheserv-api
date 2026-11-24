const assert = require("node:assert/strict");
const { after, before, describe, test } = require("node:test");
const { resetDatabase, queriesMatching, startServer, approvedProviderRule } = require("./helpers/testApp");

const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const PROVIDER_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_PROVIDER_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "55555555-5555-4555-8555-555555555555";
const QUOTE_ID = "66666666-6666-4666-8666-666666666666";
const COMPETING_ID = "77777777-7777-4777-8777-777777777777";
const ORDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const customer = { userId: CUSTOMER_ID, roles: ["cliente"] };
const provider = { userId: PROVIDER_ID, roles: ["prestadora"] };
const inDays = (days) => new Date(Date.now() + days * 86400000).toISOString();

const quoteRow = (overrides = {}) => ({
  id: QUOTE_ID, request_id: REQUEST_ID, provider_id: PROVIDER_ID, customer_id: CUSTOMER_ID,
  status: "open", total_amount: "1250.00", valid_until: inDays(3), reserved_quota: true, quota_period: "2026-11",
  ...overrides,
});
const names = { pattern: /^SELECT name FROM users WHERE id=\$1/, rows: (params) => [{ name: params[0] === CUSTOMER_ID ? "Ana Lima" : "Carla Souza" }] };

// Notificações gravadas, com os parâmetros nomeados
const notifications = () => queriesMatching(/^INSERT INTO notifications/).map(({ params }) => ({
  userId: params[0], type: params[1], title: params[2], body: params[3], data: params[4], area: params[5],
}));

let server;
before(async () => { server = await startServer(); });
after(async () => { await server.close(); });

describe("notifications on the quote flow", () => {
  test("a direct request notifies the chosen provider", async () => {
    resetDatabase([
      names,
      { pattern: /^SELECT 1 FROM users u JOIN provider_profiles/, rows: [{ "?column?": 1 }] },
      { pattern: /^INSERT INTO service_requests/, rows: [{ id: REQUEST_ID }] },
    ]);
    const response = await server.call("POST", "/api/v1/requests", {
      ...customer,
      body: { providerId: PROVIDER_ID, description: "Faxina completa no apartamento" },
    });
    assert.equal(response.status, 201);
    assert.deepEqual(notifications(), [{
      userId: PROVIDER_ID, type: "request_received", title: "Nova solicitação de orçamento",
      body: "Ana Lima pediu um orçamento para você.", data: { requestId: REQUEST_ID }, area: "provider",
    }]);
  });

  test("a public request notifies nobody", async () => {
    resetDatabase([{ pattern: /^INSERT INTO service_requests/, rows: [{ id: REQUEST_ID }] }]);
    await server.call("POST", "/api/v1/requests", { ...customer, body: { description: "Pedido aberto para todas" } });
    assert.deepEqual(notifications(), []);
  });

  test("a sent quote notifies the customer with the amount", async () => {
    resetDatabase([
      approvedProviderRule, names,
      { pattern: /^SELECT \* FROM service_requests WHERE id=\$1 FOR UPDATE/, rows: [{ id: REQUEST_ID, status: "open", provider_id: null, customer_id: CUSTOMER_ID }] },
      { pattern: /^SELECT count\(\*\)::int AS total FROM quotes/, rows: [{ total: 0 }] },
      { pattern: /^SELECT monthly_approval_limit FROM plan_catalog/, rows: [{ monthly_approval_limit: 20 }] },
      { pattern: /^INSERT INTO monthly_approval_usage/, rows: [{ approved_count: 0, reserved_count: 0 }] },
      { pattern: /^INSERT INTO quotes/, rows: [quoteRow()] },
    ]);
    const response = await server.call("POST", `/api/v1/requests/${REQUEST_ID}/quotes`, {
      ...provider,
      body: { totalAmount: 1250, validUntil: inDays(5), items: [{ description: "Serviço", unitPrice: 1250 }] },
    });
    assert.equal(response.status, 201);
    const [sent] = notifications();
    assert.equal(sent.userId, CUSTOMER_ID);
    assert.equal(sent.type, "quote_received");
    assert.equal(sent.body, "Carla Souza enviou um orçamento de R$ 1.250,00.");
    assert.deepEqual(sent.data, { requestId: REQUEST_ID, quoteId: QUOTE_ID });
    assert.equal(sent.area, "customer");
  });

  test("a message notifies the other side, in that side's area", async () => {
    resetDatabase([
      names,
      { pattern: /^SELECT \* FROM quotes WHERE id=\$1/, rows: [quoteRow()] },
      { pattern: /^INSERT INTO quote_messages/, rows: [{ id: "m1", text: "Pode ser na sexta?" }] },
    ]);
    await server.call("POST", `/api/v1/quotes/${QUOTE_ID}/messages`, { ...customer, body: { text: "Pode ser na sexta?" } });
    await server.call("POST", `/api/v1/quotes/${QUOTE_ID}/messages`, { ...provider, body: { text: "Pode sim!" } });
    assert.deepEqual(
      notifications().map(({ userId, title, area }) => ({ userId, title, area })),
      [
        { userId: PROVIDER_ID, title: "Nova mensagem de Ana Lima", area: "provider" },
        { userId: CUSTOMER_ID, title: "Nova mensagem de Carla Souza", area: "customer" },
      ]
    );
  });

  test("a counter-offer from the customer notifies the provider", async () => {
    resetDatabase([names, { pattern: /^SELECT \* FROM quotes WHERE id=\$1/, rows: [quoteRow()] }]);
    await server.call("POST", `/api/v1/quotes/${QUOTE_ID}/counter`, {
      ...customer,
      body: { totalAmount: 1100, validUntil: inDays(4) },
    });
    const [countered] = notifications();
    assert.equal(countered.userId, PROVIDER_ID);
    assert.equal(countered.title, "Contraproposta recebida");
    assert.equal(countered.body, "Ana Lima propôs R$ 1.100,00.");
  });

  test("approving notifies the chosen provider and the ones not chosen", async () => {
    resetDatabase([
      names,
      { pattern: /^SELECT \* FROM quotes WHERE id=\$1/, rows: [quoteRow()] },
      { pattern: /^SELECT \* FROM quotes WHERE request_id=\$1 AND id<>\$2/, rows: [quoteRow({ id: COMPETING_ID, provider_id: OTHER_PROVIDER_ID })] },
      { pattern: /^SELECT \* FROM service_requests WHERE id=\$1/, rows: [{ id: REQUEST_ID, service_id: null, address_id: null }] },
      { pattern: /^INSERT INTO orders/, rows: [{ id: ORDER_ID }] },
    ]);
    const response = await server.call("POST", `/api/v1/quotes/${QUOTE_ID}/approve`, {
      ...customer,
      body: { scheduledAt: inDays(2) },
    });
    assert.equal(response.status, 200);
    const byType = Object.fromEntries(notifications().map((entry) => [entry.type, entry]));
    assert.equal(byType.quote_approved.userId, PROVIDER_ID);
    assert.deepEqual(byType.quote_approved.data, { requestId: REQUEST_ID, quoteId: QUOTE_ID, orderId: ORDER_ID });
    assert.equal(byType.quote_not_chosen.userId, OTHER_PROVIDER_ID);
  });

  test("rejecting notifies the provider", async () => {
    resetDatabase([names, { pattern: /^SELECT \* FROM quotes WHERE id=\$1 FOR UPDATE/, rows: [quoteRow()] }]);
    await server.call("POST", `/api/v1/quotes/${QUOTE_ID}/reject`, customer);
    const [rejected] = notifications();
    assert.equal(rejected.type, "quote_rejected");
    assert.equal(rejected.userId, PROVIDER_ID);
  });
});

describe("GET /me/notifications", () => {
  test("is available to customers too (not only providers)", async () => {
    resetDatabase([{ pattern: /FROM notifications/, rows: [{ id: "n1", title: "Oi" }] }]);
    const response = await server.call("GET", "/api/v1/me/notifications", customer);
    assert.equal(response.status, 200);
    assert.equal(response.body.length, 1);
  });

  test("filters by ?since and ?area", async () => {
    resetDatabase();
    const since = "2026-11-24T12:00:00.000Z";
    await server.call("GET", `/api/v1/me/notifications?since=${since}&area=customer`, customer);
    const [query] = queriesMatching(/FROM notifications/);
    assert.deepEqual(query.params, [CUSTOMER_ID, since, "customer"]);
  });

  test("refuses an unknown area", async () => {
    resetDatabase();
    const response = await server.call("GET", "/api/v1/me/notifications?area=admin", customer);
    assert.equal(response.status, 422);
  });

  test("read-all marks the account's unread notifications", async () => {
    resetDatabase([{ pattern: /^UPDATE notifications SET read=true/, rows: [{}, {}] }]);
    const response = await server.call("POST", "/api/v1/me/notifications/read-all", { ...customer, body: { area: "customer" } });
    assert.equal(response.status, 200);
    assert.equal(response.body.updated, 2);
    assert.deepEqual(queriesMatching(/^UPDATE notifications/)[0].params, [CUSTOMER_ID, "customer"]);
  });
});

describe("GET /requests/:id/quotes", () => {
  const requestRow = (overrides = {}) => ({ id: REQUEST_ID, customer_id: CUSTOMER_ID, provider_id: null, ...overrides });

  test("a provider who quoted a public request sees only her own quote", async () => {
    resetDatabase([
      { pattern: /^SELECT \* FROM service_requests WHERE id=\$1/, rows: [requestRow()] },
      { pattern: /^SELECT 1 FROM quotes WHERE request_id=\$1 AND provider_id=\$2/, rows: [{ "?column?": 1 }] },
      { pattern: /FROM quotes q JOIN users provider/, rows: [quoteRow()] },
    ]);
    const response = await server.call("GET", `/api/v1/requests/${REQUEST_ID}/quotes`, provider);
    assert.equal(response.status, 200);
    assert.deepEqual(queriesMatching(/FROM quotes q JOIN users provider/)[0].params, [REQUEST_ID, PROVIDER_ID]);
  });

  test("the customer sees every quote", async () => {
    resetDatabase([{ pattern: /^SELECT \* FROM service_requests WHERE id=\$1/, rows: [requestRow()] }]);
    const response = await server.call("GET", `/api/v1/requests/${REQUEST_ID}/quotes`, customer);
    assert.equal(response.status, 200);
    assert.deepEqual(queriesMatching(/FROM quotes q JOIN users provider/)[0].params, [REQUEST_ID, null]);
  });

  test("a provider without a quote on the request is refused", async () => {
    resetDatabase([{ pattern: /^SELECT \* FROM service_requests WHERE id=\$1/, rows: [requestRow()] }]);
    const response = await server.call("GET", `/api/v1/requests/${REQUEST_ID}/quotes`, provider);
    assert.equal(response.status, 403);
  });
});
