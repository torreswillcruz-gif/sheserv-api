const router = require("express").Router();
const { z } = require("zod");
const { query } = require("../db");
const { ApiError, wrap } = require("../errors");
const { encrypt, decrypt } = require("../security");
const { loadOwnedOrder } = require("./orders");

const TYPES = ["cpf_selfie", "gender_eligibility", "background_check", "proof_of_address", "references"];

router.get("/me/verifications", wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT id, type, provider, result, score::float, expires_at AS "expiresAt"
     FROM verifications WHERE user_id=$1 ORDER BY created_at DESC`, [req.user.id]);
  res.json(rows);
}));

router.post("/me/verifications", wrap(async (req, res) => {
  const { type } = z.object({ type: z.enum(TYPES) }).strict().parse(req.body);
  // TODO: integrar provedor de verificação e gerar URLs assinadas de upload
  const { rows } = await query(
    "INSERT INTO verifications (user_id,type) VALUES ($1,$2) RETURNING id, type, result",
    [req.user.id, type]);
  res.status(201).json({ ...rows[0], status: rows[0].result });
}));

const contactOut = (r) => ({ id: r.id, name: r.name, relationship: r.relationship, phone: decrypt(r.phone_encrypted), enabled: r.enabled });

router.get("/me/trusted-contacts", wrap(async (req, res) => {
  const { rows } = await query("SELECT * FROM trusted_contacts WHERE user_id=$1 ORDER BY name", [req.user.id]);
  res.json(rows.map(contactOut));
}));

router.post("/me/trusted-contacts", wrap(async (req, res) => {
  const b = z.object({
    name: z.string().trim().min(1).max(100),
    relationship: z.string().max(50).optional(),
    phone: z.string().regex(/^\+\d{10,15}$/),
  }).strict().parse(req.body);
  const { rows } = await query(
    "INSERT INTO trusted_contacts (user_id,name,relationship,phone_encrypted) VALUES ($1,$2,$3,$4) RETURNING *",
    [req.user.id, b.name, b.relationship ?? null, encrypt(b.phone)]);
  res.status(201).json(contactOut(rows[0]));
}));

router.patch("/me/trusted-contacts/:id", wrap(async (req, res) => {
  const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
  const { rows } = await query(
    "UPDATE trusted_contacts SET enabled=$1 WHERE id=$2::uuid AND user_id=$3 RETURNING *",
    [enabled, req.params.id, req.user.id]).catch(() => ({ rows: [] }));
  if (!rows[0]) throw new ApiError(404, "not_found", "Contact not found.");
  res.json(contactOut(rows[0]));
}));

router.post("/orders/:id/sos-alerts", wrap(async (req, res) => {
  const b = z.object({
    location: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).optional(),
    message: z.string().max(500).optional(),
  }).strict().parse(req.body);
  const o = await loadOwnedOrder(req.params.id, req.user.id);
  const { rows } = await query(
    `INSERT INTO sos_alerts (order_id,user_id,latitude,longitude,message) VALUES ($1,$2,$3,$4,$5)
     RETURNING id, status, created_at AS "createdAt"`,
    [o.id, req.user.id, b.location?.latitude ?? null, b.location?.longitude ?? null, b.message ?? null]);
  // TODO: notificar contatos de confiança habilitados e o backoffice (SMS/push/fila)
  console.warn(`SOS alert ${rows[0].id} order=${o.id}`);
  res.status(201).json(rows[0]);
}));

module.exports = router;
