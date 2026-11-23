const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const jsonWebToken = require("jsonwebtoken");

process.env.JWT_SECRET = "test-secret-with-more-than-thirty-two-characters";
const database = require("../src/db");
const originalRunQuery = database.runQuery;
let activeAdmin = false;
database.runQuery = async (_sql, [userId]) => ({
  rows: activeAdmin ? [{ id: userId }] : [],
});
const { requireAdmin } = require("../src/security");

after(() => {
  database.runQuery = originalRunQuery;
});

function invokeMiddleware(roles) {
  const token = jsonWebToken.sign(
    { sub: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", roles },
    process.env.JWT_SECRET,
    { algorithm: "HS256", issuer: "sheserv-api", expiresIn: "1m" }
  );
  return new Promise((resolve) => {
    requireAdmin(
      { headers: { authorization: `Bearer ${token}` } },
      {},
      (error) => resolve(error ?? null)
    );
  });
}

test("admin claim alone is rejected when the database role was revoked", async () => {
  activeAdmin = false;
  const error = await invokeMiddleware(["admin"]);
  assert.equal(error.status, 403);
});

test("current database admin role is honored even with a stale token claim", async () => {
  activeAdmin = true;
  assert.equal(await invokeMiddleware(["cliente"]), null);
});
