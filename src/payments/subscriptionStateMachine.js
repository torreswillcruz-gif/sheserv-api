// Máquina de estados da assinatura. Pura: recebe o estado atual e o evento e
// devolve o próximo estado e os efeitos que o serviço precisa aplicar. Toda
// transição fora da tabela é rejeitada.
//
// pendente       → ativa           1ª cobrança paga
// pendente       → cancelada       1ª cobrança recusada (nada foi liberado)
// ativa          → ativa           renovação paga: novo ciclo, direitos resetados
// ativa          → em_retentativa  renovação falhou: direitos congelados
// ativa          → cancelada       fim do ciclo com cancelamento pedido
// em_retentativa → ativa           tentativa aprovada: direitos descongelados
// em_retentativa → em_retentativa  tentativa intermediária falhou
// em_retentativa → suspensa        última tentativa falhou: direitos zerados
// em_retentativa → cancelada       cliente cancela durante a retentativa
// suspensa       → cancelada       prazo da suspensão terminou
//
// Falha de pagamento nunca cancela direto (regra 4): entra em retentativa.

const STATES = ["pendente", "ativa", "em_retentativa", "suspensa", "cancelada"];

const EVENTS = {
  PAYMENT_CONFIRMED: "PAYMENT_CONFIRMED",
  PAYMENT_FAILED: "PAYMENT_FAILED",
  PERIOD_ENDED_WITH_CANCEL: "PERIOD_ENDED_WITH_CANCEL",
  CUSTOMER_CANCELED: "CUSTOMER_CANCELED",
  SUSPENSION_EXPIRED: "SUSPENSION_EXPIRED",
};

// Efeitos que o serviço executa (na mesma transação da transição)
const EFFECTS = {
  START_FIRST_CYCLE: "START_FIRST_CYCLE",     // ciclo 1 começa agora
  START_NEXT_CYCLE: "START_NEXT_CYCLE",       // avança para o ciclo seguinte (aniversário)
  GRANT_ENTITLEMENTS: "GRANT_ENTITLEMENTS",   // cria os direitos do ciclo (não acumulam)
  FREEZE_ENTITLEMENTS: "FREEZE_ENTITLEMENTS", // congelado = derivado do status; só registra
  UNFREEZE_ENTITLEMENTS: "UNFREEZE_ENTITLEMENTS",
  VOID_ENTITLEMENTS: "VOID_ENTITLEMENTS",     // zera os direitos do ciclo
  SCHEDULE_RETRY: "SCHEDULE_RETRY",
  CLEAR_RETRY: "CLEAR_RETRY",
  MARK_SUSPENDED: "MARK_SUSPENDED",
  MARK_CANCELED: "MARK_CANCELED",
  CANCEL_AT_GATEWAY: "CANCEL_AT_GATEWAY",
};

class InvalidTransitionError extends Error {
  constructor(from, event) {
    super(`Transição inválida: ${from} --${event}-->`);
    this.code = "invalid_transition";
    this.from = from;
    this.event = event;
  }
}

// estado → evento → (contexto) → { to, effects }
const TRANSITIONS = {
  pendente: {
    PAYMENT_CONFIRMED: () => ({
      to: "ativa",
      effects: [EFFECTS.START_FIRST_CYCLE, EFFECTS.GRANT_ENTITLEMENTS],
    }),
    PAYMENT_FAILED: () => ({
      to: "cancelada",
      effects: [EFFECTS.MARK_CANCELED, EFFECTS.CANCEL_AT_GATEWAY],
    }),
  },
  ativa: {
    // renovação paga: o ciclo novo começa no aniversário e os direitos resetam
    PAYMENT_CONFIRMED: () => ({
      to: "ativa",
      effects: [EFFECTS.START_NEXT_CYCLE, EFFECTS.GRANT_ENTITLEMENTS],
    }),
    // renovação recusada: o ciclo novo começa (o aniversário chegou), mas com
    // os direitos congelados até uma tentativa ser aprovada
    PAYMENT_FAILED: () => ({
      to: "em_retentativa",
      effects: [EFFECTS.START_NEXT_CYCLE, EFFECTS.GRANT_ENTITLEMENTS, EFFECTS.FREEZE_ENTITLEMENTS, EFFECTS.SCHEDULE_RETRY],
    }),
    PERIOD_ENDED_WITH_CANCEL: () => ({
      to: "cancelada",
      effects: [EFFECTS.MARK_CANCELED],
    }),
  },
  em_retentativa: {
    PAYMENT_CONFIRMED: () => ({
      to: "ativa",
      effects: [EFFECTS.UNFREEZE_ENTITLEMENTS, EFFECTS.CLEAR_RETRY],
    }),
    PAYMENT_FAILED: ({ isLastAttempt }) => (isLastAttempt
      ? { to: "suspensa", effects: [EFFECTS.VOID_ENTITLEMENTS, EFFECTS.CLEAR_RETRY, EFFECTS.MARK_SUSPENDED] }
      : { to: "em_retentativa", effects: [EFFECTS.SCHEDULE_RETRY] }),
    CUSTOMER_CANCELED: () => ({
      to: "cancelada",
      effects: [EFFECTS.VOID_ENTITLEMENTS, EFFECTS.CLEAR_RETRY, EFFECTS.MARK_CANCELED, EFFECTS.CANCEL_AT_GATEWAY],
    }),
  },
  suspensa: {
    SUSPENSION_EXPIRED: () => ({
      to: "cancelada",
      effects: [EFFECTS.MARK_CANCELED, EFFECTS.CANCEL_AT_GATEWAY],
    }),
  },
  cancelada: {},
};

function transition(from, event, context = {}) {
  if (!STATES.includes(from)) throw new InvalidTransitionError(from, event);
  const handler = TRANSITIONS[from][event];
  if (!handler) throw new InvalidTransitionError(from, event);
  if (event === EVENTS.PAYMENT_FAILED && from === "em_retentativa" && typeof context.isLastAttempt !== "boolean")
    throw new TypeError("PAYMENT_FAILED em retentativa exige context.isLastAttempt");
  return { from, ...handler(context) };
}

const canTransition = (from, event) => Boolean(TRANSITIONS[from]?.[event]);

// Estados que ocupam vaga no limite do Free (assinante ativa): pendente,
// ativa (inclusive com cancelamento agendado, até o fim do ciclo) e em
// retentativa.
const OCCUPIES_SEAT = ["pendente", "ativa", "em_retentativa"];

// Direitos usáveis só com a assinatura ativa (em retentativa ficam congelados)
const ENTITLEMENTS_USABLE = ["ativa"];

module.exports = {
  STATES,
  EVENTS,
  EFFECTS,
  TRANSITIONS,
  OCCUPIES_SEAT,
  ENTITLEMENTS_USABLE,
  InvalidTransitionError,
  transition,
  canTransition,
};
