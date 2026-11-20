/**
 * 演示模式（mock）的本地 API 适配器。
 * - 数据来自 public/js/mock/ 下的静态 JSON；
 * - 进度写入 localStorage（结构与真实 /api/progress 一致）；
 * - 批改 / 参考译文 / 查词由本地规则模拟，用于独立演示 UI。
 * 正式模式（默认）不会加载本文件。
 */

import { ApiError } from '../errors.js';
import { normalizeProgress, setParagraphData, chapterStats, bookStats } from '../progress.js';
import { sleep } from '../utils.js';
import { buildMockReview, buildMockReference } from './mock-review.js';

const MOCK_ROOT = 'js/mock/';
const PROGRESS_KEY = 'dev_progress_v1';
const LAST_LOCATION_KEY = 'zs.lastLocation';

const cache = {
  manifest: null,
  reference: null,
  chapters: new Map(),
};

async function fetchJson(path) {
  let response;
  try {
    response = await fetch(path, { cache: 'no-cache' });
  } catch (error) {
    throw new ApiError('NETWORK', '演示数据加载失败：请通过 HTTP 服务打开页面（例如 npm start 或 python -m http.server）。', { cause: error });
  }
  if (!response.ok) {
    throw new ApiError('NOT_FOUND', `演示数据缺失：${path}`, { status: response.status });
  }
  return response.json();
}

export async function loadMockManifest() {
  if (!cache.manifest) cache.manifest = await fetchJson(`${MOCK_ROOT}manifest.json`);
  return cache.manifest;
}

export async function loadMockChapter(bookId, chapterIndex) {
  const manifest = await loadMockManifest();
  const book = manifest.books.find((item) => item.id === bookId);
  if (!book) throw new ApiError('NOT_FOUND', `演示数据里没有这本书：${bookId}`, { status: 404 });
  const chapterMeta = (book.chapters || []).find((item) => Number(item.index) === Number(chapterIndex));
  if (!chapterMeta) throw new ApiError('NOT_FOUND', `演示数据里没有这一章：第 ${chapterIndex} 章`, { status: 404 });
  const key = `${book.id}/${chapterMeta.index}`;
  if (!cache.chapters.has(key)) {
    cache.chapters.set(key, await fetchJson(MOCK_ROOT + chapterMeta.file));
  }
  return cache.chapters.get(key);
}

async function loadMockReferenceMap() {
  if (!cache.reference) cache.reference = await fetchJson(`${MOCK_ROOT}reference.json`);
  return cache.reference;
}

function getReferenceFor(referenceMap, bookId, chapterIndex, paragraphIndex) {
  return referenceMap?.[bookId]?.[String(chapterIndex)]?.[String(paragraphIndex)] || { sentences: [] };
}

/* ------------------------------ 进度（localStorage） ------------------------------ */

export function getMockProgress() {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (!raw) return normalizeProgress(null);
    return normalizeProgress(JSON.parse(raw));
  } catch {
    return normalizeProgress(null);
  }
}

function writeMockProgress(root) {
  root.updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(root));
  } catch (error) {
    throw new ApiError('SERVER_ERROR', '演示模式的浏览器存储不可用（可能处于隐私模式）。', { cause: error });
  }
  return root;
}

function clearMockProgress() {
  try {
    localStorage.removeItem(PROGRESS_KEY);
  } catch { /* 忽略 */ }
}

function buildSummary(root, bookId, chapterIndex) {
  const manifest = cache.manifest;
  const book = manifest?.books?.find((item) => item.id === bookId);
  if (!book) return { bookProgress: 0, chapterProgress: 0 };
  const bookProgressData = root.books?.[bookId] || { chapters: {} };
  const stats = bookStats(book, bookProgressData);
  const chapterMeta = (book.chapters || []).find((item) => Number(item.index) === Number(chapterIndex));
  const chapterStat = chapterMeta
    ? chapterStats(chapterMeta, bookProgressData.chapters?.[String(chapterMeta.index)]?.paragraphs)
    : { percent: 0 };
  return {
    bookProgress: Math.round(stats.percent * 10) / 10,
    chapterProgress: Math.round(chapterStat.percent * 10) / 10,
  };
}

/* --------------------------------- 演示数据播种 --------------------------------- */

const DEMO_TRANSLATIONS = {
  '1:0': [
    '德思礼先生和太太住在女贞路四号，他们一向很自豪地说，自己是非常正常的人，这点真是谢天谢地。',
    '他们是那种最不可能和任何古怪神秘的事情扯上关系的人，因为他们根本不相信这些胡说八道。',
  ],
  '1:1': [
    '德思礼先生是一家名叫格朗宁的公司的经理，这家公司生产钻头。',
    '他是个又高又壮的男人，几乎没有什么脖子，不过倒是留着很大的一把胡子。',
    '',
  ],
  '1:2': ['德思礼夫妇有个小儿子，名叫达力；在他们看来，天底下再没有比他更好的孩子了。'],
  '2:0': [
    '将近十年过去了。当年德思礼夫妇一觉醒来，发现侄子躺在门前的台阶上；可女贞路几乎一点没变。',
    '太阳照旧升起，照亮同样整洁的前院，也照亮德思礼家大门上擦得锃亮的铜门牌「四号」；阳光悄悄溜进客厅——那里几乎和德思礼先生看到关于猫头鹰的可怕新闻的那个晚上一模一样。',
  ],
};

/**
 * 演示模式初始示例进度：让 UI 独立演示「已翻译 / 收藏 / AI 需改进」等状态。
 * 仅在进度为空时写入（force=true 除外）。
 */
export async function seedDemoProgress({ force = false } = {}) {
  const existing = getMockProgress();
  if (!force && existing.books && Object.keys(existing.books).length > 0) return false;

  const [manifest, chapter1, chapter2, referenceMap] = await Promise.all([
    loadMockManifest(),
    loadMockChapter('hp1', 1),
    loadMockChapter('hp1', 2),
    loadMockReferenceMap(),
  ]);
  if (!manifest.books.length) return false;

  const root = normalizeProgress({ version: 1, updatedAt: null, books: {} });
  const now = Date.now();
  const minutesAgo = (n) => new Date(now - n * 60 * 1000).toISOString();

  const addParagraph = (chapter, paragraphIndex, translations, { starred = false, withReview = false, minutes = 1 } = {}) => {
    const paragraph = (chapter.paragraphs || []).find((item) => Number(item.index) === Number(paragraphIndex));
    if (!paragraph) return;
    const reference = getReferenceFor(referenceMap, chapter.bookId, chapter.chapterIndex, paragraphIndex);
    const review = withReview
      ? buildMockReview({ chapter, paragraph, translations, reference }).review
      : null;
    setParagraphData(root, {
      bookId: chapter.bookId,
      chapterIndex: chapter.chapterIndex,
      paragraphIndex,
      sentences: translations,
      starred,
      review,
    });
    const saved = root.books[chapter.bookId].chapters[String(chapter.chapterIndex)].paragraphs[String(paragraphIndex)];
    saved.updatedAt = minutesAgo(minutes);
  };

  addParagraph(chapter1, 0, DEMO_TRANSLATIONS['1:0'], { starred: true, withReview: true, minutes: 42 });
  addParagraph(chapter1, 1, DEMO_TRANSLATIONS['1:1'], { withReview: true, minutes: 18 });
  addParagraph(chapter1, 2, DEMO_TRANSLATIONS['1:2'], { minutes: 9 });
  addParagraph(chapter2, 0, DEMO_TRANSLATIONS['2:0'], { starred: true, minutes: 3 });

  root.updatedAt = new Date(now).toISOString();
  writeMockProgress(root);

  try {
    localStorage.setItem(LAST_LOCATION_KEY, JSON.stringify({
      bookId: chapter1.bookId,
      chapterIndex: chapter1.chapterIndex,
      paragraphIndex: 1,
      updatedAt: new Date(now).toISOString(),
    }));
  } catch { /* 忽略 */ }

  return true;
}

/* ----------------------------------- 请求分发 ----------------------------------- */

const WORD_ENTRIES = {
  privet: { phonetic: '/ˈprɪvɪt/', meanings: [{ pos: 'n.', cn: '女贞（一种常绿灌木）' }, { pos: 'adj.', cn: '女贞属的' }], note: 'Privet Drive 是哈利从小长大的街道名，通常译作「女贞路」。' },
  drill: { phonetic: '/drɪl/', meanings: [{ pos: 'n.', cn: '钻头；电钻' }, { pos: 'v.', cn: '钻孔；训练' }], note: '本文中指格朗宁公司生产的钻机／钻头。' },
  mustache: { phonetic: '/ˈmʌstæʃ/', meanings: [{ pos: 'n.', cn: '胡子（尤指上唇的）' }], note: '英式拼写常作 moustache，美式为 mustache。' },
  screech: { phonetic: '/skriːtʃ/', meanings: [{ pos: 'v.', cn: '尖声叫喊；发出刺耳的声音' }], note: '比 shout 更尖利刺耳，常形容惊恐或愤怒的声音。' },
  mantelpiece: { phonetic: '/ˈmæntlpiːs/', meanings: [{ pos: 'n.', cn: '壁炉架' }], note: '英国家庭常把照片、钟表摆在壁炉架上。' },
  tawny: { phonetic: '/ˈtɔːni/', meanings: [{ pos: 'adj.', cn: '黄褐色的；茶色的' }], note: 'tawny owl 指灰林鸮，是英国常见的猫头鹰。' },
};

function buildMockWordEntry(word, sentence) {
  const key = String(word || '').toLowerCase();
  const known = WORD_ENTRIES[key];
  const meanings = known ? known.meanings : [{ pos: '—', cn: `「${word}」的释义（演示模式示例数据）` }];
  return {
    word,
    phonetic: known ? known.phonetic : '',
    meanings,
    explanation: `${known?.note ? `${known.note} ` : ''}当前为本地演示模式，不会调用真实 AI。启动后端并配置 DEEPSEEK_API_KEY 后，这里会返回基于上下文的逐词讲解、搭配和例句。`,
    examples: [
      {
        en: sentence || 'The Dursleys were proud to say that they were perfectly normal.',
        cn: '德思礼夫妇很自豪地说，他们是再正常不过的人。',
      },
    ],
  };
}

/**
 * mock 版 fetch：签名与真实请求一致，返回同样结构的 Promise。
 * @param {string} path 例如 /api/manifest
 * @param {{method?: string, body?: object}} [options]
 */
export async function mockRequest(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const body = options.body || null;
  const url = new URL(path, 'http://mock.local');
  const route = url.pathname;

  await sleep(80 + Math.random() * 140);

  if (method === 'GET' && route === '/api/health') {
    const manifest = await loadMockManifest();
    const chapters = manifest.books.reduce((sum, book) => sum + (book.chapters?.length || 0), 0);
    const sentences = manifest.books.reduce((sum, book) => sum + (book.sentenceCount || 0), 0);
    const progress = getMockProgress();
    return {
      ok: true,
      version: '1.0.0-demo',
      keyConfigured: true,
      model: 'deepseek-chat（演示）',
      baseUrlHost: 'mock.local',
      corpus: { books: manifest.books.length, chapters, sentences },
      progressUpdatedAt: progress.updatedAt,
      mock: true,
    };
  }

  if (method === 'GET' && route === '/api/manifest') {
    return loadMockManifest();
  }

  const chapterMatch = route.match(/^\/api\/chapters\/([^/]+)\/(\d+)$/);
  if (method === 'GET' && chapterMatch) {
    return loadMockChapter(decodeURIComponent(chapterMatch[1]), Number(chapterMatch[2]));
  }

  if (method === 'GET' && route === '/api/progress') {
    const root = getMockProgress();
    return { ok: true, version: 1, updatedAt: root.updatedAt, data: root };
  }

  if (method === 'PUT' && route === '/api/progress/paragraph') {
    if (!body || typeof body !== 'object') {
      throw new ApiError('BAD_REQUEST', '请求体缺少段落进度数据。', { status: 400 });
    }
    const { bookId, chapterIndex, paragraphIndex } = body;
    if (typeof bookId !== 'string' || !Number.isInteger(Number(chapterIndex)) || !Number.isInteger(Number(paragraphIndex))) {
      throw new ApiError('BAD_REQUEST', '段落进度参数不合法。', { status: 400 });
    }
    const chapter = await loadMockChapter(bookId, Number(chapterIndex));
    const paragraph = (chapter.paragraphs || []).find((item) => Number(item.index) === Number(paragraphIndex));
    if (!paragraph) throw new ApiError('NOT_FOUND', '段落不存在。', { status: 404 });
    const translations = Array.isArray(body.sentences) ? body.sentences : [];
    if (translations.length !== paragraph.sentences.length) {
      throw new ApiError('BAD_REQUEST', '译文句数与原句数不一致。', { status: 400 });
    }
    const root = getMockProgress();
    setParagraphData(root, {
      bookId,
      chapterIndex: Number(chapterIndex),
      paragraphIndex: Number(paragraphIndex),
      sentences: translations,
      starred: Boolean(body.starred),
      review: body.review || null,
    });
    writeMockProgress(root);
    return { ok: true, updatedAt: root.updatedAt, summary: buildSummary(root, bookId, Number(chapterIndex)) };
  }

  if (method === 'DELETE' && route === '/api/progress') {
    clearMockProgress();
    return { ok: true };
  }

  if (method === 'POST' && route === '/api/review') {
    await sleep(1400 + Math.random() * 1700);
    if (!body || typeof body !== 'object') throw new ApiError('BAD_REQUEST', '请求体缺少批改参数。', { status: 400 });
    const { bookId, chapterIndex, paragraphIndex } = body;
    const chapter = await loadMockChapter(bookId, Number(chapterIndex));
    const paragraph = (chapter.paragraphs || []).find((item) => Number(item.index) === Number(paragraphIndex));
    if (!paragraph) throw new ApiError('NOT_FOUND', '段落不存在，无法批改。', { status: 404 });
    if (!Array.isArray(body.translations)) throw new ApiError('BAD_REQUEST', 'translations 必须是数组。', { status: 400 });
    const referenceMap = await loadMockReferenceMap();
    const reference = getReferenceFor(referenceMap, bookId, Number(chapterIndex), Number(paragraphIndex));
    return buildMockReview({ chapter, paragraph, translations: body.translations, reference });
  }

  if (method === 'POST' && route === '/api/reference') {
    await sleep(700 + Math.random() * 900);
    if (!body || typeof body !== 'object') throw new ApiError('BAD_REQUEST', '请求体缺少参考译文参数。', { status: 400 });
    const { bookId, chapterIndex, paragraphIndex } = body;
    const chapter = await loadMockChapter(bookId, Number(chapterIndex));
    const paragraph = (chapter.paragraphs || []).find((item) => Number(item.index) === Number(paragraphIndex));
    if (!paragraph) throw new ApiError('NOT_FOUND', '段落不存在。', { status: 404 });
    const referenceMap = await loadMockReferenceMap();
    const reference = getReferenceFor(referenceMap, bookId, Number(chapterIndex), Number(paragraphIndex));
    if (!Array.isArray(reference.sentences) || !reference.sentences.length) {
      throw new ApiError('NOT_FOUND', '演示数据中没有这一段的参考译文。', { status: 404 });
    }
    return buildMockReference({ reference, paragraph });
  }

  if (method === 'POST' && route === '/api/word') {
    await sleep(500 + Math.random() * 600);
    const word = typeof body?.word === 'string' ? body.word : '';
    if (!word) throw new ApiError('BAD_REQUEST', '缺少要查询的单词。', { status: 400 });
    return { ok: true, entry: buildMockWordEntry(word, typeof body?.sentence === 'string' ? body.sentence : '') };
  }

  throw new ApiError('NOT_FOUND', `演示模式未实现该接口：${method} ${route}`, { status: 404 });
}
