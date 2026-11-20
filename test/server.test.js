/**
 * 后端黑盒测试（node:test + 本地 mock DeepSeek，绝不调用真实 API）。
 *
 * 覆盖 docs/CONTRACT.md §7 的全部验收项：
 * 1. 静态文件：/ 200、/css/app.css 200、路径穿越 404；
 * 2. manifest/章节接口正常、不存在章节 404、非法 bookId 404（防穿越）；
 * 3. 读不到 Key：health keyConfigured:false，/api/review 返回 AI_AUTH；
 * 4. mock DeepSeek：正常结构化字段、坏 JSON 重试后 AI_BAD_FORMAT、超时 AI_TIMEOUT、401 AI_AUTH；
 * 5. 进度：PUT→GET 一致、重启仍在、并发 PUT 不损坏、DELETE 重置、损坏文件备份重建；
 * 6. 以上全部在本文件运行，`node --test test/` 全绿。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../server/config.js';
import { createApp, startServer } from '../server/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const FIXTURE_CORPUS = path.join(FIXTURES, 'corpus');
const FIXTURE_PUBLIC = path.join(FIXTURES, 'public');
const TEST_API_KEY = 'test-key-not-real';

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

// ---------------------------------------------------------------------------
// 工具：临时目录 / HTTP 客户端
// ---------------------------------------------------------------------------

function makeTempDir(prefix = 'translate-study-test-') {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** 原始 HTTP 请求：path 不做 URL 规范化，才能测试路径穿越。 */
function rawRequest(baseUrl, requestPath, { method = 'GET', headers = {}, body, timeoutMs = 10000 } = {}) {
  const target = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    const requestHeaders = { ...headers };
    if (payload !== undefined) requestHeaders['Content-Length'] = payload.length;
    const req = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: requestPath,
        method,
        headers: requestHeaders,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('rawRequest timeout')));
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function jsonRequest(baseUrl, method, requestPath, body) {
  const raw = await rawRequest(baseUrl, requestPath, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { ...raw, body: raw.json ?? raw.text };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 工具：启动被测应用（进程内，随机端口）
// ---------------------------------------------------------------------------

async function startTestApp(options = {}) {
  const tmpDir = options.tmpDir ?? (await makeTempDir());
  const env = {
    PORT: '0',
    HOST: '127.0.0.1',
    DEEPSEEK_BASE_URL: options.baseUrl ?? 'http://127.0.0.1:9',
    DEEPSEEK_MODEL: options.model ?? 'deepseek-chat',
    AI_TIMEOUT_MS: String(options.timeoutMs ?? 500),
    DEEPSEEK_ENV_FILE: options.envFile ?? path.join(tmpDir, 'absent.env'),
    DEEPSEEK_NO_SYSTEM_ENV: '1',
    PROGRESS_PATH: options.progressPath ?? path.join(tmpDir, 'progress.json'),
    CORPUS_DIR: options.corpusDir ?? FIXTURE_CORPUS,
    PUBLIC_DIR: options.publicDir ?? FIXTURE_PUBLIC,
  };
  if (options.key !== null) env.DEEPSEEK_API_KEY = options.key ?? TEST_API_KEY;

  const config = loadConfig(env);
  const built = createApp({ config, logger: options.logger ?? silentLogger });
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    built.server.once('error', onError);
    built.server.listen(0, '127.0.0.1', () => {
      built.server.off('error', onError);
      resolve();
    });
  });
  const port = built.server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  await built.progress.ensureLoaded();

  const close = () => new Promise((resolve) => {
    built.server.closeIdleConnections?.();
    built.server.closeAllConnections?.();
    built.server.close(() => resolve());
  });

  return {
    ...built,
    port,
    baseUrl,
    tmpDir,
    progressPath: config.progressPath,
    close,
    cleanup: async () => {
      await close();
      if (!options.keepTmpDir) await fsp.rm(tmpDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// mock DeepSeek 服务
// ---------------------------------------------------------------------------

const REVIEW_FIXTURE = {
  overall: {
    score: 78,
    verdict: 'good',
    summary: '整体理解准确，个别搭配还需打磨。先肯定你抓住了原文语气，再注意中文量词。',
    dimensions: [
      { id: 'accuracy', label: '准确', score: 80 },
      { id: 'fluency', label: '通顺', score: 76 },
      { id: 'style', label: '文风', score: 74 },
    ],
  },
  sentences: [
    {
      index: 0,
      verdict: 'excellent',
      issues: [],
      suggestion: '德思礼先生是一家叫格朗宁的钻头公司的主管。',
      comment: '准确自然。',
    },
    {
      index: 1,
      verdict: 'needs_improvement',
      issues: [{ type: '搭配', detail: '“一把很大的胡子”搭配不当，应说“一大把胡子”。' }],
      suggestion: '他身材高大魁梧，几乎没有脖子，却留着一大把胡子。',
      comment: '注意中文量词搭配。',
    },
    {
      index: 2,
      verdict: 'excellent',
      issues: [],
      suggestion: '德思礼家有个儿子叫达力，在他们看来，天底下再没有比他更好的男孩了。',
      comment: '译文自然。',
    },
  ],
  revisedParagraph: '德思礼先生是一家叫格朗宁的钻头公司的主管。他身材高大魁梧，几乎没有脖子，却留着一大把胡子。德思礼家有个儿子叫达力，在他们看来，天底下再没有比他更好的男孩了。',
  vocabulary: [{ term: 'beefy', meaning: '魁梧的；壮实的', note: '口语中常形容人高大结实。' }],
  tips: ['注意中文量词搭配。', '专有名词可以统一译名后再通读一遍。'],
};

const REFERENCE_FIXTURE = {
  translation: '德思礼先生是一家叫格朗宁的钻头公司的主管。他身材高大魁梧，几乎没有脖子，却留着一大把胡子。德思礼家有个儿子叫达力，在他们看来，天底下再没有比他更好的男孩了。',
  sentences: [
    { index: 0, translation: '德思礼先生是一家叫格朗宁的钻头公司的主管。', note: 'director 在此译“主管”更自然。' },
    { index: 1, translation: '他身材高大魁梧，几乎没有脖子，却留着一大把胡子。', note: '' },
    { index: 2, translation: '德思礼家有个儿子叫达力，在他们看来，天底下再没有比他更好的男孩了。', note: 'no finer boy 可译作“再没有比他更好的男孩”。' },
  ],
};

const WORD_FIXTURE = {
  word: 'beefy',
  phonetic: '/ˈbiːfi/',
  meanings: [{ pos: 'adj.', cn: '魁梧的；结实有力的' }],
  explanation: '本句用 beefy 形容达力父亲身材高大壮实，带有轻微的调侃语气。',
  examples: [{ en: 'He was a big, beefy man.', cn: '他是个高大魁梧的男人。' }],
};

function chatEnvelope(content) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'deepseek-flash',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
  };
}

async function createMockDeepSeek() {
  const state = {
    mode: 'ok',
    calls: [],
    active: 0,
    maxActive: 0,
    delayMs: 0,
    badJsonServed: 0,
  };
  const sockets = new Set();

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let payload = null;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      payload = null;
    }
    const system = payload?.messages?.[0]?.content ?? '';
    const user = payload?.messages?.[1]?.content ?? '';
    state.calls.push({ payload, system, user, hasJsonObjectFormat: payload?.response_format?.type === 'json_object' });
    state.active += 1;
    state.maxActive = Math.max(state.maxActive, state.active);

    let done = false;
    const respond = (status, body) => {
      if (done) return;
      done = true;
      state.active = Math.max(0, state.active - 1);
      if (res.destroyed || res.writableEnded) return;
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(text);
    };
    res.on('close', () => {
      if (done) return;
      done = true;
      state.active = Math.max(0, state.active - 1);
    });

    if (state.delayMs > 0) await sleep(state.delayMs);
    if (done) return;

    if (state.mode === 'auth') return respond(401, { error: { message: 'invalid api key' } });
    if (state.mode === 'rate_limit') return respond(429, { error: { message: 'rate limited' } });
    if (state.mode === 'timeout') return; // 故意不响应，等客户端超时
    if (state.mode === 'badjson-always') return respond(200, chatEnvelope('这不是合法 JSON：{'));
    if (state.mode === 'badjson-then-ok') {
      if (state.badJsonServed === 0) {
        state.badJsonServed += 1;
        return respond(200, chatEnvelope('这不是合法 JSON'));
      }
      return respond(200, chatEnvelope(JSON.stringify(REVIEW_FIXTURE)));
    }
    if (state.mode === 'partial') {
      return respond(200, chatEnvelope(JSON.stringify({
        overall: { score: 130, verdict: 'weird' },
        sentences: [{ index: 0, verdict: 'excellent', issues: ['这条问题没有 type 字段'] }],
        vocabulary: 'bad',
        tips: 'bad',
      })));
    }

    // 默认 ok：按 system prompt 自动返回对应模式的 JSON（review 先判断，它的提示词里也含“参考译文”字样）
    if (system.includes('批改中国学生的文学翻译练习')) return respond(200, chatEnvelope(JSON.stringify(REVIEW_FIXTURE)));
    if (system.includes('参考译文')) return respond(200, chatEnvelope(JSON.stringify(REFERENCE_FIXTURE)));
    if (system.includes('单词或短语')) return respond(200, chatEnvelope(JSON.stringify(WORD_FIXTURE)));
    return respond(200, chatEnvelope(JSON.stringify(REVIEW_FIXTURE)));
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;

  const close = () => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections?.();
    server.close(() => resolve());
  });

  return {
    server,
    state,
    baseUrl: `http://127.0.0.1:${port}`,
    reset() {
      state.mode = 'ok';
      state.calls.length = 0;
      state.active = 0;
      state.maxActive = 0;
      state.delayMs = 0;
      state.badJsonServed = 0;
    },
    close,
  };
}

// ---------------------------------------------------------------------------
// 全局：mock 服务
// ---------------------------------------------------------------------------

let mock;
let mockBaseUrl;

before(async () => {
  mock = await createMockDeepSeek();
  mockBaseUrl = mock.baseUrl;
});

after(async () => {
  await mock.close();
});

/** 创建被测应用并在测试结束后自动清理；创建前重置 mock 状态。 */
async function withApp(t, options = {}) {
  mock.reset();
  const instance = await startTestApp({ baseUrl: mockBaseUrl, ...options });
  t.after(async () => {
    await instance.cleanup();
  });
  return instance;
}

// ---------------------------------------------------------------------------
// 1. 静态文件
// ---------------------------------------------------------------------------

describe('静态文件服务（契约 §7.1）', () => {
  it('GET / 返回 index.html，GET /css/app.css 返回 CSS', async (t) => {
    const app = await withApp(t);

    const root = await rawRequest(app.baseUrl, '/');
    assert.equal(root.status, 200);
    assert.match(String(root.headers['content-type']), /text\/html/);
    assert.ok(root.text.includes('逐句译测试首页'));

    const css = await rawRequest(app.baseUrl, '/css/app.css');
    assert.equal(css.status, 200);
    assert.match(String(css.headers['content-type']), /text\/css/);
    assert.ok(css.text.includes('body'));
  });

  it('未知路径回退 index.html（前端 hash 路由）', async (t) => {
    const app = await withApp(t);
    const res = await rawRequest(app.baseUrl, '/some/unknown/route');
    assert.equal(res.status, 200);
    assert.ok(res.text.includes('逐句译测试首页'));
  });

  it('路径穿越一律 404，且不泄露源码/配置内容', async (t) => {
    const app = await withApp(t);
    const attempts = [
      '/../server/config.js',
      '/%2e%2e/%2e%2e/server/config.js',
      '/..%5cserver%5cconfig.js',
      '/css/../../package.json',
      '/%43%3A%2FWindows/win.ini',
    ];
    for (const attempt of attempts) {
      const res = await rawRequest(app.baseUrl, attempt);
      assert.equal(res.status, 404, `路径穿越应 404：${attempt}`);
      assert.ok(!res.text.includes('parseEnvFile'), `不应泄露 server/config.js：${attempt}`);
      assert.ok(!res.text.includes('DEEPSEEK_API_KEY'), `不应泄露配置内容：${attempt}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. 语料接口
// ---------------------------------------------------------------------------

describe('语料接口（契约 §7.2）', () => {
  it('GET /api/manifest 返回 manifest', async (t) => {
    const app = await withApp(t);
    const res = await jsonRequest(app.baseUrl, 'GET', '/api/manifest');
    assert.equal(res.status, 200);
    assert.equal(res.body.version, 1);
    assert.ok(Array.isArray(res.body.books));
    assert.equal(res.body.books.length, 2);
    assert.equal(res.body.books[0].id, 'hp1');
  });

  it('GET /api/chapters/hp1/1 返回章文件，句子为 {text, wordCount}', async (t) => {
    const app = await withApp(t);
    const res = await jsonRequest(app.baseUrl, 'GET', '/api/chapters/hp1/1');
    assert.equal(res.status, 200);
    assert.equal(res.body.bookId, 'hp1');
    assert.equal(res.body.chapterIndex, 1);
    assert.ok(Array.isArray(res.body.paragraphs));
    assert.equal(res.body.paragraphs.length, 3);
    assert.equal(res.body.paragraphs[0].sentences.length, 3);
    assert.match(res.body.paragraphs[0].sentences[0].text, /Mr\. Dursley/);
  });

  it('不存在的章节 / 书返回 404 NOT_FOUND', async (t) => {
    const app = await withApp(t);
    const chapter = await jsonRequest(app.baseUrl, 'GET', '/api/chapters/hp1/999');
    assert.equal(chapter.status, 404);
    assert.equal(chapter.body.ok, false);
    assert.equal(chapter.body.error.code, 'NOT_FOUND');

    const book = await jsonRequest(app.baseUrl, 'GET', '/api/chapters/hp9/1');
    assert.equal(book.status, 404);
    assert.equal(book.body.error.code, 'NOT_FOUND');
  });

  it('非法 bookId（含路径穿越）返回 404', async (t) => {
    const app = await withApp(t);
    const attempts = [
      '/api/chapters/..%2F..%2Fpackage.json/1',
      '/api/chapters/..%5c..%5cpackage.json/1',
      '/api/chapters/%2e%2e%2fserver/1',
      '/api/chapters/hp1%2F..%2F..%2Fserver/1',
    ];
    for (const attempt of attempts) {
      const res = await rawRequest(app.baseUrl, attempt);
      assert.equal(res.status, 404, `非法 bookId 应 404：${attempt}`);
      assert.ok(!res.text.includes('"name": "translate-study"'));
    }
  });

  it('语料未就绪时服务仍可启动，接口返回清晰中文错误', async (t) => {
    const emptyDir = await makeTempDir('translate-study-nocorpus-');
    t.after(async () => {
      await fsp.rm(emptyDir, { recursive: true, force: true });
    });
    const app = await withApp(t, { corpusDir: emptyDir });

    const health = await jsonRequest(app.baseUrl, 'GET', '/api/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.body.corpus, { books: 0, chapters: 0, sentences: 0 });

    const manifest = await jsonRequest(app.baseUrl, 'GET', '/api/manifest');
    assert.equal(manifest.status, 500);
    assert.equal(manifest.body.ok, false);
    assert.equal(manifest.body.error.code, 'SERVER_ERROR');
    assert.match(manifest.body.error.message, /语料/);

    const chapter = await jsonRequest(app.baseUrl, 'GET', '/api/chapters/hp1/1');
    assert.equal(chapter.status, 500);
    assert.match(chapter.body.error.message, /语料/);

    // 进程没有 crash：健康检查仍然可用
    const again = await jsonRequest(app.baseUrl, 'GET', '/api/health');
    assert.equal(again.status, 200);
  });

  it('manifest 损坏时返回 500 而非 crash', async (t) => {
    const brokenDir = await makeTempDir('translate-study-brokenmanifest-');
    await fsp.writeFile(path.join(brokenDir, 'manifest.json'), '{ broken json', 'utf8');
    t.after(async () => {
      await fsp.rm(brokenDir, { recursive: true, force: true });
    });
    const app = await withApp(t, { corpusDir: brokenDir });
    const res = await jsonRequest(app.baseUrl, 'GET', '/api/manifest');
    assert.equal(res.status, 500);
    assert.equal(res.body.error.code, 'SERVER_ERROR');
    assert.match(res.body.error.message, /JSON/);
  });
});

// ---------------------------------------------------------------------------
// 3. 健康检查 / 未配置 Key
// ---------------------------------------------------------------------------

describe('健康检查与 Key 缺失（契约 §4.1 / §7.3）', () => {
  it('GET /api/health 返回完整字段且绝不包含 Key', async (t) => {
    const app = await withApp(t);
    const res = await jsonRequest(app.baseUrl, 'GET', '/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.version, '1.0.0');
    assert.equal(res.body.keyConfigured, true);
    assert.equal(res.body.model, 'deepseek-chat');
    assert.equal(res.body.baseUrlHost, new URL(mockBaseUrl).host);
    assert.deepEqual(res.body.corpus, { books: 2, chapters: 3, sentences: 11 });
    assert.equal(res.body.progressUpdatedAt, null);
    assert.ok(!res.text.includes(TEST_API_KEY));
    assert.ok(!res.text.includes('Bearer'));
  });

  it('未配置 Key：health keyConfigured:false，/api/review 返回 AI_AUTH 且不发起网络请求', async (t) => {
    const app = await withApp(t, { key: null });
    assert.equal(app.config.keyConfigured, false);
    assert.equal(app.config.apiKey, '');
    assert.equal(app.config.keySource, null);

    const health = await jsonRequest(app.baseUrl, 'GET', '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.keyConfigured, false);
    assert.ok(!health.text.includes(TEST_API_KEY));

    const review = await jsonRequest(app.baseUrl, 'POST', '/api/review', {
      bookId: 'hp1',
      chapterIndex: 1,
      paragraphIndex: 0,
      translations: ['一', '二', '三'],
    });
    assert.equal(review.status, 401);
    assert.equal(review.body.ok, false);
    assert.equal(review.body.error.code, 'AI_AUTH');
    assert.match(review.body.error.message, /API Key/);
    assert.equal(mock.state.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 4. AI 批改
// ---------------------------------------------------------------------------

function makeReviewBody(overrides = {}) {
  return {
    bookId: 'hp1',
    chapterIndex: 1,
    paragraphIndex: 0,
    translations: [
      '德思礼先生是格朗宁公司的主管，这家公司生产钻头。',
      '他是个又大又壮的男人，几乎没有脖子，不过确实留着一把很大的胡子。',
      '',
    ],
    ...overrides,
  };
}

describe('AI 批改 /api/review（契约 §4.3 / §7.4）', () => {
  it('正常返回：结构化字段齐全、逐句对齐、空译文标 missing、服务端使用语料原句', async (t) => {
    const app = await withApp(t);
    const res = await jsonRequest(app.baseUrl, 'POST', '/api/review', makeReviewBody({ sentences: ['客户端伪造的原句，不应被采信'] }));
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    const review = res.body.review;
    assert.equal(review.overall.score, 78);
    assert.equal(review.overall.verdict, 'good');
    assert.ok(review.overall.summary.length > 0);
    assert.equal(review.overall.dimensions.length, 3);
    assert.deepEqual(review.overall.dimensions.map((item) => item.id), ['accuracy', 'fluency', 'style']);
    assert.deepEqual(review.overall.dimensions.map((item) => item.label), ['准确', '通顺', '文风']);
    assert.equal(review.sentences.length, 3);
    assert.deepEqual(review.sentences.map((item) => item.index), [0, 1, 2]);
    assert.equal(review.sentences[0].verdict, 'excellent');
    assert.equal(review.sentences[1].verdict, 'needs_improvement');
    assert.equal(review.sentences[1].issues[0].type, '搭配');
    assert.ok(review.sentences[1].suggestion.length > 0);
    assert.ok(review.sentences[1].comment.length > 0);
    assert.equal(review.sentences[2].verdict, 'missing', '空串译文必须标 missing');
    assert.ok(review.sentences[2].suggestion.length > 0);
    assert.ok(review.revisedParagraph.length > 0);
    assert.ok(review.vocabulary.length >= 1);
    assert.equal(review.vocabulary[0].term, 'beefy');
    assert.ok(review.tips.length >= 1);

    assert.equal(res.body.meta.model, 'deepseek-chat');
    assert.equal(typeof res.body.meta.elapsedMs, 'number');
    assert.deepEqual(res.body.meta.usage, { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 });

    // 服务端发给 AI 的是语料原句，而不是客户端伪造的 sentences
    assert.equal(mock.state.calls.length, 1);
    const call = mock.state.calls[0];
    assert.equal(call.hasJsonObjectFormat, true);
    assert.match(call.user, /Mr\. Dursley was the director/);
    assert.match(call.user, /（未翻译）/);
    assert.ok(!call.user.includes('客户端伪造的原句'));
    assert.equal(call.payload.temperature, 0.3);
    assert.equal(call.payload.max_tokens, 2000);
    assert.match(call.system, /资深英译中翻译教师/);
  });

  it('AI 输出字段缺失/非法时兜底归一化（score 夹 0-100、补齐句数、非法 verdict 归位）', async (t) => {
    const app = await withApp(t);
    mock.state.mode = 'partial';
    const res = await jsonRequest(app.baseUrl, 'POST', '/api/review', makeReviewBody({
      translations: ['第一句译文', '第二句译文', '第三句译文'],
    }));
    assert.equal(res.status, 200);
    const review = res.body.review;
    assert.equal(review.overall.score, 100, '130 应被夹到 100');
    assert.equal(review.overall.verdict, 'needs_improvement', '非法 verdict 应归到 needs_improvement');
    assert.equal(review.overall.dimensions.length, 3);
    assert.deepEqual(review.overall.dimensions.map((item) => item.score), [100, 100, 100]);
    assert.equal(review.sentences.length, 3);
    assert.equal(review.sentences[0].verdict, 'excellent');
    assert.equal(review.sentences[0].issues.length, 1);
    assert.equal(review.sentences[0].issues[0].type, '其他');
    assert.equal(review.sentences[1].verdict, 'needs_improvement');
    assert.ok(Array.isArray(review.vocabulary));
    assert.equal(review.vocabulary.length, 0);
    assert.ok(Array.isArray(review.tips));
    assert.ok(review.tips.length >= 1, 'tips 缺失时应给默认建议');
    assert.ok(review.revisedParagraph.length > 0);
  });

  it('译文句数与原文不一致返回 400 BAD_REQUEST，且不调用 AI', async (t) => {
    const app = await withApp(t);
    const res = await jsonRequest(app.baseUrl, 'POST', '/api/review', makeReviewBody({ translations: ['只有一句'] }));
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error.code, 'BAD_REQUEST');
    assert.match(res.body.error.message, /句数/);
    assert.equal(mock.state.calls.length, 0);
  });

  it('translations 非字符串数组返回 400；缺 body 返回 400；段落不存在返回 404', async (t) => {
    const app = await withApp(t);
    const notArray = await jsonRequest(app.baseUrl, 'POST', '/api/review', makeReviewBody({ translations: '字符串' }));
    assert.equal(notArray.status, 400);
    assert.equal(notArray.body.error.code, 'BAD_REQUEST');

    const badType = await jsonRequest(app.baseUrl, 'POST', '/api/review', makeReviewBody({ translations: ['a', 2, 'c'] }));
    assert.equal(badType.status, 400);

    const emptyBody = await rawRequest(app.baseUrl, '/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(emptyBody.status, 400);
    assert.equal(emptyBody.json.error.code, 'BAD_REQUEST');

    const missingParagraph = await jsonRequest(app.baseUrl, 'POST', '/api/review', makeReviewBody({ paragraphIndex: 99 }));
    assert.equal(missingParagraph.status, 404);
    assert.equal(missingParagraph.body.error.code, 'NOT_FOUND');
    assert.equal(mock.state.calls.length, 0);
  });

  it('坏 JSON：重试 1 次成功后返回正常结果', async (t) => {
    const app = await withApp(t);
    mock.state.mode = 'badjson-then-ok';
    const res = await jsonRequest(app.baseUrl, 'POST', '/api/review', makeReviewBody());
    assert.equal(res.status, 200);
    assert.equal(res.body.review.sentences.length, 3);
    assert.equal(res.body.meta.attempts, 2);
    assert.equal(mock.state.calls.length, 2);
    assert.equal(mock.state.badJsonServed, 1);
  });

  it('坏 JSON：重试 1 次仍失败返回 502 AI_BAD_FORMAT', async (t) => {
    const app = await withApp(t);
    mock.state.mode = 'badjson-always';
    const res = await jsonRequest(app.baseUrl, 'POST', '/api/review', makeReviewBody());
    assert.equal(res.status, 502);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error.code, 'AI_BAD_FORMAT');
    assert.match(res.body.error.message, /重试|JSON/);
    assert.equal(mock.state.calls.length, 2, '应只重试 1 次');
  });

  it('AI 超时返回 504 AI_TIMEOUT', async (t) => {
    const app = await withApp(t, { timeoutMs: 250 });
    mock.state.mode = 'timeout';
    const startedAt = Date.now();
    const res = await jsonRequest(app.baseUrl, 'POST', '/api/review', makeReviewBody());
    assert.equal(res.status, 504);
    assert.equal(res.body.error.code, 'AI_TIMEOUT');
    assert.match(res.body.error.message, /超时/);
    assert.equal(mock.state.calls.length, 1);
    assert.ok(Date.now() - startedAt < 5000);
  });

  it('AI 返回 401 → AI_AUTH；429 → AI_RATE_LIMIT', async (t) => {
    const app = await withApp(t);

    mock.state.mode = 'auth';
    const auth = await jsonRequest(app.baseUrl, 'POST', '/api/review', makeReviewBody());
    assert.equal(auth.status, 401);
    assert.equal(auth.body.error.code, 'AI_AUTH');

    mock.state.mode = 'rate_limit';
    const limited = await jsonRequest(app.baseUrl, 'POST', '/api/review', makeReviewBody());
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, 'AI_RATE_LIMIT');
  });

  it('并发上限 2：5 个并发批改请求最多同时 2 个打到 AI', async (t) => {
    const app = await withApp(t);
    mock.state.delayMs = 80;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => jsonRequest(app.baseUrl, 'POST', '/api/review', makeReviewBody())),
    );
    for (const res of results) assert.equal(res.status, 200);
    assert.equal(mock.state.calls.length, 5);
    assert.ok(mock.state.maxActive <= 2, `AI 并发应 <= 2，实际 ${mock.state.maxActive}`);
  });

  it('请求体超过 256KB 返回 400 BAD_REQUEST', async (t) => {
    const app = await withApp(t);
    const huge = JSON.stringify({
      bookId: 'hp1',
      chapterIndex: 1,
      paragraphIndex: 0,
      translations: ['x'.repeat(300 * 1024)],
    });
    const res = await rawRequest(app.baseUrl, '/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: huge,
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'BAD_REQUEST');
    assert.match(res.json.error.message, /256KB/);
  });

  it('请求体不是合法 JSON 返回 400', async (t) => {
    const app = await withApp(t);
    const res = await rawRequest(app.baseUrl, '/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"bookId": broken',
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'BAD_REQUEST');
  });
});

// ---------------------------------------------------------------------------
// 5. 参考译文 / 单词
// ---------------------------------------------------------------------------

describe('参考译文与单词接口（契约 §4.4 / §4.5）', () => {
  it('POST /api/reference 返回整段译文 + 逐句译文', async (t) => {
    const app = await withApp(t);
    const res = await jsonRequest(app.baseUrl, 'POST', '/api/reference', {
      bookId: 'hp1',
      chapterIndex: 1,
      paragraphIndex: 0,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.reference.translation.length > 0);
    assert.equal(res.body.reference.sentences.length, 3);
    assert.deepEqual(res.body.reference.sentences.map((item) => item.index), [0, 1, 2]);
    assert.ok(res.body.reference.sentences[0].translation.length > 0);
    assert.equal(typeof res.body.reference.sentences[0].note, 'string');
    assert.equal(res.body.meta.model, 'deepseek-chat');

    const call = mock.state.calls[0];
    assert.equal(mock.state.calls.length, 1, '参考译文只应调用一次 AI');
    assert.match(call.system, /参考译文/);
  });

  it('POST /api/reference 段落不存在返回 404', async (t) => {
    const app = await withApp(t);
    const res = await jsonRequest(app.baseUrl, 'POST', '/api/reference', {
      bookId: 'hp1',
      chapterIndex: 1,
      paragraphIndex: 42,
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });

  it('POST /api/word 返回结构化词条', async (t) => {
    const app = await withApp(t);
    const res = await jsonRequest(app.baseUrl, 'POST', '/api/word', {
      word: 'beefy',
      sentence: 'He was a big, beefy man.',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    const entry = res.body.entry;
    assert.equal(entry.word, 'beefy');
    assert.ok(Array.isArray(entry.meanings) && entry.meanings.length >= 1);
    assert.ok(entry.meanings[0].cn.length > 0);
    assert.ok(Array.isArray(entry.examples));
    assert.equal(entry.examples[0].en, 'He was a big, beefy man.');
  });

  it('POST /api/word 缺少 word 返回 400', async (t) => {
    const app = await withApp(t);
    const res = await jsonRequest(app.baseUrl, 'POST', '/api/word', { sentence: 'x' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'BAD_REQUEST');
  });
});

// ---------------------------------------------------------------------------
// 6. 进度持久化
// ---------------------------------------------------------------------------

function progressUrl(app) {
  return `${app.baseUrl}/api/progress`;
}

describe('进度持久化（契约 §4.2 / §7.5）', () => {
  it('PUT 保存 → GET 回读一致，并返回本书/本章进度百分比', async (t) => {
    const app = await withApp(t);
    const put = await jsonRequest(app.baseUrl, 'PUT', '/api/progress/paragraph', {
      bookId: 'hp1',
      chapterIndex: 1,
      paragraphIndex: 0,
      sentences: ['德思礼先生是格朗宁公司的主管。', '', '德思礼家有个儿子叫达力。'],
      starred: true,
      review: null,
    });
    assert.equal(put.status, 200);
    assert.equal(put.body.ok, true);
    assert.equal(typeof put.body.updatedAt, 'string');
    // 非空译文 2 句：全书 2/9=22.2%，本章 2/6=33.3%
    assert.equal(put.body.summary.bookProgress, 22.2);
    assert.equal(put.body.summary.chapterProgress, 33.3);

    const get = await jsonRequest(app.baseUrl, 'GET', '/api/progress');
    assert.equal(get.status, 200);
    assert.equal(get.body.ok, true);
    assert.equal(get.body.version, 1);
    assert.equal(get.body.updatedAt, put.body.updatedAt);
    assert.equal(get.body.data.version, 1);
    assert.equal(get.body.data.updatedAt, put.body.updatedAt);
    const record = get.body.data.books.hp1.chapters['1'].paragraphs['0'];
    assert.deepEqual(record.sentences, ['德思礼先生是格朗宁公司的主管。', '', '德思礼家有个儿子叫达力。']);
    assert.equal(record.starred, true);
    assert.equal(record.review, null);
    assert.equal(typeof record.updatedAt, 'string');
  });

  it('按段 patch 合并：只更新出现过的字段，其余保留', async (t) => {
    const app = await withApp(t);
    await jsonRequest(app.baseUrl, 'PUT', '/api/progress/paragraph', {
      bookId: 'hp1',
      chapterIndex: 1,
      paragraphIndex: 1,
      sentences: ['第一句', '第二句'],
    });
    const starOnly = await jsonRequest(app.baseUrl, 'PUT', '/api/progress/paragraph', {
      bookId: 'hp1',
      chapterIndex: 1,
      paragraphIndex: 1,
      starred: true,
    });
    assert.equal(starOnly.status, 200);
    const get = await jsonRequest(app.baseUrl, 'GET', '/api/progress');
    const record = get.body.data.books.hp1.chapters['1'].paragraphs['1'];
    assert.deepEqual(record.sentences, ['第一句', '第二句'], 'sentences 应被合并保留');
    assert.equal(record.starred, true);
  });

  it('并发 PUT 不损坏 JSON，所有段落都能落盘', async (t) => {
    const app = await withApp(t);
    const paragraphSentences = {
      0: ['a0', 'b0', 'c0'],
      1: ['a1', 'b1'],
      2: ['a2'],
    };
    const tasks = [];
    for (let round = 0; round < 4; round += 1) {
      for (const [paragraphIndex, sentences] of Object.entries(paragraphSentences)) {
        tasks.push(jsonRequest(app.baseUrl, 'PUT', '/api/progress/paragraph', {
          bookId: 'hp1',
          chapterIndex: 1,
          paragraphIndex: Number(paragraphIndex),
          sentences: sentences.map((item) => `${item}-r${round}`),
        }));
      }
    }
    const results = await Promise.all(tasks);
    for (const res of results) assert.equal(res.status, 200);

    const raw = await fsp.readFile(app.progressPath, 'utf8');
    const parsed = JSON.parse(raw); // 文件必须是完整合法 JSON
    const paragraphs = parsed.books.hp1.chapters['1'].paragraphs;
    assert.deepEqual(Object.keys(paragraphs).sort(), ['0', '1', '2']);
    assert.equal(paragraphs['0'].sentences.length, 3);
    assert.equal(paragraphs['1'].sentences.length, 2);
    assert.equal(paragraphs['2'].sentences.length, 1);

    const get = await jsonRequest(app.baseUrl, 'GET', '/api/progress');
    assert.equal(get.status, 200);
    assert.equal(Object.keys(get.body.data.books.hp1.chapters['1'].paragraphs).length, 3);
  });

  it('重启后进度仍在（同一 PROGRESS_PATH）', async (t) => {
    const tmpDir = await makeTempDir('translate-study-restart-');
    const progressPath = path.join(tmpDir, 'progress.json');
    t.after(async () => {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    const first = await startTestApp({ baseUrl: mockBaseUrl, tmpDir, progressPath, keepTmpDir: true });
    try {
      const put = await jsonRequest(first.baseUrl, 'PUT', '/api/progress/paragraph', {
        bookId: 'hp1',
        chapterIndex: 2,
        paragraphIndex: 0,
        sentences: ['重启后应保留的第一句', '第二句'],
      });
      assert.equal(put.status, 200);
    } finally {
      await first.close();
    }

    const second = await startTestApp({ baseUrl: mockBaseUrl, tmpDir, progressPath, keepTmpDir: true });
    try {
      const get = await jsonRequest(second.baseUrl, 'GET', '/api/progress');
      assert.equal(get.status, 200);
      const record = get.body.data.books.hp1.chapters['2'].paragraphs['0'];
      assert.deepEqual(record.sentences, ['重启后应保留的第一句', '第二句']);
    } finally {
      await second.close();
    }
  });

  it('DELETE 重置全部进度，文件仍是合法 JSON', async (t) => {
    const app = await withApp(t);
    await jsonRequest(app.baseUrl, 'PUT', '/api/progress/paragraph', {
      bookId: 'hp1',
      chapterIndex: 1,
      paragraphIndex: 0,
      sentences: ['一', '二', '三'],
    });
    const reset = await jsonRequest(app.baseUrl, 'DELETE', '/api/progress');
    assert.equal(reset.status, 200);
    assert.equal(reset.body.ok, true);

    const get = await jsonRequest(app.baseUrl, 'GET', '/api/progress');
    assert.deepEqual(get.body.data.books, {});
    assert.equal(get.body.updatedAt, reset.body.updatedAt);

    const parsed = JSON.parse(await fsp.readFile(app.progressPath, 'utf8'));
    assert.deepEqual(parsed.books, {});
  });

  it('启动时进度文件损坏：自动备份并重建空进度，之后可正常写入', async (t) => {
    const tmpDir = await makeTempDir('translate-study-corrupt-');
    const progressPath = path.join(tmpDir, 'progress.json');
    await fsp.writeFile(progressPath, '{"version":1,"books":{broken', 'utf8');
    t.after(async () => {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    const app = await startTestApp({ baseUrl: mockBaseUrl, tmpDir, progressPath, keepTmpDir: true });
    try {
      const get = await jsonRequest(app.baseUrl, 'GET', '/api/progress');
      assert.equal(get.status, 200);
      assert.deepEqual(get.body.data.books, {});

      const entries = await fsp.readdir(tmpDir);
      const backup = entries.find((name) => name.startsWith('progress.json.corrupt-'));
      assert.ok(backup, `损坏文件应被备份，目录内容：${entries.join(', ')}`);

      const put = await jsonRequest(app.baseUrl, 'PUT', '/api/progress/paragraph', {
        bookId: 'hp1',
        chapterIndex: 1,
        paragraphIndex: 2,
        sentences: ['重建后的句子'],
      });
      assert.equal(put.status, 200);
      const after = await jsonRequest(app.baseUrl, 'GET', '/api/progress');
      assert.equal(after.body.data.books.hp1.chapters['1'].paragraphs['2'].sentences[0], '重建后的句子');
    } finally {
      await app.close();
    }
  });

  it('进度写入参数校验：句数不齐 400、段落不存在 404、空 patch 400', async (t) => {
    const app = await withApp(t);
    const mismatch = await jsonRequest(app.baseUrl, 'PUT', '/api/progress/paragraph', {
      bookId: 'hp1',
      chapterIndex: 1,
      paragraphIndex: 0,
      sentences: ['只给一句'],
    });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.error.code, 'BAD_REQUEST');

    const missingParagraph = await jsonRequest(app.baseUrl, 'PUT', '/api/progress/paragraph', {
      bookId: 'hp1',
      chapterIndex: 1,
      paragraphIndex: 99,
      sentences: [],
    });
    assert.equal(missingParagraph.status, 404);

    const emptyPatch = await jsonRequest(app.baseUrl, 'PUT', '/api/progress/paragraph', {
      bookId: 'hp1',
      chapterIndex: 1,
      paragraphIndex: 0,
    });
    assert.equal(emptyPatch.status, 400);
    assert.match(emptyPatch.body.error.message, /sentences|starred|review/);
  });
});

// ---------------------------------------------------------------------------
// 7. 启动日志
// ---------------------------------------------------------------------------

describe('启动日志（契约 §4.6：三行且不含 Key）', () => {
  it('打印访问地址 / AI 配置状态 / 语料统计，绝不打印 Key', async (t) => {
    const tmpDir = await makeTempDir('translate-study-startup-');
    t.after(async () => {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    });
    const lines = [];
    const logger = {
      log: (...args) => lines.push(args.join(' ')),
      info() {},
      warn() {},
      error() {},
    };
    const env = {
      PORT: '0',
      HOST: '127.0.0.1',
      DEEPSEEK_API_KEY: 'startup-log-secret-key',
      DEEPSEEK_ENV_FILE: path.join(tmpDir, 'absent.env'),
      DEEPSEEK_NO_SYSTEM_ENV: '1',
      PROGRESS_PATH: path.join(tmpDir, 'progress.json'),
      CORPUS_DIR: FIXTURE_CORPUS,
      PUBLIC_DIR: FIXTURE_PUBLIC,
    };
    const config = loadConfig(env);
    const started = await startServer({ config, logger });
    try {
      assert.equal(lines.length, 3);
      const text = lines.join('\n');
      assert.ok(!text.includes('startup-log-secret-key'));
      assert.match(text, /已启动: http:\/\/127\.0\.0\.1:\d+/);
      assert.match(text, /已配置 Key/);
      assert.match(text, /语料: 2 本 \/ 3 章 \/ 11 句/);
    } finally {
      started.server.closeIdleConnections?.();
      started.server.closeAllConnections?.();
      await new Promise((resolve) => started.server.close(() => resolve()));
    }
  });
});
