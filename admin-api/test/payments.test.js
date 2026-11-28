const assert = require("node:assert/strict");
const { after, before, beforeEach, describe, test } = require("node:test");
const jsonWebToken = require("jsonwebtoken");
const { analyzeImpact, validateChanges, mergeSettings, referenceItems, SettingsValidationError } = require("../src/payment_settings");

process.env.JWT_SECRET = "test-secret-with-more-than-thirty-two-characters";

const GLOBAL = {
  scope_key: "global", version: 3,
  fee_fixed_cents: 99, fee_percent_bps: 400, fee_payer: "cliente", rounding_mode: "half_up",
  activation_fee_cents: 0, activation_fee_installments: 1, free_max_active_subscribers: 5,
  standard_price_cents: 2990, pro_price_cents: 5990, retry_max_attempts: 3, retry_interval_days: 2,
  suspension_grace_days: 30, entitlement_refund_window_hours: 24, payout_interval: "semanal", payout_day: 1,
  settlement_days_card: 30, settlement_days_pix: 1, gateway_cost_card_fixed_cents: 0, gateway_cost_card_bps: 399,
  gateway_cost_pix_fixed_cents: 0, gateway_cost_pix_bps: 119, mock_failure_rate_bps: 0, mock_latency_ms: 1500,
};

describe("impacto antes de salvar", () => {
  test("padrões: margem positiva em R$ 30, 80 e 150 e plano mais barato que o avulso", () => {
    const impact = analyzeImpact(mergeSettings(GLOBAL, null));
    assert.equal(impact.canSave, true, impact.reasons.join("; "));
    assert.deepEqual(impact.bands.map((band) => band.priceCents), [3000, 8000, 15000]);
    const thirty = impact.bands[0];
    assert.equal(thirty.customerPaysCents, 3219);
    assert.equal(thirty.providerReceivesCents, 3000);
    assert.equal(thirty.gatewayCostCents, 129); // 3219 × 3,99% = 128,4 → 129 (custo arredonda para cima)
    assert.equal(thirty.marginCents, 90);
    // avulso: 4 × (750 + 99 + 30)
    assert.equal(thirty.avulsoCents, 3516);
  });

  test("recusa margem negativa", () => {
    const impact = analyzeImpact(mergeSettings(GLOBAL, { fee_fixed_cents: 0, fee_percent_bps: 200 }));
    assert.equal(impact.canSave, false);
    assert.ok(impact.reasons.some((reason) => reason.includes("Margem negativa")));
  });

  test("recusa plano mais caro que o avulso (arredondamento para baixo por sessão)", () => {
    // floor: 4 × floor(750 × 4,5%) = 132, contra floor(3000 × 4,5%) = 135
    const impact = analyzeImpact(mergeSettings(GLOBAL, { fee_fixed_cents: 0, fee_percent_bps: 450, rounding_mode: "floor", gateway_cost_card_bps: 0 }));
    assert.equal(impact.canSave, false);
    assert.ok(impact.reasons.some((reason) => reason.includes("mais caro que o avulso")), impact.reasons.join("; "));
  });

  test("confere os planos reais com os preços avulsos cadastrados", () => {
    const plans = [{ id: "p1", name: "Escova", providerName: "Ana", priceCents: 9000, items: [{ unitPriceCents: 2000, sessions: 4 }] }];
    const impact = analyzeImpact(mergeSettings(GLOBAL, null), plans);
    assert.equal(impact.canSave, false);
    assert.equal(impact.planViolations[0].id, "p1");
    assert.equal(impact.referenceSessions, 4);
  });

  test("taxa maior que o preço com a prestadora pagando é recusada", () => {
    const impact = analyzeImpact(mergeSettings(GLOBAL, { fee_payer: "prestadora", fee_fixed_cents: 5000 }));
    assert.equal(impact.canSave, false);
  });

  test("repasse semanal só em dia útil", () => {
    const impact = analyzeImpact(mergeSettings(GLOBAL, { payout_day: 10 }));
    assert.equal(impact.canSave, false);
  });

  test("avulso de referência soma exatamente o valor da faixa", () => {
    const items = referenceItems(8000, 3);
    assert.equal(items.reduce((sum, item) => sum + item.unitPriceCents * item.sessions, 0), 8000);
  });
});

describe("validação e override por cidade", () => {
  test("cidade herda o que não sobrescreve; mock só na global", () => {
    const merged = mergeSettings(GLOBAL, { fee_percent_bps: 350, mock_latency_ms: 1 });
    assert.equal(merged.fee_percent_bps, 350);
    assert.equal(merged.fee_fixed_cents, 99);
    assert.equal(merged.mock_latency_ms, 1500);
  });

  test("rejeita campo desconhecido, global vazia, mock na cidade e valor fora do limite", () => {
    const fails = (scope, changes) => assert.throws(() => validateChanges(scope, changes), SettingsValidationError);
    fails("global", { fee_unknown: 1 });
    fails("global", { fee_fixed_cents: null });
    fails("3128709", { mock_failure_rate_bps: 100 });
    fails("global", { fee_percent_bps: 5001 });
    fails("global", { fee_fixed_cents: 0.5 });
    fails("global", { fee_payer: "admin" });
    validateChanges("3128709", { fee_fixed_cents: null, fee_percent_bps: 350 });
  });
});

describe("rotas de pagamentos do admin", () => {
  const database = require("../src/db");
  let rules = [];
  let log = [];
  async function fakeQuery(sqlText, params = []) {
    const sql = String(sqlText).replace(/\s+/g, " ").trim();
    log.push({ sql, params });
    const rule = rules.find((candidate) => candidate.pattern.test(sql));
    const rows = rule ? (typeof rule.rows === "function" ? rule.rows(params) : rule.rows) : [];
    return { rows, rowCount: rows.length };
  }
  database.runQuery = fakeQuery;
  database.runInTransaction = async (callback) => callback({ query: fakeQuery });
  const app = require("../src/app");
  const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const token = jsonWebToken.sign({ sub: ADMIN_ID, roles: ["admin"] }, process.env.JWT_SECRET, { algorithm: "HS256", issuer: "sheserv-api", expiresIn: "5m" });

  let server;
  let baseUrl;
  before(async () => {
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((resolve) => server.close(resolve)));
  beforeEach(() => {
    log = [];
    rules = [
      { pattern: /^SELECT id FROM users WHERE id=\$1 AND roles @> ARRAY\['admin'\]/, rows: [{ id: ADMIN_ID }] },
      { pattern: /^SELECT \* FROM payment_settings WHERE scope_key=\$1/, rows: [GLOBAL] },
      { pattern: /^SELECT \* FROM payment_settings$/, rows: [GLOBAL] },
      { pattern: /FROM municipalities/, rows: [{ ibge_code: "3128709", name: "Guaxupé", uf: "MG" }] },
    ];
  });

  const call = async (method, path, body) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  test("salvar com margem negativa é recusado e nada muda", async () => {
    const response = await call("PUT", "/api/v1/admin/payments/settings/global", { changes: { fee_fixed_cents: 0, fee_percent_bps: 100 }, reason: "teste" });
    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, "unsafe_settings");
    assert.equal(log.filter((entry) => /^UPDATE payment_settings/.test(entry.sql)).length, 0);
    assert.equal(log.filter((entry) => /^INSERT INTO payment_settings_audit/.test(entry.sql)).length, 0);
  });

  test("salvar grava a mudança, sobe a versão e registra auditoria com valor anterior e novo", async () => {
    const response = await call("PUT", "/api/v1/admin/payments/settings/global", { changes: { fee_percent_bps: 450 }, reason: "Teste A/B" });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const update = log.find((entry) => /^UPDATE payment_settings SET/.test(entry.sql));
    assert.match(update.sql, /fee_percent_bps=\$2, version=version\+1/);
    assert.deepEqual(update.params, ["global", 450, ADMIN_ID]);
    const audit = log.find((entry) => /^INSERT INTO payment_settings_audit/.test(entry.sql));
    assert.deepEqual(audit.params, ["global", "fee_percent_bps", "400", "450", "Teste A/B", ADMIN_ID]);
  });

  test("motivo é obrigatório", async () => {
    const response = await call("PUT", "/api/v1/admin/payments/settings/global", { changes: { fee_percent_bps: 450 } });
    assert.equal(response.status, 422);
  });

  test("aplicar às existentes exige confirmar o aviso às clientes", async () => {
    const response = await call("POST", "/api/v1/admin/payments/reprice", { scopeKey: "global", reason: "x123" });
    assert.equal(response.status, 422);
  });
});
