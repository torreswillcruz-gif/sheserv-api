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
const PROVIDER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VERIFICATION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
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

describe("provider approval also verifies", () => {
  beforeEach(() => {
    log = [];
    rules = [
      adminRule,
      { pattern: /^SELECT provider_user\.id,provider_profile\.activation_status AS status/, rows: [{ id: PROVIDER_ID, status: "pending" }] },
      { pattern: /^UPDATE provider_profiles SET activation_status/, rows: (params) => [{
        id: PROVIDER_ID, activationStatus: params[0], identityVerified: params[0] === "active",
      }] },
    ];
  });

  test("approving marks the provider verified and resolves open verification requests", async () => {
    const response = await call("PATCH", `/api/v1/admin/providers/${PROVIDER_ID}/approval`, { status: "active" });
    assert.equal(response.status, 200);
    assert.equal(response.body.identityVerified, true);
    assert.match(queries(/^UPDATE provider_profiles/)[0].sql, /verified=\(\$1='active'\)/);
    const resolved = queries(/^UPDATE verifications SET result/)[0];
    assert.deepEqual(resolved.params.slice(0, 2), [PROVIDER_ID, "approved"]);
    assert.equal(resolved.params[3], ADMIN_ID);
  });

  test("rejecting removes the verified mark and rejects open requests with the reason", async () => {
    const response = await call("PATCH", `/api/v1/admin/providers/${PROVIDER_ID}/approval`, {
      status: "rejected", reason: "Documentos ilegíveis",
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.identityVerified, false);
    const resolved = queries(/^UPDATE verifications SET result/)[0];
    assert.deepEqual(resolved.params.slice(0, 3), [PROVIDER_ID, "rejected", "Documentos ilegíveis"]);
  });
});

describe("verification review", () => {
  let verification;

  beforeEach(() => {
    log = [];
    verification = { id: VERIFICATION_ID, user_id: PROVIDER_ID, type: "cpf_selfie", result: "pending" };
    rules = [
      adminRule,
      { pattern: /^SELECT id,user_id,type,result FROM verifications WHERE id=\$1 FOR UPDATE/, rows: () => (verification ? [verification] : []) },
      { pattern: /^UPDATE verifications SET result/, rows: (params) => [{
        id: params[0], type: "cpf_selfie", result: params[1], reviewNote: params[2],
      }] },
    ];
  });

  test("lists pending requests oldest first by default", async () => {
    const response = await call("GET", "/api/v1/admin/verifications");
    assert.equal(response.status, 200);
    const list = queries(/FROM verifications verification/)[0];
    assert.equal(list.params[0], "pending");
    assert.match(list.sql, /ORDER BY verification\.created_at ASC/);
  });

  test("approving confirms identity, sets the verified mark and notifies", async () => {
    const response = await call("PATCH", `/api/v1/admin/verifications/${VERIFICATION_ID}`, { result: "approved" });
    assert.equal(response.status, 200);
    assert.equal(response.body.result, "approved");
    assert.deepEqual(queries(/^UPDATE provider_profiles SET verified=true/)[0].params, [PROVIDER_ID]);
    assert.equal(queries(/^INSERT INTO notifications/)[0].params[1], "verification_approved");
    assert.equal(queries(/^INSERT INTO admin_audit_events/).length, 1);
  });

  test("rejecting requires a reason and does not touch the verified mark", async () => {
    const missingReason = await call("PATCH", `/api/v1/admin/verifications/${VERIFICATION_ID}`, { result: "rejected" });
    assert.equal(missingReason.status, 422);

    log = [];
    const response = await call("PATCH", `/api/v1/admin/verifications/${VERIFICATION_ID}`, {
      result: "rejected", reason: "Selfie não confere",
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.reviewNote, "Selfie não confere");
    assert.equal(queries(/^UPDATE provider_profiles/).length, 0);
    assert.match(queries(/^INSERT INTO notifications/)[0].params[3], /Motivo: Selfie não confere/);
  });

  test("unknown verification", async () => {
    verification = null;
    const response = await call("PATCH", `/api/v1/admin/verifications/${VERIFICATION_ID}`, { result: "approved" });
    assert.equal(response.status, 404);
  });
});

describe("provider list", () => {
  test("includes the current plan", async () => {
    log = [];
    rules = [adminRule];
    await call("GET", "/api/v1/admin/providers?status=active");
    const list = queries(/FROM provider_profiles provider_profile/)[0];
    assert.match(list.sql, /AS "planCode"/);
    assert.match(list.sql, /LEFT JOIN provider_plans/);
  });
});
