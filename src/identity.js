const { runQuery } = require("./db");
const { ApiError } = require("./errors");

// Situação da identidade da conta:
// - "verified": tem verificação cpf_selfie aprovada ou é prestadora aprovada
//   (a aprovação do cadastro marca provider_profiles.verified);
// - "pending" / "rejected": resultado do pedido cpf_selfie mais recente;
// - "none": nunca pediu.
async function loadIdentityStatus(userId) {
  const { rows } = await runQuery(
    `SELECT
       CASE
         WHEN EXISTS (SELECT 1 FROM provider_profiles WHERE user_id=$1 AND verified)
           OR EXISTS (SELECT 1 FROM verifications WHERE user_id=$1 AND type='cpf_selfie' AND result='approved')
         THEN 'verified'
         ELSE COALESCE(latest.result,'none')
       END AS identity_status,
       latest.review_note AS "reviewNote"
     FROM (SELECT 1) AS anchor
     LEFT JOIN LATERAL (
       SELECT result,review_note FROM verifications
       WHERE user_id=$1 AND type='cpf_selfie' ORDER BY created_at DESC LIMIT 1
     ) latest ON true`,
    [userId]
  );
  const row = rows[0] ?? {};
  const status = ["verified", "pending", "rejected"].includes(row.identity_status) ? row.identity_status : "none";
  return { status, reviewNote: status === "rejected" ? row.reviewNote ?? null : null };
}

// O que uma conta ainda não verificada pode usar: pedir e acompanhar a
// verificação, avisos e push, e terminar o cadastro (endereço; perfil, base e
// serviços da prestadora, que o admin analisa junto).
const OPEN_BEFORE_VERIFICATION = [
  /^\/me\/(identity|verifications|notifications|devices|addresses)(\/|$)/,
  /^\/provider\/me\/(profile|services|venue)(\/|$)/,
];

async function requireVerifiedIdentity(request, _response, next) {
  try {
    if (request.user.roles?.includes("admin")) return next();
    if (OPEN_BEFORE_VERIFICATION.some((pattern) => pattern.test(request.path))) return next();
    const identity = await loadIdentityStatus(request.user.id);
    if (identity.status === "verified") return next();
    next(new ApiError(403, "identity_not_verified", "Identity verification is required.", { identityStatus: identity.status }));
  } catch (error) {
    next(error);
  }
}

module.exports = { loadIdentityStatus, requireVerifiedIdentity };
