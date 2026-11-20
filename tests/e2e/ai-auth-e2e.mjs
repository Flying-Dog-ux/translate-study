/**
 * AI Key 未配置场景端到端测试（零依赖）。
 *
 * 目的：在不影响正式服务（5180）的前提下，用独立实例验证契约 §5 / §6.2 的降级行为：
 *   1. 启动 PORT=5185 + DEEPSEEK_NO_SYSTEM_ENV=1 的临时服务（进度写入 .scratch/qa 临时文件，不碰真实进度）；
 *   2. /api/health → keyConfigured:false；/api/review、/api/reference → 401 AI_AUTH；
 *   3. 浏览器：练习页仍可输入与自动保存；点「AI 批改」显示「尚未配置 DeepSeek API Key」面板（不报红、不白屏），
 *      面板提供「去设置页」入口；设置页显示「未配置」并给出配置指引；
 *   4. 结束后关闭临时服务。
 *
 * 用法：node tests/e2e/ai-auth-e2e.mjs
 * 输出：.scratch/qa/ai-auth-results.json、.scratch/qa/ai-auth-*.png。
 * 退出码：0 全部 PASS，1 存在 FAIL。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { assert, assertContains, assertEqual, createChecker, launchBrowser, sleep, waitUntil } from './lib/cdp.mjs';
import { apiJson } from './lib/progress-utils.mjs';

const QA_DIR = path.resolve('.scratch/qa');
const SHOT_DIR = path.join(QA_DIR, 'screenshots');
const PORT = Number(process.env.QA_AUTH_PORT || 5185);
const BASE = `http://127.0.0.1:${PORT}`;
const TEMP_PROGRESS = path.join(QA_DIR, 'tmp-5185-progress.json');
for (const dir of [QA_DIR, SHOT_DIR]) mkdirSync(dir, { recursive: true });
rmSync(TEMP_PROGRESS, { force: true });

const results = createChecker();
const screenshots = [];
let server = null;
let browser = null;

async function shot(name) {
  const filePath = path.join(SHOT_DIR, name.endsWith('.png') ? name : `${name}.png`);
  await browser.screenshot(filePath);
  screenshots.push(path.relative(process.cwd(), filePath).replace(/\\/g, '/'));
  return filePath;
}

async function waitServerReady() {
  return waitUntil(async () => {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (!response.ok) return false;
      const body = await response.json();
      return body?.ok ? body : false;
    } catch { return false; }
  }, { timeoutMs: 25000, intervalMs: 400, label: '临时 AI-Key-未配置 服务启动' });
}

async function main() {
  console.log('\n=== AI Key 未配置场景 E2E（独立实例） ===\n');
  mkdirSync(QA_DIR, { recursive: true });

  // 显式清空 Key + 跳过 Windows 注册表回退，确保临时实例 keyConfigured=false。
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DEEPSEEK_API_KEY: '',
      DEEPSEEK_NO_SYSTEM_ENV: '1',
      PROGRESS_PATH: TEMP_PROGRESS,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (chunk) => { serverLog += chunk.toString(); });
  server.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });

  const health = await waitServerReady();
  writeFileSync(path.join(QA_DIR, 'evidence', 'ai-auth-server-log.txt'), serverLog, 'utf8');

  await results.check('临时实例 /api/health：keyConfigured=false，其余字段正常；启动日志不泄露 Key', async () => {
    assertEqual(health.keyConfigured, false, 'keyConfigured');
    assertEqual(health.model, 'deepseek-chat', 'model');
    assertEqual(health.corpus.books, 7, 'corpus.books');
    assertEqual(health.corpus.chapters, 199, 'corpus.chapters');
    assertEqual(health.corpus.sentences, 80204, 'corpus.sentences');
    assert(!/sk-[A-Za-z0-9]{12,}/.test(serverLog), '启动日志疑似打印了 Key');
    assertContains(serverLog, '未配置 API Key', '启动日志应提示未配置 Key');
    assertContains(serverLog, BASE, '启动日志应打印访问地址');
    return { keyConfigured: health.keyConfigured, logLines: serverLog.trim().split(/\r?\n/).length };
  });

  await results.check('POST /api/review 未配置 Key → 401 AI_AUTH（教学式提示）', async () => {
    const chapter = await apiJson(BASE, '/api/chapters/hp1/1');
    assertEqual(chapter.status, 200, '章节接口应正常（未配置 Key 不影响读语料）');
    const sentenceCount = chapter.json.paragraphs[0].sentences.length;
    const response = await apiJson(BASE, '/api/review', {
      method: 'POST',
      body: { bookId: 'hp1', chapterIndex: 1, paragraphIndex: 0, translations: Array.from({ length: sentenceCount }, () => '') },
    });
    assertEqual(response.status, 401, `HTTP 状态（响应：${response.text.slice(0, 200)}）`);
    assertEqual(response.json.ok, false, 'ok');
    assertEqual(response.json.error.code, 'AI_AUTH', '错误码');
    assertContains(response.json.error.message, 'Key', '错误 message 应提示配置 Key');
    return { status: 401, message: response.json.error.message };
  });

  await results.check('POST /api/reference 未配置 Key → 401 AI_AUTH', async () => {
    const response = await apiJson(BASE, '/api/reference', {
      method: 'POST',
      body: { bookId: 'hp1', chapterIndex: 1, paragraphIndex: 0 },
    });
    assertEqual(response.status, 401, `HTTP 状态（响应：${response.text.slice(0, 200)}）`);
    assertEqual(response.json.error.code, 'AI_AUTH', '错误码');
    return { status: 401 };
  });

  // ------------------------- 浏览器侧降级体验 -------------------------
  browser = await launchBrowser({ width: 1440, height: 1000 });
  const consoleErrors = [];
  await browser.navigate(`${BASE}/#/practice/hp1/1`);
  await browser.waitFor(`Boolean(document.querySelector('.para-card'))`, { timeoutMs: 30000, label: '临时实例练习页' });

  await results.check('浏览器：未配置 Key 时练习页仍可输入并自动保存（练习不受影响）', async () => {
    await browser.eval(`(() => {
      const area = document.querySelector('.para-card[data-paragraph-index="0"] textarea.target-textarea');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(area, '未配置 Key 时的练习保存测试');
      area.dispatchEvent(new Event('input', { bubbles: true }));
      return area.value;
    })()`);
    await browser.waitFor(`/已保存/.test(document.querySelector('.save-status')?.innerText || '')`, { timeoutMs: 20000, label: '未配置 Key 时自动保存' });
    const progress = await apiJson(BASE, '/api/progress');
    const saved = progress.json?.data?.books?.hp1?.chapters?.['1']?.paragraphs?.['0'];
    assert(saved, '临时实例进度里没有保存记录');
    assertContains(saved.sentences?.[0] || '', '未配置 Key 时的练习保存测试', '保存的译文');
    return { saved: true };
  });

  await results.check('浏览器：点「AI 批改」→ 面板显示「尚未配置 DeepSeek API Key」+ 去设置页入口（不白屏）', async () => {
    await browser.eval(`(() => {
      const card = document.querySelector('.para-card[data-paragraph-index="0"]');
      const button = [...card.querySelectorAll('button')].find((node) => node.textContent.includes('AI 批改本段'));
      button.click();
      return true;
    })()`);
    await browser.waitFor(`Boolean(document.querySelector('.para-card[data-paragraph-index="0"] .panel-error'))`, { timeoutMs: 30000, label: 'AI_AUTH 面板错误' });
    await sleep(400);
    const facts = await browser.eval(`(() => {
      const card = document.querySelector('.para-card[data-paragraph-index="0"]');
      const panel = card.querySelector('.panel-error');
      return {
        title: panel?.querySelector('.panel-error-title')?.innerText || '',
        message: panel?.querySelector('.panel-error-message')?.innerText || '',
        hint: panel?.querySelector('.panel-error-hint')?.innerText || '',
        settingsLink: [...(panel?.querySelectorAll('a') || [])].map((node) => ({ text: node.innerText, href: node.getAttribute('href') })),
        pageTextLength: (document.body.innerText || '').trim().length,
      };
    })()`);
    assertContains(facts.title, '尚未配置 DeepSeek API Key', '错误面板标题');
    assertContains(facts.message, 'Key', '错误面板 message');
    assertContains(facts.hint, '.env', '缺少 .env 配置指引');
    const settingsLink = facts.settingsLink.find((item) => item.href === '#/settings');
    assert(settingsLink, '缺少「去设置页」入口');
    assert(facts.pageTextLength > 200, '页面接近白屏');
    await shot('ai-auth-panel-error.png');
    return { title: facts.title, link: settingsLink?.text };
  });

  await results.check('浏览器：设置页显示 Key「未配置」与配置指引（无报错白屏）', async () => {
    await browser.navigate(`${BASE}/#/settings`);
    await browser.waitFor(`Boolean(document.querySelector('.health-hero'))`, { timeoutMs: 30000, label: '临时实例设置页' });
    await sleep(400);
    const facts = await browser.eval(`(() => ({
      text: (document.querySelector('.page-inner--narrow')?.innerText || '').slice(0, 2000),
      pills: [...document.querySelectorAll('.status-pill')].map((node) => node.innerText.replace(/\\n+/g, ' ')),
      notice: document.querySelector('.settings-notice--warn')?.innerText || '',
    }))()`);
    assertContains(facts.text, '未配置', '设置页应显示 Key 未配置');
    assertContains(facts.notice, 'DEEPSEEK_API_KEY', '缺少 .env 配置指引');
    assertContains(facts.text, '80,204', '设置页语料统计');
    await shot('ai-auth-settings.png');
    return { pills: facts.pills, notice: facts.notice.slice(0, 120) };
  });

  await browser.close();
  browser = null;

  const overall = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE,
    total: results.checks.length,
    passed: results.passed.length,
    failed: results.failed.length,
    checks: results.checks,
    screenshots,
    consoleErrors,
  };
  const outFile = path.join(QA_DIR, 'ai-auth-results.json');
  writeFileSync(outFile, `${JSON.stringify(overall, null, 2)}\n`, 'utf8');
  console.log(`\n=== AI Key 未配置 E2E：${overall.passed}/${overall.total} PASS，${overall.failed} FAIL ===`);
  for (const entry of results.checks) {
    console.log(`[${entry.status}] ${entry.name}${entry.status === 'FAIL' ? `\n        → ${entry.detail}` : ''}`);
  }
  console.log(`\n截图 ${screenshots.length} 张，结果文件：${outFile}`);
  if (overall.failed > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error('AI Key 未配置 E2E 异常：', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await browser?.close(); } catch { /* 忽略 */ }
    try {
      if (server && !server.killed) {
        server.kill();
        await sleep(400);
      }
    } catch { /* 忽略 */ }
    try { rmSync(TEMP_PROGRESS, { force: true }); } catch { /* 忽略 */ }
  });
