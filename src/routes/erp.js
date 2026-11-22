const erpRouter = require("express").Router();
const { z } = require("zod");
const { runQuery, runInTransaction } = require("../db");
const { ApiError, asyncHandler } = require("../errors");
const { requireRole } = require("../security");

erpRouter.use(requireRole("prestadora"));

function requirePlanFeature(featureName) {
  return asyncHandler(async (request, _response, next) => {
    const { rows } = await runQuery(
      `SELECT COALESCE(plan_catalog.features->$2,'false'::jsonb)='true'::jsonb AS enabled
       FROM plan_catalog
       WHERE plan_code=COALESCE(
         (SELECT plan_name FROM provider_plans WHERE provider_id=$1),'free'
       )`,
      [request.user.id, featureName]
    );
    if (!rows[0]?.enabled)
      throw new ApiError(403, "plan_required", "This feature is not enabled for the current plan.");
    next();
  });
}

erpRouter.get("/me/plan", asyncHandler(async (request, response) => {
  const period = new Date().toISOString().slice(0, 7);
  const [plan, availablePlans, usage, purchases, stats] = await Promise.all([
    runQuery(
      `SELECT plan_code AS plan,display_name AS "displayName",description,
        monthly_approval_limit AS "approvalLimit",features,active
       FROM plan_catalog
       WHERE plan_code=COALESCE(
         (SELECT plan_name FROM provider_plans WHERE provider_id=$1),'free'
       )`,
      [request.user.id]
    ),
    runQuery(
      `SELECT plan_code AS "planCode",display_name AS "displayName",description,
        monthly_approval_limit AS "monthlyApprovalLimit",features
       FROM plan_catalog WHERE active=true
       ORDER BY array_position(ARRAY['free','standard','pro','premium']::text[],plan_code)`
    ),
    runQuery("SELECT * FROM monthly_approval_usage WHERE provider_id=$1 AND period=$2", [request.user.id, period]),
    runQuery("SELECT purchase_kind,coalesce(sum(quantity),0)::int AS quantity FROM plan_purchases WHERE provider_id=$1 AND status='active' GROUP BY purchase_kind", [request.user.id]),
    runQuery("SELECT * FROM provider_stats WHERE provider_id=$1", [request.user.id]),
  ]);
  response.json({
    plan: plan.rows[0]?.plan ?? "free",
    displayName: plan.rows[0]?.displayName ?? "Free",
    description: plan.rows[0]?.description ?? null,
    approvalLimit: plan.rows[0] ? plan.rows[0].approvalLimit : 20,
    features: plan.rows[0]?.features ?? { team: false },
    availablePlans: availablePlans.rows,
    approved: usage.rows[0]?.approved_count ?? 0,
    reserved: usage.rows[0]?.reserved_count ?? 0,
    avulsos: Object.fromEntries(purchases.rows.map((row) => [row.purchase_kind, row.quantity])),
    stats: stats.rows[0] ?? null,
  });
}));

erpRouter.patch("/me/plan", asyncHandler(async (request, response) => {
  throw new ApiError(403, "plan_change_not_allowed", "Plan changes require verified payment or administrator approval.");
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

const financialPeriodSchema = z.enum(["week", "month", "quarter", "year"]);

function financialPeriodStart(period) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (period === "week") {
    start.setDate(start.getDate() - 6);
  } else if (period === "year") {
    start.setMonth(0, 1);
  } else {
    start.setDate(1);
    if (period === "quarter") start.setMonth(start.getMonth() - 2);
  }
  return start;
}

erpRouter.get("/me/financial", requirePlanFeature("finance"), asyncHandler(async (request, response) => {
  const period = financialPeriodSchema.default("month").parse(request.query.period);
  const periodStart = financialPeriodStart(period);
  const { rows } = await runQuery(
    `SELECT entry_type AS "entryType",coalesce(sum(amount),0)::float AS total
     FROM financial_entries
     WHERE provider_id=$1 AND occurred_at>= $2
     GROUP BY entry_type`,
    [request.user.id, periodStart]
  );
  const summary = Object.fromEntries(rows.map((row) => [row.entryType, row.total]));
  response.json({
    income: summary.income ?? 0,
    expense: summary.expense ?? 0,
    receivable: summary.receivable ?? 0,
    profit: (summary.income ?? 0) - (summary.expense ?? 0),
  });
}));

function cashFlowLabels(period, start) {
  if (period === "week") {
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      const weekday = new Intl.DateTimeFormat("pt-BR", { weekday: "short" })
        .format(date)
        .replace(".", "");
      return `${weekday} ${String(date.getDate()).padStart(2, "0")}`;
    });
  }
  if (period === "year") {
    return ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
  }
  const daysInMonth = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  return Array.from(
    { length: Math.ceil(daysInMonth / 7) },
    (_, index) => `${index * 7 + 1}-${Math.min(index * 7 + 7, daysInMonth)}`,
  );
}

erpRouter.get("/me/financial/dashboard", requirePlanFeature("finance"), asyncHandler(async (request, response) => {
  const period = z.enum(["week", "month", "year"]).default("month").parse(request.query.period);
  const periodStart = financialPeriodStart(period);
  const bucketIndex = period === "week"
    ? "(occurred_at::date - $2::date)::int"
    : period === "year"
      ? "(extract(month from occurred_at)::int - 1)"
      : "floor((extract(day from occurred_at) - 1) / 7)::int";
  const [summaryResult, entriesResult, cashFlowResult] = await Promise.all([
    runQuery(
      `SELECT entry_type AS "entryType",coalesce(sum(amount),0)::float AS total
       FROM financial_entries
       WHERE provider_id=$1 AND occurred_at >= $2
       GROUP BY entry_type`,
      [request.user.id, periodStart],
    ),
    runQuery(
      `SELECT id,entry_type AS "entryType",amount::float,category,description,
              occurred_at AS "occurredAt",customer_id AS "customerId",
              source_order_id AS "sourceOrderId"
       FROM financial_entries
       WHERE provider_id=$1 AND occurred_at >= $2
       ORDER BY occurred_at DESC LIMIT 200`,
      [request.user.id, periodStart],
    ),
    runQuery(
      `SELECT ${bucketIndex} AS "bucketIndex",
              coalesce(sum(amount) FILTER (WHERE entry_type='income'),0)::float AS income,
              coalesce(sum(amount) FILTER (WHERE entry_type='expense'),0)::float AS expense
       FROM financial_entries
       WHERE provider_id=$1 AND occurred_at >= $2
         AND entry_type IN ('income','expense')
       GROUP BY 1 ORDER BY 1`,
      [request.user.id, periodStart],
    ),
  ]);
  const totals = Object.fromEntries(
    summaryResult.rows.map((row) => [row.entryType, row.total]),
  );
  const labels = cashFlowLabels(period, periodStart);
  const buckets = new Map(
    cashFlowResult.rows.map((row) => [Number(row.bucketIndex), row]),
  );
  response.json({
    summary: {
      income: totals.income ?? 0,
      expense: totals.expense ?? 0,
      receivable: totals.receivable ?? 0,
      profit: (totals.income ?? 0) - (totals.expense ?? 0),
    },
    entries: entriesResult.rows,
    cashFlow: labels.map((label, index) => ({
      label,
      income: buckets.get(index)?.income ?? 0,
      expense: buckets.get(index)?.expense ?? 0,
    })),
  });
}));

erpRouter.get("/me/financial/entries", requirePlanFeature("finance"), asyncHandler(async (request, response) => {
  const period = financialPeriodSchema.default("month").parse(request.query.period);
  const periodStart = financialPeriodStart(period);
  const { rows } = await runQuery(
    `    SELECT id,entry_type AS "entryType",amount::float,category,description,payment_method AS "paymentMethod",
           occurred_at AS "occurredAt",customer_id AS "customerId",
           source_order_id AS "sourceOrderId"
     FROM financial_entries WHERE provider_id=$1 AND occurred_at>= $2
     ORDER BY occurred_at DESC LIMIT 200`,
    [request.user.id, periodStart]
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

erpRouter.post("/me/financial/entries", requirePlanFeature("finance"), asyncHandler(async (request, response) => {
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

erpRouter.get("/me/clients", requirePlanFeature("clients"), asyncHandler(async (request, response) => {
  const { rows } = await runQuery(
    `SELECT c.customer_id AS "customerId",u.name,u.email,c.tags,c.notes,c.birthday,c.next_contact_at AS "nextContactAt"
     FROM provider_clients c JOIN users u ON u.id=c.customer_id
     WHERE c.provider_id=$1 ORDER BY u.name`,
    [request.user.id]
  );
  response.json(rows);
}));

erpRouter.put("/me/clients/:customerId", requirePlanFeature("clients"), asyncHandler(async (request, response) => {
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

erpRouter.get("/me/stats", requirePlanFeature("statistics"), asyncHandler(async (request, response) => {
  const period = new Date().toISOString().slice(0, 7);
  const yearStart = new Date();
  yearStart.setMonth(0, 1);
  yearStart.setHours(0, 0, 0, 0);
  const [stored, usage] = await Promise.all([
    runQuery("SELECT * FROM provider_stats WHERE provider_id=$1", [request.user.id]),
    runQuery("SELECT * FROM monthly_approval_usage WHERE provider_id=$1 AND period=$2", [request.user.id, period]),
  ]);
  const [completed, monthlyOrders, monthlyFinancial] = await Promise.all([
    runQuery(
      `SELECT count(*)::int AS "completedServices",
              count(DISTINCT customer_id)::int AS "clientsServed",
              coalesce(sum(total_amount),0)::float AS "completedValue"
       FROM orders WHERE provider_id=$1 AND status='completed'`,
      [request.user.id],
    ),
    runQuery(
      `SELECT extract(month from coalesce(completion.completed_at, orders.scheduled_at))::int AS month,
              count(*)::int AS "completedServices",
              count(DISTINCT orders.customer_id)::int AS "clientsServed"
       FROM orders
       LEFT JOIN LATERAL (
         SELECT max(created_at) AS completed_at
         FROM order_events
         WHERE order_id=orders.id AND type='status_changed'
           AND data->>'to'='completed'
       ) completion ON true
       WHERE orders.provider_id=$1 AND orders.status='completed'
         AND coalesce(completion.completed_at, orders.scheduled_at) >= $2
       GROUP BY 1 ORDER BY 1`,
      [request.user.id, yearStart],
    ),
    runQuery(
      `SELECT extract(month from occurred_at)::int AS month,
              coalesce(sum(amount) FILTER (WHERE entry_type='income'),0)::float AS income,
              coalesce(sum(amount) FILTER (WHERE entry_type='expense'),0)::float AS expense
       FROM financial_entries
       WHERE provider_id=$1 AND occurred_at >= $2
       GROUP BY 1 ORDER BY 1`,
      [request.user.id, yearStart],
    ),
  ]);
  const stats = stored.rows[0] ?? {};
  const approved = usage.rows[0]?.approved_count ?? 0;
  const sent = stats.quote_sent ?? 0;
  const completedSummary = completed.rows[0];
  const monthly = new Map();
  for (const row of monthlyOrders.rows) {
    monthly.set(Number(row.month), { ...row });
  }
  for (const row of monthlyFinancial.rows) {
    const month = Number(row.month);
    monthly.set(month, { ...(monthly.get(month) ?? {}), ...row });
  }
  const monthlyActivity = Array.from({ length: 12 }, (_, index) => {
    const month = index + 1;
    const activity = monthly.get(month) ?? {};
    return {
      label: new Intl.DateTimeFormat("pt-BR", { month: "short", timeZone: "UTC" })
        .format(new Date(Date.UTC(yearStart.getFullYear(), index, 1)))
        .replace(".", ""),
      completedServices: Number(activity.completedServices ?? 0),
      clientsServed: Number(activity.clientsServed ?? 0),
      income: Number(activity.income ?? 0),
      expense: Number(activity.expense ?? 0),
    };
  });
  const completedServices = Number(completedSummary.completedServices ?? 0);
  const completedValue = Number(completedSummary.completedValue ?? 0);
  response.json({
    profileViews: stats.profile_views ?? 0,
    quotesSent: sent,
    quotesApproved: stats.quote_approved ?? approved,
    conversion: sent === 0 ? 0 : ((stats.quote_approved ?? approved) / sent) * 100,
    averageResponseMinutes: stats.average_response_minutes ?? null,
    completedServices,
    clientsServed: Number(completedSummary.clientsServed ?? 0),
    completedValue,
    averageServiceValue: completedServices === 0 ? 0 : completedValue / completedServices,
    monthlyActivity,
  });
}));

erpRouter.get("/me/promotions", requirePlanFeature("promotions"), asyncHandler(async (request, response) => {
  const { rows } = await runQuery(
    "SELECT * FROM promotions WHERE provider_id=$1 ORDER BY created_at DESC",
    [request.user.id]
  );
  response.json(rows);
}));

erpRouter.post("/me/promotions", requirePlanFeature("promotions"), asyncHandler(async (request, response) => {
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
    plan: z.enum(["free", "standard", "pro", "premium"]).optional(),
  }).strict().parse({
    ...request.body,
    plan: request.body?.plan
      ? String(request.body.plan).trim().toLowerCase()
      : undefined,
  });
  const { rows } = await runQuery(
    `INSERT INTO plan_purchases
       (provider_id,store_product_id,purchase_kind,quantity,plan_name,status)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [request.user.id, data.storeProductId, data.purchaseKind, data.quantity,
     data.purchaseKind === "subscription" ? data.plan ?? null : null,
     data.purchaseKind === "subscription" ? "pending" : "active"]
  );
  response.status(201).json(rows[0]);
}));

erpRouter.get("/me/team", requirePlanFeature("team"), asyncHandler(async (request, response) => {
  const { rows } = await runQuery(
    "SELECT * FROM team_members WHERE provider_id=$1 ORDER BY created_at DESC",
    [request.user.id]
  );
  response.json(rows);
}));

erpRouter.post("/me/team", requirePlanFeature("team"), asyncHandler(async (request, response) => {
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
