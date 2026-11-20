/**
 * 黑盒 API 测试（零依赖，Node 24 全局 fetch / node:http）。
 *
 * 对运行中的服务（默认 http://127.0.0.1:5180）做契约 §4 / §7 的黑盒验证：
 *   health / manifest / 章节 / 404 / 路径穿越 / 请求体上限 / 进度读写与百分比 /
 *   /api/review 参数边界（不调用真实 AI）/ /api/word 真实调用 1 次（--no-ai 可跳过）。
 * 另外做数据一致性：全部 199 章文件统计 vs manifest。
 *
 * 用法：
 *   node tests/e2e/api-blackbox.mjs
 *   node tests/e2e/api-blackbox.mjs --base http://127.0.0.1:5180 --no-ai
 *
 * 输出：.scratch/qa/api-results.json（逐项 PASS/FAIL + 证据），控制台打印摘要。
 * 退出码：0 全部 PASS，1 存在 FAIL。
 */
import http from 'node:http';
import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { assert, assertContains, assertEqual, createChecker } from './lib/cdp.mjs';
import { apiJson, fetchProgress, iterateParagraphs, summarizeProgress } from './lib/progress-utils.mjs';

const args = process.argv.slice(2);
const getArg = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const BASE = getArg('--base', 'http://127.0.0.1:5180').replace(/\/+$/, '');
const NO_AI = args.includes('--no-ai');
const QA_DIR = path.resolve('.scratch/qa');
const EVIDENCE_DIR = path.join(QA_DIR, 'evidence');
mkdirSync(EVIDENCE_DIR, { recursive: true });

const results = createChecker();
const evidenceFiles = [];
function saveEvidence(name, content) {
  const filePath = path.join(EVIDENCE_DIR, name);
  writeFileSync(filePath, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`, 'utf8');
  evidenceFiles.push(filePath);
  return filePath;
}

function rawRequest(baseUrl, rawPath, { method = 'GET', body = null, headers = {} } = {}) {
  const base = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: base.hostname,
      port: base.port || 80,
      path: rawPath,
      method,
      headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    request.setTimeout(30000, () => request.destroy(new Error('raw request 超时')));
    if (body) request.write(body);
    request.end();
  });
}

async function main() {
  console.log(`\n=== 黑盒 API 测试：${BASE} ===\n`);

  // manifest 与章节缓存，供多项检查复用
  let manifest = null;
  const chapterCache = new Map();
  async function getChapter(bookId, chapterIndex) {
    const key = `${bookId}/${chapterIndex}`;
    if (chapterCache.has(key)) return chapterCache.get(key);
    const response = await apiJson(BASE, `/api/chapters/${bookId}/${chapterIndex}`);
    if (response.status !== 200) throw new Error(`章节 ${key} 拉取失败：HTTP ${response.status}`);
    chapterCache.set(key, response.json);
    return response.json;
  }

  /* ------------------------------ 1. health ------------------------------ */
  await results.check('health：7 本 / 199 章 / 80204 句（最终语料），keyConfigured=true 且不泄露 key', async () => {
    const response = await apiJson(BASE, '/api/health');
    assertEqual(response.status, 200, 'health HTTP 状态');
    const health = response.json;
    saveEvidence('health.json', health);
    assert(health && health.ok === true, 'health.ok 必须为 true');
    assertEqual(health.corpus.books, 7, 'corpus.books');
    assertEqual(health.corpus.chapters, 199, 'corpus.chapters');
    assertEqual(health.corpus.sentences, 80204, 'corpus.sentences（最终语料 80,204 句）');
    assertEqual(health.keyConfigured, true, 'keyConfigured');
    assertEqual(health.model, 'deepseek-chat', 'model');
    assertEqual(health.baseUrlHost, 'api.deepseek.com', 'baseUrlHost');
    assert(typeof health.version === 'string' && health.version.length > 0, 'version 应为非空字符串');
    assert('progressUpdatedAt' in health, 'health 缺少 progressUpdatedAt 字段');
    const serialized = JSON.stringify(health);
    assert(!/sk-[A-Za-z0-9]{12,}/.test(serialized), 'health 响应疑似包含 DeepSeek Key');
    const forbidden = ['apiKey', 'apikey', 'secret', 'accessToken', 'authorization'];
    const walk = (value, trail) => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        assert(!forbidden.includes(key), `health 响应出现敏感字段 ${trail}.${key}`);
        walk(child, `${trail}.${key}`);
      }
    };
    walk(health, '$');
    // 注意：corpus.sentences 是服务端缓存的 manifest 统计；与磁盘语料是否一致由 consistency 阶段单独校验。
    return { corpus: health.corpus, keyConfigured: health.keyConfigured, model: health.model };
  }, { phase: 'health' });

  /* ------------------------------ 2. 静态资源 ------------------------------ */
  await results.check('静态资源：/ 与 /css/app.css /js/app.js 正常返回，MIME 正确', async () => {
    const index = await apiJson(BASE, '/');
    assertEqual(index.status, 200, '/ HTTP 状态');
    assertContains(index.headers.get('content-type') || '', 'text/html', '/ Content-Type');
    assertContains(index.text, '逐句译', '/ 返回的中文文案');
    const css = await apiJson(BASE, '/css/app.css');
    assertEqual(css.status, 200, '/css/app.css HTTP 状态');
    assertContains(css.headers.get('content-type') || '', 'text/css', 'CSS Content-Type');
    assert(css.text.length > 10000, `app.css 体积过小（${css.text.length} 字节）`);
    const js = await apiJson(BASE, '/js/app.js');
    assertEqual(js.status, 200, '/js/app.js HTTP 状态');
    assertContains(js.headers.get('content-type') || '', 'text/javascript', 'JS Content-Type');
    return { htmlBytes: Buffer.byteLength(index.text), cssBytes: Buffer.byteLength(css.text), jsBytes: Buffer.byteLength(js.text) };
  }, { phase: 'static' });

  await results.check('未知静态路由回退 index.html（前端 hash 路由兜底，契约 §4.6）', async () => {
    const response = await apiJson(BASE, '/some/unknown/route');
    assertEqual(response.status, 200, '未知路由 HTTP 状态');
    assertContains(response.headers.get('content-type') || '', 'text/html', '未知路由 Content-Type');
    assertContains(response.text, 'id="app"', '未知路由应回退 index.html');
    return { status: response.status };
  }, { phase: 'static' });

  /* --------------------- 3. 路径穿越 / 非法请求 --------------------- */
  const traversalCases = [
    ['/..%2fserver/config.js', '编码的 ../server'],
    ['/..%2f..%2fserver%2findex.js', '双重 ../'],
    ['/%2e%2e/server/config.js', '%2e%2e 编码'],
    ['/css/..%2f..%2fserver%2fconfig.js', '子目录穿越'],
    ['/public/..%2f..%2fserver%2fconfig.js', 'public 子目录穿越'],
    ['/api/chapters/..%2f..%2fpackage.json/1', 'API 章节路径穿越'],
    ['/api/chapters/hp1/..%2f..%2fpackage.json', 'API 章节 index 穿越'],
  ];
  for (const [rawPath, label] of traversalCases) {
    await results.check(`路径穿越防护：${label} → 404 且不泄露源码/数据`, async () => {
      const response = await rawRequest(BASE, rawPath);
      assertEqual(response.status, 404, `${rawPath} HTTP 状态`);
      const contentType = response.headers['content-type'] || '';
      assertContains(contentType, 'application/json', `${rawPath} 应返回 JSON 错误结构`);
      let json = null;
      try { json = JSON.parse(response.text); } catch { throw new Error(`404 响应不是合法 JSON：${response.text.slice(0, 120)}`); }
      assertEqual(json.ok, false, '错误响应 ok 应为 false');
      assertEqual(json.error.code, 'NOT_FOUND', '错误码');
      assert(!response.text.includes('DEEPSEEK_API_KEY'), '404 响应泄露了配置键名');
      assert(!response.text.includes('resolveApiKey'), '404 响应泄露了 server/config.js 源码片段');
      assert(!response.text.includes('chapter-001'), '404 响应泄露了语料内容');
      return { path: rawPath, status: response.status, code: json.error.code };
    }, { phase: 'traversal' });
  }

  // 明文指向 public/ 之外（server/、data/）的 URL：按契约 §4.6 会回退 index.html，
  // 关键是「只返回前端外壳，绝不返回源码/数据文件内容」。
  for (const [rawPath, label] of [['/server/config.js', '源码目录明文路径'], ['/data/corpus/manifest.json', '数据目录明文路径']]) {
    await results.check(`敏感目录不可读：${label} 只回退 index.html，不泄露文件内容`, async () => {
      const response = await rawRequest(BASE, rawPath);
      assert([200, 404].includes(response.status), `${rawPath} 状态码应 200/404，实际 ${response.status}`);
      const leaked = /DEEPSEEK_API_KEY|resolveApiKey|"books"\s*:\s*\[/.test(response.text);
      assert(!leaked, `${rawPath} 泄露了服务端源码/语料数据`);
      if (response.status === 200) assertContains(response.text, 'id="app"', `${rawPath} 200 时应为 index.html 外壳`);
      return { path: rawPath, status: response.status };
    }, { phase: 'traversal' });
  }

  await results.check('非法路径编码 / NUL 字节 → 400', async () => {
    const badEncoding = await rawRequest(BASE, '/%E0%A4%A');
    assertEqual(badEncoding.status, 400, '非法 URL 编码状态码');
    const nul = await rawRequest(BASE, '/api/%00health');
    assertEqual(nul.status, 400, 'NUL 字节状态码');
    return { badEncoding: badEncoding.status, nul: nul.status };
  }, { phase: 'traversal' });

  /* ------------------------------ 4. manifest ------------------------------ */
  await results.check('GET /api/manifest：7 本、id 顺序 hp1..hp7、章节数符合契约 §3.4', async () => {
    const response = await apiJson(BASE, '/api/manifest');
    assertEqual(response.status, 200, 'manifest HTTP 状态');
    manifest = response.json;
    saveEvidence('manifest.json', manifest);
    assert(manifest && Array.isArray(manifest.books), 'manifest.books 应为数组');
    assertEqual(manifest.books.length, 7, '书目数量');
    assertEqual(manifest.version, 1, 'manifest.version');
    const expectedChapters = { hp1: 17, hp2: 18, hp3: 22, hp4: 37, hp5: 38, hp6: 30, hp7: 37 };
    manifest.books.forEach((book, index) => {
      assertEqual(book.id, `hp${index + 1}`, `第 ${index + 1} 本书 id`);
      assertEqual(book.order, index + 1, `${book.id} order`);
      assert(Array.isArray(book.chapters), `${book.id} chapters 应为数组`);
      assertEqual(book.chapters.length, expectedChapters[book.id], `${book.id} 章节数`);
      book.chapters.forEach((chapter, chapterIndex) => {
        assertEqual(chapter.index, chapterIndex + 1, `${book.id} 章序号连续性`);
        assert(typeof chapter.file === 'string' && !chapter.file.includes('\\'), `${book.id}/${chapter.index} file 应使用正斜杠`);
        assert(Number.isFinite(Number(chapter.sentenceCount)) && chapter.sentenceCount > 0, `${book.id}/${chapter.index} sentenceCount`);
      });
    });
    const totalChapters = manifest.books.reduce((sum, book) => sum + book.chapters.length, 0);
    const totalSentences = manifest.books.reduce((sum, book) => sum + book.sentenceCount, 0);
    assertEqual(totalChapters, 199, '章节总数');
    assertEqual(totalSentences, 80204, '句子总数（最终语料 80,204 句）');
    return { books: 7, chapters: totalChapters, sentences: totalSentences };
  }, { phase: 'manifest' });

  /* ------------------------------ 5. 章节接口 ------------------------------ */
  await results.check('GET /api/chapters/hp1/1：标题正确、段落结构符合契约 §3.3', async () => {
    const chapter = await getChapter('hp1', 1);
    saveEvidence('chapter-hp1-1.json', chapter);
    assertEqual(chapter.bookId, 'hp1', 'bookId');
    assertEqual(chapter.chapterIndex, 1, 'chapterIndex');
    assertEqual(chapter.title, 'The Boy Who Lived', 'chapter.title');
    assert(Array.isArray(chapter.paragraphs) && chapter.paragraphs.length > 50, `paragraphs 数量异常：${chapter.paragraphs?.length}`);
    const first = chapter.paragraphs[0];
    assertEqual(first.index, 0, '首段 index');
    assert(Array.isArray(first.sentences) && first.sentences.length > 0, '首段 sentences');
    assert(typeof first.sentences[0].text === 'string' && first.sentences[0].text.length > 10, '句 0 text');
    assert(Number.isFinite(first.sentences[0].wordCount), '句 0 wordCount 应为数字');
    chapter.paragraphs.forEach((paragraph, index) => assertEqual(paragraph.index, index, `段落 index 连续性（第 ${index} 段）`));
    return { title: chapter.title, paragraphs: chapter.paragraphs.length };
  }, { phase: 'chapters' });

  await results.check('GET /api/chapters/hp7/37：EPILOGUE / Nineteen Years Later', async () => {
    const chapter = await getChapter('hp7', 37);
    assertEqual(chapter.bookId, 'hp7', 'bookId');
    assertEqual(chapter.chapterIndex, 37, 'chapterIndex');
    assertEqual(chapter.title, 'Nineteen Years Later', 'chapter.title');
    const meta = manifest.books.find((book) => book.id === 'hp7').chapters.find((item) => item.index === 37);
    assertEqual(meta.number, 'EPILOGUE', 'manifest 章号 EPILOGUE');
    assertEqual(meta.title, 'Nineteen Years Later', 'manifest 章标题');
    return { title: chapter.title, paragraphs: chapter.paragraphs.length };
  }, { phase: 'chapters' });

  /* --------------- 6. 不存在 / 非法参数 404 与错误结构 --------------- */
  const notFoundCases = [
    ['/api/chapters/hp1/999', '不存在的章节号'],
    ['/api/chapters/hp1/0', '章节号 0'],
    ['/api/chapters/hp1/-1', '章节号 -1'],
    ['/api/chapters/hp1/abc', '章节号非数字'],
    ['/api/chapters/hp1/1.5', '章节号小数'],
    ['/api/chapters/hp9/1', '不存在的书'],
    ['/api/chapters/evil%20book/1', '非法 bookId'],
    ['/api/chapters', '缺少章节参数'],
    ['/api/chapters/hp1', '缺少章节序号'],
    ['/api/not-exist', '未知 API'],
    ['/api', 'API 根路径'],
  ];
  for (const [rawPath, label] of notFoundCases) {
    await results.check(`404：${label}（${rawPath}）`, async () => {
      const response = await rawRequest(BASE, encodeURI(rawPath) === rawPath ? rawPath : rawPath);
      assertEqual(response.status, 404, `${label} HTTP 状态`);
      let json = null;
      try { json = JSON.parse(response.text); } catch { throw new Error(`响应不是 JSON：${response.text.slice(0, 120)}`); }
      assertEqual(json.ok, false, '错误响应 ok 字段');
      assertEqual(json.error.code, 'NOT_FOUND', '错误码');
      assert(typeof json.error.message === 'string' && json.error.message.trim().length > 0, '缺少中文错误 message');
      return { path: rawPath, status: 404 };
    }, { phase: '404' });
  }

  await results.check('方法不匹配：POST /api/health → 404，GET /api/review → 404', async () => {
    const postHealth = await apiJson(BASE, '/api/health', { method: 'POST', body: {} });
    assertEqual(postHealth.status, 404, 'POST /api/health 状态');
    const getReview = await apiJson(BASE, '/api/review');
    assertEqual(getReview.status, 404, 'GET /api/review 状态');
    return { postHealth: postHealth.status, getReview: getReview.status };
  }, { phase: '404' });

  /* --------------------------- 7. 请求体上限 256KB --------------------------- */
  await results.check('请求体过大（>256KB）→ 413 或 400，拒绝并返回中文错误', async () => {
    const hugeText = 'x'.repeat(300 * 1024);
    const response = await apiJson(BASE, '/api/progress/paragraph', {
      method: 'PUT',
      body: {
        bookId: 'hp1',
        chapterIndex: 1,
        paragraphIndex: 0,
        sentences: [hugeText],
      },
      timeoutMs: 30000,
    });
    assert(response.status === 400 || response.status === 413, `期望 400/413，实际 ${response.status}`);
    let json = null;
    try { json = JSON.parse(response.text); } catch { throw new Error('超限响应不是 JSON'); }
    assertEqual(json.ok, false, '超限响应 ok 字段');
    assert(response.status === 413 || json.error.code === 'BAD_REQUEST', '超限响应错误码');
    assertContains(json.error.message, '过大', '超限提示文案');
    return { status: response.status, code: json.error.code, message: json.error.message };
  }, { phase: 'body-limit' });

  /* --------------------------- 8. 进度读写 --------------------------- */
  await results.check('GET /api/progress：结构符合契约 §4.2', async () => {
    const response = await apiJson(BASE, '/api/progress');
    assertEqual(response.status, 200, 'HTTP 状态');
    const body = response.json;
    assertEqual(body.ok, true, 'ok');
    assertEqual(body.version, 1, 'version');
    assert(body.data && typeof body.data === 'object', 'data 对象');
    assert(body.data.books && typeof body.data.books === 'object', 'data.books 对象');
    assert('updatedAt' in body, 'updatedAt 字段');
    saveEvidence('progress-before-tests.json', body);
    return summarizeProgress(body.data);
  }, { phase: 'progress' });

  // 用已有进度段落做幂等 PUT，验证 summary 百分比计算
  await results.check('PUT /api/progress/paragraph：幂等保存 + summary 百分比与独立计算一致', async () => {
    const progress = await fetchProgress(BASE);
    const entries = iterateParagraphs(progress);
    const target = entries.find((entry) => (entry.record?.sentences || []).some((text) => String(text).trim()))
      || entries[0];
    if (!target) throw new Error('当前进度为空，无法验证 summary（请先在有进度的状态运行）');
    const response = await apiJson(BASE, '/api/progress/paragraph', {
      method: 'PUT',
      body: {
        bookId: target.bookId,
        chapterIndex: target.chapterIndex,
        paragraphIndex: target.paragraphIndex,
        sentences: target.record.sentences,
        starred: Boolean(target.record.starred),
        review: target.record.review ?? null,
      },
    });
    assertEqual(response.status, 200, 'PUT HTTP 状态');
    const body = response.json;
    assertEqual(body.ok, true, 'PUT ok');
    assert(typeof body.updatedAt === 'string', 'PUT updatedAt');
    assert(body.summary && Number.isFinite(body.summary.bookProgress) && Number.isFinite(body.summary.chapterProgress), 'PUT summary 结构');

    // 独立计算（与 server/progress.js 相同口径：分子=非空译文、分母=manifest sentenceCount）
    const book = manifest.books.find((item) => item.id === target.bookId);
    const chapterMeta = book.chapters.find((item) => Number(item.index) === Number(target.chapterIndex));
    let chapterTranslated = 0;
    let bookTranslated = 0;
    for (const entry of entries) {
      const count = (entry.record?.sentences || []).filter((text) => String(text).trim()).length;
      if (entry.bookId === target.bookId) bookTranslated += count;
      if (entry.bookId === target.bookId && Number(entry.chapterIndex) === Number(target.chapterIndex)) chapterTranslated += count;
    }
    const round1 = (value) => Math.round(value * 10) / 10;
    const expectedChapter = round1(Math.min(100, (chapterTranslated / chapterMeta.sentenceCount) * 100));
    const expectedBook = round1(Math.min(100, (bookTranslated / book.sentenceCount) * 100));
    assertEqual(body.summary.chapterProgress, expectedChapter, 'chapterProgress 独立计算对比');
    assertEqual(body.summary.bookProgress, expectedBook, 'bookProgress 独立计算对比');
    const after = await apiJson(BASE, '/api/progress');
    assertEqual(after.status, 200, 'PUT 后 GET 状态');
    const readBack = iterateParagraphs(after.json.data).find((entry) => entry.bookId === target.bookId
      && entry.chapterIndex === target.chapterIndex
      && entry.paragraphIndex === target.paragraphIndex);
    assert(readBack, 'PUT 后未能回读到该段落');
    assertEqual(JSON.stringify(readBack.record.sentences), JSON.stringify(target.record.sentences), 'PUT 回读 sentences 一致');
    return { target: `${target.bookId}/${target.chapterIndex}/${target.paragraphIndex}`, summary: body.summary, expected: { bookProgress: expectedBook, chapterProgress: expectedChapter } };
  }, { phase: 'progress' });

  const invalidProgressCases = [
    [{ bookId: 'hp1', chapterIndex: 1, paragraphIndex: 0 }, '缺少所有可保存字段'],
    [{ bookId: 'hp1', chapterIndex: 1, paragraphIndex: 0, sentences: 'not-an-array' }, 'sentences 非数组'],
    [{ bookId: 'hp1', chapterIndex: 1, paragraphIndex: 0, sentences: ['只有一句'] }, '句数不齐'],
    [{ bookId: 'hp1', chapterIndex: 1, paragraphIndex: 0, starred: 'yes' }, 'starred 非布尔'],
    [{ bookId: 'hp1', chapterIndex: 1, paragraphIndex: 0, review: [] }, 'review 为数组'],
    [{ bookId: 'hp1', chapterIndex: 0, paragraphIndex: 0 }, 'chapterIndex=0'],
    [{ bookId: '', chapterIndex: 1, paragraphIndex: 0 }, 'bookId 空串'],
    [{ bookId: 'hp1', chapterIndex: 1, paragraphIndex: -1 }, 'paragraphIndex=-1'],
  ];
  for (const [body, label] of invalidProgressCases) {
    await results.check(`PUT /api/progress/paragraph 非法参数 → 400：${label}`, async () => {
      const response = await apiJson(BASE, '/api/progress/paragraph', { method: 'PUT', body });
      assertEqual(response.status, 400, `${label} 状态码`);
      let json = null;
      try { json = JSON.parse(response.text); } catch { throw new Error('响应不是 JSON'); }
      assertEqual(json.ok, false, 'ok 字段');
      assertEqual(json.error.code, 'BAD_REQUEST', '错误码');
      return { status: 400 };
    }, { phase: 'progress' });
  }

  await results.check('PUT /api/progress/paragraph：不存在的段落 → 404', async () => {
    const response = await apiJson(BASE, '/api/progress/paragraph', {
      method: 'PUT',
      body: { bookId: 'hp1', chapterIndex: 1, paragraphIndex: 9999, sentences: [] },
    });
    assertEqual(response.status, 404, '不存在的段落状态码');
    return { status: 404 };
  }, { phase: 'progress' });

  await results.check('缺请求体 / 非法 JSON → 400', async () => {
    const noBody = await apiJson(BASE, '/api/progress/paragraph', { method: 'PUT' });
    assertEqual(noBody.status, 400, '缺请求体状态码');
    const badJson = await rawRequest(BASE, '/api/progress/paragraph', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });
    assertEqual(badJson.status, 400, '非法 JSON 状态码');
    return { noBody: noBody.status, badJson: badJson.status };
  }, { phase: 'progress' });

  await results.check('并发 PUT 3 个段落：全部落盘且进度 JSON 结构完好', async () => {
    const chapter = await getChapter('hp1', 1);
    const paragraphIndexes = [10, 11, 12]; // 选未被使用的段落做并发写，结束后由恢复流程清理
    const payloads = paragraphIndexes.map((paragraphIndex, offset) => {
      const sentences = Array.from({ length: chapter.paragraphs[paragraphIndex].sentences.length }, () => `QA并发测试-${paragraphIndex}-${offset}`);
      return { bookId: 'hp1', chapterIndex: 1, paragraphIndex, sentences, starred: false, review: null };
    });
    const responses = await Promise.all(payloads.map((body) => apiJson(BASE, '/api/progress/paragraph', { method: 'PUT', body })));
    responses.forEach((response, index) => assertEqual(response.status, 200, `并发 PUT #${index} 状态码`));
    const after = await fetchProgress(BASE);
    const saved = iterateParagraphs(after).filter((entry) => entry.bookId === 'hp1' && entry.chapterIndex === 1 && paragraphIndexes.includes(entry.paragraphIndex));
    assertEqual(saved.length, paragraphIndexes.length, '并发保存的段落数');
    for (const entry of saved) {
      assert((entry.record.sentences || []).some((text) => String(text).startsWith('QA并发测试-')), `段落 ${entry.paragraphIndex} 内容未落盘`);
    }
    saveEvidence('progress-concurrent-after.json', after);
    return { savedParagraphs: saved.map((entry) => entry.paragraphIndex) };
  }, { phase: 'progress' });

  /* --------------------------- 9. /api/review 参数边界 --------------------------- */
  await results.check('POST /api/review：缺少 translations → 400（不调用 AI）', async () => {
    const response = await apiJson(BASE, '/api/review', {
      method: 'POST',
      body: { bookId: 'hp1', chapterIndex: 1, paragraphIndex: 0 },
    });
    assertEqual(response.status, 400, '状态码');
    assertEqual(response.json.error.code, 'BAD_REQUEST', '错误码');
    assertContains(response.json.error.message, 'translations', '错误 message');
    return { status: 400 };
  }, { phase: 'review' });

  await results.check('POST /api/review：translations 非数组 → 400', async () => {
    const response = await apiJson(BASE, '/api/review', {
      method: 'POST',
      body: { bookId: 'hp1', chapterIndex: 1, paragraphIndex: 0, translations: 'x' },
    });
    assertEqual(response.status, 400, '状态码');
    return { status: 400 };
  }, { phase: 'review' });

  await results.check('POST /api/review：译文句数与原文不齐 → 400（不调用 AI）', async () => {
    const response = await apiJson(BASE, '/api/review', {
      method: 'POST',
      body: { bookId: 'hp1', chapterIndex: 1, paragraphIndex: 0, translations: ['只有一句'] },
    });
    assertEqual(response.status, 400, '状态码');
    assertContains(response.json.error.message, '句数', '错误 message 应提到句数');
    return { status: 400, message: response.json.error.message };
  }, { phase: 'review' });

  await results.check('POST /api/review：不存在的段落 → 404（不调用 AI）', async () => {
    const response = await apiJson(BASE, '/api/review', {
      method: 'POST',
      body: { bookId: 'hp1', chapterIndex: 1, paragraphIndex: 9999, translations: [] },
    });
    assertEqual(response.status, 404, '状态码');
    assertEqual(response.json.error.code, 'NOT_FOUND', '错误码');
    return { status: 404 };
  }, { phase: 'review' });

  /* --------------------------- 10. /api/word 真实调用一次 --------------------------- */
  if (NO_AI) {
    results.pass('/api/word 真实调用（--no-ai 跳过）', { skipped: true }, { phase: 'word' });
  } else {
    await results.check('/api/word：真实调用一次，返回结构化词条', async () => {
      const chapter = await getChapter('hp1', 1);
      const sentence = chapter.paragraphs[0].sentences[0].text;
      const paragraph = chapter.paragraphs[0].sentences.map((item) => item.text).join(' ');
      const startedAt = Date.now();
      const response = await apiJson(BASE, '/api/word', {
        method: 'POST',
        body: { word: 'privet', sentence, paragraph },
        timeoutMs: 150000,
      });
      const elapsedMs = Date.now() - startedAt;
      saveEvidence('word-response.json', { status: response.status, elapsedMs, body: response.json });
      assertEqual(response.status, 200, `HTTP 状态（耗时 ${elapsedMs}ms，响应：${response.text.slice(0, 300)}）`);
      const body = response.json;
      assertEqual(body.ok, true, 'ok');
      assert(body.entry && typeof body.entry === 'object', 'entry 对象');
      assertEqual(String(body.entry.word).toLowerCase(), 'privet', 'entry.word');
      assert(Array.isArray(body.entry.meanings) && body.entry.meanings.length >= 1, 'entry.meanings 非空数组');
      body.entry.meanings.forEach((meaning, index) => {
        assert(typeof meaning.cn === 'string' && meaning.cn.trim(), `meanings[${index}].cn`);
      });
      assert(typeof body.entry.explanation === 'string' && body.entry.explanation.trim(), 'entry.explanation');
      assert(Array.isArray(body.entry.examples) && body.entry.examples.length >= 1, 'entry.examples');
      assert(body.meta && Number.isFinite(body.meta.elapsedMs), 'meta.elapsedMs');
      return { elapsedMs, model: body.meta.model, meanings: body.entry.meanings.length };
    }, { phase: 'word' });
  }

  /* ------------------- 11. 数据一致性：磁盘语料 vs 运行服务 ------------------- */
  const corpusDir = path.resolve('data/corpus');
  const diskManifest = JSON.parse(readFileSync(path.join(corpusDir, 'manifest.json'), 'utf8'));
  saveEvidence('manifest-disk.json', diskManifest);

  await results.check('数据一致性（磁盘）：199 个章文件统计（段落数/句子数/标题）与 manifest.json 完全一致', async () => {
    const mismatches = [];
    let totalSentences = 0;
    let totalParagraphs = 0;
    for (const book of diskManifest.books) {
      let bookSentences = 0;
      let bookParagraphs = 0;
      for (const chapterMeta of book.chapters) {
        const chapter = JSON.parse(readFileSync(path.join(corpusDir, chapterMeta.file), 'utf8'));
        if (chapter.title !== chapterMeta.title) mismatches.push(`${book.id}/${chapterMeta.index} 标题不一致`);
        if (chapter.bookId !== book.id) mismatches.push(`${book.id}/${chapterMeta.index} bookId 不一致`);
        if (Number(chapter.chapterIndex) !== Number(chapterMeta.index)) mismatches.push(`${book.id}/${chapterMeta.index} chapterIndex 不一致`);
        const paragraphs = chapter.paragraphs || [];
        if (paragraphs.length !== chapterMeta.paragraphCount) mismatches.push(`${book.id}/${chapterMeta.index} 段落数 ${paragraphs.length} != manifest ${chapterMeta.paragraphCount}`);
        let sentenceTotal = 0;
        paragraphs.forEach((paragraph, index) => {
          if (paragraph.index !== index) mismatches.push(`${book.id}/${chapterMeta.index} 段落 index 不连续`);
          sentenceTotal += paragraph.sentences.length;
          for (const sentence of paragraph.sentences) {
            if (typeof sentence.text !== 'string' || !sentence.text.trim()) mismatches.push(`${book.id}/${chapterMeta.index} 存在空句子`);
            if (/[\r\n]/.test(sentence.text)) mismatches.push(`${book.id}/${chapterMeta.index} 句子内含换行`);
            if (sentence.text.includes('  ')) mismatches.push(`${book.id}/${chapterMeta.index} 句子内含双空格`);
            if (sentence.text.includes('\u0091')) mismatches.push(`${book.id}/${chapterMeta.index} 句子含 \\x91 残留`);
          }
        });
        if (sentenceTotal !== chapterMeta.sentenceCount) mismatches.push(`${book.id}/${chapterMeta.index} 句子数 ${sentenceTotal} != manifest ${chapterMeta.sentenceCount}`);
        bookSentences += sentenceTotal;
        bookParagraphs += paragraphs.length;
      }
      if (bookSentences !== book.sentenceCount) mismatches.push(`${book.id} 全书句子数 ${bookSentences} != manifest ${book.sentenceCount}`);
      if (bookParagraphs !== book.paragraphCount) mismatches.push(`${book.id} 全书段落数 ${bookParagraphs} != manifest ${book.paragraphCount}`);
      totalSentences += bookSentences;
      totalParagraphs += bookParagraphs;
    }
    const summary = { chapters: 199, sentences: totalSentences, paragraphs: totalParagraphs, mismatchCount: mismatches.length, mismatches: mismatches.slice(0, 50) };
    saveEvidence('corpus-disk-consistency.json', summary);
    assertEqual(mismatches.length, 0, `磁盘语料一致性不匹配（前 5 项）：${mismatches.slice(0, 5).join('；')}`);
    assertEqual(totalSentences, 80204, '磁盘语料句子总数（80,204）');
    assertEqual(totalParagraphs, 37852, '磁盘语料段落总数（37,852）');
    return summary;
  }, { phase: 'consistency' });

  await results.check('数据一致性（运行态）：GET /api/manifest 与磁盘 manifest.json 一致（防止服务缓存旧语料）', async () => {
    const response = await apiJson(BASE, '/api/manifest');
    assertEqual(response.status, 200, 'manifest HTTP 状态');
    const served = response.json;
    saveEvidence('manifest-served.json', served);
    const diffs = [];
    const servedByBook = new Map((served.books || []).map((book) => [book.id, book]));
    for (const diskBook of diskManifest.books) {
      const servedBook = servedByBook.get(diskBook.id);
      if (!servedBook) { diffs.push(`${diskBook.id} 服务端缺失`); continue; }
      for (const field of ['sentenceCount', 'paragraphCount', 'wordCount']) {
        if (servedBook[field] !== diskBook[field]) diffs.push(`${diskBook.id}.${field} 磁盘=${diskBook[field]} 服务端=${servedBook[field]}`);
      }
      const servedChapters = new Map((servedBook.chapters || []).map((chapter) => [Number(chapter.index), chapter]));
      for (const diskChapter of diskBook.chapters) {
        const servedChapter = servedChapters.get(Number(diskChapter.index));
        if (!servedChapter) { diffs.push(`${diskBook.id}/${diskChapter.index} 服务端缺失`); continue; }
        for (const field of ['paragraphCount', 'sentenceCount', 'title']) {
          if (JSON.stringify(servedChapter[field]) !== JSON.stringify(diskChapter[field])) {
            diffs.push(`${diskBook.id}/${diskChapter.index}.${field} 磁盘=${JSON.stringify(diskChapter[field])} 服务端=${JSON.stringify(servedChapter[field])}`);
          }
        }
      }
    }
    saveEvidence('manifest-served-vs-disk-diff.json', { diffCount: diffs.length, diffs: diffs.slice(0, 80) });
    assertEqual(diffs.length, 0, `运行中服务缓存了旧 manifest：${diffs.length} 处不一致（需重启服务加载磁盘最新语料）。前 6 项：${diffs.slice(0, 6).join('；')}`);
    return { diffCount: 0, sentences: served.books.reduce((sum, book) => sum + book.sentenceCount, 0) };
  }, { phase: 'consistency' });

  /* --------------------- 12. 进度与 manifest 章节/句子统计一致 --------------------- */
  await results.check('数据一致性：进度中的 book/chapter/paragraph 索引都存在于 manifest 与章文件', async () => {
    const progress = await fetchProgress(BASE);
    for (const entry of iterateParagraphs(progress)) {
      const chapter = await getChapter(entry.bookId, entry.chapterIndex);
      const paragraph = chapter.paragraphs.find((item) => Number(item.index) === Number(entry.paragraphIndex));
      assert(paragraph, `进度段落不存在：${entry.bookId}/${entry.chapterIndex}/${entry.paragraphIndex}`);
      assertEqual(entry.record.sentences.length, paragraph.sentences.length, `进度 ${entry.bookId}/${entry.chapterIndex}/${entry.paragraphIndex} 译文句数与原文不齐`);
    }
    return { checkedParagraphs: iterateParagraphs(progress).length };
  }, { phase: 'consistency' });

  /* ------------------------------ 汇总输出 ------------------------------ */
  const summary = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE,
    total: results.checks.length,
    passed: results.passed.length,
    failed: results.failed.length,
    checks: results.checks,
    evidenceFiles,
  };
  const outFile = path.join(QA_DIR, 'api-results.json');
  writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  console.log(`\n=== 黑盒 API 结果：${summary.passed}/${summary.total} PASS，${summary.failed} FAIL ===`);
  for (const entry of results.checks) {
    const mark = entry.status === 'PASS' ? 'PASS' : 'FAIL';
    console.log(`[${mark}] ${entry.phase} | ${entry.name}${entry.status === 'FAIL' ? `\n        → ${entry.detail}` : ''}`);
  }
  console.log(`\n结果文件：${outFile}`);
  if (summary.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('黑盒测试脚本异常：', error);
  process.exitCode = 1;
});
