/**
 * 全局状态：阅读偏好（主题 / 字号 / 上次位置）、manifest / progress 缓存、进度计算、段落保存。
 * 视图只通过本模块读写全局数据；页面内的临时状态由视图自己管理。
 */

import { api, isMockMode } from './api.js';
import {
  bookStats,
  chapterStats,
  collectReviewItems,
  getChapterProgressData,
  getParagraphData as readParagraph,
  normalizeProgress,
  setParagraphData,
} from './progress.js';

const THEME_KEY = 'zs.theme';
const FONT_SCALE_KEY = 'zs.fontScale';
const LAST_LOCATION_KEY = 'zs.lastLocation';

const FONT_SCALE_MIN = 0.85;
const FONT_SCALE_MAX = 1.4;
const FONT_SCALE_STEP = 0.1;

const systemDarkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

const cache = {
  manifest: null,
  manifestPromise: null,
  progress: null,
  progressPromise: null,
  health: null,
};

let themePreference = readThemePreference();
let fontScale = readFontScale();

/* --------------------------------- 阅读偏好 --------------------------------- */

function readThemePreference() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    if (value === 'light' || value === 'dark' || value === 'auto') return value;
  } catch { /* 忽略 */ }
  return 'auto';
}

function readFontScale() {
  try {
    const value = parseFloat(localStorage.getItem(FONT_SCALE_KEY));
    if (Number.isFinite(value) && value >= FONT_SCALE_MIN && value <= FONT_SCALE_MAX) return value;
  } catch { /* 忽略 */ }
  return 1;
}

export function getThemePreference() {
  return themePreference;
}

export function getEffectiveTheme() {
  if (themePreference === 'light' || themePreference === 'dark') return themePreference;
  return systemDarkQuery && systemDarkQuery.matches ? 'dark' : 'light';
}

export function applyTheme() {
  const theme = getEffectiveTheme();
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#121820' : '#f3eee2');
  return theme;
}

export function setTheme(preference) {
  themePreference = preference === 'light' || preference === 'dark' ? preference : 'auto';
  try { localStorage.setItem(THEME_KEY, themePreference); } catch { /* 忽略 */ }
  return applyTheme();
}

/** 在浅色 / 深色之间切换，返回切换后的实际主题 */
export function toggleTheme() {
  const next = getEffectiveTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}

export function getFontScale() {
  return fontScale;
}

export function setFontScale(scale) {
  const value = Math.round(Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, Number(scale) || 1)) * 100) / 100;
  fontScale = value;
  document.documentElement.style.setProperty('--reading-scale', String(value));
  try { localStorage.setItem(FONT_SCALE_KEY, String(value)); } catch { /* 忽略 */ }
  return value;
}

/** A+ / A-：返回新的字号比例 */
export function adjustFontScale(direction) {
  return setFontScale(fontScale + (direction > 0 ? FONT_SCALE_STEP : -FONT_SCALE_STEP));
}

export function canAdjustFontScale(direction) {
  return direction > 0 ? fontScale < FONT_SCALE_MAX - 0.001 : fontScale > FONT_SCALE_MIN + 0.001;
}

export function initPreferences() {
  applyTheme();
  setFontScale(fontScale);
  if (systemDarkQuery && typeof systemDarkQuery.addEventListener === 'function') {
    systemDarkQuery.addEventListener('change', () => {
      if (themePreference === 'auto') applyTheme();
    });
  }
}

/** 上次练习位置：{bookId, chapterIndex, paragraphIndex, updatedAt} */
export function getLastLocation() {
  try {
    const raw = localStorage.getItem(LAST_LOCATION_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (value && typeof value.bookId === 'string' && Number.isInteger(Number(value.chapterIndex))) {
      return {
        bookId: value.bookId,
        chapterIndex: Number(value.chapterIndex),
        paragraphIndex: Number.isInteger(Number(value.paragraphIndex)) ? Number(value.paragraphIndex) : 0,
        updatedAt: value.updatedAt || null,
      };
    }
  } catch { /* 忽略 */ }
  return null;
}

export function setLastLocation(bookId, chapterIndex, paragraphIndex = 0) {
  const value = {
    bookId,
    chapterIndex: Number(chapterIndex),
    paragraphIndex: Number(paragraphIndex),
    updatedAt: new Date().toISOString(),
  };
  try { localStorage.setItem(LAST_LOCATION_KEY, JSON.stringify(value)); } catch { /* 忽略 */ }
  return value;
}

export function clearLastLocation() {
  try { localStorage.removeItem(LAST_LOCATION_KEY); } catch { /* 忽略 */ }
}

/* --------------------------------- 数据缓存 --------------------------------- */

/** 加载 manifest（带缓存）。失败时抛出 ApiError，下次调用会重试。 */
export async function loadManifest({ force = false } = {}) {
  if (force) {
    cache.manifest = null;
    cache.manifestPromise = null;
  }
  if (cache.manifest) return cache.manifest;
  if (!cache.manifestPromise) {
    cache.manifestPromise = api.manifest()
      .then((manifest) => {
        cache.manifest = manifest;
        return manifest;
      })
      .catch((error) => {
        cache.manifestPromise = null;
        throw error;
      });
  }
  return cache.manifestPromise;
}

/** 加载进度（带缓存）。返回进度根对象 {version, updatedAt, books}。 */
export async function loadProgress({ force = false } = {}) {
  if (force) {
    cache.progress = null;
    cache.progressPromise = null;
  }
  if (cache.progress) return cache.progress;
  if (!cache.progressPromise) {
    cache.progressPromise = api.getProgress()
      .then((response) => {
        cache.progress = normalizeProgress(response);
        return cache.progress;
      })
      .catch((error) => {
        cache.progressPromise = null;
        throw error;
      });
  }
  return cache.progressPromise;
}

export function getCachedManifest() {
  return cache.manifest;
}

export function getCachedProgress() {
  return cache.progress;
}

export async function loadHealth({ force = false } = {}) {
  if (!force && cache.health) return cache.health;
  cache.health = await api.health();
  return cache.health;
}

export function getCachedHealth() {
  return cache.health;
}

export function invalidateAll() {
  cache.manifest = null;
  cache.manifestPromise = null;
  cache.progress = null;
  cache.progressPromise = null;
  cache.health = null;
}

/* --------------------------------- 书籍 / 章节 --------------------------------- */

/** 按 id 找书；演示模式下兼容书架上唯一的示例书（例如 #/practice/mock/... 这类演示 URL） */
export function resolveBook(rawBookId) {
  const manifest = cache.manifest;
  if (!manifest || !Array.isArray(manifest.books)) return null;
  const found = manifest.books.find((book) => book.id === rawBookId);
  if (found) return found;
  if (isMockMode() && manifest.books.length === 1) return manifest.books[0];
  return null;
}

/** 解析章节序号；非法时回退到第一章（返回 null 表示该书没有章节） */
export function resolveChapter(book, rawChapterIndex) {
  const chapters = Array.isArray(book?.chapters) ? book.chapters : [];
  if (!chapters.length) return null;
  const index = Number(rawChapterIndex);
  return chapters.find((chapter) => Number(chapter.index) === index) || chapters[0];
}

export function getChapterMeta(book, chapterIndex) {
  return (book?.chapters || []).find((chapter) => Number(chapter.index) === Number(chapterIndex)) || null;
}

/* --------------------------------- 进度计算 --------------------------------- */

/** 某本书的进度统计（依赖已加载的 manifest 与 progress；未加载时返回空统计） */
export function getBookProgress(book) {
  const progressBook = cache.progress?.books?.[book?.id] || { chapters: {} };
  return bookStats(book, progressBook);
}

export function getChapterProgress(book, chapterIndex) {
  const chapterMeta = getChapterMeta(book, chapterIndex);
  const paragraphs = getChapterProgressData(cache.progress, book?.id, chapterIndex);
  return chapterStats(chapterMeta, paragraphs);
}

/** 全书汇总（书架页顶部 / 设置页用） */
export function getOverallStats() {
  const manifest = cache.manifest;
  let total = 0;
  let translated = 0;
  for (const book of manifest?.books || []) {
    const stats = getBookProgress(book);
    total += stats.total;
    translated += stats.translated;
  }
  const percent = total > 0 ? (translated / total) * 100 : 0;
  return { total, translated, percent };
}

/** 待复习条目（收藏 + AI 判定需改进） */
export function getReviewItems() {
  if (!cache.manifest || !cache.progress) return [];
  return collectReviewItems(cache.manifest, cache.progress);
}

export function getReviewCount() {
  return getReviewItems().length;
}

/** 读取某段的已保存进度 */
export function getSavedParagraph(bookId, chapterIndex, paragraphIndex) {
  return readParagraph(cache.progress, bookId, chapterIndex, paragraphIndex);
}

/** 当前章所有已保存段落（paragraphs 对象） */
export function getSavedChapterParagraphs(bookId, chapterIndex) {
  return getChapterProgressData(cache.progress, bookId, chapterIndex);
}

/* --------------------------------- 保存 --------------------------------- */

/**
 * 保存段落进度：先写服务器（mock 模式写 localStorage），成功后同步本地缓存。
 * @returns {Promise<{ok:boolean, updatedAt?:string, summary?:object}>}
 */
export async function persistParagraph(payload) {
  const response = await api.saveParagraph(payload);
  if (!cache.progress) cache.progress = normalizeProgress(null);
  setParagraphData(cache.progress, payload);
  if (response?.updatedAt) cache.progress.updatedAt = response.updatedAt;
  return response;
}

/** 重置全部进度（服务器或 localStorage） */
export async function resetProgress() {
  await api.deleteProgress();
  cache.progress = normalizeProgress(null);
  clearLastLocation();
  return cache.progress;
}

/** 直接覆盖缓存中的进度（导入后重新拉取时使用） */
export function replaceProgress(nextProgress) {
  cache.progress = normalizeProgress(nextProgress);
  return cache.progress;
}

export { isMockMode };
