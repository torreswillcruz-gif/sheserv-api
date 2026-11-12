const router = require("express").Router();
const { z } = require("zod");
const { query, tx } = require("../db");
const { ApiError, wrap } = require("../errors");

router.get("/me/dashboard", wrap(async (req, res) => {
  const id = req.user.id;
  const [profile, counts, earnings] = await Promise.all([
    query("SELECT available, activation_status AS \"activationStatus\", verified FROM provider_profiles WHERE user_id=$1", [id]),
    query("SELECT status, count(*)::int AS total FROM orders WHERE provider_id=$1 GROUP BY status", [id]),
    query("SELECT COALESCE(sum(amount),0)::float AS total FROM payouts WHERE provider_id=$1", [id]),
  ]);
  res.json({
    ...profile.rows[0],
    ordersByStatus: Object.fromEntries(counts.rows.map((r) => [r.status, r.total])),
    totalEarnings: earnings.rows[0].total,
  });
}));

router.get("/me/orders", wrap(async (req, res) => {
  const { status } = z.object({
    status: z.enum(["requested", "accepted", "on_the_way", "in_progress", "completed", "cancelled", "disputed"]).optional(),
  }).parse(req.query);
  const { rows } = await query(
    `SELECT id, status, service_id AS "serviceId", scheduled_at AS "scheduledAt", total_amount::float AS "totalAmount"
     FROM orders WHERE provider_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY scheduled_at DESC LIMIT 100`,
    [req.user.id, status ?? null]);
  res.json(rows);
}));

router.patch("/me/availability", wrap(async (req, res) => {
  const { available } = z.object({ available: z.boolean() }).strict().parse(req.body);
  await query("UPDATE provider_profiles SET available=$1 WHERE user_id=$2", [available, req.user.id]);
  res.json({ available });
}));

// ---------- perfil da prestadora ----------
const PROFILE_SQL = `
  SELECT u.id, u.name, p.bio, p.available, p.verified, p.activation_status AS "activationStatus"
  FROM provider_profiles p JOIN users u ON u.id=p.user_id WHERE p.user_id=$1`;

router.get("/me/profile", wrap(async (req, res) => {
  const { rows } = await query(PROFILE_SQL, [req.user.id]);
  if (!rows[0]) throw new ApiError(404, "not_found", "Provider profile not found.");
  res.json(rows[0]);
}));

// activation_status e verified pertencem ao servidor/backoffice: a prestadora não edita
const profileSchema = z.object({
  name: z.string().trim().min(2).max(120),
  bio: z.string().trim().max(500).nullable(),
  available: z.boolean(),
}).partial().strict();

router.patch("/me/profile", wrap(async (req, res) => {
  const b = profileSchema.parse(req.body);
  if (Object.keys(b).length === 0)
    throw new ApiError(422, "validation_error", "The request is invalid.", { body: "No fields to update." });

  await tx(async (c) => {
    const exists = (await c.query("SELECT 1 FROM provider_profiles WHERE user_id=$1 FOR UPDATE", [req.user.id])).rows[0];
    if (!exists) throw new ApiError(404, "not_found", "Provider profile not found.");

    if (b.name !== undefined) await c.query("UPDATE users SET name=$1 WHERE id=$2", [b.name, req.user.id]);

    const sets = [], vals = [req.user.id];
    if (b.bio !== undefined) { vals.push(b.bio === "" ? null : b.bio); sets.push(`bio=$${vals.length}`); }
    if (b.available !== undefined) { vals.push(b.available); sets.push(`available=$${vals.length}`); }
    if (sets.length) await c.query(`UPDATE provider_profiles SET ${sets.join(", ")} WHERE user_id=$1`, vals);
  });

  res.json((await query(PROFILE_SQL, [req.user.id])).rows[0]);
}));

// ---------- serviços da prestadora ----------
const MAX_SERVICES = 30;
const SERVICE_COLS = `id, category_id AS "categoryId", title, base_price::float AS "basePrice",
  duration_minutes AS "durationMinutes", active`;

const serviceSchema = z.object({
  categoryId: z.string().min(1).max(100),
  title: z.string().trim().min(3).max(120),
  basePrice: z.number().positive().max(100000).transform((n) => Math.round(n * 100) / 100),
  durationMinutes: z.number().int().min(15).max(720),
}).strict();

const SERVICE_FIELD_TO_COLUMN = {
  categoryId: "category_id", title: "title", basePrice: "base_price", durationMinutes: "duration_minutes",
};
const validId = (id) => /^[0-9a-f-]{36}$/i.test(id);

async function assertCategoryExists(id) {
  const { rows } = await query("SELECT 1 FROM categories WHERE id=$1", [id]);
  if (!rows[0]) throw new ApiError(422, "validation_error", "The request is invalid.", { categoryId: "Category not found." });
}

router.get("/me/services", wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT ${SERVICE_COLS} FROM services WHERE provider_id=$1 AND active ORDER BY title`, [req.user.id]);
  res.json(rows);
}));

router.post("/me/services", wrap(async (req, res) => {
  const b = serviceSchema.parse(req.body);
  await assertCategoryExists(b.categoryId);
  const n = (await query("SELECT count(*)::int AS n FROM services WHERE provider_id=$1 AND active", [req.user.id])).rows[0].n;
  if (n >= MAX_SERVICES) throw new ApiError(409, "limit_reached", `Maximum of ${MAX_SERVICES} services.`);

  // provider_id vem sempre do token
  const { rows } = await query(
    `INSERT INTO services (provider_id, category_id, title, base_price, duration_minutes)
     VALUES ($1,$2,$3,$4,$5) RETURNING ${SERVICE_COLS}`,
    [req.user.id, b.categoryId, b.title, b.basePrice, b.durationMinutes]);
  res.status(201).json(rows[0]);
}));

router.patch("/me/services/:id", wrap(async (req, res) => {
  if (!validId(req.params.id)) throw new ApiError(404, "not_found", "Service not found.");
  const b = serviceSchema.partial().parse(req.body);
  const entries = Object.entries(b);
  if (entries.length === 0) throw new ApiError(422, "validation_error", "The request is invalid.", { body: "No fields to update." });
  if (b.categoryId) await assertCategoryExists(b.categoryId);

  const sets = entries.map(([k], i) => `${SERVICE_FIELD_TO_COLUMN[k]}=$${i + 3}`);
  const { rows } = await query(
    `UPDATE services SET ${sets.join(", ")} WHERE id=$1 AND provider_id=$2 AND active RETURNING ${SERVICE_COLS}`,
    [req.params.id, req.user.id, ...entries.map(([, v]) => v)]);
  if (!rows[0]) throw new ApiError(404, "not_found", "Service not found.");
  res.json(rows[0]);
}));

router.delete("/me/services/:id", wrap(async (req, res) => {
  if (!validId(req.params.id)) throw new ApiError(404, "not_found", "Service not found.");
  const { rowCount } = await query(
    "UPDATE services SET active=false WHERE id=$1 AND provider_id=$2 AND active", [req.params.id, req.user.id]);
  if (!rowCount) throw new ApiError(404, "not_found", "Service not found.");
  res.sendStatus(204);
}));

module.exports = router;
