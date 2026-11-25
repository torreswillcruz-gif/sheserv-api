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
const PROVIDER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const token = jsonWebToken.sign({ sub: ADMIN_ID, roles: ["admin"] }, process.env.JWT_SECRET, {
  algorithm: "HS256", issuer: "sheserv-api", expiresIn: "5m",
});
const adminRule = { pattern: /^SELECT id FROM users WHERE id=\$1 AND roles @> ARRAY\['admin'\]/, rows: [{ id: ADMIN_ID }] };
const queries = (pattern) => log.filter((entry) => pattern.test(entry.sql));

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

let providerExists;
beforeEach(() => {
  log = [];
  providerExists = true;
  rules = [
    adminRule,
    {
      pattern: /^SELECT provider_user\.id,COALESCE\(feature_override\.overrides/,
      rows: () => (providerExists ? [{ id: PROVIDER_ID, overrides: { team: true } }] : []),
    },
    {
      pattern: /^INSERT INTO provider_feature_overrides/,
      rows: (params) => [{ providerId: params[0], featureOverrides: JSON.parse(params[1]) }],
    },
  ];
});

describe("recursos por prestadora", () => {
  test("a lista de prestadoras traz os recursos do plano e as exceções", async () => {
    const response = await call("GET", "/api/v1/admin/providers?status=active");
    assert.equal(response.status, 200);
    const [list] = queries(/FROM provider_profiles provider_profile/);
    assert.match(list.sql, /AS "planFeatures"/);
    assert.match(list.sql, /AS "featureOverrides"/);
  });

  test("salvar substitui as exceções e registra antes e depois na auditoria", async () => {
    const overrides = { finance: true, branding: false };
    const response = await call("PUT", `/api/v1/admin/providers/${PROVIDER_ID}/features`, { overrides });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.featureOverrides, overrides);
    const [audit] = queries(/^INSERT INTO admin_audit_events/);
    assert.equal(audit.params[1], "provider.features_changed");
    assert.deepEqual(JSON.parse(audit.params[4]), { before: { team: true }, after: overrides });
  });

  test("mapa vazio volta a seguir só o plano", async () => {
    const response = await call("PUT", `/api/v1/admin/providers/${PROVIDER_ID}/features`, { overrides: {} });
    assert.equal(response.status, 200);
    assert.deepEqual(queries(/^INSERT INTO provider_feature_overrides/)[0].params[1], "{}");
  });

  test("valores que não são liga/desliga são recusados", async () => {
    const response = await call("PUT", `/api/v1/admin/providers/${PROVIDER_ID}/features`, {
      overrides: { finance: "sim" },
    });
    assert.equal(response.status, 422);
    assert.equal(queries(/^INSERT INTO provider_feature_overrides/).length, 0);
  });

  test("prestadora inexistente dá 404", async () => {
    providerExists = false;
    const response = await call("PUT", `/api/v1/admin/providers/${PROVIDER_ID}/features`, { overrides: {} });
    assert.equal(response.status, 404);
  });
});
