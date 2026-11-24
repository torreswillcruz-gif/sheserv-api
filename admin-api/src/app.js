const express = require("express");
const helmet = require("helmet");
const crypto = require("crypto");
const path = require("path");
const rateLimit = require("express-rate-limit");
const { errorHandler, ApiError } = require("./errors");
const { requireAdmin } = require("./security");
const adminRoutes = require("./routes/admin");
const sessionRoutes = require("./routes/session");

const FIFTEEN_MINUTES_IN_MS = 15 * 60 * 1000;

const app = express();
app.set("trust proxy", 1);
// CSP padrão do helmet (só scripts/estilos do próprio servidor). Sem
// "upgrade-insecure-requests" para o painel funcionar em http://localhost;
// em produção o Render já serve tudo em HTTPS.
app.use(helmet({ contentSecurityPolicy: { directives: { "upgrade-insecure-requests": null } } }));
app.use(express.json({ limit: "100kb" }));
app.use((request, _response, next) => {
  request.id = crypto.randomUUID();
  next();
});

app.get("/health", (_request, response) => response.sendStatus(200));

// Painel administrativo (página estática)
app.get("/", (_request, response) => response.redirect("/admin/"));
app.use("/admin", express.static(path.join(__dirname, "..", "public"), { index: "index.html" }));

app.use(
  "/api",
  rateLimit({ windowMs: FIFTEEN_MINUTES_IN_MS, limit: 120, standardHeaders: true, legacyHeaders: false })
);
// Login do painel: antes do requireAdmin e com limite próprio
app.use(
  "/api/v1/admin/session",
  rateLimit({ windowMs: FIFTEEN_MINUTES_IN_MS, limit: 20, standardHeaders: true, legacyHeaders: false }),
  sessionRoutes
);
app.use("/api/v1/admin", requireAdmin, adminRoutes);
app.use((_request, _response, next) => next(new ApiError(404, "not_found", "Route not found.")));
app.use(errorHandler);

module.exports = app;
