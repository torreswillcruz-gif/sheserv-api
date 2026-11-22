const erpRouter = require("express").Router();
const { z } = require("zod");
const { runQuery, runInTransaction } = require("../db");
const { ApiError, asyncHandler } = require("../errors");
const { requireRole } = require("../security");

erpRouter.use(requireRole("prestadora"));

erpRouter.get("/me/plan", asyncHandler(async (request, response) => {
  const period = new Date().toISOString().slice(0, 7);
  const [plan, usage, avulsos, stats] = await Promise.all([
    runQuery("SELECT * FROM provider_plans WHERE provider_id=$1", [request.user.id]),
    runQuery("SELECT * FROM monthly_approval_usage WHERE provider_id=$1 AND period=$2", [request.user.id, period]),
    runQuery("SELECT purchase_kind,coalesce(sum(quantity),0)::int AS quantity FROM plan_purchases WHERE provider_id=$1 AND status='active' GROUP BY purchase_kind", [request.user.id]),
    runQuery("SELECT * FROM provider_stats WHERE provider_id=$1", [request.user.id]),
  ]);
  response.json({
    plan: plan.rows[0]?.plan_name ?? "free",
    approvalLimit: plan.rows[0]?.monthly_approval_limit ?? 20,
    approved: usage.rows[0]?.approved_count ?? 0,
    reserved: usage.rows[0]?.reserved_count ?? 0,
    avulsos: Object.fromEntries(avulsos.rows.map((row) => [row.purchase_kind, row.quantity])),
    stats: stats.rows[0] ?? null,
  });
}));

erpRouter.get("/me/notifications", asyncHandler(async (request, response) => {
  const { rows } = await runQuery(
    `SELECT id,type,title,body,read,created_at AS "createdAt"
     FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`,
    [request.user.id]
  );
  response.json(rows);
}));

erpRouter.patch("/me/notifications/:id/read", asyncHandler(async (request, response) => {
  const { rows } = await runQuery(
    "UPDATE notifications SET read=true WHERE id=$1 AND user_id=$2 RETURNING id,read",
    [request.params.id, request.user.id]
  );
  if (!rows[0]) throw new ApiError(404, "not_found", "Notification not found.");
  response.json(rows[0]);
}));

erpRouter.get("/me/financial", asyncHandler(async (request, response) => {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const { rows } = await runQuery(
    `SELECT entry_type AS "entryType",coalesce(sum(amount),0)::float AS total
     FROM financial_entries
     WHERE provider_id=$1 AND occurred_at>= $2
     GROUP BY entry_type`,
    [request.user.id, monthStart]
  );
  const summary = Object.fromEntries(rows.map((row) => [row.entryType, row.total]));
  response.json({
    income: summary.income ?? 0,
    expense: summary.expense ?? 0,
    receivable: summary.receivable ?? 0,
    profit: (summary.income ?? 0) - (summary.expense ?? 0),
  });
}));

erpRouter.get("/me/financial/entries", asyncHandler(async (request, response) => {
  const { rows } = await runQuery(
    `SELECT id,entry_type AS "entryType",amount::float,category,description,payment_method AS "paymentMethod",
            occurred_at AS "occurredAt",customer_id AS "customerId"
     FROM financial_entries WHERE provider_id=$1 ORDER BY occurred_at DESC LIMIT 200`,
    [request.user.id]
  );
  response.json(rows);
}));

const entrySchema = z.object({
  entryType: z.enum(["income", "expense", "receivable"]),
  amount: z.number().positive(),
  category: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).nullable().optional(),
  paymentMethod: z.string().trim().max(100).nullable().optional(),
  customerId: z.string().uuid().nullable().optional(),
  occurredAt: z.string().datetime({ offset: true }).optional(),
}).strict();

erpRouter.post("/me/financial/entries", asyncHandler(async (request, response) => {
  const data = entrySchema.parse(request.body);
  const { rows } = await runQuery(
    `INSERT INTO financial_entries
      (provider_id,entry_type,amount,category,description,payment_method,customer_id,occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id,entry_type AS "entryType",amount::float,category,description,
               payment_method AS "paymentMethod",occurred_at AS "occurredAt"`,
    [request.user.id, data.entryType, data.amount, data.category, data.description ?? null,
     data.paymentMethod ?? null, data.customerId ?? null, data.occurredAt ?? new Date()]
  );
  response.status(201).json(rows[0]);
}));

erpRouter.get("/me/clients", asyncHandler(async (request, response) => {
  const { rows } = await runQuery(
    `SELECT c.customer_id AS "customerId",u.name,u.email,c.tags,c.notes,c.birthday,c.next_contact_at AS "nextContactAt"
     FROM provider_clients c JOIN users u ON u.id=c.customer_id
     WHERE c.provider_id=$1 ORDER BY u.name`,
    [request.user.id]
  );
  response.json(rows);
}));

erpRouter.put("/me/clients/:customerId", asyncHandler(async (request, response) => {
  const data = z.object({
    tags: z.array(z.string().trim().min(1).max(30)).max(20).default([]),
    notes: z.string().trim().max(3000).nullable().optional(),
    birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    nextContactAt: z.string().datetime({ offset: true }).nullable().optional(),
  }).strict().parse(request.body);
  const { rows } = await runQuery(
    `INSERT INTO provider_clients (provider_id,customer_id,tags,notes,birthday,next_contact_at)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (provider_id,customer_id) DO UPDATE SET
       tags=EXCLUDED.tags,notes=EXCLUDED.notes,birthday=EXCLUDED.birthday,
       next_contact_at=EXCLUDED.next_contact_at,updated_at=now()
     RETURNING customer_id AS "customerId",tags,notes,birthday,next_contact_at AS "nextContactAt"`,
    [request.user.id, request.params.customerId, data.tags, data.notes ?? null,
     data.birthday ?? null, data.nextContactAt ?? null]
  );
  response.json(rows[0]);
}));

erpRouter.get("/me/stats", asyncHandler(async (request, response) => {
  const period = new Date().toISOString().slice(0, 7);
  const [stored, usage] = await Promise.all([
    runQuery("SELECT * FROM provider_stats WHERE provider_id=$1", [request.user.id]),
    runQuery("SELECT * FROM monthly_approval_usage WHERE provider_id=$1 AND period=$2", [request.user.id, period]),
  ]);
  const stats = stored.rows[0] ?? {};
  const approved = usage.rows[0]?.approved_count ?? 0;
  const sent = stats.quote_sent ?? 0;
  response.json({
    profileViews: stats.profile_views ?? 0,
    quotesSent: sent,
    quotesApproved: stats.quote_approved ?? approved,
    conversion: sent === 0 ? 0 : ((stats.quote_approved ?? approved) / sent) * 100,
    averageResponseMinutes: stats.average_response_minutes ?? null,
  });
}));

erpRouter.get("/me/promotions", asyncHandler(async (request, response) => {
  const { rows } = await runQuery(
    "SELECT * FROM promotions WHERE provider_id=$1 ORDER BY created_at DESC",
    [request.user.id]
  );
  response.json(rows);
}));

erpRouter.post("/me/promotions", asyncHandler(async (request, response) => {
  const data = z.object({
    serviceId: z.string().uuid().nullable().optional(),
    message: z.string().trim().min(10).max(500),
    radiusKm: z.number().positive().max(500),
    durationDays: z.number().int().min(1).max(30),
  }).strict().parse(request.body);
  const startsAt = new Date();
  const endsAt = new Date(startsAt.getTime() + data.durationDays * 86400000);
  const { rows } = await runQuery(
    `INSERT INTO promotions (provider_id,service_id,message,radius_km,starts_at,ends_at,status)
     VALUES ($1,$2,$3,$4,$5,$6,'pending_review') RETURNING *`,
    [request.user.id, data.serviceId ?? null, data.message, data.radiusKm, startsAt, endsAt]
  );
  response.status(201).json(rows[0]);
}));

erpRouter.post("/me/purchases", asyncHandler(async (request, response) => {
  const data = z.object({
    storeProductId: z.string().trim().min(1).max(200),
    purchaseKind: z.enum(["subscription", "approval_pack", "promotion_pack", "featured"]),
    quantity: z.number().int().positive().max(1000).default(1),
  }).strict().parse(request.body);
  const { rows } = await runQuery(
    `INSERT INTO plan_purchases (provider_id,store_product_id,purchase_kind,quantity,status)
     VALUES ($1,$2,$3,$4,'active') RETURNING *`,
    [request.user.id, data.storeProductId, data.purchaseKind, data.quantity]
  );
  response.status(201).json(rows[0]);
}));

erpRouter.get("/me/team", asyncHandler(async (request, response) => {
  const plan = await runQuery("SELECT plan_name FROM provider_plans WHERE provider_id=$1", [request.user.id]);
  if ((plan.rows[0]?.plan_name ?? "free") !== "premium")
    throw new ApiError(403, "plan_required", "Team is available only for Premium.");
  const { rows } = await runQuery(
    "SELECT * FROM team_members WHERE provider_id=$1 ORDER BY created_at DESC",
    [request.user.id]
  );
  response.json(rows);
}));

erpRouter.post("/me/team", asyncHandler(async (request, response) => {
  const plan = await runQuery("SELECT plan_name FROM provider_plans WHERE provider_id=$1", [request.user.id]);
  if ((plan.rows[0]?.plan_name ?? "free") !== "premium")
    throw new ApiError(403, "plan_required", "Team is available only for Premium.");
  const data = z.object({
    email: z.string().email(),
    role: z.enum(["assistant", "manager"]).default("assistant"),
    permissions: z.record(z.boolean()).default({}),
  }).strict().parse(request.body);
  const count = await runQuery(
    "SELECT count(*)::int AS total FROM team_members WHERE provider_id=$1 AND status<>'removed'",
    [request.user.id]
  );
  if (count.rows[0].total >= 3)
    throw new ApiError(409, "team_limit", "Premium includes up to 3 team members.");
  const { rows } = await runQuery(
    `INSERT INTO team_members (provider_id,email,role,permissions,status)
     VALUES ($1,$2,$3,$4,'invited') RETURNING *`,
    [request.user.id, data.email, data.role, JSON.stringify(data.permissions)]
  );
  response.status(201).json(rows[0]);
}));

module.exports = { erpRouter };
