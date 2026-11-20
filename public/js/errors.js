/** 统一的 API 错误类型（前后端错误码见 docs/CONTRACT.md §4） */
export class ApiError extends Error {
  /**
   * @param {string} code 错误码：BAD_REQUEST / NOT_FOUND / AI_AUTH / AI_RATE_LIMIT / AI_TIMEOUT / AI_BAD_FORMAT / SERVER_ERROR / NETWORK …
   * @param {string} message 中文可读信息
   * @param {{status?: number, cause?: unknown}} [options]
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code || 'UNKNOWN';
    this.status = options.status || 0;
    if (options.cause) this.cause = options.cause;
  }
}

export function isAuthError(error) {
  return Boolean(error && error.code === 'AI_AUTH');
}

export function isNetworkError(error) {
  return Boolean(error && (error.code === 'NETWORK' || error.code === 'NETWORK_TIMEOUT'));
}
