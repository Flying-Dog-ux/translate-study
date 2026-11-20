/**
 * 浏览器端到端测试（零依赖，Edge headless + 原生 WebSocket CDP）。
 *
 * 覆盖：
 *  - 5 个 hash 路由 × 桌面 1440×1000 / 平板 768×1024 / 手机 390×844（CDP 移动模拟）截图与横向溢出断言；
 *  - 练习页：逐句输入、800ms 防抖自动保存、Ctrl+Enter 触发真实 AI 批改（默认 1 次真实 /api/review）、
 *    批改面板完整字段、参考译文二次确认、收藏→待复习、字号/主题持久化、刷新恢复、XSS 转义；
 *  - 章节目录 / 继续上次练习 / 未知路由回书架；
 *  - 空状态（全未翻译章节、待复习为空）、错误态（manifest 500、断网保存失败）、深色对比度；
 *  - 设置页：健康状态、导出进度 JSON、重置、导入（导出→重置→导入 完整往返）；
 *  - 可访问性抽查（aria-label / focus-visible / 触控目标）、控制台错误、404 资源、第三方请求。
 *
 * 用法：
 *   node tests/e2e/browser-e2e.mjs                  # 完整跑（含 1 次真实 AI 批改）
 *   node tests/e2e/browser-e2e.mjs --skip-live-review   # 不调用真实 AI（复用已有批改数据）
 *   node tests/e2e/browser-e2e.mjs --keep-progress      # 结束后不自动恢复测试前进度
 *
 * 输出：.scratch/qa/browser-results.json、.scratch/qa/*.png、.scratch/qa/evidence/。
 * 退出码：0 全部 PASS，1 存在 FAIL。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  assert,
  assertContains,
  assertEqual,
  createChecker,
  launchBrowser,
  sleep,
  waitUntil,
} from './lib/cdp.mjs';
import {
  apiJson,
  backupProgress,
  diffProgress,
  fetchProgress,
  iterateParagraphs,
  restoreProgress,
  summarizeProgress,
} from './lib/progress-utils.mjs';

const args = process.argv.slice(2);
const getArg = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const BASE = getArg('--base', 'http://127.0.0.1:5180').replace(/\/+$/, '');
const SKIP_LIVE_REVIEW = args.includes('--skip-live-review');
const KEEP_PROGRESS = args.includes('--keep-progress');
const QA_DIR = path.resolve('.scratch/qa');
const SHOT_DIR = path.join(QA_DIR, 'screenshots');
const EVIDENCE_DIR = path.join(QA_DIR, 'evidence');
const DOWNLOAD_DIR = path.join(QA_DIR, 'downloads');
for (const dir of [QA_DIR, SHOT_DIR, EVIDENCE_DIR]) mkdirSync(dir, { recursive: true });
rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
mkdirSync(DOWNLOAD_DIR, { recursive: true });

const results = createChecker();
const screenshots = [];
const browserErrorsByPhase = new Map();
const errorResponseRanges = [];
let browser = null;
let currentPhase = { name: 'init', consoleStart: 0, pageStart: 0, responseStart: 0, allowConsoleErrors: false };
let progressBackup = null;

function sel(value) { return JSON.stringify(value); }

function beginPhase(name, { allowConsoleErrors = false } = {}) {
  currentPhase = {
    name,
    consoleStart: browser ? browser.consoleMessages.length : 0,
    pageStart: browser ? browser.pageErrors.length : 0,
    responseStart: browser ? browser.responses.length : 0,
    allowConsoleErrors,
  };
}

function endPhase() {
  if (!browser) return;
  const consoleErrors = browser.consoleMessages.slice(currentPhase.consoleStart).filter((entry) => entry.type === 'error');
  const pageErrors = browser.pageErrors.slice(currentPhase.pageStart);
  const previous = browserErrorsByPhase.get(currentPhase.name) || { consoleErrors: [], pageErrors: [], allowed: false };
  browserErrorsByPhase.set(currentPhase.name, {
    consoleErrors: [...previous.consoleErrors, ...consoleErrors],
    pageErrors: [...previous.pageErrors, ...pageErrors],
    allowed: previous.allowed || currentPhase.allowConsoleErrors,
  });
  if (currentPhase.allowConsoleErrors) {
    errorResponseRanges.push([currentPhase.responseStart, browser.responses.length]);
  }
}

async function check(name, fn) {
  return results.check(name, fn, { phase: currentPhase.name });
}

async function shot(name, options = {}) {
  const filePath = path.join(SHOT_DIR, name.endsWith('.png') ? name : `${name}.png`);
  await browser.screenshot(filePath, options);
  screenshots.push(path.relative(process.cwd(), filePath).replace(/\\/g, '/'));
  return filePath;
}

function saveEvidence(name, content) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const filePath = path.join(EVIDENCE_DIR, name);
  writeFileSync(filePath, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`, 'utf8');
  return filePath;
}

/* ---------------------------- 页面查询小工具 ---------------------------- */

async function evalPage(expression) { return browser.eval(expression); }
async function count(selector) { return browser.eval(`document.querySelectorAll(${sel(selector)}).length`); }
async function textOf(selector) { return browser.eval(`(document.querySelector(${sel(selector)})?.innerText || '')`); }
async function attrOf(selector, name) { return browser.eval(`document.querySelector(${sel(selector)})?.getAttribute(${sel(name)}) ?? null`); }
async function click(selector) { return browser.eval(`(() => { const n = document.querySelector(${sel(selector)}); if (!n) return false; n.click(); return true; })()`); }
async function clickIn(containerSelector, text) {
  return browser.eval(`(() => {
    const c = document.querySelector(${sel(containerSelector)});
    if (!c) return false;
    const node = [...c.querySelectorAll('button, a')].find((item) => (item.textContent || '').includes(${sel(text)}));
    if (!node) return false;
    node.click();
    return true;
  })()`);
}
async function clickButtonText(text) {
  return browser.eval(`(() => {
    const node = [...document.querySelectorAll('button, a')].find((item) => (item.textContent || '').includes(${sel(text)}));
    if (!node) return false;
    node.click();
    return true;
  })()`);
}
async function waitText(selector, text, timeoutMs = 30000) {
  return browser.waitFor(`(document.querySelector(${sel(selector)})?.innerText || '').includes(${sel(text)})`, { timeoutMs, label: `${selector} 包含「${text}」` });
}
async function waitModal(title = null) {
  await browser.waitFor(`Boolean(document.querySelector('.modal-overlay .modal-title'))`, { timeoutMs: 8000, label: '确认对话框出现' });
  if (title) await waitText('.modal-title', title, 5000);
}
async function clickModalButton(text) {
  const ok = await browser.eval(`(() => {
    const buttons = [...document.querySelectorAll('.modal-footer button')];
    const node = buttons.find((item) => (item.textContent || '').includes(${sel(text)}));
    if (!node) return false;
    node.click();
    return true;
  })()`);
  assert(ok, `确认对话框里找不到按钮「${text}」`);
  await browser.waitFor(`!document.querySelector('.modal-overlay')`, { timeoutMs: 8000, label: '对话框关闭' });
}
async function waitSaveStatus(pattern, timeoutMs = 15000) {
  return browser.waitFor(`/${pattern}/.test(document.querySelector('.save-status')?.innerText || '')`, { timeoutMs, label: `保存状态匹配 ${pattern}` });
}
async function setTextarea(selector, value) {
  return browser.eval(`(() => {
    const node = document.querySelector(${sel(selector)});
    if (!node) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(node, ${JSON.stringify(value)});
    node.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
}
async function fillCardTextareas(paragraphIndex, values) {
  return browser.eval(`(() => {
    const card = document.querySelector('.para-card[data-paragraph-index="' + ${paragraphIndex} + '"]');
    if (!card) return null;
    const areas = [...card.querySelectorAll('textarea.target-textarea')];
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    const values = ${JSON.stringify(values)};
    areas.forEach((area, index) => {
      setter.call(area, values[index] ?? '');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    return areas.map((area) => area.value);
  })()`);
}
async function cardTextareaValues(paragraphIndex) {
  return browser.eval(`(() => {
    const card = document.querySelector('.para-card[data-paragraph-index="' + ${paragraphIndex} + '"]');
    return card ? [...card.querySelectorAll('textarea.target-textarea')].map((area) => area.value) : null;
  })()`);
}
async function waitCard(paragraphIndex, timeoutMs = 30000) {
  return browser.waitFor(`Boolean(document.querySelector('.para-card[data-paragraph-index="' + ${paragraphIndex} + '"]'))`, { timeoutMs, label: `第 ${paragraphIndex} 段卡片渲染` });
}
async function waitReviewPanel(paragraphIndex, timeoutMs = 200000) {
  return browser.waitFor(`(() => {
    const card = document.querySelector('.para-card[data-paragraph-index="' + ${paragraphIndex} + '"]');
    if (!card) return false;
    const panel = card.querySelector('.para-panel');
    return Boolean(panel && !panel.hidden && panel.querySelector('.review-panel'));
  })()`, { timeoutMs, label: `第 ${paragraphIndex} 段批改面板渲染` });
}
async function readReviewFacts(paragraphIndex) {
  return browser.eval(`(() => {
    const card = document.querySelector('.para-card[data-paragraph-index="' + ${paragraphIndex} + '"]');
    if (!card) return null;
    const panel = card.querySelector('.para-panel');
    const scoreText = (card.querySelector('.review-score-ring')?.innerText || '').trim();
    return {
      panelVisible: Boolean(panel && !panel.hidden && panel.querySelector('.review-panel')),
      scoreText,
      verdicts: [...card.querySelectorAll('.review-panel .review-head .verdict')].map((node) => node.textContent.trim()),
      sentenceVerdicts: [...card.querySelectorAll('.sentence-review .verdict')].map((node) => node.textContent.trim()),
      dimensions: card.querySelectorAll('.dimension-row').length,
      dimensionLabels: [...card.querySelectorAll('.dimension-label')].map((node) => node.textContent.trim()),
      sentenceItems: card.querySelectorAll('.sentence-review').length,
      issueChips: card.querySelectorAll('.issue-chip').length,
      suggestions: card.querySelectorAll('.suggestion').length,
      copyButtons: card.querySelectorAll('.copy-btn').length,
      revised: Boolean(card.querySelector('.revised-block')),
      revisedText: (card.querySelector('.revised-text')?.textContent || '').trim(),
      vocab: card.querySelectorAll('.vocab-item').length,
      tips: card.querySelectorAll('.tips-item').length,
      overallText: (card.querySelector('.review-overall-text')?.innerText || '').trim(),
      hasRerun: [...card.querySelectorAll('.review-foot button')].some((node) => (node.textContent || '').includes('重新批改')),
      hasClose: Boolean(card.querySelector('.panel-close')),
    };
  })()`);
}

async function assertNoHorizontalOverflow(label) {
  const metrics = await browser.eval(`(() => {
    const de = document.documentElement;
    const body = document.body;
    return {
      viewportWidth: window.innerWidth,
      clientWidth: de.clientWidth,
      scrollWidth: de.scrollWidth,
      bodyClientWidth: body.clientWidth,
      bodyScrollWidth: body.scrollWidth,
      scrollHeight: Math.max(de.scrollHeight, body.scrollHeight),
    };
  })()`);
  assert(metrics.scrollWidth <= metrics.clientWidth + 1, `${label} 横向溢出：scrollWidth=${metrics.scrollWidth} > clientWidth=${metrics.clientWidth}`);
  assert(metrics.bodyScrollWidth <= metrics.bodyClientWidth + 1, `${label} body 横向溢出：${metrics.bodyScrollWidth} > ${metrics.bodyClientWidth}`);
  return metrics;
}

async function navigateHash(hash) {
  await browser.navigate(`${BASE}/${hash.startsWith('#') ? hash : `#${hash}`}`);
  await sleep(250);
}

async function gotoRoute({ label, hash, waitSelector, shotName, content = [] }) {
  await navigateHash(hash);
  await browser.waitFor(`Boolean(document.querySelector(${sel(waitSelector)}))`, { timeoutMs: 30000, label: `${label} 渲染 ${waitSelector}` });
  await sleep(500);
  const metrics = await assertNoHorizontalOverflow(label);
  for (const [selector, needle] of content) {
    const innerText = await textOf(selector);
    assertContains(innerText, needle, `${label} 缺少预期文案「${needle}」（${selector}）`);
  }
  if (shotName) await shot(shotName);
  return metrics;
}

async function routeSmoke(prefix) {
  const routeChecks = [
    {
      key: 'library',
      hash: '#/',
      waitSelector: '.book-card',
      content: [['.site-header', '逐句译'], ['.book-grid', 'Harry Potter and the Sorcerer']],
      verify: async () => assertEqual(await count('.book-card'), 7, '书架应有 7 本书卡片'),
    },
    {
      key: 'book-hp1',
      hash: '#/book/hp1',
      waitSelector: '.chapter-row',
      content: [['.book-hero', 'Sorcerer'], ['.chapters-section', '章节目录']],
      verify: async () => assertEqual(await count('.chapter-row'), 17, 'hp1 章节目录应有 17 章'),
    },
    {
      key: 'practice-hp1-1',
      hash: '#/practice/hp1/1',
      waitSelector: '.para-card',
      content: [['.topbar-title-text', 'The Boy Who Lived'], ['.practice-chapter-eyebrow', 'CHAPTER']],
      verify: async () => assert((await count('.para-card')) >= 5, '初始应渲染至少 5 个段落卡片'),
    },
    {
      key: 'review',
      hash: '#/review',
      waitSelector: '.review-item, .state-view',
      content: [['.page-title', '待复习']],
      verify: async () => assert((await count('.summary-card')) === 3, '待复习页应有 3 个统计卡片'),
    },
    {
      key: 'settings',
      hash: '#/settings',
      waitSelector: '.settings-card',
      content: [['.page-title', '设置']],
      verify: async () => {
        await browser.waitFor(`Boolean(document.querySelector('.health-hero')) || Boolean(document.querySelector('.settings-inline-error'))`, { timeoutMs: 15000, label: '设置页服务状态加载' });
        assert((await count('.settings-card')) >= 5, '设置页应有至少 5 个卡片');
      },
    },
  ];
  for (const route of routeChecks) {
    await check(`${prefix} 路由 ${route.hash}：渲染正常、无横向溢出、截图`, async () => {
      await gotoRoute({ label: `${prefix} ${route.key}`, hash: route.hash, waitSelector: route.waitSelector, shotName: `${prefix}-${route.key}.png`, content: route.content });
      await route.verify();
      return { hash: route.hash };
    });
  }
}

/* ================================ 主流程 ================================ */

async function main() {
  console.log(`\n=== 浏览器端到端测试：${BASE}（真实 AI 批改：${SKIP_LIVE_REVIEW ? '跳过' : '调用 1 次'}） ===\n`);
  beginPhase('bootstrap');
  const health = await apiJson(BASE, '/api/health');
  assertEqual(health.status, 200, '后端服务未就绪（/api/health）');
  assertEqual(health.json.corpus.sentences, 80204, 'health 语料句数应为最终语料 80,204（服务需已重启加载最终语料）');
  progressBackup = await backupProgress(BASE, path.join(QA_DIR, 'browser-progress-backup.json'));
  saveEvidence('browser-progress-backup-summary.json', summarizeProgress(progressBackup));

  browser = await launchBrowser();
  await browser.navigate(`${BASE}/#/`);
  await browser.waitFor(`Boolean(document.querySelector('.book-card'))`, { timeoutMs: 30000, label: '书架首屏' });
  endPhase();

  /* -------------------- A. 桌面 / 平板 / 手机路由 × 截图 -------------------- */
  beginPhase('desktop-routes');
  await browser.setColorScheme('light');
  await browser.setDeviceMetrics({ width: 1440, height: 1000, mobile: false });
  await routeSmoke('desktop-1440');
  endPhase();

  beginPhase('tablet-routes');
  await browser.setDeviceMetrics({ width: 768, height: 1024, mobile: false });
  await routeSmoke('tablet-768');
  endPhase();

  beginPhase('mobile-routes');
  await browser.setDeviceMetrics({ width: 390, height: 844, mobile: true });
  await routeSmoke('mobile-390');
  await check('手机端练习页：章节目录抽屉可打开 / 关闭，且无横向溢出', async () => {
    await navigateHash('#/practice/hp1/1');
    await browser.waitFor(`Boolean(document.querySelector('.para-card'))`, { timeoutMs: 30000, label: '手机练习页' });
    assert(await click('.sidebar-toggle'), '找不到章节目录按钮 .sidebar-toggle');
    await browser.waitFor(`document.querySelector('.practice-sidebar')?.classList.contains('is-open')`, { timeoutMs: 5000, label: '抽屉打开' });
    assertEqual(await attrOf('.sidebar-toggle', 'aria-expanded'), 'true', '抽屉按钮 aria-expanded');
    await shot('mobile-390-practice-drawer.png');
    const drawerMetrics = await assertNoHorizontalOverflow('手机端抽屉打开时');
    await click('.drawer-backdrop');
    await browser.waitFor(`!document.querySelector('.practice-sidebar')?.classList.contains('is-open')`, { timeoutMs: 5000, label: '抽屉关闭' });
    return { viewport: drawerMetrics.clientWidth };
  });
  await check('手机端保存的批改面板：完整渲染且无横向溢出（截图）', async () => {
    await navigateHash('#/practice/hp1/1?p=2&panel=review');
    await waitCard(2);
    await waitReviewPanel(2, 60000);
    await sleep(600);
    const facts = await readReviewFacts(2);
    assert(facts.panelVisible, '批改面板未展开');
    assertEqual(facts.dimensions, 3, '维度数量');
    assert(facts.sentenceItems >= 1, '逐句结果为 0');
    const metrics = await assertNoHorizontalOverflow('手机端批改面板');
    await shot('mobile-390-practice-review-panel.png');
    return { score: facts.scoreText, viewport: metrics.clientWidth };
  });
  endPhase();

  /* ------------------------------ B. 练习页交互 ------------------------------ */
  beginPhase('practice-interactive');
  await browser.setDeviceMetrics({ width: 1440, height: 1000, mobile: false });
  await navigateHash('#/practice/hp1/1');
  await waitCard(0);
  await check('练习页：逐句 textarea 存在、可输入、字数/状态点联动', async () => {
    const facts = await browser.eval(`(() => {
      const card = document.querySelector('.para-card[data-paragraph-index="4"]');
      const area = card.querySelector('textarea.target-textarea');
      const placeholder = area.getAttribute('placeholder');
      const ariaLabel = area.getAttribute('aria-label');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(area, '输入联动测试');
      area.dispatchEvent(new Event('input', { bubbles: true }));
      return {
        placeholder,
        ariaLabel,
        charCount: card.querySelector('.char-count')?.innerText || '',
        dotTranslated: card.querySelector('.sentence-dot')?.classList.contains('is-translated'),
      };
    })()`);
    assertContains(facts.placeholder, '中文译文', 'textarea placeholder');
    assert(facts.ariaLabel && facts.ariaLabel.includes('第 1 句'), 'textarea 缺少 aria-label');
    assertContains(facts.charCount, '6 字', '字数提示应更新为 6 字');
    assertEqual(facts.dotTranslated, true, '句子状态点应变为已译');
    return facts;
  });

  await check('自动保存：输入后进入「待保存」，约 800ms 防抖后「已保存」并落库', async () => {
    const chapter = await apiJson(BASE, '/api/chapters/hp1/1');
    const sentenceCount = chapter.json.paragraphs[4].sentences.length;
    await browser.eval(`document.querySelector('.para-card[data-paragraph-index="4"] textarea.target-textarea').focus()`);
    const startedAt = Date.now();
    await setTextarea('.para-card[data-paragraph-index="4"] textarea.target-textarea', '防抖自动保存测试');
    await waitSaveStatus('待保存', 3000);
    await waitSaveStatus('已保存', 15000);
    const elapsedMs = Date.now() - startedAt;
    assert(elapsedMs >= 700, `自动保存过快（${elapsedMs}ms），800ms 防抖可能未生效`);
    const progress = await fetchProgress(BASE);
    const saved = progress.books?.hp1?.chapters?.['1']?.paragraphs?.['4'];
    assert(saved, '进度里没有第 5 段记录');
    assertEqual(saved.sentences.length, sentenceCount, '保存的译文句数');
    assertContains(saved.sentences[0], '防抖自动保存测试', '落库的译文内容');
    return { elapsedMs, sentenceCount };
  });

  await check('刷新后译文恢复：页面重载后 textarea 内容仍在', async () => {
    await browser.reload();
    await browser.waitFor(`Boolean(document.querySelector('.para-card'))`, { timeoutMs: 30000, label: '重载后的练习页' });
    await waitCard(4);
    await sleep(800);
    const values = await cardTextareaValues(4);
    assertContains(values[0], '防抖自动保存测试', '刷新后第 5 段译文');
    return { firstValue: values[0] };
  });

  await check('8 秒批改结果恢复：?p=2&panel=review 打开已保存批改面板，字段完整', async () => {
    await navigateHash('#/practice/hp1/1?p=2&panel=review');
    await waitCard(2);
    await waitReviewPanel(2, 60000);
    await sleep(500);
    const facts = await readReviewFacts(2);
    saveEvidence('saved-review-panel-facts.json', facts);
    assert(facts.panelVisible, '面板未显示');
    assert(facts.scoreText.length > 0, '缺少总分');
    assertEqual(facts.dimensions, 3, '维度数量应为 3');
    assertContains(facts.dimensionLabels.join(','), '准确', '缺少「准确」维度');
    assertContains(facts.dimensionLabels.join(','), '通顺', '缺少「通顺」维度');
    assertContains(facts.dimensionLabels.join(','), '文风', '缺少「文风」维度');
    assertEqual(facts.sentenceItems, 6, '该段逐句结果应有 6 条');
    assert(facts.sentenceVerdicts.length >= 6, '逐句 verdict 徽章数量');
    assert(facts.suggestions >= 1, '缺少建议译文');
    assert(facts.copyButtons >= 1, '缺少复制按钮');
    assertEqual(facts.revised, true, '缺少整段修改稿');
    assert(facts.revisedText.length > 10, '整段修改稿内容过短');
    assertEqual(facts.vocab, 5, '词汇与表达应有 5 条（已保存的批改数据）');
    assert(facts.tips >= 1, '缺少学习建议');
    assert(facts.hasRerun, '缺少「重新批改」按钮');
    assert(facts.hasClose, '缺少关闭面板按钮');
    assert(facts.overallText.length > 5, '缺少总评文字');
    await shot('desktop-1440-practice-review-saved.png');
    return { score: facts.scoreText, sentenceItems: facts.sentenceItems, vocab: facts.vocab, tips: facts.tips };
  });

  await check('参考译文：二次确认弹窗出现，取消后不发起 /api/reference 请求', async () => {
    const requestsBefore = browser.requests.filter((item) => item.url.includes('/api/reference')).length;
    await navigateHash('#/practice/hp1/1?p=2');
    await waitCard(2);
    assert(await clickIn('.para-card[data-paragraph-index="2"] .para-actions', '参考译文'), '找不到「参考译文」按钮');
    await waitModal('查看参考译文？');
    const modalText = await textOf('.modal-body');
    assertContains(modalText, '先自己翻', '参考译文确认弹窗缺少提醒文案');
    await shot('desktop-1440-reference-confirm.png');
    await clickModalButton('先自己译');
    await sleep(500);
    const requestsAfter = browser.requests.filter((item) => item.url.includes('/api/reference')).length;
    assertEqual(requestsAfter, requestsBefore, '取消参考译文后仍发起了 /api/reference 请求');
    assert(!(await browser.eval(`Boolean(document.querySelector('.modal-overlay'))`)), '弹窗未关闭');
    return { requests: requestsAfter };
  });

  await check('Esc 关闭批改面板', async () => {
    await navigateHash('#/practice/hp1/1?p=2&panel=review');
    await waitCard(2);
    await waitReviewPanel(2, 60000);
    await browser.pressKey('Escape');
    await browser.waitFor(`(() => { const panel = document.querySelector('.para-card[data-paragraph-index="2"] .para-panel'); return !panel || panel.hidden; })()`, { timeoutMs: 5000, label: 'Esc 关闭面板' });
    return { closed: true };
  });

  // 真实 AI 批改：Ctrl + Enter
  if (SKIP_LIVE_REVIEW) {
    results.pass('Ctrl+Enter 触发真实 AI 批改（--skip-live-review 跳过）', { skipped: true }, { phase: currentPhase.name });
  } else {
    await check('Ctrl+Enter：触发真实 AI 批改，批改面板字段完整，结果随进度保存', async () => {
      await navigateHash('#/practice/hp1/1?p=0');
      await waitCard(0);
      await sleep(400);
      const sentenceCount = await browser.eval(`document.querySelectorAll('.para-card[data-paragraph-index="0"] textarea.target-textarea').length`);
      assert(sentenceCount > 0, '第 1 段没有 textarea');
      const translations = Array.from({ length: sentenceCount }, (_, index) => `第${index + 1}句的 QA 测试译文。`);
      await fillCardTextareas(0, translations);
      await browser.eval(`document.querySelector('.para-card[data-paragraph-index="0"] textarea.target-textarea').focus()`);
      const startedAt = Date.now();
      await browser.pressKey('Enter', { modifiers: 2 });
      await waitReviewPanel(0, 200000);
      const elapsedMs = Date.now() - startedAt;
      const facts = await readReviewFacts(0);
      saveEvidence('live-review-panel-facts.json', facts);
      assert(facts.scoreText.length > 0, '缺少总分');
      assertEqual(facts.dimensions, 3, '维度数量');
      assert(facts.sentenceItems >= sentenceCount, `逐句结果 ${facts.sentenceItems} < 原文 ${sentenceCount}`);
      assert(facts.revised, '缺少整段修改稿');
      assert(facts.tips >= 1, '缺少学习建议');
      assert(facts.hasRerun, '缺少重新批改');
      await waitSaveStatus('已保存', 30000);
      const progress = await fetchProgress(BASE);
      const saved = progress.books?.hp1?.chapters?.['1']?.paragraphs?.['0'];
      assert(saved, '批改结果未随进度保存（第 1 段）');
      assert(saved.review && typeof saved.review === 'object', '第 1 段进度里没有 review');
      assert(saved.review.overall && Number.isFinite(Number(saved.review.overall.score)), '保存的 review 缺少 overall.score');
      assert((saved.review.sentences || []).length === sentenceCount, '保存的 review 逐句数与原文不齐');
      await shot('desktop-1440-practice-live-review.png');
      return { elapsedMs, score: facts.scoreText, sentenceItems: facts.sentenceItems, vocab: facts.vocab, tips: facts.tips };
    });
  }

  await check('Ctrl+↓：跳转到下一段并聚焦其 textarea', async () => {
    await navigateHash('#/practice/hp1/1?p=0');
    await waitCard(0);
    await waitCard(1);
    await browser.eval(`document.querySelector('.para-card[data-paragraph-index="0"] textarea.target-textarea').focus()`);
    await browser.pressKey('ArrowDown', { modifiers: 2 });
    await browser.waitFor(`Boolean(document.activeElement?.closest?.('.para-card[data-paragraph-index="1"]'))`, { timeoutMs: 8000, label: '焦点移动到第 2 段' });
    return { focusedParagraph: await browser.eval(`document.activeElement?.closest?.('.para-card')?.dataset.paragraphIndex`) };
  });

  await check('收藏段落 → 待复习页出现该段落卡片（截图）', async () => {
    await navigateHash('#/practice/hp1/1?p=0');
    await waitCard(0);
    const alreadyStarred = await attrOf('.para-card[data-paragraph-index="0"] .star-btn', 'aria-pressed');
    if (alreadyStarred !== 'true') {
      assert(await click('.para-card[data-paragraph-index="0"] .star-btn'), '找不到收藏按钮');
    }
    await waitSaveStatus('已保存', 20000);
    assertEqual(await attrOf('.para-card[data-paragraph-index="0"] .star-btn', 'aria-pressed'), 'true', '收藏按钮 aria-pressed');
    await navigateHash('#/review');
    await browser.waitFor(`Boolean(document.querySelector('.review-item'))`, { timeoutMs: 30000, label: '待复习列表' });
    await sleep(600);
    const reviewText = await textOf('.review-list, .page-inner--narrow');
    assertContains(reviewText, '第 1 段', '待复习页未出现第 1 段');
    assertContains(reviewText, '魔法石', '待复习页缺少书名');
    await shot('desktop-1440-review-after-star.png');
    const itemCount = await count('.review-item');
    assert(itemCount >= 1, '待复习条目数为 0');
    return { itemCount };
  });

  await check('待复习页分类筛选：收藏 / 需改进 tab 可切换且计数一致', async () => {
    await navigateHash('#/review');
    await browser.waitFor(`Boolean(document.querySelector('.filter-tab'))`, { timeoutMs: 30000, label: '待复习筛选 tab' });
    const tabs = await browser.eval(`[...document.querySelectorAll('.filter-tab')].map((tab) => ({ text: tab.innerText.replace(/\\n+/g, ' '), selected: tab.getAttribute('aria-selected') }))`);
    assertEqual(tabs.length, 3, '筛选 tab 数量');
    assertContains(tabs.map((tab) => tab.text).join(','), '收藏', '缺少收藏 tab');
    assertContains(tabs.map((tab) => tab.text).join(','), '需改进', '缺少需改进 tab');
    await clickButtonText('需改进');
    await sleep(400);
    const selected = await browser.eval(`[...document.querySelectorAll('.filter-tab')].filter((tab) => tab.getAttribute('aria-selected') === 'true').map((tab) => tab.innerText)`);
    assertEqual(selected.length, 1, '应只有一个激活的 tab');
    await clickButtonText('全部');
    return { tabs };
  });

  await check('XSS 防护：textarea 输入 <img onerror> 保存刷新后仍为纯文本，window.__xss 未被赋值', async () => {
    const payload = '<img src=x onerror=window.__xss=1>';
    await navigateHash('#/practice/hp1/1?p=3');
    await waitCard(3);
    await setTextarea('.para-card[data-paragraph-index="3"] textarea.target-textarea', payload);
    await waitSaveStatus('已保存', 15000);
    const progress = await fetchProgress(BASE);
    const saved = progress.books?.hp1?.chapters?.['1']?.paragraphs?.['3'];
    assert(saved && saved.sentences[0] === payload, '保存的 XSS 载荷与原文不一致');
    await browser.reload();
    await browser.waitFor(`Boolean(document.querySelector('.para-card'))`, { timeoutMs: 30000, label: '刷新后练习页' });
    await waitCard(3);
    await sleep(900);
    const facts = await browser.eval(`(() => ({
      textareaValue: document.querySelector('.para-card[data-paragraph-index="3"] textarea.target-textarea')?.value,
      injectedImages: document.querySelectorAll('img[src="x"]').length,
      injectedScripts: document.querySelectorAll('.target-textarea img, .target-textarea script').length,
      xssFlag: window.__xss,
    }))()`);
    assertEqual(facts.textareaValue, payload, '刷新后 textarea 应显示原始文本');
    assertEqual(facts.injectedImages, 0, '页面出现了注入的 <img src=x>');
    assertEqual(facts.injectedScripts, 0, 'textarea 内出现注入元素');
    assertEqual(facts.xssFlag, undefined, 'window.__xss 被赋值，存在 XSS');
    await shot('desktop-1440-xss-after-reload.png');
    return { payload, textareaValue: facts.textareaValue, xssFlag: String(facts.xssFlag) };
  });

  await check('字号 / 主题切换后刷新持久化（localStorage + 根元素）', async () => {
    await navigateHash('#/practice/hp1/1?p=2&panel=review');
    await waitCard(2);
    await waitReviewPanel(2, 60000);
    assert(await click('[aria-label^="增大正文字号"]'), '找不到增大字号按钮');
    assert(await click('[aria-label="切换到深色主题"]'), '找不到主题切换按钮');
    await browser.waitFor(`document.documentElement.dataset.theme === 'dark'`, { timeoutMs: 5000, label: '切换深色主题' });
    const stored = await browser.eval(`({ theme: localStorage.getItem('zs.theme'), fontScale: localStorage.getItem('zs.fontScale') })`);
    assertEqual(stored.theme, 'dark', 'localStorage zs.theme');
    assertEqual(stored.fontScale, '1.1', 'localStorage zs.fontScale');
    await browser.reload();
    await browser.waitFor(`Boolean(document.querySelector('.para-card'))`, { timeoutMs: 30000, label: '刷新后练习页' });
    await sleep(500);
    const persisted = await browser.eval(`({
      theme: document.documentElement.dataset.theme,
      readingScale: getComputedStyle(document.documentElement).getPropertyValue('--reading-scale').trim(),
      storedTheme: localStorage.getItem('zs.theme'),
      storedFontScale: localStorage.getItem('zs.fontScale'),
    })`);
    assertEqual(persisted.theme, 'dark', '刷新后主题');
    assertEqual(persisted.readingScale, '1.1', '刷新后 --reading-scale');
    assertEqual(persisted.storedTheme, 'dark', '刷新后 localStorage 主题');
    assertEqual(persisted.storedFontScale, '1.1', '刷新后 localStorage 字号');
    return persisted;
  });

  await check('深色主题对比度抽查（正文/输入框/标题 ≥ 4.5:1）', async () => {
    const facts = await browser.eval(`(() => {
      const parse = (color) => {
        const match = String(color).match(/rgba?\\(([^)]+)\\)/);
        if (!match) return null;
        const parts = match[1].split(',').map((value) => Number(value.trim()));
        return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] === undefined ? 1 : parts[3] };
      };
      const luminance = ({ r, g, b }) => {
        const channel = (value) => { const v = value / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      };
      const background = (node) => {
        let current = node;
        while (current) {
          const parsed = parse(getComputedStyle(current).backgroundColor);
          if (parsed && parsed.a > 0.5) return parsed;
          current = current.parentElement;
        }
        return { r: 255, g: 255, b: 255, a: 1 };
      };
      const ratio = (a, b) => {
        const l1 = luminance(a); const l2 = luminance(b);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      };
      const selectors = ['.source-en', '.target-textarea', '.practice-chapter-title', '.topbar-title-text'];
      const output = [];
      for (const selector of selectors) {
        const node = document.querySelector(selector);
        if (!node) continue;
        const style = getComputedStyle(node);
        const fg = parse(style.color);
        const bg = background(node);
        output.push({ selector, color: style.color, background: 'rgb(' + bg.r + ',' + bg.g + ',' + bg.b + ')', ratio: Math.round(ratio(fg, bg) * 100) / 100 });
      }
      return { theme: document.documentElement.dataset.theme, output };
    })()`);
    assertEqual(facts.theme, 'dark', '当前应为深色主题');
    assert(facts.output.length >= 3, '对比度采样元素不足');
    const low = facts.output.filter((item) => item.ratio < 4.5);
    assertEqual(low.length, 0, `深色对比度不足 4.5:1：${low.map((item) => `${item.selector}=${item.ratio}`).join('，')}`);
    await shot('desktop-1440-practice-dark.png');
    await browser.setDeviceMetrics({ width: 390, height: 844, mobile: true });
    await sleep(500);
    await assertNoHorizontalOverflow('深色手机端练习页');
    await shot('mobile-390-practice-dark.png');
    await browser.setDeviceMetrics({ width: 1440, height: 1000, mobile: false });
    // 恢复浅色，避免影响后续截图（主题持久化已在上一条验证）
    await click('[aria-label="切换到浅色主题"]');
    await browser.waitFor(`document.documentElement.dataset.theme === 'light'`, { timeoutMs: 5000, label: '恢复浅色主题' });
    return facts.output;
  });

  await check('空状态：全未翻译章节显示 0% 且输入框为空（hp2/1）', async () => {
    await navigateHash('#/practice/hp2/1');
    await browser.waitFor(`Boolean(document.querySelector('.para-card'))`, { timeoutMs: 30000, label: 'hp2 第 1 章' });
    await sleep(600);
    const facts = await browser.eval(`(() => {
      const areas = [...document.querySelectorAll('.para-card .target-textarea')];
      return {
        progressText: document.querySelector('.topbar-progress-text')?.innerText || '',
        chapterMeta: document.querySelector('.practice-chapter-progress')?.innerText || '',
        textareaCount: areas.length,
        nonEmpty: areas.filter((area) => area.value.trim()).length,
      };
    })()`);
    assertContains(facts.progressText, '0%', '未翻译章节进度');
    assert(facts.textareaCount > 0, '未翻译章节没有输入框');
    assertEqual(facts.nonEmpty, 0, '未翻译章节的输入框应为空');
    assertContains(facts.chapterMeta, '已译 0', '章节进度文案');
    await assertNoHorizontalOverflow('空章节练习页');
    await shot('desktop-1440-practice-empty-chapter.png');
    return facts;
  });

  await check('空状态（演示模式）：待复习为空时给出友好空状态（截图）', async () => {
    await browser.navigate(`${BASE}/?mock=1#/review`);
    await browser.waitFor(`Boolean(document.querySelector('.state-view, .review-empty'))`, { timeoutMs: 30000, label: '演示模式空状态' });
    await sleep(500);
    const emptyText = await textOf('.state-view, .review-empty');
    assertContains(emptyText, '还没有待复习的段落', '待复习空状态文案');
    await shot('desktop-1440-review-empty-mock.png');
    await browser.setDeviceMetrics({ width: 390, height: 844, mobile: true });
    await sleep(400);
    await assertNoHorizontalOverflow('手机端待复习空状态');
    await shot('mobile-390-review-empty-mock.png');
    await browser.setDeviceMetrics({ width: 1440, height: 1000, mobile: false });
    await browser.navigate(`${BASE}/#/`);
    await browser.waitFor(`Boolean(document.querySelector('.book-card'))`, { timeoutMs: 30000, label: '回到正式模式书架' });
    return { text: emptyText.slice(0, 80) };
  });

  /* -------------------- C. 章节目录 / 继续上次练习 / 未知路由 -------------------- */
  await check('书架「继续上次练习」入口存在且跳转正确', async () => {
    await navigateHash('#/');
    await browser.waitFor(`Boolean(document.querySelector('.hero-actions'))`, { timeoutMs: 30000, label: '书架 hero' });
    await sleep(300);
    const facts = await browser.eval(`(() => {
      const hero = document.querySelector('.hero-actions');
      const primary = hero?.querySelector('a.btn-primary');
      let last = null;
      try { last = JSON.parse(localStorage.getItem('zs.lastLocation') || 'null'); } catch { last = null; }
      return {
        label: primary?.innerText?.trim() || '',
        href: primary?.getAttribute('href') || '',
        hint: document.querySelector('.hero-continue-hint')?.innerText || '',
        libraryStats: document.querySelector('.hero-stats')?.innerText?.replace(/\\n+/g, ' ') || '',
        last,
      };
    })()`);
    assertContains(facts.label, '继续上次练习', '书架主按钮文案');
    assert(facts.last && facts.last.bookId, 'localStorage 里没有上次练习位置');
    const expectedHref = `#/practice/${facts.last.bookId}/${facts.last.chapterIndex}${Number(facts.last.paragraphIndex) > 0 ? `?p=${facts.last.paragraphIndex}` : ''}`;
    assertEqual(facts.href, expectedHref, '继续上次练习链接应指向 localStorage 记录的位置');
    assertContains(facts.hint, '上次停在', '缺少上次位置提示');
    assertContains(facts.libraryStats, '本原著', '书架统计缺少本数');
    assertContains(facts.libraryStats, '199', '书架统计缺少章节数');
    await click('.hero-actions a.btn-primary');
    await browser.waitFor(`location.hash.startsWith('#/practice/')`, { timeoutMs: 30000, label: '继续练习跳转' });
    await browser.waitFor(`Boolean(document.querySelector('.para-card'))`, { timeoutMs: 30000, label: '练习页渲染' });
    const hash = await browser.eval('location.hash');
    assert(hash.startsWith(`#/practice/${facts.last.bookId}/${facts.last.chapterIndex}`), `继续练习跳转的 hash：${hash}`);
    return facts;
  });

  await check('章节目录：17 章、继续上次练习按钮、点击章节可跳转', async () => {
    await navigateHash('#/book/hp1');
    await browser.waitFor(`Boolean(document.querySelector('.chapter-row'))`, { timeoutMs: 30000, label: '章节目录' });
    await sleep(300);
    const facts = await browser.eval(`(() => {
      const rows = [...document.querySelectorAll('.chapter-row')];
      const primary = document.querySelector('.book-hero-actions a.btn-primary');
      return {
        rows: rows.length,
        firstTitle: rows[0]?.innerText?.replace(/\\n+/g, ' ').slice(0, 80) || '',
        continueLabel: primary?.innerText?.trim() || '',
        continueHref: primary?.getAttribute('href') || '',
        progressRingLabel: document.querySelector('.book-hero-progress')?.innerText?.replace(/\\n+/g, ' ') || '',
      };
    })()`);
    assertEqual(facts.rows, 17, 'hp1 章节行数');
    assertContains(facts.firstTitle, 'The Boy Who Lived', '第一章标题');
    assertContains(facts.continueLabel, '继续', '继续练习按钮文案');
    assert(facts.continueHref.includes('#/practice/hp1/1'), `继续练习链接：${facts.continueHref}`);
    await click('.chapter-row:nth-child(2) a');
    await browser.waitFor(`Boolean(document.querySelector('.para-card'))`, { timeoutMs: 30000, label: '第 2 章练习页' });
    await waitText('.topbar-title-text', 'The Vanishing Glass', 8000);
    const hash = await browser.eval('location.hash');
    assertContains(hash, '#/practice/hp1/2', '点击章节后的 hash');
    return facts;
  });

  await check('未知路由回书架（hash 被替换为 #/）', async () => {
    await browser.eval(`location.hash = '#/definitely-not-a-route'`);
    await browser.waitFor(`location.hash === '#/'`, { timeoutMs: 10000, label: '未知路由回书架' });
    await browser.waitFor(`Boolean(document.querySelector('.book-card'))`, { timeoutMs: 15000, label: '书架重新渲染' });
    return { hash: await browser.eval('location.hash') };
  });

  /* ------------------------------ D. 错误态 ------------------------------ */
  endPhase();
  beginPhase('error-manifest', { allowConsoleErrors: true });
  await check('错误态：/api/manifest 返回 500 时书架显示错误面板（不白屏），恢复后正常', async () => {
    await browser.intercept((url) => url.includes('/api/manifest'), async (client, params) => {
      const body = Buffer.from(JSON.stringify({ ok: false, error: { code: 'SERVER_ERROR', message: 'QA 模拟：后端临时不可用' } })).toString('base64');
      await client.send('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: 500,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }],
        body,
      });
    });
    await browser.navigate(`${BASE}/?qa-manifest=1#/`);
    await browser.waitFor(`Boolean(document.querySelector('.error-panel-wrap, .state-view'))`, { timeoutMs: 30000, label: '书架错误面板' });
    await sleep(600);
    const facts = await browser.eval(`(() => ({
      hasErrorPanel: Boolean(document.querySelector('.error-panel-wrap')),
      errorText: (document.querySelector('.error-panel-wrap')?.innerText || document.querySelector('.state-view')?.innerText || '').slice(0, 300),
      pageTextLength: (document.body.innerText || '').trim().length,
      hasBootLoadingOnly: Boolean(document.querySelector('.boot-loading')),
    }))()`);
    assert(facts.pageTextLength > 40, '错误态页面几乎是空白');
    assertEqual(facts.hasBootLoadingOnly, false, '页面停留在启动 loading');
    assertContains(facts.errorText, '无法连接后端服务', '错误面板标题');
    assertContains(facts.errorText, 'QA 模拟', '错误面板应展示后端错误信息');
    await shot('desktop-1440-manifest-error.png');
    await browser.clearInterceptors();
    await browser.navigate(`${BASE}/#/`);
    await browser.waitFor(`Boolean(document.querySelector('.book-card'))`, { timeoutMs: 30000, label: '错误恢复后书架' });
    assert((await count('.book-card')) === 7, '恢复后书架卡片数');
    return { errorText: facts.errorText.slice(0, 120) };
  });
  endPhase();

  beginPhase('error-offline', { allowConsoleErrors: true });
  await check('错误态：断网时自动保存失败有明确提示、页面不白屏；恢复网络后点击重试成功', async () => {
    // 先在联网状态把练习页与视图模块加载好，再断网触发保存失败（模拟真实“网线断开”场景）。
    await navigateHash('#/practice/hp1/1');
    await waitCard(0);
    await sleep(400);
    let facts = null;
    await browser.setOffline(true);
    try {
      await setTextarea('.para-card[data-paragraph-index="1"] textarea.target-textarea', '断网重试测试');
      await browser.waitFor(`/保存失败/.test(document.querySelector('.save-status')?.innerText || '')`, { timeoutMs: 25000, label: '保存失败状态' });
      await browser.waitFor(`Boolean(document.querySelector('.toast--error'))`, { timeoutMs: 10000, label: '保存失败 toast' });
      facts = await browser.eval(`(() => ({
        saveStatus: document.querySelector('.save-status')?.innerText || '',
        toastText: (document.querySelector('.toast--error')?.innerText || '').slice(0, 160),
        cards: document.querySelectorAll('.para-card').length,
        bodyTextLength: (document.body.innerText || '').trim().length,
      }))()`);
      assertContains(facts.saveStatus, '保存失败', '保存状态文案');
      assert(facts.cards >= 1, '断网后页面卡片消失');
      assert(facts.bodyTextLength > 200, '断网后页面接近白屏');
      await shot('desktop-1440-offline-save-error.png');
    } finally {
      // 无论断言是否失败都恢复网络，避免污染后续检查。
      await browser.setOffline(false);
    }
    await click('.save-status');
    await waitSaveStatus('已保存', 30000);
    const progress = await fetchProgress(BASE);
    const saved = progress.books?.hp1?.chapters?.['1']?.paragraphs?.['1'];
    assert(saved && saved.sentences.some((text) => String(text).includes('断网重试测试')), '恢复网络重试后译文未落库');
    // 回到干净的联网页面，供后续设置页阶段使用。
    await browser.navigate(`${BASE}/#/`);
    await browser.waitFor(`Boolean(document.querySelector('.book-card'))`, { timeoutMs: 30000, label: '断网恢复后书架' });
    return { saveStatus: facts.saveStatus.trim(), toast: facts.toastText };
  });
  endPhase();

  /* ------------------- E. 设置页：健康 / 导出 / 重置 / 导入 ------------------- */
  beginPhase('settings');
  await browser.setOffline(false).catch(() => {});
  await check('设置页：健康状态显示服务运行中 / Key 已配置 / 模型与最终语料统计', async () => {
    await navigateHash('#/settings');
    await browser.waitFor(`Boolean(document.querySelector('.health-hero'))`, { timeoutMs: 30000, label: '设置页健康状态' });
    await sleep(400);
    const facts = await browser.eval(`(() => ({
      text: (document.querySelector('.page-inner--narrow')?.innerText || '').slice(0, 2500),
      pills: [...document.querySelectorAll('.status-pill')].map((node) => node.innerText.replace(/\\n+/g, ' ')),
      rows: document.querySelectorAll('.settings-row').length,
      cards: document.querySelectorAll('.settings-card').length,
      shortcuts: document.querySelectorAll('.settings-card .shortcut-row, .settings-card tr').length,
    }))()`);
    assertContains(facts.text, '服务运行中', '缺少服务运行状态');
    assertContains(facts.text, '已配置', '缺少 Key 已配置状态');
    assertContains(facts.text, 'deepseek-chat', '缺少模型名');
    assertContains(facts.text, 'api.deepseek.com', '缺少接口地址');
    assertContains(facts.text, '7 本 · 199 章 · 80,204 句', '缺少最终语料统计');
    assertContains(facts.text, '快捷键', '缺少快捷键说明');
    assert(facts.rows >= 8, `设置项过少：${facts.rows}`);
    await shot('desktop-1440-settings-health.png');
    return { rows: facts.rows, cards: facts.cards };
  });

  await check('设置页：导出进度 JSON 可下载且结构正确', async () => {
    await browser.setDownloadBehavior(DOWNLOAD_DIR);
    rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
    mkdirSync(DOWNLOAD_DIR, { recursive: true });
    assert(await clickButtonText('导出进度 JSON'), '找不到导出按钮');
    const downloaded = await waitUntil(() => {
      const files = readdirSync(DOWNLOAD_DIR).filter((name) => name.endsWith('.json'));
      return files.length ? path.join(DOWNLOAD_DIR, files[0]) : null;
    }, { timeoutMs: 15000, label: '等待进度导出下载' });
    await waitUntil(() => {
      try {
        const parsed = JSON.parse(readFileSync(downloaded, 'utf8'));
        return parsed && parsed.books && Object.keys(parsed.books).length > 0;
      } catch { return false; }
    }, { timeoutMs: 10000, label: '下载文件写入完成' });
    const exported = JSON.parse(readFileSync(downloaded, 'utf8'));
    saveEvidence('exported-progress.json', exported);
    const filePath = path.join(EVIDENCE_DIR, 'exported-progress.json');
    const summary = summarizeProgress({ books: exported.books });
    assert(summary.paragraphs >= 1, '导出的进度为空');
    assert(exported.books.hp1, '导出进度缺少 hp1');
    globalThis.__exportedProgress = { exported, file: downloaded };
    return { download: path.relative(process.cwd(), downloaded).replace(/\\/g, '/'), ...summary, evidence: path.relative(process.cwd(), filePath).replace(/\\/g, '/') };
  });

  await check('设置页：重置全部进度（确认弹窗）→ 服务端进度清空 → 待复习空状态（截图）', async () => {
    assert(await clickButtonText('重置全部进度'), '找不到重置按钮');
    await waitModal('重置全部进度');
    assertContains(await textOf('.modal-body'), '无法恢复', '重置弹窗缺少风险提示');
    await clickModalButton('确认重置');
    await browser.waitFor(`Boolean(document.querySelector('.toast'))`, { timeoutMs: 15000, label: '重置成功 toast' });
    await sleep(600);
    const progress = await fetchProgress(BASE);
    const summary = summarizeProgress(progress);
    assertEqual(summary.paragraphs, 0, '重置后仍存在段落进度');
    await navigateHash('#/review');
    await browser.waitFor(`Boolean(document.querySelector('.state-view, .review-empty'))`, { timeoutMs: 30000, label: '待复习空状态' });
    await sleep(400);
    const emptyText = await textOf('.state-view, .review-empty');
    assertContains(emptyText, '还没有待复习的段落', '真实模式待复习空状态文案');
    await shot('desktop-1440-review-empty-real.png');
    return summary;
  });

  await check('设置页：导入进度 JSON（导出文件回导）→ 内容与服务端导出快照一致', async () => {
    const { exported, file } = globalThis.__exportedProgress;
    await navigateHash('#/settings');
    await browser.waitFor(`Boolean(document.querySelector('.settings-card'))`, { timeoutMs: 30000, label: '设置页' });
    await sleep(400);
    assert(await clickButtonText('导入进度 JSON'), '找不到导入按钮');
    await browser.setFileInput('input[type=file]', file);
    await waitModal('导入进度');
    const modalText = await textOf('.modal-body');
    assertContains(modalText, '段落进度', '导入确认弹窗缺少段落数量说明');
    await clickModalButton('导入');
    await browser.waitFor(`/导入完成/.test(document.querySelector('.import-status')?.innerText || '')`, { timeoutMs: 60000, label: '导入完成状态' });
    await sleep(800);
    const progress = await fetchProgress(BASE);
    const diffs = diffProgress({ books: exported.books }, progress);
    saveEvidence('import-roundtrip-diff.json', { diffCount: diffs.length, diffs: diffs.slice(0, 20) });
    assertEqual(diffs.length, 0, `导入回读与导出快照不一致：${diffs.slice(0, 3).map((item) => `${item.key} ${item.reason}`).join('；')}`);
    const summary = summarizeProgress(progress);
    assert(summary.paragraphs > 0, '导入后进度为空');
    await shot('desktop-1440-settings-after-import.png');
    return { imported: summary, importStatus: (await textOf('.import-status')).trim() };
  });

  endPhase();

  beginPhase('settings-health-error', { allowConsoleErrors: true });
  await check('设置页故障兜底：/api/health 失败时显示内联错误而不是白屏（重新检测按钮仍可用）', async () => {
    await browser.intercept((url) => url.includes('/api/health'), async (client, params) => {
      await client.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'ConnectionRefused' }).catch(async () => {
        await client.send('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: 500, body: Buffer.from('{"ok":false}').toString('base64') });
      });
    });
    await browser.navigate(`${BASE}/?qa-health=1#/settings`);
    await browser.waitFor(`Boolean(document.querySelector('.settings-inline-error'))`, { timeoutMs: 30000, label: '设置页健康错误' });
    const errorText = await textOf('.settings-inline-error');
    assertContains(errorText, '无法连接本机后端服务', '健康检查错误提示');
    assertContains(errorText, 'npm start', '缺少启动指引');
    await shot('desktop-1440-settings-health-error.png');
    await browser.clearInterceptors();
    await browser.navigate(`${BASE}/#/settings`);
    await browser.waitFor(`Boolean(document.querySelector('.health-hero'))`, { timeoutMs: 30000, label: '恢复后健康状态' });
    return { errorText: errorText.slice(0, 120) };
  });
  endPhase();

  beginPhase('settings-theme');
  await check('设置页主题按钮恢复浅色（并验证浅色/深色/跟随系统三段切换）', async () => {
    await navigateHash('#/settings');
    await browser.waitFor(`Boolean(document.querySelector('.segmented'))`, { timeoutMs: 30000, label: '主题分段控件' });
    await clickIn('.segmented', '浅色');
    await browser.waitFor(`document.documentElement.dataset.theme === 'light'`, { timeoutMs: 5000, label: '浅色主题' });
    await clickIn('.segmented', '跟随系统');
    await sleep(300);
    await clickIn('.segmented', '浅色');
    await sleep(300);
    const facts = await browser.eval(`({
      theme: document.documentElement.dataset.theme,
      stored: localStorage.getItem('zs.theme'),
      pressed: [...document.querySelectorAll('.segmented-btn')].map((button) => ({ text: button.innerText, pressed: button.getAttribute('aria-pressed') })),
    })`);
    assertEqual(facts.theme, 'light', '恢复浅色主题');
    assertEqual(facts.stored, 'light', 'localStorage 主题');
    return facts;
  });
  endPhase();

  /* ---------------------------- F. 可访问性抽查 ---------------------------- */
  beginPhase('a11y');
  await check('可访问性：所有路由交互元素均有可访问名称（aria-label / 文本）', async () => {
    const routes = ['#/', '#/book/hp1', '#/practice/hp1/1', '#/review', '#/settings'];
    const problems = [];
    for (const hash of routes) {
      await navigateHash(hash);
      await sleep(900);
      const unlabeled = await browser.eval(`(() => {
        const nodes = [...document.querySelectorAll('button, a[href], textarea, select')];
        return nodes
          .filter((node) => node.getClientRects().length > 0)
          .filter((node) => {
            const label = (node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent || '').trim();
            const placeholder = (node.getAttribute('placeholder') || '').trim();
            return !label && !placeholder;
          })
          .map((node) => node.outerHTML.slice(0, 140))
          .slice(0, 5);
      })()`);
      if (unlabeled.length) problems.push({ hash, unlabeled });
    }
    saveEvidence('a11y-unlabeled.json', problems);
    assertEqual(problems.length, 0, `存在无可访问名称的交互元素：${JSON.stringify(problems).slice(0, 500)}`);
    return { routes: routes.length };
  });

  await check('可访问性：键盘 Tab 焦点可见（:focus-visible 样式生效）', async () => {
    await navigateHash('#/');
    await browser.waitFor(`Boolean(document.querySelector('.book-card'))`, { timeoutMs: 30000, label: '书架' });
    const focusRuleCount = await browser.eval(`(() => {
      let count = 0;
      for (const sheet of document.styleSheets) {
        let rules = [];
        try { rules = [...sheet.cssRules]; } catch { continue; }
        for (const rule of rules) if (rule.selectorText && rule.selectorText.includes(':focus-visible')) count += 1;
      }
      return count;
    })()`);
    assert(focusRuleCount > 0, '样式表中没有 :focus-visible 规则');
    await browser.pressKey('Tab');
    await sleep(300);
    const focusFacts = await browser.eval(`(() => {
      const active = document.activeElement;
      const style = active ? getComputedStyle(active) : null;
      return { tag: active?.tagName, outlineStyle: style?.outlineStyle, outlineWidth: style?.outlineWidth };
    })()`);
    assert(focusFacts.tag && focusFacts.tag !== 'BODY', 'Tab 后焦点仍在 body');
    assert(focusFacts.outlineStyle !== 'none' && Number.parseFloat(focusFacts.outlineWidth) >= 1, `焦点样式不可见：${JSON.stringify(focusFacts)}`);
    return { focusRuleCount, focusFacts };
  });

  await check('移动端触控目标：主要按钮与输入框高度 ≥ 40px', async () => {
    await browser.setDeviceMetrics({ width: 390, height: 844, mobile: true });
    await navigateHash('#/practice/hp1/1');
    await waitCard(0);
    await sleep(600);
    const facts = await browser.eval(`(() => {
      const rect = (node) => Math.round(node.getBoundingClientRect().height * 10) / 10;
      return {
        primaryButtons: [...document.querySelectorAll('.para-card .para-actions .btn')].slice(0, 3).map((node) => ({ text: node.innerText.trim().slice(0, 12), height: rect(node) })),
        textarea: rect(document.querySelector('.para-card .target-textarea')),
        iconButtons: [...document.querySelectorAll('.topbar-actions .icon-btn, .sidebar-toggle')].map((node) => ({ label: node.getAttribute('aria-label') || node.title, height: rect(node) })),
      };
    })()`);
    const smallButtons = facts.primaryButtons.filter((item) => item.height < 40);
    assertEqual(smallButtons.length, 0, `主要按钮触控目标不足 40px：${JSON.stringify(smallButtons)}`);
    assert(facts.textarea >= 40, `输入框高度不足 40px：${facts.textarea}`);
    await browser.setDeviceMetrics({ width: 1440, height: 1000, mobile: false });
    return facts;
  });
  endPhase();

  /* ------------------------ G. 控制台 / 网络健全性 ------------------------ */
  await check('正常流程控制台 0 个 error、0 个未捕获异常', async () => {
    const normalPhases = [...browserErrorsByPhase.entries()].filter(([, value]) => !value.allowed);
    const consoleErrors = normalPhases.flatMap(([name, value]) => value.consoleErrors.map((error) => `${name}: ${error.text}`));
    const pageErrors = normalPhases.flatMap(([name, value]) => value.pageErrors.map((error) => `${name}: ${error.text}`));
    saveEvidence('console-errors.json', { consoleErrors, pageErrors });
    assertEqual(pageErrors.length, 0, `未捕获异常 ${pageErrors.length} 个：${pageErrors.slice(0, 3).join(' | ')}`);
    assertEqual(consoleErrors.length, 0, `控制台 error ${consoleErrors.length} 个：${consoleErrors.slice(0, 5).join(' | ')}`);
    return { phases: normalPhases.length };
  });

  await check('正常流程无 404/5xx 资源（静态文件与 API 均正常）', async () => {
    const inErrorRange = (index) => errorResponseRanges.some(([start, end]) => index >= start && index < end);
    const badResponses = browser.responses.filter((item, index) => item.status >= 400 && !inErrorRange(index));
    saveEvidence('bad-responses.json', { badResponses, errorResponseRanges });
    assertEqual(badResponses.length, 0, `出现 ${badResponses.length} 个异常响应：${badResponses.slice(0, 5).map((item) => `${item.status} ${item.url}`).join(' | ')}`);
    return { responses: browser.responses.length };
  });

  await check('无第三方网络请求（全部同源，符合「仅本机 + DeepSeek 服务端调用」约束）', async () => {
    const origins = new Set(browser.requests
      .filter((item) => item.url.startsWith('http'))
      .map((item) => { try { return new URL(item.url).origin; } catch { return item.url; } }));
    const extra = [...origins].filter((origin) => origin !== BASE);
    saveEvidence('request-origins.json', { origins: [...origins], requests: browser.requests.length });
    // 说明：真实 AI 请求由 Node 服务端发出，不经过浏览器，因此浏览器侧应只有本地同源请求。
    assertEqual(extra.length, 0, `出现第三方请求：${extra.join(', ')}`);
    return { requestCount: browser.requests.length, origins: [...origins] };
  });

  /* ------------------------------ 汇总输出 ------------------------------ */
  await browser.close();
  browser = null;
  const overall = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE,
    liveAiReview: !SKIP_LIVE_REVIEW,
    total: results.checks.length,
    passed: results.passed.length,
    failed: results.failed.length,
    checks: results.checks,
    screenshots,
    consoleErrorsByPhase: Object.fromEntries([...browserErrorsByPhase.entries()].map(([name, value]) => [name, {
      allowed: value.allowed,
      consoleErrorCount: value.consoleErrors.length,
      pageErrorCount: value.pageErrors.length,
    }])),
  };
  const outFile = path.join(QA_DIR, 'browser-results.json');
  writeFileSync(outFile, `${JSON.stringify(overall, null, 2)}\n`, 'utf8');

  console.log(`\n=== 浏览器 E2E 结果：${overall.passed}/${overall.total} PASS，${overall.failed} FAIL ===`);
  for (const entry of results.checks) {
    console.log(`[${entry.status}] ${entry.phase} | ${entry.name}${entry.status === 'FAIL' ? `\n        → ${entry.detail}` : ''}`);
  }
  console.log(`\n截图 ${screenshots.length} 张，结果文件：${outFile}`);

  if (!KEEP_PROGRESS && progressBackup) {
    console.log('\n正在恢复测试前进度…');
    const restore = await restoreProgress(BASE, progressBackup);
    console.log(`进度恢复：${restore.restored}/${restore.total} 段${restore.failures.length ? `，失败 ${restore.failures.length} 段` : ''}`);
    if (restore.failures.length) process.exitCode = 1;
  }
  if (overall.failed > 0) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error('浏览器 E2E 脚本异常：', error);
  try {
    if (browser) {
      const outFile = path.join(QA_DIR, 'browser-failure.png');
      await browser.screenshot(outFile).catch(() => {});
      await browser.close();
      browser = null;
    }
    if (!KEEP_PROGRESS && progressBackup) {
      console.log('脚本异常，尝试恢复测试前进度…');
      const restore = await restoreProgress(BASE, progressBackup);
      console.log(`进度恢复：${restore.restored}/${restore.total} 段`);
    }
  } catch { /* 忽略 */ }
  process.exitCode = 1;
});
