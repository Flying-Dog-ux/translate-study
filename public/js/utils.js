/**
 * 通用工具：DOM 构建、格式化、防抖、文件下载、英文分词等。
 * 约定：任何来自语料 / 用户输入的文本都通过 textContent 写入，本文件不提供裸 innerHTML 文本注入接口。
 * （el 的 html 属性仅用于本仓库内静态 SVG 图标字符串。）
 */

/** 轻量 DOM 构建器 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class' || key === 'className') {
      node.className = value;
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'html') {
      // 仅限静态图标；任何用户 / 语料文本一律禁止走这里
      node.innerHTML = value;
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(node.style, value);
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (key === 'on') {
      for (const [event, handler] of Object.entries(value)) {
        if (typeof handler === 'function') node.addEventListener(event, handler);
      }
    } else if (key === 'attrs') {
      for (const [attr, val] of Object.entries(value)) {
        if (val === null || val === undefined || val === false) continue;
        node.setAttribute(attr, val === true ? '' : String(val));
      }
    } else if (key === 'aria') {
      for (const [attr, val] of Object.entries(value)) {
        if (val === null || val === undefined || val === false) continue;
        node.setAttribute(`aria-${attr}`, String(val));
      }
    } else if (key in node && typeof node[key] !== 'function') {
      try { node[key] = value; } catch { node.setAttribute(key, String(value)); }
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(node) {
  if (node) node.replaceChildren();
  return node;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/** 简单防抖 */
export function debounce(fn, delay = 300) {
  let timer = 0;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return wrapped;
}

/** 注水式伪随机数（用于 mock 批改的稳定输出） */
export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------------------------- 格式化 ---------------------------------- */

export function formatNumber(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString('zh-CN');
}

export function formatPercent(p, { clampPercent = true } = {}) {
  let value = Number(p);
  if (!Number.isFinite(value)) return '—';
  value = clampPercent ? clamp(value, 0, 100) : value;
  // 极低进度用「<0.1%」表示，避免真实大语料下出现 0.0% 让人误以为没有保存
  if (value > 0 && value < 0.1) return '<0.1%';
  if (value > 0 && value < 10) return `${value.toFixed(1)}%`;
  return `${Math.round(value)}%`;
}

export function formatElapsed(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 10000) return `${(value / 1000).toFixed(1)} 秒`;
  return `${Math.round(value / 1000)} 秒`;
}

export function formatClock(input) {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function formatDateTime(input) {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return '—';
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  const parts = date.toLocaleString('zh-CN', {
    year: sameYear ? undefined : 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return parts;
}

export function relativeTime(input) {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return '';
  const diff = Date.now() - date.getTime();
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)} 天前`;
  return formatDateTime(date);
}

/* ---------------------------------- 文本处理 ---------------------------------- */

const WORD_RE = /[A-Za-z0-9]+(?:[’'\-][A-Za-z0-9]+)*/g;

/**
 * 把英文句子切分成「单词 / 非单词」片段，供点击查词使用。
 * 不改变原文内容与顺序。
 * @returns {Array<{word?: string, text?: string}>}
 */
export function tokenizeEnglish(text) {
  const input = String(text ?? '');
  const tokens = [];
  let last = 0;
  let match;
  WORD_RE.lastIndex = 0;
  while ((match = WORD_RE.exec(input)) !== null) {
    if (match.index > last) tokens.push({ text: input.slice(last, match.index) });
    tokens.push({ word: match[0] });
    last = match.index + match[0].length;
  }
  if (last < input.length) tokens.push({ text: input.slice(last) });
  return tokens;
}

/** 取一段英文里第一个足够长的单词，用于 mock 批改的「用词」建议 */
export function pickEnglishWord(text) {
  const matches = String(text ?? '').match(/[A-Za-z][A-Za-z'’-]{5,}/g) || [];
  return matches.length ? matches[Math.floor(matches.length / 2)] : '';
}

export function countWords(text) {
  const matches = String(text ?? '').match(/[A-Za-z0-9]+(?:[’'\-][A-Za-z0-9]+)*/g);
  return matches ? matches.length : 0;
}

/* ---------------------------------- 输入框 ---------------------------------- */

const TEXTAREA_MAX_HEIGHT = 320;

/** 自动增高 textarea（配合 CSS resize: none 使用） */
export function autoResize(textarea) {
  if (!textarea) return;
  textarea.style.height = 'auto';
  const next = Math.min(textarea.scrollHeight + 2, TEXTAREA_MAX_HEIGHT);
  textarea.style.height = `${next}px`;
  textarea.style.overflowY = textarea.scrollHeight > TEXTAREA_MAX_HEIGHT ? 'auto' : 'hidden';
}

/** 是否为可编辑元素（用于键盘快捷键不抢输入） */
export function isEditableTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return target.isContentEditable || tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT';
}

/* ---------------------------------- 剪贴板 / 下载 ---------------------------------- */

/** 复制文本，返回是否成功 */
export async function copyText(text) {
  const value = String(text ?? '');
  if (!value) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch { /* 继续尝试降级方案 */ }
  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 触发浏览器下载一个文本文件 */
export function downloadText(filename, content, mime = 'application/json') {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadJson(filename, data) {
  downloadText(filename, JSON.stringify(data, null, 2));
}

/** 本地时间戳文件名片段：20261119-0940 */
export function timestampSlug(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/* ---------------------------------- 其它 ---------------------------------- */

export function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function isMockRange(param) {
  const v = String(param ?? '').toLowerCase();
  return v === 'mock' || v === 'demo' || v === '1';
}
