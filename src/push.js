// Push pelo Firebase Cloud Messaging (API HTTP v1).
//
// Configuração: a variável FIREBASE_SERVICE_ACCOUNT com o JSON da conta de
// serviço do projeto Firebase (Console do Firebase → Configurações do projeto →
// Contas de serviço → Gerar nova chave privada). Sem ela, o push fica
// desligado e as notificações continuam só no sino do app.
const jsonWebToken = require("jsonwebtoken");

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

let cachedAccount;
let cachedAccessToken = null;

function serviceAccount() {
  if (cachedAccount !== undefined) return cachedAccount;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  cachedAccount = null;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed.client_email && parsed.private_key && parsed.project_id) cachedAccount = parsed;
    else console.error("FIREBASE_SERVICE_ACCOUNT sem client_email, private_key ou project_id; push desligado.");
  } catch {
    console.error("FIREBASE_SERVICE_ACCOUNT não é um JSON válido; push desligado.");
  }
  return cachedAccount;
}

const isPushEnabled = () => serviceAccount() !== null;

// Token OAuth da conta de serviço (vale 1 hora; renovado 5 minutos antes)
async function accessToken(account) {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 5 * 60 * 1000) return cachedAccessToken.value;
  const now = Math.floor(Date.now() / 1000);
  const assertion = jsonWebToken.sign(
    { iss: account.client_email, scope: FCM_SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 },
    account.private_key,
    { algorithm: "RS256" }
  );
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!response.ok) throw new Error(`Firebase OAuth falhou (${response.status}): ${await response.text()}`);
  const body = await response.json();
  cachedAccessToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return cachedAccessToken.value;
}

// FCM só aceita strings em `data`
const stringData = (data) =>
  Object.fromEntries(Object.entries(data).filter(([, value]) => value != null).map(([key, value]) => [key, String(value)]));

// Envia a notificação para todos os aparelhos do usuário. Chamar depois do
// COMMIT. Tokens que o FCM diz que não existem mais são apagados.
async function sendPush(databaseClient, userId, { type, title, body, data = {}, area }) {
  const account = serviceAccount();
  if (!account) return { sent: 0 };
  const { rows } = await databaseClient.query("SELECT token FROM device_tokens WHERE user_id=$1", [userId]);
  if (rows.length === 0) return { sent: 0 };
  const bearer = await accessToken(account);
  let sent = 0;
  for (const { token } of rows) {
    const response = await fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({
        message: {
          token,
          notification: { title, body: body ?? undefined },
          data: stringData({ type, area, ...data }),
          // Prioridade alta: aparece na hora mesmo com o aparelho em repouso
          android: { priority: "high" },
        },
      }),
    });
    if (response.ok) {
      sent += 1;
      continue;
    }
    const errorText = await response.text();
    // Aparelho desinstalou o app ou o token expirou
    if (response.status === 404 || /UNREGISTERED|registration-token-not-registered/.test(errorText)) {
      await databaseClient.query("DELETE FROM device_tokens WHERE token=$1", [token]);
    } else {
      console.error(`FCM falhou (${response.status}) para ${userId}: ${errorText}`);
    }
  }
  return { sent };
}

module.exports = { isPushEnabled, sendPush };
