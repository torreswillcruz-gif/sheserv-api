// Peças compartilhadas pelo domínio de pagamentos.
const crypto = require("crypto");
const db = require("../db");
const { getGateway, isDemoMode } = require("./gateway");
const { ApiError } = require("../errors");

// Parâmetros do mock: configuração global do admin; as variáveis de ambiente
// só valem se a configuração não existir.
async function loadMockBehavior() {
  const { rows } = await db.runQuery(
    "SELECT mock_failure_rate_bps, mock_latency_ms FROM payment_settings WHERE scope_key='global'"
  );
  const envRate = Number(process.env.MOCK_FAILURE_RATE);
  const envLatency = Number(process.env.MOCK_LATENCY_MS);
  return {
    failureRateBps: rows[0]?.mock_failure_rate_bps ?? (Number.isFinite(envRate) ? Math.round(envRate * 10000) : 0),
    latencyMs: rows[0]?.mock_latency_ms ?? (Number.isFinite(envLatency) ? envLatency : 1500),
  };
}

const gateway = () => getGateway({ query: (sql, params) => db.runQuery(sql, params), loadBehavior: loadMockBehavior });

// Agenda algo para depois do COMMIT (chamada ao gateway): nunca chamar o PSP
// com a transação aberta, nem avisar de algo que acabou desfeito.
function afterCommit(client, callback) {
  const run = () => Promise.resolve().then(callback).catch((error) => console.error("payments afterCommit:", error.message));
  if (typeof client.afterCommit === "function") client.afterCommit(run);
  else run();
}

// Impressão digital do pedido: mesma chave de idempotência com outro conteúdo
// é recusada (422), nunca vira uma segunda cobrança.
function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_\-:.]{8,200}$/;

function requireIdempotencyKey(request) {
  const key = request.get("Idempotency-Key");
  if (!key || !IDEMPOTENCY_KEY_PATTERN.test(key))
    throw new ApiError(400, "idempotency_key_required", "Envie o header Idempotency-Key (8 a 200 caracteres) em toda operação de cobrança.");
  // a chave vale por usuário: duas contas nunca colidem
  return `${request.user.id}:${key}`;
}

function assertSameRequest(storedFingerprint, currentFingerprint) {
  if (storedFingerprint !== currentFingerprint)
    throw new ApiError(422, "idempotency_key_reuse", "Esta chave de idempotência já foi usada com outro conteúdo.");
}

// Coluna numeric(10,2) legada → centavos inteiros, sem passar por float
function centsFromDecimal(value) {
  const [whole, fraction = ""] = String(value ?? "0").split(".");
  const sign = whole.startsWith("-") ? -1 : 1;
  return sign * (Math.abs(Number(whole)) * 100 + Number(`${fraction}00`.slice(0, 2)));
}

// Centavos → texto decimal para colunas numeric legadas ('32.19')
function decimalFromCents(cents) {
  return `${Math.trunc(cents / 100)}.${String(Math.abs(cents % 100)).padStart(2, "0")}`;
}

module.exports = {
  gateway,
  isDemoMode,
  loadMockBehavior,
  afterCommit,
  fingerprint,
  requireIdempotencyKey,
  assertSameRequest,
  centsFromDecimal,
  decimalFromCents,
};
