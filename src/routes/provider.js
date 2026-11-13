const providerRouter = require("express").Router();
const { z } = require("zod");
const { runQuery, runInTransaction } = require("../db");
const { ApiError, asyncHandler } = require("../errors");
const { isValidUuid } = require("../validation");

const ORDER_STATUSES = ["requested", "accepted", "on_the_way", "in_progress", "completed", "cancelled", "disputed"];

// ---------- Painel ----------

providerRouter.get("/me/dashboard", asyncHandler(async (request, response) => {
  const providerId = request.user.id;
  const [profileResult, orderCountsResult, earningsResult] = await Promise.all([
    runQuery(
      'SELECT available, activation_status AS "activationStatus", verified FROM provider_profiles WHERE user_id=$1',
      [providerId]
    ),
    runQuery("SELECT status, count(*)::int AS total FROM orders WHERE provider_id=$1 GROUP BY status", [providerId]),
    runQuery("SELECT COALESCE(sum(amount),0)::float AS total FROM payouts WHERE provider_id=$1", [providerId]),
  ]);

  response.json({
    ...profileResult.rows[0],
    ordersByStatus: Object.fromEntries(orderCountsResult.rows.map((countRow) => [countRow.status, countRow.total])),
    totalEarnings: earningsResult.rows[0].total,
  });
}));

// ---------- Pedidos da prestadora ----------

// location (coordenadas do endereço do cliente) só aparece em serviços "at_customer" e depois que o pedido é aceito
providerRouter.get("/me/orders", asyncHandler(async (request, response) => {
  const { status: statusFilter } = z.object({ status: z.enum(ORDER_STATUSES).optional() }).parse(request.query);

  const { rows: providerOrders } = await runQuery(
    `SELECT
       orders.id,
       orders.friendly_id AS "friendlyId",
       orders.status,
       orders.service_id AS "serviceId",
       orders.scheduled_at AS "scheduledAt",
       orders.total_amount::float AS "totalAmount",
       orders.service_location AS "serviceLocation",
       customer_user.name AS "customerName",
       CASE WHEN orders.service_location = 'at_customer' AND orders.status NOT IN ('requested', 'cancelled')
         THEN json_build_object('latitude', order_address.latitude, 'longitude', order_address.longitude)
       END AS location
     FROM orders
     JOIN users customer_user ON customer_user.id = orders.customer_id
     LEFT JOIN addresses order_address ON order_address.id = orders.address_id
     WHERE orders.provider_id = $1 AND ($2::text IS NULL OR orders.status = $2::text)
     ORDER BY orders.scheduled_at DESC
     LIMIT 100`,
    [request.user.id, statusFilter ?? null]
  );
  response.json(providerOrders);
}));

// ---------- Disponibilidade ----------

providerRouter.patch("/me/availability", asyncHandler(async (request, response) => {
  const { available } = z.object({ available: z.boolean() }).strict().parse(request.body);
  await runQuery("UPDATE provider_profiles SET available=$1 WHERE user_id=$2", [available, request.user.id]);
  response.json({ available });
}));

// ---------- Perfil da prestadora ----------

const PROFILE_SQL = `
  SELECT
    provider_user.id,
    provider_user.name,
    provider_profile.bio,
    provider_profile.available,
    provider_profile.verified,
    provider_profile.activation_status AS "activationStatus",
    provider_profile.latitude,
    provider_profile.longitude
  FROM provider_profiles provider_profile
  JOIN users provider_user ON provider_user.id = provider_profile.user_id
  WHERE provider_profile.user_id = $1`;

providerRouter.get("/me/profile", asyncHandler(async (request, response) => {
  const { rows: profiles } = await runQuery(PROFILE_SQL, [request.user.id]);
  if (!profiles[0]) throw new ApiError(404, "not_found", "Provider profile not found.");
  response.json(profiles[0]);
}));

// activation_status e verified pertencem ao servidor/backoffice: a prestadora não edita.
// latitude/longitude = base de atendimento, usada só para calcular a distância no catálogo.
const updateProfileSchema = z.object({
  name: z.string().trim().min(2).max(120),
  bio: z.string().trim().max(500).nullable(),
  available: z.boolean(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
}).partial().strict().refine(
  (profileChanges) => (profileChanges.latitude === undefined) === (profileChanges.longitude === undefined),
  { message: "Send latitude and longitude together.", path: ["longitude"] }
);

providerRouter.patch("/me/profile", asyncHandler(async (request, response) => {
  const profileChanges = updateProfileSchema.parse(request.body);
  if (Object.keys(profileChanges).length === 0)
    throw new ApiError(422, "validation_error", "The request is invalid.", { body: "No fields to update." });

  await runInTransaction(async (transactionClient) => {
    const { rows: existingProfiles } = await transactionClient.query(
      "SELECT 1 FROM provider_profiles WHERE user_id=$1 FOR UPDATE",
      [request.user.id]
    );
    if (!existingProfiles[0]) throw new ApiError(404, "not_found", "Provider profile not found.");

    // o nome fica na tabela users; o restante em provider_profiles
    if (profileChanges.name !== undefined) {
      await transactionClient.query("UPDATE users SET name=$1 WHERE id=$2", [profileChanges.name, request.user.id]);
    }

    const columnAssignments = [];
    const queryValues = [request.user.id]; // $1 = dono do perfil
    const addAssignment = (columnName, columnValue) => {
      queryValues.push(columnValue);
      columnAssignments.push(`${columnName}=$${queryValues.length}`);
    };

    if (profileChanges.bio !== undefined) addAssignment("bio", profileChanges.bio === "" ? null : profileChanges.bio);
    if (profileChanges.available !== undefined) addAssignment("available", profileChanges.available);
    if (profileChanges.latitude !== undefined) {
      addAssignment("latitude", profileChanges.latitude);
      addAssignment("longitude", profileChanges.longitude);
    }

    if (columnAssignments.length > 0) {
      await transactionClient.query(
        `UPDATE provider_profiles SET ${columnAssignments.join(", ")} WHERE user_id=$1`,
        queryValues
      );
    }
  });

  const { rows: updatedProfiles } = await runQuery(PROFILE_SQL, [request.user.id]);
  response.json(updatedProfiles[0]);
}));

// ---------- Local de atendimento (usado nos serviços "at_provider") ----------

const VENUE_COLUMNS = `street, number, complement, neighborhood, city, state,
  postal_code AS "postalCode", latitude, longitude`;

// PUT substitui o local inteiro: campos opcionais omitidos ficam vazios
const venueSchema = z.object({
  street: z.string().trim().min(2).max(200),
  number: z.string().trim().max(20).optional(),
  complement: z.string().trim().max(100).optional(),
  neighborhood: z.string().trim().min(2).max(100),
  city: z.string().trim().min(2).max(100),
  state: z.string().trim().length(2).transform((stateCode) => stateCode.toUpperCase()).optional(),
  postalCode: z.string().regex(/^\d{5}-?\d{3}$/, "Use o formato 00000-000")
    .transform((postalCode) => postalCode.replace("-", "")).optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
}).strict();

providerRouter.get("/me/venue", asyncHandler(async (request, response) => {
  const { rows: venues } = await runQuery(
    `SELECT ${VENUE_COLUMNS} FROM provider_venues WHERE provider_id=$1`,
    [request.user.id]
  );
  if (!venues[0]) throw new ApiError(404, "not_found", "Service location not registered.");
  response.json(venues[0]);
}));

providerRouter.put("/me/venue", asyncHandler(async (request, response) => {
  const venueData = venueSchema.parse(request.body);

  // provider_id vem sempre do token; se já existe um local, ele é substituído
  const { rows: savedVenues } = await runQuery(
    `INSERT INTO provider_venues (provider_id, street, number, complement, neighborhood, city, state, postal_code, latitude, longitude)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (provider_id) DO UPDATE SET
       street=EXCLUDED.street, number=EXCLUDED.number, complement=EXCLUDED.complement,
       neighborhood=EXCLUDED.neighborhood, city=EXCLUDED.city, state=EXCLUDED.state,
       postal_code=EXCLUDED.postal_code, latitude=EXCLUDED.latitude, longitude=EXCLUDED.longitude,
       updated_at=now()
     RETURNING ${VENUE_COLUMNS}`,
    [request.user.id, venueData.street, venueData.number ?? null, venueData.complement ?? null,
     venueData.neighborhood, venueData.city, venueData.state ?? null, venueData.postalCode ?? null,
     venueData.latitude, venueData.longitude]
  );
  response.json(savedVenues[0]);
}));

providerRouter.delete("/me/venue", asyncHandler(async (request, response) => {
  const { rows: servicesUsingVenue } = await runQuery(
    "SELECT 1 FROM services WHERE provider_id=$1 AND active AND service_location='at_provider' LIMIT 1",
    [request.user.id]
  );
  if (servicesUsingVenue[0]) {
    throw new ApiError(409, "conflict", "Service location is in use.", {
      venue: "Deactivate or change your services at your own location first.",
    });
  }
  const { rowCount: removedCount } = await runQuery("DELETE FROM provider_venues WHERE provider_id=$1", [request.user.id]);
  if (!removedCount) throw new ApiError(404, "not_found", "Service location not registered.");
  response.sendStatus(204);
}));

// ---------- Serviços da prestadora ----------

const MAX_SERVICES_PER_PROVIDER = 30;

const SERVICE_COLUMNS = `id, category_id AS "categoryId",
  (SELECT name FROM categories WHERE categories.id = services.category_id) AS "categoryName", title, base_price::float AS "basePrice",
  duration_minutes AS "durationMinutes", service_location AS "serviceLocation", active`;

const serviceSchema = z.object({
  categoryId: z.string().min(1).max(100),
  title: z.string().trim().min(3).max(120),
  basePrice: z.number().positive().max(100000).transform((price) => Math.round(price * 100) / 100),
  durationMinutes: z.number().int().min(15).max(720),
  // "at_customer": a prestadora vai até o cliente. "at_provider": o cliente vai até a prestadora.
  serviceLocation: z.enum(["at_customer", "at_provider"]).default("at_customer"),
}).strict();

// campo enviado pelo app -> coluna do banco
const SERVICE_FIELD_TO_COLUMN = {
  categoryId: "category_id",
  title: "title",
  basePrice: "base_price",
  durationMinutes: "duration_minutes",
  serviceLocation: "service_location",
};

async function assertCategoryExists(categoryId) {
  const { rows: matchingCategories } = await runQuery("SELECT 1 FROM categories WHERE id=$1", [categoryId]);
  if (!matchingCategories[0])
    throw new ApiError(422, "validation_error", "The request is invalid.", { categoryId: "Category not found." });
}

// Serviço "at_provider" só pode existir se a prestadora já cadastrou o local de atendimento
async function assertProviderHasVenue(providerId) {
  const { rows: venues } = await runQuery("SELECT 1 FROM provider_venues WHERE provider_id=$1", [providerId]);
  if (!venues[0]) {
    throw new ApiError(422, "validation_error", "The request is invalid.", {
      serviceLocation: "Register your service location first (PUT /provider/me/venue).",
    });
  }
}

providerRouter.get("/me/services", asyncHandler(async (request, response) => {
  const { rows: services } = await runQuery(
    `SELECT ${SERVICE_COLUMNS} FROM services WHERE provider_id=$1 AND active ORDER BY title`,
    [request.user.id]
  );
  response.json(services);
}));

providerRouter.post("/me/services", asyncHandler(async (request, response) => {
  const serviceData = serviceSchema.parse(request.body);
  await assertCategoryExists(serviceData.categoryId);
  if (serviceData.serviceLocation === "at_provider") await assertProviderHasVenue(request.user.id);

  const { rows: countRows } = await runQuery(
    "SELECT count(*)::int AS total FROM services WHERE provider_id=$1 AND active",
    [request.user.id]
  );
  if (countRows[0].total >= MAX_SERVICES_PER_PROVIDER)
    throw new ApiError(409, "limit_reached", `Maximum of ${MAX_SERVICES_PER_PROVIDER} services.`);

  // provider_id vem sempre do token
  const { rows: createdServices } = await runQuery(
    `INSERT INTO services (provider_id, category_id, title, base_price, duration_minutes, service_location)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${SERVICE_COLUMNS}`,
    [request.user.id, serviceData.categoryId, serviceData.title, serviceData.basePrice,
     serviceData.durationMinutes, serviceData.serviceLocation]
  );
  response.status(201).json(createdServices[0]);
}));

providerRouter.patch("/me/services/:id", asyncHandler(async (request, response) => {
  if (!isValidUuid(request.params.id)) throw new ApiError(404, "not_found", "Service not found.");

  const serviceChanges = serviceSchema.partial().parse(request.body);
  const changedFields = Object.entries(serviceChanges);
  if (changedFields.length === 0)
    throw new ApiError(422, "validation_error", "The request is invalid.", { body: "No fields to update." });
  if (serviceChanges.categoryId) await assertCategoryExists(serviceChanges.categoryId);
  if (serviceChanges.serviceLocation === "at_provider") await assertProviderHasVenue(request.user.id);

  // $1 = id do serviço, $2 = prestadora dona; os campos alterados começam no $3
  const columnAssignments = changedFields.map(([fieldName], position) => `${SERVICE_FIELD_TO_COLUMN[fieldName]}=$${position + 3}`);
  const { rows: updatedServices } = await runQuery(
    `UPDATE services SET ${columnAssignments.join(", ")} WHERE id=$1 AND provider_id=$2 AND active RETURNING ${SERVICE_COLUMNS}`,
    [request.params.id, request.user.id, ...changedFields.map(([, fieldValue]) => fieldValue)]
  );
  if (!updatedServices[0]) throw new ApiError(404, "not_found", "Service not found.");
  response.json(updatedServices[0]);
}));

// exclusão lógica: pedidos antigos continuam apontando para o serviço
providerRouter.delete("/me/services/:id", asyncHandler(async (request, response) => {
  if (!isValidUuid(request.params.id)) throw new ApiError(404, "not_found", "Service not found.");

  const { rowCount: deactivatedCount } = await runQuery(
    "UPDATE services SET active=false WHERE id=$1 AND provider_id=$2 AND active",
    [request.params.id, request.user.id]
  );
  if (!deactivatedCount) throw new ApiError(404, "not_found", "Service not found.");
  response.sendStatus(204);
}));

module.exports = providerRouter;
