const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const connectionPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
});

const runQuery = (sqlText, parameterValues) => connectionPool.query(sqlText, parameterValues);

// Executa várias queries juntas: se alguma falhar, nenhuma é salva
async function runInTransaction(transactionCallback) {
  const transactionClient = await connectionPool.connect();
  try {
    await transactionClient.query("BEGIN");
    const callbackResult = await transactionCallback(transactionClient);
    await transactionClient.query("COMMIT");
    return callbackResult;
  } catch (transactionError) {
    await transactionClient.query("ROLLBACK");
    throw transactionError;
  } finally {
    transactionClient.release();
  }
}

async function runMigrations() {
  const schemaSql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await connectionPool.query(schemaSql);
}

module.exports = { connectionPool, runQuery, runInTransaction, runMigrations };
