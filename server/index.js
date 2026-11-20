/**
 * 逐句译 · HTTP 服务入口（零外部依赖：node:http + 全局 fetch）。
 *
 * 职责：
 * - 静态服务 public/（MIME、无路径穿越、未知路由回退 index.html）；
 * - REST API：/api/health、/api/manifest、/api/chapters/:bookId/:chapterIndex、
 *   /api/progress（GET/PUT/DELETE）、/api/review、/api/reference、/api/word；
 * - 统一错误结构 {ok:false,error:{code,message}}，请求体上限 256KB；
 * - /api/review 的英文原句一律从语料读取，不信任客户端。
 */
import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig, keySourceLabel } from './config.js';
import { CorpusError, CorpusStore } from './corpus.js';
import { ProgressStore } from './progress.js';
import { AiError, DeepSeekClient } from './deepseek.js';
import {
  buildReferenceUserPrompt,
  buildReviewUserPrompt,
  buildWordUserPrompt,
  REFERENCE_SYSTEM_PROMPT,
  REVIEW_SYSTEM_PROMPT,
  WORD_SYSTEM_PROMPT,
} from './prompts.js';
import { normalizeReference, normalizeReview, normalizeWord } from './review.js';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
};

/** 业务处理中主动抛出的 HTTP 错误（会被映射成统一 JSON 错误结构）。 */
class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

const badRequest = (message) => new HttpError(400, 'BAD_REQUEST', message);
const notFound = (message) => new HttpError(404, 'NOT_FOUND', message);

// ---------------------------------------------------------------------------
// 通用 HTTP 工具
// ---------------------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendBuffer(res, status, buffer, contentType, method = 'GET') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': buffer.length,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  if (method === 'HEAD') res.end();
  else res.end(buffer);
}

function mimeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * 读取 JSON 请求体。上限默认 256KB。
 * 超限时继续把流读完（丢弃内容）再回 400，避免客户端因连接被断开而报 fetch failed。
 */
function readJsonBody(req, limitBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let size = 0;
    let tooLarge = false;
    const chunks = [];

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (tooLarge) {
        reject(badRequest(`请求体过大（上限 ${Math.round(limitBytes / 1024)}KB）`));
        return;
      }
      const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
      if (!text.trim()) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(badRequest('请求体不是合法的 JSON'));
      }
    });
    req.on('error', () => fail(badRequest('读取请求体失败')));
  });
}

function requireBody(body) {
  if (body === undefined) throw badRequest('缺少请求体：请以 JSON 对象提交');
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('请求体必须是 JSON 对象');
  }
  return body;
}

function requireBookId(body) {
  const value = body.bookId;
  if (typeof value !== 'string' || !value.trim()) {
    throw badRequest('bookId 不合法：应为非空字符串');
  }
  if (value.trim().length > 64) throw badRequest('bookId 过长');
  return value.trim();
}

function requireIndex(value, field, min) {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value.trim())
      : Number.NaN;
  if (!Number.isInteger(number) || number < min) {
    throw badRequest(`${field} 不合法：应为 >= ${min} 的整数`);
  }
  return number;
}

function normalizeContext(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const prevSource = typeof raw.prevSource === 'string' ? raw.prevSource.trim().slice(0, 2000) : '';
  const nextSource = typeof raw.nextSource === 'string' ? raw.nextSource.trim().slice(0, 2000) : '';
  return prevSource || nextSource ? { prevSource, nextSource } : null;
}

/** 解析路径中的章节参数（bookId/chapterIndex），拒绝任何多余路径段（防路径穿越）。 */
function parseChapterParams(rest) {
  if (!Array.isArray(rest) || rest.length !== 2) {
    throw notFound('章节接口路径不合法：应为 /api/chapters/:bookId/:chapterIndex');
  }
  return { bookId: rest[0], chapterIndex: rest[1] };
}

function parseBookChapterParagraph(body, { requireParagraph = true } = {}) {
  const source = requireBody(body);
  const bookId = requireBookId(source);
  const chapterIndex = requireIndex(source.chapterIndex, 'chapterIndex', 1);
  const result = { bookId, chapterIndex };
  if (requireParagraph) result.paragraphIndex = requireIndex(source.paragraphIndex, 'paragraphIndex', 0);
  return result;
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

/**
 * 从请求行里取出「保留 ../ 原样」的路径。
 * 不能用 new URL() 取 pathname：WHATWG URL 会把 ../、%2e%2e 规范化掉，
 * 导致路径穿越请求被静默重写成合法路径。这里只剥掉 query/hash 再解码。
 */
function parseRequestPath(rawUrl) {
  let target = rawUrl;
  const absoluteForm = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*(\/.*)?$/.exec(target);
  if (absoluteForm) target = absoluteForm[1] ?? '/';
  const queryIndex = target.indexOf('?');
  if (queryIndex >= 0) target = target.slice(0, queryIndex);
  const hashIndex = target.indexOf('#');
  if (hashIndex >= 0) target = target.slice(0, hashIndex);
  if (!target.startsWith('/')) target = `/${target}`;
  return decodeURIComponent(target);
}

async function handleRequest(app, req, res) {
  const rawUrl = typeof req.url === 'string' && req.url ? req.url : '/';
  let pathname;
  try {
    pathname = parseRequestPath(rawUrl);
  } catch {
    throw badRequest('请求路径编码不合法');
  }
  if (pathname.includes('\0')) throw badRequest('请求路径不合法');

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return handleApi(app, req, res, pathname);
  }
  return serveStatic(app, req, res, pathname);
}

async function handleApi(app, req, res, pathname) {
  const method = req.method ?? 'GET';
  const match = /^\/api\/([A-Za-z0-9_-]+)(?:\/(.*))?$/.exec(pathname);
  if (!match) throw notFound('接口不存在');
  const resource = match[1];
  const rest = typeof match[2] === 'string' && match[2] !== '' ? match[2].split('/') : [];

  const allow = (...methods) => {
    if (!methods.includes(method)) throw notFound('接口不存在');
  };

  switch (resource) {
    case 'health': {
      allow('GET');
      const stats = await app.corpus.getStats();
      const progressUpdatedAt = await app.progress.getUpdatedAt();
      return sendJson(res, 200, {
        ok: true,
        version: app.config.version,
        keyConfigured: app.config.keyConfigured,
        model: app.config.model,
        baseUrlHost: app.config.baseUrlHost,
        corpus: stats,
        progressUpdatedAt,
      });
    }

    case 'manifest': {
      allow('GET');
      const manifest = await app.corpus.getManifest();
      return sendJson(res, 200, manifest);
    }

    case 'chapters': {
      allow('GET');
      const { bookId, chapterIndex } = parseChapterParams(rest);
      const chapter = await app.corpus.getChapter(bookId, chapterIndex);
      return sendJson(res, 200, chapter);
    }

    case 'progress': {
      if (rest.length === 0) {
        if (method === 'GET') {
          const snapshot = await app.progress.getSnapshot();
          return sendJson(res, 200, {
            ok: true,
            version: snapshot.version,
            updatedAt: snapshot.updatedAt,
            data: snapshot,
          });
        }
        if (method === 'DELETE') {
          const { updatedAt } = await app.progress.reset();
          return sendJson(res, 200, { ok: true, updatedAt });
        }
        throw notFound('接口不存在');
      }
      if (rest.length === 1 && rest[0] === 'paragraph' && method === 'PUT') {
        return saveParagraphProgress(app, req, res);
      }
      throw notFound('接口不存在');
    }

    case 'review': {
      allow('POST');
      return handleReview(app, req, res);
    }

    case 'reference': {
      allow('POST');
      return handleReference(app, req, res);
    }

    case 'word': {
      allow('POST');
      return handleWord(app, req, res);
    }

    default:
      throw notFound('接口不存在');
  }
}

/** PUT /api/progress/paragraph —— 按段 patch 合并保存。 */
async function saveParagraphProgress(app, req, res) {
  const body = requireBody(await readJsonBody(req, app.config.maxBodyBytes));
  const target = parseBookChapterParagraph(body);
  const patch = { ...target };
  let hasField = false;

  if (body.sentences !== undefined) {
    if (!Array.isArray(body.sentences)) throw badRequest('sentences 必须是字符串数组');
    if (body.sentences.length > 1000) throw badRequest('sentences 句数过多');
    for (let index = 0; index < body.sentences.length; index += 1) {
      if (typeof body.sentences[index] !== 'string') {
        throw badRequest(`sentences[${index}] 必须是字符串`);
      }
    }
    patch.sentences = body.sentences;
    patch.hasSentences = true;
    hasField = true;
  }
  if (body.starred !== undefined) {
    if (typeof body.starred !== 'boolean') throw badRequest('starred 必须是布尔值');
    patch.starred = body.starred;
    patch.hasStarred = true;
    hasField = true;
  }
  if (body.review !== undefined) {
    if (body.review !== null && (typeof body.review !== 'object' || Array.isArray(body.review))) {
      throw badRequest('review 必须是对象或 null');
    }
    patch.review = body.review;
    patch.hasReview = true;
    hasField = true;
  }
  if (!hasField) throw badRequest('缺少可保存字段（sentences/starred/review 至少提供一个）');

  // 用 manifest/章节文件校验段落真实存在，并检查译文句数对齐。
  const info = await app.corpus.getParagraph(target.bookId, target.chapterIndex, target.paragraphIndex);
  if (patch.hasSentences && patch.sentences.length !== info.sentences.length) {
    throw badRequest(`译文句数（${patch.sentences.length}）与原文句数（${info.sentences.length}）不一致`);
  }

  const { updatedAt, summary } = await app.progress.setParagraph(patch);
  return sendJson(res, 200, { ok: true, updatedAt, summary });
}

/** POST /api/review —— 段落 AI 批改。 */
async function handleReview(app, req, res) {
  const body = requireBody(await readJsonBody(req, app.config.maxBodyBytes));
  const target = parseBookChapterParagraph(body);

  if (!Array.isArray(body.translations)) throw badRequest('translations 必须是字符串数组');
  if (body.translations.length > 500) throw badRequest('translations 句数过多');
  const translations = body.translations.map((item, index) => {
    if (typeof item !== 'string') throw badRequest(`translations[${index}] 必须是字符串`);
    return item;
  });
  const context = normalizeContext(body.context);

  // 权威英文原句来自语料，客户端传什么原文都不采信。
  const info = await app.corpus.getParagraph(target.bookId, target.chapterIndex, target.paragraphIndex);
  const sentences = info.sentences;
  if (translations.length !== sentences.length) {
    throw badRequest(`译文句数（${translations.length}）必须与原文句数（${sentences.length}）一致`);
  }

  const messages = [
    { role: 'system', content: REVIEW_SYSTEM_PROMPT },
    { role: 'user', content: buildReviewUserPrompt({ sentences, translations, context }) },
  ];
  const { json, meta } = await app.ai.chatJSON({
    messages,
    maxTokens: app.config.maxTokens,
    temperature: app.config.temperature,
    label: 'review',
  });
  const review = normalizeReview(json, sentences.length, translations);
  return sendJson(res, 200, { ok: true, review, meta });
}

/** POST /api/reference —— 段落参考译文。 */
async function handleReference(app, req, res) {
  const body = requireBody(await readJsonBody(req, app.config.maxBodyBytes));
  const target = parseBookChapterParagraph(body);
  const info = await app.corpus.getParagraph(target.bookId, target.chapterIndex, target.paragraphIndex);
  const sentences = info.sentences;

  const messages = [
    { role: 'system', content: REFERENCE_SYSTEM_PROMPT },
    { role: 'user', content: buildReferenceUserPrompt({ sentences }) },
  ];
  const { json, meta } = await app.ai.chatJSON({
    messages,
    maxTokens: app.config.maxTokens,
    temperature: app.config.temperature,
    label: 'reference',
  });
  const reference = normalizeReference(json, sentences.length);
  return sendJson(res, 200, { ok: true, reference, meta });
}

/** POST /api/word —— 单词/短语讲解（可选接口）。 */
async function handleWord(app, req, res) {
  const body = requireBody(await readJsonBody(req, app.config.maxBodyBytes));
  if (typeof body.word !== 'string' || !body.word.trim()) throw badRequest('word 不合法：应为非空字符串');
  const word = body.word.trim().slice(0, 100);
  const sentence = typeof body.sentence === 'string' ? body.sentence.trim().slice(0, 2000) : '';
  const paragraph = typeof body.paragraph === 'string' ? body.paragraph.trim().slice(0, 5000) : '';

  const messages = [
    { role: 'system', content: WORD_SYSTEM_PROMPT },
    { role: 'user', content: buildWordUserPrompt({ word, sentence, paragraph }) },
  ];
  const { json, meta } = await app.ai.chatJSON({
    messages,
    maxTokens: 800,
    temperature: app.config.temperature,
    label: 'word',
  });
  const entry = normalizeWord(json, word);
  return sendJson(res, 200, { ok: true, entry, meta });
}

// ---------------------------------------------------------------------------
// 静态文件
// ---------------------------------------------------------------------------

async function serveStatic(app, req, res, pathname) {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') throw notFound('资源不存在');

  const publicDir = path.resolve(app.config.publicDir);
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (!relative) return sendFallbackIndex(res, publicDir, method);

  const absolute = path.resolve(publicDir, relative);
  const rootWithSep = publicDir.endsWith(path.sep) ? publicDir : publicDir + path.sep;
  // 路径穿越（含 ../、..\\、绝对路径注入）一律 404，绝不落到语料/源码/数据目录。
  if (absolute !== publicDir && !absolute.startsWith(rootWithSep)) {
    throw notFound('资源不存在');
  }

  try {
    const stat = await fsp.stat(absolute);
    if (stat.isFile()) {
      const buffer = await fsp.readFile(absolute);
      return sendBuffer(res, 200, buffer, mimeFor(absolute), method);
    }
  } catch (error) {
    if (error && error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
      throw new HttpError(500, 'SERVER_ERROR', '读取静态资源失败');
    }
  }

  // 契约 §4.6：未知路由返回 index.html（前端 hash 路由兜底）。
  return sendFallbackIndex(res, publicDir, method);
}

async function sendFallbackIndex(res, publicDir, method) {
  const indexPath = path.join(publicDir, 'index.html');
  try {
    const buffer = await fsp.readFile(indexPath);
    return sendBuffer(res, 200, buffer, 'text/html; charset=utf-8', method);
  } catch {
    throw notFound('页面不存在：public/index.html 尚未就绪');
  }
}

// ---------------------------------------------------------------------------
// 错误处理
// ---------------------------------------------------------------------------

const ERROR_STATUS = {
  AI_AUTH: 401,
  AI_RATE_LIMIT: 429,
  AI_TIMEOUT: 504,
  AI_BAD_FORMAT: 502,
  SERVER_ERROR: 500,
};

function toErrorPayload(app, req, error) {
  if (error instanceof HttpError) {
    return { status: error.status, code: error.code, message: error.message, log: false };
  }
  if (error instanceof AiError) {
    return { status: error.httpStatus, code: error.code, message: error.message, log: error.code === 'SERVER_ERROR' };
  }
  if (error instanceof CorpusError) {
    const status = error.code === 'NOT_FOUND' ? 404 : (ERROR_STATUS.SERVER_ERROR ?? 500);
    return {
      status,
      code: error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'SERVER_ERROR',
      message: error.message,
      log: error.code !== 'NOT_FOUND',
    };
  }
  return {
    status: 500,
    code: 'SERVER_ERROR',
    message: '服务器内部错误，请稍后重试。',
    log: true,
  };
}

function handleRequestError(app, req, res, error) {
  const payload = toErrorPayload(app, req, error);
  if (payload.log) {
    const detail = error && error.stack ? error.stack : String(error);
    if (app.logger && typeof app.logger.error === 'function') {
      app.logger.error(`[error] ${req.method} ${req.url} ${payload.code}: ${detail}`);
    }
  }
  if (res.headersSent) {
    res.destroy();
    return;
  }
  sendJson(res, payload.status, {
    ok: false,
    error: { code: payload.code, message: payload.message },
  });
}

// ---------------------------------------------------------------------------
// 应用组装 / 启动
// ---------------------------------------------------------------------------

/**
 * 组装应用（不监听端口，便于测试）。
 * @param {{config?: ReturnType<typeof loadConfig>, logger?: Console,
 *          corpus?: CorpusStore, progress?: ProgressStore, ai?: DeepSeekClient}} [options]
 */
export function createApp(options = {}) {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? console;
  const corpus = options.corpus ?? new CorpusStore({ corpusDir: config.corpusDir });
  const progress = options.progress ?? new ProgressStore({
    filePath: config.progressPath,
    corpus,
    logger,
  });
  const ai = options.ai ?? new DeepSeekClient({
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
    maxConcurrency: config.aiConcurrency,
    logger,
  });

  const app = { config, logger, corpus, progress, ai };
  const server = http.createServer((req, res) => {
    handleRequest(app, req, res).catch((error) => handleRequestError(app, req, res, error));
  });
  return { server, app, config, corpus, progress, ai, logger };
}

/**
 * 启动服务并打印三行启动日志（地址 / AI 配置状态 / 语料统计），绝不打印 Key。
 * @param {{config?: ReturnType<typeof loadConfig>, logger?: Console}} [options]
 */
export async function startServer(options = {}) {
  const built = createApp(options);
  const { config, corpus, progress, server, logger } = built;

  await progress.ensureLoaded();

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(config.port, config.host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = address && typeof address === 'object' ? address.port : config.port;
  const hostForUrl = config.host.includes(':') ? `[${config.host}]` : config.host;
  const url = `http://${hostForUrl}:${actualPort}`;

  const stats = await corpus.getStats();
  const keyLine = config.keyConfigured
    ? `已配置 Key（来源：${keySourceLabel(config.keySource)}）`
    : '未配置 API Key（AI 批改不可用，见 .env.example）';

  logger.log(`逐句译服务已启动: ${url}`);
  logger.log(`AI 配置: ${keyLine} | 模型: ${config.model} | 接口: ${config.baseUrlHost}`);
  logger.log(stats.books > 0
    ? `语料: ${stats.books} 本 / ${stats.chapters} 章 / ${stats.sentences} 句（${config.corpusDir}）`
    : `语料: 未就绪（${config.corpusDir}/manifest.json 缺失，请先运行 python scripts/build_corpus.py）`);

  return { ...built, url, address };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  startServer()
    .then(({ server, logger }) => {
      const shutdown = (signal) => {
        logger.log(`收到 ${signal}，正在关闭服务…`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000).unref();
      };
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
    })
    .catch((error) => {
      console.error(`启动失败：${error?.message || error}`);
      process.exitCode = 1;
    });
}
