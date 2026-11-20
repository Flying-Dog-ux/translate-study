/**
 * HTTP API 封装。
 * - 正式模式：同源 fetch 到 /api/*（后端见 docs/CONTRACT.md §4）；
 * - 演示模式：URL 带 ?mock=1 或 localStorage.devMock === '1' 时，改用本地 mock 适配器。
 * 统一把失败转换为 ApiError（code + 中文 message），调用方只需捕获并展示。
 */

import { ApiError } from './errors.js';
import { isMockRange } from './utils.js';

const DEFAULT_TIMEOUT = 30000;
const AI_TIMEOUT = 150000;

let mockMode = detectMockMode();
let mockModulePromise = null;

export function detectMockMode() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has('mock')) return isMockRange(params.get('mock'));
    return localStorage.getItem('devMock') === '1';
  } catch {
    return false;
  }
}

export function isMockMode() {
  return mockMode;
}

export function refreshMockMode() {
  mockMode = detectMockMode();
  return mockMode;
}

/** 切换演示模式；persist=false 时仅当前会话生效（用于 URL 上的 ?mock=1） */
export function setMockMode(enabled, { persist = true } = {}) {
  mockMode = Boolean(enabled);
  if (!persist) return mockMode;
  try {
    if (mockMode) localStorage.setItem('devMock', '1');
    else localStorage.removeItem('devMock');
  } catch { /* 隐私模式下忽略 */ }
  return mockMode;
}

async function dispatch(path, options = {}) {
  if (mockMode) {
    if (!mockModulePromise) mockModulePromise = import('./mock/mock-api.js');
    const module = await mockModulePromise;
    return module.mockRequest(path, options);
  }
  return httpRequest(path, options);
}

async function httpRequest(path, { method = 'GET', body = null, timeoutMs = DEFAULT_TIMEOUT } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new ApiError('NETWORK_TIMEOUT', '请求超时：服务没有响应，请稍后重试。', { cause: error });
    }
    throw new ApiError(
      'NETWORK',
      `无法连接后端服务（${path}）。请确认已在项目根目录运行 npm start，并访问 http://127.0.0.1:5180；或使用 ?mock=1 打开演示模式。`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text().catch(() => '');
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }

  if (data && data.ok === false) {
    const error = data.error || {};
    throw new ApiError(error.code || 'SERVER_ERROR', error.message || '请求失败，请稍后重试。', { status: response.status });
  }
  if (!response.ok) {
    if (response.status === 404) {
      throw new ApiError('NOT_FOUND', `接口或数据不存在（HTTP 404）：${path}`, { status: 404 });
    }
    throw new ApiError(
      response.status >= 500 ? 'SERVER_ERROR' : 'BAD_REQUEST',
      `请求失败（HTTP ${response.status}），请稍后重试。`,
      { status: response.status },
    );
  }
  if (data === null) {
    throw new ApiError('SERVER_ERROR', '服务返回了无法解析的响应，请检查后端服务。', { status: response.status });
  }
  return data;
}

export const api = {
  isMock: isMockMode,
  setMockMode,

  /** GET /api/health */
  health: () => dispatch('/api/health', { timeoutMs: 8000 }),

  /** GET /api/manifest */
  manifest: () => dispatch('/api/manifest'),

  /** GET /api/chapters/:bookId/:chapterIndex */
  chapter: (bookId, chapterIndex) => dispatch(`/api/chapters/${encodeURIComponent(bookId)}/${encodeURIComponent(Number(chapterIndex))}`),

  /** GET /api/progress */
  getProgress: () => dispatch('/api/progress'),

  /** PUT /api/progress/paragraph */
  saveParagraph: (payload) => dispatch('/api/progress/paragraph', { method: 'PUT', body: payload }),

  /** DELETE /api/progress */
  deleteProgress: () => dispatch('/api/progress', { method: 'DELETE' }),

  /** POST /api/review（AI 可能耗时较长，超时 150s） */
  review: (payload) => dispatch('/api/review', { method: 'POST', body: payload, timeoutMs: AI_TIMEOUT }),

  /** POST /api/reference */
  reference: (payload) => dispatch('/api/reference', { method: 'POST', body: payload, timeoutMs: AI_TIMEOUT }),

  /** POST /api/word */
  word: (payload) => dispatch('/api/word', { method: 'POST', body: payload, timeoutMs: 60000 }),
};

/**
 * 页面卸载时用 keepalive 请求兜底保存（正式模式）。
 * 演示模式直接返回 false，由常规保存流程处理。
 */
export function saveParagraphKeepalive(payload) {
  if (mockMode) return false;
  try {
    fetch('/api/progress/paragraph', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}
