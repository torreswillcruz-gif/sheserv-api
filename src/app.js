const express = require("express");
const helmet = require("helmet");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const { errorHandler, ApiError } = require("./errors");
const { requireAuth, requireRole } = require("./security");

const app = express();
app.set("trust proxy", 1); // Render fica atrás de proxy
app.use(helmet());
app.use(express.json({ limit: "100kb" }));
app.use((req, _res, next) => { req.id = crypto.randomUUID(); next(); });

app.get("/health", (_req, res) => res.sendStatus(200));

const v1 = express.Router();
v1.use("/auth", rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }), require("./routes/auth"));
v1.use(require("./routes/catalog"));
v1.use(requireAuth);
v1.use(require("./routes/orders").router);
v1.use("/provider", requireRole("prestadora"), require("./routes/provider"));
v1.use(require("./routes/safety"));
v1.use(require("./routes/social"));
app.use("/api/v1", v1);

app.use((_req, _res, next) => next(new ApiError(404, "not_found", "Route not found.")));
app.use(errorHandler);

module.exports = app;
