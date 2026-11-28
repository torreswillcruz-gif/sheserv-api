// Rotas do módulo de pagamentos (montadas depois do login).
//
// Prestadora (/me/payments/...): conta de recebimento, perfil fiscal, planos
// (cotação ao vivo, sugestões, criação), extrato, dados das notas, camada e
// estatísticas avançadas (Pro).
// Cliente: perfil de cobrança (CPF e endereço), planos de uma prestadora,
// checkout, assinar (Idempotency-Key obrigatória), minhas assinaturas e
// cancelamento.
//
// Nenhuma rota aceita taxa ou total vindo do app, e nenhuma marca cobrança
// como paga: isso só acontece no webhook (src/payments/webhooks.js).
const paymentsRouter = require("express").Router();
const { z } = require("zod");
const db = require("../db");
const { ApiError, asyncHandler } = require("../errors");
const { requireRole } = require("../security");
const { isValidUuid } = require("../validation");
const { requirePlanFeature } = require("./erp");
const { gateway, isDemoMode, requireIdempotencyKey } = require("../payments/runtime");
const accounts = require("../payments/accounts");
const plans = require("../payments/plans");
const subscriptions = require("../payments/subscriptions");
const views = require("../payments/views");
const cards = require("../payments/cards");
const { loadProviderSettings } = require("../payments/settings");

const asProvider = requireRole("prestadora");
const asCustomer = requireRole("cliente");
const read = (callback) => callback({ query: db.runQuery });
const uuidParam = (value, message = "Não encontrado.") => {
  if (!isValidUuid(value)) throw new ApiError(404, "not_found", message);
  return value;
};

// ---------- Comum ----------

paymentsRouter.get("/payments/config", (_request, response) => {
  response.json({ gateway: gateway().nome, demoMode: isDemoMode(), capabilities: gateway().capabilities() });
});

// ---------- Prestadora ----------

paymentsRouter.get("/me/payments/overview", asProvider, asyncHandler(async (request, response) => {
  const providerId = request.user.id;
  const result = await read(async (client) => {
    const settings = await loadProviderSettings(client, providerId);
    const [account, eligibility, seats, fiscal, tier, holder] = await Promise.all([
      accounts.loadAccount(client, providerId),
      accounts.providerEligibility(client, providerId),
      accounts.seatUsage(client, providerId, settings),
      views.fiscalProfile(client, providerId),
      accounts.providerTier(client, providerId),
      accounts.accountHolder(client, providerId),
    ]);
    const { rows: cities } = await client.query(
      "SELECT ibge_code AS \"cityCode\", name, uf FROM municipalities WHERE launched ORDER BY name"
    );
    const { rows: profile } = await client.query("SELECT city_code FROM provider_profiles WHERE user_id=$1", [providerId]);
    return {
      demoMode: isDemoMode(),
      account: accounts.accountView(account),
      // de quem a conta precisa ser (CPF do cadastro ou CNPJ dos dados fiscais)
      holder: accounts.holderView(holder),
      eligibility: {
        ...eligibility,
        missing: eligibility.missing.map((key) => ({ key, label: accounts.ELIGIBILITY_LABELS[key] })),
      },
      tier: tier.tier,
      tierChangedAt: tier.changedAt,
      seats: { used: seats.used, limit: seats.limit, full: seats.full },
      tierPrices: { standardCents: settings.standard_price_cents, proCents: settings.pro_price_cents },
      fiscalStatus: fiscal.statusConfig,
      cityCode: profile[0]?.city_code ?? null,
      cities,
      payoutSchedule: {
        interval: account?.payout_interval ?? settings.payout_interval,
        day: account?.payout_day ?? settings.payout_day,
      },
    };
  });
  response.json(result);
}));

const accountSchema = z.object({
  // o titular vem do cadastro (PF) ou dos dados fiscais (PJ); só conta antiga
  // sem CPF no cadastro manda o documento
  holderName: z.string().trim().min(3).max(120).optional(),
  holderDocument: z.string().trim().min(11).max(20).optional(),
  bankCode: z.string().regex(/^\d{3}$/, "Código do banco com 3 dígitos."),
  branch: z.string().regex(/^\d{1,5}$/, "Agência só com números."),
  branchDigit: z.string().regex(/^[0-9Xx]$/).nullable().optional(),
  account: z.string().regex(/^[\d-]{2,20}$/, "Conta com dígito, só números e hífen."),
  accountType: z.enum(["corrente", "poupanca"]),
  cityCode: z.string().regex(/^\d{7}$/),
}).strict();

paymentsRouter.put("/me/payments/account", asProvider, asyncHandler(async (request, response) => {
  const data = accountSchema.parse(request.body);
  const account = await db.runInTransaction((client) => accounts.saveAccount(client, request.user.id, data));
  response.json(accounts.accountView(account));
}));

// Prova de vida na instituição de pagamento: gera (ou reaproveita) o link
paymentsRouter.post("/me/payments/account/kyc-link", asProvider, asyncHandler(async (request, response) => {
  response.json(await db.runInTransaction((client) => accounts.requestKycLink(client, request.user.id)));
}));

paymentsRouter.get("/me/payments/fiscal-profile", asProvider, asyncHandler(async (request, response) => {
  response.json(await read((client) => views.fiscalProfile(client, request.user.id)));
}));

const fiscalSchema = z.object({
  regime: z.enum(["informal", "mei", "me", "salao"]),
  cpf: z.string().trim().max(20).nullable().optional(),
  cnpj: z.string().trim().max(20).nullable().optional(),
  legalName: z.string().trim().max(200).nullable().optional(),
  municipalRegistration: z.string().trim().max(40).nullable().optional(),
  cityCode: z.string().regex(/^\d{7}$/).nullable().optional(),
  serviceCode: z.string().regex(/^\d{1,2}\.\d{2}$/, "Use o formato 6.01").nullable().optional(),
  aliquotaIssBps: z.number().int().min(0).max(500).nullable().optional(),
  issRetido: z.boolean().optional(),
  emiteNfse: z.boolean().optional(),
  // campos de IBS/CBS da NFS-e (opcionais por enquanto)
  nbsCode: z.string().trim().max(14).nullable().optional(),
  cClassTrib: z.string().regex(/^\d{6}$/, "cClassTrib com 6 dígitos").nullable().optional(),
}).strict();

paymentsRouter.put("/me/payments/fiscal-profile", asProvider, asyncHandler(async (request, response) => {
  const data = fiscalSchema.parse(request.body);
  response.json(await db.runInTransaction((client) => views.saveFiscalProfile(client, request.user.id, data)));
}));

const planItemsSchema = z.array(z.object({
  serviceId: z.string().uuid(),
  sessionsPerCycle: z.number().int().min(1).max(60),
}).strict()).min(1).max(10)
  .refine((items) => new Set(items.map((item) => item.serviceId)).size === items.length, "Serviço repetido.");

const quoteSchema = z.object({
  priceCents: z.number().int().positive().max(10_000_000),
  items: planItemsSchema,
}).strict();

paymentsRouter.post("/me/payments/quote", asProvider, asyncHandler(async (request, response) => {
  const data = quoteSchema.parse(request.body);
  response.json(await read((client) => plans.quotePlan(client, request.user.id, data)));
}));

paymentsRouter.get("/me/payments/plan-suggestions", asProvider, asyncHandler(async (request, response) => {
  response.json(await read((client) => plans.planSuggestions(client, request.user.id)));
}));

paymentsRouter.get("/me/payments/plans", asProvider, asyncHandler(async (request, response) => {
  response.json(await read((client) => plans.listPlans(client, request.user.id)));
}));

const createPlanSchema = z.object({
  name: z.string().trim().min(3).max(80),
  description: z.string().trim().max(300).nullable().optional(),
  priceCents: z.number().int().positive().max(10_000_000),
  items: planItemsSchema,
  intervalUnit: z.enum(["month"]).default("month"),
  intervalCount: z.literal(1).default(1),
  maxSubscribers: z.number().int().min(1).max(1000).nullable().optional(),
  reservedSlot: z.string().trim().max(80).nullable().optional(),
}).strict();

paymentsRouter.post("/me/payments/plans", asProvider, asyncHandler(async (request, response) => {
  const data = createPlanSchema.parse(request.body);
  const created = await db.runInTransaction((client) => plans.createPlan(client, request.user.id, data));
  const list = await read((client) => plans.listPlans(client, request.user.id));
  response.status(201).json({ plan: list.find((plan) => plan.id === created.planId), activation: created.activation });
}));

// Plano: por enquanto só o valor e o status mudam (ativo, pausado = sem
// novas assinaturas, arquivado = excluído). Valor novo avisa as assinantes e
// vale para elas a partir do próximo ciclo.
const updatePlanSchema = z.object({
  status: z.enum(["ativo", "pausado", "arquivado"]).optional(),
  priceCents: z.number().int().positive().max(10_000_000).optional(),
}).strict().refine((data) => Object.keys(data).length > 0, { message: "Nada para mudar.", path: ["body"] });

paymentsRouter.patch("/me/payments/plans/:id", asProvider, asyncHandler(async (request, response) => {
  const changes = updatePlanSchema.parse(request.body);
  const planId = uuidParam(request.params.id, "Plano não encontrado.");
  const result = await db.runInTransaction((client) => plans.updatePlan(client, request.user.id, planId, changes));
  if (changes.status === "arquivado") return response.sendStatus(204);
  const list = await read((client) => plans.listPlans(client, request.user.id));
  response.json({ ...list.find((plan) => plan.id === planId), notifiedSubscribers: result.notified });
}));

paymentsRouter.get("/me/payments/statement", asProvider, asyncHandler(async (request, response) => {
  response.json(await read((client) => views.providerStatement(client, request.user.id)));
}));

paymentsRouter.get("/me/payments/invoices", asProvider, asyncHandler(async (request, response) => {
  response.json(await read((client) => views.listInvoices(client, request.user.id)));
}));

paymentsRouter.get("/me/payments/invoices/:chargeId", asProvider, asyncHandler(async (request, response) => {
  response.json(await read((client) => views.invoiceDetail(client, request.user.id, uuidParam(request.params.chargeId))));
}));

// Status marcado pela prestadora (nada é emitido pelo app)
paymentsRouter.patch("/me/payments/invoices/:chargeId", asProvider, asyncHandler(async (request, response) => {
  const { status } = z.object({ status: z.enum(["pendente", "emitida", "dispensada"]) }).strict().parse(request.body);
  await db.runInTransaction((client) => views.setInvoiceStatus(client, request.user.id, uuidParam(request.params.chargeId), status));
  response.sendStatus(204);
}));

paymentsRouter.put("/me/payments/tier", asProvider, asyncHandler(async (request, response) => {
  const { plan } = z.object({ plan: z.enum(["free", "standard", "pro"]) }).strict().parse(request.body);
  response.json(await db.runInTransaction((client) => accounts.changeTier(client, request.user.id, plan)));
}));

paymentsRouter.get("/me/payments/stats", asProvider, requirePlanFeature("advanced_stats"), asyncHandler(async (request, response) => {
  response.json(await read((client) => views.subscriptionStats(client, request.user.id)));
}));

// ---------- Cliente ----------

paymentsRouter.get("/me/customer-profile", asyncHandler(async (request, response) => {
  response.json(await read((client) => accounts.customerProfile(client, request.user.id)));
}));

const customerProfileSchema = z.object({
  cpf: z.string().trim().min(11).max(14).optional(),
  address: z.object({
    street: z.string().trim().min(2).max(200),
    number: z.string().trim().min(1).max(20),
    complement: z.string().trim().max(100).nullable().optional(),
    neighborhood: z.string().trim().min(2).max(100),
    city: z.string().trim().min(2).max(100),
    state: z.string().trim().length(2),
    postalCode: z.string().regex(/^\d{5}-?\d{3}$/, "Use 00000-000"),
  }).strict().optional(),
}).strict();

paymentsRouter.put("/me/customer-profile", asyncHandler(async (request, response) => {
  const data = customerProfileSchema.parse(request.body);
  response.json(await db.runInTransaction((client) => accounts.saveCustomerProfile(client, request.user.id, data)));
}));

paymentsRouter.get("/providers/:id/subscription-plans", asyncHandler(async (request, response) => {
  response.json(await read((client) => plans.publicPlans(client, uuidParam(request.params.id))));
}));

paymentsRouter.get("/subscription-plans/:id/checkout", asCustomer, asyncHandler(async (request, response) => {
  response.json(await read((client) => plans.checkoutPreview(client, uuidParam(request.params.id), request.user.id)));
}));

const subscribeSchema = z.object({
  planId: z.string().uuid(),
  // token do cartão gerado no PSP pelo app (no modo demonstração, qualquer
  // token; 'tok_mock_recusar' simula recusa) ou um cartão salvo. Nunca o
  // número do cartão.
  card: z.union([
    z.object({
      token: z.string().min(8).max(200),
      last4: z.string().regex(/^\d{4}$/).optional(),
      brand: z.string().max(20).optional(),
    }).strict(),
    z.object({ savedCardId: z.string().uuid() }).strict(),
  ]),
}).strict();

paymentsRouter.post("/subscriptions", asCustomer, asyncHandler(async (request, response) => {
  const idempotencyKey = requireIdempotencyKey(request);
  const data = subscribeSchema.parse(request.body);
  const subscriptionId = await subscriptions.subscribe(request.user.id, data, idempotencyKey);
  const list = await read((client) => views.customerSubscriptions(client, request.user.id));
  response.status(201).json(list.find((sub) => sub.id === subscriptionId) ?? { id: subscriptionId });
}));

paymentsRouter.get("/me/subscriptions", asyncHandler(async (request, response) => {
  response.json(await read((client) => views.customerSubscriptions(client, request.user.id)));
}));

paymentsRouter.post("/subscriptions/:id/cancel", asyncHandler(async (request, response) => {
  await subscriptions.cancelSubscription(request.user.id, uuidParam(request.params.id, "Assinatura não encontrada."));
  const list = await read((client) => views.customerSubscriptions(client, request.user.id));
  response.json(list.find((sub) => sub.id === request.params.id));
}));

// ---------- Cartões salvos (cliente) ----------

const cardSchema = z.object({
  token: z.string().min(8).max(200),
  last4: z.string().regex(/^\d{4}$/),
  brand: z.string().trim().max(20).optional(),
  expMonth: z.number().int().min(1).max(12),
  expYear: z.number().int().min(2000).max(2100),
  holderName: z.string().trim().min(2).max(120),
  makeDefault: z.boolean().optional(),
}).strict();

paymentsRouter.get("/me/payments/cards", asCustomer, asyncHandler(async (request, response) => {
  response.json(await read((client) => cards.listCards(client, request.user.id)));
}));

paymentsRouter.post("/me/payments/cards", asCustomer, asyncHandler(async (request, response) => {
  const data = cardSchema.parse(request.body);
  const now = new Date();
  if (data.expYear < now.getFullYear() || (data.expYear === now.getFullYear() && data.expMonth < now.getMonth() + 1))
    throw new ApiError(422, "validation_error", "Cartão vencido.", { expMonth: "Cartão vencido." });
  response.status(201).json(await cards.addCard(request.user.id, data));
}));

paymentsRouter.put("/me/payments/cards/:id/default", asCustomer, asyncHandler(async (request, response) => {
  response.json(await cards.setDefaultCard(request.user.id, uuidParam(request.params.id, "Cartão não encontrado.")));
}));

paymentsRouter.delete("/me/payments/cards/:id", asCustomer, asyncHandler(async (request, response) => {
  await cards.deleteCard(request.user.id, uuidParam(request.params.id, "Cartão não encontrado."));
  response.sendStatus(204);
}));

module.exports = { paymentsRouter };
