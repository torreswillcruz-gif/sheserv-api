// Sessão do painel administrativo.
// A admin-api não emite tokens: login, renovação e logout são repassados à
// marketplace-api (MARKETPLACE_API_URL). Aqui só se garante que a conta tem o
// papel "admin" antes de devolver a sessão ao painel.
const sessionRouter = require("express").Router();
const { z } = require("zod");
const { runQuery } = require("../db");
const { ApiError, asyncHandler } = require("../errors");

const UPSTREAM_TIMEOUT_MS = 20_000; // a API principal pode estar acordando (Render free)

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(3).max(320),
  password: z.string().min(1).max(128),
}).strict();

const refreshSchema = z.object({ refreshToken: z.string().min(10).max(200) }).strict();

async function callMarketplace(path, body) {
  const baseUrl = process.env.MARKETPLACE_API_URL;
  if (!baseUrl) throw new ApiError(503, "not_configured", "MARKETPLACE_API_URL is not configured.");

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(new URL(path, baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    throw new ApiError(502, "upstream_unavailable", "Authentication service is unavailable.");
  }
  const payload = upstreamResponse.status === 204 ? null : await upstreamResponse.json().catch(() => null);
  return { status: upstreamResponse.status, payload };
}

async function isCurrentAdmin(userId) {
  const { rows } = await runQuery(
    "SELECT 1 FROM users WHERE id=$1 AND roles @> ARRAY['admin']::text[]",
    [userId]
  );
  return Boolean(rows[0]);
}

// Converte a resposta de sessão da API principal na sessão do painel,
// recusando (e encerrando) sessões de quem não é admin.
async function adminSessionFrom({ status, payload }) {
  if (status === 401) throw new ApiError(401, "invalid_credentials", "Invalid e-mail or password.");
  if (status === 429) throw new ApiError(429, "rate_limited", "Too many attempts. Try again later.");
  if (status !== 200 || !payload?.accessToken || !payload?.user?.id)
    throw new ApiError(502, "upstream_error", "Unexpected response from the authentication service.");

  if (!(await isCurrentAdmin(payload.user.id))) {
    await callMarketplace("/api/v1/auth/logout", { refreshToken: payload.refreshToken }).catch(() => {});
    throw new ApiError(403, "forbidden", "Administrator access is required.");
  }
  return {
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken,
    user: { id: payload.user.id, name: payload.user.name, email: payload.user.email },
  };
}

sessionRouter.post("/", asyncHandler(async (request, response) => {
  const credentials = loginSchema.parse(request.body);
  response.json(await adminSessionFrom(await callMarketplace("/api/v1/auth/sessions", credentials)));
}));

sessionRouter.post("/refresh", asyncHandler(async (request, response) => {
  const { refreshToken } = refreshSchema.parse(request.body);
  const upstream = await callMarketplace("/api/v1/auth/refresh", { refreshToken });
  if (upstream.status === 401) throw new ApiError(401, "unauthorized", "Session expired.");
  response.json(await adminSessionFrom(upstream));
}));

sessionRouter.post("/logout", asyncHandler(async (request, response) => {
  const { refreshToken } = refreshSchema.parse(request.body);
  await callMarketplace("/api/v1/auth/logout", { refreshToken });
  response.sendStatus(204);
}));

module.exports = sessionRouter;
