// Razão do módulo: descontos nos repasses, repasses previstos, estornos e os
// dados da nota de cada cobrança paga.
const { allocateDeductions, refundAllocation } = require("./money");
const { expectedPayoutDateKey, competenciaKey, brasiliaDateKey } = require("./dates");
const { payoutSchedule } = require("./settings");
const { deriveFiscalStatus, customerMissingFields, loadCustomerFiscalData } = require("./fiscal");
const { decimalFromCents } = require("./runtime");
const { encryptText } = require("../security");

// ---------- Descontos (ativação, camada, estorno já repassado) ----------

// Saldo em aberto de cada desconto e quanto ainda cabe na janela de repasse
async function openDeductions(client, providerId, payoutDate) {
  await client.query(
    "SELECT id FROM provider_deductions WHERE provider_id=$1 AND settled_at IS NULL FOR UPDATE",
    [providerId]
  );
  const { rows } = await client.query(
    `SELECT d.id, d.amount_cents, d.per_payout_cap_cents,
       (d.amount_cents - COALESCE(SUM(cd.amount_cents) FILTER (WHERE cd.status IN ('reservado','confirmado')), 0))::int AS remaining_cents,
       COALESCE(SUM(cd.amount_cents) FILTER (WHERE cd.status IN ('reservado','confirmado') AND cd.payout_date = $2::date), 0)::int AS used_in_window_cents
     FROM provider_deductions d
     LEFT JOIN charge_deductions cd ON cd.deduction_id = d.id
     WHERE d.provider_id = $1 AND d.settled_at IS NULL
     GROUP BY d.id
     ORDER BY d.created_at, d.id`,
    [providerId, payoutDate]
  );
  return rows.map((row) => ({
    id: row.id,
    remainingCents: row.remaining_cents,
    capCents: row.per_payout_cap_cents == null ? null : Math.max(0, row.per_payout_cap_cents - row.used_in_window_cents),
  }));
}

// Reserva descontos sobre a parte da prestadora numa cobrança (avulsa:
// chargeId; ciclo de assinatura: subscriptionId + cycle). Devolve o total.
async function reserveDeductions(client, { providerId, availableCents, payoutDate, chargeId = null, subscriptionId = null, cycle = null }) {
  const deductions = await openDeductions(client, providerId, payoutDate);
  const allocations = allocateDeductions(availableCents, deductions.filter((deduction) => deduction.remainingCents > 0));
  for (const allocation of allocations) {
    await client.query(
      `INSERT INTO charge_deductions (charge_id,subscription_id,subscription_cycle,deduction_id,amount_cents,payout_date)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [chargeId, subscriptionId, cycle, allocation.id, allocation.amountCents, payoutDate]
    );
  }
  return allocations.reduce((sum, allocation) => sum + allocation.amountCents, 0);
}

// Cobrança paga: o que estava reservado vira confirmado; desconto quitado fecha.
async function confirmDeductions(client, charge) {
  await client.query(
    `UPDATE charge_deductions SET status='confirmado', charge_id=$1
     WHERE status='reservado' AND (charge_id=$1 OR (charge_id IS NULL AND subscription_id=$2 AND subscription_cycle=$3))`,
    [charge.id, charge.subscription_id, charge.subscription_cycle]
  );
  await client.query(
    `UPDATE provider_deductions d SET settled_at=now()
     WHERE d.provider_id=$1 AND d.settled_at IS NULL
       AND d.amount_cents <= (SELECT COALESCE(SUM(amount_cents),0) FROM charge_deductions
                              WHERE deduction_id=d.id AND status='confirmado')`,
    [charge.provider_id]
  );
}

// Cobrança recusada/cancelada: devolve ao saldo o que estava reservado
async function releaseReservedDeductions(client, { chargeId = null, subscriptionId = null, cycle = null }) {
  await client.query(
    `UPDATE charge_deductions SET status='liberado'
     WHERE status='reservado' AND (charge_id=$1 OR ($1::uuid IS NULL AND subscription_id=$2 AND ($3::int IS NULL OR subscription_cycle=$3)))`,
    [chargeId, subscriptionId, cycle]
  );
}

// ---------- Cobrança paga ----------

async function loadAccount(client, providerId) {
  const { rows } = await client.query("SELECT * FROM provider_payment_accounts WHERE provider_id=$1", [providerId]);
  return rows[0] ?? null;
}

// Repasse previsto, lançamento no financeiro e dados da nota. Tudo a partir
// do snapshot gravado na cobrança.
async function recordPaidCharge(client, charge, paidAt) {
  const snapshot = charge.settings_snapshot;
  const account = await loadAccount(client, charge.provider_id);
  const { rows: splits } = await client.query(
    "SELECT amount_cents FROM charge_splits WHERE charge_id=$1 AND party='prestadora'",
    [charge.id]
  );
  const providerShare = splits[0]?.amount_cents ?? charge.provider_amount_cents - charge.deduction_cents;
  const payoutDate = expectedPayoutDateKey(paidAt, charge.payment_method, snapshot, payoutSchedule(snapshot, account));
  await client.query(
    `INSERT INTO payables (provider_id,charge_id,amount_cents,expected_payout_date)
     VALUES ($1,$2,$3,$4) ON CONFLICT (charge_id) DO NOTHING`,
    [charge.provider_id, charge.id, providerShare, payoutDate]
  );
  await confirmDeductions(client, charge);

  // Assinatura entra no financeiro como "a receber" quando é paga; o avulso
  // continua entrando na conclusão do atendimento (ver orders.js).
  if (charge.origin === "assinatura" && providerShare > 0) {
    await client.query(
      `INSERT INTO financial_entries (provider_id,entry_type,amount,category,description,customer_id,occurred_at)
       VALUES ($1,'receivable',$2,'Assinatura',$3,$4,$5)`,
      [charge.provider_id, decimalFromCents(providerShare), `Assinatura (ciclo ${charge.subscription_cycle}), repasse previsto ${payoutDate}`,
       charge.customer_id, paidAt]
    );
  }

  // Dado fiscal faltando nunca bloqueia a cobrança: falha aqui só é registrada
  await client.query("SAVEPOINT invoice_data");
  try {
    await buildInvoiceData(client, charge, paidAt);
    await client.query("RELEASE SAVEPOINT invoice_data");
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT invoice_data");
    console.error(`invoice_data da cobrança ${charge.id} não foi montado:`, error.message);
  }
  return { payoutDate, providerShare };
}

async function chargeDescription(client, charge) {
  if (charge.origin === "assinatura") {
    const { rows } = await client.query(
      `SELECT p.name, string_agg(i.sessions_per_cycle || 'x ' || s.title, ', ' ORDER BY s.title) AS items
       FROM subscriptions sub JOIN subscription_plans p ON p.id = sub.plan_id
       LEFT JOIN subscription_plan_items i ON i.plan_id = p.id
       LEFT JOIN services s ON s.id = i.service_id
       WHERE sub.id = $1 GROUP BY p.name`,
      [charge.subscription_id]
    );
    const plan = rows[0];
    return { description: `Plano ${plan?.name ?? ""}: ${plan?.items ?? "serviços"} (ciclo ${charge.subscription_cycle})`.trim(), serviceDate: null };
  }
  const { rows } = await client.query(
    `SELECT s.title, o.scheduled_at FROM orders o JOIN services s ON s.id = o.service_id WHERE o.id = $1`,
    [charge.order_id]
  );
  return { description: rows[0]?.title ?? "Serviço", serviceDate: rows[0] ? brasiliaDateKey(rows[0].scheduled_at) : null };
}

// Dados completos e normalizados da nota, copiados agora: a configuração
// fiscal pode mudar até a emissão.
async function buildInvoiceData(client, charge, paidAt) {
  const { rows: providers } = await client.query(
    `SELECT u.name, fp.*, (fp.cpf_encrypted IS NOT NULL) AS "hasCpf"
     FROM users u LEFT JOIN provider_fiscal_profiles fp ON fp.provider_id = u.id
     WHERE u.id = $1`,
    [charge.provider_id]
  );
  const provider = providers[0] ?? {};
  const fiscal = deriveFiscalStatus(provider.regime ? provider : null);
  const customer = await loadCustomerFiscalData(client, charge.customer_id);
  const { description, serviceDate } = await chargeDescription(client, charge);
  const address = customer?.address ?? {};
  // Valor da nota da prestadora: o preço do serviço dela. A taxa da SheServe
  // é receita de intermediação da plataforma (nota própria, fora daqui).
  const amountCents = charge.fee_payer === "prestadora" ? charge.total_cents : charge.provider_amount_cents;
  const missing = [
    ...fiscal.missingFields.map((field) => `prestadora.${field}`),
    ...customerMissingFields(customer).map((field) => `cliente.${field}`),
  ];
  const documentType = provider.document_type ?? (provider.cnpj ? "cnpj" : provider.cpf_encrypted ? "cpf" : null);
  const providerDocumentEncrypted = documentType === "cnpj" && provider.cnpj ? encryptText(provider.cnpj) : provider.cpf_encrypted ?? null;

  await client.query(
    `INSERT INTO invoice_data (
       charge_id, provider_id, provider_name, provider_document_type, provider_document_encrypted, provider_regime,
       provider_municipal_registration, provider_city_code, item_servico, aliquota_iss_bps, iss_retido,
       customer_name, customer_document_encrypted, customer_email,
       customer_street, customer_number, customer_complement, customer_neighborhood, customer_city, customer_uf, customer_cep,
       amount_cents, description, competencia, service_date, fiscal_status_at_charge, missing_fields, nbs_code, c_class_trib)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
     ON CONFLICT (charge_id) DO NOTHING`,
    [
      charge.id, charge.provider_id, provider.legal_name || provider.name || "Prestadora", documentType, providerDocumentEncrypted,
      provider.regime ?? null, provider.municipal_registration ?? null, provider.city_code ?? null,
      provider.service_code ?? null, provider.aliquota_iss_bps ?? null, provider.iss_retido ?? null,
      customer?.name ?? "Cliente", customer?.cpf_encrypted ?? null, customer?.email ?? null,
      address.street ?? null, address.number ?? null, address.complement ?? null, address.neighborhood ?? null,
      address.city ?? null, address.state ?? null, address.postal_code ?? null,
      amountCents, description, competenciaKey(paidAt), serviceDate, fiscal.statusConfig, missing,
      provider.nbs_code ?? null, provider.c_class_trib ?? null,
    ]
  );
}

// ---------- Estorno concluído ----------

// Reverte o split (inclusive a taxa), o repasse previsto e os descontos que
// tinham saído desta cobrança.
async function recordRefund(client, charge, refund) {
  const { rows: splits } = await client.query("SELECT * FROM charge_splits WHERE charge_id=$1 FOR UPDATE", [charge.id]);
  const providerSplit = splits.find((split) => split.party === "prestadora");
  const platformSplit = splits.find((split) => split.party === "plataforma");
  await client.query("UPDATE charge_splits SET refunded_cents=refunded_cents+$2 WHERE id=$1", [providerSplit.id, refund.provider_reversed_cents]);
  await client.query("UPDATE charge_splits SET refunded_cents=refunded_cents+$2 WHERE id=$1", [platformSplit.id, refund.platform_reversed_cents]);

  const refundedTotal = charge.refunded_cents + refund.amount_cents;
  const fullyRefunded = refundedTotal === charge.total_cents;
  await client.query(
    "UPDATE charges SET refunded_cents=$2, refunded_at=now(), status=$3, updated_at=now() WHERE id=$1",
    [charge.id, refundedTotal, fullyRefunded ? "estornada" : "estornada_parcial"]
  );
  await client.query("UPDATE refunds SET status='concluido', updated_at=now() WHERE id=$1", [refund.id]);

  // Repasse: se ainda não saiu, diminui; se já saiu, vira desconto nos próximos
  const { rows: payables } = await client.query("SELECT * FROM payables WHERE charge_id=$1 FOR UPDATE", [charge.id]);
  const payable = payables[0];
  if (payable && refund.provider_reversed_cents > 0) {
    if (payable.status === "previsto") {
      const reversed = payable.reversed_cents + refund.provider_reversed_cents;
      await client.query(
        "UPDATE payables SET reversed_cents=$2, status=CASE WHEN $2 >= amount_cents THEN 'revertido' ELSE status END WHERE id=$1",
        [payable.id, Math.min(reversed, payable.amount_cents)]
      );
    } else {
      await client.query(
        `INSERT INTO provider_deductions (provider_id,kind,description,amount_cents,settings_snapshot,reference)
         VALUES ($1,'estorno',$2,$3,$4,$5) ON CONFLICT (provider_id,reference) DO NOTHING`,
        [charge.provider_id, `Estorno de cobrança já repassada (${refund.id.slice(0, 8)})`, refund.provider_reversed_cents,
         charge.settings_snapshot, `estorno:${refund.id}`]
      );
    }
  }

  // O desconto de repasse estava dentro da parte da plataforma: estornado,
  // volta a ser devido (proporcional no parcial).
  const { rows: chargeDeductions } = await client.query(
    "SELECT * FROM charge_deductions WHERE charge_id=$1 AND status='confirmado' FOR UPDATE",
    [charge.id]
  );
  for (const deduction of chargeDeductions) {
    const released = fullyRefunded
      ? deduction.amount_cents
      : Math.floor((deduction.amount_cents * refund.amount_cents) / charge.total_cents);
    if (released <= 0) continue;
    if (released >= deduction.amount_cents) {
      await client.query("UPDATE charge_deductions SET status='liberado' WHERE id=$1", [deduction.id]);
    } else {
      await client.query("UPDATE charge_deductions SET amount_cents=amount_cents-$2 WHERE id=$1", [deduction.id, released]);
    }
    await client.query("UPDATE provider_deductions SET settled_at=NULL WHERE id=$1", [deduction.deduction_id]);
  }
  return { fullyRefunded };
}

// Valores de um estorno a partir do que resta de cada lado do split
async function planRefund(client, charge, amountCents) {
  const { rows: splits } = await client.query("SELECT * FROM charge_splits WHERE charge_id=$1", [charge.id]);
  const providerSplit = splits.find((split) => split.party === "prestadora");
  const platformSplit = splits.find((split) => split.party === "plataforma");
  const { rows: pending } = await client.query(
    `SELECT COALESCE(SUM(provider_reversed_cents),0)::int AS provider, COALESCE(SUM(platform_reversed_cents),0)::int AS platform
     FROM refunds WHERE charge_id=$1 AND status <> 'falhou'`,
    [charge.id]
  );
  return refundAllocation({
    refundCents: amountCents,
    totalCents: charge.total_cents,
    providerSplitCents: providerSplit.amount_cents,
    providerReversedCents: pending[0].provider,
    platformReversedCents: pending[0].platform,
  });
}

module.exports = {
  openDeductions,
  reserveDeductions,
  confirmDeductions,
  releaseReservedDeductions,
  recordPaidCharge,
  buildInvoiceData,
  recordRefund,
  planRefund,
  loadAccount,
};
