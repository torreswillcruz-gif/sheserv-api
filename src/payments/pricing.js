// Preço que a cliente vê no catálogo: com a taxa da SheServe embutida (nunca
// como linha separada), para prestadoras que recebem pelo app. O cálculo é o
// mesmo da cobrança, então o valor exibido é o valor cobrado.
const { priceBreakdown } = require("./money");
const { loadEffectiveSettings } = require("./settings");
const { centsFromDecimal } = require("./runtime");

async function applyCustomerPrices(client, providers) {
  if (!providers.length) return providers;
  const { rows } = await client.query(
    `SELECT pp.user_id, pp.city_code,
       (SELECT COUNT(*)::int FROM subscription_plans p WHERE p.provider_id = pp.user_id AND p.status = 'ativo') AS plans
     FROM provider_profiles pp
     JOIN provider_payment_accounts a ON a.provider_id = pp.user_id AND a.status = 'aprovada'
     WHERE pp.user_id = ANY($1::uuid[])`,
    [providers.map((provider) => provider.id)]
  );
  if (!rows.length) return providers;
  const settingsByCity = new Map();
  const inApp = new Map(rows.map((row) => [row.user_id, row]));
  for (const provider of providers) {
    const account = inApp.get(provider.id);
    if (!account) continue;
    const cityKey = account.city_code ?? "global";
    if (!settingsByCity.has(cityKey)) settingsByCity.set(cityKey, await loadEffectiveSettings(client, account.city_code));
    const settings = settingsByCity.get(cityKey);
    provider.receivesInApp = true;
    provider.subscriptionPlansCount = account.plans;
    for (const service of provider.services ?? []) {
      const priceCents = centsFromDecimal(String(service.basePrice ?? 0));
      if (priceCents <= 0) continue;
      const { totalCents } = priceBreakdown(priceCents, settings);
      service.customerPriceCents = totalCents;
      service.basePrice = totalCents / 100; // campo legado (número) com o preço final
    }
  }
  return providers;
}

module.exports = { applyCustomerPrices };
