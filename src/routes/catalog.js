const router = require("express").Router();
const { z } = require("zod");
const { query } = require("../db");
const { ApiError, wrap } = require("../errors");

router.get("/categories", wrap(async (req, res) => {
  const { parentId } = z.object({ parentId: z.string().optional() }).parse(req.query);
  const { rows } = parentId
    ? await query("SELECT id, parent_id AS \"parentId\", name FROM categories WHERE parent_id=$1 ORDER BY name", [parentId])
    : await query("SELECT id, parent_id AS \"parentId\", name FROM categories WHERE parent_id IS NULL ORDER BY name");
  res.json(rows);
}));

const SELECT = `
  SELECT u.id, u.name, p.bio, p.verified, p.activation_status AS "activationStatus",
    COALESCE(r.avg,0)::float AS rating, COALESCE(r.cnt,0)::int AS "reviewCount",
    COALESCE((SELECT json_agg(json_build_object('id',s.id,'categoryId',s.category_id,'title',s.title,
      'basePrice',s.base_price::float,'durationMinutes',s.duration_minutes))
      FROM services s WHERE s.provider_id=u.id AND s.active AND ($1::text IS NULL OR s.category_id=$1)), '[]') AS services
  FROM provider_profiles p
  JOIN users u ON u.id=p.user_id
  LEFT JOIN (SELECT target_id, avg(rating) avg, count(*) cnt FROM reviews WHERE direction='customer_to_provider' GROUP BY target_id) r
    ON r.target_id=u.id`;

router.get("/providers", wrap(async (req, res) => {
  const q = z.object({
    categoryId: z.string().optional(),
    query: z.string().max(100).optional(),
    availableAt: z.string().datetime({ offset: true }).optional(),
  }).passthrough().parse(req.query);

  // latitude/longitude/radiusKm: o ERD ainda não tem área de atendimento da prestadora
  const { rows } = await query(
    `${SELECT}
     WHERE p.activation_status='active'
       AND ($2::text IS NULL OR u.name ILIKE '%'||$2||'%' OR EXISTS
            (SELECT 1 FROM services s WHERE s.provider_id=u.id AND s.active AND s.title ILIKE '%'||$2||'%'))
       AND ($1::text IS NULL OR EXISTS (SELECT 1 FROM services s WHERE s.provider_id=u.id AND s.active AND s.category_id=$1))
       AND ($3::timestamptz IS NULL OR NOT EXISTS (SELECT 1 FROM orders o WHERE o.provider_id=u.id
            AND o.status IN ('requested','accepted','on_the_way','in_progress')
            AND $3 < o.scheduled_at + o.duration_minutes * interval '1 minute'
            AND $3 + interval '1 minute' > o.scheduled_at))
     ORDER BY rating DESC, u.name LIMIT 50`,
    [q.categoryId ?? null, q.query ?? null, q.availableAt ?? null]
  );
  res.json(rows);
}));

router.get("/providers/:id", wrap(async (req, res) => {
  const { rows } = await query(`${SELECT} WHERE u.id=$2`, [null, req.params.id]).catch(() => ({ rows: [] }));
  if (!rows[0]) throw new ApiError(404, "not_found", "Provider not found.");
  res.json(rows[0]);
}));

module.exports = router;
