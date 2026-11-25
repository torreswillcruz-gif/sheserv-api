const test = require("node:test");
const assert = require("node:assert/strict");
const { resetDatabase, queriesMatching, startServer } = require("./helpers/testApp");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const identityRule = (status, reviewNote = null) => ({
  pattern: /AS identity_status/,
  rows: [{ identity_status: status, reviewNote }],
});

let server;
test.before(async () => {
  server = await startServer();
});
test.after(() => server.close());

for (const status of ["none", "pending", "rejected"]) {
  test(`conta com identidade "${status}" não usa o app`, async () => {
    resetDatabase([identityRule(status)]);
    const response = await server.call("GET", "/api/v1/me/orders", { userId: USER_ID, roles: ["cliente"] });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "identity_not_verified");
    assert.equal(queriesMatching(/FROM orders/).length, 0);
  });
}

test("prestadora não verificada também é barrada na área dela", async () => {
  resetDatabase([identityRule("pending")]);
  const response = await server.call("GET", "/api/v1/provider/me/dashboard", {
    userId: USER_ID,
    roles: ["prestadora"],
  });
  assert.equal(response.status, 403);
});

test("sem verificação, ainda dá para pedir a verificação e terminar o cadastro", async () => {
  resetDatabase([
    identityRule("none"),
    { pattern: /INSERT INTO verifications/, rows: [{ id: "v1", type: "cpf_selfie", result: "pending" }] },
  ]);
  const caller = { userId: USER_ID, roles: ["cliente", "prestadora"] };
  assert.equal((await server.call("GET", "/api/v1/me/verifications", caller)).status, 200);
  assert.equal(
    (await server.call("POST", "/api/v1/me/verifications", { ...caller, body: { type: "cpf_selfie" } })).status,
    201
  );
  assert.equal((await server.call("GET", "/api/v1/me/addresses", caller)).status, 200);
  assert.equal((await server.call("GET", "/api/v1/me/notifications", caller)).status, 200);
  assert.equal((await server.call("GET", "/api/v1/provider/me/services", caller)).status, 200);
});

test("GET /me/identity devolve a situação e o motivo da recusa", async () => {
  resetDatabase([identityRule("rejected", "Foto ilegível")]);
  const response = await server.call("GET", "/api/v1/me/identity", { userId: USER_ID, roles: ["cliente"] });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { identityStatus: "rejected", reviewNote: "Foto ilegível" });

  resetDatabase([identityRule("pending", "nota antiga")]);
  const pending = await server.call("GET", "/api/v1/me/identity", { userId: USER_ID, roles: ["cliente"] });
  assert.deepEqual(pending.body, { identityStatus: "pending", reviewNote: null });
});

test("conta verificada usa o app normalmente", async () => {
  resetDatabase([]);
  const response = await server.call("GET", "/api/v1/me/identity", { userId: USER_ID, roles: ["cliente"] });
  assert.equal(response.body.identityStatus, "verified");
  const orders = await server.call("GET", "/api/v1/me/orders", { userId: USER_ID, roles: ["cliente"] });
  assert.notEqual(orders.status, 403);
});
