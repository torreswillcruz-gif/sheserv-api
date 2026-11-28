// Confiança e cadastro no painel:
//   GET  /terms/:key            versões do termo (a mais recente primeiro)
//   POST /terms/:key            publica uma versão nova (o cadastro passa a pedir esta)
//   GET  /providers/:id/cpf     CPF completo para conferir na Serpro (fica na auditoria)
const crypto = require("crypto");
const trustAdminRouter = require("express").Router();
const { z } = require("zod");
const { runQuery, runInTransaction } = require("../db");
const { ApiError, asyncHandler } = require("../errors");
const { basicDataVerifier } = require("../basic_data_verifier");

const TERM_KEYS = ["prestadora_elegibilidade"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function recordAudit(client, adminId, action, resourceType, resourceId, details) {
  await client.query(
    "INSERT INTO admin_audit_events (admin_id,action,resource_type,resource_id,details) VALUES ($1,$2,$3,$4,$5)",
    [adminId, action, resourceType, resourceId, JSON.stringify(details)]
  );
}

const termKeyParam = (key) => {
  if (!TERM_KEYS.includes(key)) throw new ApiError(404, "not_found", "Termo não encontrado.");
  return key;
};

trustAdminRouter.get("/terms/:key", asyncHandler(async (request, response) => {
  const key = termKeyParam(request.params.key);
  const { rows } = await runQuery(
    `SELECT t.version, t.title, t.body, t.created_at AS "createdAt", u.name AS "createdBy",
       (SELECT COUNT(*)::int FROM term_acceptances a WHERE a.term_key=t.term_key AND a.version=t.version) AS acceptances
     FROM legal_terms t LEFT JOIN users u ON u.id=t.created_by
     WHERE t.term_key=$1 ORDER BY t.version DESC LIMIT 20`,
    [key]
  );
  response.json({ key, versions: rows });
}));

const termSchema = z.object({
  title: z.string().trim().min(3).max(200),
  body: z.string().trim().min(20).max(20000),
}).strict();

trustAdminRouter.post("/terms/:key", asyncHandler(async (request, response) => {
  const key = termKeyParam(request.params.key);
  const data = termSchema.parse(request.body);
  const created = await runInTransaction(async (client) => {
    const { rows: latest } = await client.query(
      "SELECT version, title, body FROM legal_terms WHERE term_key=$1 ORDER BY version DESC LIMIT 1 FOR UPDATE",
      [key]
    );
    if (latest[0] && latest[0].title === data.title && latest[0].body === data.body)
      throw new ApiError(422, "unchanged", "Nada mudou em relação à versão atual.");
    const version = (latest[0]?.version ?? 0) + 1;
    const { rows } = await client.query(
      `INSERT INTO legal_terms (term_key,version,title,body,created_by) VALUES ($1,$2,$3,$4,$5)
       RETURNING version, title, body, created_at AS "createdAt"`,
      [key, version, data.title, data.body, request.user.id]
    );
    await recordAudit(client, request.user.id, "term.published", "term", `${key}:v${version}`, {
      key, version, previousVersion: latest[0]?.version ?? null,
    });
    return rows[0];
  });
  response.status(201).json(created);
}));

// Mesmo esquema de chave da API principal (AES-256-GCM sobre sha256 da chave)
function decryptText(encryptedBase64) {
  const secret = process.env.DATA_ENCRYPTION_KEY;
  if (!secret) throw new ApiError(503, "encryption_not_configured", "Configure DATA_ENCRYPTION_KEY no admin para ver o CPF.");
  const key = crypto.createHash("sha256").update(secret).digest();
  const buffer = Buffer.from(encryptedBase64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, buffer.subarray(0, 12));
  decipher.setAuthTag(buffer.subarray(12, 28));
  return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString("utf8");
}

trustAdminRouter.get("/providers/:id/cpf", asyncHandler(async (request, response) => {
  if (!UUID_PATTERN.test(request.params.id)) throw new ApiError(404, "not_found", "Provider not found.");
  const result = await runInTransaction(async (client) => {
    const { rows } = await client.query(
      "SELECT u.name, u.social_name, u.cpf_encrypted FROM users u WHERE u.id=$1 AND u.roles @> ARRAY['prestadora']::text[]",
      [request.params.id]
    );
    if (!rows[0]) throw new ApiError(404, "not_found", "Provider not found.");
    if (!rows[0].cpf_encrypted) throw new ApiError(404, "cpf_missing", "Esta prestadora não informou CPF.");
    let cpf;
    try {
      cpf = decryptText(rows[0].cpf_encrypted);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, "decrypt_failed", "Não foi possível ler o CPF (chave diferente da API?).");
    }
    await recordAudit(client, request.user.id, "provider.cpf_viewed", "provider", request.params.id, { purpose: "basic_data_check" });
    return {
      cpf: `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`,
      name: rows[0].name,
      socialName: rows[0].social_name,
      verifier: basicDataVerifier().source,
    };
  });
  response.json(result);
}));

module.exports = { trustAdminRouter };
