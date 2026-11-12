const socialRouter = require("express").Router();
const { z } = require("zod");
const { runQuery } = require("../db");
const { ApiError, asyncHandler } = require("../errors");
const { loadOrderForParticipant } = require("./orders");

// Troca telefones escritos nas mensagens por um aviso (a conversa não pode vazar contatos)
const maskPhoneNumbers = (messageText) => messageText.replace(/\+?\d[\d\s().-]{7,}\d/g, "[telefone oculto]");

// Dado um pedido e um participante, devolve o id do outro participante
const getOtherParticipantId = (order, userId) =>
  order.customer_id === userId ? order.provider_id : order.customer_id;

// ---------- Mensagens ----------

socialRouter.get("/orders/:id/messages", asyncHandler(async (request, response) => {
  const order = await loadOrderForParticipant(request.params.id, request.user.id);
  const { rows: messages } = await runQuery(
    `SELECT id, author_id AS "authorId", text, created_at AS "createdAt" FROM messages WHERE order_id=$1 ORDER BY created_at`,
    [order.id]
  );
  response.json(messages);
}));

const sendMessageSchema = z.object({ text: z.string().trim().min(1).max(1000) }).strict();

socialRouter.post("/orders/:id/messages", asyncHandler(async (request, response) => {
  const { text: messageText } = sendMessageSchema.parse(request.body);
  const order = await loadOrderForParticipant(request.params.id, request.user.id);

  const { rows: createdMessages } = await runQuery(
    `INSERT INTO messages (order_id,author_id,text) VALUES ($1,$2,$3)
     RETURNING id, author_id AS "authorId", text, created_at AS "createdAt"`,
    [order.id, request.user.id, maskPhoneNumbers(messageText)]
  );
  response.status(201).json(createdMessages[0]);
}));

// ---------- Denúncias ----------

const createReportSchema = z.object({
  reportedUserId: z.string().uuid(),
  reason: z.string().min(2).max(60),
  description: z.string().max(2000).optional(),
}).strict();

socialRouter.post("/orders/:id/reports", asyncHandler(async (request, response) => {
  const reportData = createReportSchema.parse(request.body);
  const order = await loadOrderForParticipant(request.params.id, request.user.id);

  if (reportData.reportedUserId !== getOtherParticipantId(order, request.user.id))
    throw new ApiError(422, "validation_error", "Invalid.", { reportedUserId: "Not related to this order." });

  const { rows: createdReports } = await runQuery(
    "INSERT INTO reports (order_id,reporter_id,reported_user_id,reason,description) VALUES ($1,$2,$3,$4,$5) RETURNING id, status",
    [order.id, request.user.id, reportData.reportedUserId, reportData.reason, reportData.description ?? null]
  );
  response.status(201).json(createdReports[0]);
}));

// ---------- Avaliações ----------

const createReviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  tags: z.array(z.string().max(40)).max(10).optional(),
  comment: z.string().max(1000).optional(),
  tipAmount: z.number().min(0).max(1000).optional(),
}).strict();

socialRouter.post("/orders/:id/reviews", asyncHandler(async (request, response) => {
  const reviewData = createReviewSchema.parse(request.body);
  const order = await loadOrderForParticipant(request.params.id, request.user.id);
  if (order.status !== "completed") throw new ApiError(409, "invalid_state", "Order is not completed.");

  const reviewDirection = order.customer_id === request.user.id ? "customer_to_provider" : "provider_to_customer";
  // gorjeta só existe quando o cliente avalia a prestadora
  const tipAmount = reviewDirection === "customer_to_provider" ? reviewData.tipAmount ?? null : null;

  try {
    const { rows: createdReviews } = await runQuery(
      `INSERT INTO reviews (order_id,author_id,target_id,direction,rating,tags,comment,tip_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, rating, tags, comment`,
      [order.id, request.user.id, getOtherParticipantId(order, request.user.id), reviewDirection,
       reviewData.rating, reviewData.tags ?? [], reviewData.comment ?? null, tipAmount]
    );
    response.status(201).json(createdReviews[0]);
  } catch (databaseError) {
    if (databaseError.code === "23505") throw new ApiError(409, "conflict", "You already reviewed this order.");
    throw databaseError;
  }
}));

module.exports = socialRouter;
