export class AppError extends Error {
  constructor(code, message, { retryable = false, status = 500, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AppError';
    this.code = code;
    this.message = message;
    this.retryable = retryable;
    this.status = status;
  }
}
