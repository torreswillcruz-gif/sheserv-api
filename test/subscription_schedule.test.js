const assert = require("node:assert/strict");
const { test } = require("node:test");
const { occurrences, spread } = require("../src/payments/subscriptionSchedule");

test("recorrência: sábados às 9h (Brasília) dentro do ciclo", () => {
  // 01/12/2026 (terça) até 01/01/2027
  const dates = occurrences(
    [{ serviceId: "s", weekday: 6, time: "09:00" }],
    new Date("2026-12-01T03:00:00Z"),
    new Date("2027-01-01T03:00:00Z")
  );
  assert.deepEqual(dates.map((date) => date.toISOString()), [
    "2026-12-05T12:00:00.000Z",
    "2026-12-12T12:00:00.000Z",
    "2026-12-19T12:00:00.000Z",
    "2026-12-26T12:00:00.000Z",
  ]);
});

test("duas regras na semana entram em ordem", () => {
  const dates = occurrences(
    [{ serviceId: "s", weekday: 4, time: "18:30" }, { serviceId: "s", weekday: 2, time: "10:00" }],
    new Date("2026-12-01T03:00:00Z"),
    new Date("2026-12-08T03:00:00Z")
  );
  assert.deepEqual(dates.map((date) => date.toISOString()), [
    "2026-12-01T13:00:00.000Z",
    "2026-12-03T21:30:00.000Z",
  ]);
});

test("menos sessões que datas: espalha pelo mês", () => {
  const dates = [1, 2, 3, 4].map((day) => new Date(Date.UTC(2026, 11, day)));
  assert.deepEqual(spread(dates, 2).map((date) => date.getUTCDate()), [1, 3]);
  assert.deepEqual(spread(dates, 4).map((date) => date.getUTCDate()), [1, 2, 3, 4]);
  assert.equal(spread(dates.slice(0, 1), 3).length, 1, "não inventa datas");
});
