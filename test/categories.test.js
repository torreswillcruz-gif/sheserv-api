const assert = require("node:assert/strict");
const { after, before, beforeEach, describe, test } = require("node:test");
const { resetDatabase, queriesMatching, startServer } = require("./helpers/testApp");

const PROVIDER_ID = "22222222-2222-4222-8222-222222222222";
const SERVICE_ID = "99999999-9999-4999-8999-999999999999";
const provider = { userId: PROVIDER_ID, roles: ["prestadora"] };

let server;

before(async () => { server = await startServer(); });
after(async () => { await server.close(); });

describe("GET /categories", () => {
  beforeEach(() => resetDatabase([
    { pattern: /FROM categories WHERE parent_id IS NULL/, rows: [
      { id: "beauty", parentId: null, name: "Beleza", icon: "beauty" },
      { id: "pets", parentId: null, name: "Pets", icon: "pets" },
    ] },
    { pattern: /FROM categories WHERE parent_id=\$1/, rows: [
      { id: "nails", parentId: "beauty", name: "Unhas", icon: "beauty" },
    ] },
  ]));

  test("lists only active main categories, in the admin order, with the icon", async () => {
    const response = await server.call("GET", "/api/v1/categories");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.map((category) => [category.id, category.icon]), [["beauty", "beauty"], ["pets", "pets"]]);
    const [query] = queriesMatching(/FROM categories WHERE parent_id IS NULL/);
    assert.match(query.sql, /AND active/);
    assert.match(query.sql, /ORDER BY sort_order, name/);
  });

  test("subcategories of a category follow the same rules", async () => {
    const response = await server.call("GET", "/api/v1/categories?parentId=beauty");
    assert.deepEqual(response.body.map((category) => category.id), ["nails"]);
    const [query] = queriesMatching(/FROM categories WHERE parent_id=\$1/);
    assert.deepEqual(query.params, ["beauty"]);
    assert.match(query.sql, /AND active/);
  });
});

describe("POST /provider/me/services and inactive categories", () => {
  const body = {
    categoryId: "beauty", title: "Manicure", basePrice: 80, durationMinutes: 60,
    serviceLocation: "at_customer", availability: [{ weekday: 3, start: "09:00", end: "12:00" }],
  };

  test("a deactivated (or unknown) category does not take new services", async () => {
    // A consulta exige "active": sem linha, a categoria está desativada ou não existe
    resetDatabase([]);
    const response = await server.call("POST", "/api/v1/provider/me/services", { ...provider, body });
    assert.equal(response.status, 422);
    assert.equal(response.body.error.details.categoryId, "Category not found.");
    assert.match(queriesMatching(/^SELECT 1 FROM categories/)[0].sql, /AND active/);
    assert.equal(queriesMatching(/^INSERT INTO services/).length, 0);
  });

  test("an active category does", async () => {
    resetDatabase([
      { pattern: /^SELECT 1 FROM categories WHERE id=\$1 AND active/, rows: [{ "?column?": 1 }] },
      { pattern: /^SELECT count\(\*\)::int AS total FROM services/, rows: [{ total: 0 }] },
      { pattern: /^INSERT INTO services/, rows: [{ id: SERVICE_ID }] },
    ]);
    const response = await server.call("POST", "/api/v1/provider/me/services", { ...provider, body });
    assert.equal(response.status, 201);
  });
});
