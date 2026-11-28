// Ferramentas do plano Pro em diante: perfil da marca, dados fiscais e notas
// de serviço, e orçamento livre. Todas exigem login de prestadora.
const businessRouter = require("express").Router();
const { z } = require("zod");
const { runQuery, runInTransaction } = require("../db");
const { ApiError, asyncHandler } = require("../errors");
const { encryptText, decryptText, requireRole } = require("../security");
const { requirePlanFeature } = require("./erp");

const asProvider = requireRole("prestadora");
const optionalText = (max) =>
  z.string().trim().max(max).nullable().optional().transform((value) => (value ? value : null));

// CPF e CNPJ: validação em src/documents.js
const { onlyDocumentCharacters, isValidCnpj, isValidCpf } = require("../documents");

// "***.456.789-**" / "**.***.678/0001-**": só o meio, para conferir sem expor.
function maskDocument(document) {
  if (!document) return null;
  if (document.length === 11) return `***.${document.slice(3, 6)}.${document.slice(6, 9)}-**`;
  return `**.***.${document.slice(5, 8)}/${document.slice(8, 12)}-**`;
}

// ---------------------------------------------------------------------------
// Perfil da marca

const brandingSchema = z.object({
  brandName: optionalText(60),
  tagline: optionalText(120),
  instagram: optionalText(40).transform((value) => (value ? value.replace(/^@/, "") : null))
    .refine((value) => value === null || /^[A-Za-z0-9._]{1,30}$/.test(value), "Invalid Instagram user."),
  whatsapp: optionalText(20).transform((value) => (value ? value.replace(/\D/g, "") : null))
    .refine((value) => value === null || /^\d{10,13}$/.test(value), "Invalid WhatsApp number."),
  website: optionalText(120)
    .refine((value) => value === null || /^https?:\/\/[^\s]+$/i.test(value), "Use a full link (https://...)."),
}).strict();

const BRANDING_COLUMNS = `brand_name AS "brandName",tagline,instagram,whatsapp,website,updated_at AS "updatedAt"`;
const EMPTY_BRANDING = { brandName: null, tagline: null, instagram: null, whatsapp: null, website: null };

businessRouter.get("/me/branding", asProvider, requirePlanFeature("branding"), asyncHandler(async (request, response) => {
  const { rows } = await runQuery(
    `SELECT ${BRANDING_COLUMNS} FROM provider_branding WHERE provider_id=$1`,
    [request.user.id]
  );
  response.json(rows[0] ?? EMPTY_BRANDING);
}));

businessRouter.put("/me/branding", asProvider, requirePlanFeature("branding"), asyncHandler(async (request, response) => {
  const data = brandingSchema.parse(request.body);
  const { rows } = await runQuery(
    `INSERT INTO provider_branding (provider_id,brand_name,tagline,instagram,whatsapp,website)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (provider_id) DO UPDATE SET brand_name=EXCLUDED.brand_name,tagline=EXCLUDED.tagline,
       instagram=EXCLUDED.instagram,whatsapp=EXCLUDED.whatsapp,website=EXCLUDED.website,updated_at=now()
     RETURNING ${BRANDING_COLUMNS}`,
    [request.user.id, data.brandName, data.tagline, data.instagram, data.whatsapp, data.website]
  );
  response.json(rows[0]);
}));

// ---------------------------------------------------------------------------
// Dados fiscais

const TAX_REGIMES = ["mei", "simples_nacional", "lucro_presumido", "lucro_real"];

const fiscalSchema = z.object({
  cnpj: z.string().transform(onlyDocumentCharacters).refine(isValidCnpj, "Invalid CNPJ."),
  legalName: z.string().trim().min(2).max(150),
  taxRegime: z.enum(TAX_REGIMES),
  municipalRegistration: optionalText(30),
  // Código IBGE do município (7 dígitos): onde a nota é emitida.
  cityCode: optionalText(7).refine((value) => value === null || /^\d{7}$/.test(value), "Use the 7-digit IBGE code."),
  // Código de tributação nacional do serviço (ex.: 06.01.01 para cabeleireiros).
  serviceCode: optionalText(20),
  issRate: z.number().min(0).max(5).nullable().optional().transform((value) => value ?? null),
}).strict();

const FISCAL_COLUMNS = `cnpj,legal_name AS "legalName",tax_regime AS "taxRegime",
  municipal_registration AS "municipalRegistration",city_code AS "cityCode",
  service_code AS "serviceCode",iss_rate::float AS "issRate",updated_at AS "updatedAt"`;

businessRouter.get("/me/fiscal", asProvider, requirePlanFeature("invoices"), asyncHandler(async (request, response) => {
  const { rows } = await runQuery(
    `SELECT ${FISCAL_COLUMNS} FROM provider_fiscal_profiles WHERE provider_id=$1`,
    [request.user.id]
  );
  // Sem dados fiscais: a prestadora ainda não tem CNPJ cadastrado.
  response.json(rows[0] ?? null);
}));

businessRouter.put("/me/fiscal", asProvider, requirePlanFeature("invoices"), asyncHandler(async (request, response) => {
  const data = fiscalSchema.parse(request.body);
  const { rows } = await runQuery(
    `INSERT INTO provider_fiscal_profiles
      (provider_id,cnpj,legal_name,tax_regime,municipal_registration,city_code,service_code,iss_rate)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (provider_id) DO UPDATE SET cnpj=EXCLUDED.cnpj,legal_name=EXCLUDED.legal_name,
       tax_regime=EXCLUDED.tax_regime,municipal_registration=EXCLUDED.municipal_registration,
       city_code=EXCLUDED.city_code,service_code=EXCLUDED.service_code,iss_rate=EXCLUDED.iss_rate,
       updated_at=now()
     RETURNING ${FISCAL_COLUMNS}`,
    [request.user.id, data.cnpj, data.legalName, data.taxRegime, data.municipalRegistration,
     data.cityCode, data.serviceCode, data.issRate]
  );
  response.json(rows[0]);
}));

// ---------------------------------------------------------------------------
// Notas de serviço. A emissão em si depende da integração (docs/NOTAS_FISCAIS.md
// no app): até lá, a nota fica como rascunho com todos os dados para emitir.

const INVOICE_COLUMNS = `id,order_id AS "orderId",customer_name AS "customerName",
  customer_document_encrypted AS "customerDocumentEncrypted",customer_email AS "customerEmail",
  description,amount::float,to_char(service_date,'YYYY-MM-DD') AS "serviceDate",status,number,
  verification_code AS "verificationCode",pdf_url AS "pdfUrl",xml_url AS "xmlUrl",
  status_message AS "statusMessage",created_at AS "createdAt"`;

function invoiceForResponse(row) {
  const { customerDocumentEncrypted, ...invoice } = row;
  const document = customerDocumentEncrypted ? decryptText(customerDocumentEncrypted) : null;
  return { ...invoice, customerDocument: maskDocument(document) };
}

const invoiceSchema = z.object({
  orderId: z.string().uuid().nullable().optional(),
  customerName: z.string().trim().min(2).max(150),
  customerDocument: z.string().nullable().optional()
    .transform((value) => (value ? onlyDocumentCharacters(value) : null))
    .refine((value) => value === null || isValidCpf(value) || isValidCnpj(value), "Invalid CPF or CNPJ."),
  customerEmail: z.string().trim().email().max(150).nullable().optional(),
  description: z.string().trim().min(3).max(2000),
  amount: z.number().positive().max(1_000_000),
  serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();

businessRouter.get("/me/invoices", asProvider, requirePlanFeature("invoices"), asyncHandler(async (request, response) => {
  const { rows } = await runQuery(
    `SELECT ${INVOICE_COLUMNS} FROM service_invoices
     WHERE provider_id=$1 ORDER BY created_at DESC LIMIT 100`,
    [request.user.id]
  );
  response.json(rows.map(invoiceForResponse));
}));

businessRouter.post("/me/invoices", asProvider, requirePlanFeature("invoices"), asyncHandler(async (request, response) => {
  const data = invoiceSchema.parse(request.body);
  const fiscal = await runQuery("SELECT 1 FROM provider_fiscal_profiles WHERE provider_id=$1", [request.user.id]);
  if (!fiscal.rows[0]) {
    throw new ApiError(409, "fiscal_profile_required", "Register the CNPJ before requesting invoices.");
  }
  if (data.orderId) {
    const order = await runQuery(
      "SELECT 1 FROM orders WHERE id=$1 AND provider_id=$2 AND status='completed'",
      [data.orderId, request.user.id]
    );
    if (!order.rows[0]) throw new ApiError(422, "order_not_completed", "Only completed orders of this provider.");
  }
  const { rows } = await runQuery(
    `INSERT INTO service_invoices
      (provider_id,order_id,customer_name,customer_document_encrypted,customer_email,description,amount,service_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${INVOICE_COLUMNS}`,
    [request.user.id, data.orderId ?? null, data.customerName,
     data.customerDocument ? encryptText(data.customerDocument) : null,
     data.customerEmail ?? null, data.description, data.amount, data.serviceDate]
  );
  response.status(201).json(invoiceForResponse(rows[0]));
}));

// Só rascunhos: nota emitida se cancela pelo emissor, não se apaga.
businessRouter.delete("/me/invoices/:invoiceId", asProvider, requirePlanFeature("invoices"), asyncHandler(async (request, response) => {
  const invoiceId = z.string().uuid().parse(request.params.invoiceId);
  const { rows } = await runQuery(
    "SELECT status FROM service_invoices WHERE id=$1 AND provider_id=$2",
    [invoiceId, request.user.id]
  );
  if (!rows[0]) throw new ApiError(404, "invoice_not_found", "Invoice not found.");
  if (rows[0].status !== "draft") {
    throw new ApiError(409, "invoice_not_draft", "Only drafts can be deleted.");
  }
  await runQuery("DELETE FROM service_invoices WHERE id=$1 AND provider_id=$2", [invoiceId, request.user.id]);
  response.status(204).end();
}));

// ---------------------------------------------------------------------------
// Orçamento livre

const quoteItemSchema = z.object({
  description: z.string().trim().min(1).max(200),
  quantity: z.number().positive().max(10_000),
  unitPrice: z.number().min(0).max(1_000_000),
}).strict();

const customQuoteSchema = z.object({
  customerName: z.string().trim().min(2).max(150),
  customerContact: optionalText(150),
  items: z.array(quoteItemSchema).min(1).max(50),
  discount: z.number().min(0).max(1_000_000).default(0),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: optionalText(2000),
  status: z.enum(["draft", "sent", "accepted", "declined"]).default("draft"),
}).strict().refine(
  (quote) => quote.discount <= quote.items.reduce((total, item) => total + item.quantity * item.unitPrice, 0),
  { message: "Discount is larger than the total.", path: ["discount"] }
);

const QUOTE_COLUMNS = `id,number,customer_name AS "customerName",customer_contact AS "customerContact",
  items,discount::float,to_char(valid_until,'YYYY-MM-DD') AS "validUntil",notes,status,
  created_at AS "createdAt",updated_at AS "updatedAt"`;

businessRouter.get("/me/custom-quotes", asProvider, requirePlanFeature("custom_quotes"), asyncHandler(async (request, response) => {
  const { rows } = await runQuery(
    `SELECT ${QUOTE_COLUMNS} FROM custom_quotes WHERE provider_id=$1 ORDER BY number DESC LIMIT 100`,
    [request.user.id]
  );
  response.json(rows);
}));

businessRouter.post("/me/custom-quotes", asProvider, requirePlanFeature("custom_quotes"), asyncHandler(async (request, response) => {
  const data = customQuoteSchema.parse(request.body);
  // Número sequencial por prestadora (Nº 1, 2, 3...), travando a numeração.
  const created = await runInTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`custom_quotes:${request.user.id}`]);
    const next = await client.query(
      "SELECT coalesce(max(number),0)+1 AS next FROM custom_quotes WHERE provider_id=$1",
      [request.user.id]
    );
    const { rows } = await client.query(
      `INSERT INTO custom_quotes
        (provider_id,number,customer_name,customer_contact,items,discount,valid_until,notes,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${QUOTE_COLUMNS}`,
      [request.user.id, Number(next.rows[0]?.next ?? 1), data.customerName, data.customerContact,
       JSON.stringify(data.items), data.discount, data.validUntil ?? null, data.notes, data.status]
    );
    return rows[0];
  });
  response.status(201).json(created);
}));

businessRouter.put("/me/custom-quotes/:quoteId", asProvider, requirePlanFeature("custom_quotes"), asyncHandler(async (request, response) => {
  const quoteId = z.string().uuid().parse(request.params.quoteId);
  const data = customQuoteSchema.parse(request.body);
  const { rows } = await runQuery(
    `UPDATE custom_quotes SET customer_name=$3,customer_contact=$4,items=$5,discount=$6,
       valid_until=$7,notes=$8,status=$9,updated_at=now()
     WHERE id=$1 AND provider_id=$2 RETURNING ${QUOTE_COLUMNS}`,
    [quoteId, request.user.id, data.customerName, data.customerContact, JSON.stringify(data.items),
     data.discount, data.validUntil ?? null, data.notes, data.status]
  );
  if (!rows[0]) throw new ApiError(404, "quote_not_found", "Quote not found.");
  response.json(rows[0]);
}));

businessRouter.delete("/me/custom-quotes/:quoteId", asProvider, requirePlanFeature("custom_quotes"), asyncHandler(async (request, response) => {
  const quoteId = z.string().uuid().parse(request.params.quoteId);
  const { rows } = await runQuery(
    "DELETE FROM custom_quotes WHERE id=$1 AND provider_id=$2 RETURNING id",
    [quoteId, request.user.id]
  );
  if (!rows[0]) throw new ApiError(404, "quote_not_found", "Quote not found.");
  response.status(204).end();
}));

module.exports = { businessRouter, isValidCnpj, isValidCpf };
