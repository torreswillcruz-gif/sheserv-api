const notificationsRouter = require("express").Router();
const { z } = require("zod");
const { runQuery } = require("../db");
const { ApiError, asyncHandler } = require("../errors");
const { NOTIFICATION_AREAS } = require("../notifications");
const { isValidUuid } = require("../validation");

// Notificações de qualquer conta autenticada (cliente ou prestadora).
// Antes ficavam no erpRouter, que exige o papel de prestadora.

// ?since=<ISO> devolve só as mais novas que o instante (o app consulta de tempos
// em tempos); ?area=customer|provider filtra pela área (avisos sem área aparecem
// nas duas).
const notificationQuerySchema = z.object({
  since: z.string().datetime({ offset: true }).optional(),
  area: z.enum(NOTIFICATION_AREAS).optional(),
}).passthrough();

notificationsRouter.get("/me/notifications", asyncHandler(async (request, response) => {
  const { since, area } = notificationQuerySchema.parse(request.query);
  const { rows } = await runQuery(
    `SELECT id,type,title,body,read,data,area,created_at AS "createdAt"
     FROM notifications
     WHERE user_id=$1
       AND ($2::timestamptz IS NULL OR created_at > $2)
       AND ($3::text IS NULL OR area IS NULL OR area = $3)
     ORDER BY created_at DESC LIMIT 100`,
    [request.user.id, since ?? null, area ?? null]
  );
  response.json(rows);
}));

// Marca todas como lidas (opcionalmente só as de uma área)
notificationsRouter.post("/me/notifications/read-all", asyncHandler(async (request, response) => {
  const { area } = z.object({ area: z.enum(NOTIFICATION_AREAS).optional() }).strict().parse(request.body ?? {});
  const { rowCount } = await runQuery(
    `UPDATE notifications SET read=true
     WHERE user_id=$1 AND read=false AND ($2::text IS NULL OR area IS NULL OR area = $2)`,
    [request.user.id, area ?? null]
  );
  response.json({ updated: rowCount ?? 0 });
}));

notificationsRouter.patch("/me/notifications/:id/read", asyncHandler(async (request, response) => {
  if (!isValidUuid(request.params.id)) throw new ApiError(404, "not_found", "Notification not found.");
  const { rows } = await runQuery(
    "UPDATE notifications SET read=true WHERE id=$1 AND user_id=$2 RETURNING id,read",
    [request.params.id, request.user.id]
  );
  if (!rows[0]) throw new ApiError(404, "not_found", "Notification not found.");
  response.json(rows[0]);
}));

// ---------- Aparelhos para push (Firebase Cloud Messaging) ----------

const deviceSchema = z.object({
  token: z.string().trim().min(20).max(4096),
  platform: z.enum(["android", "ios", "web"]).default("android"),
}).strict();

// O app registra o token do aparelho ao entrar. O mesmo aparelho usado por
// outra conta passa a ser dessa conta (o token é único).
notificationsRouter.post("/me/devices", asyncHandler(async (request, response) => {
  const device = deviceSchema.parse(request.body);
  await runQuery(
    `INSERT INTO device_tokens (token,user_id,platform) VALUES ($1,$2,$3)
     ON CONFLICT (token) DO UPDATE SET user_id=EXCLUDED.user_id, platform=EXCLUDED.platform, updated_at=now()`,
    [device.token, request.user.id, device.platform]
  );
  response.status(204).end();
}));

// Ao sair da conta, o app remove o token para o aparelho não receber mais avisos dela.
// POST (e não DELETE com corpo) para o token não ir na URL, que aparece em logs.
notificationsRouter.post("/me/devices/unregister", asyncHandler(async (request, response) => {
  const { token } = z.object({ token: z.string().trim().min(1).max(4096) }).strict().parse(request.body ?? {});
  await runQuery("DELETE FROM device_tokens WHERE token=$1 AND user_id=$2", [token, request.user.id]);
  response.status(204).end();
}));

module.exports = { notificationsRouter };
