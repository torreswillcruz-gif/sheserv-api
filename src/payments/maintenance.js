// Agendador do módulo (roda a cada 30 s no servidor e sob demanda nos
// endpoints de demonstração):
// - fim de ciclo com cancelamento, fim do prazo de suspensão, repactuação;
// - mensalidade das camadas (vira desconto de repasse);
// - repasses previstos que venceram (no mock, o repasse "sai" na data);
// - cobranças/estornos que não chegaram ao gateway;
// - jobs do MockGateway (liquidação e webhooks).
const db = require("../db");
const { gateway } = require("./runtime");
const { runMaintenance: runSubscriptionMaintenance } = require("./subscriptions");
const { resubmitStuckCharges } = require("./charges");
const { billTierIfDue } = require("./accounts");
const { brasiliaDateKey } = require("./dates");
const { generateDueSchedules } = require("./subscriptionSchedule");

async function billDueTiers() {
  const { rows } = await db.runQuery(
    `SELECT provider_id FROM provider_plans
     WHERE plan_name IN ('standard','pro') AND (tier_billed_until IS NULL OR tier_billed_until <= now()) LIMIT 100`
  );
  for (const { provider_id: providerId } of rows) {
    await db.runInTransaction((client) => billTierIfDue(client, providerId));
  }
}

async function settleDuePayables() {
  if (gateway().nome !== "mock") return; // no PSP real, o repasse é confirmado por ele
  await db.runQuery(
    // repasse só para quem fez a prova de vida (o PSP também segura o saldo)
    `UPDATE payables p SET status='pago', paid_at=now()
     WHERE p.status='previsto' AND p.expected_payout_date <= $1::date
       AND EXISTS (SELECT 1 FROM provider_payment_accounts a WHERE a.provider_id=p.provider_id AND a.kyc_status='aprovada')`,
    [brasiliaDateKey(new Date())]
  );
}

let running = null;

function runPaymentsMaintenance() {
  if (!running) {
    running = (async () => {
      const steps = [
        ["mock", () => (typeof gateway().pump === "function" ? gateway().pump() : null)],
        ["assinaturas", runSubscriptionMaintenance],
        ["agendas", generateDueSchedules],
        ["camadas", billDueTiers],
        ["repasses", settleDuePayables],
        ["reenvio", resubmitStuckCharges],
      ];
      for (const [name, step] of steps) {
        try {
          await step();
        } catch (error) {
          console.error(`manutenção de pagamentos (${name}):`, error.message);
        }
      }
    })().finally(() => { running = null; });
  }
  return running;
}

function startPaymentsScheduler(intervalMs = 30000) {
  const timer = setInterval(() => { runPaymentsMaintenance(); }, intervalMs);
  timer.unref();
  return timer;
}

module.exports = { runPaymentsMaintenance, startPaymentsScheduler };
