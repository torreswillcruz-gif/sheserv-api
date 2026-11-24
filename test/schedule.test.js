const assert = require("node:assert/strict");
const { after, before, beforeEach, describe, test } = require("node:test");
const { resetDatabase, queriesMatching, startServer } = require("./helpers/testApp");
const { localParts, zonedDate } = require("../src/schedule");

const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const PROVIDER_ID = "22222222-2222-4222-8222-222222222222";
const SERVICE_ID = "99999999-9999-4999-8999-999999999999";
const ORDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const customer = { userId: CUSTOMER_ID, roles: ["cliente"] };
const provider = { userId: PROVIDER_ID, roles: ["prestadora"] };
const bothRoles = { userId: CUSTOMER_ID, roles: ["cliente", "prestadora"] };

// Próxima quarta-feira (horário de Brasília) a pelo menos 2 dias de hoje
function nextWednesday() {
  let date = new Date(Date.now() + 2 * 86400000);
  while (localParts(date).weekday !== 3) date = new Date(date.getTime() + 86400000);
  return localParts(date).dateKey;
}
const WEDNESDAY = nextWednesday();
const atBrasilia = (hour, minute = 0) => zonedDate(WEDNESDAY, hour * 60 + minute).toISOString();

const WEEKDAY_HOURS = [{ weekday: 3, start: "09:00", end: "12:00" }];

let server;
before(async () => { server = await startServer(); });
after(async () => { await server.close(); });

function serviceRow(overrides = {}) {
  return {
    id: SERVICE_ID, provider_id: PROVIDER_ID, base_price: "120.00", duration_minutes: 60,
    service_location: "at_provider", activation_status: "active", availability: WEEKDAY_HOURS,
    ...overrides,
  };
}

const book = (scheduledAt, user = customer) => server.call("POST", "/api/v1/orders", {
  ...user,
  body: { serviceId: SERVICE_ID, scheduledAt, paymentMethod: { type: "pix" } },
});

describe("service hours on POST /provider/me/services", () => {
  const baseService = {
    categoryId: "beleza", title: "Manicure", basePrice: 80, durationMinutes: 60,
    serviceLocation: "at_customer",
  };

  beforeEach(() => resetDatabase([
    { pattern: /^SELECT 1 FROM categories/, rows: [{ "?column?": 1 }] },
    { pattern: /^SELECT count\(\*\)::int AS total FROM services/, rows: [{ total: 0 }] },
    { pattern: /^INSERT INTO services/, rows: (params) => [{ id: SERVICE_ID, availability: JSON.parse(params[10]) }] },
  ]));

  test("is required for new services", async () => {
    const response = await server.call("POST", "/api/v1/provider/me/services", { ...provider, body: baseService });
    assert.equal(response.status, 422);
    assert.equal(queriesMatching(/^INSERT INTO services/).length, 0);
  });

  test("rejects a window that ends before it starts", async () => {
    const response = await server.call("POST", "/api/v1/provider/me/services", {
      ...provider,
      body: { ...baseService, availability: [{ weekday: 1, start: "18:00", end: "09:00" }] },
    });
    assert.equal(response.status, 422);
  });

  test("is stored with the service", async () => {
    const response = await server.call("POST", "/api/v1/provider/me/services", {
      ...provider,
      body: { ...baseService, availability: WEEKDAY_HOURS },
    });
    assert.equal(response.status, 201);
    assert.deepEqual(response.body.availability, WEEKDAY_HOURS);
  });
});

describe("POST /orders checks the schedule", () => {
  const rules = (extra = []) => [
    { pattern: /^SELECT service\.\*, provider_profile\.activation_status/, rows: [serviceRow()] },
    ...extra,
    { pattern: /^INSERT INTO orders/, rows: [{ id: ORDER_ID }] },
    { pattern: /^SELECT orders\.id,/, rows: [{ id: ORDER_ID }] },
  ];

  test("accepts a time inside the service hours", async () => {
    resetDatabase(rules());
    const response = await book(atBrasilia(10));
    assert.equal(response.status, 201);
  });

  test("refuses a time outside the service hours", async () => {
    resetDatabase(rules());
    const response = await book(atBrasilia(11, 30)); // 11:30 + 60 min passa das 12:00
    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, "outside_service_hours");
    assert.equal(queriesMatching(/^INSERT INTO orders/).length, 0);
  });

  test("an old service without hours accepts any future time", async () => {
    resetDatabase([
      { pattern: /^SELECT service\.\*, provider_profile\.activation_status/, rows: [serviceRow({ availability: [] })] },
      { pattern: /^INSERT INTO orders/, rows: [{ id: ORDER_ID }] },
      { pattern: /^SELECT orders\.id,/, rows: [{ id: ORDER_ID }] },
    ]);
    const response = await book(atBrasilia(21));
    assert.equal(response.status, 201);
  });

  test("a taken slot is reported as unavailable", async () => {
    resetDatabase(rules([{ pattern: /^SELECT 1 FROM orders WHERE provider_id=\$1/, rows: [{ "?column?": 1 }] }]));
    const response = await book(atBrasilia(10));
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "slot_unavailable");
  });

  test("the customer's own commitment at the same time is reported", async () => {
    resetDatabase(rules([{ pattern: /^SELECT 1 FROM orders WHERE \(customer_id=\$1 OR provider_id=\$1\)/, rows: [{ "?column?": 1 }] }]));
    const response = await book(atBrasilia(10));
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "schedule_conflict");
  });
});

describe("GET /services/:id/slots", () => {
  test("lists the day's start times and marks the busy ones", async () => {
    resetDatabase([
      { pattern: /^SELECT service\.id, service\.provider_id/, rows: [serviceRow()] },
      { pattern: /^SELECT scheduled_at, duration_minutes, provider_id, customer_id FROM orders/, rows: [
        { scheduled_at: atBrasilia(9), duration_minutes: 60, provider_id: PROVIDER_ID, customer_id: "x" },
        { scheduled_at: atBrasilia(11), duration_minutes: 60, provider_id: "someone-else", customer_id: CUSTOMER_ID },
      ] },
    ]);
    const response = await server.call("GET", `/api/v1/services/${SERVICE_ID}/slots?date=${WEDNESDAY}`, customer);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.hours, [{ start: "09:00", end: "12:00" }]);
    const byTime = Object.fromEntries(response.body.slots.map((slot) => [slot.time, slot]));
    assert.deepEqual(Object.keys(byTime), ["09:00", "09:30", "10:00", "10:30", "11:00"]);
    assert.equal(byTime["09:00"].reason, "provider_busy");
    assert.equal(byTime["09:30"].reason, "provider_busy");
    assert.equal(byTime["10:00"].available, true);
    assert.equal(byTime["10:30"].reason, "your_commitment");
    assert.equal(byTime["11:00"].reason, "your_commitment");
  });

  test("a day the service does not work has no slots", async () => {
    resetDatabase([{ pattern: /^SELECT service\.id, service\.provider_id/, rows: [serviceRow({ availability: [{ weekday: 1, start: "09:00", end: "12:00" }] })] }]);
    const response = await server.call("GET", `/api/v1/services/${SERVICE_ID}/slots?date=${WEDNESDAY}`, customer);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.slots, []);
  });

  test("refuses dates in the past", async () => {
    resetDatabase();
    const response = await server.call("GET", `/api/v1/services/${SERVICE_ID}/slots?date=2020-01-01`, customer);
    assert.equal(response.status, 422);
  });
});

describe("agenda per area", () => {
  test("?as=customer only lists orders the account booked", async () => {
    resetDatabase();
    const response = await server.call("GET", "/api/v1/me/orders?as=customer", bothRoles);
    assert.equal(response.status, 200);
    const query = queriesMatching(/FROM orders/)[0];
    assert.match(query.sql, /WHERE orders\.customer_id = \$1 ORDER BY/);
  });

  test("?as=provider only lists orders the account serves", async () => {
    resetDatabase();
    await server.call("GET", "/api/v1/me/orders?as=provider", bothRoles);
    assert.match(queriesMatching(/FROM orders/)[0].sql, /WHERE orders\.provider_id = \$1 ORDER BY/);
  });

  test("an area the account does not have is refused", async () => {
    resetDatabase();
    const response = await server.call("GET", "/api/v1/me/orders?as=provider", customer);
    assert.equal(response.status, 403);
  });

  test("without ?as the previous behaviour (both sides) is kept", async () => {
    resetDatabase();
    await server.call("GET", "/api/v1/me/orders", bothRoles);
    assert.match(queriesMatching(/FROM orders/)[0].sql, /orders\.customer_id = \$1 OR orders\.provider_id = \$1/);
  });

  test("busy times of the other area come without any detail", async () => {
    resetDatabase([{ pattern: /FROM orders WHERE provider_id = \$1/, rows: [
      { scheduledAt: atBrasilia(15), durationMinutes: 60, status: "accepted" },
    ] }]);
    const response = await server.call("GET", "/api/v1/me/orders/busy?as=customer", bothRoles);
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.body[0]).sort(), ["durationMinutes", "scheduledAt", "status"]);
    // Na agenda de cliente, "ocupado" são os atendimentos que ela faz como prestadora
    assert.match(queriesMatching(/FROM orders/)[0].sql, /WHERE provider_id = \$1 AND status = ANY/);
  });
});
