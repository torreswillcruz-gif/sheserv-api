const { ZodError } = require("zod");

class ApiError extends Error {
  constructor(httpStatus, errorCode, errorMessage, errorDetails) {
    super(errorMessage);
    this.status = httpStatus;
    this.code = errorCode;
    this.details = errorDetails;
  }
}

// Envolve um handler async para que qualquer erro caia no errorHandler
const asyncHandler = (routeHandler) => (request, response, next) =>
  Promise.resolve(routeHandler(request, response, next)).catch(next);

function errorHandler(error, request, response, _next) {
  let httpStatus = 500;
  let errorCode = "internal_error";
  let errorMessage = "Unexpected error.";
  let errorDetails;

  if (error instanceof ZodError) {
    httpStatus = 422;
    errorCode = "validation_error";
    errorMessage = "The request is invalid.";
    errorDetails = {};
    for (const issue of error.issues) errorDetails[issue.path.join(".") || "body"] = issue.message;
  } else if (error instanceof ApiError) {
    httpStatus = error.status;
    errorCode = error.code;
    errorMessage = error.message;
    errorDetails = error.details;
  } else if (error.type === "entity.parse.failed") {
    httpStatus = 400;
    errorCode = "invalid_json";
    errorMessage = "Malformed JSON.";
  } else {
    console.error(`[${request.id}]`, error.message); // nunca logar senhas/hashes
  }

  response.status(httpStatus).json({
    error: { code: errorCode, message: errorMessage, details: errorDetails, traceId: request.id },
  });
}

module.exports = { ApiError, asyncHandler, errorHandler };
