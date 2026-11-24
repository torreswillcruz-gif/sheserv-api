const assert = require("node:assert/strict");
const { after, before, beforeEach, describe, test } = require("node:test");

process.env.JWT_SECRET = "test-secret-with-more-than-thirty-two-characters";
process.env.MARKETPLACE_API_URL = "http://marketplace.test";

// Banco falso: responde se o usuário é admin
const database = require("../src/db");
let adminIds = new Set();
database.runQuery = async (_sql, [userId]) => ({ rows: adminIds.has(userId) ? [{ "?column?": 1 }] : [] });

// API principal falsa: intercepta só as chamadas para MARKETPLACE_API_URL
const realFetch = globalThis.fetch;
let upstreamCalls = [];
let upstreamHandler;
globalThis.fetch = async (url, options) => {
  const target = String(url);
  if (!target.startsWith(process.env.MARKETPLACE_API_URL)) return realFetch(url, options);
  upstreamCalls.push({ path: new URL(target).pathname, body: JSON.parse(options.body) });
  return upstreamHandler(new URL(target).pathname);
};

const app = require("../src/app");

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sessionPayload = {
  accessToken: "access-token",
  refreshToken: "refresh-token-value",
  user: { id: ADMIN_ID, name: "Admin", email: "admin@example.test", roles: ["cliente", "admin"] },
};
const jsonResponse = (status, body) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let server;
let baseUrl;
before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  adminIds = new Set([ADMIN_ID]);
  upstreamCalls = [];
  upstreamHandler = (path) => {
    if (path === "/api/v1/auth/logout") return jsonResponse(204, null);
    return jsonResponse(200, sessionPayload);
  };
});

const post = (path, body) =>
  realFetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }));

describe("POST /api/v1/admin/session", () => {
  test("an admin signs in through the marketplace API", async () => {
    const response = await post("/api/v1/admin/session", { email: "Admin@Example.test", password: "secret" });
    assert.equal(response.status, 200);
    assert.equal(response.body.accessToken, "access-token");
    assert.equal(response.body.refreshToken, "refresh-token-value");
    assert.deepEqual(response.body.user, { id: ADMIN_ID, name: "Admin", email: "admin@example.test" });
    assert.deepEqual(upstreamCalls, [{
      path: "/api/v1/auth/sessions",
      body: { email: "admin@example.test", password: "secret" },
    }]);
  });

  test("a non-admin account is refused and its new session is closed", async () => {
    adminIds = new Set();
    const response = await post("/api/v1/admin/session", { email: "user@example.test", password: "secret" });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "forbidden");
    assert.equal(response.body.accessToken, undefined);
    assert.deepEqual(upstreamCalls.map((call) => call.path), ["/api/v1/auth/sessions", "/api/v1/auth/logout"]);
    assert.deepEqual(upstreamCalls[1].body, { refreshToken: "refresh-token-value" });
  });

  test("wrong credentials", async () => {
    upstreamHandler = () => jsonResponse(401, { error: { code: "invalid_credentials" } });
    const response = await post("/api/v1/admin/session", { email: "admin@example.test", password: "wrong" });
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, "invalid_credentials");
  });

  test("marketplace API unavailable", async () => {
    upstreamHandler = () => { throw new TypeError("fetch failed"); };
    const response = await post("/api/v1/admin/session", { email: "admin@example.test", password: "secret" });
    assert.equal(response.status, 502);
    assert.equal(response.body.error.code, "upstream_unavailable");
  });
});

describe("session refresh and logout", () => {
  test("refresh keeps an admin signed in", async () => {
    const response = await post("/api/v1/admin/session/refresh", { refreshToken: "refresh-token-value" });
    assert.equal(response.status, 200);
    assert.equal(upstreamCalls[0].path, "/api/v1/auth/refresh");
  });

  test("refresh is refused after the admin role is revoked", async () => {
    adminIds = new Set();
    const response = await post("/api/v1/admin/session/refresh", { refreshToken: "refresh-token-value" });
    assert.equal(response.status, 403);
  });

  test("an expired refresh token asks for a new login", async () => {
    upstreamHandler = () => jsonResponse(401, { error: { code: "unauthorized" } });
    const response = await post("/api/v1/admin/session/refresh", { refreshToken: "refresh-token-value" });
    assert.equal(response.status, 401);
  });

  test("logout revokes the refresh token", async () => {
    const response = await post("/api/v1/admin/session/logout", { refreshToken: "refresh-token-value" });
    assert.equal(response.status, 204);
    assert.deepEqual(upstreamCalls, [{ path: "/api/v1/auth/logout", body: { refreshToken: "refresh-token-value" } }]);
  });
});

describe("admin panel page", () => {
  test("is served at /admin/ with a strict CSP", async () => {
    const response = await realFetch(`${baseUrl}/admin/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Aprovação de prestadoras/);
    const csp = response.headers.get("content-security-policy");
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /upgrade-insecure-requests/);
  });

  test("the root redirects to the panel", async () => {
    const response = await realFetch(`${baseUrl}/`, { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/admin/");
  });

  test("admin data routes still require an admin token", async () => {
    const response = await realFetch(`${baseUrl}/api/v1/admin/providers`);
    assert.equal(response.status, 401);
  });
});
