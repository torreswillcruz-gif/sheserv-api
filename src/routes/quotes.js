const quotesRouter = require("express").Router();
const crypto = require("crypto");
const { z } = require("zod");
const { runQuery, runInTransaction } = require("../db");
const { ApiError, asyncHandler } = require("../errors");
const { requireRole } = require("../security");
const { assertSlotFree } = require("../schedule");

// Orçamentos que ainda podem ser aprovados, recusados ou negociados
const NEGOTIABLE_QUOTE_STATUSES = ["open", "countered"];

// Mês (UTC) em que a cota é reservada, no formato YYYY-MM
const currentQuotaPeriod = () => new Date().toISOString().slice(0, 7);

// A cota é devolvida no mesmo mês em que foi reservada (orçamentos antigos sem
// quota_period usam o mês atual).
const quotaPeriodOf = (quote) => quote.quota_period ?? currentQuotaPeriod();

// Só prestadora aprovada pelo admin (activation_status = 'active') participa de
// orçamentos: vê solicitações públicas, recebe pedidos e envia propostas.
async function isApprovedProvider(databaseClient, providerId) {
  const { rows } = await databaseClient.query(
    "SELECT 1 FROM provider_profiles WHERE user_id=$1 AND activation_status='active'",
    [providerId]
  );
  return Boolean(rows[0]);
}

// Devolve a unidade de cota reservada por um orçamento que não será aprovado
async function releaseReservedQuota(transaction, quote) {
  if (!quote.reserved_quota) return;
  await transaction.query(
    `UPDATE monthly_approval_usage
     SET reserved_count=GREATEST(reserved_count-1,0)
     WHERE provider_id=$1 AND period=$2`,
    [quote.provider_id, quotaPeriodOf(quote)]
  );
  await transaction.query("UPDATE quotes SET reserved_quota=false WHERE id=$1", [quote.id]);
}

const requestSchema = z.object({
  providerId: z.string().uuid().optional(),
  serviceId: z.string().uuid().optional(),
  description: z.string().trim().min(10).max(3000),
  briefAnswers: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).default({}),
  photoUrls: z.array(z.string().url()).max(10).default([]),
  addressId: z.string().uuid().optional(),
  dateWindowStart: z.string().datetime({ offset: true }).optional(),
  dateWindowEnd: z.string().datetime({ offset: true }).optional(),
  estimatedValue: z.number().positive().optional(),
}).strict();

quotesRouter.post("/requests", requireRole("cliente"), asyncHandler(async (request, response) => {
  const data = requestSchema.parse(request.body);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  if (data.providerId === request.user.id)
    throw new ApiError(422, "self_dealing", "You cannot request a quote from yourself.", {
      providerId: "Choose another provider.",
    });
  if (data.providerId) {
    const { rows } = await runQuery(
      `SELECT 1 FROM users u JOIN provider_profiles p ON p.user_id=u.id
       WHERE u.id=$1 AND 'prestadora'=ANY(u.roles) AND p.activation_status='active'`,
      [data.providerId]
    );
    if (!rows[0]) throw new ApiError(404, "not_found", "Provider not found.");
  }
  const { rows } = await runQuery(
    `INSERT INTO service_requests
      (customer_id,provider_id,service_id,description,brief_answers,photo_urls,address_id,date_window_start,date_window_end,estimated_value,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [request.user.id, data.providerId ?? null, data.serviceId ?? null, data.description,
     JSON.stringify(data.briefAnswers), data.photoUrls, data.addressId ?? null,
     data.dateWindowStart ?? null, data.dateWindowEnd ?? null,
     data.estimatedValue ?? null, expiresAt]
  );
  response.status(201).json(rows[0]);
}));

// Quem tem os dois papéis escolhe a visão com ?as=customer|provider.
// Sem o parâmetro, mantém o comportamento antigo: prestadora vê a visão de prestadora.
const requestListQuerySchema = z.object({ as: z.enum(["customer", "provider"]).optional() }).passthrough();

quotesRouter.get("/requests", asyncHandler(async (request, response) => {
  const { as: requestedView } = requestListQuerySchema.parse(request.query);
  const roles = request.user.roles ?? [];
  const view = requestedView ?? (roles.includes("prestadora") ? "provider" : "customer");
  if (view === "provider" && !roles.includes("prestadora"))
    throw new ApiError(403, "forbidden", "Requires role prestadora.");
  if (view === "customer" && !roles.includes("cliente"))
    throw new ApiError(403, "forbidden", "Requires role cliente.");
  const isProvider = view === "provider";
  // Cadastro em análise ou recusado ainda não recebe solicitações
  if (isProvider && !(await isApprovedProvider({ query: runQuery }, request.user.id)))
    return response.json([]);
  const { rows } = await runQuery(
    `SELECT r.*,
      customer.name AS "customerName",
      (SELECT count(*)::int FROM quotes q
       WHERE q.request_id=r.id AND q.status IN ('open','countered')) AS "openQuoteCount"
       ,
      (SELECT count(*)::int FROM quotes q
       WHERE q.request_id=r.id AND q.provider_id=$1) AS "providerQuoteCount",
      (SELECT q.status FROM quotes q
       WHERE q.request_id=r.id AND q.provider_id=$1
       ORDER BY q.created_at DESC LIMIT 1) AS "providerQuoteStatus",
      (r.provider_id IS NULL) AS "isPublic"
     FROM service_requests r
     LEFT JOIN users customer ON customer.id=r.customer_id
     WHERE r.${isProvider ? "provider_id" : "customer_id"}=$1
        OR ($2='provider' AND r.provider_id IS NULL AND r.customer_id<>$1)
     ORDER BY r.created_at DESC LIMIT 100`,
    [request.user.id, isProvider ? "provider" : "customer"]
  );
  response.json(rows);
}));

const quoteSchema = z.object({
  totalAmount: z.number().positive(),
  validUntil: z.string().datetime({ offset: true }),
  terms: z.string().trim().max(3000).nullable().optional(),
  items: z.array(z.object({
    serviceId: z.string().uuid().optional(),
    description: z.string().trim().min(2).max(300),
    quantity: z.number().positive().default(1),
    unitPrice: z.number().nonnegative(),
    kind: z.enum(["service", "travel", "discount", "additional"]).default("service"),
  })).min(1).max(50),
}).strict();

quotesRouter.post("/requests/:id/quotes", requireRole("prestadora"), asyncHandler(async (request, response) => {
  const data = quoteSchema.parse(request.body);
  if (new Date(data.validUntil) <= new Date())
    throw new ApiError(422, "validation_error", "Validity must be in the future.", { validUntil: "Invalid validity." });
  const created = await runInTransaction(async (transaction) => {
    if (!(await isApprovedProvider(transaction, request.user.id)))
      throw new ApiError(403, "provider_not_approved", "Your provider profile is awaiting approval.");
    const { rows } = await transaction.query("SELECT * FROM service_requests WHERE id=$1 FOR UPDATE", [request.params.id]);
    const serviceRequest = rows[0];
    if (!serviceRequest) throw new ApiError(404, "not_found", "Request not found.");
    if (["cancelled", "expired", "accepted"].includes(serviceRequest.status))
      throw new ApiError(409, "invalid_transition", "Request is no longer open.");
    if (serviceRequest.provider_id && serviceRequest.provider_id !== request.user.id)
      throw new ApiError(403, "forbidden", "This request belongs to another provider.");
    if (serviceRequest.customer_id === request.user.id)
      throw new ApiError(403, "self_dealing", "You cannot quote your own request.");

    const { rows: openRows } = await transaction.query(
      "SELECT count(*)::int AS total FROM quotes WHERE request_id=$1 AND status IN ('open','countered')",
      [serviceRequest.id]
    );
    if (openRows[0].total >= 3)
      throw new ApiError(409, "quota_limit", "This request already has 3 open quotes.");
    const { rows: providerRows } = await transaction.query(
      "SELECT 1 FROM quotes WHERE request_id=$1 AND provider_id=$2 AND status IN ('open','countered')",
      [serviceRequest.id, request.user.id]
    );
    if (providerRows[0])
      throw new ApiError(409, "duplicate_quote", "You already sent an open quote for this request.");

    const period = currentQuotaPeriod();
    const { rows: planRows } = await transaction.query(
      `SELECT monthly_approval_limit FROM plan_catalog
       WHERE plan_code=COALESCE(
         (SELECT plan_name FROM provider_plans WHERE provider_id=$1),'free'
       )`,
      [request.user.id]
    );
    const planLimit = planRows[0] ? planRows[0].monthly_approval_limit : 20;
    const { rows: usageRows } = await transaction.query(
      `INSERT INTO monthly_approval_usage (provider_id,period,approved_count,reserved_count)
       VALUES ($1,$2,0,0)
       ON CONFLICT (provider_id,period) DO UPDATE SET reserved_count=monthly_approval_usage.reserved_count
       RETURNING approved_count,reserved_count`,
      [request.user.id, period]
    );
    if (planLimit !== null && usageRows[0].approved_count + usageRows[0].reserved_count >= planLimit)
      throw new ApiError(409, "quota_limit", "No monthly approval quota is available.");

    await transaction.query(
      "UPDATE monthly_approval_usage SET reserved_count=reserved_count+1 WHERE provider_id=$1 AND period=$2",
      [request.user.id, period]
    );
    const { rows: quoteRows } = await transaction.query(
      `INSERT INTO quotes (request_id,provider_id,customer_id,status,total_amount,valid_until,terms,reserved_quota,quota_period)
       VALUES ($1,$2,$3,'open',$4,$5,$6,true,$7) RETURNING *`,
      [serviceRequest.id, request.user.id, serviceRequest.customer_id, data.totalAmount,
       data.validUntil, data.terms ?? null, period]
    );
    const quote = quoteRows[0];
    for (const item of data.items) {
      await transaction.query(
        `INSERT INTO quote_items (quote_id,service_id,description,quantity,unit_price,kind)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [quote.id, item.serviceId ?? null, item.description, item.quantity, item.unitPrice, item.kind]
      );
    }
    await transaction.query(
      "UPDATE service_requests SET status='with_quotes',updated_at=now() WHERE id=$1",
      [serviceRequest.id]
    );
    await transaction.query(
      "INSERT INTO quote_events (quote_id,actor_id,type,data) VALUES ($1,$2,'sent',$3)",
      [quote.id, request.user.id, { reservedQuota: true }]
    );
    return quote;
  });
  response.status(201).json(created);
}));

quotesRouter.post("/quotes/:id/approve", requireRole("cliente"), asyncHandler(async (request, response) => {
  const approvalSchema = z.object({
    scheduledAt: z.string().datetime({ offset: true }),
    addressId: z.string().uuid().optional(),
    paymentMethod: z.enum(["pix", "combined"]).default("combined"),
  }).strict();
  const approval = approvalSchema.parse(request.body);
  const scheduledAt = new Date(approval.scheduledAt);
  if (scheduledAt <= new Date())
    throw new ApiError(422, "validation_error", "Scheduled time must be in the future.", { scheduledAt: "Invalid date." });

  const createdOrder = await runInTransaction(async (transaction) => {
    const { rows } = await transaction.query("SELECT * FROM quotes WHERE id=$1 FOR UPDATE", [request.params.id]);
    const quote = rows[0];
    if (!quote) throw new ApiError(404, "not_found", "Quote not found.");
    if (quote.customer_id !== request.user.id) throw new ApiError(403, "forbidden", "Not your quote.");
    if (!NEGOTIABLE_QUOTE_STATUSES.includes(quote.status) || new Date(quote.valid_until) <= new Date())
      throw new ApiError(409, "invalid_transition", "Quote is not available for approval.");

    const { rows: requestRows } = await transaction.query(
      "SELECT * FROM service_requests WHERE id=$1",
      [quote.request_id]
    );
    const serviceRequest = requestRows[0];
    if (!serviceRequest) throw new ApiError(404, "not_found", "Request not found.");
    const serviceId = serviceRequest.service_id;
    let service = null;
    if (serviceId) {
      const { rows: serviceRows } = await transaction.query(
        `SELECT service.* FROM services service
         JOIN provider_profiles profile ON profile.user_id=service.provider_id
         WHERE service.id=$1 AND service.provider_id=$2 AND service.active`,
        [serviceId, quote.provider_id]
      );
      service = serviceRows[0] ?? null;
    }
    if (serviceRequest.address_id || (!serviceId && approval.addressId)) {
      const addressId = serviceRequest.address_id ?? approval.addressId;
      if (!addressId)
        throw new ApiError(422, "validation_error", "Address is required.", { addressId: "Select an address." });
      const { rows: addressRows } = await transaction.query(
        "SELECT 1 FROM addresses WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL",
        [addressId, request.user.id]
      );
      if (!addressRows[0]) throw new ApiError(404, "not_found", "Address not found.");
    }
    if (!approval.addressId && service?.service_location === "at_customer" && !serviceRequest.address_id)
      throw new ApiError(422, "validation_error", "Address is required.", { addressId: "Select an address." });

    // O horário é negociado no orçamento, então não se aplica o horário de atendimento
    // do serviço; só se garante que a prestadora e a cliente estão livres.
    const durationMinutes = service?.duration_minutes ?? 60;
    const endAt = await assertSlotFree(transaction, {
      providerId: quote.provider_id,
      customerId: request.user.id,
      start: scheduledAt,
      durationMinutes,
    });

    const addressId = serviceRequest.address_id ?? approval.addressId ?? null;
    const checkinCode = String(crypto.randomInt(0, 10000)).padStart(4, "0");
    const totalAmount = Number(quote.total_amount);
    const { rows: orderRows } = await transaction.query(
      `INSERT INTO orders
        (customer_id,provider_id,service_id,address_id,service_location,scheduled_at,duration_minutes,
         status,total_amount,commission,checkin_code,quote_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'requested',$8,0,$9,$10) RETURNING id`,
      [request.user.id, quote.provider_id, serviceId, addressId,
       service?.service_location ?? "at_customer", scheduledAt, durationMinutes,
       totalAmount, checkinCode, quote.id]
    );
    const orderId = orderRows[0].id;
    await transaction.query(
      "INSERT INTO payments (order_id,status,method,method_token,held_until) VALUES ($1,'held',$2,null,$3)",
      [orderId, approval.paymentMethod, endAt]
    );
    await transaction.query(
      "INSERT INTO order_events (order_id,actor_id,type,data) VALUES ($1,$2,'created_from_quote',$3)",
      [orderId, request.user.id, { quoteId: quote.id }]
    );

    await transaction.query(
      "UPDATE quotes SET status='approved',reserved_quota=false,updated_at=now() WHERE id=$1",
      [quote.id]
    );

    // As demais propostas em negociação são encerradas e devolvem a cota de cada prestadora
    const { rows: competingQuotes } = await transaction.query(
      `SELECT * FROM quotes
       WHERE request_id=$1 AND id<>$2 AND status = ANY($3::text[])
       FOR UPDATE`,
      [quote.request_id, quote.id, NEGOTIABLE_QUOTE_STATUSES]
    );
    for (const competingQuote of competingQuotes) {
      await transaction.query(
        "UPDATE quotes SET status='rejected',updated_at=now() WHERE id=$1",
        [competingQuote.id]
      );
      await releaseReservedQuota(transaction, competingQuote);
    }

    await transaction.query(
      "UPDATE service_requests SET status='accepted',provider_id=$2,updated_at=now() WHERE id=$1",
      [quote.request_id, quote.provider_id]
    );

    // A reserva vira aprovação no mesmo mês em que a cota foi reservada
    if (quote.reserved_quota) {
      await transaction.query(
        `UPDATE monthly_approval_usage
         SET approved_count=approved_count+1,reserved_count=GREATEST(reserved_count-1,0)
         WHERE provider_id=$1 AND period=$2`,
        [quote.provider_id, quotaPeriodOf(quote)]
      );
    }
    return { id: orderId };
  });
  const { rows } = await runQuery("SELECT * FROM quotes WHERE id=$1", [request.params.id]);
  response.json({ ...rows[0], orderId: createdOrder.id });
}));

quotesRouter.get("/requests/:id/quotes", asyncHandler(async (request, response) => {
  const { rows: requestRows } = await runQuery(
    "SELECT * FROM service_requests WHERE id=$1",
    [request.params.id]
  );
  const serviceRequest = requestRows[0];
  if (!serviceRequest) throw new ApiError(404, "not_found", "Request not found.");
  if (serviceRequest.customer_id !== request.user.id && serviceRequest.provider_id !== request.user.id)
    throw new ApiError(403, "forbidden", "Not a participant of this request.");
  const { rows } = await runQuery(
    `SELECT q.*,
      provider.name AS "providerName",
      (SELECT json_agg(json_build_object(
        'id',qi.id,'serviceId',qi.service_id,'description',qi.description,
        'quantity',qi.quantity,'unitPrice',qi.unit_price,'kind',qi.kind
      ) ORDER BY qi.created_at) FROM quote_items qi WHERE qi.quote_id=q.id) AS items
     FROM quotes q
     JOIN users provider ON provider.id=q.provider_id
     WHERE q.request_id=$1
     ORDER BY q.created_at DESC`,
    [request.params.id]
  );
  response.json(rows);
}));

quotesRouter.get("/quotes/:id", asyncHandler(async (request, response) => {
  const { rows } = await runQuery(
    `SELECT q.*, provider.name AS "providerName",
      (SELECT json_agg(json_build_object(
        'id',qi.id,'serviceId',qi.service_id,'description',qi.description,
        'quantity',qi.quantity,'unitPrice',qi.unit_price,'kind',qi.kind
      )) FROM quote_items qi WHERE qi.quote_id=q.id) AS items
     FROM quotes q JOIN users provider ON provider.id=q.provider_id
     WHERE q.id=$1`,
    [request.params.id]
  );
  const quote = rows[0];
  if (!quote) throw new ApiError(404, "not_found", "Quote not found.");
  if (quote.customer_id !== request.user.id && quote.provider_id !== request.user.id)
    throw new ApiError(403, "forbidden", "Not a participant of this quote.");
  response.json(quote);
}));

quotesRouter.get("/quotes/:id/messages", asyncHandler(async (request, response) => {
  const { rows: quoteRows } = await runQuery("SELECT * FROM quotes WHERE id=$1", [request.params.id]);
  const quote = quoteRows[0];
  if (!quote) throw new ApiError(404, "not_found", "Quote not found.");
  if (quote.customer_id !== request.user.id && quote.provider_id !== request.user.id)
    throw new ApiError(403, "forbidden", "Not a participant of this quote.");
  const { rows } = await runQuery(
    `SELECT m.id,m.text,m.author_id AS "authorId",m.created_at AS "createdAt",u.name AS "authorName"
     FROM quote_messages m JOIN users u ON u.id=m.author_id
     WHERE m.quote_id=$1 ORDER BY m.created_at`,
    [request.params.id]
  );
  response.json(rows);
}));

quotesRouter.post("/quotes/:id/messages", asyncHandler(async (request, response) => {
  const messageSchema = z.object({ text: z.string().trim().min(1).max(2000) }).strict();
  const data = messageSchema.parse(request.body);
  const { rows: quoteRows } = await runQuery("SELECT * FROM quotes WHERE id=$1", [request.params.id]);
  const quote = quoteRows[0];
  if (!quote) throw new ApiError(404, "not_found", "Quote not found.");
  if (quote.customer_id !== request.user.id && quote.provider_id !== request.user.id)
    throw new ApiError(403, "forbidden", "Not a participant of this quote.");
  const { rows } = await runQuery(
    `INSERT INTO quote_messages (quote_id,author_id,text)
     VALUES ($1,$2,$3) RETURNING id,text,author_id AS "authorId",created_at AS "createdAt"`,
    [quote.id, request.user.id, data.text]
  );
  response.status(201).json(rows[0]);
}));

quotesRouter.post("/quotes/:id/counter", asyncHandler(async (request, response) => {
  const counterSchema = z.object({
    totalAmount: z.number().positive(),
    validUntil: z.string().datetime({ offset: true }),
    terms: z.string().trim().max(3000).nullable().optional(),
  }).strict();
  const data = counterSchema.parse(request.body);
  if (new Date(data.validUntil) <= new Date())
    throw new ApiError(422, "validation_error", "Validity must be in the future.", { validUntil: "Invalid validity." });
  const result = await runInTransaction(async (transaction) => {
    const { rows } = await transaction.query("SELECT * FROM quotes WHERE id=$1 FOR UPDATE", [request.params.id]);
    const quote = rows[0];
    if (!quote) throw new ApiError(404, "not_found", "Quote not found.");
    if (quote.customer_id !== request.user.id && quote.provider_id !== request.user.id)
      throw new ApiError(403, "forbidden", "Not a participant of this quote.");
    if (!["open", "countered"].includes(quote.status))
      throw new ApiError(409, "invalid_transition", "Quote is no longer open.");
    await transaction.query(
      `INSERT INTO quote_versions (quote_id,author_id,total_amount,valid_until,terms,change_type)
       VALUES ($1,$2,$3,$4,$5,'counter')`,
      [quote.id, request.user.id, data.totalAmount, data.validUntil, data.terms ?? null]
    );
    await transaction.query(
      "UPDATE quotes SET status='countered',total_amount=$2,valid_until=$3,terms=$4,updated_at=now() WHERE id=$1",
      [quote.id, data.totalAmount, data.validUntil, data.terms ?? null]
    );
    const { rows: updated } = await transaction.query("SELECT * FROM quotes WHERE id=$1", [quote.id]);
    return updated[0];
  });
  response.json(result);
}));

quotesRouter.post("/quotes/:id/reject", requireRole("cliente"), asyncHandler(async (request, response) => {
  const rejectedQuoteId = await runInTransaction(async (transaction) => {
    const { rows } = await transaction.query("SELECT * FROM quotes WHERE id=$1 FOR UPDATE", [request.params.id]);
    const quote = rows[0];
    if (!quote) throw new ApiError(404, "not_found", "Quote not found.");
    if (quote.customer_id !== request.user.id) throw new ApiError(403, "forbidden", "Not your quote.");
    if (!NEGOTIABLE_QUOTE_STATUSES.includes(quote.status))
      throw new ApiError(409, "invalid_transition", "Quote is no longer open.");

    await transaction.query("UPDATE quotes SET status='rejected',updated_at=now() WHERE id=$1", [quote.id]);
    await releaseReservedQuota(transaction, quote);
    return quote.id;
  });
  response.json({ id: rejectedQuoteId, status: "rejected" });
}));

module.exports = { quotesRouter };
