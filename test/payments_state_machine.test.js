const assert = require("node:assert/strict");
const { describe, test } = require("node:test");
const { STATES, EVENTS, EFFECTS, transition, canTransition, InvalidTransitionError, OCCUPIES_SEAT } = require("../src/payments/subscriptionStateMachine");

// Todas as transições válidas, com o estado de destino e os efeitos esperados
const VALID = [
  ["pendente", EVENTS.PAYMENT_CONFIRMED, {}, "ativa", [EFFECTS.START_FIRST_CYCLE, EFFECTS.GRANT_ENTITLEMENTS]],
  ["pendente", EVENTS.PAYMENT_FAILED, {}, "cancelada", [EFFECTS.MARK_CANCELED, EFFECTS.CANCEL_AT_GATEWAY]],
  ["ativa", EVENTS.PAYMENT_CONFIRMED, {}, "ativa", [EFFECTS.START_NEXT_CYCLE, EFFECTS.GRANT_ENTITLEMENTS]],
  ["ativa", EVENTS.PAYMENT_FAILED, {}, "em_retentativa",
    [EFFECTS.START_NEXT_CYCLE, EFFECTS.GRANT_ENTITLEMENTS, EFFECTS.FREEZE_ENTITLEMENTS, EFFECTS.SCHEDULE_RETRY]],
  ["ativa", EVENTS.PERIOD_ENDED_WITH_CANCEL, {}, "cancelada", [EFFECTS.MARK_CANCELED]],
  ["em_retentativa", EVENTS.PAYMENT_CONFIRMED, {}, "ativa", [EFFECTS.UNFREEZE_ENTITLEMENTS, EFFECTS.CLEAR_RETRY]],
  ["em_retentativa", EVENTS.PAYMENT_FAILED, { isLastAttempt: false }, "em_retentativa", [EFFECTS.SCHEDULE_RETRY]],
  ["em_retentativa", EVENTS.PAYMENT_FAILED, { isLastAttempt: true }, "suspensa",
    [EFFECTS.VOID_ENTITLEMENTS, EFFECTS.CLEAR_RETRY, EFFECTS.MARK_SUSPENDED]],
  ["em_retentativa", EVENTS.CUSTOMER_CANCELED, {}, "cancelada",
    [EFFECTS.VOID_ENTITLEMENTS, EFFECTS.CLEAR_RETRY, EFFECTS.MARK_CANCELED, EFFECTS.CANCEL_AT_GATEWAY]],
  ["suspensa", EVENTS.SUSPENSION_EXPIRED, {}, "cancelada", [EFFECTS.MARK_CANCELED, EFFECTS.CANCEL_AT_GATEWAY]],
];

describe("máquina de estados da assinatura", () => {
  for (const [from, event, context, to, effects] of VALID) {
    const label = `${from} --${event}${"isLastAttempt" in context ? `(última=${context.isLastAttempt})` : ""}--> ${to}`;
    test(label, () => {
      assert.deepEqual(transition(from, event, context), { from, to, effects });
      assert.equal(canTransition(from, event), true);
    });
  }

  test("toda combinação fora da tabela é rejeitada", () => {
    const validPairs = new Set(VALID.map(([from, event]) => `${from}|${event}`));
    let rejected = 0;
    for (const from of STATES) {
      for (const event of Object.values(EVENTS)) {
        if (validPairs.has(`${from}|${event}`)) continue;
        assert.throws(() => transition(from, event, { isLastAttempt: true }), InvalidTransitionError, `${from} --${event}`);
        assert.equal(canTransition(from, event), false);
        rejected++;
      }
    }
    assert.equal(rejected, STATES.length * Object.keys(EVENTS).length - validPairs.size);
  });

  test("cancelada é terminal", () => {
    for (const event of Object.values(EVENTS)) assert.throws(() => transition("cancelada", event), { code: "invalid_transition" });
  });

  test("estado desconhecido é rejeitado", () => {
    assert.throws(() => transition("ativo", EVENTS.PAYMENT_CONFIRMED), { code: "invalid_transition" });
  });

  test("falha de pagamento nunca cancela uma assinatura que já começou", () => {
    assert.equal(transition("ativa", EVENTS.PAYMENT_FAILED).to, "em_retentativa");
    assert.equal(transition("em_retentativa", EVENTS.PAYMENT_FAILED, { isLastAttempt: true }).to, "suspensa");
  });

  test("falha em retentativa exige saber se é a última tentativa", () => {
    assert.throws(() => transition("em_retentativa", EVENTS.PAYMENT_FAILED), TypeError);
  });

  test("ocupam vaga no Free: pendente, ativa e em retentativa", () => {
    assert.deepEqual(OCCUPIES_SEAT, ["pendente", "ativa", "em_retentativa"]);
  });
});
