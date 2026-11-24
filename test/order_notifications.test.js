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

const names = { pattern: /^SELECT name FROM users WHERE id=\$1/, rows: (params) => [{ name: params[0] === CUSTOMER_ID ? "Ana Lima" : "Carla Souza" }] };
const notifications = () => queriesMatching(/^INSERT INTO notifications/).map(({ params }) => ({
  userId: params[0], type: params[1], title: params[2], body: params[3], data: params[4], area: params[5],
}));

beforeEach(() => {
  order = {
    id: ORDER_ID, customer_id: CUSTOMER_ID, provider_id: PROVIDER_ID, service_id: SERVICE_ID,
    status: "requested", service_location: "at_customer", total_amount: "180.00", checkin_code: "0427",
    scheduled_at: "2026-12-02T13:00:00.000Z",
  };
  resetDatabase([
    names,
    { pattern: /^SELECT \* FROM orders WHERE id=\$1 FOR UPDATE/, rows: () => [order] },
    { pattern: /^SELECT orders\.id,/, rows: () => [{ id: ORDER_ID }] },
  ]);
});

const changeStatus = (user, status) =>
  server.call("PATCH", `/api/v1/orders/${ORDER_ID}/status`, { ...user, body: { status } });

describe("order status notifications", () => {
  test("accepting notifies the customer with the time in Brasília", async () => {
    assert.equal((await changeStatus(provider, "accepted")).status, 200);
    assert.deepEqual(notifications(), [{
      userId: CUSTOMER_ID, type: "order_accepted", title: "Pedido aceito",
      body: "Carla Souza aceitou seu pedido para 02/12 às 10:00.",
      data: { orderId: ORDER_ID }, area: "customer",
    }]);
  });

  test("provider on the way notifies the customer", async () => {
    order.status = "accepted";
    await changeStatus(provider, "on_the_way");
    const [sent] = notifications();
    assert.equal(sent.userId, CUSTOMER_ID);
    assert.equal(sent.title, "A prestadora está a caminho");
  });

  test("customer on the way (service at the provider) notifies the provider", async () => {
    order.status = "accepted";
    order.service_location = "at_provider";
    await changeStatus(customer, "on_the_way");
    const [sent] = notifications();
    assert.equal(sent.userId, PROVIDER_ID);
    assert.equal(sent.title, "Ana Lima está a caminho");
    assert.equal(sent.area, "provider");
  });

  test("cancelling notifies whoever did not cancel", async () => {
    await changeStatus(customer, "cancelled");
    assert.equal(notifications()[0].userId, PROVIDER_ID);
    assert.equal(notifications()[0].body, "Ana Lima cancelou o pedido de 02/12 às 10:00.");

    resetDatabase([names, { pattern: /^SELECT \* FROM orders WHERE id=\$1 FOR UPDATE/, rows: () => [order] }]);
    await changeStatus(provider, "cancelled");
    assert.equal(notifications()[0].userId, CUSTOMER_ID);
    assert.equal(notifications()[0].area, "customer");
  });

  test("check-in and check-out notify the customer (started / completed)", async () => {
    order.status = "on_the_way";
    await server.call("POST", `/api/v1/orders/${ORDER_ID}/check-ins`, { ...provider, body: { type: "entry", code: "0427" } });
    order.status = "in_progress";
    await server.call("POST", `/api/v1/orders/${ORDER_ID}/check-ins`, { ...provider, body: { type: "exit", code: "0427" } });
    assert.deepEqual(notifications().map(({ type, userId }) => [type, userId]), [
      ["order_in_progress", CUSTOMER_ID],
      ["order_completed", CUSTOMER_ID],
    ]);
  });

  test("a refused transition notifies nobody", async () => {
    order.status = "completed";
    assert.equal((await changeStatus(provider, "accepted")).status, 409);
    assert.deepEqual(notifications(), []);
  });
});

describe("POST /orders", () => {
  test("a new booking notifies the provider", async () => {
    const scheduledAt = new Date(Date.now() + 3 * 86400000);
    resetDatabase([
      names,
      { pattern: /^SELECT service\.\*, provider_profile\.activation_status/, rows: [{
        id: SERVICE_ID, provider_id: PROVIDER_ID, title: "Manicure", base_price: "80.00", duration_minutes: 60,
        service_location: "at_provider", activation_status: "active", availability: [],
      }] },
      { pattern: /^INSERT INTO orders/, rows: [{ id: ORDER_ID }] },
      { pattern: /^SELECT orders\.id,/, rows: [{ id: ORDER_ID }] },
    ]);
    const response = await server.call("POST", "/api/v1/orders", {
      ...customer,
      body: { serviceId: SERVICE_ID, scheduledAt: scheduledAt.toISOString(), paymentMethod: { type: "pix" } },
    });
    assert.equal(response.status, 201);
    const [sent] = notifications();
    assert.equal(sent.userId, PROVIDER_ID);
    assert.equal(sent.type, "order_requested");
    assert.match(sent.body, /^Ana Lima agendou Manicure para \d{2}\/\d{2} às \d{2}:\d{2}\.$/);
  });
});

describe("devices for push", () => {
  const TOKEN = "fcm-token-with-enough-characters-1234567890";

  test("registers the device token for the logged-in account", async () => {
    resetDatabase();
    const response = await server.call("POST", "/api/v1/me/devices", { ...customer, body: { token: TOKEN } });
    assert.equal(response.status, 204);
    assert.deepEqual(queriesMatching(/^INSERT INTO device_tokens/)[0].params, [TOKEN, CUSTOMER_ID, "android"]);
  });

  test("removes only the account's own token", async () => {
    resetDatabase();
    const response = await server.call("POST", "/api/v1/me/devices/unregister", { ...customer, body: { token: TOKEN } });
    assert.equal(response.status, 204);
    assert.deepEqual(queriesMatching(/^DELETE FROM device_tokens/)[0].params, [TOKEN, CUSTOMER_ID]);
  });

  test("refuses an invalid token", async () => {
    resetDatabase();
    const response = await server.call("POST", "/api/v1/me/devices", { ...customer, body: { token: "x" } });
    assert.equal(response.status, 422);
  });
});

describe("order chat", () => {
  const send = (user, text) => server.call("POST", `/api/v1/orders/${ORDER_ID}/messages`, { ...user, body: { text } });

  test("a message notifies the other side and hides phone numbers", async () => {
    resetDatabase([
      names,
      { pattern: /^SELECT \* FROM orders WHERE id=\$1 FOR UPDATE/, rows: () => [order] },
      { pattern: /^INSERT INTO messages/, rows: (params) => [{ id: "m1", authorId: params[1], text: params[2] }] },
    ]);
    const response = await send(customer, "Me liga no 11 98765-4321, por favor");
    assert.equal(response.status, 201);
    assert.equal(response.body.text, "Me liga no [telefone oculto], por favor");
    assert.equal(response.body.authorName, "Ana Lima");
    assert.deepEqual(notifications(), [{
      userId: PROVIDER_ID, type: "order_message", title: "Nova mensagem de Ana Lima",
      body: "Me liga no [telefone oculto], por favor", data: { orderId: ORDER_ID }, area: "provider",
    }]);
  });

  test("the provider's message goes to the customer area", async () => {
    resetDatabase([
      names,
      { pattern: /^SELECT \* FROM orders WHERE id=\$1 FOR UPDATE/, rows: () => [order] },
      { pattern: /^INSERT INTO messages/, rows: [{ id: "m2" }] },
    ]);
    await send(provider, "Chego às 10h");
    assert.deepEqual(notifications().map(({ userId, area }) => [userId, area]), [[CUSTOMER_ID, "customer"]]);
  });

  test("completed or cancelled orders are read-only", async () => {
    for (const status of ["completed", "cancelled"]) {
      order.status = status;
      resetDatabase([{ pattern: /^SELECT \* FROM orders WHERE id=\$1 FOR UPDATE/, rows: () => [order] }]);
      const response = await send(customer, "Oi?");
      assert.equal(response.status, 409);
      assert.equal(response.body.error.code, "chat_closed");
      assert.equal(queriesMatching(/^INSERT INTO messages/).length, 0);
    }
  });

  test("lists the messages with the author's name", async () => {
    resetDatabase([{ pattern: /^SELECT \* FROM orders WHERE id=\$1 FOR UPDATE/, rows: () => [order] }]);
    const response = await server.call("GET", `/api/v1/orders/${ORDER_ID}/messages`, customer);
    assert.equal(response.status, 200);
    assert.match(queriesMatching(/FROM messages m JOIN users u/)[0].sql, /u\.name AS "authorName"/);
  });
});
