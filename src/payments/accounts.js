// Conta de recebimento da prestadora, elegibilidade para oferecer planos,
// camadas (Free/Standard/Pro) e perfil de cobrança da cliente.
const crypto = require("crypto");
const { ApiError } = require("../errors");
const { encryptText, hashWithSha256 } = require("../security");
const { gateway, afterCommit } = require("./runtime");
const { loadProviderSettings, snapshotOf, payoutSchedule } = require("./settings");
const { installmentCap } = require("./money");
const { OCCUPIES_SEAT } = require("./subscriptionStateMachine");
const { isValidCpf, isValidCnpj, isValidCep, onlyDigits, customerMissingFields, loadCustomerFiscalData, formatDocument } = require("./fiscal");

const TIERS = ["free", "standard", "pro"];

// ---------- Recebedor ----------

async function loadAccount(client, providerId, { forUpdate = false } = {}) {
  const { rows } = await client.query(
    `SELECT * FROM provider_payment_accounts WHERE provider_id=$1 ${forUpdate ? "FOR UPDATE" : ""}`,
    [providerId]
  );
  return rows[0] ?? null;
}

function accountView(account) {
  if (!account) return null;
  return {
    status: account.status,
    statusReason: account.status_reason,
    holderName: account.holder_name,
    holderDocumentType: account.holder_document_type,
    bankCode: account.bank_code,
    branch: account.branch,
    accountType: account.account_type,
    accountLast4: account.account_last4,
    payoutInterval: account.payout_interval,
    payoutDay: account.payout_day,
    gateway: account.gateway,
    kyc: {
      status: account.kyc_status ?? "nao_iniciada",
      reason: account.kyc_reason ?? null,
      verifiedAt: account.kyc_verified_at ?? null,
      linkUrl: account.kyc_link_url ?? null,
      linkExpiresAt: account.kyc_link_expires_at ?? null,
    },
  };
}

const PJ_REGIMES = ["mei", "me", "salao"];

// Titular da conta de recebimento: a conta tem que estar no nome de quem
// recebe. Pessoa jurídica (MEI, ME, salão) -> CNPJ e razão social dos dados
// fiscais; pessoa física -> o CPF e o nome do cadastro.
async function accountHolder(client, providerId) {
  const { decryptText } = require("../security");
  const { rows } = await client.query(
    `SELECT u.name, u.social_name, u.cpf_encrypted AS user_cpf, fp.regime, fp.cnpj, fp.legal_name, fp.cpf_encrypted AS fiscal_cpf
     FROM users u LEFT JOIN provider_fiscal_profiles fp ON fp.provider_id = u.id WHERE u.id=$1`,
    [providerId]
  );
  const row = rows[0] ?? {};
  const decrypt = (value) => { try { return value ? decryptText(value) : null; } catch { return null; } };
  if (PJ_REGIMES.includes(row.regime)) {
    const cnpj = row.cnpj ? onlyDigits(row.cnpj) : null;
    return {
      type: "cnpj",
      regime: row.regime,
      name: row.legal_name ?? null,
      document: cnpj,
      missing: [!cnpj && "CNPJ", !row.legal_name && "Razão social"].filter(Boolean),
    };
  }
  const cpf = decrypt(row.user_cpf) ?? decrypt(row.fiscal_cpf);
  return { type: "cpf", regime: row.regime ?? "informal", name: row.name ?? null, document: cpf, missing: cpf ? [] : ["CPF"] };
}

function holderView(holder) {
  return { ...holder, document: holder.document ? formatDocument(holder.document) : null };
}

// Cria (ou refaz, se recusada) o recebedor com os dados bancários. Depois de
// aprovada, a troca de conta passa pelo suporte: assinaturas ativas têm o
// split apontando para o recebedor atual.
async function saveAccount(client, providerId, data) {
  const holder = await accountHolder(client, providerId);
  if (holder.type === "cnpj" && holder.missing.length)
    throw new ApiError(422, "holder_incomplete", "Cadastre o CNPJ e a razão social em Dados fiscais antes da conta.", {
      holderDocument: `Falta: ${holder.missing.join(", ")}.`,
    });
  // PF sem CPF no cadastro (contas antigas): aceita o informado e grava no cadastro
  let document = holder.document;
  if (!document) {
    document = onlyDigits(data.holderDocument ?? "");
    if (!isValidCpf(document)) throw new ApiError(422, "validation_error", "CPF inválido.", { holderDocument: "Informe o seu CPF." });
    try {
      await client.query("UPDATE users SET cpf_encrypted=$2, cpf_hash=$3 WHERE id=$1", [providerId, encryptText(document), cpfHash(document)]);
    } catch (error) {
      if (error.code === "23505") throw new ApiError(409, "cpf_in_use", "Este CPF já está em outra conta.", { holderDocument: "CPF já cadastrado." });
      throw error;
    }
  }
  const documentType = holder.type;
  if (documentType === "cpf" ? !isValidCpf(document) : !isValidCnpj(document))
    throw new ApiError(422, "validation_error", "Documento inválido.", { holderDocument: "CPF ou CNPJ inválido." });
  // o titular é sempre quem recebe: o nome vem do cadastro (PF) ou da razão social (PJ)
  data = { ...data, holderName: holder.name ?? data.holderName };

  const { rows: cities } = await client.query("SELECT 1 FROM municipalities WHERE ibge_code=$1 AND launched", [data.cityCode]);
  if (!cities[0]) throw new ApiError(422, "validation_error", "Cidade fora do lançamento.", { cityCode: "Escolha Guaxupé ou Alfenas." });

  const existing = await loadAccount(client, providerId, { forUpdate: true });
  if (existing && ["aprovada", "em_analise"].includes(existing.status))
    throw new ApiError(409, "account_locked", existing.status === "aprovada"
      ? "A conta de recebimento já foi aprovada. Para trocar, fale com o suporte."
      : "A conta de recebimento está em análise.");

  await client.query("UPDATE provider_profiles SET city_code=$2 WHERE user_id=$1", [providerId, data.cityCode]);
  const account = onlyDigits(data.account);
  const values = [
    providerId, gateway().nome, data.holderName, documentType, encryptText(document),
    data.bankCode, data.branch, data.branchDigit ?? null, data.accountType, encryptText(account), account.slice(-4),
  ];
  await client.query(
    `INSERT INTO provider_payment_accounts
       (provider_id,gateway,holder_name,holder_document_type,holder_document_encrypted,
        bank_code,branch,branch_digit,account_type,account_encrypted,account_last4,status,status_reason,gateway_recipient_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pendente',NULL,NULL)
     ON CONFLICT (provider_id) DO UPDATE SET
       gateway=EXCLUDED.gateway, holder_name=EXCLUDED.holder_name, holder_document_type=EXCLUDED.holder_document_type,
       holder_document_encrypted=EXCLUDED.holder_document_encrypted, bank_code=EXCLUDED.bank_code, branch=EXCLUDED.branch,
       branch_digit=EXCLUDED.branch_digit, account_type=EXCLUDED.account_type, account_encrypted=EXCLUDED.account_encrypted,
       account_last4=EXCLUDED.account_last4, status='pendente', status_reason=NULL, gateway_recipient_id=NULL,
       kyc_status=CASE WHEN provider_payment_accounts.kyc_status='aprovada' THEN 'aprovada' ELSE 'nao_iniciada' END,
       kyc_link_url=NULL, kyc_link_expires_at=NULL, updated_at=now()`,
    values
  );

  const settings = await loadProviderSettings(client, providerId);
  const schedule = payoutSchedule(settings, existing);
  const idempotencyKey = `recipient:${providerId}:${hashWithSha256(`${document}|${data.bankCode}|${data.branch}|${account}`).slice(0, 24)}`;
  const { rows: users } = await client.query("SELECT name, email FROM users WHERE id=$1", [providerId]);
  afterCommit(client, () => registerRecipient(providerId, {
    nome: data.holderName,
    email: users[0]?.email,
    documento: document,
    tipoDocumento: documentType,
  }, {
    banco: data.bankCode, agencia: data.branch, digitoAgencia: data.branchDigit ?? null,
    conta: account, tipo: data.accountType, titular: data.holderName, documentoTitular: document,
  }, { intervalo: schedule.payoutInterval, dia: schedule.payoutDay }, idempotencyKey));
  return loadAccount(client, providerId);
}

// Chamada ao PSP depois do COMMIT. Os dados bancários só passam por aqui
// (nunca vão para log).
async function registerRecipient(providerId, dadosPrestadora, dadosBancarios, calendarioRepasse, idempotencyKey) {
  const db = require("../db");
  try {
    const result = await gateway().createRecipient(dadosPrestadora, dadosBancarios, { calendarioRepasse, idempotencyKey });
    await db.runQuery(
      `UPDATE provider_payment_accounts SET gateway_recipient_id=$2,
         status=CASE WHEN status='pendente' THEN $3 ELSE status END, updated_at=now()
       WHERE provider_id=$1`,
      [providerId, result.recipientId, result.status]
    );
  } catch (error) {
    await db.runQuery(
      "UPDATE provider_payment_accounts SET status_reason=$2, updated_at=now() WHERE provider_id=$1 AND status='pendente'",
      [providerId, `Falha ao enviar ao gateway: ${error.message}`.slice(0, 300)]
    );
  }
}

// ---------- Prova de vida (KYC) no gateway ----------
// Feita pela instituição de pagamento depois que o recebedor existe. Vira o
// selo "Identidade verificada" e libera planos e repasses.
async function requestKycLink(client, providerId) {
  const account = await loadAccount(client, providerId, { forUpdate: true });
  if (!account?.gateway_recipient_id || !["em_analise", "aprovada"].includes(account.status))
    throw new ApiError(409, "account_not_ready", "Cadastre a conta de recebimento antes da prova de vida.");
  if (account.kyc_status === "aprovada") throw new ApiError(409, "kyc_done", "Sua prova de vida já foi aprovada.");
  if (account.kyc_link_url && account.kyc_link_expires_at && new Date(account.kyc_link_expires_at) > new Date())
    return accountView(account);
  let link;
  try {
    link = await gateway().createKycLink(account.gateway_recipient_id);
  } catch (error) {
    // o PSP já aprovou (webhook perdido): sincroniza em vez de falhar
    if (error.code === "kyc_done") {
      const { rows } = await client.query(
        `UPDATE provider_payment_accounts SET kyc_status='aprovada', kyc_reason=NULL, kyc_verified_at=COALESCE(kyc_verified_at, now()),
           kyc_link_url=NULL, kyc_link_expires_at=NULL, updated_at=now()
         WHERE provider_id=$1 RETURNING *`,
        [providerId]
      );
      return accountView(rows[0]);
    }
    throw new ApiError(502, "gateway_error", `A instituição de pagamento não gerou o link: ${error.message}`);
  }
  const { rows } = await client.query(
    `UPDATE provider_payment_accounts SET kyc_status='pendente', kyc_reason=NULL, kyc_link_url=$2, kyc_link_expires_at=$3, updated_at=now()
     WHERE provider_id=$1 RETURNING *`,
    [providerId, link.url, link.expiraEm ?? null]
  );
  return accountView(rows[0]);
}

// ---------- Elegibilidade para oferecer planos ----------
// Assinatura só para quem atende em estabelecimento físico e tem o cadastro
// completo. Dado fiscal não entra: nunca bloqueia cobrança (regra fiscal 4).
async function providerEligibility(client, providerId) {
  const { rows } = await client.query(
    `SELECT
       pp.activation_status = 'active' AS approved,
       pp.city_code IS NOT NULL AS has_city,
       EXISTS (SELECT 1 FROM provider_venues v WHERE v.provider_id = pp.user_id) AS has_venue,
       EXISTS (SELECT 1 FROM services s WHERE s.provider_id = pp.user_id AND s.active AND NOT s.hidden_by_admin
                 AND s.service_location = 'at_provider' AND s.price_type = 'fixed') AS has_venue_service,
       (SELECT status FROM provider_payment_accounts a WHERE a.provider_id = pp.user_id) AS account_status,
       (SELECT kyc_status FROM provider_payment_accounts a WHERE a.provider_id = pp.user_id) AS kyc_status
     FROM provider_profiles pp WHERE pp.user_id = $1`,
    [providerId]
  );
  const row = rows[0];
  const missing = [];
  if (!row) return { eligible: false, missing: ["provider_profile"] };
  if (!row.approved) missing.push("provider_approval");
  if (!row.has_venue) missing.push("venue");
  if (!row.has_venue_service) missing.push("venue_service");
  if (!row.has_city) missing.push("city");
  if (row.account_status !== "aprovada") missing.push("payment_account");
  if (row.kyc_status !== "aprovada") missing.push("identity");
  return { eligible: missing.length === 0, missing, accountStatus: row.account_status ?? null, kycStatus: row.kyc_status ?? null };
}

const ELIGIBILITY_LABELS = {
  provider_profile: "Cadastro de prestadora",
  provider_approval: "Cadastro aprovado pela SheServe",
  venue: "Endereço do seu espaço de atendimento",
  venue_service: "Um serviço de preço fixo atendido no seu espaço",
  city: "Cidade de atuação",
  payment_account: "Conta de recebimento aprovada",
  identity: "Prova de vida feita pela instituição de pagamento",
};

// ---------- Camadas e vagas ----------

async function providerTier(client, providerId) {
  const { rows } = await client.query(
    "SELECT plan_name, tier_changed_at, tier_billed_until FROM provider_plans WHERE provider_id=$1",
    [providerId]
  );
  const tier = rows[0]?.plan_name ?? "free";
  return { tier: TIERS.includes(tier) ? tier : "pro", changedAt: rows[0]?.tier_changed_at ?? null, billedUntil: rows[0]?.tier_billed_until ?? null };
}

// Limite do Free é sobre assinantes ativas (clientes distintas), não sobre
// tipos de plano. Standard e Pro: ilimitado.
async function seatUsage(client, providerId, settings) {
  const { tier } = await providerTier(client, providerId);
  const { rows } = await client.query(
    "SELECT COUNT(DISTINCT customer_id)::int AS used FROM subscriptions WHERE provider_id=$1 AND status = ANY($2::text[])",
    [providerId, OCCUPIES_SEAT]
  );
  const limit = tier === "free" ? settings.free_max_active_subscribers : null;
  const used = rows[0]?.used ?? 0;
  return { tier, used, limit, full: limit != null && used >= limit };
}

// Troca de camada. Downgrade não cancela assinatura de ninguém: só bloqueia
// novas até caber no limite. A mensalidade da camada é descontada dos
// repasses (nunca cobrada antes).
async function changeTier(client, providerId, nextTier) {
  if (!TIERS.includes(nextTier)) throw new ApiError(422, "validation_error", "Camada inválida.", { plan: "Use free, standard ou pro." });
  const { rows: catalog } = await client.query("SELECT monthly_approval_limit FROM plan_catalog WHERE plan_code=$1 AND active", [nextTier]);
  if (!catalog[0]) throw new ApiError(404, "not_found", "Camada indisponível.");
  const current = await providerTier(client, providerId);
  const now = new Date();
  await client.query(
    `INSERT INTO provider_plans (provider_id,plan_name,monthly_approval_limit,renewal_at,updated_at,tier_changed_at,previous_plan_name,tier_billed_until)
     VALUES ($1,$2,$3,date_trunc('month',now()) + interval '1 month',now(),now(),$4,NULL)
     ON CONFLICT (provider_id) DO UPDATE SET plan_name=EXCLUDED.plan_name,
       monthly_approval_limit=EXCLUDED.monthly_approval_limit, updated_at=now(),
       tier_changed_at=CASE WHEN provider_plans.plan_name <> EXCLUDED.plan_name THEN now() ELSE provider_plans.tier_changed_at END,
       previous_plan_name=CASE WHEN provider_plans.plan_name <> EXCLUDED.plan_name THEN provider_plans.plan_name ELSE provider_plans.previous_plan_name END,
       tier_billed_until=CASE WHEN EXCLUDED.plan_name='free' THEN NULL
                              WHEN provider_plans.plan_name <> EXCLUDED.plan_name THEN NULL
                              ELSE provider_plans.tier_billed_until END`,
    [providerId, nextTier, catalog[0].monthly_approval_limit, current.tier]
  );
  if (nextTier !== "free" && nextTier !== current.tier) await billTierIfDue(client, providerId, now);
  const settings = await loadProviderSettings(client, providerId);
  return { ...(await providerTier(client, providerId)), seats: await seatUsage(client, providerId, settings) };
}

// Mensalidade da camada vira um desconto de repasse, um por mês
async function billTierIfDue(client, providerId, now = new Date()) {
  const { rows } = await client.query(
    "SELECT plan_name, tier_billed_until FROM provider_plans WHERE provider_id=$1 FOR UPDATE",
    [providerId]
  );
  const plan = rows[0];
  if (!plan || !["standard", "pro"].includes(plan.plan_name)) return null;
  if (plan.tier_billed_until && new Date(plan.tier_billed_until) > now) return null;
  const settings = await loadProviderSettings(client, providerId);
  const price = plan.plan_name === "pro" ? settings.pro_price_cents : settings.standard_price_cents;
  const periodStart = plan.tier_billed_until ? new Date(plan.tier_billed_until) : now;
  const periodKey = periodStart.toISOString().slice(0, 10);
  if (price > 0) {
    await client.query(
      `INSERT INTO provider_deductions (provider_id,kind,description,amount_cents,settings_snapshot,reference)
       VALUES ($1,'camada',$2,$3,$4,$5) ON CONFLICT (provider_id,reference) DO NOTHING`,
      [providerId, `Mensalidade ${plan.plan_name === "pro" ? "Pro" : "Standard"} a partir de ${periodKey}`, price,
       snapshotOf(settings), `camada:${plan.plan_name}:${periodKey}`]
    );
  }
  const next = new Date(periodStart);
  next.setUTCMonth(next.getUTCMonth() + 1);
  await client.query("UPDATE provider_plans SET tier_billed_until=$2 WHERE provider_id=$1", [providerId, next]);
  return { amountCents: price, until: next };
}

// Primeira vez que ativa planos: taxa de ativação, descontada dos primeiros
// repasses (nunca antes), em até N repasses.
async function chargeActivationIfFirst(client, providerId) {
  const { rows } = await client.query(
    `UPDATE provider_payment_accounts SET plans_activated_at=now()
     WHERE provider_id=$1 AND plans_activated_at IS NULL RETURNING provider_id`,
    [providerId]
  );
  if (!rows[0]) return null;
  const settings = await loadProviderSettings(client, providerId);
  if (settings.activation_fee_cents <= 0) return null;
  await client.query(
    `INSERT INTO provider_deductions (provider_id,kind,description,amount_cents,per_payout_cap_cents,settings_snapshot,reference)
     VALUES ($1,'ativacao',$2,$3,$4,$5,'ativacao') ON CONFLICT (provider_id,reference) DO NOTHING`,
    [providerId, `Taxa de ativação dos planos (${settings.activation_fee_installments} repasse(s))`,
     settings.activation_fee_cents, installmentCap(settings.activation_fee_cents, settings.activation_fee_installments),
     snapshotOf(settings)]
  );
  return { amountCents: settings.activation_fee_cents, installments: settings.activation_fee_installments };
}

// ---------- Perfil de cobrança da cliente ----------

function maskCpf(cpf) {
  return cpf ? `***.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-**` : null;
}

async function customerProfile(client, customerId) {
  const customer = await loadCustomerFiscalData(client, customerId);
  const { decryptText } = require("../security");
  let cpf = null;
  if (customer?.cpf_encrypted) {
    try { cpf = decryptText(customer.cpf_encrypted); } catch { cpf = null; }
  }
  const missing = customerMissingFields(customer);
  return {
    name: customer?.name ?? null,
    email: customer?.email ?? null,
    cpfMasked: maskCpf(cpf),
    hasCpf: Boolean(cpf),
    address: customer?.address ? {
      street: customer.address.street,
      number: customer.address.number,
      complement: customer.address.complement,
      neighborhood: customer.address.neighborhood,
      city: customer.address.city,
      state: customer.address.state,
      postalCode: customer.address.postal_code,
    } : null,
    missing,
    complete: missing.length === 0,
  };
}

// Grava CPF (cifrado, com hash para não repetir em outra conta) e o endereço
// de cobrança (com CEP). Validação de formato aqui e no app.
async function saveCustomerProfile(client, customerId, data) {
  if (data.cpf !== undefined) {
    const cpf = onlyDigits(data.cpf);
    if (!isValidCpf(cpf)) throw new ApiError(422, "validation_error", "CPF inválido.", { cpf: "CPF inválido." });
    try {
      await client.query("UPDATE users SET cpf_encrypted=$2, cpf_hash=$3 WHERE id=$1", [customerId, encryptText(cpf), cpfHash(cpf)]);
    } catch (error) {
      if (error.code === "23505") throw new ApiError(409, "cpf_in_use", "Este CPF já está em outra conta.", { cpf: "CPF já cadastrado." });
      throw error;
    }
  }
  if (data.address) {
    const address = data.address;
    if (!isValidCep(address.postalCode)) throw new ApiError(422, "validation_error", "CEP inválido.", { postalCode: "Use 00000-000." });
    const { rows } = await client.query(
      `INSERT INTO addresses (user_id,label,street,number,complement,neighborhood,city,state,postal_code)
       VALUES ($1,'Cobrança',$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [customerId, address.street, address.number, address.complement ?? null, address.neighborhood,
       address.city, address.state.toUpperCase(), onlyDigits(address.postalCode)]
    );
    await client.query("UPDATE users SET billing_address_id=$2 WHERE id=$1", [customerId, rows[0].id]);
  }
  return customerProfile(client, customerId);
}

// HMAC com a chave de dados: o mesmo CPF sempre dá o mesmo hash, sem expor o CPF
function cpfHash(cpf) {
  return crypto.createHmac("sha256", process.env.DATA_ENCRYPTION_KEY || "").update(`cpf:${cpf}`).digest("hex");
}

async function assertCustomerComplete(client, customerId) {
  const profile = await customerProfile(client, customerId);
  if (!profile.complete)
    throw new ApiError(422, "customer_profile_incomplete", "Complete seu cadastro (CPF e endereço com CEP) para pagar pelo app.", {
      missing: profile.missing.join(","),
    });
  return profile;
}

module.exports = {
  TIERS,
  ELIGIBILITY_LABELS,
  loadAccount,
  accountView,
  accountHolder,
  holderView,
  saveAccount,
  requestKycLink,
  providerEligibility,
  providerTier,
  seatUsage,
  changeTier,
  billTierIfDue,
  chargeActivationIfFirst,
  customerProfile,
  saveCustomerProfile,
  assertCustomerComplete,
  cpfHash,
};
