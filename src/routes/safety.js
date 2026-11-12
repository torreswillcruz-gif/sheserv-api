const safetyRouter = require("express").Router();
const { z } = require("zod");
const { runQuery } = require("../db");
const { ApiError, asyncHandler } = require("../errors");
const { encryptText, decryptText } = require("../security");
const { loadOrderForParticipant } = require("./orders");
const { isValidUuid } = require("../validation");

const VERIFICATION_TYPES = ["cpf_selfie", "gender_eligibility", "background_check", "proof_of_address", "references"];

const locationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

// ---------- Verificação de identidade ----------

safetyRouter.get("/me/verifications", asyncHandler(async (request, response) => {
  const { rows: verifications } = await runQuery(
    `SELECT id, type, provider, result, score::float, expires_at AS "expiresAt"
     FROM verifications WHERE user_id=$1 ORDER BY created_at DESC`,
    [request.user.id]
  );
  response.json(verifications);
}));

safetyRouter.post("/me/verifications", asyncHandler(async (request, response) => {
  const { type: verificationType } = z.object({ type: z.enum(VERIFICATION_TYPES) }).strict().parse(request.body);

  // TODO: integrar provedor de verificação e gerar URLs assinadas de upload
  const { rows: createdVerifications } = await runQuery(
    "INSERT INTO verifications (user_id,type) VALUES ($1,$2) RETURNING id, type, result",
    [request.user.id, verificationType]
  );
  response.status(201).json({ ...createdVerifications[0], status: createdVerifications[0].result });
}));

// ---------- Contatos de confiança (telefone criptografado no banco) ----------

const formatTrustedContact = (contactRow) => ({
  id: contactRow.id,
  name: contactRow.name,
  relationship: contactRow.relationship,
  phone: decryptText(contactRow.phone_encrypted),
  enabled: contactRow.enabled,
});

safetyRouter.get("/me/trusted-contacts", asyncHandler(async (request, response) => {
  const { rows: contacts } = await runQuery("SELECT * FROM trusted_contacts WHERE user_id=$1 ORDER BY name", [request.user.id]);
  response.json(contacts.map(formatTrustedContact));
}));

const createTrustedContactSchema = z.object({
  name: z.string().trim().min(1).max(100),
  relationship: z.string().max(50).optional(),
  phone: z.string().regex(/^\+\d{10,15}$/),
}).strict();

safetyRouter.post("/me/trusted-contacts", asyncHandler(async (request, response) => {
  const contactData = createTrustedContactSchema.parse(request.body);

  const { rows: createdContacts } = await runQuery(
    "INSERT INTO trusted_contacts (user_id,name,relationship,phone_encrypted) VALUES ($1,$2,$3,$4) RETURNING *",
    [request.user.id, contactData.name, contactData.relationship ?? null, encryptText(contactData.phone)]
  );
  response.status(201).json(formatTrustedContact(createdContacts[0]));
}));

safetyRouter.patch("/me/trusted-contacts/:id", asyncHandler(async (request, response) => {
  if (!isValidUuid(request.params.id)) throw new ApiError(404, "not_found", "Contact not found.");
  const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(request.body);

  const { rows: updatedContacts } = await runQuery(
    "UPDATE trusted_contacts SET enabled=$1 WHERE id=$2 AND user_id=$3 RETURNING *",
    [enabled, request.params.id, request.user.id]
  );
  if (!updatedContacts[0]) throw new ApiError(404, "not_found", "Contact not found.");
  response.json(formatTrustedContact(updatedContacts[0]));
}));

// ---------- SOS ----------

const sosAlertSchema = z.object({
  location: locationSchema.optional(),
  message: z.string().max(500).optional(),
}).strict();

safetyRouter.post("/orders/:id/sos-alerts", asyncHandler(async (request, response) => {
  const sosData = sosAlertSchema.parse(request.body);
  const order = await loadOrderForParticipant(request.params.id, request.user.id);

  const { rows: createdAlerts } = await runQuery(
    `INSERT INTO sos_alerts (order_id,user_id,latitude,longitude,message) VALUES ($1,$2,$3,$4,$5)
     RETURNING id, status, created_at AS "createdAt"`,
    [order.id, request.user.id, sosData.location?.latitude ?? null, sosData.location?.longitude ?? null, sosData.message ?? null]
  );

  // TODO: notificar contatos de confiança habilitados e o backoffice (SMS/push/fila)
  console.warn(`SOS alert ${createdAlerts[0].id} order=${order.id}`);
  response.status(201).json(createdAlerts[0]);
}));

module.exports = safetyRouter;
