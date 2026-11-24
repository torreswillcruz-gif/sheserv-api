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
    ]);
  });

  test("a subscription changes the provider's plan right away (no gateway yet)", async () => {
    const response = await buy({ storeProductId: "subscription-pro", purchaseKind: "subscription", plan: "Pro" });

    assert.equal(response.status, 201);
    assert.equal(response.body.status, "active");
    assert.equal(response.body.plan.planCode, "pro");
    assert.equal(response.body.plan.monthlyApprovalLimit, 100);

    const purchaseUpdate = queriesMatching(/^UPDATE plan_purchases SET status='active',paid_at=now\(\)/)[0];
    assert.equal(purchaseUpdate.params[0], PURCHASE_ID);
    // Sem gateway, nenhum dado de transação é inventado.
    assert.deepEqual(purchaseUpdate.params.slice(1), [null, null, null]);

    const planUpsert = queriesMatching(/^INSERT INTO provider_plans/)[0];
    assert.deepEqual(planUpsert.params, [PROVIDER_ID, "pro", 100]);
    assert.match(planUpsert.sql, /ON CONFLICT \(provider_id\) DO UPDATE/);
  });

  test("a plan without a fixed limit keeps the limit empty", async () => {
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
