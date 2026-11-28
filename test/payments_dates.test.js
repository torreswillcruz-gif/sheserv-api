const assert = require("node:assert/strict");
const { describe, test } = require("node:test");
const dates = require("../src/payments/dates");

const monthly = (anchorDay) => ({ intervalUnit: "month", intervalCount: 1, anchorDay });
const key = (date) => dates.brasiliaDateKey(date);

describe("aniversário da assinatura", () => {
  test("renova no mesmo dia do mês em que começou, não no dia 1", () => {
    const start = new Date("2026-09-15T13:00:00-03:00");
    assert.equal(key(dates.cycleStart(start, 1, monthly(15))), "2026-10-15");
    assert.equal(key(dates.cycleStart(start, 3, monthly(15))), "2026-12-15");
  });

  test("dia 31 cai no último dia dos meses curtos e volta ao 31", () => {
    const start = new Date("2027-01-31T10:00:00-03:00");
    assert.equal(key(dates.cycleStart(start, 1, monthly(31))), "2027-02-28");
    assert.equal(key(dates.cycleStart(start, 2, monthly(31))), "2027-03-31");
    assert.equal(key(dates.cycleStart(start, 3, monthly(31))), "2027-04-30");
  });

  test("ano bissexto", () => {
    const start = new Date("2028-01-30T10:00:00-03:00");
    assert.equal(key(dates.cycleStart(start, 1, monthly(30))), "2028-02-29");
  });

  test("vira o ano", () => {
    const start = new Date("2026-11-27T10:00:00-03:00");
    assert.equal(key(dates.cycleStart(start, 2, monthly(27))), "2027-01-27");
  });

  test("mantém o horário em Brasília, mesmo perto da meia-noite", () => {
    const start = new Date("2026-11-30T23:30:00-03:00");
    const next = dates.cycleStart(start, 1, monthly(30));
    assert.equal(next.toISOString(), "2026-12-31T02:30:00.000Z");
    assert.equal(key(next), "2026-12-30");
  });

  test("período semanal", () => {
    const start = new Date("2026-11-27T10:00:00-03:00");
    const period = dates.cyclePeriod(start, 1, { intervalUnit: "week", intervalCount: 1 });
    assert.equal(key(period.start), "2026-12-04");
    assert.equal(key(period.end), "2026-12-11");
  });
});

describe("calendário de repasse", () => {
  const weeklyMonday = { payoutInterval: "semanal", payoutDay: 1 };

  test("semanal: próxima segunda a partir da data (inclusive)", () => {
    assert.equal(dates.nextPayoutDateKey("2026-11-27", weeklyMonday), "2026-11-30"); // sexta → segunda
    assert.equal(dates.nextPayoutDateKey("2026-11-30", weeklyMonday), "2026-11-30"); // já é segunda
    assert.equal(dates.nextPayoutDateKey("2026-12-01", weeklyMonday), "2026-12-07");
  });

  test("mensal: próximo dia configurado", () => {
    assert.equal(dates.nextPayoutDateKey("2026-11-27", { payoutInterval: "mensal", payoutDay: 5 }), "2026-12-05");
    assert.equal(dates.nextPayoutDateKey("2026-11-03", { payoutInterval: "mensal", payoutDay: 5 }), "2026-11-05");
  });

  test("data prevista considera a liquidação do meio de pagamento", () => {
    const settings = { settlement_days_card: 30, settlement_days_pix: 1 };
    const paidAt = new Date("2026-11-27T10:00:00-03:00"); // sexta
    // cartão: D+30 = 27/12 (domingo) → segunda 28/12
    assert.equal(dates.expectedPayoutDateKey(paidAt, "cartao", settings, weeklyMonday), "2026-12-28");
    // pix: D+1 = sábado 28/11 → segunda 30/11
    assert.equal(dates.expectedPayoutDateKey(paidAt, "pix", settings, weeklyMonday), "2026-11-30");
  });

  test("competência é o mês em Brasília", () => {
    assert.equal(dates.competenciaKey(new Date("2026-12-01T01:00:00Z")), "2026-11-01");
  });
});
