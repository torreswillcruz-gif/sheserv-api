// Agenda da assinatura: a cliente define a recorrência (dia da semana e
// horário para cada serviço do plano) e as sessões que restam no ciclo viram
// pedidos já confirmados na agenda das duas. Horário ocupado não é marcado:
// vira pendência com as opções livres mais próximas para ela escolher. A
// cada ciclo pago, o agendador marca o mês novo com a mesma recorrência.
// Mudar a recorrência remarca as sessões futuras (as antigas são canceladas
// e a sessão volta).
const crypto = require("crypto");
const db = require("../db");
const { ApiError } = require("../errors");
const { notify, formatWhen } = require("../notifications");
const {
  ACTIVE_ORDER_STATUSES, fitsAvailability, slotsForDay, zonedDate, localParts,
} = require("../schedule");
const { debitEntitlement, returnEntitlement } = require("./subscriptions");

const LEAD_MINUTES = 60; // sessão marcada com pelo menos 1 h de antecedência
const MAX_ALTERNATIVES = 3;
const ALTERNATIVE_DAYS = 3; // procura opções no dia e nos 3 seguintes

const toMinutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

// ---------- Leitura ----------

async function loadSubscription(client, subscriptionId, customerId, { forUpdate = false } = {}) {
  const { rows } = await client.query(
    `SELECT s.*, p.name AS plan_name FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id
     WHERE s.id=$1 ${forUpdate ? "FOR UPDATE OF s" : ""}`,
    [subscriptionId]
  );
  const sub = rows[0];
  if (!sub || (customerId && sub.customer_id !== customerId)) throw new ApiError(404, "not_found", "Assinatura não encontrada.");
  return sub;
}

// Serviços do plano com o que resta no ciclo (sem contar as sessões futuras
// marcadas pela agenda, que podem ser remarcadas)
async function planServices(client, sub) {
  const { rows } = await client.query(
    `SELECT sv.id AS "serviceId", sv.title, sv.duration_minutes AS "durationMinutes", sv.availability,
       sv.provider_id, sv.service_location, sv.base_price,
       i.sessions_per_cycle AS "sessionsPerCycle",
       COALESCE(e.sessions_granted, 0) AS granted, COALESCE(e.sessions_used, 0) AS used,
       (SELECT COUNT(*)::int FROM orders o JOIN entitlement_usages u ON u.order_id = o.id AND u.status='debitado'
        WHERE u.entitlement_id = e.id AND o.subscription_schedule AND o.status = ANY($3::text[]) AND o.scheduled_at > now()) AS rebookable
     FROM subscription_plan_items i
     JOIN services sv ON sv.id = i.service_id
     LEFT JOIN entitlements e ON e.subscription_id = $1 AND e.service_id = i.service_id AND e.cycle = $2 AND e.voided_at IS NULL
     WHERE i.plan_id = $4 ORDER BY sv.title`,
    [sub.id, sub.current_cycle, ACTIVE_ORDER_STATUSES, sub.plan_id]
  );
  return rows.map((row) => ({ ...row, remaining: Math.max(0, row.granted - row.used + row.rebookable) }));
}

async function futureScheduleOrders(client, subscriptionId) {
  const { rows } = await client.query(
    `SELECT o.id, o.service_id, o.scheduled_at, o.duration_minutes, o.status FROM orders o
     JOIN entitlement_usages u ON u.order_id = o.id AND u.status = 'debitado'
     JOIN entitlements e ON e.id = u.entitlement_id
     WHERE e.subscription_id = $1 AND o.subscription_schedule AND o.status = ANY($2::text[]) AND o.scheduled_at > now()
     ORDER BY o.scheduled_at`,
    [subscriptionId, ACTIVE_ORDER_STATUSES]
  );
  return rows;
}

// Ocupação da prestadora ou da cliente em [start, end), ignorando os pedidos
// da própria agenda que vão ser remarcados
async function isBusy(client, { providerId, customerId, start, end, ignore }) {
  const { rows } = await client.query(
    `SELECT 1 FROM orders
     WHERE (provider_id=$1 OR customer_id=$2 OR provider_id=$2) AND status = ANY($5::text[])
       AND $3 < scheduled_at + duration_minutes * interval '1 minute' AND $4 > scheduled_at
       AND NOT (id = ANY($6::uuid[]))
     LIMIT 1`,
    [providerId, customerId, start, end, ACTIVE_ORDER_STATUSES, ignore]
  );
  return Boolean(rows[0]);
}

// ---------- Planejamento ----------

// Datas da recorrência dentro do que resta do ciclo
function occurrences(rules, fromDate, untilDate) {
  const dates = [];
  const firstDay = localParts(fromDate).dateKey;
  for (let offset = 0; offset < 62; offset++) {
    const dayStart = zonedDate(firstDay, 12 * 60);
    const dateKey = localParts(new Date(dayStart.getTime() + offset * 86400000)).dateKey;
    const { weekday } = localParts(zonedDate(dateKey, 12 * 60));
    for (const rule of rules) {
      if (rule.weekday !== weekday) continue;
      const start = zonedDate(dateKey, toMinutes(rule.time));
      if (start >= fromDate && start < untilDate) dates.push(start);
    }
    if (zonedDate(dateKey, 0) >= untilDate) break;
  }
  return dates.sort((a, b) => a - b);
}

// Escolhe `count` datas espalhadas (ex.: 2 sessões em 4 sábados: 1º e 3º)
function spread(dates, count) {
  if (dates.length <= count) return dates;
  return Array.from({ length: count }, (_, index) => dates[Math.floor((index * dates.length) / count)]);
}

async function alternativesFor(client, { service, sub, wanted, ignore, taken }) {
  const options = [];
  const wantedMinutes = localParts(wanted).minutes;
  for (let dayOffset = 0; dayOffset <= ALTERNATIVE_DAYS && options.length < MAX_ALTERNATIVES; dayOffset++) {
    const dateKey = localParts(new Date(wanted.getTime() + dayOffset * 86400000)).dateKey;
    const { slots } = await slotsForDay(client, {
      service: { provider_id: service.provider_id, duration_minutes: service.durationMinutes, availability: service.availability },
      dateKey, customerId: sub.customer_id,
    });
    const candidates = [];
    for (const slot of slots) {
      const start = new Date(slot.startsAt);
      if (start >= new Date(sub.current_period_end) || start <= new Date(Date.now() + LEAD_MINUTES * 60000)) continue;
      const end = new Date(start.getTime() + service.durationMinutes * 60000);
      if (taken.some((other) => start < other.end && end > other.start)) continue;
      // slotsForDay já marca ocupado; os pedidos que vão ser remarcados ficam livres
      if (!slot.available && await isBusy(client, { providerId: service.provider_id, customerId: sub.customer_id, start, end, ignore })) continue;
      candidates.push(start);
    }
    candidates.sort((a, b) => Math.abs(localParts(a).minutes - wantedMinutes) - Math.abs(localParts(b).minutes - wantedMinutes));
    for (const start of candidates) {
      if (options.length >= MAX_ALTERNATIVES) break;
      options.push(start.toISOString());
    }
  }
  return options;
}

// O que a recorrência marcaria agora: para cada sessão que resta, a data, se
// está livre e, se não, as opções mais próximas.
async function planSessions(client, sub, rules) {
  const services = await planServices(client, sub);
  const ignore = (await futureScheduleOrders(client, sub.id)).map((order) => order.id);
  const from = new Date(Math.max(Date.now() + LEAD_MINUTES * 60000, new Date(sub.current_period_start).getTime()));
  const until = new Date(sub.current_period_end);
  const sessions = [];
  const taken = [];
  for (const service of services) {
    const serviceRules = rules.filter((rule) => rule.serviceId === service.serviceId);
    if (!serviceRules.length || service.remaining === 0) continue;
    const dates = spread(occurrences(serviceRules, from, until), service.remaining);
    for (const wanted of dates) {
      const end = new Date(wanted.getTime() + service.durationMinutes * 60000);
      const fits = fitsAvailability(service.availability, wanted, service.durationMinutes);
      const clash = taken.some((other) => wanted < other.end && end > other.start);
      const busy = !fits || clash || await isBusy(client, {
        providerId: service.provider_id, customerId: sub.customer_id, start: wanted, end, ignore,
      });
      const session = {
        serviceId: service.serviceId,
        title: service.title,
        wantedAt: wanted.toISOString(),
        available: !busy,
        reason: !fits ? "outside_service_hours" : busy ? "busy" : null,
        alternatives: [],
      };
      if (busy) session.alternatives = await alternativesFor(client, { service, sub, wanted, ignore, taken });
      else taken.push({ start: wanted, end });
      sessions.push(session);
    }
  }
  const scheduled = sessions.length;
  const unscheduled = services.reduce((sum, service) => {
    const ruled = rules.some((rule) => rule.serviceId === service.serviceId);
    const planned = sessions.filter((session) => session.serviceId === service.serviceId).length;
    return sum + (ruled ? service.remaining - planned : 0);
  }, 0);
  return { sessions, scheduled, unscheduled, services };
}

// ---------- Gravação ----------

async function bookSession(client, sub, service, startsAt, { actorId }) {
  const start = new Date(startsAt);
  if (start <= new Date() || start >= new Date(sub.current_period_end))
    throw new ApiError(422, "outside_cycle", "Escolha um horário dentro do ciclo atual da assinatura.");
  if (!fitsAvailability(service.availability, start, service.durationMinutes))
    throw new ApiError(422, "outside_service_hours", "Horário fora do atendimento da prestadora.");
  const end = new Date(start.getTime() + service.durationMinutes * 60000);
  if (await isBusy(client, { providerId: service.provider_id, customerId: sub.customer_id, start, end, ignore: [] }))
    throw new ApiError(409, "slot_unavailable", "Esse horário não está mais livre. Escolha outro.", { startsAt });
  const { rows } = await client.query(
    `INSERT INTO orders (customer_id,provider_id,service_id,address_id,service_location,scheduled_at,duration_minutes,
       total_amount,commission,checkin_code,status,subscription_schedule)
     VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,0,$8,'accepted',true) RETURNING id`,
    [sub.customer_id, sub.provider_id, service.serviceId, service.service_location, start, service.durationMinutes,
     Number(service.base_price), String(crypto.randomInt(0, 10000)).padStart(4, "0")]
  );
  const orderId = rows[0].id;
  await debitEntitlement(client, {
    customerId: sub.customer_id, subscriptionId: sub.id, serviceId: service.serviceId, scheduledAt: start, orderId,
  });
  await client.query(
    "INSERT INTO order_events (order_id,actor_id,type,data) VALUES ($1,$2,'requested',$3),($1,NULL,'status_changed',$4)",
    [orderId, actorId, { source: "subscription_schedule" }, { from: "requested", to: "accepted", source: "subscription_schedule" }]
  );
  return { orderId, startsAt: start };
}

async function cancelFutureSessions(client, sub) {
  const orders = await futureScheduleOrders(client, sub.id);
  for (const order of orders) {
    await client.query("UPDATE orders SET status='cancelled' WHERE id=$1", [order.id]);
    await client.query(
      "INSERT INTO order_events (order_id,actor_id,type,data) VALUES ($1,$2,'status_changed',$3)",
      [order.id, sub.customer_id, { from: order.status, to: "cancelled", reason: "agenda da assinatura remarcada" }]
    );
    await returnEntitlement(client, order.id);
  }
  return orders.length;
}

// Salva a recorrência e marca as sessões escolhidas (as que ela confirmou na
// prévia, com a data original ou uma das opções)
async function saveSchedule(customerId, subscriptionId, { rules, sessions }) {
  return db.runInTransaction(async (client) => {
    const sub = await loadSubscription(client, subscriptionId, customerId, { forUpdate: true });
    if (sub.status !== "ativa") throw new ApiError(409, "subscription_inactive", "A agenda só pode ser montada com a assinatura ativa.");
    const services = await planServices(client, sub);
    const byId = new Map(services.map((service) => [service.serviceId, service]));
    for (const rule of rules) {
      if (!byId.has(rule.serviceId)) throw new ApiError(422, "service_not_in_plan", "Serviço fora do plano.", { rules: rule.serviceId });
    }
    const replaced = await cancelFutureSessions(client, sub);
    const booked = [];
    for (const session of sessions) {
      const service = byId.get(session.serviceId);
      if (!service) throw new ApiError(422, "service_not_in_plan", "Serviço fora do plano.", { sessions: session.serviceId });
      booked.push(await bookSession(client, sub, service, session.startsAt, { actorId: customerId }));
    }
    await client.query(
      `INSERT INTO subscription_schedules (subscription_id,rules,updated_at) VALUES ($1,$2,now())
       ON CONFLICT (subscription_id) DO UPDATE SET rules=EXCLUDED.rules, updated_at=now()`,
      [sub.id, JSON.stringify(rules)]
    );
    await client.query("UPDATE subscriptions SET schedule_generated_cycle=current_cycle WHERE id=$1", [sub.id]);
    await client.query("UPDATE subscription_schedule_pending SET resolved_at=now() WHERE subscription_id=$1 AND resolved_at IS NULL", [sub.id]);
    if (booked.length || replaced) {
      const { rows: names } = await client.query("SELECT COALESCE(NULLIF(social_name,''), name) AS name FROM users WHERE id=$1", [customerId]);
      await notify(client, {
        userId: sub.provider_id,
        type: "subscription_schedule_set",
        title: replaced ? "Agenda de assinante atualizada" : "Nova agenda de assinante",
        body: `${names[0]?.name ?? "Uma assinante"} marcou ${booked.length} sessão(ões) do plano "${sub.plan_name}"${booked[0] ? `, a primeira em ${formatWhen(booked[0].startsAt)}` : ""}.`,
        data: { subscriptionId: sub.id }, area: "provider",
      });
    }
    return { booked: booked.length, replaced };
  });
}

// Sessão avulsa da agenda (resolver uma pendência ou marcar uma que sobrou)
async function bookOne(customerId, subscriptionId, { serviceId, startsAt, pendingId }) {
  return db.runInTransaction(async (client) => {
    const sub = await loadSubscription(client, subscriptionId, customerId, { forUpdate: true });
    if (sub.status !== "ativa") throw new ApiError(409, "subscription_inactive", "Esta assinatura não está ativa.");
    const services = await planServices(client, sub);
    const service = services.find((item) => item.serviceId === serviceId);
    if (!service) throw new ApiError(422, "service_not_in_plan", "Serviço fora do plano.");
    const booked = await bookSession(client, sub, service, startsAt, { actorId: customerId });
    if (pendingId) {
      await client.query(
        "UPDATE subscription_schedule_pending SET resolved_at=now() WHERE id=$1 AND subscription_id=$2",
        [pendingId, sub.id]
      );
    }
    await notify(client, {
      userId: sub.provider_id, type: "subscription_session_booked", title: "Sessão de assinante marcada",
      body: `${service.title} em ${formatWhen(booked.startsAt)} (plano "${sub.plan_name}").`,
      data: { orderId: booked.orderId }, area: "provider",
    });
    return booked;
  });
}

async function scheduleView(customerId, subscriptionId) {
  const client = { query: db.runQuery };
  const sub = await loadSubscription(client, subscriptionId, customerId);
  const { rows: saved } = await client.query("SELECT rules FROM subscription_schedules WHERE subscription_id=$1", [sub.id]);
  const services = await planServices(client, sub);
  const { rows: upcoming } = await client.query(
    `SELECT o.id AS "orderId", o.service_id AS "serviceId", sv.title, o.scheduled_at AS "startsAt", o.status
     FROM orders o JOIN services sv ON sv.id = o.service_id
     JOIN entitlement_usages u ON u.order_id = o.id AND u.status='debitado'
     JOIN entitlements e ON e.id = u.entitlement_id
     WHERE e.subscription_id=$1 AND e.cycle=$2 AND o.status = ANY($3::text[]) AND o.scheduled_at > now()
     ORDER BY o.scheduled_at`,
    [sub.id, sub.current_cycle, ACTIVE_ORDER_STATUSES]
  );
  const { rows: pending } = await client.query(
    `SELECT p.id, p.service_id AS "serviceId", sv.title, p.wanted_at AS "wantedAt", p.alternatives
     FROM subscription_schedule_pending p JOIN services sv ON sv.id = p.service_id
     WHERE p.subscription_id=$1 AND p.cycle=$2 AND p.resolved_at IS NULL ORDER BY p.wanted_at`,
    [sub.id, sub.current_cycle]
  );
  return {
    subscriptionId: sub.id,
    status: sub.status,
    planName: sub.plan_name,
    cycle: sub.current_cycle,
    periodEnd: sub.current_period_end,
    rules: saved[0]?.rules ?? [],
    services: services.map((service) => ({
      serviceId: service.serviceId,
      title: service.title,
      durationMinutes: service.durationMinutes,
      sessionsPerCycle: service.sessionsPerCycle,
      remaining: Math.max(0, service.granted - service.used),
      availability: service.availability ?? [],
    })),
    upcoming,
    pending,
  };
}

// ---------- Mês novo (agendador) ----------

// Assinaturas ativas com recorrência salva e ciclo ainda não marcado: marca
// o que estiver livre e guarda as pendências com opções.
async function generateDueSchedules() {
  await releaseInactiveSchedules();
  const { rows } = await db.runQuery(
    `SELECT s.id FROM subscriptions s JOIN subscription_schedules r ON r.subscription_id = s.id
     WHERE s.status='ativa' AND (s.schedule_generated_cycle IS NULL OR s.schedule_generated_cycle < s.current_cycle)
       AND EXISTS (SELECT 1 FROM entitlements e WHERE e.subscription_id=s.id AND e.cycle=s.current_cycle)
     LIMIT 50`
  );
  for (const { id } of rows) {
    try {
      await db.runInTransaction((client) => generateCycle(client, id));
    } catch (error) {
      console.error(`agenda da assinatura ${id}:`, error.message);
    }
  }
}

// Assinatura suspensa ou cancelada: as sessões futuras marcadas pela agenda
// saem das duas agendas (o horário volta a ficar livre para a prestadora)
async function releaseInactiveSchedules() {
  const { rows } = await db.runQuery(
    `SELECT DISTINCT e.subscription_id AS id FROM orders o
     JOIN entitlement_usages u ON u.order_id = o.id AND u.status='debitado'
     JOIN entitlements e ON e.id = u.entitlement_id
     JOIN subscriptions s ON s.id = e.subscription_id
     WHERE o.subscription_schedule AND o.status = ANY($1::text[]) AND o.scheduled_at > now()
       AND s.status IN ('suspensa','cancelada')
     LIMIT 50`,
    [ACTIVE_ORDER_STATUSES]
  );
  for (const { id } of rows) {
    try {
      await db.runInTransaction(async (client) => {
        const sub = await loadSubscription(client, id, null, { forUpdate: true });
        const released = await cancelFutureSessions(client, sub);
        if (!released) return;
        await notify(client, {
          userId: sub.provider_id, type: "subscription_schedule_released", title: "Horários de assinante liberados",
          body: `${released} sessão(ões) do plano "${sub.plan_name}" saíram da sua agenda: a assinatura não está mais ativa.`,
          data: { subscriptionId: sub.id }, area: "provider",
        });
      });
    } catch (error) {
      console.error(`liberar agenda da assinatura ${id}:`, error.message);
    }
  }
}

async function generateCycle(client, subscriptionId) {
  const sub = await loadSubscription(client, subscriptionId, null, { forUpdate: true });
  if (sub.status !== "ativa" || (sub.schedule_generated_cycle ?? 0) >= sub.current_cycle) return;
  const { rows: saved } = await client.query("SELECT rules FROM subscription_schedules WHERE subscription_id=$1", [sub.id]);
  const rules = saved[0]?.rules ?? [];
  const plan = await planSessions(client, sub, rules);
  const services = new Map(plan.services.map((service) => [service.serviceId, service]));
  let booked = 0;
  let pending = 0;
  let first = null;
  for (const session of plan.sessions) {
    if (session.available) {
      const result = await bookSession(client, sub, services.get(session.serviceId), session.wantedAt, { actorId: null });
      booked++;
      first ??= result.startsAt;
    } else {
      await client.query(
        `INSERT INTO subscription_schedule_pending (subscription_id,cycle,service_id,wanted_at,alternatives)
         VALUES ($1,$2,$3,$4,$5)`,
        [sub.id, sub.current_cycle, session.serviceId, session.wantedAt, JSON.stringify(session.alternatives)]
      );
      pending++;
    }
  }
  await client.query("UPDATE subscriptions SET schedule_generated_cycle=current_cycle WHERE id=$1", [sub.id]);
  await notify(client, {
    userId: sub.customer_id,
    type: pending ? "subscription_schedule_pending" : "subscription_schedule_generated",
    title: pending ? "Escolha novos horários da sua assinatura" : "Sua agenda do mês está marcada",
    body: pending
      ? `Marcamos ${booked} sessão(ões) do plano "${sub.plan_name}". ${pending} caiu(íram) em horário ocupado: escolha outro horário.`
      : `Marcamos ${booked} sessão(ões) do plano "${sub.plan_name}" nos seus dias de sempre.`,
    data: { subscriptionId: sub.id }, area: "customer",
  });
  if (booked) {
    await notify(client, {
      userId: sub.provider_id, type: "subscription_schedule_generated", title: "Agenda de assinante do mês",
      body: `${booked} sessão(ões) do plano "${sub.plan_name}" marcadas${first ? `, a primeira em ${formatWhen(first)}` : ""}.`,
      data: { subscriptionId: sub.id }, area: "provider",
    });
  }
}

async function previewSchedule(customerId, subscriptionId, rules) {
  const client = { query: db.runQuery };
  const sub = await loadSubscription(client, subscriptionId, customerId);
  if (sub.status !== "ativa") throw new ApiError(409, "subscription_inactive", "A agenda só pode ser montada com a assinatura ativa.");
  const plan = await planSessions(client, sub, rules);
  return { sessions: plan.sessions, unscheduled: plan.unscheduled };
}

module.exports = {
  previewSchedule, saveSchedule, bookOne, scheduleView, generateDueSchedules,
  // testes
  occurrences, spread,
};
