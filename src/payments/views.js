// Leituras do módulo: extrato, notas, assinaturas da cliente, perfil fiscal e
// estatísticas. O extrato é reconstruído do que foi gravado em cada cobrança
// (split e snapshot), nunca recalculado com a configuração atual.
const { ApiError } = require("../errors");
const { encryptText, decryptText } = require("../security");
const { deriveFiscalStatus, FIELD_LABELS, onlyDigits, isValidCpf, isValidCnpj, REGIMES, formatDocument } = require("./fiscal");
const { brasiliaDateKey } = require("./dates");

const safeDecrypt = (value) => {
  if (!value) return null;
  try { return decryptText(value); } catch { return null; }
};

// "126021000" → "1.2602.10.00"
const formatNbs = (nbs) => (nbs && /^\d{9}$/.test(nbs) ? `${nbs[0]}.${nbs.slice(1, 5)}.${nbs.slice(5, 7)}.${nbs.slice(7)}` : nbs);

const formatCep = (cep) => (cep && cep.length === 8 ? `${cep.slice(0, 5)}-${cep.slice(5)}` : cep);

// ---------- Extrato da prestadora ----------

async function providerStatement(client, providerId) {
  const { rows: charges } = await client.query(
    `SELECT c.id, c.origin, c.status, c.payment_method AS "paymentMethod", c.created_at AS "createdAt", c.paid_at AS "paidAt",
       c.provider_amount_cents AS "providerAmountCents", c.deduction_cents AS "deductionCents",
       c.refunded_cents AS "refundedCents", c.subscription_cycle AS "cycle",
       ps.amount_cents AS "receivedCents", ps.refunded_cents AS "providerRefundedCents",
       u.name AS "customerName",
       COALESCE(sp.name, sv.title) AS "description",
       p.expected_payout_date::text AS "expectedPayoutDate", p.status AS "payoutStatus",
       inv.status AS "invoiceStatus"
     FROM charges c
     JOIN users u ON u.id = c.customer_id
     LEFT JOIN charge_splits ps ON ps.charge_id = c.id AND ps.party = 'prestadora'
     LEFT JOIN payables p ON p.charge_id = c.id
     LEFT JOIN subscriptions s ON s.id = c.subscription_id
     LEFT JOIN subscription_plans sp ON sp.id = s.plan_id
     LEFT JOIN orders o ON o.id = c.order_id
     LEFT JOIN services sv ON sv.id = o.service_id
     LEFT JOIN invoice_data inv ON inv.charge_id = c.id
     WHERE c.provider_id = $1 AND c.status IN ('paga','estornada','estornada_parcial','falhou')
     ORDER BY COALESCE(c.paid_at, c.created_at) DESC
     LIMIT 200`,
    [providerId]
  );
  const { rows: upcoming } = await client.query(
    `SELECT expected_payout_date::text AS date, SUM(amount_cents - reversed_cents)::int AS "amountCents", COUNT(*)::int AS charges
     FROM payables WHERE provider_id=$1 AND status='previsto'
     GROUP BY expected_payout_date ORDER BY expected_payout_date LIMIT 12`,
    [providerId]
  );
  const { rows: deductions } = await client.query(
    `SELECT d.id, d.kind, d.description, d.amount_cents AS "amountCents",
       (d.amount_cents - COALESCE(SUM(cd.amount_cents) FILTER (WHERE cd.status='confirmado'),0))::int AS "remainingCents"
     FROM provider_deductions d LEFT JOIN charge_deductions cd ON cd.deduction_id=d.id
     WHERE d.provider_id=$1 AND d.settled_at IS NULL GROUP BY d.id ORDER BY d.created_at`,
    [providerId]
  );
  const { rows: totals } = await client.query(
    `SELECT COALESCE(SUM(amount_cents - reversed_cents) FILTER (WHERE status='pago'),0)::int AS "paidOutCents",
            COALESCE(SUM(amount_cents - reversed_cents) FILTER (WHERE status='previsto'),0)::int AS "scheduledCents"
     FROM payables WHERE provider_id=$1`,
    [providerId]
  );
  const { rows: kyc } = await client.query("SELECT kyc_status FROM provider_payment_accounts WHERE provider_id=$1", [providerId]);
  return {
    charges: charges.map((charge) => ({
      ...charge,
      // o que ela recebe de fato desta cobrança (split gravado menos estornos)
      netReceivedCents: charge.status === "falhou" ? 0 : (charge.receivedCents ?? 0) - (charge.providerRefundedCents ?? 0),
    })),
    upcomingPayouts: upcoming,
    openDeductions: deductions,
    totals: totals[0],
    // sem prova de vida o PSP segura os repasses
    payoutsOnHold: kyc[0]?.kyc_status !== "aprovada",
  };
}

// ---------- Notas (dados prontos para copiar) ----------

const EMISSOR_NACIONAL_URL = "https://www.nfse.gov.br/EmissorNacional";

async function listInvoices(client, providerId) {
  const { rows } = await client.query(
    `SELECT i.charge_id AS "chargeId", i.customer_name AS "customerName", i.amount_cents AS "amountCents",
       i.description, i.competencia::text AS competencia, i.status, i.missing_fields AS "missingFields",
       c.paid_at AS "paidAt"
     FROM invoice_data i JOIN charges c ON c.id = i.charge_id
     WHERE i.provider_id=$1 ORDER BY c.paid_at DESC NULLS LAST LIMIT 200`,
    [providerId]
  );
  return { emissorNacionalUrl: EMISSOR_NACIONAL_URL, invoices: rows };
}

async function invoiceDetail(client, providerId, chargeId) {
  const { rows } = await client.query(
    `SELECT i.*, c.paid_at, c.status AS charge_status FROM invoice_data i JOIN charges c ON c.id=i.charge_id
     WHERE i.charge_id=$1 AND i.provider_id=$2`,
    [chargeId, providerId]
  );
  const invoice = rows[0];
  if (!invoice) throw new ApiError(404, "not_found", "Dados da nota não encontrados.");
  const amount = `${Math.trunc(invoice.amount_cents / 100)},${String(invoice.amount_cents % 100).padStart(2, "0")}`;
  const addressLine = [invoice.customer_street, invoice.customer_number, invoice.customer_complement].filter(Boolean).join(", ");
  // Cada campo vira uma linha com botão de copiar no app, na ordem do Emissor Nacional
  const fields = [
    ["tomador", "Tomador (nome)", invoice.customer_name],
    ["cpf", "CPF do tomador", formatDocument(safeDecrypt(invoice.customer_document_encrypted))],
    ["email", "E-mail do tomador", invoice.customer_email],
    ["endereco", "Endereço", addressLine || null],
    ["bairro", "Bairro", invoice.customer_neighborhood],
    ["cidade", "Cidade/UF", invoice.customer_city ? `${invoice.customer_city}/${invoice.customer_uf ?? ""}` : null],
    ["cep", "CEP", formatCep(invoice.customer_cep)],
    ["valor", "Valor do serviço (R$)", amount],
    ["descricao", "Descrição do serviço", invoice.description],
    ["competencia", "Competência", invoice.competencia ? brasiliaDateKey(new Date(invoice.competencia)).slice(0, 7).split("-").reverse().join("/") : null],
    ["item", "Item de serviço (LC 116)", invoice.item_servico],
    ["aliquota", "Alíquota de ISS (%)", invoice.provider_regime === "mei"
      ? "Não se aplica (MEI recolhe o ISS no DAS)"
      : invoice.aliquota_iss_bps == null ? null
      : `${Math.trunc(invoice.aliquota_iss_bps / 100)},${String(invoice.aliquota_iss_bps % 100).padStart(2, "0")}`],
    ["issRetido", "ISS retido", invoice.iss_retido == null ? null : invoice.iss_retido ? "Sim" : "Não"],
    ["nbs", "Código NBS", formatNbs(invoice.nbs_code)],
    ["cClassTrib", "Classificação tributária (cClassTrib)", invoice.c_class_trib],
  ].map(([key, label, value]) => ({ key, label, value: value ?? null }));
  return {
    chargeId: invoice.charge_id,
    status: invoice.status,
    statusChangedAt: invoice.status_changed_at,
    fiscalStatusAtCharge: invoice.fiscal_status_at_charge,
    missingFields: invoice.missing_fields,
    emissorNacionalUrl: EMISSOR_NACIONAL_URL,
    fields,
  };
}

async function setInvoiceStatus(client, providerId, chargeId, status) {
  const { rows } = await client.query(
    "UPDATE invoice_data SET status=$3, status_changed_at=now(), updated_at=now() WHERE charge_id=$1 AND provider_id=$2 RETURNING charge_id",
    [chargeId, providerId, status]
  );
  if (!rows[0]) throw new ApiError(404, "not_found", "Dados da nota não encontrados.");
}

// ---------- Perfil fiscal ----------

async function fiscalProfile(client, providerId) {
  const { rows } = await client.query(
    `SELECT fp.*, (fp.cpf_encrypted IS NOT NULL) AS "hasCpf", pp.city_code AS provider_city, u.cpf_encrypted AS user_cpf
     FROM provider_profiles pp JOIN users u ON u.id = pp.user_id
     LEFT JOIN provider_fiscal_profiles fp ON fp.provider_id = pp.user_id
     WHERE pp.user_id=$1`,
    [providerId]
  );
  const row = rows[0] ?? {};
  const status = deriveFiscalStatus(row.regime ? row : null);
  const cityCode = row.city_code ?? row.provider_city ?? null;
  // Pré-preenchido pelo município (e pela categoria principal, se houver)
  const { rows: defaults } = await client.query(
    `SELECT d.item_servico, d.aliquota_iss_bps, d.nbs_code, d.c_class_trib, d.confirmed, m.name AS city_name
     FROM municipal_service_defaults d JOIN municipalities m ON m.ibge_code = d.ibge_code
     WHERE d.ibge_code = $1
       AND (d.category_id IS NULL OR d.category_id = (
         SELECT category_id FROM services WHERE provider_id=$2 AND active GROUP BY category_id ORDER BY COUNT(*) DESC LIMIT 1))
     ORDER BY d.category_id IS NULL LIMIT 1`,
    [cityCode, providerId]
  );
  // Pessoa física: o CPF é o do cadastro (não se digita de novo)
  const registeredCpf = safeDecrypt(row.user_cpf);
  const cpf = registeredCpf ?? safeDecrypt(row.cpf_encrypted);
  const serviceCode = row.service_code ?? defaults[0]?.item_servico ?? null;
  // NBS válidos para o item escolhido (tabela oficial da Receita)
  const { rows: nbsOptions } = await client.query(
    `SELECT nbs_code AS "code", description, c_class_trib AS "cClassTrib"
     FROM nbs_options WHERE item_servico = $1 ORDER BY nbs_code`,
    [serviceCode]
  );
  return {
    regime: row.regime ?? null,
    documentType: row.document_type ?? null,
    cpf: cpf ? formatDocument(cpf) : null,
    cpfFromRegistration: Boolean(registeredCpf),
    cnpj: row.cnpj ? formatDocument(row.cnpj) : null,
    legalName: row.legal_name ?? null,
    municipalRegistration: row.municipal_registration ?? null,
    cityCode,
    serviceCode,
    aliquotaIssBps: row.aliquota_iss_bps ?? defaults[0]?.aliquota_iss_bps ?? null,
    issRetido: row.iss_retido ?? false,
    nbsCode: row.nbs_code ?? (row.service_code && row.service_code !== defaults[0]?.item_servico ? nbsOptions[0]?.code : defaults[0]?.nbs_code) ?? nbsOptions[0]?.code ?? null,
    cClassTrib: row.c_class_trib ?? defaults[0]?.c_class_trib ?? nbsOptions[0]?.cClassTrib ?? null,
    nbsOptions: nbsOptions.map((option) => ({ ...option, label: `${formatNbs(option.code)} · ${option.description}` })),
    emiteNfse: status.emiteNfse,
    statusConfig: status.statusConfig,
    missingFields: status.missingFields.map((field) => ({ field, label: FIELD_LABELS[field] ?? field })),
    emissionOptionVisible: status.emissionOptionVisible,
    prefilled: defaults[0] ? {
      cityName: defaults[0].city_name,
      serviceCode: defaults[0].item_servico,
      aliquotaIssBps: defaults[0].aliquota_iss_bps,
      nbsCode: defaults[0].nbs_code,
      cClassTrib: defaults[0].c_class_trib,
      confirmedByCityHall: defaults[0].confirmed,
    } : null,
    regimes: REGIMES,
  };
}

async function saveFiscalProfile(client, providerId, data) {
  const errors = {};
  let cpf = null;
  let cnpj = null;
  if (data.cpf) {
    cpf = onlyDigits(data.cpf);
    if (!isValidCpf(cpf)) errors.cpf = "CPF inválido.";
  }
  if (data.cnpj) {
    cnpj = String(data.cnpj).toUpperCase().replace(/[^0-9A-Z]/g, "");
    if (!isValidCnpj(cnpj)) errors.cnpj = "CNPJ inválido.";
  }
  const { rows: existing } = await client.query(
    "SELECT cpf_encrypted IS NOT NULL AS has_cpf FROM provider_fiscal_profiles WHERE provider_id=$1",
    [providerId]
  );
  const { rows: users } = await client.query("SELECT cpf_encrypted FROM users WHERE id=$1", [providerId]);
  const registeredCpf = safeDecrypt(users[0]?.cpf_encrypted);
  if (registeredCpf) {
    // o CPF do cadastro vale para a nota e para a conta de recebimento
    if (cpf && cpf !== registeredCpf) errors.cpf = "Use o CPF do seu cadastro. Para trocar, fale com o suporte.";
    cpf = registeredCpf;
  }
  const hasStoredCpf = Boolean(existing[0]?.has_cpf) || Boolean(registeredCpf);
  if (data.regime === "informal" && !cpf && !hasStoredCpf) errors.cpf = "Informal emite com CPF.";
  if (data.regime !== "informal" && data.regime && !cnpj && data.emiteNfse) errors.cnpj = "Informe o CNPJ para emitir nota.";
  if (data.nbsCode && !/^\d{9}$/.test(onlyDigits(data.nbsCode))) errors.nbsCode = "Use o código NBS com 9 dígitos (ex.: 1.2602.10.00).";
  if (data.nbsCode && data.serviceCode && !errors.nbsCode) {
    // NBS precisa ser compatível com o item da LC 116 (tabela oficial)
    const { rows: allowed } = await client.query(
      "SELECT 1 FROM nbs_options WHERE item_servico=$1 AND nbs_code=$2 UNION ALL SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM nbs_options WHERE item_servico=$1)",
      [data.serviceCode, onlyDigits(data.nbsCode)]
    );
    if (!allowed[0]) errors.nbsCode = "Este NBS não corresponde ao item de serviço escolhido.";
  }
  if (Object.keys(errors).length) throw new ApiError(422, "validation_error", "Confira os dados fiscais.", errors);

  const profile = {
    regime: data.regime,
    cnpj: data.regime === "informal" ? null : cnpj,
    legal_name: data.legalName ?? null,
    municipal_registration: data.municipalRegistration ?? null,
    city_code: data.cityCode ?? null,
    service_code: data.serviceCode ?? null,
    aliquota_iss_bps: data.aliquotaIssBps ?? null,
    iss_retido: Boolean(data.issRetido),
    nbs_code: data.nbsCode ? onlyDigits(data.nbsCode) : null,
    c_class_trib: data.cClassTrib ?? null,
    // a escolha dela; o servidor decide se a opção vale (informal nunca emite)
    emite_nfse: data.regime === "informal" ? false : Boolean(data.emiteNfse),
    hasCpf: Boolean(cpf) || hasStoredCpf,
  };
  const status = deriveFiscalStatus(profile);
  await client.query(
    `INSERT INTO provider_fiscal_profiles (provider_id,regime,document_type,cpf_encrypted,cnpj,legal_name,municipal_registration,
       city_code,service_code,aliquota_iss_bps,iss_retido,emite_nfse,status_config,missing_fields,tax_regime,nbs_code,c_class_trib,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now())
     ON CONFLICT (provider_id) DO UPDATE SET regime=EXCLUDED.regime, document_type=EXCLUDED.document_type,
       cpf_encrypted=COALESCE(EXCLUDED.cpf_encrypted, provider_fiscal_profiles.cpf_encrypted), cnpj=EXCLUDED.cnpj,
       legal_name=EXCLUDED.legal_name, municipal_registration=EXCLUDED.municipal_registration, city_code=EXCLUDED.city_code,
       service_code=EXCLUDED.service_code, aliquota_iss_bps=EXCLUDED.aliquota_iss_bps, iss_retido=EXCLUDED.iss_retido,
       emite_nfse=EXCLUDED.emite_nfse, status_config=EXCLUDED.status_config, missing_fields=EXCLUDED.missing_fields,
       tax_regime=COALESCE(EXCLUDED.tax_regime, provider_fiscal_profiles.tax_regime),
       nbs_code=EXCLUDED.nbs_code, c_class_trib=EXCLUDED.c_class_trib, updated_at=now()`,
    [providerId, profile.regime, profile.cnpj ? "cnpj" : "cpf", cpf ? encryptText(cpf) : null, profile.cnpj,
     profile.legal_name, profile.municipal_registration, profile.city_code, profile.service_code, profile.aliquota_iss_bps,
     profile.iss_retido, status.emiteNfse, status.statusConfig, status.missingFields,
     profile.regime === "mei" ? "mei" : profile.regime === "me" || profile.regime === "salao" ? "simples_nacional" : null,
     profile.nbs_code, profile.c_class_trib]
  );
  return fiscalProfile(client, providerId);
}

// ---------- Assinaturas da cliente ----------

async function customerSubscriptions(client, customerId) {
  const { rows } = await client.query(
    `SELECT s.id, s.status, s.total_cents AS "totalCents", s.current_cycle AS "cycle",
       s.current_period_start AS "periodStart", s.current_period_end AS "periodEnd",
       s.cancel_at_period_end AS "cancelAtPeriodEnd", s.billing_anchor_day AS "billingDay",
       s.card_last4 AS "cardLast4", s.card_brand AS "cardBrand", s.next_retry_at AS "nextRetryAt",
       s.next_cycle_pricing->>'total_cents' AS "nextTotalCents",
       p.id AS "planId", p.name AS "planName", p.reserved_slot AS "reservedSlot",
       u.id AS "providerId", u.name AS "providerName",
       COALESCE((SELECT json_agg(json_build_object(
          'serviceId', e.service_id, 'title', sv.title,
          'granted', e.sessions_granted, 'used', e.sessions_used,
          'remaining', CASE WHEN e.voided_at IS NOT NULL THEN 0 ELSE e.sessions_granted - e.sessions_used END,
          'voided', e.voided_at IS NOT NULL) ORDER BY sv.title)
        FROM entitlements e JOIN services sv ON sv.id = e.service_id
        WHERE e.subscription_id = s.id AND e.cycle = s.current_cycle), '[]') AS sessions
     FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id JOIN users u ON u.id = s.provider_id
     WHERE s.customer_id = $1
     ORDER BY (s.status = 'cancelada'), s.created_at DESC`,
    [customerId]
  );
  return rows.map((row) => ({
    ...row,
    nextTotalCents: row.nextTotalCents == null ? null : Number(row.nextTotalCents),
    sessionsFrozen: row.status === "em_retentativa",
    nextChargeDate: row.status === "ativa" && !row.cancelAtPeriodEnd && row.periodEnd ? brasiliaDateKey(row.periodEnd) : null,
    accessUntil: row.periodEnd ? brasiliaDateKey(row.periodEnd) : null,
  }));
}

// ---------- Estatísticas avançadas (Pro) ----------

async function subscriptionStats(client, providerId) {
  const { rows: months } = await client.query(
    `WITH months AS (
       SELECT generate_series(date_trunc('month', now()) - interval '5 months', date_trunc('month', now()), interval '1 month') AS month
     )
     SELECT to_char(m.month, 'YYYY-MM') AS month,
       (SELECT COUNT(*)::int FROM subscriptions s WHERE s.provider_id=$1 AND date_trunc('month', s.started_at)=m.month) AS "newSubscribers",
       (SELECT COUNT(*)::int FROM subscriptions s WHERE s.provider_id=$1 AND date_trunc('month', s.canceled_at)=m.month) AS cancellations,
       (SELECT COALESCE(SUM(ps.amount_cents - ps.refunded_cents),0)::int FROM charges c
          JOIN charge_splits ps ON ps.charge_id=c.id AND ps.party='prestadora'
          WHERE c.provider_id=$1 AND c.origin='assinatura' AND c.status IN ('paga','estornada_parcial')
            AND date_trunc('month', c.paid_at)=m.month) AS "subscriptionRevenueCents",
       (SELECT COUNT(*)::int FROM subscriptions s WHERE s.provider_id=$1 AND s.started_at < m.month + interval '1 month'
          AND (s.canceled_at IS NULL OR s.canceled_at >= m.month + interval '1 month')) AS "activeAtMonthEnd"
     FROM months m ORDER BY m.month`,
    [providerId]
  );
  const { rows: byPlan } = await client.query(
    `SELECT p.id, p.name,
       COUNT(s.*) FILTER (WHERE s.status IN ('ativa','em_retentativa'))::int AS active,
       COUNT(s.*) FILTER (WHERE s.status='cancelada')::int AS canceled,
       COUNT(s.*) FILTER (WHERE s.status='em_retentativa')::int AS "inRetry",
       COALESCE(SUM(s.provider_amount_cents) FILTER (WHERE s.status='ativa'),0)::int AS "monthlyRecurringCents"
     FROM subscription_plans p LEFT JOIN subscriptions s ON s.plan_id=p.id
     WHERE p.provider_id=$1 GROUP BY p.id ORDER BY p.created_at`,
    [providerId]
  );
  return {
    months: months.map((month) => ({
      ...month,
      churnRate: month.activeAtMonthEnd + month.cancellations > 0
        ? Math.round((month.cancellations * 1000) / (month.activeAtMonthEnd + month.cancellations)) / 10
        : 0,
    })),
    byPlan,
  };
}

module.exports = {
  providerStatement,
  listInvoices,
  invoiceDetail,
  setInvoiceStatus,
  fiscalProfile,
  saveFiscalProfile,
  customerSubscriptions,
  subscriptionStats,
  EMISSOR_NACIONAL_URL,
};
