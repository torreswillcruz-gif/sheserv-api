const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const connectionPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
});

const runQuery = (sqlText, parameterValues) => connectionPool.query(sqlText, parameterValues);

// Executa várias queries juntas: se alguma falhar, nenhuma é salva.
// `transactionClient.afterCommit(fn)` agenda algo para depois do COMMIT (ex.:
// push), para não avisar de uma mudança que acabou desfeita.
async function runInTransaction(transactionCallback) {
  const transactionClient = await connectionPool.connect();
  const afterCommitCallbacks = [];
  transactionClient.afterCommit = (callback) => afterCommitCallbacks.push(callback);
  try {
    await transactionClient.query("BEGIN");
    const callbackResult = await transactionCallback(transactionClient);
    await transactionClient.query("COMMIT");
    for (const callback of afterCommitCallbacks) {
      Promise.resolve()
        .then(callback)
        .catch((error) => console.error("afterCommit failed:", error));
    }
    return callbackResult;
  } catch (transactionError) {
    await transactionClient.query("ROLLBACK");
    throw transactionError;
  } finally {
    delete transactionClient.afterCommit;
    transactionClient.release();
  }
}

async function runMigrations() {
  const schemaSql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await connectionPool.query(schemaSql);
  // Módulo de pagamentos (depende das tabelas acima)
  const paymentsSql = fs.readFileSync(path.join(__dirname, "payments_schema.sql"), "utf8");
  await connectionPool.query(paymentsSql);
  // Termos, selos de verificação e cartões salvos (dependem dos dois acima)
  const trustSql = fs.readFileSync(path.join(__dirname, "trust_schema.sql"), "utf8");
  await connectionPool.query(trustSql);
}

module.exports = { connectionPool, runQuery, runInTransaction, runMigrations };
