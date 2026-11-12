const ordersRouter = require("express").Router();
const crypto = require("crypto");
const { z } = require("zod");
const { runQuery, runInTransaction } = require("../db");
const { ApiError, asyncHandler } = require("../errors");
const { requireRole } = require("../security");
const { isValidUuid } = require("../validation");

const COMMISSION_RATE = Number(process.env.COMMISSION_RATE || 0.12);
const roundToTwoDecimals = (value) => Math.round(value * 100) / 100;

// $1 = id de quem está logado.
// - checkinCode: só o cliente vê.
// - serviceLocation: "at_customer" (a prestadora vai até o cliente) ou "at_provider" (o cliente vai até ela).
// - location (coordenadas do endereço do cliente, só em at_customer): o cliente sempre vê; a prestadora
//   só vê depois de aceitar o pedido (antes disso o endereço fica protegido).
// - venue (endereço exato da prestadora, só em at_provider): só aparece depois que o pedido é aceito.
const ORDER_SELECT_SQL = `
  SELECT
    orders.id,
    orders.status,
    orders.service_id AS "serviceId",
    orders.provider_id AS "providerId",
    provider_user.name AS "providerName",
    orders.customer_id AS "customerId",
    customer_user.name AS "customerName",
    orders.scheduled_at AS "scheduledAt",
    orders.total_amount::float AS "totalAmount",
    orders.commission::float AS commission,
    orders.service_location AS "serviceLocation",
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
    json_build_object(
      'id', payments.id,
      'status', payments.status,
      'method', payments.method,
      'heldUntil', payments.held_until
    ) AS payment
  FROM orders
  JOIN users customer_user ON customer_user.id = orders.customer_id
  JOIN users provider_user ON provider_user.id = orders.provider_id
  LEFT JOIN addresses order_address ON order_address.id = orders.address_id
  LEFT JOIN provider_venues order_venue ON order_venue.provider_id = orders.provider_id
  LEFT JOIN payments ON payments.order_id = orders.id`;

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

const createOrderSchema = z.object({
  serviceId: z.string().uuid(),
  addressId: z.string().uuid().optional(), // obrigatório só em serviços "at_customer"
  scheduledAt: z.string().datetime({ offset: true }),
  paymentMethod: z.discriminatedUnion("type", [
    z.object({ type: z.literal("pix") }),
    z.object({ type: z.literal("card"), paymentMethodToken: z.string().min(8) }),
  ]),
}).strict();

ordersRouter.post("/orders", requireRole("cliente"), asyncHandler(async (request, response) => {
  const orderRequest = createOrderSchema.parse(request.body);
  const scheduledDate = new Date(orderRequest.scheduledAt);
  if (scheduledDate <= new Date())
    throw new ApiError(422, "validation_error", "Invalid.", { scheduledAt: "Must be in the future." });

  const createdOrder = await runInTransaction(async (transactionClient) => {
    const { rows: matchingServices } = await transactionClient.query(
      `SELECT service.*, provider_profile.activation_status
       FROM services service
       JOIN provider_profiles provider_profile ON provider_profile.user_id = service.provider_id
       WHERE service.id = $1 AND service.active`,
      [orderRequest.serviceId]
    );
    const service = matchingServices[0];
    if (!service || service.activation_status !== "active")
      throw new ApiError(404, "not_found", "Service not available.");

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

    // A prestadora não pode ter dois pedidos ativos no mesmo horário
    const serviceEndDate = new Date(scheduledDate.getTime() + service.duration_minutes * 60000);
    const { rows: conflictingOrders } = await transactionClient.query(
      `SELECT 1 FROM orders
       WHERE provider_id=$1 AND status IN ('requested','accepted','on_the_way','in_progress')
         AND $2 < scheduled_at + duration_minutes * interval '1 minute' AND $3 > scheduled_at`,
      [service.provider_id, scheduledDate, serviceEndDate]
    );
    if (conflictingOrders[0])
      throw new ApiError(409, "conflict", "Slot unavailable.", { scheduledAt: "The selected time is no longer available." });

    // Preço e comissão são sempre calculados aqui, nunca vêm do app
    const basePrice = Number(service.base_price);
    const commission = roundToTwoDecimals(basePrice * COMMISSION_RATE);
    const totalAmount = roundToTwoDecimals(basePrice + commission);
    const checkInCode = String(crypto.randomInt(0, 10000)).padStart(4, "0");

    const { rows: insertedOrders } = await transactionClient.query(
      `INSERT INTO orders (customer_id,provider_id,service_id,address_id,service_location,scheduled_at,duration_minutes,total_amount,commission,checkin_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [request.user.id, service.provider_id, service.id, customerAddressId, service.service_location,
       scheduledDate, service.duration_minutes, totalAmount, commission, checkInCode]
    );
    const insertedOrder = insertedOrders[0];

    // TODO: autorizar/reter o pagamento no gateway (Pix/cartão) antes de gravar como "held"
    await transactionClient.query(
      "INSERT INTO payments (order_id,status,method,method_token,held_until) VALUES ($1,'held',$2,$3,$4)",
      [insertedOrder.id, orderRequest.paymentMethod.type, orderRequest.paymentMethod.paymentMethodToken ?? null, serviceEndDate]
    );
    await transactionClient.query(
      "INSERT INTO order_events (order_id,actor_id,type) VALUES ($1,$2,'requested')",
      [insertedOrder.id, request.user.id]
    );
    return insertedOrder;
  });

  const { rows: orderDetails } = await runQuery(`${ORDER_SELECT_SQL} WHERE orders.id = $2`, [request.user.id, createdOrder.id]);
  response.status(201).json(orderDetails[0]);
}));

// ---------- Ler pedidos ----------

ordersRouter.get("/me/orders", asyncHandler(async (request, response) => {
  const { rows: myOrders } = await runQuery(
    `${ORDER_SELECT_SQL}
     WHERE orders.customer_id = $1 OR orders.provider_id = $1
     ORDER BY orders.scheduled_at DESC
     LIMIT 100`,
    [request.user.id]
  );
  response.json(myOrders);
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
  accepted: { on_the_way: "provider", cancelled: "any" },
  on_the_way: { in_progress: "provider", cancelled: "any" },
  in_progress: { completed: "provider", disputed: "any" },
  completed: { disputed: "any" },
};

async function applyStatusTransition(transactionClient, order, nextStatus, actingUserId, actingRole) {
  const allowedActor = ORDER_STATUS_TRANSITIONS[order.status]?.[nextStatus];
  if (!allowedActor || (allowedActor !== "any" && allowedActor !== actingRole))
    throw new ApiError(409, "invalid_transition", `Cannot change from ${order.status} to ${nextStatus}.`);

  await transactionClient.query("UPDATE orders SET status=$1 WHERE id=$2", [nextStatus, order.id]);
  await transactionClient.query(
    "INSERT INTO order_events (order_id,actor_id,type,data) VALUES ($1,$2,'status_changed',$3)",
    [order.id, actingUserId, { from: order.status, to: nextStatus }]
  );

  if (nextStatus === "completed") {
    await transactionClient.query("UPDATE payments SET status='captured' WHERE order_id=$1", [order.id]);
    await transactionClient.query(
      "INSERT INTO payouts (order_id,provider_id,amount) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
      [order.id, order.provider_id, roundToTwoDecimals(Number(order.total_amount) - Number(order.commission))]
    );
  }
  if (nextStatus === "cancelled") {
    await transactionClient.query("UPDATE payments SET status='released' WHERE order_id=$1 AND status='held'", [order.id]);
  }
}

const changeStatusSchema = z.object({
  status: z.enum(["accepted", "on_the_way", "in_progress", "completed", "cancelled", "disputed"]),
}).strict();

ordersRouter.patch("/orders/:id/status", asyncHandler(async (request, response) => {
  const { status: nextStatus } = changeStatusSchema.parse(request.body);

  await runInTransaction(async (transactionClient) => {
    const order = await loadOrderForParticipant(request.params.id, request.user.id, transactionClient);
    const actingRole = order.provider_id === request.user.id ? "provider" : "customer";
    await applyStatusTransition(transactionClient, order, nextStatus, request.user.id, actingRole);
  });

  const { rows: orderDetails } = await runQuery(`${ORDER_SELECT_SQL} WHERE orders.id = $2`, [request.user.id, request.params.id]);
  response.json(orderDetails[0]);
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
