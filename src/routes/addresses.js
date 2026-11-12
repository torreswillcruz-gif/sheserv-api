const addressesRouter = require("express").Router();
const { z } = require("zod");
const { runQuery } = require("../db");
const { ApiError, asyncHandler } = require("../errors");
const { isValidUuid } = require("../validation");

const MAX_ADDRESSES_PER_USER = 20;

const ADDRESS_COLUMNS = `id, label, street, number, complement, neighborhood, city, state,
  postal_code AS "postalCode", latitude, longitude`;

const baseAddressSchema = z.object({
  label: z.string().trim().max(50).optional(),
  street: z.string().trim().min(2).max(200),
  number: z.string().trim().max(20).optional(),
  complement: z.string().trim().max(100).optional(),
  neighborhood: z.string().trim().max(100).optional(),
  city: z.string().trim().min(2).max(100),
  state: z.string().trim().length(2).transform((stateCode) => stateCode.toUpperCase()).optional(),
  postalCode: z.string().regex(/^\d{5}-?\d{3}$/, "Use o formato 00000-000")
    .transform((postalCode) => postalCode.replace("-", "")).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
}).strict();

// latitude e longitude só fazem sentido juntas
const latitudeAndLongitudeTogether = [
  (addressData) => (addressData.latitude === undefined) === (addressData.longitude === undefined),
  { message: "Send latitude and longitude together.", path: ["longitude"] },
];
const createAddressSchema = baseAddressSchema.refine(...latitudeAndLongitudeTogether);
const updateAddressSchema = baseAddressSchema.partial().refine(...latitudeAndLongitudeTogether);

// campo enviado pelo app -> coluna do banco
const FIELD_TO_COLUMN = {
  label: "label",
  street: "street",
  number: "number",
  complement: "complement",
  neighborhood: "neighborhood",
  city: "city",
  state: "state",
  postalCode: "postal_code",
  latitude: "latitude",
  longitude: "longitude",
};

addressesRouter.get("/me/addresses", asyncHandler(async (request, response) => {
  const { rows: addresses } = await runQuery(
    `SELECT ${ADDRESS_COLUMNS} FROM addresses WHERE user_id=$1 AND deleted_at IS NULL ORDER BY label NULLS LAST, street`,
    [request.user.id]
  );
  response.json(addresses);
}));

addressesRouter.post("/me/addresses", asyncHandler(async (request, response) => {
  const addressData = createAddressSchema.parse(request.body);

  const { rows: countRows } = await runQuery(
    "SELECT count(*)::int AS total FROM addresses WHERE user_id=$1 AND deleted_at IS NULL",
    [request.user.id]
  );
  if (countRows[0].total >= MAX_ADDRESSES_PER_USER)
    throw new ApiError(409, "limit_reached", `Maximum of ${MAX_ADDRESSES_PER_USER} addresses.`);

  const { rows: createdAddresses } = await runQuery(
    `INSERT INTO addresses (user_id,label,street,number,complement,neighborhood,city,state,postal_code,latitude,longitude)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${ADDRESS_COLUMNS}`,
    [request.user.id, addressData.label ?? null, addressData.street, addressData.number ?? null,
     addressData.complement ?? null, addressData.neighborhood ?? null, addressData.city,
     addressData.state ?? null, addressData.postalCode ?? null, addressData.latitude ?? null,
     addressData.longitude ?? null]
  );
  response.status(201).json(createdAddresses[0]);
}));

addressesRouter.get("/me/addresses/:id", asyncHandler(async (request, response) => {
  if (!isValidUuid(request.params.id)) throw new ApiError(404, "not_found", "Address not found.");

  const { rows: matchingAddresses } = await runQuery(
    `SELECT ${ADDRESS_COLUMNS} FROM addresses WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
    [request.params.id, request.user.id]
  );
  if (!matchingAddresses[0]) throw new ApiError(404, "not_found", "Address not found.");
  response.json(matchingAddresses[0]);
}));

addressesRouter.patch("/me/addresses/:id", asyncHandler(async (request, response) => {
  if (!isValidUuid(request.params.id)) throw new ApiError(404, "not_found", "Address not found.");

  const addressChanges = updateAddressSchema.parse(request.body);
  const changedFields = Object.entries(addressChanges);
  if (changedFields.length === 0)
    throw new ApiError(422, "validation_error", "The request is invalid.", { body: "No fields to update." });

  // $1 = id do endereço, $2 = dono; os campos alterados começam no $3
  const columnAssignments = changedFields.map(([fieldName], position) => `${FIELD_TO_COLUMN[fieldName]}=$${position + 3}`);
  const { rows: updatedAddresses } = await runQuery(
    `UPDATE addresses SET ${columnAssignments.join(", ")}
     WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL RETURNING ${ADDRESS_COLUMNS}`,
    [request.params.id, request.user.id, ...changedFields.map(([, fieldValue]) => fieldValue)]
  );
  if (!updatedAddresses[0]) throw new ApiError(404, "not_found", "Address not found.");
  response.json(updatedAddresses[0]);
}));

// exclusão lógica: pedidos antigos continuam apontando para o endereço
addressesRouter.delete("/me/addresses/:id", asyncHandler(async (request, response) => {
  if (!isValidUuid(request.params.id)) throw new ApiError(404, "not_found", "Address not found.");

  const { rowCount: removedCount } = await runQuery(
    "UPDATE addresses SET deleted_at=now() WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL",
    [request.params.id, request.user.id]
  );
  if (!removedCount) throw new ApiError(404, "not_found", "Address not found.");
  response.sendStatus(204);
}));

module.exports = addressesRouter;
