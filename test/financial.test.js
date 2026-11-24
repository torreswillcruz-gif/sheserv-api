const assert = require("node:assert/strict");
const { after, before, beforeEach, describe, test } = require("node:test");
const { resetDatabase, queriesMatching, startServer } = require("./helpers/testApp");

const PROVIDER_ID = "33333333-3333-4333-8333-333333333333";
const ENTRY_ID = "44444444-4444-4444-8444-444444444444";
const ORDER_ID = "55555555-5555-4555-8555-555555555555";
const provider = { userId: PROVIDER_ID, roles: ["prestadora"] };
const financeEnabled = { pattern: /AS enabled FROM plan_catalog/, rows: [{ enabled: true }] };

let server;
before(async () => { server = await startServer(); });
after(async () => { await server.close(); });

describe("GET /me/financial/dashboard", () => {
  beforeEach(() => resetDatabase([
    financeEnabled,
    { pattern: /GROUP BY 1,2,3/, rows: [
      { entryType: "income", category: "service_outside", fromApp: false, total: 300, count: 2 },
      { entryType: "receivable", category: "Serviço concluído", fromApp: true, total: 180, count: 1 },
      { entryType: "expense", category: "loss", fromApp: false, total: 50, count: 1 },
    ] },
  ]));

  test("adds the totals by category, telling app income from income outside the app", async () => {
    const response = await server.call("GET", "/api/v1/me/financial/dashboard?period=month", provider);
    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.byCategory.map((row) => [row.entryType, row.category, row.fromApp]),
      [["income", "service_outside", false], ["receivable", "Serviço concluído", true], ["expense", "loss", false]],
    );
    const [query] = queriesMatching(/GROUP BY 1,2,3/);
    assert.match(query.sql, /\(source_order_id IS NOT NULL\) AS "fromApp"/);
    assert.equal(query.params[0], PROVIDER_ID);
  });
});

describe("POST /me/financial/entries", () => {
  beforeEach(() => resetDatabase([
    financeEnabled,
    { pattern: /^INSERT INTO financial_entries/, rows: (params) => [{ id: ENTRY_ID, entryType: params[1], amount: params[2] }] },
  ]));

  test("records money that came in outside the app, with date and payment method", async () => {
    const response = await server.call("POST", "/api/v1/me/financial/entries", { ...provider, body: {
      entryType: "income", amount: 120, category: "service_outside", description: "Escova da Ana",
      paymentMethod: "pix", occurredAt: "2026-11-20T12:00:00.000-03:00",
    } });
    assert.equal(response.status, 201);
    const [insert] = queriesMatching(/^INSERT INTO financial_entries/);
    assert.deepEqual(insert.params.slice(1, 6), ["income", 120, "service_outside", "Escova da Ana", "pix"]);
  });

  test("an expense or loss needs a positive amount", async () => {
    const response = await server.call("POST", "/api/v1/me/financial/entries", { ...provider, body: {
      entryType: "expense", amount: 0, category: "loss",
    } });
    assert.equal(response.status, 422);
    assert.equal(queriesMatching(/^INSERT INTO financial_entries/).length, 0);
  });
});

describe("PATCH /me/financial/entries/:id/received", () => {
  test("turns a receivable into income", async () => {
    resetDatabase([
      financeEnabled,
      { pattern: /^UPDATE financial_entries SET entry_type='income'/, rows: [{ id: ENTRY_ID, entryType: "income" }] },
    ]);
    const response = await server.call("PATCH", `/api/v1/me/financial/entries/${ENTRY_ID}/received`, { ...provider, body: { paymentMethod: "cash" } });
    assert.equal(response.status, 200);
    assert.equal(response.body.entryType, "income");
    const [update] = queriesMatching(/^UPDATE financial_entries/);
    assert.match(update.sql, /AND provider_id=\$2 AND entry_type='receivable'/);
    assert.deepEqual([update.params[0], update.params[1], update.params[3]], [ENTRY_ID, PROVIDER_ID, "cash"]);
  });

  test("answers 404 when the entry is not a receivable of this provider", async () => {
    resetDatabase([financeEnabled]);
    const response = await server.call("PATCH", `/api/v1/me/financial/entries/${ENTRY_ID}/received`, { ...provider, body: {} });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "entry_not_found");
  });
});

describe("DELETE /me/financial/entries/:id", () => {
  test("deletes an entry made by hand", async () => {
    resetDatabase([
      financeEnabled,
      { pattern: /^SELECT source_order_id/, rows: [{ sourceOrderId: null }] },
    ]);
    const response = await server.call("DELETE", `/api/v1/me/financial/entries/${ENTRY_ID}`, provider);
    assert.equal(response.status, 204);
    assert.deepEqual(queriesMatching(/^DELETE FROM financial_entries/)[0].params, [ENTRY_ID, PROVIDER_ID]);
  });

  test("keeps the entries created by an order", async () => {
    resetDatabase([
      financeEnabled,
      { pattern: /^SELECT source_order_id/, rows: [{ sourceOrderId: ORDER_ID }] },
    ]);
    const response = await server.call("DELETE", `/api/v1/me/financial/entries/${ENTRY_ID}`, provider);
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "entry_from_order");
    assert.equal(queriesMatching(/^DELETE FROM financial_entries/).length, 0);
  });

  test("answers 404 for another provider's entry", async () => {
    resetDatabase([financeEnabled]);
    const response = await server.call("DELETE", `/api/v1/me/financial/entries/${ENTRY_ID}`, provider);
    assert.equal(response.status, 404);
  });
});
