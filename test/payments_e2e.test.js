// Ponta a ponta do módulo de pagamentos contra um PostgreSQL real, com a API
// de verdade e o MockGateway entregando webhooks por HTTP.
// Só roda com PAYMENTS_E2E_DATABASE_URL (banco descartável: o teste grava dados).
//   PAYMENTS_E2E_DATABASE_URL=postgres://... node --test test/payments_e2e.test.js
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { after, before, describe, test } = require("node:test");

const DATABASE_URL = process.env.PAYMENTS_E2E_DATABASE_URL;

describe("pagamentos ponta a ponta (PostgreSQL real)", { skip: !DATABASE_URL && "defina PAYMENTS_E2E_DATABASE_URL" }, () => {
  let server;
  let baseUrl;
  let db;
  let jwt;
  let originalSettings;
  const ids = {};

  const token = (userId, roles) => jwt.sign({ sub: userId, roles }, process.env.JWT_SECRET, { algorithm: "HS256", issuer: "sheserv-api", expiresIn: "10m" });

  async function call(method, path, { as, body, headers = {} } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(as ? { authorization: `Bearer ${token(as.id, as.roles)}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  // Espera o gateway liquidar e o webhook ser processado
  async function waitFor(check, label) {
    const { gateway } = require("../src/payments/runtime");
    for (let attempt = 0; attempt < 100; attempt++) {
      await gateway().pump();
      const value = await check();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Tempo esgotado esperando: ${label}`);
  }

  // CPF válido aleatório (o teste pode rodar várias vezes no mesmo banco)
  function randomCpf() {
    const digits = Array.from({ length: 9 }, () => crypto.randomInt(10));
    for (const length of [9, 10]) {
      const sum = digits.reduce((total, digit, index) => total + digit * (length + 1 - index), 0);
      const rest = (sum * 10) % 11;
      digits.push(rest === 10 ? 0 : rest);
    }
    return digits.join("");
  }

  const one = async (sql, params) => (await db.runQuery(sql, params)).rows[0];

  async function createUser(name, roles) {
    const id = crypto.randomUUID();
    const suffix = id.slice(0, 8);
    await db.runQuery(
      "INSERT INTO users (id,name,email,phone,password_hash,roles) VALUES ($1,$2,$3,$4,'x',$5)",
      [id, name, `${suffix}@e2e.test`, `+5535${String(parseInt(suffix, 16)).padStart(9, "0").slice(0, 9)}`, roles]
    );
    await db.runQuery("INSERT INTO verifications (user_id,type,result) VALUES ($1,'cpf_selfie','approved')", [id]);
    return { id, roles };
  }

  before(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.JWT_SECRET ||= "e2e-jwt-secret-with-more-than-thirty-two-chars";
    process.env.DATA_ENCRYPTION_KEY ||= "e2e-encryption-key-with-more-than-32-chars";
    process.env.PAYMENT_GATEWAY = "mock";
    jwt = require("jsonwebtoken");
    db = require("../src/db");
    await db.runMigrations();
    const app = require("../src/app");
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    process.env.PAYMENT_WEBHOOK_URL = `${baseUrl}/webhooks/payments`;
    // mock rápido e sem recusa aleatória; Free com 1 vaga para testar o limite
    // (restaurado no fim: o banco pode ser o da demonstração)
    originalSettings = (await db.runQuery(
      "SELECT mock_latency_ms, mock_failure_rate_bps, free_max_active_subscribers, retry_max_attempts FROM payment_settings WHERE scope_key='global'"
    )).rows[0];
    await db.runQuery(
      "UPDATE payment_settings SET mock_latency_ms=30, mock_failure_rate_bps=0, free_max_active_subscribers=1, retry_max_attempts=2 WHERE scope_key='global'"
    );

    ids.provider = await createUser("Prestadora E2E", ["prestadora"]);
    ids.customer = await createUser("Cliente E2E", ["cliente"]);
    ids.customer2 = await createUser("Cliente E2E 2", ["cliente"]);
    await db.runQuery("INSERT INTO provider_profiles (user_id,activation_status,verified,available) VALUES ($1,'active',true,true)", [ids.provider.id]);
    await db.runQuery(
      `INSERT INTO provider_venues (provider_id,street,number,neighborhood,city,state,postal_code,latitude,longitude)
       VALUES ($1,'Rua A','10','Centro','Guaxupé','MG','37800000',-21.3,-46.7)`,
      [ids.provider.id]
    );
    await db.runQuery("INSERT INTO categories (id,name) VALUES ('beauty','Beleza') ON CONFLICT DO NOTHING");
    const service = await one(
      `INSERT INTO services (provider_id,category_id,title,base_price,duration_minutes,service_location,price_type,availability)
       VALUES ($1,'beauty','Escova',20.00,60,'at_provider','fixed','[]') RETURNING id`,
      [ids.provider.id]
    );
    ids.serviceId = service.id;
  });

  after(async () => {
    if (db && originalSettings) {
      await db.runQuery(
        `UPDATE payment_settings SET mock_latency_ms=$1, mock_failure_rate_bps=$2, free_max_active_subscribers=$3, retry_max_attempts=$4
         WHERE scope_key='global'`,
        [originalSettings.mock_latency_ms, originalSettings.mock_failure_rate_bps,
         originalSettings.free_max_active_subscribers, originalSettings.retry_max_attempts]
      );
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    if (db) await db.connectionPool.end();
  });

  test("prestadora cadastra a conta e o recebedor é aprovado por webhook", async () => {
    const response = await call("PUT", "/api/v1/me/payments/account", {
      as: ids.provider,
      body: {
        holderName: "Prestadora E2E", holderDocument: randomCpf(), bankCode: "260", branch: "0001",
        account: "12345-6", accountType: "corrente", cityCode: "3128709",
      },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    await waitFor(async () => (await one("SELECT status FROM provider_payment_accounts WHERE provider_id=$1", [ids.provider.id]))?.status === "aprovada", "recebedor aprovado");
    const overview = await call("GET", "/api/v1/me/payments/overview", { as: ids.provider });
    assert.equal(overview.body.eligibility.eligible, true, JSON.stringify(overview.body.eligibility));
    assert.deepEqual(overview.body.seats, { used: 0, limit: 1, full: false });
  });

  test("cotação ao vivo: 3000 → cliente paga 3219, prestadora recebe 3000", async () => {
    const response = await call("POST", "/api/v1/me/payments/quote", {
      as: ids.provider, body: { priceCents: 3000, items: [{ serviceId: ids.serviceId, sessionsPerCycle: 2 }] },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.customerPaysCents, 3219);
    assert.equal(response.body.providerReceivesCents, 3000);
    // avulso: 2 × (2000 + 99 + 80) = 4358
    assert.equal(response.body.avulsoCents, 4358);
    assert.equal(response.body.savingsCents, 4358 - 3219);
  });

  test("plano mais caro que o avulso é recusado; plano válido é criado", async () => {
    const pricey = await call("POST", "/api/v1/me/payments/plans", {
      as: ids.provider, body: { name: "Caro", priceCents: 5000, items: [{ serviceId: ids.serviceId, sessionsPerCycle: 2 }] },
    });
    assert.equal(pricey.status, 422);
    assert.equal(pricey.body.error.code, "plan_pricier_than_avulso");
    const created = await call("POST", "/api/v1/me/payments/plans", {
      as: ids.provider, body: { name: "Escova 2x", priceCents: 3000, items: [{ serviceId: ids.serviceId, sessionsPerCycle: 2 }], reservedSlot: "Sábados às 9h" },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    ids.planId = created.body.plan.id;
  });

  test("checkout exige cadastro completo da cliente e mostra um total único", async () => {
    const blocked = await call("POST", "/api/v1/subscriptions", {
      as: ids.customer, headers: { "Idempotency-Key": "e2e-blocked-0001" },
      body: { planId: ids.planId, card: { token: "tok_mock_aprovar", last4: "4242" } },
    });
    assert.equal(blocked.status, 422);
    assert.equal(blocked.body.error.code, "customer_profile_incomplete");

    for (const customer of [ids.customer, ids.customer2]) {
      const profile = await call("PUT", "/api/v1/me/customer-profile", {
        as: customer,
        body: {
          cpf: randomCpf(),
          address: { street: "Rua B", number: "20", neighborhood: "Centro", city: "Guaxupé", state: "MG", postalCode: "37800-000" },
        },
      });
      assert.equal(profile.status, 200, JSON.stringify(profile.body));
      assert.equal(profile.body.complete, true);
    }
    const checkout = await call("GET", `/api/v1/subscription-plans/${ids.planId}/checkout`, { as: ids.customer });
    assert.equal(checkout.status, 200);
    assert.equal(checkout.body.totalCents, 3219);
    assert.equal(checkout.body.reservedSlot, "Sábados às 9h");
    assert.ok(!("feeCents" in checkout.body), "a taxa nunca aparece como linha separada");
  });

  test("assinar sem Idempotency-Key é recusado", async () => {
    const response = await call("POST", "/api/v1/subscriptions", {
      as: ids.customer, body: { planId: ids.planId, card: { token: "tok_mock_aprovar" } },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "idempotency_key_required");
  });

  test("mesma chave duas vezes = uma assinatura e uma cobrança; webhook ativa e libera as sessões", async () => {
    const request = () => call("POST", "/api/v1/subscriptions", {
      as: ids.customer, headers: { "Idempotency-Key": "e2e-subscribe-0001" },
      body: { planId: ids.planId, card: { token: "tok_mock_aprovar", last4: "4242", brand: "visa" } },
    });
    const [first, second] = await Promise.all([request(), request()]);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.equal(first.body.id, second.body.id);
    ids.subscriptionId = first.body.id;

    const reused = await call("POST", "/api/v1/subscriptions", {
      as: ids.customer, headers: { "Idempotency-Key": "e2e-subscribe-0001" },
      body: { planId: ids.planId, card: { token: "outro-token-123" } },
    });
    assert.equal(reused.status, 422);
    assert.equal(reused.body.error.code, "idempotency_key_reuse");

    await waitFor(async () => (await one("SELECT status FROM subscriptions WHERE id=$1", [ids.subscriptionId]))?.status === "ativa", "assinatura ativa");
    const { rows: charges } = await db.runQuery("SELECT * FROM charges WHERE subscription_id=$1", [ids.subscriptionId]);
    assert.equal(charges.length, 1);
    assert.equal(charges[0].status, "paga");
    assert.equal(charges[0].total_cents, 3219);
    assert.equal(charges[0].settings_snapshot.fee_percent_bps, 400);
    const { rows: subs } = await db.runQuery("SELECT * FROM subscriptions WHERE customer_id=$1", [ids.customer.id]);
    assert.equal(subs.length, 1);
    const { rows: gatewaySubs } = await db.runQuery("SELECT * FROM mock_gateway_objects WHERE kind='subscription'");
    assert.equal(gatewaySubs.filter((row) => row.state.referencia?.id === ids.subscriptionId).length, 1);

    const mine = await call("GET", "/api/v1/me/subscriptions", { as: ids.customer });
    assert.equal(mine.body[0].sessions[0].remaining, 2);
    assert.ok(await one("SELECT 1 FROM payables WHERE charge_id=$1", [charges[0].id]), "repasse previsto");
    assert.ok(await one("SELECT 1 FROM invoice_data WHERE charge_id=$1", [charges[0].id]), "dados da nota");
  });

  test("limite do Free é sobre assinantes ativas", async () => {
    const response = await call("POST", "/api/v1/subscriptions", {
      as: ids.customer2, headers: { "Idempotency-Key": "e2e-subscribe-0002" },
      body: { planId: ids.planId, card: { token: "tok_mock_aprovar" } },
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "subscriber_limit");
  });

  test("sessão é debitada no agendamento e devolvida no cancelamento dentro do prazo", async () => {
    const scheduledAt = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    const order = await call("POST", "/api/v1/orders", {
      as: ids.customer, body: { serviceId: ids.serviceId, scheduledAt, subscriptionId: ids.subscriptionId },
    });
    assert.equal(order.status, 201, JSON.stringify(order.body));
    assert.equal(order.body.payment.method, "subscription");
    let mine = await call("GET", "/api/v1/me/subscriptions", { as: ids.customer });
    assert.equal(mine.body[0].sessions[0].remaining, 1);
    const cancel = await call("PATCH", `/api/v1/orders/${order.body.id}/status`, { as: ids.customer, body: { status: "cancelled" } });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
    mine = await call("GET", "/api/v1/me/subscriptions", { as: ids.customer });
    assert.equal(mine.body[0].sessions[0].remaining, 2);
  });

  test("renovação recusada: retentativa congela as sessões; tentativa aprovada libera", async () => {
    const failed = await call("POST", `/api/v1/dev/payments/subscriptions/${ids.subscriptionId}/advance-cycle`, { as: ids.customer, body: { outcome: "fail" } });
    assert.equal(failed.status, 200, JSON.stringify(failed.body));
    await waitFor(async () => (await one("SELECT status FROM subscriptions WHERE id=$1", [ids.subscriptionId]))?.status === "em_retentativa", "em retentativa");
    const sub = await one("SELECT current_cycle FROM subscriptions WHERE id=$1", [ids.subscriptionId]);
    assert.equal(sub.current_cycle, 2);

    const frozen = await call("POST", "/api/v1/orders", {
      as: ids.customer,
      body: { serviceId: ids.serviceId, scheduledAt: new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString(), subscriptionId: ids.subscriptionId },
    });
    assert.equal(frozen.status, 409);
    assert.equal(frozen.body.error.code, "entitlements_frozen");

    await call("POST", `/api/v1/dev/payments/subscriptions/${ids.subscriptionId}/advance-cycle`, { as: ids.customer, body: { outcome: "approve" } });
    await waitFor(async () => (await one("SELECT status FROM subscriptions WHERE id=$1", [ids.subscriptionId]))?.status === "ativa", "ativa de novo");
    const mine = await call("GET", "/api/v1/me/subscriptions", { as: ids.customer });
    assert.equal(mine.body[0].cycle, 2);
    assert.equal(mine.body[0].sessions[0].remaining, 2, "ciclo novo: direitos resetados, sem acumular");
    const { rows: cycleTwo } = await db.runQuery("SELECT status, attempt FROM charges WHERE subscription_id=$1 AND subscription_cycle=2 ORDER BY attempt", [ids.subscriptionId]);
    assert.deepEqual(cycleTwo.map((row) => [row.status, row.attempt]), [["falhou", 1], ["paga", 2]]);
  });

  test("avulso: cobrado na solicitação, idempotente, aceito só depois do webhook; estorno reverte o split", async () => {
    const body = { serviceId: ids.serviceId, scheduledAt: new Date(Date.now() + 4 * 24 * 3600 * 1000).toISOString(), paymentMethod: { type: "pix" } };
    const missingKey = await call("POST", "/api/v1/orders", { as: ids.customer2, body });
    assert.equal(missingKey.status, 400);
    const first = await call("POST", "/api/v1/orders", { as: ids.customer2, body, headers: { "Idempotency-Key": "e2e-order-0001" } });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const again = await call("POST", "/api/v1/orders", { as: ids.customer2, body, headers: { "Idempotency-Key": "e2e-order-0001" } });
    assert.equal(again.body.id, first.body.id);
    // cliente vê o total com a taxa embutida: 2000 + 99 + 80
    assert.equal(first.body.totalAmount, 21.79);
    const { rows: charges } = await db.runQuery("SELECT * FROM charges WHERE order_id=$1", [first.body.id]);
    assert.equal(charges.length, 1);

    await waitFor(async () => (await one("SELECT status FROM charges WHERE id=$1", [charges[0].id]))?.status === "paga", "avulso pago");
    const accepted = await call("PATCH", `/api/v1/orders/${first.body.id}/status`, { as: ids.provider, body: { status: "accepted" } });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));

    const refund = await call("POST", `/api/v1/dev/payments/charges/${charges[0].id}/refund`, { as: ids.customer2, body: {} });
    assert.equal(refund.status, 202, JSON.stringify(refund.body));
    await waitFor(async () => (await one("SELECT status FROM charges WHERE id=$1", [charges[0].id]))?.status === "estornada", "estornada");
    const { rows: splits } = await db.runQuery("SELECT party, amount_cents, refunded_cents FROM charge_splits WHERE charge_id=$1 ORDER BY party", [charges[0].id]);
    assert.deepEqual(splits.map((split) => [split.party, split.refunded_cents === split.amount_cents]), [["plataforma", true], ["prestadora", true]]);
    assert.equal((await one("SELECT status FROM payables WHERE charge_id=$1", [charges[0].id])).status, "revertido");
  });

  test("webhook com assinatura inválida é recusado; evento repetido é ignorado", async () => {
    const forged = await fetch(`${baseUrl}/webhooks/payments`, {
      method: "POST", headers: { "content-type": "application/json", "x-mock-signature": "00" },
      body: JSON.stringify({ id: "evt_forjado", type: "charge.paid", data: {} }),
    });
    assert.equal(forged.status, 401);
    const { rows } = await db.runQuery("SELECT payload FROM mock_scheduled_webhooks WHERE payload->>'action'='deliver' AND sent_at IS NOT NULL LIMIT 1");
    const { signMockWebhook } = require("../src/payments/gateway/MockGateway");
    const { gateway } = require("../src/payments/runtime");
    const rawBody = JSON.stringify(rows[0].payload.event);
    const replay = await fetch(`${baseUrl}/webhooks/payments`, {
      method: "POST", headers: { "content-type": "application/json", "x-mock-signature": signMockWebhook(gateway().secret, rawBody) }, body: rawBody,
    });
    assert.equal(replay.status, 200);
  });

  test("cancelamento vale no fim do ciclo: ativa até lá, depois cancelada", async () => {
    const cancel = await call("POST", `/api/v1/subscriptions/${ids.subscriptionId}/cancel`, { as: ids.customer });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.status, "ativa");
    assert.equal(cancel.body.cancelAtPeriodEnd, true);
    await call("POST", `/api/v1/dev/payments/subscriptions/${ids.subscriptionId}/advance-cycle`, { as: ids.customer, body: {} });
    assert.equal((await one("SELECT status FROM subscriptions WHERE id=$1", [ids.subscriptionId])).status, "cancelada");
  });

  test("downgrade não cancela ninguém e a camada vira desconto de repasse", async () => {
    const up = await call("PUT", "/api/v1/me/payments/tier", { as: ids.provider, body: { plan: "standard" } });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.ok(await one("SELECT 1 FROM provider_deductions WHERE provider_id=$1 AND kind='camada' AND amount_cents=2990", [ids.provider.id]));
    const down = await call("PUT", "/api/v1/me/payments/tier", { as: ids.provider, body: { plan: "free" } });
    assert.equal(down.status, 200);
    assert.equal(down.body.tier, "free");
  });

  test("perfil fiscal: NBS pré-preenchido pelo item, validado contra a tabela oficial", async () => {
    const profile = await call("GET", "/api/v1/me/payments/fiscal-profile", { as: ids.provider });
    assert.equal(profile.status, 200);
    assert.equal(profile.body.serviceCode, "6.01");
    assert.equal(profile.body.nbsCode, "126021000");
    assert.equal(profile.body.cClassTrib, "000001");
    assert.deepEqual(profile.body.nbsOptions.map((option) => option.code), ["126021000", "126022000"]);
    const wrong = await call("PUT", "/api/v1/me/payments/fiscal-profile", {
      as: ids.provider, body: { regime: "informal", cpf: randomCpf(), serviceCode: "6.01", nbsCode: "1.1803.10.00", cClassTrib: "000001" },
    });
    assert.equal(wrong.status, 422);
    assert.ok(wrong.body.error.details.nbsCode);
    const saved = await call("PUT", "/api/v1/me/payments/fiscal-profile", {
      as: ids.provider, body: { regime: "informal", cpf: randomCpf(), serviceCode: "6.01", nbsCode: "1.2602.20.00", cClassTrib: "000001" },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.nbsCode, "126022000");
  });

  test("extrato e dados da nota são lidos do que foi gravado", async () => {
    const statement = await call("GET", "/api/v1/me/payments/statement", { as: ids.provider });
    assert.equal(statement.status, 200);
    assert.ok(statement.body.charges.length >= 3);
    const invoices = await call("GET", "/api/v1/me/payments/invoices", { as: ids.provider });
    const detail = await call("GET", `/api/v1/me/payments/invoices/${invoices.body.invoices[0].chargeId}`, { as: ids.provider });
    assert.equal(detail.status, 200);
    const cep = detail.body.fields.find((field) => field.key === "cep");
    assert.equal(cep.value, "37800-000");
    assert.ok(detail.body.fields.some((field) => field.key === "nbs"), "campo NBS na nota");
    assert.ok(detail.body.fields.some((field) => field.key === "cClassTrib"), "campo cClassTrib na nota");
    const marked = await call("PATCH", `/api/v1/me/payments/invoices/${invoices.body.invoices[0].chargeId}`, { as: ids.provider, body: { status: "emitida" } });
    assert.equal(marked.status, 204);
  });
});
