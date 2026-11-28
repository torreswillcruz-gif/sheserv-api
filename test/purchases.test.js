const assert = require("node:assert/strict");
const { after, before, beforeEach, describe, test } = require("node:test");
const { resetDatabase, queriesMatching, startServer } = require("./helpers/testApp");

const PROVIDER_ID = "11111111-1111-4111-8111-111111111111";
const PURCHASE_ID = "77777777-7777-4777-8777-777777777777";
const provider = { userId: PROVIDER_ID, roles: ["prestadora"] };

let server;
before(async () => { server = await startServer(); });
after(async () => { await server.close(); });

const buy = (body) => server.call("POST", "/api/v1/me/purchases", { ...provider, body });

describe("POST /me/purchases", () => {
  let activePlans;

  beforeEach(() => {
    activePlans = { pro: 100, premium: null };
    resetDatabase([
      { pattern: /^INSERT INTO plan_purchases/, rows: (params) => [{
        id: PURCHASE_ID, provider_id: params[0], purchase_kind: params[2], plan_name: params[4], status: params[5],
      }] },
      { pattern: /^SELECT plan_code,monthly_approval_limit FROM plan_catalog/, rows: (params) =>
        params[0] in activePlans ? [{ plan_code: params[0], monthly_approval_limit: activePlans[params[0]] }] : [] },
      { pattern: /^INSERT INTO provider_plans/, rows: (params) => [{
        planCode: params[1], monthlyApprovalLimit: params[2], renewalAt: "2026-12-01T00:00:00.000Z",
      }] },
      // camadas do módulo de pagamentos
      { pattern: /^SELECT monthly_approval_limit FROM plan_catalog WHERE plan_code=\$1 AND active/, rows: (params) =>
        params[0] in activePlans ? [{ monthly_approval_limit: activePlans[params[0]] }] : [] },
      { pattern: /^SELECT plan_name, tier_billed_until FROM provider_plans/, rows: () => [{ plan_name: "pro", tier_billed_until: null }] },
      { pattern: /^SELECT plan_name AS "planCode"/, rows: () => [{ planCode: "pro", monthlyApprovalLimit: 100 }] },
      { pattern: /FROM payment_settings WHERE scope_key = 'global'/, rows: () => [{
        scope_key: "global", version: 1, pro_price_cents: 5990, standard_price_cents: 2990, fee_fixed_cents: 99,
      }] },
    ]);
  });

  test("Free/Standard/Pro muda a camada na hora e a mensalidade vira desconto nos repasses", async () => {
    const response = await buy({ storeProductId: "subscription-pro", purchaseKind: "subscription", plan: "Pro" });

    assert.equal(response.status, 201);
    assert.equal(response.body.status, "active");
    assert.equal(response.body.plan.planCode, "pro");

    const planUpsert = queriesMatching(/^INSERT INTO provider_plans/)[0];
    assert.deepEqual(planUpsert.params.slice(0, 3), [PROVIDER_ID, "pro", 100]);
    assert.match(planUpsert.sql, /tier_changed_at/);
    // Nunca cobrada antes: entra como desconto de repasse com o preço da configuração
    const deduction = queriesMatching(/^INSERT INTO provider_deductions/)[0];
    assert.equal(deduction.params[0], PROVIDER_ID);
    assert.equal(deduction.params[2], 5990);
    assert.match(deduction.params[4], /^camada:pro:/);
    assert.equal(queriesMatching(/^UPDATE plan_purchases SET status='active',paid_at=now\(\) WHERE id=\$1/)[0].params[0], PURCHASE_ID);
  });

  test("Premium (legado) continua pelo caminho antigo", async () => {
    const response = await buy({ storeProductId: "subscription-premium", purchaseKind: "subscription", plan: "premium" });
    assert.equal(response.status, 201);
    assert.deepEqual(queriesMatching(/^INSERT INTO provider_plans/)[0].params, [PROVIDER_ID, "premium", null]);
  });

  test("an inactive plan is refused and nothing changes", async () => {
    delete activePlans.pro;
    const response = await buy({ storeProductId: "subscription-pro", purchaseKind: "subscription", plan: "pro" });

    assert.equal(response.status, 404);
    assert.equal(queriesMatching(/^INSERT INTO provider_plans/).length, 0);
    assert.equal(queriesMatching(/^UPDATE plan_purchases/).length, 0);
  });

  test("a subscription without a plan is a validation error", async () => {
    const response = await buy({ storeProductId: "subscription", purchaseKind: "subscription" });
    assert.equal(response.status, 422);
    assert.equal(queriesMatching(/^INSERT INTO plan_purchases/).length, 0);
  });

  test("other purchase kinds do not touch the plan", async () => {
    const response = await buy({ storeProductId: "pack-10", purchaseKind: "approval_pack", quantity: 10 });

    assert.equal(response.status, 201);
    assert.equal(response.body.status, "active");
    assert.equal(queriesMatching(/^INSERT INTO provider_plans/).length, 0);
  });

  test("customers cannot buy plans", async () => {
    const response = await server.call("POST", "/api/v1/me/purchases", {
      userId: PROVIDER_ID, roles: ["cliente"],
      body: { storeProductId: "subscription-pro", purchaseKind: "subscription", plan: "pro" },
    });
    assert.equal(response.status, 403);
  });
});
