const jsonWebToken = require("jsonwebtoken");
const { runQuery } = require("./db");
const { ApiError } = require("./errors");

const JWT_ALGORITHM = "HS256";
const JWT_ISSUER = "sheserv-api";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireAdmin(request, _response, next) {
  const authorizationHeader = request.headers.authorization || "";
  if (!authorizationHeader.startsWith("Bearer "))
    return next(new ApiError(401, "unauthorized", "Missing access token."));

  let tokenPayload;
  try {
    tokenPayload = jsonWebToken.verify(authorizationHeader.slice(7), process.env.JWT_SECRET, {
      algorithms: [JWT_ALGORITHM],
      issuer: JWT_ISSUER,
    });
  } catch {
    return next(new ApiError(401, "unauthorized", "Invalid or expired access token."));
  }

  if (typeof tokenPayload.sub !== "string" || !UUID_PATTERN.test(tokenPayload.sub))
    return next(new ApiError(401, "unauthorized", "Invalid access token."));

  return runQuery(
    "SELECT id FROM users WHERE id=$1 AND roles @> ARRAY['admin']::text[]",
    [tokenPayload.sub]
  ).then(({ rows }) => {
    if (!rows[0]) throw new ApiError(403, "forbidden", "Administrator access is required.");
    request.user = { id: rows[0].id, roles: ["admin"] };
    next();
  }).catch(next);
}

module.exports = { requireAdmin };
