const router = require("express").Router();
const argon2 = require("argon2");
const { z } = require("zod");
const { query, tx } = require("../db");
const { ApiError, wrap } = require("../errors");
const { issueSession, sha256 } = require("../security");

const ARGON = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }; // OWASP

const phone = z.string().regex(/^\+\d{10,15}$/, "Use E.164 format, e.g. +5511999990101");
const registration = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email(),
  phone,
  password: z.string().min(8).max(128),
  role: z.enum(["cliente", "prestadora"]),
  providerProfile: z.object({ bio: z.string().max(500).optional() }).optional(),
});

router.post("/registrations", wrap(async (req, res) => {
  const b = registration.parse(req.body);
  const hash = await argon2.hash(b.password, ARGON);
  try {
    const user = await tx(async (c) => {
      const { rows } = await c.query(
        "INSERT INTO users (name,email,phone,password_hash,roles) VALUES ($1,$2,$3,$4,$5) RETURNING id,name,email,roles",
        [b.name, b.email, b.phone, hash, [b.role]]
      );
      if (b.role === "prestadora")
        await c.query("INSERT INTO provider_profiles (user_id,bio) VALUES ($1,$2)", [rows[0].id, b.providerProfile?.bio ?? null]);
      return rows[0];
    });
    res.status(201).json(await issueSession(user));
  } catch (e) {
    if (e.code === "23505") throw new ApiError(409, "conflict", "E-mail or phone already in use.");
    throw e;
  }
}));

router.post("/sessions", wrap(async (req, res) => {
  const { email, password } = z.object({
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(1).max(128),
  }).parse(req.body);

  const { rows } = await query("SELECT * FROM users WHERE email=$1", [email]);
  const u = rows[0];
  if (!u || !(await argon2.verify(u.password_hash, password)))
    throw new ApiError(401, "invalid_credentials", "Invalid e-mail or password.");
  if (argon2.needsRehash(u.password_hash, ARGON))
    await query("UPDATE users SET password_hash=$1 WHERE id=$2", [await argon2.hash(password, ARGON), u.id]);
  res.json(await issueSession(u));
}));

router.post("/refresh", wrap(async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string().min(10) }).parse(req.body);
  const { rows } = await query(
    `UPDATE refresh_tokens SET revoked=true
     WHERE token_hash=$1 AND revoked=false AND expires_at>now() RETURNING user_id`,
    [sha256(refreshToken)]
  );
  if (!rows[0]) throw new ApiError(401, "unauthorized", "Invalid refresh token.");
  const u = (await query("SELECT id,name,email,roles FROM users WHERE id=$1", [rows[0].user_id])).rows[0];
  res.json(await issueSession(u));
}));

// OTP: contrato definido, provedor de SMS ainda não escolhido
router.post("/otp/requests", (_req, _res, next) => next(new ApiError(501, "not_implemented", "OTP not configured.")));
router.post("/otp/verifications", (_req, _res, next) => next(new ApiError(501, "not_implemented", "OTP not configured.")));

module.exports = router;
