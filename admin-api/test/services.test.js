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


const SERVICE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROVIDER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
let storedService;

beforeEach(() => {
  log = [];
  storedService = { id: SERVICE_ID, title: "Manicure", provider_id: PROVIDER_ID, hidden_by_admin: false };
  rules = [
    adminRule,
    { pattern: /^SELECT id,title,provider_id,hidden_by_admin FROM services/, rows: () => (storedService ? [storedService] : []) },
    { pattern: /FROM services service JOIN users provider_user/, rows: () => [{ id: SERVICE_ID, title: "Manicure", hiddenByAdmin: true }] },
  ];
});

describe("serviços no painel admin", () => {
  test("lista com filtro de visibilidade e busca", async () => {
    const response = await call("GET", "/api/v1/admin/services?visibility=hidden&query=mani");
    assert.equal(response.status, 200);
    assert.equal(response.body.items.length, 1);
    const [listQuery] = queries(/WHERE service\.active/);
    assert.deepEqual(listQuery.params, ["hidden", "mani", 50, 0]);
  });

  test("filtro desconhecido é recusado", async () => {
    const response = await call("GET", "/api/v1/admin/services?visibility=deleted");
    assert.equal(response.status, 422);
  });

  test("ocultar exige motivo", async () => {
    const response = await call("PATCH", `/api/v1/admin/services/${SERVICE_ID}/visibility`, { hidden: true });
    assert.equal(response.status, 422);
    assert.equal(queries(/^UPDATE services/).length, 0);
  });

  test("ocultar grava o motivo, avisa a prestadora e registra na auditoria", async () => {
    const response = await call("PATCH", `/api/v1/admin/services/${SERVICE_ID}/visibility`, {
      hidden: true, reason: "Foto imprópria",
    });
    assert.equal(response.status, 200);
    const [update] = queries(/^UPDATE services SET hidden_by_admin/);
    assert.deepEqual(update.params, [SERVICE_ID, true, "Foto imprópria"]);
    const [notification] = queries(/^INSERT INTO notifications/);
    assert.equal(notification.params[0], PROVIDER_ID);
    assert.equal(notification.params[1], "service_hidden");
    assert.match(notification.params[3], /Foto imprópria/);
    const [audit] = audits();
    assert.equal(audit.action, "service.visibility_changed");
    assert.equal(audit.details.hidden, true);
    assert.equal(audit.details.previousHidden, false);
  });

  test("mostrar de novo limpa o motivo e avisa a prestadora", async () => {
    storedService.hidden_by_admin = true;
    const response = await call("PATCH", `/api/v1/admin/services/${SERVICE_ID}/visibility`, { hidden: false });
    assert.equal(response.status, 200);
    const [update] = queries(/^UPDATE services SET hidden_by_admin/);
    assert.deepEqual(update.params, [SERVICE_ID, false, null]);
    assert.equal(queries(/^INSERT INTO notifications/)[0].params[1], "service_visible");
  });

  test("sem mudança de situação não manda aviso", async () => {
    const response = await call("PATCH", `/api/v1/admin/services/${SERVICE_ID}/visibility`, { hidden: false });
    assert.equal(response.status, 200);
    assert.equal(queries(/^INSERT INTO notifications/).length, 0);
  });

  test("serviço excluído ou inexistente dá 404", async () => {
    storedService = null;
    const missing = await call("PATCH", `/api/v1/admin/services/${SERVICE_ID}/visibility`, { hidden: false });
    assert.equal(missing.status, 404);
    const invalid = await call("PATCH", "/api/v1/admin/services/nao-e-uuid/visibility", { hidden: false });
    assert.equal(invalid.status, 404);
  });
});
