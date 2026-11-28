// Planos de assinatura da prestadora: criação (com cálculo no servidor),
// sugestão a partir do histórico das clientes, cotação ao vivo e o que a
// cliente vê no checkout.
const { ApiError } = require("../errors");
const { centsFromDecimal } = require("./runtime");
const { planImpact } = require("./money");
const { cycleStart, brasiliaDateKey } = require("./dates");
const { loadProviderSettings } = require("./settings");
const { providerEligibility, seatUsage, chargeActivationIfFirst, ELIGIBILITY_LABELS } = require("./accounts");

// Serviços que podem entrar num plano: da prestadora, ativos, de preço fixo
// e atendidos no espaço dela (assinatura só para estabelecimento físico).
async function loadPlanServices(client, providerId, serviceIds) {
  const { rows } = await client.query(
    `SELECT id, title, base_price, duration_minutes FROM services
     WHERE provider_id=$1 AND id = ANY($2::uuid[]) AND active AND NOT hidden_by_admin
       AND service_location='at_provider' AND price_type='fixed'`,
    [providerId, serviceIds]
  );
  return new Map(rows.map((row) => [row.id, row]));
}

function avulsoItems(items, servicesById) {
  return items.map((item) => ({
    unitPriceCents: centsFromDecimal(servicesById.get(item.serviceId).base_price),
    sessions: item.sessionsPerCycle,
  }));
}

// Cotação: o que a prestadora recebe, o que a cliente paga e a economia
// contra o avulso pelos preços cadastrados. Mesmo cálculo da criação.
async function quotePlan(client, providerId, { priceCents, items }) {
  const settings = await loadProviderSettings(client, providerId);
  const servicesById = await loadPlanServices(client, providerId, items.map((item) => item.serviceId));
  const unknown = items.find((item) => !servicesById.has(item.serviceId));
  if (unknown)
    throw new ApiError(422, "validation_error", "Serviço inválido para plano.", {
      items: "Use serviços de preço fixo atendidos no seu espaço.",
    });
  const impact = planImpact(priceCents, settings, avulsoItems(items, servicesById));
  return {
    priceCents,
    providerReceivesCents: impact.providerReceivesCents,
    customerPaysCents: impact.customerPaysCents,
    avulsoCents: impact.avulsoCents,
    savingsCents: impact.savingsCents,
    cheaperThanAvulso: impact.savingsCents >= 0,
    feePayer: settings.fee_payer,
  };
}

async function createPlan(client, providerId, data) {
  const eligibility = await providerEligibility(client, providerId);
  if (!eligibility.eligible)
    throw new ApiError(409, "provider_not_eligible", "Complete o cadastro para oferecer planos.", {
      missing: eligibility.missing.map((key) => ELIGIBILITY_LABELS[key]).join("; "),
    });
  const quote = await quotePlan(client, providerId, data);
  if (!quote.cheaperThanAvulso)
    throw new ApiError(422, "plan_pricier_than_avulso", "O plano ficaria mais caro para a cliente do que o avulso.", {
      priceCents: `Com este preço a cliente pagaria ${quote.customerPaysCents} contra ${quote.avulsoCents} avulso.`,
    });
  const { rows } = await client.query(
    `INSERT INTO subscription_plans (provider_id,name,description,price_cents,interval_unit,interval_count,max_subscribers,reserved_slot)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [providerId, data.name, data.description ?? null, data.priceCents, data.intervalUnit ?? "month",
     data.intervalCount ?? 1, data.maxSubscribers ?? null, data.reservedSlot ?? null]
  );
  for (const item of data.items) {
    await client.query(
      "INSERT INTO subscription_plan_items (plan_id,service_id,sessions_per_cycle) VALUES ($1,$2,$3)",
      [rows[0].id, item.serviceId, item.sessionsPerCycle]
    );
  }
  // primeira vez que ativa planos: taxa de ativação (descontada dos repasses)
  const activation = await chargeActivationIfFirst(client, providerId);
  return { planId: rows[0].id, activation };
}

async function updatePlanStatus(client, providerId, planId, status) {
  const { rows } = await client.query(
    "UPDATE subscription_plans SET status=$3, updated_at=now() WHERE id=$1 AND provider_id=$2 RETURNING id",
    [planId, providerId, status]
  );
  if (!rows[0]) throw new ApiError(404, "not_found", "Plano não encontrado.");
}

// Planos com itens, preços calculados agora (para novas assinantes) e vagas
async function listPlans(client, providerId, { onlyActive = false } = {}) {
  const settings = await loadProviderSettings(client, providerId);
  const { rows } = await client.query(
    `SELECT p.*,
       (SELECT COUNT(*)::int FROM subscriptions s WHERE s.plan_id=p.id AND s.status IN ('pendente','ativa','em_retentativa')) AS subscribers,
       COALESCE((SELECT json_agg(json_build_object(
          'serviceId', i.service_id, 'title', sv.title, 'sessionsPerCycle', i.sessions_per_cycle,
          'unitPrice', sv.base_price::text, 'durationMinutes', sv.duration_minutes) ORDER BY sv.title)
        FROM subscription_plan_items i JOIN services sv ON sv.id=i.service_id WHERE i.plan_id=p.id), '[]') AS items
     FROM subscription_plans p
     WHERE p.provider_id=$1 AND ($2::boolean IS FALSE OR p.status='ativo') AND p.status <> 'arquivado'
     ORDER BY p.created_at`,
    [providerId, onlyActive]
  );
  return rows.map((plan) => {
    const items = plan.items.map((item) => ({ ...item, unitPriceCents: centsFromDecimal(item.unitPrice), unitPrice: undefined }));
    const impact = planImpact(plan.price_cents, settings, items.map((item) => ({ unitPriceCents: item.unitPriceCents, sessions: item.sessionsPerCycle })));
    return {
      id: plan.id,
      name: plan.name,
      description: plan.description,
      status: plan.status,
      intervalUnit: plan.interval_unit,
      intervalCount: plan.interval_count,
      maxSubscribers: plan.max_subscribers,
      reservedSlot: plan.reserved_slot,
      subscribers: plan.subscribers,
      items,
      priceCents: plan.price_cents,
      providerReceivesCents: impact.providerReceivesCents,
      customerPaysCents: impact.customerPaysCents,
      avulsoCents: impact.avulsoCents,
      savingsCents: impact.savingsCents,
    };
  });
}

// O que a cliente vê: valor total único (sem linha de taxa).
function customerPlanView(plan) {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    intervalUnit: plan.intervalUnit,
    intervalCount: plan.intervalCount,
    reservedSlot: plan.reservedSlot,
    items: plan.items.map((item) => ({ serviceId: item.serviceId, title: item.title, sessionsPerCycle: item.sessionsPerCycle, durationMinutes: item.durationMinutes })),
    totalCents: plan.customerPaysCents,
    avulsoCents: plan.avulsoCents,
    savingsCents: plan.savingsCents,
    full: plan.maxSubscribers != null && plan.subscribers >= plan.maxSubscribers,
  };
}

async function publicPlans(client, providerId) {
  const eligibility = await providerEligibility(client, providerId);
  if (!eligibility.eligible) return { acceptingSubscribers: false, plans: [] };
  const settings = await loadProviderSettings(client, providerId);
  const seats = await seatUsage(client, providerId, settings);
  const plans = await listPlans(client, providerId, { onlyActive: true });
  return { acceptingSubscribers: !seats.full, plans: plans.map(customerPlanView) };
}

// Checkout: total, o que está incluso, dia da cobrança, como cancelar,
// economia e horário reservado. Tudo calculado pelo servidor.
async function checkoutPreview(client, planId, customerId) {
  const { rows } = await client.query("SELECT provider_id FROM subscription_plans WHERE id=$1 AND status='ativo'", [planId]);
  if (!rows[0]) throw new ApiError(404, "plan_unavailable", "Este plano não está disponível.");
  const providerId = rows[0].provider_id;
  const { plans, acceptingSubscribers } = await publicPlans(client, providerId);
  const plan = plans.find((candidate) => candidate.id === planId);
  if (!plan) throw new ApiError(404, "plan_unavailable", "Este plano não está disponível.");
  const { rows: providers } = await client.query("SELECT name FROM users WHERE id=$1", [providerId]);
  const { rows: subscribed } = await client.query(
    "SELECT 1 FROM subscriptions WHERE customer_id=$1 AND plan_id=$2 AND status <> 'cancelada'",
    [customerId, planId]
  );
  const now = new Date();
  const anchorDay = Number(brasiliaDateKey(now).slice(8, 10));
  const nextCharge = cycleStart(now, 1, { intervalUnit: plan.intervalUnit, intervalCount: plan.intervalCount, anchorDay });
  return {
    ...plan,
    providerId,
    providerName: providers[0]?.name ?? "",
    acceptingSubscribers,
    alreadySubscribed: Boolean(subscribed[0]),
    billingDay: plan.intervalUnit === "month" ? anchorDay : null,
    firstChargeToday: true,
    nextChargeDate: brasiliaDateKey(nextCharge),
    paymentMethods: ["cartao"],
    howToCancel: "Cancele quando quiser em Minhas assinaturas. O cancelamento vale para o próximo ciclo: suas sessões continuam até o fim do ciclo já pago.",
  };
}

// Sugestão de plano a partir do histórico das clientes (nunca formulário em
// branco): serviços do espaço com clientes que voltam, com a frequência média.
async function planSuggestions(client, providerId) {
  const { rows } = await client.query(
    `WITH visits AS (
       SELECT o.customer_id, o.service_id, COUNT(*)::int AS total,
              GREATEST(1, CEIL(EXTRACT(EPOCH FROM (now() - MIN(o.scheduled_at))) / (30 * 86400)))::int AS months
       FROM orders o
       WHERE o.provider_id=$1 AND o.status IN ('completed','accepted','in_progress','on_the_way')
         AND o.scheduled_at > now() - interval '120 days'
       GROUP BY o.customer_id, o.service_id
     )
     SELECT s.id AS service_id, s.title, s.base_price::text AS base_price,
            COUNT(*) FILTER (WHERE v.total >= 2)::int AS returning_customers,
            ROUND(AVG(v.total::numeric / v.months), 1)::text AS avg_monthly,
            (ARRAY_AGG(u.name ORDER BY v.total DESC))[1:3] AS top_customers
     FROM visits v
     JOIN services s ON s.id = v.service_id AND s.active AND s.service_location='at_provider' AND s.price_type='fixed'
     JOIN users u ON u.id = v.customer_id
     GROUP BY s.id
     ORDER BY returning_customers DESC, AVG(v.total::numeric / v.months) DESC
     LIMIT 3`,
    [providerId]
  );
  const suggestions = rows.map((row) => {
    const sessions = Math.min(8, Math.max(1, Math.round(Number(row.avg_monthly))));
    const unitPriceCents = centsFromDecimal(row.base_price);
    return {
      source: "history",
      serviceId: row.service_id,
      name: `${row.title} ${sessions}x por mês`,
      sessionsPerCycle: sessions,
      // ela recebe o mesmo que no avulso; a cliente economiza as taxas das sessões avulsas
      priceCents: unitPriceCents * sessions,
      reason: row.returning_customers > 0
        ? `${row.returning_customers} cliente(s) voltaram para ${row.title}, em média ${String(row.avg_monthly).replace(".", ",")}x por mês. Quem mais agenda: ${(row.top_customers ?? []).filter(Boolean).join(", ")}.`
        : `Clientes agendaram ${row.title} em média ${String(row.avg_monthly).replace(".", ",")}x por mês.`,
    };
  });
  if (suggestions.length) return suggestions;
  // Sem histórico: parte do serviço do espaço, uma vez por semana
  const { rows: services } = await client.query(
    `SELECT id, title, base_price::text AS base_price FROM services
     WHERE provider_id=$1 AND active AND NOT hidden_by_admin AND service_location='at_provider' AND price_type='fixed'
     ORDER BY base_price LIMIT 1`,
    [providerId]
  );
  return services.map((service) => ({
    source: "default",
    serviceId: service.id,
    name: `${service.title} toda semana`,
    sessionsPerCycle: 4,
    priceCents: centsFromDecimal(service.base_price) * 4,
    reason: "Ainda não há histórico de clientes que voltam. Planos semanais costumam ser os mais procurados.",
  }));
}

module.exports = { quotePlan, createPlan, updatePlanStatus, listPlans, publicPlans, checkoutPreview, planSuggestions, customerPlanView };
