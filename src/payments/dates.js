// Datas do módulo de pagamentos, no horário de Brasília (UTC-3 fixo: o Brasil
// não tem horário de verão desde 2019).

const BRASILIA_OFFSET_MS = -3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const toBrasilia = (date) => new Date(new Date(date).getTime() + BRASILIA_OFFSET_MS);
const fromBrasilia = (date) => new Date(date.getTime() - BRASILIA_OFFSET_MS);
const daysInMonth = (year, monthIndex) => new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

// 'YYYY-MM-DD' do dia em Brasília
function brasiliaDateKey(date) {
  return toBrasilia(date).toISOString().slice(0, 10);
}

// Início do ciclo `cycleIndex` (0 = o primeiro) de uma assinatura que começou
// em `start`. Mensal: mesmo dia do mês da assinatura (aniversário, não dia 1);
// em mês mais curto, o último dia (31 → 28/29 → volta a 31 em março). Mantém
// o horário do início.
function cycleStart(start, cycleIndex, { intervalUnit, intervalCount, anchorDay }) {
  const local = toBrasilia(start);
  if (intervalUnit === "week") {
    return new Date(new Date(start).getTime() + cycleIndex * intervalCount * 7 * DAY_MS);
  }
  const totalMonths = local.getUTCMonth() + cycleIndex * intervalCount;
  const year = local.getUTCFullYear() + Math.floor(totalMonths / 12);
  const monthIndex = ((totalMonths % 12) + 12) % 12;
  const day = Math.min(anchorDay ?? local.getUTCDate(), daysInMonth(year, monthIndex));
  const result = new Date(Date.UTC(
    year, monthIndex, day,
    local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds(), local.getUTCMilliseconds()
  ));
  return fromBrasilia(result);
}

// Período [início, fim) do ciclo
function cyclePeriod(start, cycleIndex, options) {
  return { start: cycleStart(start, cycleIndex, options), end: cycleStart(start, cycleIndex + 1, options) };
}

function addDaysToKey(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  return new Date(date.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

// Primeiro dia de repasse a partir de `dateKey` (inclusive).
// semanal: payoutDay = dia da semana ISO (1 = segunda ... 5 = sexta)
// mensal: payoutDay = dia do mês (1 a 28)
function nextPayoutDateKey(dateKey, { payoutInterval, payoutDay }) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  if (payoutInterval === "semanal") {
    const isoWeekday = ((date.getUTCDay() + 6) % 7) + 1;
    const wait = (payoutDay - isoWeekday + 7) % 7;
    return addDaysToKey(dateKey, wait);
  }
  if (payoutInterval === "mensal") {
    const candidate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), payoutDay));
    if (candidate >= date) return candidate.toISOString().slice(0, 10);
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, payoutDay)).toISOString().slice(0, 10);
  }
  throw new Error(`Calendário de repasse inválido: ${payoutInterval}`);
}

// Data prevista do repasse de uma cobrança paga em `paidAt`: o dinheiro fica
// disponível depois do prazo de liquidação do meio de pagamento (cartão sem
// antecipação costuma ser D+30) e sai no próximo dia de repasse.
function expectedPayoutDateKey(paidAt, paymentMethod, settings, schedule) {
  const settlementDays = paymentMethod === "pix" ? settings.settlement_days_pix : settings.settlement_days_card;
  const availableKey = addDaysToKey(brasiliaDateKey(paidAt), settlementDays);
  return nextPayoutDateKey(availableKey, schedule);
}

// Primeiro dia do mês de competência ('YYYY-MM-01')
const competenciaKey = (date) => `${brasiliaDateKey(date).slice(0, 7)}-01`;

module.exports = {
  DAY_MS,
  brasiliaDateKey,
  cycleStart,
  cyclePeriod,
  addDaysToKey,
  nextPayoutDateKey,
  expectedPayoutDateKey,
  competenciaKey,
};
