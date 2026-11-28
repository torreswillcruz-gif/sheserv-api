// Interface que todo adapter de PSP implementa. O domínio só conhece esta
// classe, recipientId e os eventos normalizados de webhook: nenhuma
// credencial, URL ou formato de PSP sai do adapter.
//
// Convenções:
// - valores sempre em centavos inteiros;
// - split sempre em centavos absolutos, nunca percentual;
// - toda operação que move dinheiro recebe idempotencyKey obrigatória;
// - tokens de cartão são opacos e NÃO portáveis entre PSPs (não abstraímos
//   tokenização: o app tokeniza direto no PSP ativo e manda o token).

/**
 * @typedef {{ recipientId: string|null, parte: 'prestadora'|'plataforma', valor: number }} SplitItem
 *   recipientId null = conta da plataforma (no Pagar.me, o recebedor padrão da conta).
 * @typedef {{ titular: 'plataforma'|'recebedor', itens: SplitItem[] }} Split
 * @typedef {{ tipo: 'pix' } | { tipo: 'cartao', tokenDoGateway: string }
 *   | { tipo: 'cartao', cartaoId: string, clienteId?: string }} MetodoPagamento
 *   cartaoId = cartão salvo no PSP (saveCard); tokenDoGateway = token de uso único.
 * @typedef {{ intervalo: 'semanal'|'mensal', dia: number }} CalendarioRepasse
 * @typedef {{ unidade: 'week'|'month', quantidade: number }} Periodicidade
 * @typedef {{ tentativas: number, intervaloDias: number }} PoliticaRetentativa
 * @typedef {{ tipo: 'cobranca'|'assinatura', id: string }} Referencia  nosso id, volta no webhook
 *
 * @typedef {'PAYMENT_CONFIRMED'|'PAYMENT_FAILED'|'PAYMENT_REFUNDED'|'RECIPIENT_APPROVED'|'RECIPIENT_REJECTED'
 *   |'RECIPIENT_KYC_APPROVED'|'RECIPIENT_KYC_REJECTED'} WebhookEventType
 *   KYC = prova de vida/validação cadastral do recebedor feita pelo PSP.
 * @typedef {{
 *   eventId: string, tipo: WebhookEventType, ocorridoEm: string,
 *   gatewayChargeId?: string, gatewaySubscriptionId?: string, recipientId?: string,
 *   referencia?: Referencia, valor?: number, ciclo?: number, tentativa?: number,
 *   metodo?: 'pix'|'cartao', motivo?: string, gatewayRefundId?: string,
 *   bruto: object
 * }} WebhookEvent
 */

const WEBHOOK_EVENT_TYPES = [
  "PAYMENT_CONFIRMED", "PAYMENT_FAILED", "PAYMENT_REFUNDED",
  "RECIPIENT_APPROVED", "RECIPIENT_REJECTED", "RECIPIENT_KYC_APPROVED", "RECIPIENT_KYC_REJECTED",
];

class GatewayError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

class NotImplementedGatewayError extends GatewayError {
  constructor(gatewayName, method) {
    super("not_implemented", `${gatewayName}.${method} ainda não foi implementado.`);
  }
}

function assertCents(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new GatewayError("invalid_amount", `${name} precisa ser centavos inteiros.`);
}

function assertIdempotencyKey(key) {
  if (typeof key !== "string" || key.length < 8 || key.length > 200)
    throw new GatewayError("idempotency_key_required", "idempotencyKey é obrigatória (8 a 200 caracteres).");
}

// O split precisa somar exatamente o total, em centavos absolutos
function assertSplit(split, valorTotal) {
  if (!split || !["plataforma", "recebedor"].includes(split.titular) || !Array.isArray(split.itens) || split.itens.length === 0)
    throw new GatewayError("invalid_split", "Split inválido.");
  let sum = 0;
  for (const item of split.itens) {
    assertCents(item.valor, "split.valor");
    sum += item.valor;
  }
  if (sum !== valorTotal) throw new GatewayError("invalid_split", `O split soma ${sum}, o total é ${valorTotal}.`);
}

class PaymentGateway {
  /** @returns {string} */
  get nome() { throw new NotImplementedGatewayError(this.constructor.name, "nome"); }

  /** @returns {{ emiteNfse: boolean, temEscrow: boolean, temAntecipacao: boolean,
   *   titularDaCobranca: 'plataforma'|'recebedor', intervalosDeRepasse: string[] }} */
  capabilities() { throw new NotImplementedGatewayError(this.nome, "capabilities"); }

  /** Cria o recebedor da prestadora (sem login dela no PSP).
   * @returns {Promise<{ recipientId: string, status: 'em_analise'|'aprovada'|'recusada' }>} */
  async createRecipient(_dadosPrestadora, _dadosBancarios, _opcoes) { throw new NotImplementedGatewayError(this.nome, "createRecipient"); }

  /** @returns {Promise<{ status: 'em_analise'|'aprovada'|'recusada', motivo?: string }>} */
  async getRecipientStatus(_recipientId) { throw new NotImplementedGatewayError(this.nome, "getRecipientStatus"); }

  /** @param {CalendarioRepasse} _calendario */
  async updateRecipientPayoutSchedule(_recipientId, _calendario) { throw new NotImplementedGatewayError(this.nome, "updateRecipientPayoutSchedule"); }

  /** Link da prova de vida (KYC) do recebedor, aberto pela prestadora no
   * celular. O resultado chega por webhook (RECIPIENT_KYC_APPROVED/REJECTED).
   * No Pagar.me: POST /recipients/{id}/kyc_link.
   * @returns {Promise<{ url: string, expiraEm: string|null }>} */
  async createKycLink(_recipientId) { throw new NotImplementedGatewayError(this.nome, "createKycLink"); }

  /** Salva o cartão (a partir do token de uso único) na cliente do PSP.
   * `exibicao` só é usada se o PSP não devolver bandeira/final/validade.
   * @param {{ cliente: { nome: string, email: string, documento?: string }, clienteId?: string|null,
   *   token: string, exibicao?: { final?: string, bandeira?: string, mesValidade?: number, anoValidade?: number, titular?: string } }} _dados
   * @returns {Promise<{ cartaoId: string, clienteId: string|null, final: string, bandeira: string|null,
   *   mesValidade: number|null, anoValidade: number|null }>} */
  async saveCard(_dados) { throw new NotImplementedGatewayError(this.nome, "saveCard"); }

  /** Apaga o cartão salvo no PSP. */
  async deleteCard(_clienteId, _cartaoId) { throw new NotImplementedGatewayError(this.nome, "deleteCard"); }

  /** Assinatura recorrente no cartão. A 1ª cobrança é feita na criação e
   * confirmada por webhook.
   * @returns {Promise<{ subscriptionId: string, status: string }>} */
  async createSubscription(_dados) { throw new NotImplementedGatewayError(this.nome, "createSubscription"); }

  /** Muda valor e/ou split a partir do próximo ciclo (preço repactuado ou
   * desconto de repasse no ciclo). */
  async updateSubscriptionAmount(_subscriptionId, _dados) { throw new NotImplementedGatewayError(this.nome, "updateSubscriptionAmount"); }

  /** Cancela a recorrência: nenhuma cobrança nova depois do ciclo em curso. */
  async cancelSubscription(_subscriptionId, _opcoes) { throw new NotImplementedGatewayError(this.nome, "cancelSubscription"); }

  /** Cobrança avulsa. Confirmada só por webhook.
   * @returns {Promise<{ chargeId: string, status: 'processando', pix?: { copiaECola: string, expiraEm: string } }>} */
  async createCharge(_dados) { throw new NotImplementedGatewayError(this.nome, "createCharge"); }

  /** Estorno total ou parcial; reverte o split, inclusive a taxa da plataforma.
   * @returns {Promise<{ refundId: string, status: 'processando'|'concluido' }>} */
  async refund(_chargeId, _valor, _opcoes) { throw new NotImplementedGatewayError(this.nome, "refund"); }

  /** Confere a assinatura do webhook e converte para o enum próprio.
   * Lança GatewayError('invalid_signature') se a assinatura não bater.
   * @returns {WebhookEvent} */
  parseWebhook(_headers, _rawBody) { throw new NotImplementedGatewayError(this.nome, "parseWebhook"); }
}

module.exports = {
  PaymentGateway,
  GatewayError,
  NotImplementedGatewayError,
  WEBHOOK_EVENT_TYPES,
  assertCents,
  assertIdempotencyKey,
  assertSplit,
};
