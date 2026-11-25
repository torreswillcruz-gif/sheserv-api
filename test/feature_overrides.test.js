const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { resetDatabase, queriesMatching, startServer } = require("./helpers/testApp");

// Exceções por prestadora definidas no painel admin, por cima do plano.
const PROVIDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const provider = { userId: PROVIDER_ID, roles: ["prestadora"] };

let server;
before(async () => { server = await startServer(); });
after(async () => { await server.close(); });

test("a checagem de recurso soma as exceções da prestadora ao plano", async () => {
  resetDatabase([{ pattern: /AS enabled FROM plan_catalog/, rows: [{ enabled: false }] }]);
  const response = await server.call("GET", "/api/v1/me/financial", provider);
  assert.equal(response.status, 403);
  const [check] = queriesMatching(/AS enabled FROM plan_catalog/);
  assert.match(check.sql, /plan_catalog\.features \|\| COALESCE\( \(SELECT overrides FROM provider_feature_overrides WHERE provider_id=\$1\)/);
  assert.equal(check.params[0], PROVIDER_ID);
});

test("GET /me/plan devolve os recursos já com as exceções e as exceções em separado", async () => {
  resetDatabase([{
    pattern: /AS "approvalLimit"/,
    rows: [{
      plan: "free", displayName: "Grátis", approvalLimit: 20, active: true,
      features: { finance: true, team: false },
      featureOverrides: { finance: true },
    }],
  }]);
  const response = await server.call("GET", "/api/v1/me/plan", provider);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.features, { finance: true, team: false });
  assert.deepEqual(response.body.featureOverrides, { finance: true });
  const [planQuery] = queriesMatching(/AS "approvalLimit"/);
  assert.match(planQuery.sql, /features \|\| COALESCE/);
});

test("sem exceções, featureOverrides vem vazio", async () => {
  resetDatabase([]);
  const response = await server.call("GET", "/api/v1/me/plan", provider);
  assert.deepEqual(response.body.featureOverrides, {});
});
