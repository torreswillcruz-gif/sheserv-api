const express = require("express");
const helmet = require("helmet");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const { errorHandler, ApiError } = require("./errors");
const { requireAuthentication, requireRole } = require("./security");

const authRoutes = require("./routes/auth");
const catalogRoutes = require("./routes/catalog");
const { ordersRouter } = require("./routes/orders");
const addressRoutes = require("./routes/addresses");
const providerRoutes = require("./routes/provider");
const safetyRoutes = require("./routes/safety");
const socialRoutes = require("./routes/social");

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
apiV1Router.use(ordersRouter);
apiV1Router.use(addressRoutes);
apiV1Router.use("/provider", requireRole("prestadora"), providerRoutes);
apiV1Router.use(safetyRoutes);
apiV1Router.use(socialRoutes);

app.use(
  "/api",
  rateLimit({ windowMs: FIFTEEN_MINUTES_IN_MS, limit: 300, standardHeaders: true, legacyHeaders: false })
);
app.use("/api/v1", apiV1Router);

app.use((_request, _response, next) => next(new ApiError(404, "not_found", "Route not found.")));
app.use(errorHandler);

module.exports = app;
