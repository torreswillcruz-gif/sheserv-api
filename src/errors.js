const { ZodError } = require("zod");

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function errorHandler(err, req, res, _next) {
  let status = 500, code = "internal_error", message = "Unexpected error.", details;
  if (err instanceof ZodError) {
    status = 422; code = "validation_error"; message = "The request is invalid.";
    details = {};
    for (const i of err.issues) details[i.path.join(".") || "body"] = i.message;
  } else if (err instanceof ApiError) {
    ({ status, code, message, details } = err);
  } else if (err.type === "entity.parse.failed") {
    status = 400; code = "invalid_json"; message = "Malformed JSON.";
  } else {
    console.error(`[${req.id}]`, err.message); // nunca logar senhas/hashes
  }
  res.status(status).json({ error: { code, message, details, traceId: req.id } });
}

module.exports = { ApiError, wrap, errorHandler };
