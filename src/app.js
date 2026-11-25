const express = require("express");
const helmet = require("helmet");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const { errorHandler, ApiError } = require("./errors");
const { requireAuthentication, requireRole } = require("./security");
const { requireVerifiedIdentity } = require("./identity");

const authRoutes = require("./routes/auth");
const catalogRoutes = require("./routes/catalog");
const { ordersRouter } = require("./routes/orders");
const addressRoutes = require("./routes/addresses");
const providerRoutes = require("./routes/provider");
const safetyRoutes = require("./routes/safety");
const socialRoutes = require("./routes/social");
const { quotesRouter } = require("./routes/quotes");
const { erpRouter } = require("./routes/erp");
const { businessRouter } = require("./routes/business");
const { notificationsRouter } = require("./routes/notifications");

const FIFTEEN_MINUTES_IN_MS = 15 * 60 * 1000;

const app = express();
app.set("trust proxy", 1); // Render fica atrás de proxy
app.use(helmet());
app.use(express.json({ limit: "100kb" }));
app.use((request, _response, next) => {
  request.id = crypto.randomUUID(); // usado como traceId nos erros
  next();
});

app.get("/health", (_request, response) => response.sendStatus(200));

const apiV1Router = express.Router();

// Rotas públicas
apiV1Router.use(
  "/auth",
  rateLimit({ windowMs: FIFTEEN_MINUTES_IN_MS, limit: 20, standardHeaders: true, legacyHeaders: false }),
  authRoutes
);
apiV1Router.use(catalogRoutes);

// Daqui para baixo tudo exige o Bearer token
apiV1Router.use(requireAuthentication);
// Conta sem identidade verificada só usa o que leva à verificação (ver identity.js)
apiV1Router.use(requireVerifiedIdentity);
apiV1Router.use(ordersRouter);
apiV1Router.use(addressRoutes);
apiV1Router.use("/provider", requireRole("prestadora"), providerRoutes);
apiV1Router.use(safetyRoutes);
apiV1Router.use(socialRoutes);
apiV1Router.use(quotesRouter);
apiV1Router.use(notificationsRouter);
// Antes do erpRouter: ele exige papel de prestadora para tudo que passa por ele.
apiV1Router.use(businessRouter);
apiV1Router.use(erpRouter);

app.use(
  "/api",
  rateLimit({ windowMs: FIFTEEN_MINUTES_IN_MS, limit: 300, standardHeaders: true, legacyHeaders: false })
);
app.use("/api/v1", apiV1Router);

app.use((_request, _response, next) => next(new ApiError(404, "not_found", "Route not found.")));
app.use(errorHandler);

module.exports = app;
