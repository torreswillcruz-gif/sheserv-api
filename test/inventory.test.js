const assert = require("node:assert/strict");
const { after, before, describe, test } = require("node:test");
const { resetDatabase, queriesMatching, startServer } = require("./helpers/testApp");

const PROVIDER_ID = "66666666-6666-4666-8666-666666666666";
const ITEM_ID = "77777777-7777-4777-8777-777777777777";
const ENTRY_ID = "88888888-8888-4888-8888-888888888888";
const provider = { userId: PROVIDER_ID, roles: ["prestadora"] };
const enabled = (feature) => ({
  pattern: /AS enabled FROM plan_catalog/,
  rows: (params) => [{ enabled: params[1] === feature }],
});
const item = { id: ITEM_ID, name: "Esmalte", unit: "un", quantity: 4, unitCost: 12 };

let server;
before(async () => { server = await startServer(); });
after(async () => { await server.close(); });

const move = (body) => server.call("POST", `/api/v1/me/inventory/${ITEM_ID}/movements`, { ...provider, body });
const movementDatabase = () => resetDatabase([
  enabled("inventory"),
  { pattern: /^SELECT id,name,unit,quantity::float/, rows: [item] },
  { pattern: /^INSERT INTO financial_entries/, rows: [{ id: ENTRY_ID }] },
  { pattern: /^UPDATE inventory_items SET quantity/, rows: (params) => [{ ...item, quantity: params[1] }] },
]);

describe("inventory items", () => {
  test("lists the active items with low stock and the stock value", async () => {
    resetDatabase([
      enabled("inventory"),
      { pattern: /FROM inventory_items WHERE provider_id=\$1 AND active ORDER BY name/, rows: [
        { id: ITEM_ID, name: "Esmalte", quantity: 2, minQuantity: 3, unitCost: 12 },
        { id: "i2", name: "Algodão", quantity: 10, minQuantity: 2, unitCost: null },
      ] },
    ]);
    const response = await server.call("GET", "/api/v1/me/inventory", provider);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.items.map((row) => row.lowStock), [true, false]);
    assert.deepEqual(response.body.summary, { itemCount: 2, lowStockCount: 1, stockValue: 24 });
  });

  test("needs the inventory feature in the plan", async () => {
    resetDatabase([enabled("finance")]);
    const response = await server.call("GET", "/api/v1/me/inventory", provider);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "plan_required");
  });

  test("creates an item with the initial quantity", async () => {
    resetDatabase([
      enabled("inventory"),
      { pattern: /^INSERT INTO inventory_items/, rows: [{ id: ITEM_ID }] },
    ]);
    const response = await server.call("POST", "/api/v1/me/inventory", { ...provider, body: {
      name: "Esmalte", unit: "un", quantity: 4, minQuantity: 2, unitCost: 12,
    } });
    assert.equal(response.status, 201);
    assert.deepEqual(queriesMatching(/^INSERT INTO inventory_items/)[0].params, [PROVIDER_ID, "Esmalte", "un", 4, 2, 12]);
  });

  test("editing does not change the quantity", async () => {
    resetDatabase([
      enabled("inventory"),
      { pattern: /^UPDATE inventory_items SET name/, rows: [{ id: ITEM_ID }] },
    ]);
    const response = await server.call("PUT", `/api/v1/me/inventory/${ITEM_ID}`, { ...provider, body: {
      name: "Esmalte vermelho", unit: "un", minQuantity: 3, unitCost: 14,
    } });
    assert.equal(response.status, 200);
    assert.doesNotMatch(queriesMatching(/^UPDATE inventory_items/)[0].sql, /[ ,]quantity=/);
  });

  test("archiving keeps the history and answers 404 for another provider's item", async () => {
    resetDatabase([enabled("inventory"), { pattern: /SET active=false/, rows: [{ id: ITEM_ID }] }]);
    assert.equal((await server.call("DELETE", `/api/v1/me/inventory/${ITEM_ID}`, provider)).status, 204);
    resetDatabase([enabled("inventory")]);
    assert.equal((await server.call("DELETE", `/api/v1/me/inventory/${ITEM_ID}`, provider)).status, 404);
  });
});

describe("inventory movements", () => {
  test("a purchase adds stock, updates the cost and can register the expense", async () => {
    movementDatabase();
    const response = await move({ kind: "purchase", quantity: 6, unitCost: 10, registerExpense: true });
    assert.equal(response.status, 201);
    assert.equal(response.body.item.quantity, 10);
    assert.equal(response.body.financialEntryId, ENTRY_ID);
    const [expense] = queriesMatching(/^INSERT INTO financial_entries/);
    assert.deepEqual(expense.params.slice(1, 3), [60, "supplies"]);
    assert.deepEqual(queriesMatching(/^UPDATE inventory_items SET quantity/)[0].params, [ITEM_ID, 10, 10]);
    const [movement] = queriesMatching(/^INSERT INTO inventory_movements/);
    assert.deepEqual(movement.params.slice(2, 7), ["purchase", 6, 10, 10, ENTRY_ID]);
  });

  test("using takes stock out and never goes below zero", async () => {
    movementDatabase();
    const used = await move({ kind: "use", quantity: 1.5 });
    assert.equal(used.status, 201);
    assert.equal(used.body.item.quantity, 2.5);
    assert.equal(queriesMatching(/^INSERT INTO financial_entries/).length, 0);

    movementDatabase();
    const tooMuch = await move({ kind: "use", quantity: 5 });
    assert.equal(tooMuch.status, 409);
    assert.equal(tooMuch.body.error.code, "insufficient_stock");
    assert.equal(queriesMatching(/^INSERT INTO inventory_movements/).length, 0);
  });

  test("a loss can register the loss in the finance at the item cost", async () => {
    movementDatabase();
    const response = await move({ kind: "loss", quantity: 2, registerExpense: true, note: "Quebrou" });
    assert.equal(response.status, 201);
    assert.deepEqual(queriesMatching(/^INSERT INTO financial_entries/)[0].params.slice(1, 3), [24, "loss"]);
  });

  test("a count sets the counted total", async () => {
    movementDatabase();
    const response = await move({ kind: "count", quantity: 7 });
    assert.equal(response.body.item.quantity, 7);
    assert.equal(queriesMatching(/^INSERT INTO inventory_movements/)[0].params[3], 3);
  });

  test("registering an expense needs a unit cost", async () => {
    resetDatabase([
      enabled("inventory"),
      { pattern: /^SELECT id,name,unit,quantity::float/, rows: [{ ...item, unitCost: null }] },
    ]);
    const response = await move({ kind: "purchase", quantity: 2, registerExpense: true });
    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, "unit_cost_required");
  });
});

describe("GET /me/insights", () => {
  test("returns monthly totals by type and category, and the stock summary", async () => {
    resetDatabase([
      enabled("statistics"),
      { pattern: /to_char\(date_trunc\('month', occurred_at\)/, rows: [
        { month: "2026-10", entryType: "receivable", category: "Serviço concluído", fromApp: true, total: 900, count: 6 },
        { month: "2026-10", entryType: "expense", category: "rent_bills", fromApp: false, total: 500, count: 1 },
      ] },
      { pattern: /lowStockCount/, rows: [{ lowStockCount: 2, stockValue: 340 }] },
    ]);
    const response = await server.call("GET", "/api/v1/me/insights", provider);
    assert.equal(response.status, 200);
    assert.equal(response.body.rows.length, 2);
    assert.deepEqual(response.body.inventory, { lowStockCount: 2, stockValue: 340 });
    assert.equal(queriesMatching(/to_char/)[0].params[0], PROVIDER_ID);
  });

  test("is part of the statistics feature", async () => {
    resetDatabase([enabled("finance")]);
    assert.equal((await server.call("GET", "/api/v1/me/insights", provider)).status, 403);
  });
});
