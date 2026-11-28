// Endpoints só de desenvolvimento (NODE_ENV != production e gateway mock),
// para demonstrar o fluxo sem esperar o tempo real:
//   POST /dev/payments/charges/:id/approve   força a aprovação de uma cobrança em processamento
//   POST /dev/payments/charges/:id/fail      força a recusa
//   POST /dev/payments/charges/:id/refund    estorna (total ou { amountCents })
//   POST /dev/payments/subscriptions/:id/advance-cycle   "vira o mês": cobra o próximo
//        ciclo (ou a próxima retentativa) agora; { outcome: 'approve' | 'fail' } opcional
//   POST /dev/payments/run-maintenance       roda o agendador (fim de ciclo, repasses...)
// Só quem participa da cobrança/assinatura pode usá-los. O resultado chega
// pelo webhook, como em produção: nada aqui marca cobrança como paga.
const devPaymentsRouter = require("express").Router();
const { z } = require("zod");
const db = require("../db");
const { ApiError, asyncHandler } = require("../errors");
const { isValidUuid } = require("../validation");
const { gateway, isDemoMode } = require("../payments/runtime");
const { requestRefund } = require("../payments/charges");
const { runPaymentsMaintenance } = require("../payments/maintenance");

const devEnabled = () => process.env.NODE_ENV !== "production" && isDemoMode();

devPaymentsRouter.use("/dev/payments", (_request, _response, next) => {
  if (!devEnabled()) return next(new ApiError(404, "not_found", "Route not found."));
  next();
});

async function loadParticipantCharge(request) {
  if (!isValidUuid(request.params.id)) throw new ApiError(404, "not_found", "Cobrança não encontrada.");
  const { rows } = await db.runQuery("SELECT * FROM charges WHERE id=$1", [request.params.id]);
  const charge = rows[0];
  if (!charge || ![charge.customer_id, charge.provider_id].includes(request.user.id))
    throw new ApiError(404, "not_found", "Cobrança não encontrada.");
  if (!charge.gateway_charge_id) throw new ApiError(409, "not_sent", "A cobrança ainda não chegou ao gateway.");
  return charge;
}

async function forceOutcome(request, outcome) {
  const charge = await loadParticipantCharge(request);
  try {
    await gateway().forceChargeOutcome(charge.gateway_charge_id, outcome);
  } catch (error) {
    throw new ApiError(409, error.code ?? "gateway_error", error.message);
  }
  const { rows } = await db.runQuery("SELECT id, status FROM charges WHERE id=$1", [charge.id]);
  return rows[0];
}

devPaymentsRouter.post("/dev/payments/charges/:id/approve", asyncHandler(async (request, response) => {
  response.json(await forceOutcome(request, "approve"));
}));

devPaymentsRouter.post("/dev/payments/charges/:id/fail", asyncHandler(async (request, response) => {
  response.json(await forceOutcome(request, "fail"));
}));

devPaymentsRouter.post("/dev/payments/charges/:id/refund", asyncHandler(async (request, response) => {
  const { amountCents } = z.object({ amountCents: z.number().int().positive().optional() }).strict().parse(request.body ?? {});
  const charge = await loadParticipantCharge(request);
  const refund = await db.runInTransaction(async (client) => {
    const { rows } = await client.query("SELECT * FROM charges WHERE id=$1 FOR UPDATE", [charge.id]);
    const current = rows[0];
    return requestRefund(client, current, amountCents ?? current.total_cents - current.refunded_cents, {
      reason: "Estorno forçado (demonstração)",
      actorId: request.user.id,
      idempotencyKey: `dev-refund:${current.id}:${current.refunded_cents}:${amountCents ?? "total"}`,
    });
  });
  response.status(202).json({ refundId: refund.id, status: refund.status });
}));

devPaymentsRouter.post("/dev/payments/subscriptions/:id/advance-cycle", asyncHandler(async (request, response) => {
  const { outcome } = z.object({ outcome: z.enum(["approve", "fail"]).optional() }).strict().parse(request.body ?? {});
  if (!isValidUuid(request.params.id)) throw new ApiError(404, "not_found", "Assinatura não encontrada.");
  const { rows } = await db.runQuery("SELECT * FROM subscriptions WHERE id=$1", [request.params.id]);
  const sub = rows[0];
  if (!sub || ![sub.customer_id, sub.provider_id].includes(request.user.id))
    throw new ApiError(404, "not_found", "Assinatura não encontrada.");
  if (!sub.gateway_subscription_id) throw new ApiError(409, "not_sent", "A assinatura ainda não chegou ao gateway.");

  // Cancelamento agendado: virar o mês encerra a assinatura (fim do ciclo)
  if (sub.status === "ativa" && sub.cancel_at_period_end) {
    await db.runQuery("UPDATE subscriptions SET current_period_end=now() WHERE id=$1", [sub.id]);
    await runPaymentsMaintenance();
  } else if (sub.status === "suspensa") {
    await db.runQuery(
      "UPDATE subscriptions SET suspended_at=now() - make_interval(days => (settings_snapshot->>'suspension_grace_days')::int) WHERE id=$1",
      [sub.id]
    );
    await runPaymentsMaintenance();
  } else {
    try {
      await gateway().advanceSubscription(sub.gateway_subscription_id, outcome);
    } catch (error) {
      throw new ApiError(409, error.code ?? "gateway_error", error.message);
    }
  }
  const { rows: updated } = await db.runQuery(
    "SELECT id, status, current_cycle AS \"cycle\", current_period_end AS \"periodEnd\", retry_attempt AS \"retryAttempt\" FROM subscriptions WHERE id=$1",
    [sub.id]
  );
  response.json(updated[0]);
}));

devPaymentsRouter.post("/dev/payments/run-maintenance", asyncHandler(async (_request, response) => {
  await runPaymentsMaintenance();
  response.sendStatus(204);
}));

module.exports = { devPaymentsRouter, devEnabled };
