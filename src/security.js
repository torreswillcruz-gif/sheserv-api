const crypto = require("crypto");
const jsonWebToken = require("jsonwebtoken");
const { runQuery } = require("./db");
const { ApiError } = require("./errors");

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_ALGORITHM = "HS256";
const JWT_ISSUER = "sheserv-api";
const ACCESS_TOKEN_LIFETIME = "15m";

const ENCRYPTION_KEY = crypto.createHash("sha256").update(process.env.DATA_ENCRYPTION_KEY || "").digest();

const hashWithSha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

// Criptografia AES-256-GCM: o resultado guarda vetor inicial + tag de autenticação + conteúdo
function encryptText(plainText) {
  const initializationVector = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENCRYPTION_KEY, initializationVector);
  const encryptedContent = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  return Buffer.concat([initializationVector, cipher.getAuthTag(), encryptedContent]).toString("base64");
}

function decryptText(encryptedBase64) {
  const encryptedBuffer = Buffer.from(encryptedBase64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", ENCRYPTION_KEY, encryptedBuffer.subarray(0, 12));
  decipher.setAuthTag(encryptedBuffer.subarray(12, 28));
  return Buffer.concat([decipher.update(encryptedBuffer.subarray(28)), decipher.final()]).toString("utf8");
}

// Gera o accessToken (JWT) e o refreshToken (guardado no banco só como hash)
async function createSession(user) {
  const accessToken = jsonWebToken.sign({ sub: user.id, roles: user.roles }, JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_LIFETIME,
    algorithm: JWT_ALGORITHM,
    issuer: JWT_ISSUER,
  });
  const refreshToken = crypto.randomBytes(48).toString("base64url");

  await runQuery(
    "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '30 days')",
    [user.id, hashWithSha256(refreshToken)]
  );

  return {
    accessToken,
    refreshToken,
    user: { id: user.id, name: user.name, email: user.email, roles: user.roles },
  };
}

// Exige o header "Authorization: Bearer <accessToken>" e preenche request.user
function requireAuthentication(request, _response, next) {
  const authorizationHeader = request.headers.authorization || "";
  if (!authorizationHeader.startsWith("Bearer "))
    return next(new ApiError(401, "unauthorized", "Missing access token."));

  try {
    const tokenPayload = jsonWebToken.verify(authorizationHeader.slice(7), JWT_SECRET, {
      algorithms: [JWT_ALGORITHM],
      issuer: JWT_ISSUER,
    });
    request.user = { id: tokenPayload.sub, roles: tokenPayload.roles };
    next();
  } catch {
    next(new ApiError(401, "unauthorized", "Invalid or expired access token."));
  }
}

const requireRole = (requiredRole) => (request, _response, next) =>
  request.user.roles.includes(requiredRole)
    ? next()
    : next(new ApiError(403, "forbidden", `Requires role ${requiredRole}.`));

module.exports = { encryptText, decryptText, hashWithSha256, createSession, requireAuthentication, requireRole };
