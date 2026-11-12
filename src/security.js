const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { query } = require("./db");
const { ApiError } = require("./errors");

const JWT_SECRET = process.env.JWT_SECRET;
const KEY = crypto.createHash("sha256").update(process.env.DATA_ENCRYPTION_KEY || "").digest();
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}
function decrypt(b64) {
  const buf = Buffer.from(b64, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

async function issueSession(user) {
  const accessToken = jwt.sign({ sub: user.id, roles: user.roles }, JWT_SECRET, { expiresIn: "15m" });
  const refreshToken = crypto.randomBytes(48).toString("base64url");
  await query(
    "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '30 days')",
    [user.id, sha256(refreshToken)]
  );
  return {
    accessToken,
    refreshToken,
    user: { id: user.id, name: user.name, email: user.email, roles: user.roles },
  };
}

function requireAuth(req, _res, next) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return next(new ApiError(401, "unauthorized", "Missing access token."));
  try {
    const p = jwt.verify(h.slice(7), JWT_SECRET);
    req.user = { id: p.sub, roles: p.roles };
    next();
  } catch {
    next(new ApiError(401, "unauthorized", "Invalid or expired access token."));
  }
}

const requireRole = (role) => (req, _res, next) =>
  req.user.roles.includes(role) ? next() : next(new ApiError(403, "forbidden", `Requires role ${role}.`));

module.exports = { encrypt, decrypt, sha256, issueSession, requireAuth, requireRole };
