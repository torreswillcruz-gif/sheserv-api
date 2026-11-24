// Push pelo FCM com uma conta de serviço de teste e o fetch simulado.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { beforeEach, describe, test } = require("node:test");

const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
  project_id: "sheserv",
  client_email: "push@sheserv.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
});

const { isPushEnabled, sendPush } = require("../src/push");

let calls;
let fcmResponses;
global.fetch = async (url, options) => {
  calls.push({ url, options });
  if (url.startsWith("https://oauth2.googleapis.com/token"))
    return new Response(JSON.stringify({ access_token: "oauth-token", expires_in: 3600 }), { status: 200 });
  const next = fcmResponses.shift() ?? { status: 200, body: "{}" };
  return new Response(next.body, { status: next.status });
};

const fakeDatabase = (tokens) => {
  const log = [];
  return {
    log,
    query: async (sql, params) => {
      log.push({ sql, params });
      return /^SELECT token/.test(sql) ? { rows: tokens.map((token) => ({ token })) } : { rows: [] };
    },
  };
};

beforeEach(() => {
  calls = [];
  fcmResponses = [];
});

describe("sendPush", () => {
  test("is enabled by the service account variable", () => {
    assert.equal(isPushEnabled(), true);
  });

  test("sends the notification to every device of the user with string data", async () => {
    const database = fakeDatabase(["token-a", "token-b"]);
    const result = await sendPush(database, "user-1", {
      type: "order_accepted", title: "Pedido aceito", body: "Carla aceitou.", data: { orderId: "o1" }, area: "customer",
    });
    assert.equal(result.sent, 2);
    const fcmCalls = calls.filter(({ url }) => url.includes("fcm.googleapis.com"));
    assert.equal(fcmCalls.length, 2);
    assert.equal(fcmCalls[0].url, "https://fcm.googleapis.com/v1/projects/sheserv/messages:send");
    assert.equal(fcmCalls[0].options.headers.authorization, "Bearer oauth-token");
    const { message } = JSON.parse(fcmCalls[0].options.body);
    assert.equal(message.token, "token-a");
    assert.deepEqual(message.notification, { title: "Pedido aceito", body: "Carla aceitou." });
    assert.deepEqual(message.data, { type: "order_accepted", area: "customer", orderId: "o1" });
  });

  test("reuses the OAuth token between sends", async () => {
    await sendPush(fakeDatabase(["token-a"]), "user-1", { type: "t", title: "A" });
    await sendPush(fakeDatabase(["token-a"]), "user-1", { type: "t", title: "B" });
    // No máximo uma troca de token para os dois envios (pode já estar em cache)
    assert.ok(calls.filter(({ url }) => url.includes("oauth2")).length <= 1);
  });

  test("deletes tokens that FCM reports as unregistered", async () => {
    fcmResponses = [{ status: 404, body: JSON.stringify({ error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }) }];
    const database = fakeDatabase(["old-token"]);
    const result = await sendPush(database, "user-1", { type: "t", title: "A" });
    assert.equal(result.sent, 0);
    const deletion = database.log.find(({ sql }) => /^DELETE FROM device_tokens/.test(sql));
    assert.deepEqual(deletion.params, ["old-token"]);
  });

  test("does nothing when the user has no devices", async () => {
    const result = await sendPush(fakeDatabase([]), "user-1", { type: "t", title: "A" });
    assert.equal(result.sent, 0);
    assert.equal(calls.length, 0);
  });
});
