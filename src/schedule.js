// Horário de atendimento dos serviços e verificação de agenda.
//
// O horário de atendimento é guardado em services.availability como uma lista de
// janelas semanais no horário de Brasília:
//   [{ "weekday": 1, "start": "09:00", "end": "18:00" }, ...]
// weekday segue a ISO (1 = segunda ... 7 = domingo), igual ao DateTime.weekday do app.
// Lista vazia = serviço antigo, cadastrado antes do campo existir: sem restrição de horário.
const { z } = require("zod");
const { ApiError } = require("./errors");

const TIME_ZONE = "America/Sao_Paulo";
const SLOT_STEP_MINUTES = 30;
const MAX_DAYS_AHEAD = 90;
const ACTIVE_ORDER_STATUSES = ["requested", "accepted", "on_the_way", "in_progress"];

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use o formato HH:MM");
const toMinutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const toTime = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

const availabilitySchema = z.array(
  z.object({
    weekday: z.number().int().min(1).max(7),
    start: timeOfDay,
    end: timeOfDay,
  }).strict().refine((window) => toMinutes(window.start) < toMinutes(window.end), {
    message: "O início precisa ser antes do fim.",
    path: ["end"],
  })
).min(1, "Informe pelo menos um dia de atendimento.").max(21);

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23",
});
const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

// Data, dia da semana e minuto do dia de um instante, no horário de Brasília
function localParts(date) {
  const parts = Object.fromEntries(partsFormatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: WEEKDAYS[parts.weekday],
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

// Instante correspondente a "dateKey às minutos" no horário de Brasília
function zonedDate(dateKey, minutes) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const wanted = Date.UTC(year, month - 1, day, 0, minutes);
  const guess = new Date(wanted);
  const seen = localParts(guess);
  const [seenYear, seenMonth, seenDay] = seen.dateKey.split("-").map(Number);
  const seenAsUtc = Date.UTC(seenYear, seenMonth - 1, seenDay, 0, seen.minutes);
  return new Date(wanted + (wanted - seenAsUtc));
}

function weekdayOfDateKey(dateKey) {
  return localParts(zonedDate(dateKey, 12 * 60)).weekday;
}

function normalizeAvailability(availability) {
  return Array.isArray(availability) ? availability : [];
}

// O atendimento [início, início + duração] cabe numa janela do dia?
function fitsAvailability(availability, startDate, durationMinutes) {
  const windows = normalizeAvailability(availability);
  if (windows.length === 0) return true;
  const start = localParts(startDate);
  const endMinutes = start.minutes + durationMinutes;
  return windows.some((window) =>
    window.weekday === start.weekday &&
    start.minutes >= toMinutes(window.start) &&
    endMinutes <= toMinutes(window.end)
  );
}

function assertWithinAvailability(availability, startDate, durationMinutes) {
  if (!fitsAvailability(availability, startDate, durationMinutes))
    throw new ApiError(422, "outside_service_hours", "The selected time is outside the service hours.", {
      scheduledAt: "Escolha um horário dentro do horário de atendimento do serviço.",
    });
}

// Algum pedido ativo da prestadora se sobrepõe a [start, end)? `excludeOrderId`
// ignora o próprio pedido (ao mudar o horário dele).
async function providerIsBusy(databaseClient, providerId, start, end, excludeOrderId = null) {
  const { rows } = await databaseClient.query(
    `SELECT 1 FROM orders
     WHERE provider_id=$1 AND status = ANY($4::text[])
       AND $2 < scheduled_at + duration_minutes * interval '1 minute' AND $3 > scheduled_at
       AND ($5::uuid IS NULL OR id <> $5::uuid)
     LIMIT 1`,
    [providerId, start, end, ACTIVE_ORDER_STATUSES, excludeOrderId]
  );
  return Boolean(rows[0]);
}

// A pessoa já tem compromisso (como cliente ou como prestadora) em [start, end)?
async function userHasCommitment(databaseClient, userId, start, end, excludeOrderId = null) {
  const { rows } = await databaseClient.query(
    `SELECT 1 FROM orders
     WHERE (customer_id=$1 OR provider_id=$1) AND status = ANY($4::text[])
       AND $2 < scheduled_at + duration_minutes * interval '1 minute' AND $3 > scheduled_at
       AND ($5::uuid IS NULL OR id <> $5::uuid)
     LIMIT 1`,
    [userId, start, end, ACTIVE_ORDER_STATUSES, excludeOrderId]
  );
  return Boolean(rows[0]);
}

// Verificações feitas ao marcar um horário (pedido direto, aprovação de orçamento
// ou novo horário sugerido; neste caso `excludeOrderId` é o próprio pedido)
async function assertSlotFree(databaseClient, { providerId, customerId, start, durationMinutes, excludeOrderId = null }) {
  const end = new Date(start.getTime() + durationMinutes * 60000);
  if (await providerIsBusy(databaseClient, providerId, start, end, excludeOrderId))
    throw new ApiError(409, "slot_unavailable", "Slot unavailable.", {
      scheduledAt: "Esse horário não está mais disponível. Escolha outro.",
    });
  if (await userHasCommitment(databaseClient, customerId, start, end, excludeOrderId))
    throw new ApiError(409, "schedule_conflict", "You already have a commitment at this time.", {
      scheduledAt: "Você já tem um compromisso nesse horário.",
    });
  return end;
}

// Horários de início possíveis num dia, marcando os ocupados. `excludeOrderId`
// ignora um pedido de quem consulta (a prestadora sugerindo outro horário para ele).
async function slotsForDay(databaseClient, { service, dateKey, customerId, excludeOrderId = null, now = new Date() }) {
  const windows = normalizeAvailability(service.availability);
  const weekday = weekdayOfDateKey(dateKey);
  const dayWindows = windows.length === 0
    ? [{ weekday, start: "08:00", end: "20:00" }] // serviço antigo sem horário: faixa padrão
    : windows.filter((window) => window.weekday === weekday);

  const duration = service.duration_minutes;
  const dayStart = zonedDate(dateKey, 0);
  const dayEnd = zonedDate(dateKey, 24 * 60);
  const { rows: busyOrders } = await databaseClient.query(
    `SELECT scheduled_at, duration_minutes, provider_id, customer_id FROM orders
     WHERE (provider_id=$1 OR customer_id=$2 OR provider_id=$2) AND status = ANY($5::text[])
       AND scheduled_at < $4 AND scheduled_at + duration_minutes * interval '1 minute' > $3
       AND ($6::uuid IS NULL OR id <> $6::uuid OR NOT (customer_id=$2 OR provider_id=$2))`,
    [service.provider_id, customerId, dayStart, dayEnd, ACTIVE_ORDER_STATUSES, excludeOrderId]
  );

  const slots = [];
  for (const window of dayWindows) {
    for (let minute = toMinutes(window.start); minute + duration <= toMinutes(window.end); minute += SLOT_STEP_MINUTES) {
      const start = zonedDate(dateKey, minute);
      if (start <= now) continue;
      const end = new Date(start.getTime() + duration * 60000);
      const overlapping = busyOrders.filter((order) => {
        const orderStart = new Date(order.scheduled_at);
        const orderEnd = new Date(orderStart.getTime() + order.duration_minutes * 60000);
        return start < orderEnd && end > orderStart;
      });
      const providerBusy = overlapping.some((order) => order.provider_id === service.provider_id);
      const youBusy = overlapping.some((order) => order.customer_id === customerId || order.provider_id === customerId);
      slots.push({
        time: toTime(minute),
        startsAt: start.toISOString(),
        available: !providerBusy && !youBusy,
        ...(providerBusy ? { reason: "provider_busy" } : youBusy ? { reason: "your_commitment" } : {}),
      });
    }
  }
  return { windows: dayWindows, slots };
}

function assertBookableDate(dateKey, now = new Date()) {
  const today = localParts(now).dateKey;
  const last = localParts(new Date(now.getTime() + MAX_DAYS_AHEAD * 86400000)).dateKey;
  if (dateKey < today || dateKey > last)
    throw new ApiError(422, "validation_error", "Date out of range.", {
      date: `Escolha uma data entre hoje e os próximos ${MAX_DAYS_AHEAD} dias.`,
    });
}

module.exports = {
  ACTIVE_ORDER_STATUSES,
  TIME_ZONE,
  availabilitySchema,
  assertBookableDate,
  assertSlotFree,
  assertWithinAvailability,
  fitsAvailability,
  localParts,
  slotsForDay,
  zonedDate,
};
