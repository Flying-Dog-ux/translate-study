/**
 * QA 用进度备份 / 恢复 / 对比工具（全部通过 HTTP API 操作，不直接改 data/progress.json）。
 *
 * 背景：端到端测试会覆盖「重置全部进度」等破坏性操作，因此正式测试前必须先
 * GET /api/progress 备份到 .scratch/qa/，测试结束后按备份逐段 PUT 回服务端。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export async function apiJson(baseUrl, pathname, { method = 'GET', body = null, timeoutMs = 120000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: body === null ? undefined : { 'Content-Type': 'application/json' },
      body: body === null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: response.status, ok: response.ok, json, text, headers: response.headers };
  } finally {
    clearTimeout(timer);
  }
}

/** 拉取进度快照（返回 data 根对象 {version, updatedAt, books}）。 */
export async function fetchProgress(baseUrl) {
  const response = await apiJson(baseUrl, '/api/progress');
  if (!response.ok || !response.json || response.json.ok !== true) {
    throw new Error(`GET /api/progress 失败：HTTP ${response.status} ${response.text.slice(0, 200)}`);
  }
  const data = response.json.data;
  if (!data || typeof data !== 'object' || !data.books || typeof data.books !== 'object') {
    throw new Error('GET /api/progress 返回结构异常（缺少 data.books）');
  }
  return data;
}

/** 备份进度到 JSON 文件，返回备份对象。 */
export async function backupProgress(baseUrl, filePath) {
  const data = await fetchProgress(baseUrl);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify({ backedUpAt: new Date().toISOString(), data }, null, 2)}\n`, 'utf8');
  return data;
}

/** 读取备份文件里的进度数据。 */
export function readBackup(filePath) {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  return parsed.data ?? parsed;
}

/** 遍历进度里的所有段落 [bookId, chapterIndex, paragraphIndex, record]。 */
export function iterateParagraphs(progressData) {
  const entries = [];
  for (const [bookId, book] of Object.entries(progressData?.books || {})) {
    for (const [chapterIndex, chapter] of Object.entries(book?.chapters || {})) {
      for (const [paragraphIndex, record] of Object.entries(chapter?.paragraphs || {})) {
        entries.push({ bookId, chapterIndex: Number(chapterIndex), paragraphIndex: Number(paragraphIndex), record });
      }
    }
  }
  return entries;
}

/**
 * 用备份恢复服务端进度：先 DELETE 清空，再逐段 PUT。
 * 注意：DELETE 会清空 updatedAt；恢复后各段 updatedAt 为恢复时刻（内容一致）。
 */
export async function restoreProgress(baseUrl, backupData, { concurrency = 4 } = {}) {
  const reset = await apiJson(baseUrl, '/api/progress', { method: 'DELETE' });
  if (!reset.ok) throw new Error(`DELETE /api/progress 失败：HTTP ${reset.status}`);
  const entries = iterateParagraphs(backupData);
  const failures = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < entries.length) {
      const entry = entries[cursor++];
      const response = await apiJson(baseUrl, '/api/progress/paragraph', {
        method: 'PUT',
        body: {
          bookId: entry.bookId,
          chapterIndex: entry.chapterIndex,
          paragraphIndex: entry.paragraphIndex,
          sentences: Array.isArray(entry.record?.sentences) ? entry.record.sentences : [],
          starred: Boolean(entry.record?.starred),
          review: entry.record?.review && typeof entry.record.review === 'object' ? entry.record.review : null,
        },
      });
      if (!response.ok) failures.push({ entry, status: response.status, body: response.text.slice(0, 200) });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, entries.length)) }, () => worker()));
  return { restored: entries.length - failures.length, total: entries.length, failures };
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (a && b && typeof a === 'object') {
    const keysA = Object.keys(a).filter((key) => key !== 'updatedAt');
    const keysB = Object.keys(b).filter((key) => key !== 'updatedAt');
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

/**
 * 对比两份进度内容（忽略 updatedAt 时间戳），返回差异列表。
 * 找不到的段落 / 内容不同 / 多出来的段落都记入差异。
 */
export function diffProgress(expected, actual) {
  const diffs = [];
  const expectedMap = new Map();
  for (const entry of iterateParagraphs(expected)) expectedMap.set(`${entry.bookId}:${entry.chapterIndex}:${entry.paragraphIndex}`, entry);
  const actualMap = new Map();
  for (const entry of iterateParagraphs(actual)) actualMap.set(`${entry.bookId}:${entry.chapterIndex}:${entry.paragraphIndex}`, entry);
  for (const [key, expectedEntry] of expectedMap) {
    const actualEntry = actualMap.get(key);
    if (!actualEntry) {
      diffs.push({ key, reason: '实际进度缺少该段落' });
      continue;
    }
    const expectedContent = {
      sentences: expectedEntry.record?.sentences || [],
      starred: Boolean(expectedEntry.record?.starred),
      review: expectedEntry.record?.review ?? null,
    };
    const actualContent = {
      sentences: actualEntry.record?.sentences || [],
      starred: Boolean(actualEntry.record?.starred),
      review: actualEntry.record?.review ?? null,
    };
    if (!deepEqual(expectedContent, actualContent)) diffs.push({ key, reason: '段落内容不一致' });
  }
  for (const key of actualMap.keys()) {
    if (!expectedMap.has(key)) diffs.push({ key, reason: '实际进度多出该段落' });
  }
  return diffs;
}

/** 统计进度摘要：段落数、非空译文句数、收藏数、已批改段数。 */
export function summarizeProgress(progressData) {
  const entries = iterateParagraphs(progressData);
  let nonEmpty = 0;
  let starred = 0;
  let reviewed = 0;
  for (const { record } of entries) {
    nonEmpty += (record?.sentences || []).filter((text) => typeof text === 'string' && text.trim()).length;
    if (record?.starred) starred += 1;
    if (record?.review && typeof record.review === 'object') reviewed += 1;
  }
  return { paragraphs: entries.length, nonEmptySentences: nonEmpty, starred, reviewed };
}
