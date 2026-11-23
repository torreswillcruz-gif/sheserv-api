for (const variableName of ["DATABASE_URL", "JWT_SECRET"]) {
  if (!process.env[variableName]) {
    console.error(`Missing env var ${variableName}`);
    process.exit(1);
  }
}
if (process.env.JWT_SECRET.length < 32) {
  console.error("JWT_SECRET must have at least 32 characters");
  process.exit(1);
}

const app = require("./app");
const { runMigrations } = require("./db");

const PORT = process.env.PORT || 3001;

runMigrations()
  .then(() => app.listen(PORT, "0.0.0.0", () => console.log(`Admin API on port ${PORT}`)))
  .catch((startupError) => {
    console.error("Startup failed:", startupError.message);
    process.exit(1);
  });
