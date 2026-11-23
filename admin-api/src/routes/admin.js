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
       provider_profile.verified AS "identityVerified"
     FROM provider_profiles provider_profile
     JOIN users provider_user ON provider_user.id=provider_profile.user_id
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
    const { rows: updatedProviders } = await transaction.query(
      `UPDATE provider_profiles
       SET activation_status=$1,available=CASE WHEN $1='rejected' THEN false ELSE available END
       WHERE user_id=$2
       RETURNING user_id AS id,activation_status AS "activationStatus",verified AS "identityVerified"`,
      [change.status, request.params.id]
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
