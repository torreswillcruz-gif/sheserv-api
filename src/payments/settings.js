// Configuração de pagamentos: linha global + override por cidade (NULL na
// cidade = herda da global). Nada de valor fixo em código: tudo vem daqui.
// Cada cobrança e assinatura grava o snapshot do que foi usado; o extrato é
// reconstruído desse snapshot, nunca da configuração atual.

const SETTING_FIELDS = [
  "fee_fixed_cents", "fee_percent_bps", "fee_payer", "rounding_mode",
  "activation_fee_cents", "activation_fee_installments", "free_max_active_subscribers",
  "standard_price_cents", "pro_price_cents",
  "retry_max_attempts", "retry_interval_days", "suspension_grace_days",
  "entitlement_refund_window_hours", "payout_interval", "payout_day",
  "settlement_days_card", "settlement_days_pix",
  "gateway_cost_card_fixed_cents", "gateway_cost_card_bps", "gateway_cost_pix_fixed_cents", "gateway_cost_pix_bps",
  "mock_failure_rate_bps", "mock_latency_ms",
];
// Só na configuração global
const GLOBAL_ONLY_FIELDS = ["mock_failure_rate_bps", "mock_latency_ms"];

function mergeSettings(globalRow, cityRow) {
  if (!globalRow) throw new Error("payment_settings sem a linha global: rode as migrações.");
  const merged = {};
  for (const field of SETTING_FIELDS) {
    const cityValue = cityRow && !GLOBAL_ONLY_FIELDS.includes(field) ? cityRow[field] : null;
    merged[field] = cityValue ?? globalRow[field];
  }
  merged._meta = {
    cityCode: cityRow?.scope_key ?? null,
    globalVersion: globalRow.version,
    cityVersion: cityRow?.version ?? null,
  };
  return merged;
}

async function loadEffectiveSettings(client, cityCode) {
  const { rows } = await client.query(
    "SELECT * FROM payment_settings WHERE scope_key = 'global' OR scope_key = $1",
    [cityCode ?? "global"]
  );
  return mergeSettings(rows.find((row) => row.scope_key === "global"), rows.find((row) => row.scope_key !== "global"));
}

async function providerCityCode(client, providerId) {
  const { rows } = await client.query("SELECT city_code FROM provider_profiles WHERE user_id=$1", [providerId]);
  return rows[0]?.city_code ?? null;
}

async function loadProviderSettings(client, providerId) {
  return loadEffectiveSettings(client, await providerCityCode(client, providerId));
}

// O que vai gravado em cada cobrança/assinatura (sem os parâmetros do mock)
function snapshotOf(settings) {
  const snapshot = {};
  for (const field of SETTING_FIELDS) if (!GLOBAL_ONLY_FIELDS.includes(field)) snapshot[field] = settings[field];
  snapshot._meta = settings._meta;
  return snapshot;
}

// Versão gravada em settings_version: a da cidade quando há override, senão a global
const settingsVersion = (settings) => settings._meta.cityVersion ?? settings._meta.globalVersion;

// Calendário de repasse de uma prestadora: o dela, ou o da cidade
function payoutSchedule(settings, account) {
  return {
    payoutInterval: account?.payout_interval ?? settings.payout_interval,
    payoutDay: account?.payout_day ?? settings.payout_day,
  };
}

module.exports = {
  SETTING_FIELDS,
  GLOBAL_ONLY_FIELDS,
  mergeSettings,
  loadEffectiveSettings,
  loadProviderSettings,
  providerCityCode,
  snapshotOf,
  settingsVersion,
  payoutSchedule,
};
