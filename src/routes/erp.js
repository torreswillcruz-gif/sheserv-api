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
  const [summaryResult, entriesResult, cashFlowResult, categoriesResult] = await Promise.all([
    runQuery(
      `SELECT entry_type AS "entryType",coalesce(sum(amount),0)::float AS total
       FROM financial_entries
       WHERE provider_id=$1 AND occurred_at >= $2
       GROUP BY entry_type`,
      [request.user.id, periodStart],
    ),
    runQuery(
      `SELECT id,entry_type AS "entryType",amount::float,category,description,
              payment_method AS "paymentMethod",
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
    // De onde veio e para onde foi o dinheiro: total por categoria, separando
    // o que veio de atendimentos do app (source_order_id) do que veio por fora.
    runQuery(
      `SELECT entry_type AS "entryType",category,
              (source_order_id IS NOT NULL) AS "fromApp",
              coalesce(sum(amount),0)::float AS total,count(*)::int AS count
       FROM financial_entries
       WHERE provider_id=$1 AND occurred_at >= $2
       GROUP BY 1,2,3 ORDER BY total DESC`,
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
    byCategory: categoriesResult.rows,
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

// Conta a receber que entrou: vira receita com a data de hoje (ou a informada).
erpRouter.patch("/me/financial/entries/:entryId/received", requirePlanFeature("finance"), asyncHandler(async (request, response) => {
  const entryId = z.string().uuid().parse(request.params.entryId);
  const data = z.object({
    occurredAt: z.string().datetime({ offset: true }).optional(),
    paymentMethod: z.string().trim().max(100).nullable().optional(),
  }).strict().parse(request.body ?? {});
  const { rows } = await runQuery(
    `UPDATE financial_entries
     SET entry_type='income',occurred_at=$3,payment_method=coalesce($4,payment_method)
     WHERE id=$1 AND provider_id=$2 AND entry_type='receivable'
     RETURNING id,entry_type AS "entryType",amount::float,category,description,
               payment_method AS "paymentMethod",occurred_at AS "occurredAt",
               source_order_id AS "sourceOrderId"`,
    [entryId, request.user.id, data.occurredAt ?? new Date(), data.paymentMethod ?? null]
  );
  if (!rows[0]) throw new ApiError(404, "entry_not_found", "Receivable entry not found.");
  response.json(rows[0]);
}));

// Só lançamentos feitos à mão; os dos atendimentos do app ficam (são o histórico do pedido).
erpRouter.delete("/me/financial/entries/:entryId", requirePlanFeature("finance"), asyncHandler(async (request, response) => {
  const entryId = z.string().uuid().parse(request.params.entryId);
  const { rows } = await runQuery(
    "SELECT source_order_id AS \"sourceOrderId\" FROM financial_entries WHERE id=$1 AND provider_id=$2",
    [entryId, request.user.id]
  );
  if (!rows[0]) throw new ApiError(404, "entry_not_found", "Entry not found.");
  if (rows[0].sourceOrderId)
    throw new ApiError(409, "entry_from_order", "Entries created by an order cannot be deleted.");
  await runQuery("DELETE FROM financial_entries WHERE id=$1 AND provider_id=$2", [entryId, request.user.id]);
  response.status(204).end();
}));

// ---------------------------------------------------------------------------
// Inventário: produtos e materiais da prestadora.

const INVENTORY_ITEM_COLUMNS = `id,name,unit,quantity::float,min_quantity::float AS "minQuantity",
  unit_cost::float AS "unitCost",updated_at AS "updatedAt"`;

const inventoryItemSchema = z.object({
  name: z.string().trim().min(1).max(80),
  unit: z.string().trim().min(1).max(10).default("un"),
  quantity: z.number().min(0).max(1_000_000).default(0),
  minQuantity: z.number().min(0).max(1_000_000).default(0),
  unitCost: z.number().min(0).max(1_000_000).nullable().optional(),
}).strict();

erpRouter.get("/me/inventory", requirePlanFeature("inventory"), asyncHandler(async (request, response) => {
  const { rows } = await runQuery(
    `SELECT ${INVENTORY_ITEM_COLUMNS} FROM inventory_items
     WHERE provider_id=$1 AND active ORDER BY name`,
    [request.user.id]
  );
  const items = rows.map((item) => ({ ...item, lowStock: item.quantity <= item.minQuantity }));
  response.json({
    items,
    summary: {
      itemCount: items.length,
      lowStockCount: items.filter((item) => item.lowStock).length,
      stockValue: items.reduce((total, item) => total + item.quantity * (item.unitCost ?? 0), 0),
    },
  });
}));

erpRouter.post("/me/inventory", requirePlanFeature("inventory"), asyncHandler(async (request, response) => {
  const data = inventoryItemSchema.parse(request.body);
  const { rows } = await runQuery(
    `INSERT INTO inventory_items (provider_id,name,unit,quantity,min_quantity,unit_cost)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${INVENTORY_ITEM_COLUMNS}`,
    [request.user.id, data.name, data.unit, data.quantity, data.minQuantity, data.unitCost ?? null]
  );
  response.status(201).json(rows[0]);
}));

// A quantidade não muda aqui: só por movimentação, para ficar no histórico.
erpRouter.put("/me/inventory/:itemId", requirePlanFeature("inventory"), asyncHandler(async (request, response) => {
  const itemId = z.string().uuid().parse(request.params.itemId);
  const data = inventoryItemSchema.omit({ quantity: true }).parse(request.body);
  const { rows } = await runQuery(
    `UPDATE inventory_items SET name=$3,unit=$4,min_quantity=$5,unit_cost=$6,updated_at=now()
     WHERE id=$1 AND provider_id=$2 AND active RETURNING ${INVENTORY_ITEM_COLUMNS}`,
    [itemId, request.user.id, data.name, data.unit, data.minQuantity, data.unitCost ?? null]
  );
  if (!rows[0]) throw new ApiError(404, "item_not_found", "Inventory item not found.");
  response.json(rows[0]);
}));

// Arquiva (some da lista) sem apagar o histórico de movimentações.
erpRouter.delete("/me/inventory/:itemId", requirePlanFeature("inventory"), asyncHandler(async (request, response) => {
  const itemId = z.string().uuid().parse(request.params.itemId);
  const { rows } = await runQuery(
    `UPDATE inventory_items SET active=false,updated_at=now()
     WHERE id=$1 AND provider_id=$2 AND active RETURNING id`,
    [itemId, request.user.id]
  );
  if (!rows[0]) throw new ApiError(404, "item_not_found", "Inventory item not found.");
  response.status(204).end();
}));

erpRouter.get("/me/inventory/:itemId/movements", requirePlanFeature("inventory"), asyncHandler(async (request, response) => {
  const itemId = z.string().uuid().parse(request.params.itemId);
  const { rows } = await runQuery(
    `SELECT id,kind,quantity_change::float AS "quantityChange",quantity_after::float AS "quantityAfter",
            unit_cost::float AS "unitCost",financial_entry_id AS "financialEntryId",note,
            created_at AS "createdAt"
     FROM inventory_movements WHERE item_id=$1 AND provider_id=$2
     ORDER BY created_at DESC LIMIT 50`,
    [itemId, request.user.id]
  );
  response.json(rows);
}));

const movementSchema = z.object({
  // purchase: comprou (soma) · use: usou num atendimento (tira) ·
  // loss: perdeu/estragou (tira) · count: contagem (quantity é o total contado)
  kind: z.enum(["purchase", "use", "loss", "count"]),
  quantity: z.number().min(0).max(1_000_000),
  unitCost: z.number().min(0).max(1_000_000).nullable().optional(),
  // Compra vira "Material e produtos" e perda vira "Prejuízo" no financeiro.
  registerExpense: z.boolean().default(false),
  note: z.string().trim().max(300).nullable().optional(),
}).strict().refine((data) => data.kind === "count" || data.quantity > 0, {
  message: "Quantity must be positive.", path: ["quantity"],
});

const roundQuantity = (value) => Math.round(value * 1000) / 1000;
const roundMoney = (value) => Math.round(value * 100) / 100;

erpRouter.post("/me/inventory/:itemId/movements", requirePlanFeature("inventory"), asyncHandler(async (request, response) => {
  const itemId = z.string().uuid().parse(request.params.itemId);
  const data = movementSchema.parse(request.body);
  const result = await runInTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id,name,unit,quantity::float,unit_cost::float AS "unitCost" FROM inventory_items
       WHERE id=$1 AND provider_id=$2 AND active FOR UPDATE`,
      [itemId, request.user.id]
    );
    const item = rows[0];
    if (!item) throw new ApiError(404, "item_not_found", "Inventory item not found.");
    const change = data.kind === "purchase" ? data.quantity
      : data.kind === "count" ? data.quantity - item.quantity
        : -data.quantity;
    const quantityAfter = roundQuantity(item.quantity + change);
    if (quantityAfter < 0) {
      throw new ApiError(409, "insufficient_stock", "Not enough stock for this movement.", {
        available: item.quantity,
      });
    }
    // Compra com custo novo atualiza o custo unitário do item.
    const unitCost = data.unitCost ?? item.unitCost ?? null;
    let financialEntryId = null;
    if (data.registerExpense && (data.kind === "purchase" || data.kind === "loss")) {
      if (unitCost == null) {
        throw new ApiError(422, "unit_cost_required", "A unit cost is needed to register the expense.");
      }
      const amount = roundMoney(Math.abs(change) * unitCost);
      if (amount > 0) {
        const entry = await client.query(
          `INSERT INTO financial_entries (provider_id,entry_type,amount,category,description,occurred_at)
           VALUES ($1,'expense',$2,$3,$4,now()) RETURNING id`,
          [request.user.id, amount, data.kind === "purchase" ? "supplies" : "loss",
           `${data.kind === "purchase" ? "Compra" : "Perda"}: ${Math.abs(change)} ${item.unit} de ${item.name}`]
        );
        financialEntryId = entry.rows[0].id;
      }
    }
    const updated = await client.query(
      `UPDATE inventory_items SET quantity=$2,unit_cost=$3,updated_at=now()
       WHERE id=$1 RETURNING ${INVENTORY_ITEM_COLUMNS}`,
      [itemId, quantityAfter, data.kind === "purchase" ? unitCost : item.unitCost ?? null]
    );
    await client.query(
      `INSERT INTO inventory_movements
        (item_id,provider_id,kind,quantity_change,quantity_after,unit_cost,financial_entry_id,note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [itemId, request.user.id, data.kind, roundQuantity(change), quantityAfter, unitCost,
       financialEntryId, data.note ?? null]
    );
    return { item: updated.rows[0], financialEntryId };
  });
  response.status(201).json(result);
}));

// ---------------------------------------------------------------------------
// Insights: números por mês para o app calcular gastos, previsão e quantos
// atendimentos a prestadora precisa para ficar no lucro.

erpRouter.get("/me/insights", requirePlanFeature("statistics"), asyncHandler(async (request, response) => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(1);
  start.setMonth(start.getMonth() - 6); // 6 meses fechados + o atual
  const [financial, inventory] = await Promise.all([
    runQuery(
      `SELECT to_char(date_trunc('month', occurred_at),'YYYY-MM') AS month,
              entry_type AS "entryType",category,
              (source_order_id IS NOT NULL) AS "fromApp",
              coalesce(sum(amount),0)::float AS total,count(*)::int AS count
       FROM financial_entries
       WHERE provider_id=$1 AND occurred_at >= $2
       GROUP BY 1,2,3,4 ORDER BY 1`,
      [request.user.id, start]
    ),
    runQuery(
      `SELECT count(*) FILTER (WHERE quantity <= min_quantity)::int AS "lowStockCount",
              coalesce(sum(quantity * coalesce(unit_cost,0)),0)::float AS "stockValue"
       FROM inventory_items WHERE provider_id=$1 AND active`,
      [request.user.id]
    ),
  ]);
  response.json({
    generatedAt: new Date().toISOString(),
    since: start.toISOString(),
    rows: financial.rows,
    inventory: inventory.rows[0] ?? { lowStockCount: 0, stockValue: 0 },
  });
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

// Ativa a assinatura: marca a compra como paga e troca o plano da prestadora.
// Hoje é chamada direto pela rota de compra (sem gateway). Com o gateway, deve
// ser chamada só quando o pagamento for confirmado (webhook), passando os dados
// da transação em `payment`.
async function activateSubscription(transaction, { providerId, purchaseId, planCode, payment = {} }) {
  const { rows: plans } = await transaction.query(
    "SELECT plan_code,monthly_approval_limit FROM plan_catalog WHERE plan_code=$1 AND active=true",
    [planCode]
  );
  if (!plans[0]) throw new ApiError(404, "not_found", "Active plan not found.");

  await transaction.query(
    `UPDATE plan_purchases SET status='active',paid_at=now(),
       gateway_provider=$2,gateway_transaction_id=$3,amount=$4
     WHERE id=$1`,
    [purchaseId, payment.provider ?? null, payment.transactionId ?? null, payment.amount ?? null]
  );
  // Mesmo upsert da atribuição de plano pelo admin (admin-api).
  const { rows } = await transaction.query(
    `INSERT INTO provider_plans (provider_id,plan_name,monthly_approval_limit,renewal_at,updated_at)
     VALUES ($1,$2,$3,date_trunc('month',now()) + interval '1 month',now())
     ON CONFLICT (provider_id) DO UPDATE SET
       plan_name=EXCLUDED.plan_name,monthly_approval_limit=EXCLUDED.monthly_approval_limit,
       renewal_at=EXCLUDED.renewal_at,updated_at=now()
     RETURNING plan_name AS "planCode",monthly_approval_limit AS "monthlyApprovalLimit",
       renewal_at AS "renewalAt"`,
    [providerId, planCode, plans[0].monthly_approval_limit]
  );
  return rows[0];
}

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
  const isSubscription = data.purchaseKind === "subscription";
  if (isSubscription && !data.plan)
    throw new ApiError(422, "validation_error", "Subscription purchases require a plan.", { plan: "required" });

  const result = await runInTransaction(async (transaction) => {
    const { rows } = await transaction.query(
      `INSERT INTO plan_purchases
         (provider_id,store_product_id,purchase_kind,quantity,plan_name,status)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [request.user.id, data.storeProductId, data.purchaseKind, data.quantity,
       isSubscription ? data.plan : null,
       isSubscription ? "pending" : "active"]
    );
    const purchase = rows[0];
    if (!isSubscription) return { ...purchase };

    // TODO(payment-gateway): integração com o Mercado Pago (Mercado Livre).
    // Quando o gateway existir, este trecho deve:
    //   1. Criar a cobrança/assinatura no gateway (ex.: POST /preapproval ou
    //      /checkout/preferences), usando `purchase.id` como external_reference.
    //   2. Gravar gateway_provider='mercado_pago' e gateway_transaction_id na compra.
    //   3. Responder 201 com a compra ainda `pending` e o link de pagamento
    //      (init_point) para o app abrir — SEM chamar activateSubscription aqui.
    // A ativação passa para o webhook abaixo, depois que o gateway confirmar
    // o pagamento (status "approved"/"authorized").
    // Enquanto não há gateway, o plano é ativado direto:
    const plan = await activateSubscription(transaction, {
      providerId: request.user.id,
      purchaseId: purchase.id,
      planCode: data.plan,
    });
    return { ...purchase, status: "active", plan };
  });

  response.status(201).json(result);
}));

// TODO(payment-gateway): webhook de confirmação do Mercado Pago.
// Rota pública (sem requireRole/JWT; montar FORA do erpRouter, que exige
// a role prestadora), validando a assinatura do header `x-signature` com o
// segredo do webhook antes de confiar no corpo. Esboço:
//
// webhookRouter.post("/payments/mercado-pago/webhook", asyncHandler(async (request, response) => {
//   // 1. Validar x-signature; buscar o pagamento na API do Mercado Pago pelo id
//   //    recebido (nunca confiar só no corpo do webhook).
//   // 2. Se aprovado: localizar a compra por external_reference (= plan_purchases.id),
//   //    ignorar se já estiver 'active' (webhooks são reenviados) e chamar:
//   //    await runInTransaction((transaction) => activateSubscription(transaction, {
//   //      providerId: purchase.provider_id, purchaseId: purchase.id, planCode: purchase.plan_name,
//   //      payment: { provider: "mercado_pago", transactionId: payment.id, amount: payment.transaction_amount },
//   //    }));
//   // 3. Se recusado/cancelado: UPDATE plan_purchases SET status='failed'.
//   // 4. Responder 200 rápido para o gateway não reenviar.
//   response.sendStatus(200);
// }));

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
