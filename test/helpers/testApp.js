// Sobe a API com um banco falso: cada query é registrada em `log` e respondida pela
// primeira regra de `rules` cujo padrão casar com o SQL (sem regra, devolve zero linhas).
process.env.JWT_SECRET ||= "test-jwt-secret-with-more-than-thirty-two-chars";
process.env.DATA_ENCRYPTION_KEY ||= "test-encryption-key-with-more-than-32-chars";

const jsonWebToken = require("jsonwebtoken");
const database = require("../../src/db");

const fakeDatabase = { rules: [], log: [] };

async function fakeQuery(sqlText, parameterValues = []) {
  const normalizedSql = String(sqlText).replace(/\s+/g, " ").trim();
  fakeDatabase.log.push({ sql: normalizedSql, params: parameterValues });
  for (const rule of fakeDatabase.rules) {
    if (rule.pattern.test(normalizedSql)) {
      const rows = typeof rule.rows === "function" ? rule.rows(parameterValues) : rule.rows;
      return { rows, rowCount: rows.length };
    }
  }
  return { rows: [], rowCount: 0 };
}

// Os routers desestruturam runQuery/runInTransaction ao serem carregados,
// então o banco falso precisa estar no lugar antes de exigir o app.
database.runQuery = fakeQuery;
database.runInTransaction = async (transactionCallback) => transactionCallback({ query: fakeQuery });

const app = require("../../src/app");

function resetDatabase(rules = []) {
  fakeDatabase.rules = rules;
  fakeDatabase.log = [];
}

// Queries registradas cujo SQL casa com o padrão
const queriesMatching = (pattern) => fakeDatabase.log.filter((entry) => pattern.test(entry.sql));

function tokenFor(userId, roles) {
  return jsonWebToken.sign({ sub: userId, roles }, process.env.JWT_SECRET, {
    algorithm: "HS256",
    issuer: "sheserv-api",
    expiresIn: "5m",
  });
}

async function startServer() {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, { userId, roles, body } = {}) {
    const headers = { "content-type": "application/json" };
    if (userId) headers.authorization = `Bearer ${tokenFor(userId, roles)}`;
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  return { call, close: () => new Promise((resolve) => server.close(resolve)) };
}

// Regra para simular prestadora aprovada pelo admin (activation_status = 'active')
const approvedProviderRule = { pattern: /activation_status='active'/, rows: [{ approved: 1 }] };

module.exports = { resetDatabase, queriesMatching, startServer, approvedProviderRule };
