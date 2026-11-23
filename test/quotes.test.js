const assert = require("node:assert/strict");
const { after, before, beforeEach, describe, test } = require("node:test");
const { resetDatabase, queriesMatching, startServer, approvedProviderRule } = require("./helpers/testApp");

const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const PROVIDER_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_PROVIDER_ID = "33333333-3333-4333-8333-333333333333";
const THIRD_PROVIDER_ID = "44444444-4444-4444-8444-444444444444";
const REQUEST_ID = "55555555-5555-4555-8555-555555555555";
const QUOTE_ID = "66666666-6666-4666-8666-666666666666";
const COMPETING_OPEN_ID = "77777777-7777-4777-8777-777777777777";
const COMPETING_COUNTERED_ID = "88888888-8888-4888-8888-888888888888";
const SERVICE_ID = "99999999-9999-4999-8999-999999999999";
const ORDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const CURRENT_PERIOD = new Date().toISOString().slice(0, 7);
const inDays = (days) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

const customer = { userId: CUSTOMER_ID, roles: ["cliente"] };
const provider = { userId: PROVIDER_ID, roles: ["prestadora"] };

function quoteRow(overrides = {}) {
  return {
    id: QUOTE_ID,
    request_id: REQUEST_ID,
    provider_id: PROVIDER_ID,
    customer_id: CUSTOMER_ID,
    status: "open",
    total_amount: "250.00",
    valid_until: inDays(3),
    reserved_quota: true,
    quota_period: "2026-10",
    ...overrides,
  };
}

let server;
before(async () => { server = await startServer(); });
after(async () => { await server.close(); });

describe("POST /quotes/:id/approve", () => {
  let quote;
  let competingQuotes;

  beforeEach(() => {
    quote = quoteRow();
    competingQuotes = [
      quoteRow({ id: COMPETING_OPEN_ID, provider_id: OTHER_PROVIDER_ID, status: "open", quota_period: "2026-10" }),
      quoteRow({ id: COMPETING_COUNTERED_ID, provider_id: THIRD_PROVIDER_ID, status: "countered", quota_period: null }),
    ];
    resetDatabase([
      { pattern: /^SELECT \* FROM quotes WHERE id=\$1/, rows: () => [quote] },
      { pattern: /^SELECT \* FROM quotes WHERE request_id=\$1 AND id<>\$2/, rows: () => competingQuotes },
      { pattern: /^SELECT \* FROM service_requests WHERE id=\$1/, rows: [{ id: REQUEST_ID, service_id: SERVICE_ID, address_id: null }] },
      { pattern: /^SELECT service\.\* FROM services service/, rows: [{ id: SERVICE_ID, service_location: "at_provider", duration_minutes: 60 }] },
      { pattern: /^INSERT INTO orders/, rows: [{ id: ORDER_ID }] },
    ]);
  });

  const approve = () => server.call("POST", `/api/v1/quotes/${QUOTE_ID}/approve`, {
    ...customer,
    body: { scheduledAt: inDays(2) },
  });

  test("approves a quote that is under negotiation (countered)", async () => {
    quote = quoteRow({ status: "countered" });
    const response = await approve();
    assert.equal(response.status, 200);
    assert.equal(response.body.orderId, ORDER_ID);
    assert.equal(queriesMatching(/^UPDATE quotes SET status='approved'/).length, 1);
  });

  test("rejects every competing open or countered quote", async () => {
    await approve();
    const statusFilter = queriesMatching(/^SELECT \* FROM quotes WHERE request_id=\$1/)[0];
    assert.deepEqual(statusFilter.params[2], ["open", "countered"]);
    const rejectedIds = queriesMatching(/^UPDATE quotes SET status='rejected'/).map((entry) => entry.params[0]);
    assert.deepEqual(rejectedIds, [COMPETING_OPEN_ID, COMPETING_COUNTERED_ID]);
  });

  test("returns the reserved quota of each competing provider in its own period", async () => {
    await approve();
    const releases = queriesMatching(/^UPDATE monthly_approval_usage SET reserved_count=GREATEST/)
      .map((entry) => entry.params);
    assert.deepEqual(releases, [
      [OTHER_PROVIDER_ID, "2026-10"],
      [THIRD_PROVIDER_ID, CURRENT_PERIOD],
    ]);
  });

  test("turns the approved quote's reservation into an approval in the reserved period", async () => {
    await approve();
    const approvals = queriesMatching(/^UPDATE monthly_approval_usage SET approved_count=approved_count\+1/);
    assert.deepEqual(approvals.map((entry) => entry.params), [[PROVIDER_ID, "2026-10"]]);
  });

  test("does not count an approval when the quote held no reservation", async () => {
    quote = quoteRow({ reserved_quota: false });
    await approve();
    assert.equal(queriesMatching(/^UPDATE monthly_approval_usage SET approved_count/).length, 0);
  });

  for (const closedStatus of ["approved", "rejected", "expired", "cancelled"]) {
    test(`refuses a quote that is already ${closedStatus}`, async () => {
      quote = quoteRow({ status: closedStatus });
      const response = await approve();
      assert.equal(response.status, 409);
      assert.equal(response.body.error.code, "invalid_transition");
    });
  }

  test("refuses a quote past its validity", async () => {
    quote = quoteRow({ valid_until: inDays(-1) });
    const response = await approve();
    assert.equal(response.status, 409);
  });

  test("refuses a quote that belongs to another customer", async () => {
    quote = quoteRow({ customer_id: OTHER_PROVIDER_ID });
    const response = await approve();
    assert.equal(response.status, 403);
  });
});

describe("POST /quotes/:id/reject", () => {
  let quote;

  beforeEach(() => {
    quote = quoteRow({ status: "countered", quota_period: "2026-09" });
    resetDatabase([{ pattern: /^SELECT \* FROM quotes WHERE id=\$1 FOR UPDATE/, rows: () => [quote] }]);
  });

  const reject = (user = customer) => server.call("POST", `/api/v1/quotes/${QUOTE_ID}/reject`, user);

  test("rejects the quote and returns the quota to the period it was reserved in", async () => {
    const response = await reject();
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { id: QUOTE_ID, status: "rejected" });
    const releases = queriesMatching(/^UPDATE monthly_approval_usage SET reserved_count=GREATEST/);
    assert.deepEqual(releases.map((entry) => entry.params), [[PROVIDER_ID, "2026-09"]]);
    assert.equal(queriesMatching(/^UPDATE quotes SET reserved_quota=false/).length, 1);
  });

  test("does not release quota twice when nothing is reserved", async () => {
    quote = quoteRow({ reserved_quota: false });
    await reject();
    assert.equal(queriesMatching(/^UPDATE monthly_approval_usage/).length, 0);
  });

  test("refuses an already approved quote", async () => {
    quote = quoteRow({ status: "approved" });
    const response = await reject();
    assert.equal(response.status, 409);
    assert.equal(queriesMatching(/^UPDATE quotes/).length, 0);
  });

  test("refuses a customer who does not own the quote", async () => {
    const response = await reject({ userId: OTHER_PROVIDER_ID, roles: ["cliente"] });
    assert.equal(response.status, 403);
  });
});

describe("POST /requests/:id/quotes", () => {
  let usage;

  beforeEach(() => {
    usage = { approved_count: 0, reserved_count: 0 };
    resetDatabase([
      approvedProviderRule,
      { pattern: /^SELECT \* FROM service_requests WHERE id=\$1 FOR UPDATE/, rows: [{ id: REQUEST_ID, status: "open", provider_id: null, customer_id: CUSTOMER_ID }] },
      { pattern: /^SELECT count\(\*\)::int AS total FROM quotes/, rows: [{ total: 0 }] },
      { pattern: /^SELECT monthly_approval_limit FROM plan_catalog/, rows: [{ monthly_approval_limit: 20 }] },
      { pattern: /^INSERT INTO monthly_approval_usage/, rows: () => [usage] },
      { pattern: /^INSERT INTO quotes/, rows: [quoteRow()] },
    ]);
  });

  const sendQuote = () => server.call("POST", `/api/v1/requests/${REQUEST_ID}/quotes`, {
    ...provider,
    body: { totalAmount: 250, validUntil: inDays(5), items: [{ description: "Serviço", unitPrice: 250 }] },
  });

  test("stores the period in which the quota was reserved", async () => {
    const response = await sendQuote();
    assert.equal(response.status, 201);
    const insert = queriesMatching(/^INSERT INTO quotes/)[0];
    assert.equal(insert.params[6], CURRENT_PERIOD);
    assert.equal(queriesMatching(/^UPDATE monthly_approval_usage SET reserved_count=reserved_count\+1/).length, 1);
  });

  test("refuses when approvals plus reservations reach the plan limit", async () => {
    usage = { approved_count: 15, reserved_count: 5 };
    const response = await sendQuote();
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "quota_limit");
    assert.equal(queriesMatching(/^INSERT INTO quotes/).length, 0);
  });
});
