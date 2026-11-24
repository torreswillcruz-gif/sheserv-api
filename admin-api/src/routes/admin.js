const adminRouter = require("express").Router();
const { z } = require("zod");
const { runQuery, runInTransaction } = require("../db");
const { ApiError, asyncHandler } = require("../errors");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAN_CODES = ["free", "standard", "pro", "premium"];
const featureValueSchema = z.union([z.boolean(), z.number().finite(), z.string().trim().max(120)]);
const featuresSchema = z.record(z.string().regex(/^[a-z][a-zA-Z0-9_]*$/), featureValueSchema)
  .refine((features) => Object.keys(features).length <= 50);

const listQuerySchema = z.object({
  status: z.enum(["pending", "active", "rejected"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10000).default(0),
}).strict();

const approvalSchema = z.object({
  status: z.enum(["active", "rejected"]),
  reason: z.string().trim().min(1).max(500).optional(),
}).strict().refine(
  (change) => change.status !== "rejected" || Boolean(change.reason),
  { message: "A reason is required when rejecting a provider.", path: ["reason"] }
);

const planUpdateSchema = z.object({
  displayName: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).nullable(),
  monthlyApprovalLimit: z.number().int().min(0).max(100000).nullable(),
  features: featuresSchema,
  active: z.boolean(),
}).strict();

const assignPlanSchema = z.object({
  planCode: z.enum(PLAN_CODES),
}).strict();

const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10000).default(0),
}).strict();

function validateUuid(value, message) {
  if (!UUID_PATTERN.test(value)) throw new ApiError(404, "not_found", message);
}

async function recordAudit(transaction, adminId, action, resourceType, resourceId, details) {
  await transaction.query(
    `INSERT INTO admin_audit_events (admin_id,action,resource_type,resource_id,details)
     VALUES ($1,$2,$3,$4,$5)`,
    [adminId, action, resourceType, resourceId, JSON.stringify(details)]
  );
}

adminRouter.get("/providers", asyncHandler(async (request, response) => {
  const filters = listQuerySchema.parse(request.query);
  const { rows } = await runQuery(
    `SELECT provider_user.id,provider_user.name,provider_user.email,provider_user.phone,
       provider_user.created_at AS "createdAt",provider_profile.bio,
       provider_profile.activation_status AS "activationStatus",
       provider_profile.verified AS "identityVerified",
       COALESCE(provider_plan.plan_name,'free') AS "planCode",
       COALESCE(plan.display_name,'Grátis') AS "planName",
       COALESCE((
         SELECT json_agg(json_build_object(
           'title',offered.title,
           'category',category.name,
           'basePrice',offered.base_price::float,
           'priceType',offered.price_type,
           'serviceLocation',offered.service_location
         ) ORDER BY offered.title)
         FROM services offered
         JOIN categories category ON category.id=offered.category_id
         WHERE offered.provider_id=provider_user.id AND offered.active
       ),'[]'::json) AS services
     FROM provider_profiles provider_profile
     JOIN users provider_user ON provider_user.id=provider_profile.user_id
     LEFT JOIN provider_plans provider_plan ON provider_plan.provider_id=provider_user.id
     LEFT JOIN plan_catalog plan ON plan.plan_code=COALESCE(provider_plan.plan_name,'free')
     WHERE provider_user.roles @> ARRAY['prestadora']::text[]
       AND ($1::text IS NULL OR provider_profile.activation_status=$1)
     ORDER BY CASE provider_profile.activation_status WHEN 'pending' THEN 0 ELSE 1 END,
       provider_user.created_at ASC
     LIMIT $2 OFFSET $3`,
    [filters.status ?? null, filters.limit, filters.offset]
  );
  response.json({ items: rows, limit: filters.limit, offset: filters.offset });
}));

adminRouter.patch("/providers/:id/approval", asyncHandler(async (request, response) => {
  validateUuid(request.params.id, "Provider not found.");
  const change = approvalSchema.parse(request.body);

  const result = await runInTransaction(async (transaction) => {
    const { rows: providers } = await transaction.query(
      `SELECT provider_user.id,provider_profile.activation_status AS status
       FROM users provider_user
       JOIN provider_profiles provider_profile ON provider_profile.user_id=provider_user.id
       WHERE provider_user.id=$1 AND provider_user.roles @> ARRAY['prestadora']::text[]
       FOR UPDATE OF provider_profile`,
      [request.params.id]
    );
    if (!providers[0]) throw new ApiError(404, "not_found", "Provider not found.");

    const previousStatus = providers[0].status;
    // A aprovação da prestadora é a verificação dela: aprovar marca como
    // verificada (requisito para aparecer na busca do app); recusar desmarca.
    const { rows: updatedProviders } = await transaction.query(
      `UPDATE provider_profiles
       SET activation_status=$1,
           verified=($1='active'),
           available=CASE WHEN $1='rejected' THEN false ELSE available END
       WHERE user_id=$2
       RETURNING user_id AS id,activation_status AS "activationStatus",verified AS "identityVerified"`,
      [change.status, request.params.id]
    );
    // Pedidos de verificação ainda abertos são resolvidos junto com o cadastro
    await transaction.query(
      `UPDATE verifications
       SET result=$2,review_note=$3,reviewed_at=now(),reviewed_by=$4
       WHERE user_id=$1 AND result='pending'`,
      [
        request.params.id,
        change.status === "active" ? "approved" : "rejected",
        change.status === "active" ? "Verificada na aprovação do cadastro de prestadora." : change.reason,
        request.user.id,
      ]
    );
    const notification = change.status === "active"
      ? ["Cadastro aprovado", "Seu cadastro como prestadora foi aprovado."]
      : ["Cadastro não aprovado", `Seu cadastro como prestadora não foi aprovado. Motivo: ${change.reason}`];
    await transaction.query(
      "INSERT INTO notifications (user_id,type,title,body) VALUES ($1,$2,$3,$4)",
      [request.params.id, `provider_${change.status}`, notification[0], notification[1]]
    );
    await recordAudit(transaction, request.user.id, "provider.approval_changed", "provider", request.params.id, {
      previousStatus,
      status: change.status,
      reason: change.reason ?? null,
    });
    return updatedProviders[0];
  });

  response.json(result);
}));

// ---------- Verificações de identidade (revisão manual) ----------

const VERIFICATION_RESULTS = ["pending", "approved", "rejected"];

const verificationListSchema = z.object({
  result: z.enum(VERIFICATION_RESULTS).default("pending"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10000).default(0),
}).strict();

const verificationReviewSchema = z.object({
  result: z.enum(["approved", "rejected"]),
  reason: z.string().trim().min(1).max(500).optional(),
}).strict().refine(
  (review) => review.result !== "rejected" || Boolean(review.reason),
  { message: "A reason is required when rejecting a verification.", path: ["reason"] }
);

adminRouter.get("/verifications", asyncHandler(async (request, response) => {
  const filters = verificationListSchema.parse(request.query);
  const { rows } = await runQuery(
    `SELECT verification.id,verification.type,verification.result,
       verification.review_note AS "reviewNote",verification.reviewed_at AS "reviewedAt",
       verification.created_at AS "createdAt",
       requester.id AS "userId",requester.name,requester.email,requester.phone,requester.roles,
       provider_profile.activation_status AS "providerStatus"
     FROM verifications verification
     JOIN users requester ON requester.id=verification.user_id
     LEFT JOIN provider_profiles provider_profile ON provider_profile.user_id=requester.id
     WHERE verification.result=$1
     ORDER BY verification.created_at ${filters.result === "pending" ? "ASC" : "DESC"}
     LIMIT $2 OFFSET $3`,
    [filters.result, filters.limit, filters.offset]
  );
  response.json({ items: rows, limit: filters.limit, offset: filters.offset });
}));

adminRouter.patch("/verifications/:id", asyncHandler(async (request, response) => {
  validateUuid(request.params.id, "Verification not found.");
  const review = verificationReviewSchema.parse(request.body);

  const result = await runInTransaction(async (transaction) => {
    const { rows: verifications } = await transaction.query(
      "SELECT id,user_id,type,result FROM verifications WHERE id=$1 FOR UPDATE",
      [request.params.id]
    );
    const verification = verifications[0];
    if (!verification) throw new ApiError(404, "not_found", "Verification not found.");

    const { rows: updated } = await transaction.query(
      `UPDATE verifications SET result=$2,review_note=$3,reviewed_at=now(),reviewed_by=$4
       WHERE id=$1
       RETURNING id,type,result,review_note AS "reviewNote",reviewed_at AS "reviewedAt"`,
      [verification.id, review.result, review.reason ?? null, request.user.id]
    );
    // Identidade confirmada também vale como selo de verificada da prestadora.
    // Não muda a aprovação do cadastro (activation_status).
    if (review.result === "approved") {
      await transaction.query("UPDATE provider_profiles SET verified=true WHERE user_id=$1", [verification.user_id]);
    }
    const notification = review.result === "approved"
      ? ["Identidade verificada", "Sua verificação de identidade foi aprovada."]
      : ["Verificação não aprovada", `Sua verificação de identidade não foi aprovada. Motivo: ${review.reason}`];
    await transaction.query(
      "INSERT INTO notifications (user_id,type,title,body) VALUES ($1,$2,$3,$4)",
      [verification.user_id, `verification_${review.result}`, notification[0], notification[1]]
    );
    await recordAudit(transaction, request.user.id, "verification.reviewed", "verification", verification.id, {
      userId: verification.user_id,
      type: verification.type,
      previousResult: verification.result,
      result: review.result,
      reason: review.reason ?? null,
    });
    return updated[0];
  });

  response.json(result);
}));

// ---------- Planos ----------

adminRouter.get("/plans", asyncHandler(async (_request, response) => {
  const { rows } = await runQuery(
    `SELECT plan_code AS "planCode",display_name AS "displayName",description,
       monthly_approval_limit AS "monthlyApprovalLimit",features,active,
       updated_at AS "updatedAt"
     FROM plan_catalog ORDER BY array_position($1::text[],plan_code)`,
    [PLAN_CODES]
  );
  response.json(rows);
}));

adminRouter.put("/plans/:planCode", asyncHandler(async (request, response) => {
  const planCode = z.enum(PLAN_CODES).parse(request.params.planCode);
  const update = planUpdateSchema.parse(request.body);
  const result = await runInTransaction(async (transaction) => {
    const { rows: existingPlans } = await transaction.query(
      "SELECT plan_code AS code,display_name AS name,description,monthly_approval_limit AS limit,features,active FROM plan_catalog WHERE plan_code=$1 FOR UPDATE",
      [planCode]
    );
    if (!existingPlans[0]) throw new ApiError(404, "not_found", "Plan not found.");

    const { rows: updatedPlans } = await transaction.query(
      `UPDATE plan_catalog SET display_name=$2,description=$3,monthly_approval_limit=$4,
       features=$5,active=$6,updated_at=now()
       WHERE plan_code=$1
       RETURNING plan_code AS "planCode",display_name AS "displayName",description,
         monthly_approval_limit AS "monthlyApprovalLimit",features,active,updated_at AS "updatedAt"`,
      [planCode, update.displayName, update.description, update.monthlyApprovalLimit,
        JSON.stringify(update.features), update.active]
    );
    await transaction.query(
      "UPDATE provider_plans SET monthly_approval_limit=$1,updated_at=now() WHERE plan_name=$2",
      [update.monthlyApprovalLimit, planCode]
    );
    await recordAudit(transaction, request.user.id, "plan.updated", "plan", planCode, {
      before: existingPlans[0],
      after: updatedPlans[0],
    });
    return updatedPlans[0];
  });

  response.json(result);
}));

adminRouter.patch("/providers/:id/plan", asyncHandler(async (request, response) => {
  validateUuid(request.params.id, "Provider not found.");
  const { planCode } = assignPlanSchema.parse(request.body);
  const result = await runInTransaction(async (transaction) => {
    const { rows: providers } = await transaction.query(
      `SELECT provider_user.id,provider_profile.activation_status AS "activationStatus"
       FROM users provider_user
       JOIN provider_profiles provider_profile ON provider_profile.user_id=provider_user.id
       WHERE provider_user.id=$1 AND provider_user.roles @> ARRAY['prestadora']::text[]
       FOR UPDATE OF provider_profile`,
      [request.params.id]
    );
    if (!providers[0]) throw new ApiError(404, "not_found", "Provider not found.");

    const { rows: plans } = await transaction.query(
      `SELECT plan_code,monthly_approval_limit FROM plan_catalog
       WHERE plan_code=$1 AND active=true`,
      [planCode]
    );
    if (!plans[0]) throw new ApiError(404, "not_found", "Active plan not found.");

    const { rows: assignments } = await transaction.query(
      `INSERT INTO provider_plans (provider_id,plan_name,monthly_approval_limit,renewal_at,updated_at)
       VALUES ($1,$2,$3,date_trunc('month',now()) + interval '1 month',now())
       ON CONFLICT (provider_id) DO UPDATE SET
         plan_name=EXCLUDED.plan_name,monthly_approval_limit=EXCLUDED.monthly_approval_limit,
         renewal_at=EXCLUDED.renewal_at,updated_at=now()
       RETURNING provider_id AS "providerId",plan_name AS "planCode",
         monthly_approval_limit AS "monthlyApprovalLimit",renewal_at AS "renewalAt"`,
      [request.params.id, planCode, plans[0].monthly_approval_limit]
    );
    await recordAudit(transaction, request.user.id, "provider.plan_assigned", "provider", request.params.id, {
      planCode,
      activationStatus: providers[0].activationStatus,
    });
    return assignments[0];
  });

  response.json(result);
}));

// ---------- Categorias ----------
//
// Mantidas pelo admin: o app lista só as ativas, na ordem `sortOrder`.
// Dois níveis: categoria principal e subcategoria (de uma principal).
// Excluir só quando nada usa a categoria; com serviços, desative.

// Chaves de ícone que o app sabe desenhar (ServiceCategoryTile no app).
const CATEGORY_ICONS = [
  "general", "cleaning", "beauty", "fashion", "cooking", "learning",
  "repairs", "care", "pets", "health", "events", "transport",
];

const categoryIdSchema = z.string().trim().min(2).max(40)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use letras minúsculas, números e hífens (ex.: limpeza-pos-obra).");

const categoryFields = {
  name: z.string().trim().min(2).max(60),
  parentId: categoryIdSchema.nullable().default(null),
  icon: z.enum(CATEGORY_ICONS).default("general"),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  active: z.boolean().default(true),
};
const categoryCreateSchema = z.object({ id: categoryIdSchema, ...categoryFields }).strict();
const categoryUpdateSchema = z.object(categoryFields).strict();

const CATEGORY_RETURNING = `id,parent_id AS "parentId",name,icon,active,
  sort_order AS "sortOrder",updated_at AS "updatedAt"`;

function categoryError(field, message) {
  return new ApiError(422, "validation_error", "The request is invalid.", { [field]: message });
}

// A categoria acima precisa existir e ser principal; quem tem subcategorias
// não pode virar subcategoria (só dois níveis).
async function assertValidParent(transaction, parentId, categoryId) {
  if (parentId === null) return;
  if (parentId === categoryId) {
    throw categoryError("parentId", "Uma categoria não pode ficar dentro dela mesma.");
  }
  const { rows: parents } = await transaction.query("SELECT parent_id FROM categories WHERE id=$1", [parentId]);
  if (!parents[0]) throw categoryError("parentId", "Categoria principal não encontrada.");
  if (parents[0].parent_id !== null) {
    throw categoryError("parentId", "Escolha uma categoria principal (sem outra acima dela).");
  }
  const { rows: children } = await transaction.query(
    "SELECT count(*)::int AS total FROM categories WHERE parent_id=$1",
    [categoryId]
  );
  if (children[0]?.total > 0) {
    throw categoryError("parentId", "Esta categoria tem subcategorias e não pode virar subcategoria.");
  }
}

adminRouter.get("/categories", asyncHandler(async (_request, response) => {
  const { rows } = await runQuery(
    `SELECT category.id,category.parent_id AS "parentId",category.name,category.icon,category.active,
       category.sort_order AS "sortOrder",category.updated_at AS "updatedAt",
       (SELECT count(*)::int FROM services service WHERE service.category_id=category.id) AS "serviceCount",
       (SELECT count(*)::int FROM services service
        WHERE service.category_id=category.id AND service.active) AS "activeServiceCount",
       (SELECT count(*)::int FROM categories child WHERE child.parent_id=category.id) AS "childCount"
     FROM categories category
     ORDER BY category.sort_order,category.name`
  );
  response.json({ items: rows, icons: CATEGORY_ICONS });
}));

adminRouter.post("/categories", asyncHandler(async (request, response) => {
  const category = categoryCreateSchema.parse(request.body);
  const created = await runInTransaction(async (transaction) => {
    const { rows: existing } = await transaction.query("SELECT 1 FROM categories WHERE id=$1", [category.id]);
    if (existing[0]) {
      throw new ApiError(409, "category_exists", "Category already exists.", {
        id: "Já existe uma categoria com esse identificador.",
      });
    }
    await assertValidParent(transaction, category.parentId, category.id);
    const { rows } = await transaction.query(
      `INSERT INTO categories (id,parent_id,name,icon,sort_order,active,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,now())
       RETURNING ${CATEGORY_RETURNING}`,
      [category.id, category.parentId, category.name, category.icon, category.sortOrder, category.active]
    );
    await recordAudit(transaction, request.user.id, "category.created", "category", category.id, rows[0]);
    return rows[0];
  });
  response.status(201).json(created);
}));

adminRouter.put("/categories/:id", asyncHandler(async (request, response) => {
  const categoryId = categoryIdSchema.parse(request.params.id);
  const update = categoryUpdateSchema.parse(request.body);
  const updated = await runInTransaction(async (transaction) => {
    const { rows: existing } = await transaction.query(
      `SELECT ${CATEGORY_RETURNING} FROM categories WHERE id=$1 FOR UPDATE`,
      [categoryId]
    );
    if (!existing[0]) throw new ApiError(404, "not_found", "Category not found.");
    await assertValidParent(transaction, update.parentId, categoryId);
    const { rows } = await transaction.query(
      `UPDATE categories SET parent_id=$2,name=$3,icon=$4,sort_order=$5,active=$6,updated_at=now()
       WHERE id=$1
       RETURNING ${CATEGORY_RETURNING}`,
      [categoryId, update.parentId, update.name, update.icon, update.sortOrder, update.active]
    );
    await recordAudit(transaction, request.user.id, "category.updated", "category", categoryId, {
      before: existing[0],
      after: rows[0],
    });
    return rows[0];
  });
  response.json(updated);
}));

adminRouter.delete("/categories/:id", asyncHandler(async (request, response) => {
  const categoryId = categoryIdSchema.parse(request.params.id);
  await runInTransaction(async (transaction) => {
    const { rows: existing } = await transaction.query(
      `SELECT ${CATEGORY_RETURNING} FROM categories WHERE id=$1 FOR UPDATE`,
      [categoryId]
    );
    if (!existing[0]) throw new ApiError(404, "not_found", "Category not found.");
    const { rows: usage } = await transaction.query(
      `SELECT (SELECT count(*)::int FROM services WHERE category_id=$1) AS services,
         (SELECT count(*)::int FROM categories WHERE parent_id=$1) AS children`,
      [categoryId]
    );
    // Serviços (mesmo inativos) e subcategorias apontam para a categoria
    const { services = 0, children = 0 } = usage[0] ?? {};
    if (services > 0 || children > 0) {
      throw new ApiError(409, "category_in_use", "Category is in use.", {
        services, children,
        hint: "Desative a categoria em vez de excluir: ela some do app e os serviços continuam valendo.",
      });
    }
    await transaction.query("DELETE FROM categories WHERE id=$1", [categoryId]);
    await recordAudit(transaction, request.user.id, "category.deleted", "category", categoryId, existing[0]);
  });
  response.status(204).end();
}));

adminRouter.get("/audit-events", asyncHandler(async (request, response) => {
  const filters = auditQuerySchema.parse(request.query);
  const { rows } = await runQuery(
    `SELECT id,admin_id AS "adminId",action,resource_type AS "resourceType",
       resource_id AS "resourceId",details,created_at AS "createdAt"
     FROM admin_audit_events ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [filters.limit, filters.offset]
  );
  response.json({ items: rows, limit: filters.limit, offset: filters.offset });
}));

module.exports = adminRouter;
