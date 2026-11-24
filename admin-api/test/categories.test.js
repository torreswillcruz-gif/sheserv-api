const assert = require("node:assert/strict");
const { after, before, beforeEach, describe, test } = require("node:test");
const jsonWebToken = require("jsonwebtoken");

process.env.JWT_SECRET = "test-secret-with-more-than-thirty-two-characters";

// Banco falso: registra cada SQL e responde pela primeira regra que casar
const database = require("../src/db");
let rules = [];
let log = [];
async function fakeQuery(sqlText, params = []) {
  const sql = String(sqlText).replace(/\s+/g, " ").trim();
  log.push({ sql, params });
  const rule = rules.find((candidate) => candidate.pattern.test(sql));
  const rows = rule ? (typeof rule.rows === "function" ? rule.rows(params) : rule.rows) : [];
  return { rows, rowCount: rows.length };
}
database.runQuery = fakeQuery;
database.runInTransaction = async (callback) => callback({ query: fakeQuery });

const app = require("../src/app");

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const token = jsonWebToken.sign({ sub: ADMIN_ID, roles: ["admin"] }, process.env.JWT_SECRET, {
  algorithm: "HS256", issuer: "sheserv-api", expiresIn: "5m",
});
const adminRule = { pattern: /^SELECT id FROM users WHERE id=\$1 AND roles @> ARRAY\['admin'\]/, rows: [{ id: ADMIN_ID }] };
const queries = (pattern) => log.filter((entry) => pattern.test(entry.sql));
const audits = () => queries(/^INSERT INTO admin_audit_events/).map(({ params }) => ({
  action: params[1], resourceId: params[3], details: JSON.parse(params[4]),
}));

let server;
let baseUrl;
before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

const call = async (method, path, body) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

// Categorias "existentes" no banco falso: beauty (principal) e nails (dentro de beauty)
const stored = {
  beauty: { id: "beauty", parentId: null, parent_id: null, name: "Beleza", icon: "beauty", active: true, sortOrder: 0 },
  nails: { id: "nails", parentId: "beauty", parent_id: "beauty", name: "Unhas", icon: "beauty", active: true, sortOrder: 1 },
};
let usage;

beforeEach(() => {
  log = [];
  usage = { services: 0, children: 0 };
  rules = [
    adminRule,
    { pattern: /^SELECT 1 FROM categories WHERE id=\$1/, rows: (params) => (stored[params[0]] ? [{ "?column?": 1 }] : []) },
    { pattern: /^SELECT parent_id FROM categories WHERE id=\$1/, rows: (params) => (stored[params[0]] ? [{ parent_id: stored[params[0]].parent_id }] : []) },
    { pattern: /^SELECT count\(\*\)::int AS total FROM categories WHERE parent_id=\$1/, rows: (params) => [{
      total: Object.values(stored).filter((category) => category.parent_id === params[0]).length,
    }] },
    { pattern: /^SELECT id,parent_id AS "parentId".* FROM categories WHERE id=\$1 FOR UPDATE/, rows: (params) => (stored[params[0]] ? [stored[params[0]]] : []) },
    { pattern: /^SELECT \(SELECT count\(\*\)::int FROM services/, rows: () => [usage] },
    { pattern: /^INSERT INTO categories/, rows: (params) => [{
      id: params[0], parentId: params[1], name: params[2], icon: params[3], sortOrder: params[4], active: params[5],
    }] },
    { pattern: /^UPDATE categories SET/, rows: (params) => [{
      id: params[0], parentId: params[1], name: params[2], icon: params[3], sortOrder: params[4], active: params[5],
    }] },
    { pattern: /^SELECT category\.id/, rows: () => Object.values(stored).map(({ parent_id: _, ...category }) => ({
      ...category, serviceCount: 0, activeServiceCount: 0, childCount: 0,
    })) },
  ];
});

describe("admin categories", () => {
  test("lists every category and the icon keys the app draws", async () => {
    const response = await call("GET", "/api/v1/admin/categories");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.items.map((category) => category.id), ["beauty", "nails"]);
    assert.ok(response.body.icons.includes("general"));
    assert.ok(response.body.icons.includes("pets"));
  });

  test("creates a category with defaults and records the audit", async () => {
    const response = await call("POST", "/api/v1/admin/categories", { id: "pets", name: "  Pets  ", icon: "pets" });
    assert.equal(response.status, 201);
    assert.deepEqual(queries(/^INSERT INTO categories/)[0].params, ["pets", null, "Pets", "pets", 0, true]);
    assert.deepEqual(audits().map((audit) => [audit.action, audit.resourceId]), [["category.created", "pets"]]);
  });

  test("rejects a duplicated id, an invalid id and an unknown icon", async () => {
    const duplicated = await call("POST", "/api/v1/admin/categories", { id: "beauty", name: "Beleza 2" });
    assert.equal(duplicated.status, 409);
    assert.equal(duplicated.body.error.code, "category_exists");

    assert.equal((await call("POST", "/api/v1/admin/categories", { id: "Pós Obra", name: "Pós-obra" })).status, 422);
    assert.equal((await call("POST", "/api/v1/admin/categories", { id: "rockets", name: "Foguetes", icon: "rocket" })).status, 422);
    assert.equal(queries(/^INSERT INTO categories/).length, 0);
  });

  test("a subcategory must sit under a main category (two levels)", async () => {
    const underSub = await call("POST", "/api/v1/admin/categories", { id: "gel", name: "Gel", parentId: "nails" });
    assert.equal(underSub.status, 422);
    assert.match(underSub.body.error.details.parentId, /principal/);

    const missing = await call("POST", "/api/v1/admin/categories", { id: "gel", name: "Gel", parentId: "nope" });
    assert.equal(missing.status, 422);

    const ok = await call("POST", "/api/v1/admin/categories", { id: "gel", name: "Gel", parentId: "beauty" });
    assert.equal(ok.status, 201);
  });

  test("a category with subcategories cannot become a subcategory", async () => {
    stored.cleaning = { id: "cleaning", parentId: null, parent_id: null, name: "Limpeza", icon: "cleaning", active: true, sortOrder: 2 };
    const response = await call("PUT", "/api/v1/admin/categories/beauty", {
      name: "Beleza", parentId: "cleaning", icon: "beauty", sortOrder: 0, active: true,
    });
    delete stored.cleaning;
    assert.equal(response.status, 422);
    assert.match(response.body.error.details.parentId, /subcategorias/);
  });

  test("updates (e.g. deactivates) and audits before and after", async () => {
    const response = await call("PUT", "/api/v1/admin/categories/nails", {
      name: "Unhas", parentId: "beauty", icon: "beauty", sortOrder: 3, active: false,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(queries(/^UPDATE categories SET/)[0].params, ["nails", "beauty", "Unhas", "beauty", 3, false]);
    const [audit] = audits();
    assert.equal(audit.action, "category.updated");
    assert.equal(audit.details.before.active, true);
    assert.equal(audit.details.after.active, false);
  });

  test("updating an unknown category is 404", async () => {
    const response = await call("PUT", "/api/v1/admin/categories/nope", { name: "Nada" });
    assert.equal(response.status, 404);
  });

  test("deletes only when no service or subcategory uses it", async () => {
    usage = { services: 2, children: 0 };
    const inUse = await call("DELETE", "/api/v1/admin/categories/nails");
    assert.equal(inUse.status, 409);
    assert.equal(inUse.body.error.code, "category_in_use");
    assert.equal(inUse.body.error.details.services, 2);
    assert.equal(queries(/^DELETE FROM categories/).length, 0);

    usage = { services: 0, children: 0 };
    const deleted = await call("DELETE", "/api/v1/admin/categories/nails");
    assert.equal(deleted.status, 204);
    assert.deepEqual(queries(/^DELETE FROM categories/)[0].params, ["nails"]);
    assert.equal(audits().at(-1).action, "category.deleted");
  });

  test("only admins reach the routes", async () => {
    rules = rules.filter((rule) => rule !== adminRule);
    const response = await call("GET", "/api/v1/admin/categories");
    assert.equal(response.status, 403);
  });
});
