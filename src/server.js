for (const k of ["DATABASE_URL", "JWT_SECRET", "DATA_ENCRYPTION_KEY"]) {
  if (!process.env[k]) { console.error(`Missing env var ${k}`); process.exit(1); }
}
if (process.env.JWT_SECRET.length < 32 || process.env.DATA_ENCRYPTION_KEY.length < 32) {
  console.error("JWT_SECRET and DATA_ENCRYPTION_KEY must have at least 32 characters"); process.exit(1);
}
const app = require("./app");
const { migrate } = require("./db");

const PORT = process.env.PORT || 3000;
migrate()
  .then(() => app.listen(PORT, "0.0.0.0", () => console.log(`API on port ${PORT}`)))
  .catch((e) => { console.error("Startup failed:", e.message); process.exit(1); });
