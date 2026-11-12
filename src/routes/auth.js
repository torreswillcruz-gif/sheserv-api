const authRouter = require("express").Router();
const argon2 = require("argon2");
const { z } = require("zod");
const { runQuery, runInTransaction } = require("../db");
const { ApiError, asyncHandler } = require("../errors");
const { createSession, hashWithSha256, requireAuthentication } = require("../security");

// Parâmetros do Argon2id recomendados pela OWASP
const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

const phoneSchema = z.string().regex(/^\+\d{10,15}$/, "Use E.164 format, e.g. +5511999990101");

const registrationSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email(),
  phone: phoneSchema,
  password: z.string().min(8).max(128),
  role: z.enum(["cliente", "prestadora"]),
  providerProfile: z.object({ bio: z.string().max(500).optional() }).optional(),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(128),
});

const refreshTokenSchema = z.object({ refreshToken: z.string().min(10) });

authRouter.post("/registrations", asyncHandler(async (request, response) => {
  const registrationData = registrationSchema.parse(request.body);
  const passwordHash = await argon2.hash(registrationData.password, ARGON2_OPTIONS);

  try {
    const createdUser = await runInTransaction(async (transactionClient) => {
      const { rows: insertedUsers } = await transactionClient.query(
        "INSERT INTO users (name,email,phone,password_hash,roles) VALUES ($1,$2,$3,$4,$5) RETURNING id,name,email,roles",
        [registrationData.name, registrationData.email, registrationData.phone, passwordHash, [registrationData.role]]
      );
      if (registrationData.role === "prestadora") {
        await transactionClient.query(
          "INSERT INTO provider_profiles (user_id,bio) VALUES ($1,$2)",
          [insertedUsers[0].id, registrationData.providerProfile?.bio ?? null]
        );
      }
      return insertedUsers[0];
    });
    response.status(201).json(await createSession(createdUser));
  } catch (databaseError) {
    if (databaseError.code === "23505") throw new ApiError(409, "conflict", "E-mail or phone already in use.");
    throw databaseError;
  }
}));

authRouter.post("/sessions", asyncHandler(async (request, response) => {
  const { email, password } = loginSchema.parse(request.body);

  const { rows: matchingUsers } = await runQuery("SELECT * FROM users WHERE email=$1", [email]);
  const existingUser = matchingUsers[0];
  if (!existingUser || !(await argon2.verify(existingUser.password_hash, password)))
    throw new ApiError(401, "invalid_credentials", "Invalid e-mail or password.");

  // Se os parâmetros do hash ficaram defasados, regrava a senha com os parâmetros atuais
  if (argon2.needsRehash(existingUser.password_hash, ARGON2_OPTIONS)) {
    await runQuery("UPDATE users SET password_hash=$1 WHERE id=$2", [
      await argon2.hash(password, ARGON2_OPTIONS),
      existingUser.id,
    ]);
  }
  response.json(await createSession(existingUser));
}));

authRouter.post("/refresh", asyncHandler(async (request, response) => {
  const { refreshToken } = refreshTokenSchema.parse(request.body);
  const refreshTokenHash = hashWithSha256(refreshToken);

  const { rows: storedTokens } = await runQuery(
    "SELECT user_id, revoked, expires_at FROM refresh_tokens WHERE token_hash=$1",
    [refreshTokenHash]
  );
  const storedToken = storedTokens[0];
  if (!storedToken || new Date(storedToken.expires_at) < new Date())
    throw new ApiError(401, "unauthorized", "Invalid refresh token.");

  if (storedToken.revoked) {
    // token já usado/revogado sendo reapresentado: possível roubo -> encerra todas as sessões
    await runQuery("UPDATE refresh_tokens SET revoked=true WHERE user_id=$1", [storedToken.user_id]);
    throw new ApiError(401, "unauthorized", "Invalid refresh token.");
  }

  await runQuery("UPDATE refresh_tokens SET revoked=true WHERE token_hash=$1", [refreshTokenHash]);
  const { rows: tokenOwners } = await runQuery("SELECT id,name,email,roles FROM users WHERE id=$1", [storedToken.user_id]);
  response.json(await createSession(tokenOwners[0]));
}));

authRouter.post("/logout", asyncHandler(async (request, response) => {
  const { refreshToken } = refreshTokenSchema.parse(request.body);
  await runQuery("UPDATE refresh_tokens SET revoked=true WHERE token_hash=$1", [hashWithSha256(refreshToken)]);
  response.sendStatus(204);
}));

authRouter.post("/logout-all", requireAuthentication, asyncHandler(async (request, response) => {
  await runQuery("UPDATE refresh_tokens SET revoked=true WHERE user_id=$1", [request.user.id]);
  response.sendStatus(204);
}));

// OTP: contrato definido, provedor de SMS ainda não escolhido
authRouter.post("/otp/requests", (_request, _response, next) =>
  next(new ApiError(501, "not_implemented", "OTP not configured.")));
authRouter.post("/otp/verifications", (_request, _response, next) =>
  next(new ApiError(501, "not_implemented", "OTP not configured.")));

module.exports = authRouter;
