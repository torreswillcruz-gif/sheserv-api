const router = require("express").Router();
const crypto = require("crypto");
const { z } = require("zod");
const { query, tx } = require("../db");
const { ApiError, wrap } = require("../errors");
const { requireRole } = require("../security");

const COMMISSION_RATE = Number(process.env.COMMISSION_RATE || 0.12);
const round2 = (n) => Math.round(n * 100) / 100;

const ORDER_SQL = `
  SELECT o.id, o.status, o.service_id AS "serviceId", o.provider_id AS "providerId",
    o.customer_id AS "customerId", o.scheduled_at AS "scheduledAt",
    o.total_amount::float AS "totalAmount", o.commission::float AS commission,
    CASE WHEN o.customer_id=$2 THEN o.checkin_code END AS "checkinCode",
    json_build_object('id',p.id,'status',p.status,'method',p.method,'heldUntil',p.held_until) AS payment
  FROM orders o LEFT JOIN payments p ON p.order_id=o.id`;

async function loadOwnedOrder(id, userId, c = { query }) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError(404, "not_found", "Order not found.");
  const { rows } = await c.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [id]);
  const o = rows[0];
  if (!o || (o.customer_id !== userId && o.provider_id !== userId))
    throw new ApiError(404, "not_found", "Order not found.");
  return o;
}

const createSchema = z.object({
  serviceId: z.string().uuid(),
  addressId: z.string().uuid(),
  scheduledAt: z.string().datetime({ offset: true }),
  paymentMethod: z.discriminatedUnion("type", [
    z.object({ type: z.literal("pix") }),
    z.object({ type: z.literal("card"), paymentMethodToken: z.string().min(8) }),
  ]),
}).strict();

router.post("/orders", requireRole("cliente"), wrap(async (req, res) => {
  const b = createSchema.parse(req.body);
  const when = new Date(b.scheduledAt);
  if (when <= new Date()) throw new ApiError(422, "validation_error", "Invalid.", { scheduledAt: "Must be in the future." });

  const order = await tx(async (c) => {
    const s = (await c.query(
      `SELECT s.*, p.activation_status FROM services s JOIN provider_profiles p ON p.user_id=s.provider_id WHERE s.id=$1`,
      [b.serviceId])).rows[0];
    if (!s || s.activation_status !== "active") throw new ApiError(404, "not_found", "Service not available.");

    const addr = (await c.query("SELECT 1 FROM addresses WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL", [b.addressId, req.user.id])).rows[0];
    if (!addr) throw new ApiError(404, "not_found", "Address not found.");

    const end = new Date(when.getTime() + s.duration_minutes * 60000);
    const clash = (await c.query(
      `SELECT 1 FROM orders WHERE provider_id=$1 AND status IN ('requested','accepted','on_the_way','in_progress')
       AND $2 < scheduled_at + duration_minutes * interval '1 minute' AND $3 > scheduled_at`,
      [s.provider_id, when, end])).rows[0];
    if (clash) throw new ApiError(409, "conflict", "Slot unavailable.", { scheduledAt: "The selected time is no longer available." });

    const base = Number(s.base_price);
    const commission = round2(base * COMMISSION_RATE);
    const total = round2(base + commission);
    const code = String(crypto.randomInt(0, 10000)).padStart(4, "0");

    const o = (await c.query(
      `INSERT INTO orders (customer_id,provider_id,service_id,address_id,scheduled_at,duration_minutes,total_amount,commission,checkin_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [req.user.id, s.provider_id, s.id, b.addressId, when, s.duration_minutes, total, commission, code])).rows[0];

    // TODO: autorizar/reter o pagamento no gateway (Pix/cartão) antes de gravar como "held"
    await c.query(
      "INSERT INTO payments (order_id,status,method,method_token,held_until) VALUES ($1,'held',$2,$3,$4)",
      [o.id, b.paymentMethod.type, b.paymentMethod.paymentMethodToken ?? null, end]);
    await c.query("INSERT INTO order_events (order_id,actor_id,type) VALUES ($1,$2,'requested')", [o.id, req.user.id]);
    return o;
  });

  const { rows } = await query(`${ORDER_SQL} WHERE o.id=$1`, [order.id, req.user.id]);
  res.status(201).json(rows[0]);
}));

router.get("/me/orders", wrap(async (req, res) => {
  const { rows } = await query(
    `${ORDER_SQL} WHERE o.customer_id=$1 OR o.provider_id=$1 ORDER BY o.scheduled_at DESC LIMIT 100`,
    [req.user.id, req.user.id]);
  res.json(rows);
}));

router.get("/orders/:id", wrap(async (req, res) => {
  await loadOwnedOrder(req.params.id, req.user.id);
  const { rows } = await query(`${ORDER_SQL} WHERE o.id=$1`, [req.params.id, req.user.id]);
  res.json(rows[0]);
}));

// estado atual -> { próximo estado: quem pode fazer }
const TRANSITIONS = {
  requested: { accepted: "provider", cancelled: "any" },
  accepted: { on_the_way: "provider", cancelled: "any" },
  on_the_way: { in_progress: "provider", cancelled: "any" },
  in_progress: { completed: "provider", disputed: "any" },
  completed: { disputed: "any" },
};

async function applyTransition(c, order, next, actorId, role) {
  const rule = TRANSITIONS[order.status]?.[next];
  if (!rule || (rule !== "any" && rule !== role))
    throw new ApiError(409, "invalid_transition", `Cannot change from ${order.status} to ${next}.`);

  await c.query("UPDATE orders SET status=$1 WHERE id=$2", [next, order.id]);
  await c.query("INSERT INTO order_events (order_id,actor_id,type,data) VALUES ($1,$2,'status_changed',$3)",
    [order.id, actorId, { from: order.status, to: next }]);

  if (next === "completed") {
    await c.query("UPDATE payments SET status='captured' WHERE order_id=$1", [order.id]);
    await c.query("INSERT INTO payouts (order_id,provider_id,amount) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
      [order.id, order.provider_id, round2(Number(order.total_amount) - Number(order.commission))]);
  }
  if (next === "cancelled") await c.query("UPDATE payments SET status='released' WHERE order_id=$1 AND status='held'", [order.id]);
}

router.patch("/orders/:id/status", wrap(async (req, res) => {
  const { status } = z.object({
    status: z.enum(["accepted", "on_the_way", "in_progress", "completed", "cancelled", "disputed"]),
  }).strict().parse(req.body);

  await tx(async (c) => {
    const o = await loadOwnedOrder(req.params.id, req.user.id, c);
    await applyTransition(c, o, status, req.user.id, o.provider_id === req.user.id ? "provider" : "customer");
  });
  const { rows } = await query(`${ORDER_SQL} WHERE o.id=$1`, [req.params.id, req.user.id]);
  res.json(rows[0]);
}));

router.post("/orders/:id/check-ins", requireRole("prestadora"), wrap(async (req, res) => {
  const b = z.object({
    type: z.enum(["entry", "exit"]),
    code: z.string().regex(/^\d{4}$/),
    location: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).optional(),
  }).parse(req.body);

  await tx(async (c) => {
    const o = await loadOwnedOrder(req.params.id, req.user.id, c);
    if (o.provider_id !== req.user.id) throw new ApiError(403, "forbidden", "Not your order.");
    if (o.checkin_code !== b.code) throw new ApiError(422, "validation_error", "Invalid.", { code: "Invalid or expired code." });

    await applyTransition(c, o, b.type === "entry" ? "in_progress" : "completed", req.user.id, "provider");
    await c.query("INSERT INTO check_ins (order_id,user_id,type,latitude,longitude) VALUES ($1,$2,$3,$4,$5)",
      [o.id, req.user.id, b.type, b.location?.latitude ?? null, b.location?.longitude ?? null]);
    await c.query("INSERT INTO order_events (order_id,actor_id,type,data) VALUES ($1,$2,'check_in',$3)",
      [o.id, req.user.id, { type: b.type }]);
  });
  res.status(201).json({ ok: true });
}));

module.exports = { router, loadOwnedOrder };
