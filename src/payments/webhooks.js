// Webhook: a ÚNICA fonte da verdade do status de cobrança. Nenhum endpoint do
// app marca cobrança como paga. Cada evento:
// 1. tem a assinatura conferida pelo adapter (parseWebhook);
// 2. é gravado com o payload bruto e o tipo normalizado (descarta repetidos);
// 3. é processado numa transação; se falhar, responde 500 e o PSP reenvia.
const db = require("../db");
const { ApiError } = require("../errors");
const { notify } = require("../notifications");
const { gateway } = require("./runtime");
const { buildSplit } = require("./money");
const { EVENTS } = require("./subscriptionStateMachine");
const { recordPaidCharge, recordRefund, releaseReservedDeductions } = require("./ledger");
const { applyTransition, loadForUpdate } = require("./subscriptions");
const { insertSplits, requestRefund, cancelOrderForFailedPayment, notifyOrderPaid } = require("./charges");
const { refundAllocation } = require("./money");

const FINAL_CHARGE_STATUSES = ["paga", "falhou", "estornada", "estornada_parcial"];

async function receiveWebhook(headers, rawBody) {
  let event;
  try {
    event = gateway().parseWebhook(headers, rawBody);
  } catch (error) {
    if (error.code === "invalid_signature") throw new ApiError(401, "invalid_signature", "Assinatura do webhook inválida.");
    throw new ApiError(400, error.code ?? "invalid_webhook", error.message);
  }
  const gatewayName = gateway().nome;
  const { rows: inserted } = await db.runQuery(
    `INSERT INTO payment_webhook_events (gateway,gateway_event_id,event_type,raw_payload)
     VALUES ($1,$2,$3,$4) ON CONFLICT (gateway,gateway_event_id) DO NOTHING RETURNING id`,
    [gatewayName, event.eventId, event.tipo, event.bruto]
  );
  let eventRowId = inserted[0]?.id;
  if (!eventRowId) {
    const { rows } = await db.runQuery(
      "SELECT id, processed_at FROM payment_webhook_events WHERE gateway=$1 AND gateway_event_id=$2",
      [gatewayName, event.eventId]
    );
    if (rows[0]?.processed_at) return { duplicate: true };
    eventRowId = rows[0].id; // recebido antes, mas o processamento falhou: tenta de novo
  }
  try {
    await db.runInTransaction((client) => processEvent(client, event, eventRowId, gatewayName));
    await db.runQuery("UPDATE payment_webhook_events SET processed_at=now(), processing_error=NULL WHERE id=$1", [eventRowId]);
  } catch (error) {
    await db.runQuery("UPDATE payment_webhook_events SET processing_error=$2 WHERE id=$1", [eventRowId, String(error.message).slice(0, 500)]);
    throw error;
  }
  return { processed: true, type: event.tipo };
}

async function processEvent(client, event, eventRowId, gatewayName) {
  switch (event.tipo) {
    case "RECIPIENT_APPROVED":
    case "RECIPIENT_REJECTED":
      return processRecipient(client, event, gatewayName);
    case "RECIPIENT_KYC_APPROVED":
    case "RECIPIENT_KYC_REJECTED":
      return processKyc(client, event, gatewayName);
    case "PAYMENT_CONFIRMED":
    case "PAYMENT_FAILED":
      return processPayment(client, event, eventRowId, gatewayName);
    case "PAYMENT_REFUNDED":
      return processRefund(client, event, gatewayName);
    default:
      throw new Error(`Evento sem tratamento: ${event.tipo}`);
  }
}

async function processRecipient(client, event, gatewayName) {
  const approved = event.tipo === "RECIPIENT_APPROVED";
  const { rows } = await client.query(
    `UPDATE provider_payment_accounts SET status=$3, status_reason=$4, updated_at=now()
     WHERE gateway=$1 AND gateway_recipient_id=$2 AND status IN ('pendente','em_analise')
     RETURNING provider_id`,
    [gatewayName, event.recipientId, approved ? "aprovada" : "recusada", approved ? null : event.motivo ?? "Recusada pelo gateway"]
  );
  if (!rows[0]) return;
  await notify(client, {
    userId: rows[0].provider_id,
    type: approved ? "payment_account_approved" : "payment_account_rejected",
    title: approved ? "Conta de recebimento aprovada" : "Conta de recebimento recusada",
    body: approved ? "Você já pode criar planos e receber pelo app." : `Confira os dados bancários. ${event.motivo ?? ""}`.trim(),
    data: {}, area: "provider",
  });
}

// Prova de vida do recebedor: é o selo "Identidade verificada" e libera
// planos e repasses. Recusa permite tentar de novo com um link novo.
async function processKyc(client, event, gatewayName) {
  const approved = event.tipo === "RECIPIENT_KYC_APPROVED";
  const { rows } = await client.query(
    `UPDATE provider_payment_accounts
     SET kyc_status=$3, kyc_reason=$4, kyc_verified_at=CASE WHEN $3='aprovada' THEN now() ELSE NULL END,
         kyc_link_url=NULL, kyc_link_expires_at=NULL, updated_at=now()
     WHERE gateway=$1 AND gateway_recipient_id=$2 AND kyc_status <> 'aprovada'
     RETURNING provider_id`,
    [gatewayName, event.recipientId, approved ? "aprovada" : "recusada", approved ? null : event.motivo ?? "Não aprovada pela instituição de pagamento"]
  );
  if (!rows[0]) return;
  await notify(client, {
    userId: rows[0].provider_id,
    type: approved ? "identity_verified" : "identity_rejected",
    title: approved ? "Identidade verificada" : "Prova de vida não aprovada",
    body: approved
      ? "Seu perfil ganhou o selo de identidade verificada e seus repasses estão liberados."
      : `Faça a prova de vida de novo em Planos e recebimentos. ${event.motivo ?? ""}`.trim(),
    data: {}, area: "provider",
  });
}

// ---------- Pagamento confirmado / recusado ----------

async function findCharge(client, event, gatewayName) {
  if (event.gatewayChargeId) {
    const { rows } = await client.query(
      "SELECT * FROM charges WHERE gateway=$1 AND gateway_charge_id=$2 FOR UPDATE",
      [gatewayName, event.gatewayChargeId]
    );
    if (rows[0]) return rows[0];
  }
  // o webhook chegou antes de gravarmos o id do gateway
  if (event.referencia?.tipo === "cobranca") {
    const { rows } = await client.query(
      "UPDATE charges SET gateway_charge_id=$2 WHERE id=$1 AND gateway_charge_id IS NULL RETURNING id",
      [event.referencia.id, event.gatewayChargeId]
    );
    const { rows: charges } = await client.query("SELECT * FROM charges WHERE id=$1 FOR UPDATE", [rows[0]?.id ?? event.referencia.id]);
    return charges[0] ?? null;
  }
  return null;
}

async function findSubscriptionForEvent(client, event, gatewayName) {
  const { rows } = await client.query(
    `SELECT s.id FROM subscriptions s
     WHERE (s.gateway=$1 AND s.gateway_subscription_id=$2) OR (s.id::text=$3 AND $4='assinatura')
     LIMIT 1`,
    [gatewayName, event.gatewaySubscriptionId ?? null, event.referencia?.id ?? "", event.referencia?.tipo ?? ""]
  );
  if (!rows[0]) return null;
  const sub = await loadForUpdate(client, rows[0].id);
  if (!sub.gateway_subscription_id && event.gatewaySubscriptionId) {
    await client.query("UPDATE subscriptions SET gateway_subscription_id=$2 WHERE id=$1", [sub.id, event.gatewaySubscriptionId]);
    sub.gateway_subscription_id = event.gatewaySubscriptionId;
  }
  return sub;
}

// Ciclo a que a cobrança da assinatura pertence (pelo evento, ou pelo estado)
function cycleOf(sub, event) {
  if (Number.isInteger(event.ciclo)) return event.ciclo;
  if (sub.status === "pendente") return 1;
  if (sub.status === "em_retentativa") return sub.current_cycle;
  return sub.current_cycle + 1;
}

// A cobrança da renovação nasce no gateway; aqui ela ganha a linha local com
// o preço contratado (ou o repactuado, se o valor do gateway já for o novo).
async function createSubscriptionCharge(client, sub, event, gatewayName) {
  const pricing = sub.next_cycle_pricing;
  let amounts;
  if (pricing && event.valor === pricing.total_cents) {
    amounts = { ...pricing, repriced: true };
  } else if (event.valor === sub.total_cents) {
    amounts = {
      provider_amount_cents: sub.provider_amount_cents, fee_cents: sub.fee_cents, total_cents: sub.total_cents,
      fee_payer: sub.fee_payer, settings_snapshot: sub.settings_snapshot, settings_version: sub.settings_version,
    };
  } else {
    throw new Error(`Valor do gateway (${event.valor}) difere do contratado (${sub.total_cents}) na assinatura ${sub.id}.`);
  }
  const cycle = cycleOf(sub, event);
  let split = sub.current_split;
  if (!split || split.total !== amounts.total_cents || split.plataforma < amounts.fee_cents) {
    await releaseReservedDeductions(client, { subscriptionId: sub.id, cycle });
    split = buildSplit({ providerAmountCents: amounts.provider_amount_cents, feeCents: amounts.fee_cents });
  }
  const idempotencyKey = `gw:${gatewayName}:${event.gatewayChargeId}`;
  await client.query(
    `INSERT INTO charges (origin,subscription_id,subscription_cycle,customer_id,provider_id,charge_owner,total_cents,fee_cents,
       provider_amount_cents,deduction_cents,fee_payer,status,attempt,payment_method,idempotency_key,request_fingerprint,
       gateway,gateway_charge_id,settings_snapshot,settings_version)
     VALUES ('assinatura',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'processando',$11,'cartao',$12,$13,$14,$15,$16,$17)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [sub.id, cycle, sub.customer_id, sub.provider_id, gateway().capabilities().titularDaCobranca, amounts.total_cents,
     amounts.fee_cents, amounts.provider_amount_cents, split.plataforma - amounts.fee_cents, amounts.fee_payer,
     event.tentativa ?? 1, idempotencyKey, event.gatewayChargeId, gatewayName, event.gatewayChargeId,
     amounts.settings_snapshot, amounts.settings_version]
  );
  const { rows } = await client.query("SELECT * FROM charges WHERE idempotency_key=$1 FOR UPDATE", [idempotencyKey]);
  const { rows: account } = await client.query("SELECT gateway_recipient_id FROM provider_payment_accounts WHERE provider_id=$1", [sub.provider_id]);
  await insertSplits(client, rows[0].id, split, account[0]?.gateway_recipient_id ?? null);
  return { charge: rows[0], repriced: Boolean(amounts.repriced) };
}

async function processPayment(client, event, eventRowId, gatewayName) {
  const paid = event.tipo === "PAYMENT_CONFIRMED";
  let charge = await findCharge(client, event, gatewayName);
  let sub = null;
  let repriced = false;
  if (!charge || charge.origin === "assinatura") {
    sub = await findSubscriptionForEvent(client, event, gatewayName);
    if (!charge && sub) ({ charge, repriced } = await createSubscriptionCharge(client, sub, event, gatewayName));
  }
  if (!charge) throw new Error(`Cobrança desconhecida no webhook ${event.eventId} (${event.gatewayChargeId}).`);
  if (FINAL_CHARGE_STATUSES.includes(charge.status)) return; // já processada (idempotente)
  if (event.valor != null && event.valor !== charge.total_cents)
    throw new Error(`Valor do webhook (${event.valor}) difere da cobrança ${charge.id} (${charge.total_cents}).`);

  const occurredAt = event.ocorridoEm ? new Date(event.ocorridoEm) : new Date();
  if (paid) {
    const { rows } = await client.query(
      "UPDATE charges SET status='paga', paid_at=$2, failure_code=NULL, failure_message=NULL, updated_at=now() WHERE id=$1 RETURNING *",
      [charge.id, occurredAt]
    );
    charge = rows[0];
    await recordPaidCharge(client, charge, occurredAt);
  } else {
    const { rows } = await client.query(
      "UPDATE charges SET status='falhou', failed_at=$2, failure_code=$3, failure_message=$4, updated_at=now() WHERE id=$1 RETURNING *",
      [charge.id, occurredAt, event.bruto?.data?.last_transaction?.gateway_response?.code ?? "failed", event.motivo ?? null]
    );
    charge = rows[0];
    if (charge.origin === "avulso") await releaseReservedDeductions(client, { chargeId: charge.id });
  }

  if (charge.origin === "avulso") return afterAvulsoPayment(client, charge, paid, event);
  return afterSubscriptionPayment(client, sub, charge, paid, { eventRowId, repriced });
}

async function afterAvulsoPayment(client, charge, paid, event) {
  if (!paid) return cancelOrderForFailedPayment(client, charge, event.motivo);
  const { rows } = await client.query("SELECT status FROM orders WHERE id=$1", [charge.order_id]);
  // pedido cancelado enquanto o pagamento processava: devolve tudo
  if (rows[0]?.status === "cancelled") {
    await requestRefund(client, charge, charge.total_cents, {
      reason: "Pedido cancelado antes da confirmação do pagamento",
      idempotencyKey: `auto-refund:${charge.id}`,
    });
    return;
  }
  await client.query("UPDATE payments SET status='captured' WHERE order_id=$1 AND status='held'", [charge.order_id]);
  await notifyOrderPaid(client, charge);
}

async function afterSubscriptionPayment(client, sub, charge, paid, { eventRowId, repriced }) {
  if (!sub) sub = await loadForUpdate(client, charge.subscription_id);
  const cycle = charge.subscription_cycle;
  if (paid && repriced) {
    // a cobrança veio no preço repactuado: ele passa a ser o contratado
    const pricing = sub.next_cycle_pricing;
    await client.query(
      `UPDATE subscriptions SET provider_amount_cents=$2, fee_cents=$3, total_cents=$4, fee_payer=$5,
         settings_snapshot=$6, settings_version=$7, next_cycle_pricing=NULL, next_cycle_pricing_synced_at=NULL
       WHERE id=$1`,
      [sub.id, pricing.provider_amount_cents, pricing.fee_cents, pricing.total_cents, pricing.fee_payer,
       pricing.settings_snapshot, pricing.settings_version]
    );
    sub = await loadForUpdate(client, sub.id);
  }
  const event = paid ? EVENTS.PAYMENT_CONFIRMED : EVENTS.PAYMENT_FAILED;
  const options = { charge, webhookEventId: eventRowId };
  const applies =
    sub.status === "pendente" ||
    (sub.status === "ativa" && cycle === sub.current_cycle + 1 && !sub.cancel_at_period_end) ||
    (sub.status === "em_retentativa" && cycle === sub.current_cycle);
  if (applies) {
    await applyTransition(client, sub, event, options);
    return;
  }
  // Cobrança paga de assinatura que não está mais ativa (ex.: cancelada antes
  // de o gateway parar a recorrência): devolve o dinheiro.
  if (paid && ["cancelada", "suspensa"].includes(sub.status)) {
    await requestRefund(client, charge, charge.total_cents, {
      reason: `Cobrança recebida com a assinatura ${sub.status}`,
      idempotencyKey: `auto-refund:${charge.id}`,
    });
  }
}

// ---------- Estorno ----------

async function processRefund(client, event, gatewayName) {
  const charge = await findCharge(client, event, gatewayName);
  if (!charge) throw new Error(`Estorno de cobrança desconhecida (${event.gatewayChargeId}).`);
  let refund = null;
  if (event.gatewayRefundId) {
    const { rows } = await client.query("SELECT * FROM refunds WHERE gateway_refund_id=$1 FOR UPDATE", [event.gatewayRefundId]);
    refund = rows[0] ?? null;
  }
  if (!refund) {
    // pedido por nós, mas o id do gateway ainda não tinha sido gravado
    const { rows } = await client.query(
      `SELECT * FROM refunds WHERE charge_id=$1 AND status='solicitado' AND amount_cents=$2
       ORDER BY created_at LIMIT 1 FOR UPDATE`,
      [charge.id, event.valor]
    );
    refund = rows[0] ?? null;
    if (refund && event.gatewayRefundId)
      await client.query("UPDATE refunds SET gateway_refund_id=$2 WHERE id=$1", [refund.id, event.gatewayRefundId]);
  }
  if (refund?.status === "concluido") return;
  if (!refund) {
    // estorno iniciado fora do app (painel do PSP, chargeback): registra igual
    const { rows: splits } = await client.query("SELECT * FROM charge_splits WHERE charge_id=$1", [charge.id]);
    const providerSplit = splits.find((split) => split.party === "prestadora");
    const platformSplit = splits.find((split) => split.party === "plataforma");
    const allocation = refundAllocation({
      refundCents: event.valor, totalCents: charge.total_cents, providerSplitCents: providerSplit.amount_cents,
      providerReversedCents: providerSplit.refunded_cents, platformReversedCents: platformSplit.refunded_cents,
    });
    const { rows } = await client.query(
      `INSERT INTO refunds (charge_id,amount_cents,provider_reversed_cents,platform_reversed_cents,idempotency_key,status,gateway_refund_id,reason)
       VALUES ($1,$2,$3,$4,$5,'solicitado',$6,'Estorno iniciado no gateway') RETURNING *`,
      [charge.id, event.valor, allocation.providerCents, allocation.platformCents, `gw-refund:${event.gatewayRefundId ?? event.eventId}`, event.gatewayRefundId ?? null]
    );
    refund = rows[0];
  }
  const { fullyRefunded } = await recordRefund(client, charge, refund);

  if (charge.origin === "assinatura" && fullyRefunded) {
    // estorno integral do ciclo: as sessões dele deixam de valer
    await client.query(
      "UPDATE entitlements SET voided_at=now() WHERE subscription_id=$1 AND cycle=$2 AND voided_at IS NULL",
      [charge.subscription_id, charge.subscription_cycle]
    );
  }
  await notify(client, {
    userId: charge.customer_id, type: "payment_refunded", title: "Estorno realizado",
    body: `Devolvemos R$ ${(refund.amount_cents / 100).toFixed(2).replace(".", ",")} no mesmo meio de pagamento.`,
    data: charge.order_id ? { orderId: charge.order_id } : { subscriptionId: charge.subscription_id }, area: "customer",
  });
}

module.exports = { receiveWebhook, processEvent };
