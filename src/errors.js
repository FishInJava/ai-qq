/**
 * 业务错误。业务模块只抛这个类型，中文文案与 HTTP 状态码在 http 层映射。
 *
 * @typedef {object} AppErrorOptions
 * @property {boolean} [retryable=false] 调用方是否值得重试
 * @property {number} [status=500] 建议的 HTTP 状态码
 * @property {unknown} [cause] 原始错误，仅用于日志，不返回给界面
 */
export class AppError extends Error {
  /**
   * @param {string} code 稳定英文错误码
   * @param {string} message 给界面看的中文文案，不含堆栈与密钥
   * @param {AppErrorOptions} [options]
   */
  constructor(code, message, { retryable = false, status = 500, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AppError';
    this.code = code;
    this.message = message;
    this.retryable = retryable;
    this.status = status;
  }
}
