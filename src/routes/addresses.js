const router = require("express").Router();
const { z } = require("zod");
const { query } = require("../db");
const { ApiError, wrap } = require("../errors");

const MAX_ADDRESSES = 20;
const COLS = `id, label, street, number, complement, neighborhood, city, state,
  postal_code AS "postalCode", latitude, longitude`;

const createSchema = z.object({
  label: z.string().trim().max(50).optional(),
  street: z.string().trim().min(2).max(200),
  number: z.string().trim().max(20).optional(),
  complement: z.string().trim().max(100).optional(),
  neighborhood: z.string().trim().max(100).optional(),
  city: z.string().trim().min(2).max(100),
  state: z.string().trim().length(2).transform((s) => s.toUpperCase()).optional(),
  postalCode: z.string().regex(/^\d{5}-?\d{3}$/, "Use o formato 00000-000")
    .transform((s) => s.replace("-", "")).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
}).strict();

const FIELD_TO_COLUMN = {
  label: "label", street: "street", number: "number", complement: "complement",
  neighborhood: "neighborhood", city: "city", state: "state",
  postalCode: "postal_code", latitude: "latitude", longitude: "longitude",
};

const validId = (id) => /^[0-9a-f-]{36}$/i.test(id);

router.get("/me/addresses", wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT ${COLS} FROM addresses WHERE user_id=$1 AND deleted_at IS NULL ORDER BY label NULLS LAST, street`,
    [req.user.id]);
  res.json(rows);
}));

router.post("/me/addresses", wrap(async (req, res) => {
  const b = createSchema.parse(req.body);
  const count = (await query("SELECT count(*)::int AS n FROM addresses WHERE user_id=$1 AND deleted_at IS NULL", [req.user.id])).rows[0].n;
  if (count >= MAX_ADDRESSES) throw new ApiError(409, "limit_reached", `Maximum of ${MAX_ADDRESSES} addresses.`);

  const { rows } = await query(
    `INSERT INTO addresses (user_id,label,street,number,complement,neighborhood,city,state,postal_code,latitude,longitude)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${COLS}`,
    [req.user.id, b.label ?? null, b.street, b.number ?? null, b.complement ?? null, b.neighborhood ?? null,
     b.city, b.state ?? null, b.postalCode ?? null, b.latitude ?? null, b.longitude ?? null]);
  res.status(201).json(rows[0]);
}));

router.get("/me/addresses/:id", wrap(async (req, res) => {
  if (!validId(req.params.id)) throw new ApiError(404, "not_found", "Address not found.");
  const { rows } = await query(
    `SELECT ${COLS} FROM addresses WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, [req.params.id, req.user.id]);
  if (!rows[0]) throw new ApiError(404, "not_found", "Address not found.");
  res.json(rows[0]);
}));

router.patch("/me/addresses/:id", wrap(async (req, res) => {
  if (!validId(req.params.id)) throw new ApiError(404, "not_found", "Address not found.");
  const b = createSchema.partial().parse(req.body);
  const entries = Object.entries(b);
  if (entries.length === 0) throw new ApiError(422, "validation_error", "The request is invalid.", { body: "No fields to update." });

  const sets = entries.map(([k], i) => `${FIELD_TO_COLUMN[k]}=$${i + 3}`);
  const { rows } = await query(
    `UPDATE addresses SET ${sets.join(", ")} WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL RETURNING ${COLS}`,
    [req.params.id, req.user.id, ...entries.map(([, v]) => v)]);
  if (!rows[0]) throw new ApiError(404, "not_found", "Address not found.");
  res.json(rows[0]);
}));

// exclusão lógica: pedidos antigos continuam apontando para o endereço
router.delete("/me/addresses/:id", wrap(async (req, res) => {
  if (!validId(req.params.id)) throw new ApiError(404, "not_found", "Address not found.");
  const { rowCount } = await query(
    "UPDATE addresses SET deleted_at=now() WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL",
    [req.params.id, req.user.id]);
  if (!rowCount) throw new ApiError(404, "not_found", "Address not found.");
  res.sendStatus(204);
}));

module.exports = router;
