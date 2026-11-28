// Cartões salvos da cliente. O app tokeniza no PSP e manda só o token; aqui
// o cartão é salvo na cliente do PSP e guardamos o id dele e os dados de
// exibição (bandeira, final, validade). Número e CVV nunca passam pela API.
const db = require("../db");
const { ApiError } = require("../errors");
const { gateway } = require("./runtime");
const { assertCustomerComplete } = require("./accounts");
const { decryptText } = require("../security");

const safeDecrypt = (value) => {
  if (!value) return null;
  try { return decryptText(value); } catch { return null; }
};

function cardView(row) {
  return {
    id: row.id,
    brand: row.brand,
    last4: row.last4,
    expMonth: row.exp_month,
    expYear: row.exp_year,
    holderName: row.holder_name,
    isDefault: row.is_default,
    createdAt: row.created_at,
  };
}

async function listCards(client, customerId) {
  const { rows } = await client.query(
    `SELECT * FROM customer_cards WHERE customer_id=$1 AND deleted_at IS NULL AND gateway=$2
     ORDER BY is_default DESC, created_at DESC`,
    [customerId, gateway().nome]
  );
  return rows.map(cardView);
}

// Salva no PSP fora da transação (chamada externa) e grava depois
async function addCard(customerId, data) {
  await db.runInTransaction((client) => assertCustomerComplete(client, customerId));
  const { rows: users } = await db.runQuery("SELECT name, email, cpf_encrypted FROM users WHERE id=$1", [customerId]);
  const { rows: previous } = await db.runQuery(
    "SELECT gateway_customer_id FROM customer_cards WHERE customer_id=$1 AND gateway=$2 AND gateway_customer_id IS NOT NULL LIMIT 1",
    [customerId, gateway().nome]
  );
  let saved;
  try {
    saved = await gateway().saveCard({
      cliente: { nome: users[0].name, email: users[0].email, documento: safeDecrypt(users[0].cpf_encrypted) ?? undefined },
      clienteId: previous[0]?.gateway_customer_id ?? null,
      token: data.token,
      exibicao: {
        final: data.last4, bandeira: data.brand, mesValidade: data.expMonth, anoValidade: data.expYear, titular: data.holderName,
      },
    });
  } catch (error) {
    throw new ApiError(422, "card_rejected", error.message || "Não foi possível salvar o cartão.", { card: error.message });
  }
  return db.runInTransaction(async (client) => {
    const { rows: count } = await client.query(
      "SELECT COUNT(*)::int AS total FROM customer_cards WHERE customer_id=$1 AND deleted_at IS NULL AND gateway=$2",
      [customerId, gateway().nome]
    );
    const makeDefault = data.makeDefault || count[0].total === 0;
    if (makeDefault) {
      await client.query("UPDATE customer_cards SET is_default=false WHERE customer_id=$1 AND is_default", [customerId]);
    }
    const { rows } = await client.query(
      `INSERT INTO customer_cards (customer_id,gateway,gateway_customer_id,gateway_card_id,brand,last4,exp_month,exp_year,holder_name,is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [customerId, gateway().nome, saved.clienteId ?? null, saved.cartaoId, saved.bandeira ?? data.brand ?? null,
       saved.final ?? data.last4, saved.mesValidade ?? data.expMonth ?? null, saved.anoValidade ?? data.expYear ?? null,
       data.holderName ?? null, makeDefault]
    );
    return cardView(rows[0]);
  });
}

async function loadOwnCard(client, customerId, cardId, { forUpdate = false } = {}) {
  const { rows } = await client.query(
    `SELECT * FROM customer_cards WHERE id=$1 AND customer_id=$2 AND deleted_at IS NULL ${forUpdate ? "FOR UPDATE" : ""}`,
    [cardId, customerId]
  );
  if (!rows[0]) throw new ApiError(404, "card_not_found", "Cartão não encontrado.");
  if (rows[0].gateway !== gateway().nome) throw new ApiError(409, "card_other_gateway", "Este cartão é de outro meio de pagamento; cadastre de novo.");
  return rows[0];
}

async function setDefaultCard(customerId, cardId) {
  return db.runInTransaction(async (client) => {
    await loadOwnCard(client, customerId, cardId, { forUpdate: true });
    await client.query("UPDATE customer_cards SET is_default=false WHERE customer_id=$1 AND is_default", [customerId]);
    await client.query("UPDATE customer_cards SET is_default=true WHERE id=$1", [cardId]);
    return listCards(client, customerId);
  });
}

// Remove da lista; assinaturas que usam o cartão continuam cobrando nele até
// a cliente trocar (o PSP guarda a recorrência com o cartão).
async function deleteCard(customerId, cardId) {
  const card = await db.runInTransaction(async (client) => {
    const row = await loadOwnCard(client, customerId, cardId, { forUpdate: true });
    const { rows: inUse } = await client.query(
      "SELECT 1 FROM subscriptions WHERE saved_card_id=$1 AND status IN ('pendente','ativa','em_retentativa') LIMIT 1",
      [cardId]
    );
    if (inUse[0]) throw new ApiError(409, "card_in_use", "Este cartão paga uma assinatura ativa. Cancele a assinatura antes de remover.");
    await client.query("UPDATE customer_cards SET deleted_at=now(), is_default=false WHERE id=$1", [cardId]);
    // outro cartão vira o principal
    await client.query(
      `UPDATE customer_cards SET is_default=true WHERE id=(
         SELECT id FROM customer_cards WHERE customer_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1)
       AND NOT EXISTS (SELECT 1 FROM customer_cards WHERE customer_id=$1 AND deleted_at IS NULL AND is_default)`,
      [customerId]
    );
    return row;
  });
  try {
    await gateway().deleteCard(card.gateway_customer_id, card.gateway_card_id);
  } catch (error) {
    console.error("deleteCard no gateway falhou:", error.message);
  }
}

// Método de pagamento para o gateway a partir do cartão salvo
function savedCardMethod(card) {
  return { tipo: "cartao", cartaoId: card.gateway_card_id, clienteId: card.gateway_customer_id ?? undefined };
}

module.exports = { listCards, addCard, setDefaultCard, deleteCard, loadOwnCard, savedCardMethod, cardView };
