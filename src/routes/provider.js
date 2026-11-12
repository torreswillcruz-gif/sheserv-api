const router = require("express").Router();
const { z } = require("zod");
const { query } = require("../db");
const { wrap } = require("../errors");

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

module.exports = router;
