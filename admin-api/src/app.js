const express = require("express");
const helmet = require("helmet");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const { errorHandler, ApiError } = require("./errors");
const { requireAdmin } = require("./security");
const adminRoutes = require("./routes/admin");

const FIFTEEN_MINUTES_IN_MS = 15 * 60 * 1000;

const app = express();
app.set("trust proxy", 1);
app.use(helmet());
app.use(express.json({ limit: "100kb" }));
app.use((request, _response, next) => {
  request.id = crypto.randomUUID();
  next();
});

app.get("/health", (_request, response) => response.sendStatus(200));
app.use(
  "/api",
  rateLimit({ windowMs: FIFTEEN_MINUTES_IN_MS, limit: 120, standardHeaders: true, legacyHeaders: false })
);
app.use("/api/v1/admin", requireAdmin, adminRoutes);
app.use((_request, _response, next) => next(new ApiError(404, "not_found", "Route not found.")));
app.use(errorHandler);

module.exports = app;
