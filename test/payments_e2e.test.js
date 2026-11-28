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
    const cpf = randomCpf();
    const response = await call("PUT", "/api/v1/me/payments/account", {
      as: ids.provider,
      body: {
        // conta antiga sem CPF no cadastro: o informado vira o CPF do cadastro
        holderName: "Outro Nome", holderDocument: cpf, bankCode: "260", branch: "0001",
        account: "12345-6", accountType: "corrente", cityCode: "3128709",
      },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    // titular é sempre ela (PF): nome do cadastro, não o digitado
    assert.equal(response.body.holderName, "Prestadora E2E");
    await waitFor(async () => (await one("SELECT status FROM provider_payment_accounts WHERE provider_id=$1", [ids.provider.id]))?.status === "aprovada", "recebedor aprovado");
    const overview = await call("GET", "/api/v1/me/payments/overview", { as: ids.provider });
    assert.equal(overview.body.holder.type, "cpf");
    assert.equal(overview.body.holder.document.replace(/\D/g, ""), cpf);
    // sem prova de vida: ainda não pode criar planos
    assert.equal(overview.body.eligibility.eligible, false);
    assert.deepEqual(overview.body.eligibility.missing.map((item) => item.key), ["identity"]);
    assert.deepEqual(overview.body.seats, { used: 0, limit: 1, full: false });
  });

  test("prova de vida no gateway: link, resultado por webhook e selo de identidade", async () => {
    const early = await call("POST", "/api/v1/dev/payments/me/kyc", { as: ids.provider, body: { outcome: "approve" } });
    assert.equal(early.status, 409, "sem abrir o link não há resultado");
    const link = await call("POST", "/api/v1/me/payments/account/kyc-link", { as: ids.provider });
    assert.equal(link.status, 200, JSON.stringify(link.body));
    assert.equal(link.body.kyc.status, "pendente");
    assert.match(link.body.kyc.linkUrl, /^https:\/\//);
    const again = await call("POST", "/api/v1/me/payments/account/kyc-link", { as: ids.provider });
    assert.equal(again.body.kyc.linkUrl, link.body.kyc.linkUrl, "link válido é reaproveitado");

    const refused = await call("POST", "/api/v1/dev/payments/me/kyc", { as: ids.provider, body: { outcome: "fail" } });
    assert.equal(refused.status, 200, JSON.stringify(refused.body));
    await waitFor(async () => (await one("SELECT kyc_status FROM provider_payment_accounts WHERE provider_id=$1", [ids.provider.id]))?.kyc_status === "recusada", "prova de vida recusada");

    // tenta de novo com um link novo
    const retry = await call("POST", "/api/v1/me/payments/account/kyc-link", { as: ids.provider });
    assert.equal(retry.body.kyc.status, "pendente");
    await call("POST", "/api/v1/dev/payments/me/kyc", { as: ids.provider, body: { outcome: "approve" } });
    await waitFor(async () => (await one("SELECT kyc_status FROM provider_payment_accounts WHERE provider_id=$1", [ids.provider.id]))?.kyc_status === "aprovada", "prova de vida aprovada");

    const overview = await call("GET", "/api/v1/me/payments/overview", { as: ids.provider });
    assert.equal(overview.body.eligibility.eligible, true, JSON.stringify(overview.body.eligibility));
    assert.equal(overview.body.account.kyc.status, "aprovada");
    const notifications = await db.runQuery("SELECT type FROM notifications WHERE user_id=$1 AND type LIKE 'identity_%' ORDER BY created_at", [ids.provider.id]);
    assert.deepEqual(notifications.rows.map((row) => row.type), ["identity_rejected", "identity_verified"]);
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

  test("plano: só o valor muda; assinantes são avisadas e pagam o novo a partir do próximo ciclo", async () => {
    const renamed = await call("PATCH", `/api/v1/me/payments/plans/${ids.planId}`, {
      as: ids.provider, body: { name: "Outro nome" },
    });
    assert.equal(renamed.status, 422, "nome não é editável por enquanto");
    const pricey = await call("PATCH", `/api/v1/me/payments/plans/${ids.planId}`, {
      as: ids.provider, body: { priceCents: 9000 },
    });
    assert.equal(pricey.status, 422);
    assert.equal(pricey.body.error.code, "plan_pricier_than_avulso");

    const repriced = await call("PATCH", `/api/v1/me/payments/plans/${ids.planId}`, {
      as: ids.provider, body: { priceCents: 3200 },
    });
    assert.equal(repriced.status, 200, JSON.stringify(repriced.body));
    assert.equal(repriced.body.priceCents, 3200);
    assert.equal(repriced.body.notifiedSubscribers, 1);
    // assinante: preço do ciclo atual igual; o novo fica para o próximo
    const sub = await one("SELECT total_cents, next_cycle_pricing FROM subscriptions WHERE id=$1", [ids.subscriptionId]);
    assert.equal(sub.total_cents, 3219);
    // 3200 + 99 + 4% (128) = 3427
    assert.equal(sub.next_cycle_pricing.total_cents, 3427);
    const notice = await one(
      "SELECT body FROM notifications WHERE user_id=$1 AND type='subscription_repriced' ORDER BY created_at DESC LIMIT 1",
      [ids.customer.id]
    );
    assert.match(notice.body, /de R\$ 32,19 para R\$ 34,27/);
    assert.match(notice.body, /cancelar antes, sem custo/);
    // volta ao valor original para o resto do roteiro
    await call("PATCH", `/api/v1/me/payments/plans/${ids.planId}`, { as: ids.provider, body: { priceCents: 3000 } });
    await db.runQuery("UPDATE subscriptions SET next_cycle_pricing=NULL, next_cycle_pricing_synced_at=NULL WHERE id=$1", [ids.subscriptionId]);

    const archived = await call("PATCH", `/api/v1/me/payments/plans/${ids.planId}`, {
      as: ids.provider, body: { status: "arquivado" },
    });
    assert.equal(archived.status, 409, "com assinantes não exclui");
    // serviço com assinante: não exclui (as sessões ainda vão ser usadas)
    const remove = await call("DELETE", `/api/v1/provider/me/services/${ids.serviceId}`, { as: ids.provider });
    assert.equal(remove.status, 409);
    assert.equal(remove.body.error.code, "service_in_plan");
  });

  test("desativar o serviço pausa os planos dele; quem assina ainda agenda", async () => {
    const service = await one(
      `INSERT INTO services (provider_id,category_id,title,base_price,duration_minutes,service_location,price_type,availability)
       VALUES ($1,'beauty','Hidratação',30.00,60,'at_provider','fixed','[]') RETURNING id`,
      [ids.provider.id]
    );
    const created = await call("POST", "/api/v1/me/payments/plans", {
      as: ids.provider, body: { name: "Hidratação mensal", priceCents: 2500, items: [{ serviceId: service.id, sessionsPerCycle: 1 }] },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const planId = created.body.plan.id;

    const paused = await call("PATCH", `/api/v1/provider/me/services/${service.id}`, { as: ids.provider, body: { paused: true } });
    assert.equal(paused.status, 200, JSON.stringify(paused.body));
    assert.equal(paused.body.paused, true);
    assert.deepEqual(paused.body.pausedPlans, ["Hidratação mensal"]);
    const plan = (await call("GET", "/api/v1/me/payments/plans", { as: ids.provider })).body.find((item) => item.id === planId);
    assert.equal(plan.status, "pausado");

    // continua na lista dela; avulso não agenda
    const mine = await call("GET", "/api/v1/provider/me/services", { as: ids.provider });
    assert.equal(mine.body.find((item) => item.id === service.id)?.paused, true);
    const order = await call("POST", "/api/v1/orders", {
      as: ids.customer2, headers: { "Idempotency-Key": "e2e-order-paused-service" },
      body: { serviceId: service.id, scheduledAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(), paymentMethod: { type: "pix" } },
    });
    assert.notEqual(order.status, 201);
    // plano não volta enquanto o serviço estiver desativado
    const reactivate = await call("PATCH", `/api/v1/me/payments/plans/${planId}`, { as: ids.provider, body: { status: "ativo" } });
    assert.equal(reactivate.status, 422);

    // o serviço do plano com assinante: desativar pausa o plano, e a
    // assinante ainda agenda com a sessão
    const mainPaused = await call("PATCH", `/api/v1/provider/me/services/${ids.serviceId}`, { as: ids.provider, body: { paused: true } });
    assert.equal(mainPaused.status, 200);
    const subscriberOrder = await call("POST", "/api/v1/orders", {
      as: ids.customer, headers: { "Idempotency-Key": "e2e-order-paused-with-session" },
      body: { serviceId: ids.serviceId, scheduledAt: new Date(Date.now() + 8 * 24 * 3600 * 1000).toISOString(), subscriptionId: ids.subscriptionId },
    });
    assert.equal(subscriberOrder.status, 201, JSON.stringify(subscriberOrder.body));
    const cancelled = await call("PATCH", `/api/v1/orders/${subscriberOrder.body.id}/status`, { as: ids.customer, body: { status: "cancelled" } });
    assert.equal(cancelled.status, 200, "a sessão volta para o resto do roteiro");
    await call("PATCH", `/api/v1/provider/me/services/${ids.serviceId}`, { as: ids.provider, body: { paused: false } });
    await call("PATCH", `/api/v1/me/payments/plans/${ids.planId}`, { as: ids.provider, body: { status: "ativo" } });

    // reativar o serviço não reativa o plano sozinho; reativando os dois, ok
    assert.equal((await call("PATCH", `/api/v1/provider/me/services/${service.id}`, { as: ids.provider, body: { paused: false } })).status, 200);
    assert.equal((await call("PATCH", `/api/v1/me/payments/plans/${planId}`, { as: ids.provider, body: { status: "ativo" } })).status, 200);

    // excluir o serviço (sem assinantes) também pausa o plano
    const removed = await call("DELETE", `/api/v1/provider/me/services/${service.id}`, { as: ids.provider });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.deepEqual(removed.body.pausedPlans, ["Hidratação mensal"]);
    const archived = await call("PATCH", `/api/v1/me/payments/plans/${planId}`, { as: ids.provider, body: { status: "arquivado" } });
    assert.equal(archived.status, 204);
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

  test("agenda da assinatura: prévia, conflito com opções, remarcação e mês novo automático", async () => {
    // dia da semana de amanhã (Brasília) às 10h e às 14h
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    const weekdayName = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", weekday: "short" }).format(tomorrow);
    const weekday = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[weekdayName];
    const rules10 = [{ serviceId: ids.serviceId, weekday, time: "10:00" }];
    const base = `/api/v1/subscriptions/${ids.subscriptionId}/schedule`;

    const view = await call("GET", base, { as: ids.customer });
    assert.equal(view.status, 200, JSON.stringify(view.body));
    const remaining = view.body.services[0].remaining;
    assert.ok(remaining >= 1, "há sessões no ciclo");

    const preview = await call("POST", `${base}/preview`, { as: ids.customer, body: { rules: rules10 } });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.ok(preview.body.sessions.length >= 1);
    assert.ok(preview.body.sessions.every((session) => session.available));

    // a prestadora já tem um compromisso no primeiro horário: vira opção
    const first = preview.body.sessions[0];
    const blocker = await one(
      `INSERT INTO orders (customer_id,provider_id,service_id,service_location,scheduled_at,duration_minutes,total_amount,commission,checkin_code,status)
       VALUES ($1,$2,$3,'at_provider',$4,60,20,0,'0000','accepted') RETURNING id`,
      [ids.customer2.id, ids.provider.id, ids.serviceId, first.wantedAt]
    );
    const withConflict = await call("POST", `${base}/preview`, { as: ids.customer, body: { rules: rules10 } });
    const conflicted = withConflict.body.sessions[0];
    assert.equal(conflicted.available, false);
    assert.ok(conflicted.alternatives.length > 0, "oferece horários livres");
    assert.ok(!conflicted.alternatives.includes(first.wantedAt));

    // confirma: a ocupada vai para a 1ª opção, o resto na recorrência
    const sessions = withConflict.body.sessions.map((session) => ({
      serviceId: session.serviceId, startsAt: session.available ? session.wantedAt : session.alternatives[0],
    }));
    const saved = await call("PUT", base, { as: ids.customer, body: { rules: rules10, sessions } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.booked, sessions.length);
    assert.equal(saved.body.schedule.upcoming.length, sessions.length);
    assert.ok(saved.body.schedule.upcoming.every((order) => order.status === "accepted"), "já confirmadas");
    const providerOrders = await call("GET", "/api/v1/provider/me/orders", { as: ids.provider });
    if (providerOrders.status === 200 && Array.isArray(providerOrders.body)) {
      assert.ok(providerOrders.body.some((order) => order.id === saved.body.schedule.upcoming[0].orderId));
    }

    // muda a recorrência: as futuras são remarcadas e as sessões voltam
    const rules14 = [{ serviceId: ids.serviceId, weekday, time: "14:00" }];
    const preview14 = await call("POST", `${base}/preview`, { as: ids.customer, body: { rules: rules14 } });
    assert.equal(preview14.body.sessions.length, sessions.length, "as remarcáveis contam como livres");
    const moved = await call("PUT", base, {
      as: ids.customer,
      body: { rules: rules14, sessions: preview14.body.sessions.map((session) => ({ serviceId: session.serviceId, startsAt: session.wantedAt })) },
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.replaced, sessions.length);
    assert.ok(moved.body.schedule.upcoming.every((order) => new Date(order.startsAt).toISOString().includes("T17:00")), "14h em Brasília");
    const entitlement = await one("SELECT sessions_used FROM entitlements WHERE subscription_id=$1 ORDER BY cycle DESC LIMIT 1", [ids.subscriptionId]);
    assert.ok(entitlement.sessions_used <= view.body.services[0].sessionsPerCycle, "não gasta sessão a mais");

    // mês novo: o agendador marca pela recorrência das 10h; a ocupada vira pendência
    await call("PUT", base, { as: ids.customer, body: { rules: rules10, sessions: [] } });
    await db.runQuery("UPDATE subscriptions SET schedule_generated_cycle=NULL WHERE id=$1", [ids.subscriptionId]);
    await call("POST", "/api/v1/dev/payments/run-maintenance", { as: ids.customer });
    const generated = await call("GET", base, { as: ids.customer });
    assert.equal(generated.body.pending.length, 1, JSON.stringify(generated.body));
    assert.equal(generated.body.upcoming.length, remaining - 1);
    const notice = await one(
      "SELECT type FROM notifications WHERE user_id=$1 AND type LIKE 'subscription_schedule%' ORDER BY created_at DESC LIMIT 1",
      [ids.customer.id]
    );
    assert.equal(notice.type, "subscription_schedule_pending");

    // resolve a pendência com uma das opções
    const pending = generated.body.pending[0];
    const resolved = await call("POST", `${base}/sessions`, {
      as: ids.customer, body: { serviceId: pending.serviceId, startsAt: pending.alternatives[0], pendingId: pending.id },
    });
    assert.equal(resolved.status, 201, JSON.stringify(resolved.body));
    assert.equal(resolved.body.pending.length, 0);
    assert.equal(resolved.body.upcoming.length, remaining);

    // limpa para o resto do roteiro
    await call("PUT", base, { as: ids.customer, body: { rules: [], sessions: [] } });
    await db.runQuery("DELETE FROM orders WHERE id=$1", [blocker.id]);
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

  test("cartão salvo: salva no gateway, paga o avulso e sai da lista", async () => {
    const invalid = await call("POST", "/api/v1/me/payments/cards", {
      as: ids.customer2,
      body: { token: "tok_mock_invalido", last4: "1111", brand: "visa", expMonth: 12, expYear: 2099, holderName: "Cliente Dois" },
    });
    assert.equal(invalid.status, 422);
    const added = await call("POST", "/api/v1/me/payments/cards", {
      as: ids.customer2,
      body: { token: "tok_mock_aprovar", last4: "4242", brand: "visa", expMonth: 12, expYear: 2099, holderName: "Cliente Dois" },
    });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body.isDefault, true, "o primeiro cartão vira o principal");
    assert.ok(!("token" in added.body) && !("gatewayCardId" in added.body));
    const expired = await call("POST", "/api/v1/me/payments/cards", {
      as: ids.customer2,
      body: { token: "tok_mock_aprovar", last4: "4242", expMonth: 1, expYear: 2020, holderName: "Cliente Dois" },
    });
    assert.equal(expired.status, 422);

    const order = await call("POST", "/api/v1/orders", {
      as: ids.customer2, headers: { "Idempotency-Key": "e2e-order-saved-card" },
      body: {
        serviceId: ids.serviceId, scheduledAt: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
        paymentMethod: { type: "card", savedCardId: added.body.id },
      },
    });
    assert.equal(order.status, 201, JSON.stringify(order.body));
    const charge = await one("SELECT id, saved_card_id, pending_card_token_encrypted FROM charges WHERE order_id=$1", [order.body.id]);
    assert.equal(charge.saved_card_id, added.body.id);
    assert.equal(charge.pending_card_token_encrypted, null);
    await waitFor(async () => (await one("SELECT status FROM charges WHERE id=$1", [charge.id]))?.status === "paga", "avulso no cartão salvo pago");

    // cartão de outra cliente não serve
    const foreign = await call("POST", "/api/v1/orders", {
      as: ids.customer, headers: { "Idempotency-Key": "e2e-order-foreign-card" },
      body: {
        serviceId: ids.serviceId, scheduledAt: new Date(Date.now() + 6 * 24 * 3600 * 1000).toISOString(),
        paymentMethod: { type: "card", savedCardId: added.body.id },
      },
    });
    assert.equal(foreign.status, 404);

    const listed = await call("GET", "/api/v1/me/payments/cards", { as: ids.customer2 });
    assert.equal(listed.body.length, 1);
    const removed = await call("DELETE", `/api/v1/me/payments/cards/${added.body.id}`, { as: ids.customer2 });
    assert.equal(removed.status, 204);
    assert.equal((await call("GET", "/api/v1/me/payments/cards", { as: ids.customer2 })).body.length, 0);
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
    // pessoa física: o CPF vem do cadastro e não se troca por aqui
    assert.equal(profile.body.cpfFromRegistration, true);
    assert.ok(profile.body.cpf);
    const otherCpf = await call("PUT", "/api/v1/me/payments/fiscal-profile", {
      as: ids.provider, body: { regime: "informal", cpf: randomCpf(), serviceCode: "6.01" },
    });
    assert.equal(otherCpf.status, 422);
    assert.ok(otherCpf.body.error.details.cpf);
    const wrong = await call("PUT", "/api/v1/me/payments/fiscal-profile", {
      as: ids.provider, body: { regime: "informal", serviceCode: "6.01", nbsCode: "1.1803.10.00", cClassTrib: "000001" },
    });
    assert.equal(wrong.status, 422);
    assert.ok(wrong.body.error.details.nbsCode);
    const saved = await call("PUT", "/api/v1/me/payments/fiscal-profile", {
      as: ids.provider, body: { regime: "informal", serviceCode: "6.01", nbsCode: "1.2602.20.00", cClassTrib: "000001" },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.nbsCode, "126022000");
  });

  test("cadastro de prestadora: termo obrigatório, nome social no perfil e edição da conta", async () => {
    const term = await call("GET", "/api/v1/terms/prestadora_elegibilidade");
    assert.equal(term.status, 200);
    assert.match(term.body.body, /Mulheres trans são mulheres/);
    const suffix = crypto.randomUUID().slice(0, 8);
    const base = {
      name: "Registro Civil", email: `reg-${suffix}@e2e.test`, phone: `+55359${String(parseInt(suffix, 16)).padStart(8, "0").slice(0, 8)}`,
      password: "Teste@1234", role: "prestadora", cpf: randomCpf(),
    };
    const noTerm = await call("POST", "/api/v1/auth/registrations", { body: base });
    assert.equal(noTerm.status, 422);
    assert.ok(noTerm.body.error.details.acceptedTerms);
    const outdated = await call("POST", "/api/v1/auth/registrations", {
      body: { ...base, acceptedTerms: { key: "prestadora_elegibilidade", version: term.body.version + 1 } },
    });
    assert.equal(outdated.status, 409);
    const created = await call("POST", "/api/v1/auth/registrations", {
      body: { ...base, socialName: "Nome Social", acceptedTerms: { key: "prestadora_elegibilidade", version: term.body.version } },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const userId = created.body.user.id;
    const acceptance = await one("SELECT version FROM term_acceptances WHERE user_id=$1", [userId]);
    assert.equal(acceptance.version, term.body.version);
    const user = { id: userId, roles: ["prestadora"] };

    // dados básicos: abertos antes da verificação
    const account = await call("GET", "/api/v1/me/account", { as: user });
    assert.equal(account.status, 200, JSON.stringify(account.body));
    assert.equal(account.body.socialName, "Nome Social");
    assert.equal(account.body.providerTermVersion, term.body.version);
    assert.match(account.body.cpfMasked, /^\*\*\*\.\d{3}\.\d{3}-\*\*$/);
    const renamed = await call("PATCH", "/api/v1/me/account", { as: user, body: { name: "Registro Novo", socialName: "" } });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, "Registro Novo");
    assert.equal(renamed.body.socialName, null);
    const noPassword = await call("PATCH", "/api/v1/me/account", { as: user, body: { email: `novo-${suffix}@e2e.test` } });
    assert.equal(noPassword.status, 403);
    const taken = await call("PATCH", "/api/v1/me/account", {
      as: user, body: { email: (await one("SELECT email FROM users WHERE id=$1", [ids.customer.id])).email, currentPassword: "Teste@1234" },
    });
    assert.equal(taken.status, 409);
    const changed = await call("PATCH", "/api/v1/me/account", {
      as: user, body: { email: `novo-${suffix}@e2e.test`, currentPassword: "Teste@1234" },
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.email, `novo-${suffix}@e2e.test`);
  });

  test("repasse espera a prova de vida", async () => {
    const payable = await one(
      `SELECT p.id FROM payables p WHERE p.provider_id=$1 AND p.status='previsto' LIMIT 1`, [ids.provider.id]
    );
    if (!payable) return; // nada previsto neste ponto do roteiro
    await db.runQuery("UPDATE payables SET expected_payout_date=CURRENT_DATE - 1 WHERE id=$1", [payable.id]);
    await db.runQuery("UPDATE provider_payment_accounts SET kyc_status='recusada' WHERE provider_id=$1", [ids.provider.id]);
    await call("POST", "/api/v1/dev/payments/run-maintenance", { as: ids.provider });
    assert.equal((await one("SELECT status FROM payables WHERE id=$1", [payable.id])).status, "previsto");
    const statement = await call("GET", "/api/v1/me/payments/statement", { as: ids.provider });
    assert.equal(statement.body.payoutsOnHold, true);
    await db.runQuery("UPDATE provider_payment_accounts SET kyc_status='aprovada' WHERE provider_id=$1", [ids.provider.id]);
    await call("POST", "/api/v1/dev/payments/run-maintenance", { as: ids.provider });
    assert.equal((await one("SELECT status FROM payables WHERE id=$1", [payable.id])).status, "pago");
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
