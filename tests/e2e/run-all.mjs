/**
 * QA 全量回归入口（零依赖）：一次跑完 API 黑盒 + 浏览器 E2E + AI Key 未配置场景，
 * 并在结束后把真实进度恢复到测试前的状态（先备份 → 最后逐段 PUT 回写）。
 *
 * 前置：
 *   - 正式服务已在 http://127.0.0.1:5180 运行，且已加载最终语料（health: 80204 句）；
 *   - 已安装 Microsoft Edge（headless 截图/交互用）；Node 24（自带 WebSocket / fetch）。
 *
 * 用法：
 *   node tests/e2e/run-all.mjs
 *   node tests/e2e/run-all.mjs --skip-live-review   # 浏览器阶段不调用真实 AI 批改
 *   node tests/e2e/run-all.mjs --no-ai              # API 阶段也跳过真实 /api/word 调用
 *   node tests/e2e/run-all.mjs --skip-auth          # 跳过 5185 AI-Key-未配置 独立实例测试
 *
 * 输出：.scratch/qa/{api-results,browser-results,ai-auth-results,qa-summary}.json
 * 退出码：0 全部 PASS 且进度成功恢复；1 有 FAIL 或恢复失败。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { apiJson, backupProgress, diffProgress, restoreProgress, summarizeProgress } from './lib/progress-utils.mjs';

const args = process.argv.slice(2);
const BASE = 'http://127.0.0.1:5180';
const QA_DIR = path.resolve('.scratch/qa');
const PRE_QA_BACKUP = path.join(QA_DIR, 'pre-qa-progress-backup.json');
mkdirSync(QA_DIR, { recursive: true });

function runNode(script, extraArgs = []) {
  return new Promise((resolve) => {
    console.log(`\n$ node ${script} ${extraArgs.join(' ')}`.trim());
    const child = spawn(process.execPath, [script, ...extraArgs], {
      cwd: path.resolve('.'),
      stdio: 'inherit',
      env: process.env,
    });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (error) => {
      console.error(`启动 ${script} 失败：${error.message}`);
      resolve(1);
    });
  });
}

function readJsonIfExists(filePath) {
  try { return JSON.parse(readFileSync(filePath, 'utf8')); } catch { return null; }
}

async function main() {
  console.log('=== 逐句译 · QA 全量回归 ===');

  const health = await apiJson(BASE, '/api/health');
  if (health.status !== 200 || !health.json?.ok) {
    console.error(`服务未就绪：GET ${BASE}/api/health → HTTP ${health.status}`);
    process.exitCode = 1;
    return;
  }
  const corpus = health.json.corpus;
  console.log(`服务已就绪：${corpus.books} 本 / ${corpus.chapters} 章 / ${corpus.sentences} 句；keyConfigured=${health.json.keyConfigured}`);
  if (corpus.sentences !== 80204) {
    console.warn(`警告：health 语料句数为 ${corpus.sentences}，期望最终语料 80204。请确认服务是否已重启加载最新 data/corpus。`);
  }

  // 1. 备份测试前进度（真实进度，结束后恢复）
  const backup = await backupProgress(BASE, PRE_QA_BACKUP);
  const beforeSummary = summarizeProgress(backup);
  console.log(`已备份测试前进度：${JSON.stringify(beforeSummary)} → ${path.relative(process.cwd(), PRE_QA_BACKUP)}`);

  const stageResults = [];
  const apiArgs = args.includes('--no-ai') ? ['--no-ai'] : [];
  const browserArgs = args.includes('--skip-live-review') ? ['--skip-live-review'] : [];
  browserArgs.push('--keep-progress');

  // 2. API 黑盒
  const apiExit = await runNode('tests/e2e/api-blackbox.mjs', apiArgs);
  stageResults.push({ stage: 'api-blackbox', exitCode: apiExit, resultFile: '.scratch/qa/api-results.json' });

  // 3. 浏览器 E2E
  const browserExit = await runNode('tests/e2e/browser-e2e.mjs', browserArgs);
  stageResults.push({ stage: 'browser-e2e', exitCode: browserExit, resultFile: '.scratch/qa/browser-results.json' });

  // 4. AI Key 未配置独立实例
  let authExit = 0;
  if (args.includes('--skip-auth')) {
    console.log('\n（--skip-auth：跳过 AI Key 未配置场景测试）');
  } else {
    authExit = await runNode('tests/e2e/ai-auth-e2e.mjs');
    stageResults.push({ stage: 'ai-auth-e2e', exitCode: authExit, resultFile: '.scratch/qa/ai-auth-results.json' });
  }

  // 5. 恢复测试前进度 + 校验内容一致
  console.log('\n=== 恢复测试前进度 ===');
  let restoreResult = { ok: false };
  try {
    const restore = await restoreProgress(BASE, backup);
    const current = (await apiJson(BASE, '/api/progress')).json.data;
    const diffs = diffProgress(backup, current);
    const afterSummary = summarizeProgress(current);
    restoreResult = { ok: restore.failures.length === 0 && diffs.length === 0, restore, diffCount: diffs.length };
    console.log(`恢复段落：${restore.restored}/${restore.total}，内容差异：${diffs.length} 处`);
    console.log(`恢复后进度摘要：${JSON.stringify(afterSummary)}（测试前：${JSON.stringify(beforeSummary)}）`);
    if (diffs.length) console.log(`差异示例：${diffs.slice(0, 5).map((item) => `${item.key} ${item.reason}`).join('；')}`);
  } catch (error) {
    console.error(`进度恢复失败：${error.message}`);
    restoreResult = { ok: false, error: error.message };
  }

  // 6. 汇总
  const apiResults = readJsonIfExists(path.join(QA_DIR, 'api-results.json'));
  const browserResults = readJsonIfExists(path.join(QA_DIR, 'browser-results.json'));
  const authResults = args.includes('--skip-auth') ? null : readJsonIfExists(path.join(QA_DIR, 'ai-auth-results.json'));
  const totalChecks = (apiResults?.total || 0) + (browserResults?.total || 0) + (authResults?.total || 0);
  const failedChecks = (apiResults?.failed || 0) + (browserResults?.failed || 0) + (authResults?.failed || 0);

  const summary = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE,
    corpus,
    progressBefore: beforeSummary,
    progressRestored: restoreResult.ok,
    restore: restoreResult,
    stages: stageResults,
    checks: { total: totalChecks, passed: totalChecks - failedChecks, failed: failedChecks },
    stageResults: {
      api: apiResults ? { total: apiResults.total, failed: apiResults.failed } : null,
      browser: browserResults ? { total: browserResults.total, failed: browserResults.failed } : null,
      aiAuth: authResults ? { total: authResults.total, failed: authResults.failed } : null,
    },
  };
  const summaryFile = path.join(QA_DIR, 'qa-summary.json');
  writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  console.log('\n================= QA 汇总 =================');
  console.log(`检查项：${totalChecks} 项，失败 ${failedChecks} 项`);
  for (const stage of stageResults) {
    console.log(`- ${stage.stage}: ${stage.exitCode === 0 ? 'PASS' : `FAIL(exit ${stage.exitCode})`}（${stage.resultFile}）`);
  }
  console.log(`- 进度已恢复：${restoreResult.ok ? '是' : '否'}`);
  console.log(`汇总文件：${path.relative(process.cwd(), summaryFile)}`);
  const screenshotDirs = ['.scratch/qa/screenshots'];
  console.log(`截图目录：${screenshotDirs.join(', ')}`);

  const allPassed = stageResults.every((stage) => stage.exitCode === 0) && restoreResult.ok;
  console.log(allPassed ? '\nRESULT: PASS' : '\nRESULT: FAIL');
  if (!allPassed) process.exitCode = 1;
}

main().catch((error) => {
  console.error('QA 全量回归异常：', error);
  process.exitCode = 1;
});
