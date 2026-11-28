// Cobrança avulsa (atendimento pago no app) e estornos.
//
// O avulso é cobrado na solicitação do pedido. A prestadora só aceita depois
// que o webhook confirmar o pagamento. Recusa, expiração ou cancelamento no
// prazo estornam automaticamente (revertendo o split, inclusive a taxa).
const db = require("../db");
const { ApiError } = require("../errors");
const { encryptText, decryptText } = require("../security");
const { notify } = require("../notifications");
const { gateway, afterCommit, centsFromDecimal } = require("./runtime");
const { priceBreakdown, buildSplit } = require("./money");
const { expectedPayoutDateKey, DAY_MS } = require("./dates");
const { loadProviderSettings, snapshotOf, settingsVersion, payoutSchedule } = require("./settings");
const { reserveDeductions, planRefund } = require("./ledger");
const { loadAccount, assertCustomerComplete } = require("./accounts");
const { loadOwnCard, savedCardMethod } = require("./cards");
const { gatewaySplit, returnEntitlement } = require("./subscriptions");

// Prestadora recebe pelo app só com o recebedor aprovado. Sem isso, o pedido
// segue o fluxo antigo (pagamento combinado fora do gateway).
async function receivesInApp(client, providerId) {
  const account = await loadAccount(client, providerId);
  return Boolean(account && account.status === "aprovada" && account.gateway_recipient_id) ? account : null;
}

// Dentro da transação que cria o pedido. O servidor calcula tudo: nenhum
// valor de taxa ou total vem do app.
async function createOrderCharge(client, { order, service, customerId, paymentMethod, idempotencyKey, requestFingerprint, account }) {
  await assertCustomerComplete(client, customerId);
  const settings = await loadProviderSettings(client, service.provider_id);
  const breakdown = priceBreakdown(centsFromDecimal(service.base_price), settings);
  const method = paymentMethod.type === "pix" ? "pix" : "cartao";
  const savedCard = paymentMethod.savedCardId ? await loadOwnCard(client, customerId, paymentMethod.savedCardId) : null;
  const { rows } = await client.query(
    `INSERT INTO charges (origin,order_id,customer_id,provider_id,charge_owner,total_cents,fee_cents,provider_amount_cents,
       fee_payer,status,payment_method,idempotency_key,request_fingerprint,gateway,settings_snapshot,settings_version,
       pending_card_token_encrypted,saved_card_id)
     VALUES ('avulso',$1,$2,$3,$4,$5,$6,$7,$8,'pendente',$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [order.id, customerId, service.provider_id, gateway().capabilities().titularDaCobranca, breakdown.totalCents,
     breakdown.feeCents, breakdown.providerAmountCents, breakdown.feePayer, method, idempotencyKey, requestFingerprint,
     gateway().nome, snapshotOf(settings), settingsVersion(settings),
     method === "cartao" && !savedCard ? encryptText(paymentMethod.paymentMethodToken) : null, savedCard?.id ?? null]
  );
  const charge = rows[0];
  const payoutDate = expectedPayoutDateKey(new Date(), method, settings, payoutSchedule(settings, account));
  const deductionCents = await reserveDeductions(client, {
    providerId: service.provider_id, availableCents: breakdown.providerAmountCents, payoutDate, chargeId: charge.id,
  });
  const split = buildSplit({ providerAmountCents: breakdown.providerAmountCents, feeCents: breakdown.feeCents, deductionCents });
  await client.query("UPDATE charges SET deduction_cents=$2 WHERE id=$1", [charge.id, deductionCents]);
  await insertSplits(client, charge.id, split, account.gateway_recipient_id);
  afterCommit(client, () => submitCharge(charge.id));
  return { ...charge, deduction_cents: deductionCents };
}

async function insertSplits(client, chargeId, split, recipientId) {
  await client.query(
    `INSERT INTO charge_splits (charge_id,party,gateway_recipient_id,amount_cents)
     VALUES ($1,'prestadora',$2,$3),($1,'plataforma',NULL,$4) ON CONFLICT (charge_id,party) DO NOTHING`,
    [chargeId, recipientId, split.prestadora, split.plataforma]
  );
}

// Envia a cobrança ao gateway (depois do COMMIT; repetível com a mesma chave)
async function submitCharge(chargeId) {
  const { rows } = await db.runQuery(
    `SELECT c.*, a.gateway_recipient_id, cc.gateway_card_id, cc.gateway_customer_id,
       (SELECT amount_cents FROM charge_splits WHERE charge_id=c.id AND party='prestadora') AS provider_split,
       (SELECT amount_cents FROM charge_splits WHERE charge_id=c.id AND party='plataforma') AS platform_split
     FROM charges c JOIN provider_payment_accounts a ON a.provider_id = c.provider_id
     LEFT JOIN customer_cards cc ON cc.id = c.saved_card_id
     WHERE c.id=$1`,
    [chargeId]
  );
  const charge = rows[0];
  if (!charge || charge.gateway_charge_id || charge.status !== "pendente") return;
  const result = await gateway().createCharge({
    recipientId: charge.gateway_recipient_id,
    valorTotal: charge.total_cents,
    split: gatewaySplit({ prestadora: charge.provider_split, plataforma: charge.platform_split }, charge.gateway_recipient_id),
    metodoPagamento: charge.payment_method === "pix"
      ? { tipo: "pix" }
      : charge.gateway_card_id
        ? savedCardMethod(charge)
        : { tipo: "cartao", tokenDoGateway: decryptText(charge.pending_card_token_encrypted) },
    referencia: { tipo: "cobranca", id: charge.id },
    idempotencyKey: `charge:${charge.id}`,
  });
  // o webhook pode ter chegado antes desta linha: não rebaixa o status
  await db.runQuery(
    `UPDATE charges SET gateway_charge_id=COALESCE(gateway_charge_id,$2), pix_copy_paste=$3,
       status=CASE WHEN status='pendente' THEN 'processando' ELSE status END,
       pending_card_token_encrypted=NULL, updated_at=now()
     WHERE id=$1`,
    [charge.id, result.chargeId, result.pix?.copiaECola ?? null]
  );
}

// ---------- Estorno ----------

async function requestRefund(client, charge, amountCents, { reason, actorId = null, idempotencyKey }) {
  const { rows: existing } = await client.query("SELECT * FROM refunds WHERE idempotency_key=$1", [idempotencyKey]);
  if (existing[0]) return existing[0];
  if (!["paga", "estornada_parcial"].includes(charge.status))
    throw new ApiError(409, "charge_not_refundable", `Cobrança ${charge.status} não pode ser estornada.`);
  const allocation = await planRefund(client, charge, amountCents);
  const { rows } = await client.query(
    `INSERT INTO refunds (charge_id,amount_cents,provider_reversed_cents,platform_reversed_cents,idempotency_key,reason,requested_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [charge.id, amountCents, allocation.providerCents, allocation.platformCents, idempotencyKey, reason, actorId]
  );
  const refund = rows[0];
  afterCommit(client, () => submitRefund(refund.id));
  return refund;
}

async function submitRefund(refundId) {
  const { rows } = await db.runQuery(
    "SELECT r.*, c.gateway_charge_id FROM refunds r JOIN charges c ON c.id = r.charge_id WHERE r.id=$1",
    [refundId]
  );
  const refund = rows[0];
  if (!refund || refund.gateway_refund_id || refund.status !== "solicitado") return;
  try {
    const result = await gateway().refund(refund.gateway_charge_id, refund.amount_cents, { idempotencyKey: `refund:${refund.id}` });
    await db.runQuery("UPDATE refunds SET gateway_refund_id=COALESCE(gateway_refund_id,$2), updated_at=now() WHERE id=$1", [refund.id, result.refundId]);
  } catch (error) {
    if (error.retryable) throw error;
    await db.runQuery("UPDATE refunds SET status='falhou', updated_at=now() WHERE id=$1 AND status='solicitado'", [refund.id]);
    console.error(`estorno ${refund.id} recusado pelo gateway:`, error.message);
  }
}

// ---------- Integração com o pedido ----------

async function latestOrderCharge(client, orderId) {
  const { rows } = await client.query(
    "SELECT * FROM charges WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
    [orderId]
  );
  return rows[0] ?? null;
}

// A prestadora só aceita pedido pago no app depois do webhook de pagamento
async function assertOrderPaid(client, order) {
  const charge = await latestOrderCharge(client, order.id);
  if (charge && charge.status !== "paga")
    throw new ApiError(409, "payment_pending", charge.status === "falhou"
      ? "O pagamento deste pedido foi recusado."
      : "Aguarde a confirmação do pagamento para aceitar o pedido.");
}

// Pedido cancelado: devolve a sessão da assinatura ou estorna o avulso.
// - prestadora recusou/cancelou, ou o pedido ainda não tinha sido aceito:
//   devolução integral;
// - cliente cancelou um pedido aceito: só dentro do prazo configurado
//   (entitlement_refund_window_hours antes do horário).
async function handleOrderCancelled(client, order, actingRole) {
  const hoursBefore = (new Date(order.scheduled_at).getTime() - Date.now()) / (60 * 60 * 1000);
  const fullRefund = actingRole === "provider" || order.status === "requested";

  const { rows: usages } = await client.query(
    `SELECT s.settings_snapshot FROM entitlement_usages u
     JOIN entitlements e ON e.id = u.entitlement_id JOIN subscriptions s ON s.id = e.subscription_id
     WHERE u.order_id=$1 AND u.status='debitado'`,
    [order.id]
  );
  if (usages[0]) {
    const windowHours = usages[0].settings_snapshot.entitlement_refund_window_hours;
    if (fullRefund || hoursBefore >= windowHours) await returnEntitlement(client, order.id);
  }

  const charge = await latestOrderCharge(client, order.id);
  if (!charge) return;
  if (charge.status === "paga") {
    const windowHours = charge.settings_snapshot.entitlement_refund_window_hours;
    if (fullRefund || hoursBefore >= windowHours) {
      await requestRefund(client, charge, charge.total_cents, {
        reason: actingRole === "provider" ? "Pedido recusado/cancelado pela prestadora" : "Cancelado pela cliente no prazo",
        idempotencyKey: `order-cancel:${charge.id}`,
      });
    }
  }
  // pendente/processando: se o pagamento for confirmado depois, o webhook
  // estorna (pedido já cancelado)
}

// Pagamento recusado: o pedido ainda não aceito é cancelado
async function cancelOrderForFailedPayment(client, charge, reason) {
  const { rows } = await client.query(
    `UPDATE orders SET status='cancelled', cancellation_reason=$2
     WHERE id=$1 AND status='requested' RETURNING id, customer_id, provider_id`,
    [charge.order_id, `Pagamento recusado${reason ? `: ${reason}` : ""}`]
  );
  if (!rows[0]) return;
  await client.query(
    "INSERT INTO order_events (order_id,actor_id,type,data) VALUES ($1,NULL,'status_changed',$2)",
    [charge.order_id, { from: "requested", to: "cancelled", reason: "payment_failed" }]
  );
  await client.query("UPDATE payments SET status='released' WHERE order_id=$1 AND status='held'", [charge.order_id]);
  await notify(client, {
    userId: rows[0].customer_id, type: "order_payment_failed", title: "Pagamento recusado",
    body: "Não conseguimos confirmar o pagamento e o pedido foi cancelado. Tente de novo com outro meio.",
    data: { orderId: charge.order_id }, area: "customer",
  });
}

async function notifyOrderPaid(client, charge) {
  await notify(client, {
    userId: charge.provider_id, type: "order_payment_confirmed", title: "Pagamento confirmado",
    body: "O pagamento do pedido foi confirmado. Você já pode aceitar.",
    data: { orderId: charge.order_id }, area: "provider",
  });
}

// Cobranças que não chegaram ao gateway (falha depois do COMMIT)
async function resubmitStuckCharges() {
  const { rows } = await db.runQuery(
    `SELECT id FROM charges WHERE status='pendente' AND gateway_charge_id IS NULL AND origin='avulso'
       AND created_at < now() - interval '1 minute' AND created_at > now() - make_interval(secs => $1) LIMIT 20`,
    [DAY_MS / 1000]
  );
  for (const { id } of rows) await submitCharge(id).catch((error) => console.error(`cobrança ${id}:`, error.message));
  const { rows: refunds } = await db.runQuery(
    "SELECT id FROM refunds WHERE status='solicitado' AND gateway_refund_id IS NULL AND created_at < now() - interval '1 minute' LIMIT 20"
  );
  for (const { id } of refunds) await submitRefund(id).catch((error) => console.error(`estorno ${id}:`, error.message));
}

module.exports = {
  receivesInApp,
  createOrderCharge,
  insertSplits,
  submitCharge,
  requestRefund,
  submitRefund,
  latestOrderCharge,
  assertOrderPaid,
  handleOrderCancelled,
  cancelOrderForFailedPayment,
  notifyOrderPaid,
  resubmitStuckCharges,
};
