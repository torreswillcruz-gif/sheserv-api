// Notificações da conta (sino do app e push). Cada uma pode trazer `data` com
// os ids do que mudou (requestId, quoteId, orderId) para o app abrir a tela
// certa e recarregar só o necessário, e `area` ('customer' ou 'provider') para
// quem tem os dois papéis ver cada aviso na área a que ele pertence.
const { sendPush } = require("./push");

const NOTIFICATION_AREAS = ["customer", "provider"];

const formatMoney = (value) =>
  `R$ ${Number(value).toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;

// "02/12 às 10:00", no horário de Brasília
const whenFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
function formatWhen(date) {
  const parsed = date == null ? null : new Date(date);
  if (!parsed || Number.isNaN(parsed.getTime())) return "o horário combinado";
  const parts = Object.fromEntries(whenFormatter.formatToParts(parsed).map(({ type, value }) => [type, value]));
  return `${parts.day}/${parts.month} às ${parts.hour}:${parts.minute}`;
}

async function userName(databaseClient, userId) {
  const { rows } = await databaseClient.query("SELECT name FROM users WHERE id=$1", [userId]);
  return rows[0]?.name ?? "Alguém";
}

// Grava a notificação e envia o push. Chamar dentro da mesma transação da
// mudança: o push só sai depois do COMMIT (afterCommit), para não avisar de
// algo que acabou desfeito. Fora de transação, o push sai na hora.
async function notify(databaseClient, notification) {
  const { userId, type, title, body = null, data = {}, area = null } = notification;
  await databaseClient.query(
    "INSERT INTO notifications (user_id,type,title,body,data,area) VALUES ($1,$2,$3,$4,$5,$6)",
    [userId, type, title, body, data, area]
  );
  const push = () => {
    // Conexão própria: a da transação já voltou para o pool
    const { runQuery } = require("./db");
    return sendPush({ query: runQuery }, userId, { type, title, body, data, area })
      .catch((error) => console.error("Push falhou:", error));
  };
  if (typeof databaseClient.afterCommit === "function") databaseClient.afterCommit(push);
  else setImmediate(push);
}

module.exports = { NOTIFICATION_AREAS, formatMoney, formatWhen, notify, userName };
