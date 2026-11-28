// MockGateway: o único adapter funcional por enquanto. Imita um PSP no
// formato do Pagar.me (cobrança na conta da plataforma, split em centavos
// para o recebedor), sem nenhuma chamada externa.
//
// Comportamento:
// - aprova por padrão; recusa com a probabilidade da configuração
//   (mock_failure_rate_bps no admin; MOCK_FAILURE_RATE, de 0 a 1, só se a
//   configuração não existir) e responde com latência artificial;
// - tokens de teste: 'tok_mock_aprovar' sempre aprova, 'tok_mock_recusar'
//   sempre recusa;
// - conta bancária só com zeros: recebedor recusado;
// - dispara os mesmos webhooks que um PSP real, chamando o endpoint da própria
//   API, assinados com HMAC (header x-mock-signature);
// - o estado fica no banco (mock_gateway_objects e mock_scheduled_webhooks):
//   o Render free hiberna, e estado em memória perderia os webhooks.
//
// Jobs agendados (mock_scheduled_webhooks.payload.action):
//   settle_charge     decide aprovação/recusa e dispara o webhook
//   bill_subscription cobra um ciclo (ou uma retentativa) da assinatura
//   settle_refund     conclui o estorno e dispara o webhook
//   settle_recipient  aprova/recusa o recebedor e dispara o webhook
//   deliver           entrega um webhook (repetida com espera se falhar)

const crypto = require("crypto");
const { PaymentGateway, GatewayError, assertCents, assertIdempotencyKey, assertSplit } = require("./PaymentGateway");
const { cycleStart, DAY_MS } = require("../dates");

const RAW_TYPE_TO_EVENT = {
  "charge.paid": "PAYMENT_CONFIRMED",
  "charge.payment_failed": "PAYMENT_FAILED",
  "charge.refunded": "PAYMENT_REFUNDED",
  "recipient.approved": "RECIPIENT_APPROVED",
  "recipient.refused": "RECIPIENT_REJECTED",
};

const DECLINE_REASONS = [
  ["card_declined", "Cartão recusado pelo emissor."],
  ["insufficient_funds", "Saldo ou limite insuficiente."],
  ["expired_card", "Cartão vencido."],
];

const newId = (prefix) => `${prefix}_mock_${crypto.randomBytes(9).toString("base64url")}`;

function defaultWebhookSecret() {
  return process.env.MOCK_WEBHOOK_SECRET
    || crypto.createHash("sha256").update(`mock-webhook:${process.env.DATA_ENCRYPTION_KEY || ""}`).digest("hex");
}

function sign(secret, rawBody) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

class MockGateway extends PaymentGateway {
  /**
   * @param {object} options
   * @param {(sql: string, params?: any[]) => Promise<{rows: any[]}>} options.query
   * @param {() => Promise<{ failureRateBps: number, latencyMs: number }>} options.loadBehavior
   * @param {(rawBody: string, headers: object) => Promise<void>} [options.deliver] entrega do webhook (padrão: HTTP para a própria API)
   * @param {string} [options.webhookUrl]
   * @param {string} [options.secret]
   * @param {() => number} [options.random] número em [0, 10000) para a recusa (testes)
   * @param {boolean} [options.autoPump] dispara o processamento logo depois da latência
   */
  constructor({ query, loadBehavior, deliver, webhookUrl, secret, random, autoPump = true }) {
    super();
    this.query = query;
    this.loadBehavior = loadBehavior;
    this.secret = secret || defaultWebhookSecret();
    this.webhookUrl = webhookUrl
      || process.env.PAYMENT_WEBHOOK_URL
      || `http://127.0.0.1:${process.env.PORT || 3000}/webhooks/payments`;
    this.deliver = deliver || ((rawBody, headers) => this.#deliverByHttp(rawBody, headers));
    this.random = random || (() => crypto.randomInt(10000));
    this.autoPump = autoPump;
    this.pumping = null;
  }

  get nome() { return "mock"; }

  capabilities() {
    return {
      emiteNfse: false,
      temEscrow: false,
      temAntecipacao: false,
      titularDaCobranca: "plataforma",
      intervalosDeRepasse: ["semanal", "mensal"],
    };
  }

  // ---------- Recebedor ----------

  async createRecipient(dadosPrestadora, dadosBancarios, { calendarioRepasse, idempotencyKey } = {}) {
    assertIdempotencyKey(idempotencyKey);
    const existing = await this.#findByIdempotencyKey(idempotencyKey);
    if (existing) return { recipientId: existing.gateway_id, status: existing.state.status };

    if (!dadosPrestadora?.nome || !dadosPrestadora?.documento || !dadosBancarios?.conta)
      throw new GatewayError("invalid_recipient", "Dados do recebedor incompletos.");
    const recipientId = newId("rp");
    const refuse = /^0+$/.test(String(dadosBancarios.conta).replace(/\D/g, ""));
    await this.#save(recipientId, "recipient", {
      status: "em_analise",
      nome: dadosPrestadora.nome,
      documentoFinal: String(dadosPrestadora.documento).slice(-4),
      contaFinal: String(dadosBancarios.conta).slice(-4),
      calendario: calendarioRepasse ?? null,
      decisao: refuse ? "recusada" : "aprovada",
    }, idempotencyKey);
    await this.#schedule({ action: "settle_recipient", recipientId });
    return { recipientId, status: "em_analise" };
  }

  async getRecipientStatus(recipientId) {
    const recipient = await this.#load(recipientId, "recipient");
    return { status: recipient.state.status, motivo: recipient.state.motivo };
  }

  async updateRecipientPayoutSchedule(recipientId, calendario) {
    if (!this.capabilities().intervalosDeRepasse.includes(calendario?.intervalo))
      throw new GatewayError("invalid_schedule", "Calendário de repasse não suportado.");
    const recipient = await this.#load(recipientId, "recipient");
    await this.#save(recipientId, "recipient", { ...recipient.state, calendario });
  }

  // ---------- Assinatura ----------

  async createSubscription({ recipientId, valorTotal, split, periodicidade, inicio, metodoPagamento, politicaRetentativa, referencia, idempotencyKey }) {
    assertIdempotencyKey(idempotencyKey);
    assertCents(valorTotal, "valorTotal");
    assertSplit(split, valorTotal);
    if (metodoPagamento?.tipo !== "cartao" || !metodoPagamento.tokenDoGateway)
      throw new GatewayError("invalid_payment_method", "Assinatura só no cartão.");
    const existing = await this.#findByIdempotencyKey(idempotencyKey);
    if (existing) return { subscriptionId: existing.gateway_id, status: existing.state.status };
    await this.#load(recipientId, "recipient");

    const subscriptionId = newId("sub");
    const startedAt = new Date(inicio ?? Date.now());
    await this.#save(subscriptionId, "subscription", {
      status: "ativa",
      recipientId,
      valorTotal,
      split,
      periodicidade,
      inicio: startedAt.toISOString(),
      diaAncora: Number(startedAt.toLocaleString("en-US", { timeZone: "America/Sao_Paulo", day: "numeric" })),
      token: metodoPagamento.tokenDoGateway,
      politica: politicaRetentativa ?? { tentativas: 3, intervaloDias: 2 },
      referencia,
      cicloAtual: 0,
    }, idempotencyKey);
    // 1ª cobrança agora
    await this.#schedule({ action: "bill_subscription", subscriptionId, cycle: 1, attempt: 1 }, 0);
    return { subscriptionId, status: "ativa" };
  }

  async updateSubscriptionAmount(subscriptionId, { valorTotal, split, idempotencyKey }) {
    assertIdempotencyKey(idempotencyKey);
    assertCents(valorTotal, "valorTotal");
    assertSplit(split, valorTotal);
    const subscription = await this.#load(subscriptionId, "subscription");
    if (subscription.state.status !== "ativa") throw new GatewayError("subscription_canceled", "Assinatura cancelada no gateway.");
    await this.#save(subscriptionId, "subscription", { ...subscription.state, valorTotal, split });
  }

  async cancelSubscription(subscriptionId) {
    const subscription = await this.#load(subscriptionId, "subscription");
    if (subscription.state.status === "cancelada") return { status: "cancelada" };
    await this.#save(subscriptionId, "subscription", { ...subscription.state, status: "cancelada" });
    await this.query(
      `DELETE FROM mock_scheduled_webhooks
       WHERE sent_at IS NULL AND payload->>'action'='bill_subscription' AND payload->>'subscriptionId'=$1`,
      [subscriptionId]
    );
    return { status: "cancelada" };
  }

  // ---------- Cobrança avulsa e estorno ----------

  async createCharge({ recipientId, valorTotal, split, metodoPagamento, referencia, idempotencyKey }) {
    assertIdempotencyKey(idempotencyKey);
    assertCents(valorTotal, "valorTotal");
    assertSplit(split, valorTotal);
    if (!["pix", "cartao"].includes(metodoPagamento?.tipo)) throw new GatewayError("invalid_payment_method", "Meio de pagamento inválido.");
    const existing = await this.#findByIdempotencyKey(idempotencyKey);
    if (existing) return this.#chargeResponse(existing.gateway_id, existing.state);
    await this.#load(recipientId, "recipient");

    const chargeId = newId("ch");
    const state = {
      status: "processando",
      valorTotal,
      split,
      metodo: metodoPagamento.tipo,
      token: metodoPagamento.tokenDoGateway ?? null,
      referencia,
      estornado: 0,
      pix: metodoPagamento.tipo === "pix"
        ? { copiaECola: `00020126MOCK${crypto.randomBytes(12).toString("hex").toUpperCase()}5204000053039865802BR`, expiraEm: new Date(Date.now() + 30 * 60000).toISOString() }
        : null,
    };
    await this.#save(chargeId, "charge", state, idempotencyKey);
    await this.#schedule({ action: "settle_charge", chargeId });
    return this.#chargeResponse(chargeId, state);
  }

  async refund(chargeId, valor, { idempotencyKey } = {}) {
    assertIdempotencyKey(idempotencyKey);
    assertCents(valor, "valor");
    const existing = await this.#findByIdempotencyKey(idempotencyKey);
    if (existing) return { refundId: existing.gateway_id, status: existing.state.status };
    const charge = await this.#load(chargeId, "charge");
    if (charge.state.status !== "paga" && charge.state.status !== "estornada_parcial")
      throw new GatewayError("charge_not_paid", "Só é possível estornar cobrança paga.");
    if (valor === 0 || charge.state.estornado + valor > charge.state.valorTotal)
      throw new GatewayError("invalid_refund", "Valor de estorno maior que o disponível.");

    const refundId = newId("re");
    await this.#save(refundId, "refund", { status: "processando", chargeId, valor }, idempotencyKey);
    await this.#schedule({ action: "settle_refund", refundId });
    return { refundId, status: "processando" };
  }

  // ---------- Webhook ----------

  parseWebhook(headers, rawBody) {
    const received = String(headers["x-mock-signature"] ?? "");
    const expected = sign(this.secret, rawBody);
    if (received.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected)))
      throw new GatewayError("invalid_signature", "Assinatura do webhook inválida.");
    let raw;
    try {
      raw = JSON.parse(rawBody);
    } catch {
      throw new GatewayError("invalid_payload", "Webhook com JSON inválido.");
    }
    const tipo = RAW_TYPE_TO_EVENT[raw.type];
    if (!tipo || !raw.id) throw new GatewayError("unknown_event", `Evento desconhecido: ${raw.type}`);
    const data = raw.data ?? {};
    return {
      eventId: raw.id,
      tipo,
      ocorridoEm: raw.created_at,
      gatewayChargeId: data.charge_id ?? (tipo.startsWith("PAYMENT") ? data.id : undefined),
      gatewaySubscriptionId: data.subscription_id ?? undefined,
      recipientId: data.recipient_id ?? undefined,
      referencia: data.metadata?.ref_type ? { tipo: data.metadata.ref_type, id: data.metadata.ref_id } : undefined,
      valor: data.amount,
      ciclo: data.cycle ?? undefined,
      tentativa: data.attempt ?? undefined,
      metodo: data.payment_method === "pix" ? "pix" : data.payment_method === "credit_card" ? "cartao" : undefined,
      motivo: data.last_transaction?.gateway_response?.message ?? data.reason ?? undefined,
      gatewayRefundId: data.refund_id ?? undefined,
      bruto: raw,
    };
  }

  // ---------- Só do mock (endpoints de demonstração) ----------

  // Decide agora o resultado de uma cobrança ainda em processamento
  async forceChargeOutcome(chargeId, outcome) {
    const charge = await this.#load(chargeId, "charge");
    if (charge.state.status !== "processando")
      throw new GatewayError("charge_not_pending", `A cobrança já está ${charge.state.status} no gateway.`);
    await this.#save(chargeId, "charge", { ...charge.state, resultadoForcado: outcome });
    await this.query(
      `UPDATE mock_scheduled_webhooks SET fire_at=now()
       WHERE sent_at IS NULL AND payload->>'action'='settle_charge' AND payload->>'chargeId'=$1`,
      [chargeId]
    );
    await this.pump();
  }

  // "Vira o mês": antecipa a próxima cobrança (renovação ou retentativa)
  // da assinatura para agora, com resultado opcional forçado.
  async advanceSubscription(subscriptionId, outcome) {
    const subscription = await this.#load(subscriptionId, "subscription");
    if (subscription.state.status !== "ativa") throw new GatewayError("subscription_canceled", "Assinatura cancelada no gateway.");
    await this.#save(subscriptionId, "subscription", { ...subscription.state, proximoResultadoForcado: outcome ?? null });
    const { rows } = await this.query(
      `UPDATE mock_scheduled_webhooks SET fire_at=now()
       WHERE sent_at IS NULL AND payload->>'action'='bill_subscription' AND payload->>'subscriptionId'=$1
       RETURNING id`,
      [subscriptionId]
    );
    if (!rows.length) throw new GatewayError("nothing_to_bill", "Nenhuma cobrança agendada para esta assinatura.");
    await this.pump();
  }

  // Processa os jobs vencidos. Chamado pelo agendador da API e logo depois de
  // cada operação (com a latência artificial).
  pump() {
    if (!this.pumping) {
      this.pumping = this.#pumpOnce().finally(() => { this.pumping = null; });
    }
    return this.pumping;
  }

  // ---------- Internos ----------

  async #pumpOnce() {
    for (let round = 0; round < 10; round++) {
      // "aluga" os jobs vencidos por 30 s (outra instância não pega os mesmos)
      const { rows: jobs } = await this.query(
        `UPDATE mock_scheduled_webhooks SET attempts=attempts+1, fire_at=now() + interval '30 seconds'
         WHERE id IN (
           SELECT id FROM mock_scheduled_webhooks
           WHERE sent_at IS NULL AND fire_at <= now()
           ORDER BY fire_at LIMIT 20 FOR UPDATE SKIP LOCKED)
         RETURNING id, payload, attempts`
      );
      if (!jobs.length) return;
      for (const job of jobs) {
        try {
          await this.#runJob(job.payload);
          await this.query("UPDATE mock_scheduled_webhooks SET sent_at=now(), last_error=NULL WHERE id=$1", [job.id]);
        } catch (error) {
          // espera crescente, como os PSPs fazem com webhook que falhou
          const waitSeconds = Math.min(3600, 5 * 2 ** Math.min(job.attempts, 10));
          await this.query(
            "UPDATE mock_scheduled_webhooks SET last_error=$2, fire_at=now() + make_interval(secs => $3) WHERE id=$1",
            [job.id, String(error.message).slice(0, 500), waitSeconds]
          );
        }
      }
    }
  }

  async #runJob(job) {
    if (job.action === "deliver") return this.#deliverEvent(job.event);
    if (job.action === "settle_recipient") return this.#settleRecipient(job.recipientId);
    if (job.action === "settle_charge") return this.#settleCharge(job.chargeId);
    if (job.action === "settle_refund") return this.#settleRefund(job.refundId);
    if (job.action === "bill_subscription") return this.#billSubscription(job);
    throw new Error(`Job desconhecido: ${job.action}`);
  }

  async #settleRecipient(recipientId) {
    const recipient = await this.#load(recipientId, "recipient");
    if (recipient.state.status !== "em_analise") return;
    const approved = recipient.state.decisao === "aprovada";
    const motivo = approved ? null : "Dados bancários inválidos.";
    await this.#save(recipientId, "recipient", { ...recipient.state, status: approved ? "aprovada" : "recusada", motivo });
    await this.#emit(approved ? "recipient.approved" : "recipient.refused", { recipient_id: recipientId, reason: motivo });
  }

  #decide(state, forced) {
    if (forced === "approve") return { ok: true };
    if (forced === "fail") return { ok: false, reason: DECLINE_REASONS[0] };
    if (state.token === "tok_mock_aprovar") return { ok: true };
    if (state.token === "tok_mock_recusar") return { ok: false, reason: DECLINE_REASONS[0] };
    return state.failureRateBps > this.random()
      ? { ok: false, reason: DECLINE_REASONS[this.random() % DECLINE_REASONS.length] }
      : { ok: true };
  }

  async #settleCharge(chargeId) {
    const charge = await this.#load(chargeId, "charge");
    if (charge.state.status !== "processando") return;
    const { failureRateBps } = await this.loadBehavior();
    const outcome = this.#decide({ ...charge.state, failureRateBps }, charge.state.resultadoForcado);
    const state = { ...charge.state, status: outcome.ok ? "paga" : "falhou", resultadoForcado: undefined };
    await this.#save(chargeId, "charge", state);

    if (state.assinatura) await this.#afterSubscriptionCharge(state, outcome.ok);
    await this.#emit(outcome.ok ? "charge.paid" : "charge.payment_failed", this.#chargePayload(chargeId, state, outcome.reason));
  }

  async #billSubscription({ subscriptionId, cycle, attempt }) {
    const subscription = await this.#load(subscriptionId, "subscription");
    if (subscription.state.status !== "ativa") return;
    const sub = subscription.state;
    const billingKey = `${subscriptionId}:${cycle}:${attempt}`;
    if (await this.#findByIdempotencyKey(billingKey)) return; // job repetido: o ciclo já foi cobrado
    const chargeId = newId("ch");
    const forced = sub.proximoResultadoForcado ?? null;
    await this.#save(chargeId, "charge", {
      status: "processando",
      valorTotal: sub.valorTotal,
      split: sub.split,
      metodo: "cartao",
      token: sub.token,
      referencia: sub.referencia,
      estornado: 0,
      assinatura: { subscriptionId, ciclo: cycle, tentativa: attempt },
      resultadoForcado: forced,
    }, billingKey);
    await this.#save(subscriptionId, "subscription", { ...sub, cicloAtual: cycle, proximoResultadoForcado: null });
    await this.#schedule({ action: "settle_charge", chargeId });
  }

  // Depois de cobrar um ciclo: agenda a próxima renovação (no aniversário) ou
  // a retentativa, como o PSP faria sozinho.
  async #afterSubscriptionCharge(chargeState, paid) {
    const { subscriptionId, ciclo, tentativa } = chargeState.assinatura;
    const subscription = await this.#load(subscriptionId, "subscription");
    const sub = subscription.state;
    if (sub.status !== "ativa") return;
    if (!paid && tentativa <= sub.politica.tentativas) {
      await this.#schedule(
        { action: "bill_subscription", subscriptionId, cycle: ciclo, attempt: tentativa + 1 },
        sub.politica.intervaloDias * DAY_MS
      );
      return;
    }
    if (!paid) return; // última tentativa recusada: a recorrência para (a API suspende)
    const nextStart = cycleStart(new Date(sub.inicio), ciclo, {
      intervalUnit: sub.periodicidade?.unidade ?? "month",
      intervalCount: sub.periodicidade?.quantidade ?? 1,
      anchorDay: sub.diaAncora,
    });
    await this.#schedule(
      { action: "bill_subscription", subscriptionId, cycle: ciclo + 1, attempt: 1 },
      Math.max(0, nextStart.getTime() - Date.now())
    );
  }

  async #settleRefund(refundId) {
    const refund = await this.#load(refundId, "refund");
    if (refund.state.status !== "processando") return;
    const charge = await this.#load(refund.state.chargeId, "charge");
    const estornado = charge.state.estornado + refund.state.valor;
    const chargeState = { ...charge.state, estornado, status: estornado === charge.state.valorTotal ? "estornada" : "estornada_parcial" };
    await this.#save(refund.state.chargeId, "charge", chargeState);
    await this.#save(refundId, "refund", { ...refund.state, status: "concluido" });
    await this.#emit("charge.refunded", {
      ...this.#chargePayload(refund.state.chargeId, chargeState),
      amount: refund.state.valor,
      refund_id: refundId,
      refunded_amount: estornado,
    });
  }

  #chargePayload(chargeId, state, reason) {
    return {
      id: chargeId,
      charge_id: chargeId,
      amount: state.valorTotal,
      payment_method: state.metodo === "pix" ? "pix" : "credit_card",
      subscription_id: state.assinatura?.subscriptionId,
      cycle: state.assinatura?.ciclo,
      attempt: state.assinatura?.tentativa,
      split: state.split,
      metadata: state.referencia ? { ref_type: state.referencia.tipo, ref_id: state.referencia.id } : {},
      last_transaction: reason ? { gateway_response: { code: reason[0], message: reason[1] } } : { gateway_response: { code: "approved" } },
    };
  }

  #chargeResponse(chargeId, state) {
    return { chargeId, status: "processando", ...(state.pix ? { pix: state.pix } : {}) };
  }

  async #emit(type, data) {
    const event = { id: newId("evt"), type, created_at: new Date().toISOString(), data };
    // a entrega vira um job: se a API não responder, é repetida com espera
    const { rows } = await this.query(
      "INSERT INTO mock_scheduled_webhooks (fire_at,payload) VALUES (now(),$1) RETURNING id",
      [{ action: "deliver", event }]
    );
    try {
      await this.#deliverEvent(event);
      await this.query("UPDATE mock_scheduled_webhooks SET sent_at=now(), attempts=attempts+1 WHERE id=$1", [rows[0].id]);
    } catch (error) {
      await this.query("UPDATE mock_scheduled_webhooks SET last_error=$2 WHERE id=$1", [rows[0].id, String(error.message).slice(0, 500)]);
    }
  }

  async #deliverEvent(event) {
    const rawBody = JSON.stringify(event);
    await this.deliver(rawBody, { "content-type": "application/json", "x-mock-signature": sign(this.secret, rawBody) });
  }

  async #deliverByHttp(rawBody, headers) {
    const response = await fetch(this.webhookUrl, { method: "POST", headers, body: rawBody, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Webhook respondeu ${response.status}`);
  }

  async #schedule(job, delayMs) {
    const { latencyMs } = await this.loadBehavior();
    const wait = delayMs ?? latencyMs;
    await this.query(
      "INSERT INTO mock_scheduled_webhooks (fire_at,payload) VALUES (now() + make_interval(secs => $1::float8 / 1000),$2)",
      [wait, job]
    );
    if (this.autoPump && wait < 60000) {
      setTimeout(() => this.pump().catch((error) => console.error("mock pump failed:", error.message)), wait + 20).unref();
    }
  }

  async #save(gatewayId, kind, state, idempotencyKey = null) {
    await this.query(
      `INSERT INTO mock_gateway_objects (gateway_id,kind,idempotency_key,state) VALUES ($1,$2,$3,$4)
       ON CONFLICT (gateway_id) DO UPDATE SET state=EXCLUDED.state, updated_at=now()`,
      [gatewayId, kind, idempotencyKey, state]
    );
  }

  async #load(gatewayId, kind) {
    const { rows } = await this.query("SELECT gateway_id, state FROM mock_gateway_objects WHERE gateway_id=$1 AND kind=$2", [gatewayId, kind]);
    if (!rows[0]) throw new GatewayError("not_found", `${kind} ${gatewayId} não existe no gateway.`);
    return rows[0];
  }

  async #findByIdempotencyKey(idempotencyKey) {
    const { rows } = await this.query("SELECT gateway_id, state FROM mock_gateway_objects WHERE idempotency_key=$1", [idempotencyKey]);
    return rows[0] ?? null;
  }
}

module.exports = { MockGateway, signMockWebhook: sign };
