// Assinaturas: contratação, cancelamento, transições (pela máquina de estados)
// e direitos de agendamento.
const db = require("../db");
const { ApiError } = require("../errors");
const { encryptText, decryptText } = require("../security");
const { notify } = require("../notifications");
const { gateway, afterCommit, fingerprint, assertSameRequest } = require("./runtime");
const { priceBreakdown, buildSplit } = require("./money");
const { cyclePeriod, expectedPayoutDateKey, brasiliaDateKey, DAY_MS } = require("./dates");
const { loadProviderSettings, snapshotOf, settingsVersion, payoutSchedule } = require("./settings");
const { transition, EVENTS, EFFECTS, ENTITLEMENTS_USABLE } = require("./subscriptionStateMachine");
const { reserveDeductions, releaseReservedDeductions } = require("./ledger");
const { loadAccount, providerEligibility, seatUsage, assertCustomerComplete } = require("./accounts");

const periodOptions = (sub) => ({ intervalUnit: sub.interval_unit, intervalCount: sub.interval_count, anchorDay: sub.billing_anchor_day });
const anchorDayOf = (date) => Number(brasiliaDateKey(date).slice(8, 10));

// Split do domínio → formato da interface do gateway
function gatewaySplit(split, recipientId) {
  const itens = [
    { recipientId, parte: "prestadora", valor: split.prestadora },
    { recipientId: null, parte: "plataforma", valor: split.plataforma },
  ].filter((item) => item.valor > 0);
  return { titular: gateway().capabilities().titularDaCobranca, itens };
}

// ---------- Contratar ----------

async function subscribe(customerId, { planId, card }, idempotencyKey) {
  const requestFingerprint = fingerprint({ customerId, planId, card: card.token });
  const { rows: existingRows } = await db.runQuery("SELECT * FROM subscriptions WHERE idempotency_key=$1", [idempotencyKey]);
  if (existingRows[0]) {
    assertSameRequest(existingRows[0].request_fingerprint, requestFingerprint);
    if (!existingRows[0].gateway_subscription_id) await submitSubscription(existingRows[0].id);
    return existingRows[0].id;
  }

  let subscriptionId;
  try {
    subscriptionId = await db.runInTransaction(async (client) => {
      await assertCustomerComplete(client, customerId);
      const { rows: plans } = await client.query("SELECT * FROM subscription_plans WHERE id=$1", [planId]);
      const plan = plans[0];
      if (!plan || plan.status !== "ativo") throw new ApiError(404, "plan_unavailable", "Este plano não está disponível.");
      if (plan.provider_id === customerId) throw new ApiError(422, "self_dealing", "Você não pode assinar o próprio plano.");

      // Trava a conta da prestadora: contagem de vagas serializada
      const account = await loadAccount(client, plan.provider_id, { forUpdate: true });
      const eligibility = await providerEligibility(client, plan.provider_id);
      if (!eligibility.eligible) throw new ApiError(409, "provider_not_eligible", "Esta prestadora não pode receber assinaturas agora.");

      const settings = await loadProviderSettings(client, plan.provider_id);
      const { rows: already } = await client.query(
        "SELECT 1 FROM subscriptions WHERE customer_id=$1 AND provider_id=$2 AND status IN ('pendente','ativa','em_retentativa')",
        [customerId, plan.provider_id]
      );
      const seats = await seatUsage(client, plan.provider_id, settings);
      if (!already[0] && seats.full)
        throw new ApiError(409, "subscriber_limit", "Esta prestadora não está aceitando novas assinantes no momento.");
      if (plan.max_subscribers != null) {
        const { rows: planCount } = await client.query(
          "SELECT COUNT(*)::int AS total FROM subscriptions WHERE plan_id=$1 AND status IN ('pendente','ativa','em_retentativa')",
          [plan.id]
        );
        if (planCount[0].total >= plan.max_subscribers) throw new ApiError(409, "plan_full", "As vagas deste plano estão preenchidas.");
      }

      const breakdown = priceBreakdown(plan.price_cents, settings);
      const now = new Date();
      const { rows: inserted } = await client.query(
        `INSERT INTO subscriptions (
           customer_id, provider_id, plan_id, status, provider_amount_cents, fee_cents, total_cents, fee_payer,
           settings_snapshot, settings_version, billing_anchor_day, interval_unit, interval_count,
           card_last4, card_brand, pending_card_token_encrypted, gateway, idempotency_key, request_fingerprint)
         VALUES ($1,$2,$3,'pendente',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING *`,
        [customerId, plan.provider_id, plan.id, breakdown.providerAmountCents, breakdown.feeCents, breakdown.totalCents,
         breakdown.feePayer, snapshotOf(settings), settingsVersion(settings), anchorDayOf(now), plan.interval_unit,
         plan.interval_count, card.last4 ?? null, card.brand ?? null, encryptText(card.token), gateway().nome,
         idempotencyKey, requestFingerprint]
      );
      const sub = inserted[0];
      // Descontos de repasse que caem na 1ª cobrança
      const payoutDate = expectedPayoutDateKey(now, "cartao", settings, payoutSchedule(settings, account));
      const deductionCents = await reserveDeductions(client, {
        providerId: plan.provider_id, availableCents: breakdown.providerAmountCents, payoutDate, subscriptionId: sub.id, cycle: 1,
      });
      const split = buildSplit({ providerAmountCents: breakdown.providerAmountCents, feeCents: breakdown.feeCents, deductionCents });
      await client.query("UPDATE subscriptions SET current_split=$2 WHERE id=$1", [sub.id, split]);
      await recordEvent(client, sub.id, null, "pendente", "created", { actorId: customerId });
      afterCommit(client, () => submitSubscription(sub.id));
      return sub.id;
    });
  } catch (error) {
    if (error.code === "23505" && error.constraint === "subscriptions_idempotency_key_key") {
      return subscribe(customerId, { planId, card }, idempotencyKey);
    }
    if (error.code === "23505" && error.constraint === "subscriptions_one_open_per_plan")
      throw new ApiError(409, "already_subscribed", "Você já assina este plano.");
    throw error;
  }
  return subscriptionId;
}

// Cria a assinatura no gateway (depois do COMMIT; repetível: mesma chave)
async function submitSubscription(subscriptionId) {
  const { rows } = await db.runQuery(
    `SELECT s.*, a.gateway_recipient_id FROM subscriptions s
     JOIN provider_payment_accounts a ON a.provider_id = s.provider_id WHERE s.id=$1`,
    [subscriptionId]
  );
  const sub = rows[0];
  if (!sub || sub.gateway_subscription_id || sub.status !== "pendente" || !sub.pending_card_token_encrypted) return;
  const snapshot = sub.settings_snapshot;
  const result = await gateway().createSubscription({
    recipientId: sub.gateway_recipient_id,
    valorTotal: sub.total_cents,
    split: gatewaySplit(sub.current_split, sub.gateway_recipient_id),
    periodicidade: { unidade: sub.interval_unit, quantidade: sub.interval_count },
    inicio: sub.created_at,
    metodoPagamento: { tipo: "cartao", tokenDoGateway: decryptText(sub.pending_card_token_encrypted) },
    politicaRetentativa: { tentativas: snapshot.retry_max_attempts, intervaloDias: snapshot.retry_interval_days },
    referencia: { tipo: "assinatura", id: sub.id },
    idempotencyKey: `subscription:${sub.id}`,
  });
  await db.runQuery(
    "UPDATE subscriptions SET gateway_subscription_id=$2, pending_card_token_encrypted=NULL, updated_at=now() WHERE id=$1",
    [sub.id, result.subscriptionId]
  );
}

// ---------- Cancelar ----------
// Vale para o ciclo seguinte: os direitos continuam até o fim do ciclo em curso.
async function cancelSubscription(customerId, subscriptionId) {
  return db.runInTransaction(async (client) => {
    const sub = await loadForUpdate(client, subscriptionId);
    if (!sub || sub.customer_id !== customerId) throw new ApiError(404, "not_found", "Assinatura não encontrada.");
    if (sub.status === "ativa") {
      if (sub.cancel_at_period_end) return sub;
      await client.query(
        "UPDATE subscriptions SET cancel_at_period_end=true, cancel_requested_at=now(), updated_at=now() WHERE id=$1",
        [sub.id]
      );
      await releaseReservedDeductions(client, { subscriptionId: sub.id, cycle: sub.current_cycle + 1 });
      await recordEvent(client, sub.id, "ativa", "ativa", "cancel_requested", { actorId: customerId, reason: "Vale no fim do ciclo" });
      await notify(client, {
        userId: sub.provider_id, type: "subscription_cancel_requested", title: "Assinatura cancelada",
        body: "Uma assinante cancelou. As sessões dela valem até o fim do ciclo atual.",
        data: { subscriptionId: sub.id }, area: "provider",
      });
      if (sub.gateway_subscription_id) afterCommit(client, () => gateway().cancelSubscription(sub.gateway_subscription_id, { quando: "fim_do_ciclo" }));
      return { ...sub, cancel_at_period_end: true };
    }
    if (sub.status === "em_retentativa") {
      return applyTransition(client, sub, EVENTS.CUSTOMER_CANCELED, { actorId: customerId, reason: "Cancelada durante a retentativa" });
    }
    throw new ApiError(409, "invalid_transition", `Não é possível cancelar uma assinatura ${sub.status}.`);
  });
}

// ---------- Transições ----------

async function loadForUpdate(client, subscriptionId) {
  const { rows } = await client.query("SELECT * FROM subscriptions WHERE id=$1 FOR UPDATE", [subscriptionId]);
  return rows[0] ?? null;
}

async function recordEvent(client, subscriptionId, fromStatus, toStatus, event, { actorId = null, reason = null, webhookEventId = null } = {}) {
  await client.query(
    `INSERT INTO subscription_events (subscription_id,from_status,to_status,event,reason,actor_id,webhook_event_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [subscriptionId, fromStatus, toStatus, event, reason, actorId, webhookEventId]
  );
}

async function grantEntitlements(client, sub) {
  await client.query(
    `INSERT INTO entitlements (subscription_id,customer_id,provider_id,service_id,cycle,period_start,period_end,sessions_granted)
     SELECT $1,$2,$3,i.service_id,$4,$5,$6,i.sessions_per_cycle
     FROM subscription_plan_items i WHERE i.plan_id=$7
     ON CONFLICT (subscription_id,service_id,cycle) DO NOTHING`,
    [sub.id, sub.customer_id, sub.provider_id, sub.current_cycle, sub.current_period_start, sub.current_period_end, sub.plan_id]
  );
}

// Aplica um evento pela máquina de estados e executa os efeitos. `charge`
// é a cobrança que originou o evento (quando houver).
async function applyTransition(client, sub, event, { charge = null, webhookEventId = null, actorId = null, reason = null } = {}) {
  const snapshot = sub.settings_snapshot;
  const context = event === EVENTS.PAYMENT_FAILED && sub.status === "em_retentativa"
    ? { isLastAttempt: sub.retry_attempt + 1 >= snapshot.retry_max_attempts }
    : {};
  const result = transition(sub.status, event, context);
  const next = { ...sub, status: result.to };
  const now = new Date();
  const later = [];

  for (const effect of result.effects) {
    switch (effect) {
      case EFFECTS.START_FIRST_CYCLE: {
        const startedAt = charge?.paid_at ? new Date(charge.paid_at) : now;
        next.started_at = startedAt;
        next.billing_anchor_day = anchorDayOf(startedAt);
        next.current_cycle = 1;
        const period = cyclePeriod(startedAt, 0, periodOptions(next));
        next.current_period_start = period.start;
        next.current_period_end = period.end;
        break;
      }
      case EFFECTS.START_NEXT_CYCLE: {
        const cycle = charge?.subscription_cycle ?? sub.current_cycle + 1;
        next.current_cycle = cycle;
        const period = cyclePeriod(new Date(sub.started_at), cycle - 1, periodOptions(next));
        next.current_period_start = period.start;
        next.current_period_end = period.end;
        break;
      }
      case EFFECTS.GRANT_ENTITLEMENTS:
        later.push(() => grantEntitlements(client, next));
        break;
      case EFFECTS.VOID_ENTITLEMENTS:
        later.push(() => client.query(
          "UPDATE entitlements SET voided_at=now() WHERE subscription_id=$1 AND cycle=$2 AND voided_at IS NULL",
          [sub.id, next.current_cycle]
        ));
        break;
      case EFFECTS.SCHEDULE_RETRY:
        next.retry_attempt = sub.status === "em_retentativa" ? sub.retry_attempt + 1 : 0;
        next.next_retry_at = new Date(now.getTime() + snapshot.retry_interval_days * DAY_MS);
        break;
      case EFFECTS.CLEAR_RETRY:
        next.retry_attempt = 0;
        next.next_retry_at = null;
        break;
      case EFFECTS.MARK_SUSPENDED:
        next.suspended_at = now;
        break;
      case EFFECTS.MARK_CANCELED:
        next.canceled_at = now;
        later.push(() => releaseReservedDeductions(client, { subscriptionId: sub.id }));
        break;
      case EFFECTS.CANCEL_AT_GATEWAY:
        if (sub.gateway_subscription_id) afterCommit(client, () => gateway().cancelSubscription(sub.gateway_subscription_id, { quando: "imediato" }));
        break;
      case EFFECTS.FREEZE_ENTITLEMENTS:
      case EFFECTS.UNFREEZE_ENTITLEMENTS:
        break; // congelado = derivado do status (em_retentativa)
      default:
        throw new Error(`Efeito sem implementação: ${effect}`);
    }
  }
  if (result.to === "suspensa" || result.to === "cancelada")
    later.push(() => releaseReservedDeductions(client, { subscriptionId: sub.id }));

  await client.query(
    `UPDATE subscriptions SET status=$2, started_at=$3, billing_anchor_day=$4, current_cycle=$5,
       current_period_start=$6, current_period_end=$7, retry_attempt=$8, next_retry_at=$9,
       suspended_at=$10, canceled_at=$11, updated_at=now()
     WHERE id=$1`,
    [sub.id, next.status, next.started_at, next.billing_anchor_day, next.current_cycle, next.current_period_start,
     next.current_period_end, next.retry_attempt, next.next_retry_at, next.suspended_at, next.canceled_at]
  );
  for (const step of later) await step();
  await recordEvent(client, sub.id, sub.status, next.status, event, { actorId, reason, webhookEventId });
  await notifyTransition(client, sub, next);

  // Sem retentativas configuradas: a falha da renovação já é a última
  if (sub.status === "ativa" && next.status === "em_retentativa" && snapshot.retry_max_attempts === 0) {
    return applyTransition(client, { ...next, retry_attempt: -1 }, EVENTS.PAYMENT_FAILED, { charge, webhookEventId, reason: "Sem retentativas configuradas" });
  }
  if (next.status === "ativa") await prepareNextCycle(client, next);
  return next;
}

async function notifyTransition(client, before, after) {
  const messages = {
    "pendente>ativa": ["Assinatura ativa", "Pagamento confirmado. Suas sessões do ciclo já estão disponíveis."],
    "ativa>em_retentativa": ["Não conseguimos cobrar sua assinatura", "Vamos tentar de novo nos próximos dias. Até lá, as sessões do novo ciclo ficam congeladas."],
    "em_retentativa>ativa": ["Pagamento confirmado", "Sua assinatura voltou ao normal e as sessões foram liberadas."],
    "em_retentativa>suspensa": ["Assinatura suspensa", "As tentativas de cobrança falharam. Atualize o cartão para voltar a usar suas sessões."],
    "pendente>cancelada": ["Pagamento recusado", "Não foi possível iniciar a assinatura. Tente com outro cartão."],
  };
  const message = messages[`${before.status}>${after.status}`];
  if (message) {
    await notify(client, {
      userId: before.customer_id, type: `subscription_${after.status}`, title: message[0], body: message[1],
      data: { subscriptionId: before.id }, area: "customer",
    });
  }
  if (before.status === "pendente" && after.status === "ativa") {
    await notify(client, {
      userId: before.provider_id, type: "subscription_started", title: "Nova assinante",
      body: "Uma cliente assinou um dos seus planos.", data: { subscriptionId: before.id }, area: "provider",
    });
  }
}

// Depois de um ciclo pago: adota o preço repactuado (se a cobrança já veio
// nele) e reserva os descontos de repasse do próximo ciclo, atualizando o
// split no gateway se mudou.
async function prepareNextCycle(client, sub) {
  const pricing = sub.next_cycle_pricing;
  const providerAmountCents = pricing?.provider_amount_cents ?? sub.provider_amount_cents;
  const feeCents = pricing?.fee_cents ?? sub.fee_cents;
  const account = await loadAccount(client, sub.provider_id);
  if (!account || !sub.current_period_end) return;
  const nextCycle = sub.current_cycle + 1;
  const { rows: reserved } = await client.query(
    "SELECT 1 FROM charge_deductions WHERE subscription_id=$1 AND subscription_cycle=$2 AND status='reservado' LIMIT 1",
    [sub.id, nextCycle]
  );
  if (reserved[0] || sub.cancel_at_period_end) return;
  const snapshot = sub.settings_snapshot;
  const payoutDate = expectedPayoutDateKey(sub.current_period_end, "cartao", snapshot, payoutSchedule(snapshot, account));
  const deductionCents = await reserveDeductions(client, {
    providerId: sub.provider_id, availableCents: providerAmountCents, payoutDate, subscriptionId: sub.id, cycle: nextCycle,
  });
  const split = buildSplit({ providerAmountCents, feeCents, deductionCents });
  const current = sub.current_split ?? {};
  if (split.prestadora === current.prestadora && split.plataforma === current.plataforma) return;
  await client.query("UPDATE subscriptions SET current_split=$2 WHERE id=$1", [sub.id, split]);
  if (sub.gateway_subscription_id) {
    afterCommit(client, () => gateway().updateSubscriptionAmount(sub.gateway_subscription_id, {
      valorTotal: split.total,
      split: gatewaySplit(split, account.gateway_recipient_id),
      aPartirDe: sub.current_period_end,
      idempotencyKey: `split:${sub.id}:${nextCycle}:${split.prestadora}`,
    }));
  }
}

// ---------- Direitos de agendamento ----------
// Debitados no agendamento (não no atendimento), só com a assinatura ativa e
// dentro do ciclo em curso; não acumulam entre ciclos.
async function debitEntitlement(client, { customerId, subscriptionId, serviceId, scheduledAt, orderId }) {
  const sub = await loadForUpdate(client, subscriptionId);
  if (!sub || sub.customer_id !== customerId) throw new ApiError(404, "not_found", "Assinatura não encontrada.");
  if (sub.status === "em_retentativa")
    throw new ApiError(409, "entitlements_frozen", "Suas sessões estão congeladas até o pagamento da assinatura ser confirmado.");
  if (!ENTITLEMENTS_USABLE.includes(sub.status)) throw new ApiError(409, "subscription_inactive", "Esta assinatura não está ativa.");
  if (scheduledAt >= new Date(sub.current_period_end))
    throw new ApiError(422, "outside_cycle", "As sessões deste ciclo valem até o fim dele.", { scheduledAt: `Agende até ${brasiliaDateKey(sub.current_period_end)}.` });
  const { rows } = await client.query(
    `SELECT * FROM entitlements WHERE subscription_id=$1 AND service_id=$2 AND cycle=$3 AND voided_at IS NULL FOR UPDATE`,
    [sub.id, serviceId, sub.current_cycle]
  );
  const entitlement = rows[0];
  if (!entitlement) throw new ApiError(422, "service_not_in_plan", "Este serviço não faz parte do plano.");
  if (entitlement.sessions_used >= entitlement.sessions_granted)
    throw new ApiError(409, "no_sessions_left", "Você já usou todas as sessões deste ciclo.");
  await client.query("UPDATE entitlements SET sessions_used=sessions_used+1 WHERE id=$1", [entitlement.id]);
  await client.query("INSERT INTO entitlement_usages (entitlement_id,order_id) VALUES ($1,$2)", [entitlement.id, orderId]);
  return { subscription: sub, entitlement };
}

// Devolve a sessão (cancelamento dentro do prazo ou pela prestadora)
async function returnEntitlement(client, orderId) {
  const { rows } = await client.query(
    `UPDATE entitlement_usages SET status='devolvido', returned_at=now()
     WHERE order_id=$1 AND status='debitado' RETURNING entitlement_id`,
    [orderId]
  );
  if (!rows[0]) return false;
  await client.query(
    "UPDATE entitlements SET sessions_used=GREATEST(sessions_used-1,0) WHERE id=$1 AND voided_at IS NULL",
    [rows[0].entitlement_id]
  );
  return true;
}

// ---------- Manutenção periódica ----------

async function runMaintenance() {
  const now = new Date();
  const { rows: endingCancels } = await db.runQuery(
    `SELECT id FROM subscriptions WHERE status='ativa' AND cancel_at_period_end AND current_period_end <= now() LIMIT 100`
  );
  for (const { id } of endingCancels) {
    await db.runInTransaction(async (client) => {
      const sub = await loadForUpdate(client, id);
      if (sub?.status === "ativa" && sub.cancel_at_period_end && new Date(sub.current_period_end) <= now)
        await applyTransition(client, sub, EVENTS.PERIOD_ENDED_WITH_CANCEL, { reason: "Fim do ciclo após cancelamento" });
    });
  }
  const { rows: expiredSuspensions } = await db.runQuery(
    `SELECT id FROM subscriptions WHERE status='suspensa'
       AND suspended_at + make_interval(days => (settings_snapshot->>'suspension_grace_days')::int) <= now() LIMIT 100`
  );
  for (const { id } of expiredSuspensions) {
    await db.runInTransaction(async (client) => {
      const sub = await loadForUpdate(client, id);
      if (sub?.status === "suspensa") await applyTransition(client, sub, EVENTS.SUSPENSION_EXPIRED, { reason: "Prazo da suspensão terminou" });
    });
  }
  // Preço repactuado pelo admin: leva ao gateway para valer no próximo ciclo
  const { rows: repriced } = await db.runQuery(
    `SELECT s.*, a.gateway_recipient_id FROM subscriptions s JOIN provider_payment_accounts a ON a.provider_id=s.provider_id
     WHERE s.next_cycle_pricing IS NOT NULL AND s.next_cycle_pricing_synced_at IS NULL
       AND s.gateway_subscription_id IS NOT NULL AND s.status IN ('ativa','em_retentativa') LIMIT 50`
  );
  for (const sub of repriced) {
    const pricing = sub.next_cycle_pricing;
    const split = buildSplit({ providerAmountCents: pricing.provider_amount_cents, feeCents: pricing.fee_cents });
    try {
      await gateway().updateSubscriptionAmount(sub.gateway_subscription_id, {
        valorTotal: split.total, split: gatewaySplit(split, sub.gateway_recipient_id),
        aPartirDe: sub.current_period_end, idempotencyKey: `reprice:${sub.id}:${pricing.settings_version}`,
      });
      await db.runQuery("UPDATE subscriptions SET next_cycle_pricing_synced_at=now(), current_split=$2 WHERE id=$1", [sub.id, split]);
    } catch (error) {
      console.error(`repactuação da assinatura ${sub.id}:`, error.message);
    }
  }
  // Assinatura que não chegou ao gateway (falha depois do COMMIT)
  const { rows: unsent } = await db.runQuery(
    `SELECT id FROM subscriptions WHERE status='pendente' AND gateway_subscription_id IS NULL
       AND pending_card_token_encrypted IS NOT NULL AND created_at < now() - interval '1 minute' LIMIT 20`
  );
  for (const { id } of unsent) await submitSubscription(id).catch((error) => console.error(`assinatura ${id}:`, error.message));
}

module.exports = {
  subscribe,
  submitSubscription,
  cancelSubscription,
  applyTransition,
  loadForUpdate,
  debitEntitlement,
  returnEntitlement,
  gatewaySplit,
  runMaintenance,
};
