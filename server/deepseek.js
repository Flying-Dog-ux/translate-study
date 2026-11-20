/**
 * DeepSeek 客户端（零依赖，使用全局 fetch）。
 *
 * 职责：
 * - 调用 POST {baseUrl}/chat/completions，强制 response_format=json_object；
 * - 120s 超时（AbortController，可用 AI_TIMEOUT_MS 覆盖）；
 * - 错误映射：401/403→AI_AUTH、429→AI_RATE_LIMIT、超时→AI_TIMEOUT、
 *   JSON 解析失败自动重试 1 次仍失败→AI_BAD_FORMAT、网络/5xx→SERVER_ERROR；
 * - 并发上限 2 的简单队列；
 * - 每次调用返回 elapsedMs 与 usage。
 */
export const AI_ERROR_STATUS = {
  AI_AUTH: 401,
  AI_RATE_LIMIT: 429,
  AI_TIMEOUT: 504,
  AI_BAD_FORMAT: 502,
  SERVER_ERROR: 500,
};

export class AiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.httpStatus = AI_ERROR_STATUS[code] ?? 500;
  }
}

/** 简单信号量：并发上限之外的任务排队等待。 */
class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, Number(limit) || 1);
    this.active = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
  }

  release() {
    const next = this.queue.shift();
    if (next) {
      next(); // 槽位直接移交，active 不变
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}

function normalizeUsage(raw) {
  const usage = raw && typeof raw === 'object' ? raw : {};
  const toCount = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.trunc(Number(value)) : 0);
  return {
    prompt_tokens: toCount(usage.prompt_tokens),
    completion_tokens: toCount(usage.completion_tokens),
    total_tokens: toCount(usage.total_tokens),
  };
}

/** 去掉模型可能附带的 markdown 代码块围栏，再解析 JSON 对象。 */
export function parseAiJson(content) {
  if (typeof content !== 'string') return null;
  let text = content.replace(/^\uFEFF/, '').trim();
  if (!text) return null;
  const fence = /^```[A-Za-z0-9_-]*\s*\r?\n?([\s\S]*?)\r?\n?```$/.exec(text);
  if (fence) text = fence[1].trim();
  const tryParse = (candidate) => {
    try {
      const parsed = JSON.parse(candidate);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };
  let parsed = tryParse(text);
  if (parsed) return parsed;
  // 兜底：从第一个 { 到最后一个 } 之间再试一次（模型偶发在 JSON 前后加解释）。
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) parsed = tryParse(text.slice(start, end + 1));
  return parsed;
}

function describeTimeout(timeoutMs) {
  if (timeoutMs >= 1000) return `${Math.round(timeoutMs / 1000)} 秒`;
  return `${timeoutMs} 毫秒`;
}

export class DeepSeekClient {
  constructor({
    apiKey = '',
    model = 'deepseek-chat',
    baseUrl = 'https://api.deepseek.com',
    timeoutMs = 120000,
    maxConcurrency = 2,
    maxFormatRetries = 1,
    fetchImpl = globalThis.fetch,
    logger = console,
  } = {}) {
    this.apiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
    this.model = model;
    this.baseUrl = String(baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.maxFormatRetries = Math.max(0, Number(maxFormatRetries) || 0);
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.semaphore = new Semaphore(maxConcurrency);
    this.endpoint = `${this.baseUrl}/chat/completions`;
  }

  get configured() {
    return Boolean(this.apiKey);
  }

  /**
   * 请求一次 JSON 模式的对话补全。
   * @returns {Promise<{json: object, meta: {model: string, elapsedMs: number, usage: object, attempts: number}>}
   */
  async chatJSON({ messages, maxTokens = 2000, temperature = 0.3, label = 'ai' } = {}) {
    if (!this.configured) {
      throw new AiError(
        'AI_AUTH',
        '尚未配置 DeepSeek API Key。请在项目根目录 .env 中设置 DEEPSEEK_API_KEY（也可设为 Windows 用户/系统环境变量），保存后重启服务；详见设置页的配置说明。',
      );
    }

    const startedAt = Date.now();
    await this.semaphore.acquire();
    try {
      let lastFormatError = null;
      for (let attempt = 0; attempt <= this.maxFormatRetries; attempt += 1) {
        const result = await this.requestOnce({ messages, maxTokens, temperature, label, attempt });
        if (result.json) {
          return {
            json: result.json,
            meta: {
              model: this.model,
              elapsedMs: Date.now() - startedAt,
              usage: result.usage,
              attempts: attempt + 1,
            },
          };
        }
        lastFormatError = result.error;
      }
      this.logWarn(`AI 返回内容无法解析为 JSON（已重试 ${this.maxFormatRetries} 次，label=${label}）`);
      throw new AiError('AI_BAD_FORMAT', 'AI 返回内容不是合法的 JSON（已自动重试 1 次），请点击「重新批改」再试一次。');
    } finally {
      this.semaphore.release();
    }
  }

  /** 单次 HTTP 请求；返回 {json} 或 {error}（仅格式错误）。 */
  async requestOnce({ messages, maxTokens, temperature, label, attempt }) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      let response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            messages,
            response_format: { type: 'json_object' },
            temperature,
            max_tokens: maxTokens,
            stream: false,
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (timedOut || controller.signal.aborted) {
          throw new AiError(
            'AI_TIMEOUT',
            `AI 响应超时（超过 ${describeTimeout(this.timeoutMs)}），请稍后重试。`,
          );
        }
        this.logWarn(`连接 DeepSeek 失败（${label} 第 ${attempt + 1} 次）：${error?.message || error}`);
        throw new AiError('SERVER_ERROR', '无法连接 DeepSeek 服务（网络错误），请检查网络连接或接口地址配置。');
      }

      if (!response.ok) {
        throw this.mapHttpError(response.status);
      }

      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        if (timedOut || controller.signal.aborted) {
          throw new AiError(
            'AI_TIMEOUT',
            `AI 响应超时（超过 ${describeTimeout(this.timeoutMs)}），请稍后重试。`,
          );
        }
        this.logWarn(`DeepSeek 响应体不是 JSON（${label}）：${error?.message || error}`);
        return { error: new Error('响应体不是 JSON') };
      }

      const content = payload?.choices?.[0]?.message?.content;
      const usage = normalizeUsage(payload?.usage);
      if (typeof content !== 'string' || !content.trim()) {
        this.logWarn(`DeepSeek 返回内容为空（${label}）`);
        return { error: new Error('返回内容为空') };
      }
      const json = parseAiJson(content);
      if (!json) {
        this.logWarn(`DeepSeek 返回内容 JSON 解析失败（${label} 第 ${attempt + 1} 次）`);
        return { error: new Error('返回内容不是 JSON') };
      }
      return { json, usage };
    } finally {
      clearTimeout(timer);
    }
  }

  mapHttpError(status) {
    if (status === 401 || status === 403) {
      return new AiError(
        'AI_AUTH',
        `DeepSeek 鉴权失败（HTTP ${status}）：API Key 可能无效、过期或额度不足，请到设置页检查配置。`,
      );
    }
    if (status === 429) {
      return new AiError('AI_RATE_LIMIT', 'DeepSeek 请求过于频繁（HTTP 429），请稍等片刻再试。');
    }
    if (status >= 500) {
      return new AiError('SERVER_ERROR', `DeepSeek 服务暂时不可用（HTTP ${status}），请稍后重试。`);
    }
    return new AiError('SERVER_ERROR', `DeepSeek 请求失败（HTTP ${status}），请稍后重试。`);
  }

  logWarn(message) {
    if (this.logger && typeof this.logger.warn === 'function') {
      this.logger.warn(`[deepseek] ${message}`);
    }
  }
}
