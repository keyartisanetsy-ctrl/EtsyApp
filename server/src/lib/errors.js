/** Error carrying an HTTP status so route handlers can throw and let the
 *  central handler translate it into a response. */
export class AppError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (m, d) => new AppError(400, m, d);
export const unauthorized = (m = 'Not connected to Etsy') => new AppError(401, m);
export const notFound = (m = 'Not found') => new AppError(404, m);
export const conflict = (m, d) => new AppError(409, m, d);

/** Raised when Etsy itself rejects a call; keeps the upstream body for the UI. */
export class EtsyApiError extends AppError {
  constructor(status, message, { operationId, url, body } = {}) {
    super(status, message, { operationId, url, body });
    this.name = 'EtsyApiError';
    this.operationId = operationId;
    this.body = body;
  }
}
