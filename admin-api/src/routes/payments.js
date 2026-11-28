// Seção Pagamentos do painel admin.
//   GET  /payments/settings            global, cidades (override e efetiva), gateway ativo
//   POST /payments/settings/preview    impacto da mudança (faixas R$ 30/80/150 e planos reais)
//   PUT  /payments/settings/:scopeKey  salva (recusa se o impacto não passar) + auditoria
//   POST /payments/reprice             aplica a configuração atual às assinaturas existentes
//                                      (ação separada e explícita; vale no próximo ciclo)
//   GET  /payments/audit               log: quem, quando, valor anterior e novo, escopo
//
// Configuração nunca é retroativa: cada cobrança grava o snapshot usado, e
// assinatura ativa mantém o preço contratado até o "aplicar às existentes".
const paymentsAdminRouter = require("express").Router();
const { z } = require("zod");
const { runQuery, runInTransaction } = require("../db");
const { ApiError, asyncHandler } = require("../errors");
const { priceBreakdown } = require("../payments_math");
const {
  FIELDS, FIELD_NAMES, IMPACT_BANDS_CENTS, SettingsValidationError, validateChanges, mergeSettings, analyzeImpact,
} = require("../payment_settings");

const gatewayName = () => (process.env.PAYMENT_GATEWAY || "mock").trim().toLowerCase();

function rethrowValidation(error) {
  if (error instanceof SettingsValidationError) throw new ApiError(422, "validation_error", error.message, error.details);
  throw error;
}

async function loadRows(client) {
  const { rows } = await client.query("SELECT * FROM payment_settings");
  const globalRow = rows.find((row) => row.scope_key === "global");
  if (!globalRow) throw new ApiError(503, "not_migrated", "Rode as migrações da marketplace-api (payment_settings).");
  return { globalRow, cityRows: new Map(rows.filter((row) => row.scope_key !== "global").map((row) => [row.scope_key, row])) };
}

const pick = (row) => (row ? Object.fromEntries(FIELD_NAMES.map((field) => [field, row[field] ?? null])) : null);

// Valor em reais no texto do audit/aviso sem float
const centavos = (value) => `${Math.trunc(value / 100)},${String(value % 100).padStart(2, "0")}`;

// Planos ativos com os preços avulsos cadastrados (na cidade, ou em todas)
async function realPlans(client, scopeKey) {
  const { rows } = await client.query(
    `SELECT p.id, p.name, p.price_cents, u.name AS provider_name, pp.city_code,
       json_agg(json_build_object('unit', s.base_price::text, 'sessions', i.sessions_per_cycle)) AS items
     FROM subscription_plans p
     JOIN users u ON u.id = p.provider_id
     JOIN provider_profiles pp ON pp.user_id = p.provider_id
     JOIN subscription_plan_items i ON i.plan_id = p.id
     JOIN services s ON s.id = i.service_id
     WHERE p.status = 'ativo' AND ($1::text = 'global' OR pp.city_code = $1::text)
     GROUP BY p.id, u.name, pp.city_code`,
    [scopeKey]
  );
  const toCents = (text) => {
    const [whole, fraction = ""] = String(text).split(".");
    return Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2));
  };
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    providerName: row.provider_name,
    cityCode: row.city_code,
    priceCents: row.price_cents,
    items: row.items.map((item) => ({ unitPriceCents: toCents(item.unit), sessions: item.sessions })),
  }));
}

// Na configuração global, o impacto vale para cidades sem override do campo:
// confere a global e cada cidade com a configuração resultante.
async function impactFor(client, scopeKey, changes) {
  const { globalRow, cityRows } = await loadRows(client);
  const nextGlobal = scopeKey === "global" ? { ...globalRow, ...changes } : globalRow;
  const scopes = scopeKey === "global" ? ["global", ...cityRows.keys()] : [scopeKey];
  const results = {};
  for (const scope of scopes) {
    const cityRow = scope === "global" ? null : { ...(cityRows.get(scope) ?? {}), ...(scope === scopeKey ? changes : {}) };
    const effective = mergeSettings(nextGlobal, cityRow);
    const plans = await realPlans(client, scope);
    const relevantPlans = scope === "global" ? plans.filter((plan) => !plan.cityCode || !cityRows.has(plan.cityCode)) : plans;
    results[scope] = { effective, ...analyzeImpact(effective, relevantPlans) };
  }
  const primary = results[scopeKey];
  const others = Object.entries(results).filter(([scope]) => scope !== scopeKey);
  const otherReasons = others.flatMap(([scope, result]) => result.reasons.map((reason) => `${scope}: ${reason}`));
  return {
    scopeKey,
    ...primary,
    canSave: primary.canSave && otherReasons.length === 0,
    reasons: [...primary.reasons, ...otherReasons],
    affectedScopes: Object.keys(results),
  };
}

paymentsAdminRouter.get("/payments/settings", asyncHandler(async (_request, response) => {
  const client = { query: runQuery };
  const { globalRow, cityRows } = await loadRows(client);
  const { rows: cities } = await runQuery("SELECT ibge_code, name, uf FROM municipalities WHERE launched ORDER BY name");
  response.json({
    gateway: gatewayName(),
    demoMode: gatewayName() === "mock",
    fields: Object.fromEntries(FIELD_NAMES.map((field) => [field, FIELDS[field]])),
    impactBandsCents: IMPACT_BANDS_CENTS,
    global: { ...pick(globalRow), version: globalRow.version, updatedAt: globalRow.updated_at },
    cities: cities.map((city) => {
      const row = cityRows.get(city.ibge_code);
      return {
        cityCode: city.ibge_code,
        name: city.name,
        uf: city.uf,
        override: row ? { ...pick(row), version: row.version, updatedAt: row.updated_at } : null,
        effective: mergeSettings(globalRow, row),
      };
    }),
  });
}));

const previewSchema = z.object({
  scopeKey: z.string().regex(/^(global|\d{7})$/),
  changes: z.record(z.string(), z.union([z.number(), z.string(), z.null()])),
}).strict();

paymentsAdminRouter.post("/payments/settings/preview", asyncHandler(async (request, response) => {
  const { scopeKey, changes } = previewSchema.parse(request.body);
  try { validateChanges(scopeKey, changes); } catch (error) { rethrowValidation(error); }
  response.json(await impactFor({ query: runQuery }, scopeKey, changes));
}));

const saveSchema = z.object({
  changes: z.record(z.string(), z.union([z.number(), z.string(), z.null()])),
  reason: z.string().trim().min(3).max(500),
}).strict();

paymentsAdminRouter.put("/payments/settings/:scopeKey", asyncHandler(async (request, response) => {
  const scopeKey = request.params.scopeKey;
  const { changes, reason } = saveSchema.parse(request.body);
  try { validateChanges(scopeKey, changes); } catch (error) { rethrowValidation(error); }
  if (scopeKey !== "global") {
    const { rows } = await runQuery("SELECT 1 FROM municipalities WHERE ibge_code=$1", [scopeKey]);
    if (!rows[0]) throw new ApiError(404, "not_found", "Cidade não encontrada.");
  }

  const result = await runInTransaction(async (client) => {
    await client.query("LOCK TABLE payment_settings IN SHARE ROW EXCLUSIVE MODE");
    const impact = await impactFor(client, scopeKey, changes);
    if (!impact.canSave)
      throw new ApiError(422, "unsafe_settings", "A configuração não foi salva: veja os motivos.", { reasons: impact.reasons.join(" | ") });

    const { rows: currentRows } = await client.query("SELECT * FROM payment_settings WHERE scope_key=$1", [scopeKey]);
    const current = currentRows[0] ?? null;
    const changed = Object.entries(changes).filter(([field, value]) => (current?.[field] ?? null) !== value);
    if (!changed.length) return { changed: 0, impact };

    if (!current) {
      await client.query("INSERT INTO payment_settings (scope_key, version) VALUES ($1, 0)", [scopeKey]);
    }
    const assignments = changed.map(([field], index) => `${field}=$${index + 2}`);
    await client.query(
      `UPDATE payment_settings SET ${assignments.join(", ")}, version=version+1, updated_by=$${changed.length + 2}, updated_at=now()
       WHERE scope_key=$1`,
      [scopeKey, ...changed.map(([, value]) => value), request.user.id]
    );
    for (const [field, value] of changed) {
      await client.query(
        `INSERT INTO payment_settings_audit (scope_key,field,old_value,new_value,action,reason,changed_by)
         VALUES ($1,$2,$3,$4,'update',$5,$6)`,
        [scopeKey, field, JSON.stringify(current?.[field] ?? null), JSON.stringify(value), reason, request.user.id]
      );
    }
    return { changed: changed.length, impact };
  });
  response.json(result);
}));

const repriceSchema = z.object({
  scopeKey: z.string().regex(/^(global|\d{7})$/),
  // a tela exige marcar "vou comunicar as clientes"
  confirmCustomerNotice: z.literal(true),
  reason: z.string().trim().min(3).max(500),
}).strict();

// Aplica a configuração atual às assinaturas em curso do escopo: grava o novo
// preço para valer no PRÓXIMO ciclo (a API leva ao gateway) e avisa as
// clientes no app. O ciclo já pago não muda.
paymentsAdminRouter.post("/payments/reprice", asyncHandler(async (request, response) => {
  const { scopeKey, reason } = repriceSchema.parse(request.body);
  const result = await runInTransaction(async (client) => {
    const { globalRow, cityRows } = await loadRows(client);
    const { rows: subscriptions } = await client.query(
      `SELECT s.id, s.customer_id, s.total_cents, s.fee_cents, s.provider_amount_cents, s.fee_payer,
              p.price_cents, pp.city_code
       FROM subscriptions s
       JOIN subscription_plans p ON p.id = s.plan_id
       JOIN provider_profiles pp ON pp.user_id = s.provider_id
       WHERE s.status IN ('ativa','em_retentativa') AND NOT s.cancel_at_period_end
         AND ($1::text = 'global' OR pp.city_code = $1::text)
       FOR UPDATE OF s`,
      [scopeKey]
    );
    let affected = 0;
    for (const sub of subscriptions) {
      const cityRow = sub.city_code ? cityRows.get(sub.city_code) : null;
      const effective = mergeSettings(globalRow, cityRow);
      const breakdown = priceBreakdown(sub.price_cents, effective);
      if (breakdown.totalCents === sub.total_cents && breakdown.feeCents === sub.fee_cents && breakdown.feePayer === sub.fee_payer) continue;
      const snapshot = { ...effective };
      delete snapshot.mock_failure_rate_bps;
      delete snapshot.mock_latency_ms;
      snapshot._meta = { cityCode: cityRow?.scope_key ?? null, globalVersion: globalRow.version, cityVersion: cityRow?.version ?? null };
      const pricing = {
        provider_amount_cents: breakdown.providerAmountCents,
        fee_cents: breakdown.feeCents,
        total_cents: breakdown.totalCents,
        fee_payer: breakdown.feePayer,
        settings_snapshot: snapshot,
        settings_version: cityRow?.version ?? globalRow.version,
      };
      await client.query(
        "UPDATE subscriptions SET next_cycle_pricing=$2, next_cycle_pricing_synced_at=NULL, updated_at=now() WHERE id=$1",
        [sub.id, pricing]
      );
      await client.query(
        `INSERT INTO notifications (user_id,type,title,body,data,area)
         VALUES ($1,'subscription_repriced','O valor da sua assinatura vai mudar',$2,$3,'customer')`,
        [sub.customer_id,
         `A partir do próximo ciclo, a assinatura passa de R$ ${centavos(sub.total_cents)} para R$ ${centavos(breakdown.totalCents)}. Você pode cancelar antes, sem custo.`,
         { subscriptionId: sub.id }]
      );
      affected++;
    }
    await client.query(
      `INSERT INTO payment_settings_audit (scope_key,field,old_value,new_value,action,reason,changed_by)
       VALUES ($1,'subscriptions',NULL,$2,'reprice_existing',$3,$4)`,
      [scopeKey, JSON.stringify({ affected, checked: subscriptions.length }), reason, request.user.id]
    );
    return { affected, checked: subscriptions.length };
  });
  response.json(result);
}));

paymentsAdminRouter.get("/payments/audit", asyncHandler(async (request, response) => {
  const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).strict().parse(request.query);
  const { rows } = await runQuery(
    `SELECT a.id, a.scope_key AS "scopeKey", a.field, a.old_value AS "oldValue", a.new_value AS "newValue",
       a.action, a.reason, a.changed_at AS "changedAt", u.name AS "changedBy", u.email AS "changedByEmail"
     FROM payment_settings_audit a LEFT JOIN users u ON u.id = a.changed_by
     ORDER BY a.changed_at DESC LIMIT $1`,
    [limit]
  );
  response.json(rows);
}));

module.exports = { paymentsAdminRouter };
