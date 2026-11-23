const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { after, before, beforeEach, describe, test } = require("node:test");
const jsonWebToken = require("jsonwebtoken");
const { resetDatabase, queriesMatching, startServer } = require("./helpers/testApp");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const SERVICE_ID = "99999999-9999-4999-8999-999999999999";
const REQUEST_ID = "55555555-5555-4555-8555-555555555555";

const customerOnly = { userId: USER_ID, roles: ["cliente"] };
const providerOnly = { userId: USER_ID, roles: ["prestadora"] };
const bothRoles = { userId: USER_ID, roles: ["cliente", "prestadora"] };
const inDays = (days) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

let server;
before(async () => { server = await startServer(); });
after(async () => { await server.close(); });

describe("POST /auth/roles", () => {
  let storedRoles;

  beforeEach(() => {
    storedRoles = ["cliente"];
    resetDatabase([
      { pattern: /^SELECT id,name,email,roles FROM users WHERE id=\$1 FOR UPDATE/, rows: () => [{
        id: USER_ID, name: "Ana", email: "ana@example.com", roles: storedRoles,
      }] },
      { pattern: /^UPDATE users SET roles=array_append/, rows: (params) => [{ roles: [...storedRoles, params[1]] }] },
    ]);
  });

  const enableRole = (body, user = customerOnly) =>
    server.call("POST", "/api/v1/auth/roles", { ...user, body });

  test("a customer becomes a provider with a pending profile and a fresh session", async () => {
    const response = await enableRole({ role: "prestadora", providerProfile: { bio: "Manicure" } });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.user.roles, ["cliente", "prestadora"]);
    const token = jsonWebToken.decode(response.body.accessToken);
    assert.deepEqual(token.roles, ["cliente", "prestadora"]);
    assert.ok(response.body.refreshToken);

    const profileInsert = queriesMatching(/^INSERT INTO provider_profiles/)[0];
    assert.deepEqual(profileInsert.params, [USER_ID, "Manicure"]);
    assert.match(profileInsert.sql, /ON CONFLICT \(user_id\) DO NOTHING/);
  });

  test("a provider becomes a customer without creating a provider profile", async () => {
    storedRoles = ["prestadora"];
    const response = await enableRole({ role: "cliente" }, providerOnly);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.user.roles, ["prestadora", "cliente"]);
    assert.equal(queriesMatching(/^INSERT INTO provider_profiles/).length, 0);
  });

  test("enabling a role the account already has is idempotent", async () => {
    const response = await enableRole({ role: "cliente" });
    assert.equal(response.status, 200);
    assert.equal(queriesMatching(/^UPDATE users SET roles/).length, 0);
  });

  test("revokes the previous refresh token of the same user", async () => {
    const previousRefreshToken = "previous-refresh-token-value";
    await enableRole({ role: "prestadora", refreshToken: previousRefreshToken });
    const revoke = queriesMatching(/^UPDATE refresh_tokens SET revoked=true WHERE token_hash/)[0];
    const expectedHash = crypto.createHash("sha256").update(previousRefreshToken).digest("hex");
    assert.deepEqual(revoke.params, [expectedHash, USER_ID]);
  });

  test("admin cannot be self-granted", async () => {
    const response = await enableRole({ role: "admin" });
    assert.equal(response.status, 422);
    assert.equal(queriesMatching(/^UPDATE users/).length, 0);
  });

  test("requires authentication", async () => {
    const response = await server.call("POST", "/api/v1/auth/roles", { body: { role: "prestadora" } });
    assert.equal(response.status, 401);
  });
});

describe("GET /requests view", () => {
  beforeEach(() => resetDatabase());

  const listRequests = (user, view) =>
    server.call("GET", `/api/v1/requests${view ? `?as=${view}` : ""}`, user);
  const listedBy = () => queriesMatching(/FROM service_requests r/)[0];

  test("an account with both roles sees its own requests as a customer", async () => {
    const response = await listRequests(bothRoles, "customer");
    assert.equal(response.status, 200);
    assert.match(listedBy().sql, /WHERE r\.customer_id=\$1/);
    assert.equal(listedBy().params[1], "customer");
  });

  test("an account with both roles sees the provider queue, excluding its own public requests", async () => {
    await listRequests(bothRoles, "provider");
    assert.match(listedBy().sql, /WHERE r\.provider_id=\$1/);
    assert.match(listedBy().sql, /r\.customer_id<>\$1/);
  });

  test("defaults to the provider view for providers (previous behaviour)", async () => {
    await listRequests(providerOnly);
    assert.equal(listedBy().params[1], "provider");
  });

  test("refuses a view for a role the account does not have", async () => {
    assert.equal((await listRequests(customerOnly, "provider")).status, 403);
    assert.equal((await listRequests(providerOnly, "customer")).status, 403);
  });
});

describe("self-dealing is blocked", () => {
  test("booking your own service", async () => {
    resetDatabase([
      { pattern: /^SELECT service\.\*, provider_profile\.activation_status/, rows: [{
        id: SERVICE_ID, provider_id: USER_ID, base_price: "100.00", duration_minutes: 60,
        service_location: "at_provider", activation_status: "active",
      }] },
    ]);
    const response = await server.call("POST", "/api/v1/orders", {
      ...bothRoles,
      body: { serviceId: SERVICE_ID, scheduledAt: inDays(1), paymentMethod: { type: "pix" } },
    });
    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, "self_dealing");
    assert.equal(queriesMatching(/^INSERT INTO orders/).length, 0);
  });

  test("requesting a quote from yourself", async () => {
    resetDatabase();
    const response = await server.call("POST", "/api/v1/requests", {
      ...bothRoles,
      body: { providerId: USER_ID, description: "Preciso de uma manicure em casa" },
    });
    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, "self_dealing");
  });

  test("quoting your own request", async () => {
    resetDatabase([
      { pattern: /^SELECT \* FROM service_requests WHERE id=\$1 FOR UPDATE/, rows: [{
        id: REQUEST_ID, status: "open", provider_id: null, customer_id: USER_ID,
      }] },
    ]);
    const response = await server.call("POST", `/api/v1/requests/${REQUEST_ID}/quotes`, {
      ...bothRoles,
      body: { totalAmount: 100, validUntil: inDays(3), items: [{ description: "Serviço", unitPrice: 100 }] },
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "self_dealing");
    assert.equal(queriesMatching(/^INSERT INTO quotes/).length, 0);
  });

  test("another provider can still quote the request", async () => {
    resetDatabase([
      { pattern: /^SELECT \* FROM service_requests WHERE id=\$1 FOR UPDATE/, rows: [{
        id: REQUEST_ID, status: "open", provider_id: null, customer_id: OTHER_USER_ID,
      }] },
      { pattern: /^SELECT count\(\*\)::int AS total FROM quotes/, rows: [{ total: 0 }] },
      { pattern: /^SELECT monthly_approval_limit/, rows: [{ monthly_approval_limit: 20 }] },
      { pattern: /^INSERT INTO monthly_approval_usage/, rows: [{ approved_count: 0, reserved_count: 0 }] },
      { pattern: /^INSERT INTO quotes/, rows: [{ id: "q" }] },
    ]);
    const response = await server.call("POST", `/api/v1/requests/${REQUEST_ID}/quotes`, {
      ...bothRoles,
      body: { totalAmount: 100, validUntil: inDays(3), items: [{ description: "Serviço", unitPrice: 100 }] },
    });
    assert.equal(response.status, 201);
  });
});
