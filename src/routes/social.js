const router = require("express").Router();
const { z } = require("zod");
const { query } = require("../db");
const { ApiError, wrap } = require("../errors");
const { loadOwnedOrder } = require("./orders");

const maskPhones = (t) => t.replace(/\+?\d[\d\s().-]{7,}\d/g, "[telefone oculto]");
const other = (o, uid) => (o.customer_id === uid ? o.provider_id : o.customer_id);

router.get("/orders/:id/messages", wrap(async (req, res) => {
  const o = await loadOwnedOrder(req.params.id, req.user.id);
  const { rows } = await query(
    `SELECT id, author_id AS "authorId", text, created_at AS "createdAt" FROM messages WHERE order_id=$1 ORDER BY created_at`, [o.id]);
  res.json(rows);
}));

router.post("/orders/:id/messages", wrap(async (req, res) => {
  const { text } = z.object({ text: z.string().trim().min(1).max(1000) }).strict().parse(req.body);
  const o = await loadOwnedOrder(req.params.id, req.user.id);
  const { rows } = await query(
    `INSERT INTO messages (order_id,author_id,text) VALUES ($1,$2,$3)
     RETURNING id, author_id AS "authorId", text, created_at AS "createdAt"`,
    [o.id, req.user.id, maskPhones(text)]);
  res.status(201).json(rows[0]);
}));

router.post("/orders/:id/reports", wrap(async (req, res) => {
  const b = z.object({
    reportedUserId: z.string().uuid(),
    reason: z.string().min(2).max(60),
    description: z.string().max(2000).optional(),
  }).strict().parse(req.body);
  const o = await loadOwnedOrder(req.params.id, req.user.id);
  if (b.reportedUserId !== other(o, req.user.id))
    throw new ApiError(422, "validation_error", "Invalid.", { reportedUserId: "Not related to this order." });
  const { rows } = await query(
    "INSERT INTO reports (order_id,reporter_id,reported_user_id,reason,description) VALUES ($1,$2,$3,$4,$5) RETURNING id, status",
    [o.id, req.user.id, b.reportedUserId, b.reason, b.description ?? null]);
  res.status(201).json(rows[0]);
}));

router.post("/orders/:id/reviews", wrap(async (req, res) => {
  const b = z.object({
    rating: z.number().int().min(1).max(5),
    tags: z.array(z.string().max(40)).max(10).optional(),
    comment: z.string().max(1000).optional(),
    tipAmount: z.number().min(0).max(1000).optional(),
  }).strict().parse(req.body);
  const o = await loadOwnedOrder(req.params.id, req.user.id);
  if (o.status !== "completed") throw new ApiError(409, "invalid_state", "Order is not completed.");
  const direction = o.customer_id === req.user.id ? "customer_to_provider" : "provider_to_customer";
  try {
    const { rows } = await query(
      `INSERT INTO reviews (order_id,author_id,target_id,direction,rating,tags,comment,tip_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, rating, tags, comment`,
      [o.id, req.user.id, other(o, req.user.id), direction, b.rating, b.tags ?? [], b.comment ?? null,
       direction === "customer_to_provider" ? b.tipAmount ?? null : null]);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === "23505") throw new ApiError(409, "conflict", "You already reviewed this order.");
    throw e;
  }
}));

module.exports = router;
