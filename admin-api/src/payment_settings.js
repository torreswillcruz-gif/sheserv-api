// Regras da seção Pagamentos do admin, sem banco (testáveis):
// - quais campos existem, seus limites e quais só valem na configuração global;
// - configuração efetiva (global + override da cidade);
// - impacto antes de salvar para planos de R$ 30, R$ 80 e R$ 150: quanto a
//   cliente paga, quanto a prestadora recebe, custo do gateway, margem e
//   diferença para o avulso;
// - recusa salvar se a margem ficar negativa em qualquer faixa ou se o plano
//   ficar mais caro que o avulso.
// O cálculo do dinheiro é o mesmo da API (payments_math.js é cópia de
// src/payments/money.js; um teste garante que não divergem).
const { planImpact, MoneyError } = require("./payments_math");

const IMPACT_BANDS_CENTS = [3000, 8000, 15000];
const DEFAULT_REFERENCE_SESSIONS = 4;

// campo → { tipo, mínimo, máximo, rótulo }
const FIELDS = {
  fee_fixed_cents: { type: "int", min: 0, max: 10000, label: "Taxa fixa (centavos)" },
  fee_percent_bps: { type: "int", min: 0, max: 5000, label: "Taxa percentual (pontos-base)" },
  fee_payer: { type: "enum", values: ["cliente", "prestadora"], label: "Quem paga a taxa" },
  rounding_mode: { type: "enum", values: ["half_up", "half_even", "floor", "ceil"], label: "Arredondamento" },
  activation_fee_cents: { type: "int", min: 0, max: 1000000, label: "Taxa de ativação (centavos)" },
  activation_fee_installments: { type: "int", min: 1, max: 52, label: "Ativação em quantos repasses" },
  free_max_active_subscribers: { type: "int", min: 0, max: 10000, label: "Limite de assinantes do Free" },
  standard_price_cents: { type: "int", min: 0, max: 1000000, label: "Preço do Standard (centavos)" },
  pro_price_cents: { type: "int", min: 0, max: 1000000, label: "Preço do Pro (centavos)" },
  retry_max_attempts: { type: "int", min: 0, max: 10, label: "Número de retentativas" },
  retry_interval_days: { type: "int", min: 1, max: 30, label: "Intervalo entre retentativas (dias)" },
  suspension_grace_days: { type: "int", min: 0, max: 180, label: "Suspensa até cancelar (dias)" },
  entitlement_refund_window_hours: { type: "int", min: 0, max: 720, label: "Prazo de cancelamento que devolve (horas)" },
  payout_interval: { type: "enum", values: ["semanal", "mensal"], label: "Calendário de repasse" },
  payout_day: { type: "int", min: 1, max: 28, label: "Dia do repasse" },
  settlement_days_card: { type: "int", min: 0, max: 60, label: "Liquidação do cartão (dias)" },
  settlement_days_pix: { type: "int", min: 0, max: 60, label: "Liquidação do Pix (dias)" },
  gateway_cost_card_fixed_cents: { type: "int", min: 0, max: 10000, label: "Custo fixo do cartão (centavos)" },
  gateway_cost_card_bps: { type: "int", min: 0, max: 2000, label: "Custo do cartão (pontos-base)" },
  gateway_cost_pix_fixed_cents: { type: "int", min: 0, max: 10000, label: "Custo fixo do Pix (centavos)" },
  gateway_cost_pix_bps: { type: "int", min: 0, max: 2000, label: "Custo do Pix (pontos-base)" },
  mock_failure_rate_bps: { type: "int", min: 0, max: 10000, label: "Mock: taxa de recusa (pontos-base)", globalOnly: true },
  mock_latency_ms: { type: "int", min: 0, max: 30000, label: "Mock: latência (ms)", globalOnly: true },
};
const FIELD_NAMES = Object.keys(FIELDS);

class SettingsValidationError extends Error {
  constructor(details) {
    super("Configuração inválida.");
    this.details = details;
  }
}

// Valida as mudanças pedidas. Na cidade, null = volta a herdar da global.
function validateChanges(scopeKey, changes) {
  const errors = {};
  const isGlobal = scopeKey === "global";
  if (!isGlobal && !/^\d{7}$/.test(scopeKey)) errors.scopeKey = "Escopo inválido.";
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    errors.changes = "Envie um objeto de mudanças.";
    throw new SettingsValidationError(errors);
  }
  for (const [field, value] of Object.entries(changes)) {
    const spec = FIELDS[field];
    if (!spec) { errors[field] = "Campo desconhecido."; continue; }
    if (spec.globalOnly && !isGlobal) { errors[field] = "Só vale na configuração global."; continue; }
    if (value === null) {
      if (isGlobal) errors[field] = "A configuração global não pode ficar vazia.";
      continue;
    }
    if (spec.type === "int" && (!Number.isSafeInteger(value) || value < spec.min || value > spec.max))
      errors[field] = `Inteiro entre ${spec.min} e ${spec.max}.`;
    if (spec.type === "enum" && !spec.values.includes(value)) errors[field] = `Use: ${spec.values.join(", ")}.`;
  }
  if (Object.keys(errors).length) throw new SettingsValidationError(errors);
}

function mergeSettings(globalRow, cityRow) {
  const merged = {};
  for (const field of FIELD_NAMES) {
    const cityValue = cityRow && !FIELDS[field].globalOnly ? cityRow[field] : null;
    merged[field] = cityValue ?? globalRow[field];
  }
  return merged;
}

// O repasse semanal só sai em dia útil (1 = segunda ... 5 = sexta)
function crossFieldErrors(settings) {
  const errors = {};
  if (settings.payout_interval === "semanal" && (settings.payout_day < 1 || settings.payout_day > 5))
    errors.payout_day = "No repasse semanal, use 1 (segunda) a 5 (sexta).";
  return errors;
}

// Avulso de referência de uma faixa: o mesmo valor em sessões avulsas, pelo
// número de sessões típico dos planos reais da cidade (mediana; 4 sem planos)
function referenceItems(priceCents, sessions) {
  const unit = Math.floor(priceCents / sessions);
  const remainder = priceCents - unit * sessions;
  return [
    { unitPriceCents: unit, sessions: sessions - remainder },
    { unitPriceCents: unit + 1, sessions: remainder },
  ].filter((item) => item.sessions > 0);
}

function medianSessions(realPlans) {
  const counts = realPlans.map((plan) => plan.items.reduce((sum, item) => sum + item.sessions, 0)).sort((a, b) => a - b);
  if (!counts.length) return DEFAULT_REFERENCE_SESSIONS;
  return counts[Math.floor(counts.length / 2)];
}

// realPlans: [{ id, name, providerName, priceCents, items: [{ unitPriceCents, sessions }] }]
// com os preços avulsos cadastrados pelas prestadoras
function analyzeImpact(settings, realPlans = []) {
  const reasons = [];
  const sessions = medianSessions(realPlans);
  const bands = IMPACT_BANDS_CENTS.map((priceCents) => {
    try {
      const impact = planImpact(priceCents, settings, referenceItems(priceCents, sessions));
      if (impact.marginCents < 0) reasons.push(`Margem negativa no plano de R$ ${priceCents / 100}.`);
      if (impact.savingsCents < 0) reasons.push(`O plano de R$ ${priceCents / 100} fica mais caro que o avulso.`);
      return { ...impact, referenceSessions: sessions, ok: impact.marginCents >= 0 && impact.savingsCents >= 0 };
    } catch (error) {
      if (!(error instanceof MoneyError)) throw error;
      reasons.push(`Plano de R$ ${priceCents / 100}: ${error.message}`);
      return { priceCents, error: error.message, ok: false };
    }
  });
  const planViolations = [];
  for (const plan of realPlans) {
    try {
      const impact = planImpact(plan.priceCents, settings, plan.items);
      if (impact.savingsCents < 0 || impact.marginCents < 0) planViolations.push({ ...plan, ...impact });
    } catch (error) {
      if (!(error instanceof MoneyError)) throw error;
      planViolations.push({ ...plan, error: error.message });
    }
  }
  if (planViolations.length)
    reasons.push(`${planViolations.length} plano(s) ativo(s) ficariam mais caros que o avulso ou com margem negativa.`);
  const cross = crossFieldErrors(settings);
  for (const message of Object.values(cross)) reasons.push(message);
  return {
    bands,
    referenceSessions: sessions,
    plansChecked: realPlans.length,
    planViolations: planViolations.slice(0, 20),
    canSave: reasons.length === 0,
    reasons,
  };
}

module.exports = {
  FIELDS,
  FIELD_NAMES,
  IMPACT_BANDS_CENTS,
  SettingsValidationError,
  validateChanges,
  mergeSettings,
  analyzeImpact,
  referenceItems,
  medianSessions,
};
