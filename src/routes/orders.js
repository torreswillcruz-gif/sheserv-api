const ordersRouter = require("express").Router();
const crypto = require("crypto");
const { z } = require("zod");
const { runQuery, runInTransaction } = require("../db");
const { ApiError, asyncHandler } = require("../errors");
const { requireRole } = require("../security");
const { isValidUuid } = require("../validation");
const {
  ACTIVE_ORDER_STATUSES,
  assertBookableDate,
  assertSlotFree,
  assertWithinAvailability,
  slotsForDay,
} = require("../schedule");
const { formatWhen, notify, userName } = require("../notifications");
const payments = require("../payments/charges");
const { debitEntitlement } = require("../payments/subscriptions");
const { fingerprint, assertSameRequest, decimalFromCents } = require("../payments/runtime");

const roundToTwoDecimals = (value) => Math.round(value * 100) / 100;

// Uma sugestão de horário vale até 1 hora antes do horário sugerido.
const PROPOSAL_LEAD_MINUTES = 60;
const proposalExpiresAt = (proposedAt) =>
  new Date(new Date(proposedAt).getTime() - PROPOSAL_LEAD_MINUTES * 60000);

// $1 = id de quem está logado.
// - checkinCode: só o cliente vê.
// - serviceLocation: "at_customer" (a prestadora vai até o cliente) ou "at_provider" (o cliente vai até ela).
// - location (coordenadas do endereço do cliente, só em at_customer): o cliente sempre vê; a prestadora
//   só vê depois de aceitar o pedido (antes disso o endereço fica protegido).
// - venue (endereço exato da prestadora, só em at_provider): só aparece depois que o pedido é aceito.
// - cancellationReason: motivo informado ao cancelar/recusar (pode ser nulo).
// - timeProposal: outro horário sugerido pela prestadora, aguardando a cliente
//   (expiresAt = 1 hora antes do horário sugerido; ver PROPOSAL_LEAD_MINUTES).
const ORDER_SELECT_SQL = `
  SELECT
    orders.id,
    orders.status,
    orders.service_id AS "serviceId",
    (SELECT c.name FROM services s JOIN categories c ON c.id = s.category_id WHERE s.id = orders.service_id) AS "categoryName",
    orders.friendly_id AS "friendlyId",
    orders.provider_id AS "providerId",
    provider_user.name AS "providerName",
    orders.customer_id AS "customerId",
    customer_user.name AS "customerName",
    orders.scheduled_at AS "scheduledAt",
    -- a cliente vê o total que paga (taxa embutida, nunca em linha separada);
    -- a prestadora vê o preço dela
    CASE WHEN orders.customer_id = $1 AND order_charge.id IS NOT NULL
      THEN order_charge.total_cents / 100.0
      ELSE orders.total_amount::float END AS "totalAmount",
    orders.commission::float AS commission,
    orders.service_location AS "serviceLocation",
    orders.cancellation_reason AS "cancellationReason",
    CASE WHEN orders.proposed_scheduled_at IS NOT NULL THEN json_build_object(
      'scheduledAt', orders.proposed_scheduled_at,
      'reason', orders.proposal_reason,
      'expiresAt', orders.proposed_scheduled_at - interval '60 minutes'
    ) END AS "timeProposal",
    CASE WHEN orders.customer_id = $1 THEN orders.checkin_code END AS "checkinCode",
    CASE WHEN orders.service_location = 'at_customer'
           AND (orders.customer_id = $1 OR orders.status NOT IN ('requested', 'cancelled'))
      THEN json_build_object('latitude', order_address.latitude, 'longitude', order_address.longitude)
    END AS location,
    CASE WHEN orders.service_location = 'at_provider' AND orders.status NOT IN ('requested', 'cancelled')
      THEN json_build_object(
        'street', order_venue.street,
        'number', order_venue.number,
        'complement', order_venue.complement,
        'neighborhood', order_venue.neighborhood,
        'city', order_venue.city,
        'state', order_venue.state,
        'postalCode', order_venue.postal_code,
        'latitude', order_venue.latitude,
        'longitude', order_venue.longitude
      )
    END AS venue,
    CASE
      WHEN order_charge.id IS NOT NULL THEN json_build_object(
        'id', order_charge.id,
        'status', order_charge.status,
        'method', CASE order_charge.payment_method WHEN 'cartao' THEN 'card' ELSE 'pix' END,
        'inApp', true,
        'pixCopyPaste', CASE WHEN orders.customer_id = $1 AND order_charge.status IN ('pendente','processando')
                          THEN order_charge.pix_copy_paste END,
        'refundedCents', order_charge.refunded_cents)
      WHEN order_usage.id IS NOT NULL THEN json_build_object(
        'id', order_usage.id,
        'status', order_usage.status,
        'method', 'subscription',
        'subscriptionId', order_usage.subscription_id)
      ELSE json_build_object(
        'id', payments.id,
        'status', payments.status,
        'method', payments.method,
        'heldUntil', payments.held_until)
    END AS payment
  FROM orders
  JOIN users customer_user ON customer_user.id = orders.customer_id
  JOIN users provider_user ON provider_user.id = orders.provider_id
  LEFT JOIN addresses order_address ON order_address.id = orders.address_id
  LEFT JOIN provider_venues order_venue ON order_venue.provider_id = orders.provider_id
  LEFT JOIN payments ON payments.order_id = orders.id
  LEFT JOIN LATERAL (
    SELECT id, status, payment_method, total_cents, pix_copy_paste, refunded_cents
    FROM charges WHERE charges.order_id = orders.id ORDER BY created_at DESC LIMIT 1
  ) order_charge ON true
  LEFT JOIN LATERAL (
    SELECT usage.id, usage.status, entitlement.subscription_id
    FROM entitlement_usages usage JOIN entitlements entitlement ON entitlement.id = usage.entitlement_id
    WHERE usage.order_id = orders.id
  ) order_usage ON true`;

// Busca o pedido e garante que quem pediu é o cliente ou a prestadora dele
async function loadOrderForParticipant(orderId, userId, databaseClient = { query: runQuery }) {
  if (!isValidUuid(orderId)) throw new ApiError(404, "not_found", "Order not found.");

  const { rows: matchingOrders } = await databaseClient.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [orderId]);
  const order = matchingOrders[0];
  if (!order || (order.customer_id !== userId && order.provider_id !== userId))
    throw new ApiError(404, "not_found", "Order not found.");
  return order;
}

// ---------- Criar pedido (só cliente) ----------

// Pagamento: pelo app (pix/cartão, cobrado na solicitação) ou com uma sessão
// de assinatura (subscriptionId). Valor e taxa são sempre do servidor.
const createOrderSchema = z.object({
  serviceId: z.string().uuid(),
  addressId: z.string().uuid().optional(), // obrigatório só em serviços "at_customer"
  scheduledAt: z.string().datetime({ offset: true }),
  paymentMethod: z.discriminatedUnion("type", [
    z.object({ type: z.literal("pix") }),
    // token de uso único do PSP ou cartão salvo da cliente (savedCardId)
    z.object({
      type: z.literal("card"),
      paymentMethodToken: z.string().min(8).optional(),
      savedCardId: z.string().uuid().optional(),
    }),
  ]).optional(),
  subscriptionId: z.string().uuid().optional(),
}).strict().refine((body) => Boolean(body.paymentMethod) !== Boolean(body.subscriptionId), {
  message: "Envie paymentMethod ou subscriptionId (um dos dois).",
  path: ["paymentMethod"],
}).refine((body) => body.paymentMethod?.type !== "card"
  || Boolean(body.paymentMethod.paymentMethodToken) !== Boolean(body.paymentMethod.savedCardId), {
  message: "Envie o token do cartão ou o cartão salvo (um dos dois).",
  path: ["paymentMethod"],
});

// Toda criação de pedido pago pelo app exige a chave (cobrar duas vezes a
// mesma cliente é o pior bug possível).
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_\-:.]{8,200}$/;

ordersRouter.post("/orders", requireRole("cliente"), asyncHandler(async (request, response) => {
  const orderRequest = createOrderSchema.parse(request.body);
  const scheduledDate = new Date(orderRequest.scheduledAt);
  if (scheduledDate <= new Date())
    throw new ApiError(422, "validation_error", "Invalid.", { scheduledAt: "Must be in the future." });

  const rawKey = request.get("Idempotency-Key");
  if (rawKey && !IDEMPOTENCY_KEY_PATTERN.test(rawKey))
    throw new ApiError(400, "idempotency_key_required", "Idempotency-Key inválida (8 a 200 caracteres).");
  const idempotencyKey = rawKey ? `${request.user.id}:${rawKey}` : null;
  const requestFingerprint = fingerprint({ ...orderRequest, paymentMethod: orderRequest.paymentMethod?.type ?? null });
  // Repetição do mesmo pedido (rede caiu, toque duplo): devolve o pedido já criado
  if (idempotencyKey) {
    const { rows: previous } = await runQuery(
      "SELECT order_id, request_fingerprint FROM charges WHERE idempotency_key=$1",
      [idempotencyKey]
    );
    if (previous[0]) {
      assertSameRequest(previous[0].request_fingerprint, requestFingerprint);
      const { rows: existing } = await runQuery(`${ORDER_SELECT_SQL} WHERE orders.id = $2`, [request.user.id, previous[0].order_id]);
      return response.status(200).json(existing[0]);
    }
  }

  let createdOrder;
  try {
  createdOrder = await runInTransaction(async (transactionClient) => {
    const { rows: matchingServices } = await transactionClient.query(
      `SELECT service.*, provider_profile.activation_status
       FROM services service
       JOIN provider_profiles provider_profile ON provider_profile.user_id = service.provider_id
       WHERE service.id = $1 AND service.active AND NOT service.hidden_by_admin`,
      [orderRequest.serviceId]
    );
    const service = matchingServices[0];
    if (!service || service.activation_status !== "active")
      throw new ApiError(404, "not_found", "Service not available.");
    // Conta com os dois papéis não pode contratar o próprio serviço
    if (service.provider_id === request.user.id)
      throw new ApiError(422, "self_dealing", "You cannot book your own service.", {
        serviceId: "Choose a service from another provider.",
      });

    // Atendimento na casa do cliente exige um endereço dele. Atendimento na prestadora não:
    // o endereço do cliente nem é gravado (a prestadora não precisa saber onde ele mora).
    let customerAddressId = null;
    if (service.service_location === "at_customer") {
      if (!orderRequest.addressId) {
        throw new ApiError(422, "validation_error", "The request is invalid.", {
          addressId: "Required for services performed at the customer's address.",
        });
      }
      const { rows: customerAddresses } = await transactionClient.query(
        "SELECT 1 FROM addresses WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL",
        [orderRequest.addressId, request.user.id]
      );
      if (!customerAddresses[0]) throw new ApiError(404, "not_found", "Address not found.");
      customerAddressId = orderRequest.addressId;
    }

    // O horário precisa caber no horário de atendimento do serviço, a prestadora
    // não pode ter outro pedido ativo nele e a cliente não pode ter outro compromisso
    assertWithinAvailability(service.availability, scheduledDate, service.duration_minutes);
    const serviceEndDate = await assertSlotFree(transactionClient, {
      providerId: service.provider_id,
      customerId: request.user.id,
      start: scheduledDate,
      durationMinutes: service.duration_minutes,
    });

    // Preço calculado pelo servidor; não há comissão da plataforma.
    const basePrice = Number(service.base_price);
    const commission = 0;
    const totalAmount = roundToTwoDecimals(basePrice);
    const checkInCode = String(crypto.randomInt(0, 10000)).padStart(4, "0");

    const { rows: insertedOrders } = await transactionClient.query(
      `INSERT INTO orders (customer_id,provider_id,service_id,address_id,service_location,scheduled_at,duration_minutes,total_amount,commission,checkin_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [request.user.id, service.provider_id, service.id, customerAddressId, service.service_location,
       scheduledDate, service.duration_minutes, totalAmount, commission, checkInCode]
    );
    const insertedOrder = insertedOrders[0];

    if (orderRequest.subscriptionId) {
      // Sessão da assinatura: debitada no agendamento (devolvida se cancelar no prazo)
      await debitEntitlement(transactionClient, {
        customerId: request.user.id,
        subscriptionId: orderRequest.subscriptionId,
        serviceId: service.id,
        scheduledAt: scheduledDate,
        orderId: insertedOrder.id,
      });
    } else {
      const account = await payments.receivesInApp(transactionClient, service.provider_id);
      if (account) {
        // Cobrado agora, pelo gateway; a prestadora aceita depois do webhook
        if (!idempotencyKey)
          throw new ApiError(400, "idempotency_key_required", "Envie o header Idempotency-Key para pagar pelo app.");
        await payments.createOrderCharge(transactionClient, {
          order: insertedOrder, service, customerId: request.user.id, paymentMethod: orderRequest.paymentMethod,
          idempotencyKey, requestFingerprint, account,
        });
      } else {
        // Prestadora sem conta de recebimento: fluxo antigo, sem gateway
        await transactionClient.query(
          "INSERT INTO payments (order_id,status,method,method_token,held_until) VALUES ($1,'held',$2,$3,$4)",
          [insertedOrder.id, orderRequest.paymentMethod.type, orderRequest.paymentMethod.paymentMethodToken ?? null, serviceEndDate]
        );
      }
    }
    await transactionClient.query(
      "INSERT INTO order_events (order_id,actor_id,type) VALUES ($1,$2,'requested')",
      [insertedOrder.id, request.user.id]
    );
    await notify(transactionClient, {
      userId: service.provider_id,
      type: "order_requested",
      title: "Novo pedido",
      body: `${await userName(transactionClient, request.user.id)} agendou ${service.title} para ${formatWhen(scheduledDate)}.`,
      data: { orderId: insertedOrder.id },
      area: "provider",
    });
    return insertedOrder;
  });
  } catch (error) {
    // mesma chave chegando duas vezes ao mesmo tempo: a segunda devolve a primeira
    if (error.code === "23505" && error.constraint === "charges_idempotency_key_key") {
      const { rows: previous } = await runQuery("SELECT order_id, request_fingerprint FROM charges WHERE idempotency_key=$1", [idempotencyKey]);
      assertSameRequest(previous[0].request_fingerprint, requestFingerprint);
      createdOrder = { id: previous[0].order_id };
    } else {
      throw error;
    }
  }

  const { rows: orderDetails } = await runQuery(`${ORDER_SELECT_SQL} WHERE orders.id = $2`, [request.user.id, createdOrder.id]);
  response.status(201).json(orderDetails[0]);
}));

// ---------- Ler pedidos ----------

// Agenda de cada área: ?as=customer (pedidos que a pessoa contratou) ou
// ?as=provider (pedidos que ela atende). Sem "as", devolve os dois (compatibilidade).
const agendaQuerySchema = z.object({ as: z.enum(["customer", "provider"]).optional() }).strict();
const AGENDA_ROLE = { customer: "cliente", provider: "prestadora" };

function agendaView(request) {
  const { as: view } = agendaQuerySchema.parse(request.query);
  if (view && !(request.user.roles ?? []).includes(AGENDA_ROLE[view]))
    throw new ApiError(403, "forbidden", `Requires role ${AGENDA_ROLE[view]}.`);
  return view;
}

ordersRouter.get("/me/orders", asyncHandler(async (request, response) => {
  const view = agendaView(request);
  const filter = view === "customer"
    ? "orders.customer_id = $1"
    : view === "provider"
      ? "orders.provider_id = $1"
      : "(orders.customer_id = $1 OR orders.provider_id = $1)";
  const { rows: myOrders } = await runQuery(
    `${ORDER_SELECT_SQL}
     WHERE ${filter}
     ORDER BY orders.scheduled_at DESC
     LIMIT 100`,
    [request.user.id]
  );
  response.json(myOrders);
}));

// Compromissos da OUTRA área, só como "ocupado": sem nomes, endereço, valor ou id.
// Ex.: ?as=customer devolve os atendimentos que a pessoa faz como prestadora.
ordersRouter.get("/me/orders/busy", asyncHandler(async (request, response) => {
  const { as: view } = z.object({ as: z.enum(["customer", "provider"]) }).strict().parse(request.query);
  const otherSide = view === "customer" ? "provider_id" : "customer_id";
  const { rows } = await runQuery(
    `SELECT scheduled_at AS "scheduledAt", duration_minutes AS "durationMinutes", status
     FROM orders
     WHERE ${otherSide} = $1 AND status = ANY($2::text[])
     ORDER BY scheduled_at
     LIMIT 200`,
    [request.user.id, ACTIVE_ORDER_STATUSES]
  );
  response.json(rows);
}));

// Horários de um serviço num dia (horário de Brasília), para a tela de agendar.
// Cada horário vem com available=false quando a prestadora já tem pedido nele
// (reason "provider_busy") ou quando a própria pessoa tem compromisso (reason "your_commitment").
// ?excludeOrderId= ignora um pedido de quem consulta (a prestadora escolhendo
// outro horário para ele não vê o horário atual do pedido como ocupado).
ordersRouter.get("/services/:id/slots", asyncHandler(async (request, response) => {
  if (!isValidUuid(request.params.id)) throw new ApiError(404, "not_found", "Service not found.");
  const { date, excludeOrderId } = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    excludeOrderId: z.string().uuid().optional(),
  }).strict().parse(request.query);
  assertBookableDate(date);

  const { rows: services } = await runQuery(
    `SELECT service.id, service.provider_id, service.duration_minutes, service.availability
     FROM services service
     JOIN provider_profiles provider_profile ON provider_profile.user_id = service.provider_id
     WHERE service.id = $1 AND service.active AND NOT service.hidden_by_admin AND provider_profile.activation_status = 'active'`,
    [request.params.id]
  );
  const service = services[0];
  if (!service) throw new ApiError(404, "not_found", "Service not available.");

  const { windows, slots } = await slotsForDay(
    { query: runQuery },
    { service, dateKey: date, customerId: request.user.id, excludeOrderId: excludeOrderId ?? null }
  );
  response.json({
    date,
    durationMinutes: service.duration_minutes,
    availability: service.availability ?? [],
    hours: windows.map(({ start, end }) => ({ start, end })),
    slots,
  });
}));

ordersRouter.get("/orders/:id", asyncHandler(async (request, response) => {
  await loadOrderForParticipant(request.params.id, request.user.id);
  const { rows: orderDetails } = await runQuery(`${ORDER_SELECT_SQL} WHERE orders.id = $2`, [request.user.id, request.params.id]);
  response.json(orderDetails[0]);
}));

// ---------- Mudar status ----------

// estado atual -> { próximo estado permitido: quem pode fazer a mudança }
const ORDER_STATUS_TRANSITIONS = {
  requested: { accepted: "provider", cancelled: "any" },
  accepted: { cancelled: "any" },
  on_the_way: { in_progress: "provider", cancelled: "any" },
  in_progress: { completed: "provider", disputed: "any" },
  completed: { disputed: "any" },
};
//Permite mudança de ator mediante situação de atendimento.
function allowedActorForTransition(order, nextStatus) {
  if (order.status === "accepted" && nextStatus === "on_the_way") {
    if (order.service_location === "at_provider") return "customer";
    if (order.service_location === "at_customer") return "provider";
    return null;
  }

  return ORDER_STATUS_TRANSITIONS[order.status]?.[nextStatus];
}

// Avisa a outra parte de cada mudança de status do pedido (sino e push).
// cliente recebe: aceito, a caminho (prestadora indo até ela), iniciado,
// concluído; prestadora recebe: cliente a caminho (atendimento no espaço dela);
// as duas recebem cancelamento e contestação feitos pela outra.
// Cancelamento pela prestadora antes do aceite é uma recusa; o motivo, se
// houver, vai no texto do aviso.
async function notifyOrderStatus(transactionClient, order, nextStatus, actingUserId, reason = null) {
  const actorIsCustomer = actingUserId === order.customer_id;
  const recipientId = actorIsCustomer ? order.provider_id : order.customer_id;
  const area = actorIsCustomer ? "provider" : "customer";
  const actor = await userName(transactionClient, actingUserId);
  const when = formatWhen(order.scheduled_at);
  const messages = {
    accepted: ["Pedido aceito", `${actor} aceitou seu pedido para ${when}.`],
    on_the_way: actorIsCustomer
      ? [`${actor} está a caminho`, `A cliente saiu para o atendimento de ${when}.`]
      : ["A prestadora está a caminho", `${actor} saiu para o seu atendimento de ${when}.`],
    in_progress: ["Atendimento iniciado", `${actor} iniciou o atendimento.`],
    completed: ["Atendimento concluído", `Conte como foi: avalie o atendimento de ${actor}.`],
    cancelled: !actorIsCustomer && order.status === "requested"
      ? ["Pedido recusado", `${actor} recusou seu pedido de ${when}.`]
      : ["Pedido cancelado", `${actor} cancelou o pedido de ${when}.`],
    disputed: ["Pedido contestado", `${actor} abriu uma contestação sobre o pedido de ${when}.`],
  };
  const message = messages[nextStatus];
  if (!message) return;
  await notify(transactionClient, {
    userId: recipientId,
    type: `order_${nextStatus}`,
    title: message[0],
    body: reason ? `${message[1]} Motivo: ${reason}` : message[1],
    data: { orderId: order.id },
    area,
  });
}

// `reason` só vale para cancelamento. `notifyOther: false` quando quem chama
// manda um aviso próprio (ex.: cliente recusou o horário sugerido).
async function applyStatusTransition(
  transactionClient, order, nextStatus, actingUserId, actingRole, { reason = null, notifyOther = true } = {}
) {
  const allowedActor = allowedActorForTransition(order, nextStatus);
  if (!allowedActor || (allowedActor !== "any" && allowedActor !== actingRole))
    throw new ApiError(409, "invalid_transition", `Cannot change from ${order.status} to ${nextStatus}.`);
  // Pago pelo app: só aceita depois que o webhook confirmar o pagamento
  if (nextStatus === "accepted") await payments.assertOrderPaid(transactionClient, order);

  // Sair de "requested" (aceite ou cancelamento) encerra a sugestão de horário pendente
  await transactionClient.query(
    "UPDATE orders SET status=$1, proposed_scheduled_at=NULL, proposal_reason=NULL WHERE id=$2",
    [nextStatus, order.id]
  );
  if (reason) {
    await transactionClient.query("UPDATE orders SET cancellation_reason=$1 WHERE id=$2", [reason, order.id]);
  }
  await transactionClient.query(
    "INSERT INTO order_events (order_id,actor_id,type,data) VALUES ($1,$2,'status_changed',$3)",
    [order.id, actingUserId, { from: order.status, to: nextStatus, ...(reason ? { reason } : {}) }]
  );
  if (notifyOther) await notifyOrderStatus(transactionClient, order, nextStatus, actingUserId, reason);

  if (nextStatus === "completed") {
    // Sessão de assinatura: a receita entrou com a cobrança da assinatura
    const { rows: usages } = await transactionClient.query("SELECT 1 FROM entitlement_usages WHERE order_id=$1", [order.id]);
    const charge = await payments.latestOrderCharge(transactionClient, order.id);
    // Pago pelo app: o repasse já está previsto em payables, com o valor do split
    const receivableAmount = charge ? decimalFromCents(charge.provider_amount_cents) : roundToTwoDecimals(Number(order.total_amount));
    if (!charge && !usages[0]) {
      await transactionClient.query("UPDATE payments SET status='captured' WHERE order_id=$1", [order.id]);
      await transactionClient.query(
        "INSERT INTO payouts (order_id,provider_id,amount) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
        [order.id, order.provider_id, roundToTwoDecimals(Number(order.total_amount))]
      );
    }
    if (!usages[0]) await transactionClient.query(
      `INSERT INTO financial_entries
        (provider_id,entry_type,amount,category,description,service_id,customer_id,source_order_id,occurred_at)
       VALUES ($1,'receivable',$2,'Serviço concluído',$3,$4,$5,$6,now())
       ON CONFLICT (source_order_id) WHERE source_order_id IS NOT NULL DO NOTHING`,
      [
        order.provider_id,
        receivableAmount,
        `Repasse pendente do atendimento ${order.friendly_id ?? order.id}`,
        order.service_id,
        order.customer_id,
        order.id,
      ]
    );
  }
  if (nextStatus === "cancelled") {
    await transactionClient.query("UPDATE payments SET status='released' WHERE order_id=$1 AND status='held'", [order.id]);
    // Pago pelo app: estorno (recusa ou cancelamento no prazo) ou sessão devolvida
    await payments.handleOrderCancelled(transactionClient, order, actingRole);
  }
}

const reasonSchema = z.string().trim().min(1).max(200);

// `reason` (opcional) só com status "cancelled": vai para o pedido
// (cancellationReason) e para o aviso da outra parte.
const changeStatusSchema = z.object({
  status: z.enum(["accepted", "on_the_way", "in_progress", "completed", "cancelled", "disputed"]),
  reason: reasonSchema.optional(),
}).strict().refine((body) => !body.reason || body.status === "cancelled", {
  message: "A reason is only accepted when cancelling.",
  path: ["reason"],
});

ordersRouter.patch("/orders/:id/status", asyncHandler(async (request, response) => {
  const { status: nextStatus, reason } = changeStatusSchema.parse(request.body);

  await runInTransaction(async (transactionClient) => {
    const order = await loadOrderForParticipant(request.params.id, request.user.id, transactionClient);
    const actingRole = order.provider_id === request.user.id ? "provider" : "customer";
    await applyStatusTransition(transactionClient, order, nextStatus, request.user.id, actingRole, { reason });
  });

  const { rows: orderDetails } = await runQuery(`${ORDER_SELECT_SQL} WHERE orders.id = $2`, [request.user.id, request.params.id]);
  response.json(orderDetails[0]);
}));

// ---------- Sugerir outro horário (prestadora) e responder (cliente) ----------
//
// Antes de aceitar, a prestadora pode sugerir outro horário (ex.: está ocupada
// no escolhido). O pedido continua "requested" com a sugestão pendente; uma
// nova sugestão substitui a anterior. A cliente:
// - aceita: o pedido passa para o novo horário e já fica "accepted";
// - recusa: o pedido é cancelado e o pagamento retido, liberado.
// A sugestão vale até 1 hora antes do horário sugerido. O horário sugerido não
// fica reservado: a disponibilidade é conferida de novo quando a cliente aceita.

const timeProposalSchema = z.object({
  scheduledAt: z.string().datetime({ offset: true }),
  reason: reasonSchema.optional(),
}).strict();

const orderDetails = async (userId, orderId) =>
  (await runQuery(`${ORDER_SELECT_SQL} WHERE orders.id = $2`, [userId, orderId])).rows[0];

// O novo horário cabe no horário de atendimento e está livre para as duas
// (ignorando o próprio pedido). Devolve o fim do atendimento.
async function assertNewTimeFits(transactionClient, order, start) {
  const { rows: services } = await transactionClient.query("SELECT availability FROM services WHERE id=$1", [order.service_id]);
  assertWithinAvailability(services[0]?.availability, start, order.duration_minutes);
  return assertSlotFree(transactionClient, {
    providerId: order.provider_id,
    customerId: order.customer_id,
    start,
    durationMinutes: order.duration_minutes,
    excludeOrderId: order.id,
  });
}

// A sugestão pendente do pedido, para a cliente responder
function pendingProposal(order, userId) {
  if (order.customer_id !== userId)
    throw new ApiError(403, "forbidden", "Only the customer answers a time proposal.");
  if (order.status !== "requested" || !order.proposed_scheduled_at)
    throw new ApiError(409, "no_time_proposal", "There is no time proposal to answer.");
  return new Date(order.proposed_scheduled_at);
}

ordersRouter.post("/orders/:id/time-proposal", requireRole("prestadora"), asyncHandler(async (request, response) => {
  const proposal = timeProposalSchema.parse(request.body);
  const proposedAt = new Date(proposal.scheduledAt);
  if (proposalExpiresAt(proposedAt) <= new Date())
    throw new ApiError(422, "validation_error", "Invalid.", {
      scheduledAt: "Sugira um horário com pelo menos 1 hora de antecedência.",
    });

  await runInTransaction(async (transactionClient) => {
    const order = await loadOrderForParticipant(request.params.id, request.user.id, transactionClient);
    if (order.provider_id !== request.user.id) throw new ApiError(403, "forbidden", "Not your order.");
    if (order.status !== "requested")
      throw new ApiError(409, "invalid_transition", "Only orders not yet accepted can get another time.");
    if (proposedAt.getTime() === new Date(order.scheduled_at).getTime())
      throw new ApiError(422, "validation_error", "Invalid.", { scheduledAt: "Escolha um horário diferente do pedido." });

    await assertNewTimeFits(transactionClient, order, proposedAt);
    await transactionClient.query(
      "UPDATE orders SET proposed_scheduled_at=$1, proposal_reason=$2 WHERE id=$3",
      [proposedAt, proposal.reason ?? null, order.id]
    );
    await transactionClient.query(
      "INSERT INTO order_events (order_id,actor_id,type,data) VALUES ($1,$2,'time_proposed',$3)",
      [order.id, request.user.id, { from: order.scheduled_at, to: proposedAt, ...(proposal.reason ? { reason: proposal.reason } : {}) }]
    );
    const actor = await userName(transactionClient, request.user.id);
    const body = `${actor} não pode em ${formatWhen(order.scheduled_at)} e sugeriu ${formatWhen(proposedAt)}.`;
    await notify(transactionClient, {
      userId: order.customer_id,
      type: "order_reschedule_proposed",
      title: "Nova sugestão de horário",
      body: proposal.reason ? `${body} Motivo: ${proposal.reason}` : body,
      data: { orderId: order.id },
      area: "customer",
    });
  });
  response.json(await orderDetails(request.user.id, request.params.id));
}));

ordersRouter.post("/orders/:id/time-proposal/accept", asyncHandler(async (request, response) => {
  await runInTransaction(async (transactionClient) => {
    const order = await loadOrderForParticipant(request.params.id, request.user.id, transactionClient);
    const proposedAt = pendingProposal(order, request.user.id);
    if (proposalExpiresAt(proposedAt) <= new Date())
      throw new ApiError(409, "proposal_expired", "The suggested time is no longer valid.");

    const endAt = await assertNewTimeFits(transactionClient, order, proposedAt);
    await transactionClient.query(
      `UPDATE orders SET scheduled_at=$1, status='accepted', proposed_scheduled_at=NULL, proposal_reason=NULL
       WHERE id=$2`,
      [proposedAt, order.id]
    );
    await transactionClient.query("UPDATE payments SET held_until=$1 WHERE order_id=$2 AND status='held'", [endAt, order.id]);
    await transactionClient.query(
      "INSERT INTO order_events (order_id,actor_id,type,data) VALUES ($1,$2,'time_proposal_accepted',$3)",
      [order.id, request.user.id, { from: order.scheduled_at, to: proposedAt }]
    );
    await transactionClient.query(
      "INSERT INTO order_events (order_id,actor_id,type,data) VALUES ($1,$2,'status_changed',$3)",
      [order.id, request.user.id, { from: "requested", to: "accepted" }]
    );
    await notify(transactionClient, {
      userId: order.provider_id,
      type: "order_reschedule_accepted",
      title: "Novo horário aceito",
      body: `${await userName(transactionClient, request.user.id)} aceitou ${formatWhen(proposedAt)}. O pedido está confirmado.`,
      data: { orderId: order.id },
      area: "provider",
    });
  });
  response.json(await orderDetails(request.user.id, request.params.id));
}));

ordersRouter.post("/orders/:id/time-proposal/decline", asyncHandler(async (request, response) => {
  await runInTransaction(async (transactionClient) => {
    const order = await loadOrderForParticipant(request.params.id, request.user.id, transactionClient);
    const proposedAt = pendingProposal(order, request.user.id);
    await applyStatusTransition(transactionClient, order, "cancelled", request.user.id, "customer", {
      reason: "A cliente recusou o horário sugerido.",
      notifyOther: false,
    });
    await transactionClient.query(
      "INSERT INTO order_events (order_id,actor_id,type,data) VALUES ($1,$2,'time_proposal_declined',$3)",
      [order.id, request.user.id, { proposed: proposedAt }]
    );
    await notify(transactionClient, {
      userId: order.provider_id,
      type: "order_reschedule_declined",
      title: "Horário sugerido recusado",
      body: `${await userName(transactionClient, request.user.id)} recusou ${formatWhen(proposedAt)}. O pedido foi cancelado.`,
      data: { orderId: order.id },
      area: "provider",
    });
  });
  response.json(await orderDetails(request.user.id, request.params.id));
}));

// ---------- Check-in / check-out (só prestadora) ----------

const checkInSchema = z.object({
  type: z.enum(["entry", "exit"]),
  code: z.string().regex(/^\d{4}$/),
  location: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  }).optional(),
});

ordersRouter.post("/orders/:id/check-ins", requireRole("prestadora"), asyncHandler(async (request, response) => {
  const checkInData = checkInSchema.parse(request.body);

  await runInTransaction(async (transactionClient) => {
    const order = await loadOrderForParticipant(request.params.id, request.user.id, transactionClient);
    if (order.provider_id !== request.user.id) throw new ApiError(403, "forbidden", "Not your order.");
    if (order.checkin_code !== checkInData.code)
      throw new ApiError(422, "validation_error", "Invalid.", { code: "Invalid or expired code." });

    const nextStatus = checkInData.type === "entry" ? "in_progress" : "completed";
    await applyStatusTransition(transactionClient, order, nextStatus, request.user.id, "provider");

    await transactionClient.query(
      "INSERT INTO check_ins (order_id,user_id,type,latitude,longitude) VALUES ($1,$2,$3,$4,$5)",
      [order.id, request.user.id, checkInData.type, checkInData.location?.latitude ?? null, checkInData.location?.longitude ?? null]
    );
    await transactionClient.query(
      "INSERT INTO order_events (order_id,actor_id,type,data) VALUES ($1,$2,'check_in',$3)",
      [order.id, request.user.id, { type: checkInData.type }]
    );
  });
  response.status(201).json({ ok: true });
}));

module.exports = { ordersRouter, loadOrderForParticipant };
