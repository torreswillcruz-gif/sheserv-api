// Termos (públicos) e dados básicos da conta (nome, nome social, e-mail e
// celular). Trocar e-mail ou celular pede a senha atual: são o login e o
// contato de recuperação da conta.
const argon2 = require("argon2");
const { z } = require("zod");
const { runQuery, runInTransaction } = require("../db");
const { ApiError, asyncHandler } = require("../errors");
const { decryptText } = require("../security");

const PROVIDER_TERM = "prestadora_elegibilidade";
const TERM_KEYS = [PROVIDER_TERM];

async function latestTerm(client, termKey) {
  const { rows } = await client.query(
    `SELECT term_key AS key, version, title, body, created_at AS "updatedAt"
     FROM legal_terms WHERE term_key=$1 ORDER BY version DESC LIMIT 1`,
    [termKey]
  );
  return rows[0] ?? null;
}

// O app só aceita a versão que mostrou; versão velha pede para ler de novo.
async function recordAcceptance(client, userId, termKey, version) {
  const latest = await latestTerm(client, termKey);
  if (!latest) throw new ApiError(500, "term_missing", "Termo não configurado.");
  if (version !== latest.version)
    throw new ApiError(409, "term_outdated", "O termo foi atualizado. Leia a versão nova para continuar.", {
      acceptedTerms: `Versão atual: ${latest.version}.`,
    });
  await client.query(
    "INSERT INTO term_acceptances (user_id,term_key,version) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
    [userId, termKey, version]
  );
}

// Rotas públicas (antes do login)
const publicAccountRouter = require("express").Router();

publicAccountRouter.get("/terms/:key", asyncHandler(async (request, response) => {
  if (!TERM_KEYS.includes(request.params.key)) throw new ApiError(404, "not_found", "Termo não encontrado.");
  const term = await latestTerm({ query: runQuery }, request.params.key);
  if (!term) throw new ApiError(404, "not_found", "Termo não encontrado.");
  response.json(term);
}));

// Rotas da conta logada (montadas depois do login; abertas antes da
// verificação de identidade, em src/identity.js)
const accountRouter = require("express").Router();

const phoneSchema = z.string().regex(/^\+\d{10,15}$/, "Use E.164 format, e.g. +5511999990101");

async function accountView(userId) {
  const { rows } = await runQuery(
    `SELECT u.id, u.name, u.social_name AS "socialName", u.email, u.phone, u.roles, u.cpf_encrypted,
       (SELECT MAX(version) FROM term_acceptances t WHERE t.user_id=u.id AND t.term_key=$2) AS "providerTermVersion"
     FROM users u WHERE u.id=$1`,
    [userId, PROVIDER_TERM]
  );
  const user = rows[0];
  if (!user) throw new ApiError(401, "unauthorized", "Account not found.");
  let cpf = null;
  try { cpf = user.cpf_encrypted ? decryptText(user.cpf_encrypted) : null; } catch { cpf = null; }
  const { cpf_encrypted: _ignored, ...rest } = user;
  return { ...rest, cpfMasked: cpf ? `***.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-**` : null };
}

accountRouter.get("/me/account", asyncHandler(async (request, response) => {
  response.json(await accountView(request.user.id));
}));

const accountUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  socialName: z.string().trim().max(120).nullable().optional(),
  email: z.string().trim().toLowerCase().email().optional(),
  phone: phoneSchema.optional(),
  currentPassword: z.string().min(1).max(128).optional(),
}).strict();

accountRouter.patch("/me/account", asyncHandler(async (request, response) => {
  const change = accountUpdateSchema.parse(request.body);
  await runInTransaction(async (client) => {
    const { rows } = await client.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [request.user.id]);
    const user = rows[0];
    if (!user) throw new ApiError(401, "unauthorized", "Account not found.");
    const changesLogin = (change.email && change.email !== user.email) || (change.phone && change.phone !== user.phone);
    if (changesLogin) {
      if (!change.currentPassword || !(await argon2.verify(user.password_hash, change.currentPassword)))
        throw new ApiError(403, "invalid_password", "Confirme com a sua senha atual.", { currentPassword: "Senha incorreta." });
    }
    try {
      await client.query(
        `UPDATE users SET name=COALESCE($2,name), email=COALESCE($3,email), phone=COALESCE($4,phone),
           social_name=CASE WHEN $5 THEN NULLIF($6,'') ELSE social_name END
         WHERE id=$1`,
        [user.id, change.name ?? null, change.email ?? null, change.phone ?? null,
         change.socialName !== undefined, change.socialName ?? null]
      );
    } catch (error) {
      if (error.code === "23505") {
        const field = String(error.constraint ?? "").includes("phone") ? "phone" : "email";
        throw new ApiError(409, "conflict", field === "phone" ? "Este celular já está em outra conta." : "Este e-mail já está em outra conta.", {
          [field]: "Já cadastrado em outra conta.",
        });
      }
      throw error;
    }
  });
  response.json(await accountView(request.user.id));
}));

// Aceite do termo depois do cadastro (versão nova ou conta antiga)
accountRouter.post("/me/terms/:key/acceptances", asyncHandler(async (request, response) => {
  if (!TERM_KEYS.includes(request.params.key)) throw new ApiError(404, "not_found", "Termo não encontrado.");
  const { version } = z.object({ version: z.number().int().positive() }).strict().parse(request.body);
  await runInTransaction((client) => recordAcceptance(client, request.user.id, request.params.key, version));
  response.sendStatus(204);
}));

module.exports = { publicAccountRouter, accountRouter, recordAcceptance, latestTerm, PROVIDER_TERM };
