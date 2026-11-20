/**
 * 进度数据纯函数：结构与 docs/CONTRACT.md §4.2 保持一致。
 * 这里不发起请求，供 store（正式模式）与 mock-api（演示模式）共用。
 */

import { REVIEW_NEEDED_VERDICTS } from './constants.js';

/** 空的进度根对象 */
export function emptyProgress() {
  return { version: 1, updatedAt: null, books: {} };
}

/** 接受 {ok,data:{...}} 包装或进度根对象，归一化为进度根对象 */
export function normalizeProgress(raw) {
  if (!raw || typeof raw !== 'object') return emptyProgress();
  const root = raw.books === undefined && raw.data && typeof raw.data === 'object' ? raw.data : raw;
  const books = root.books && typeof root.books === 'object' && !Array.isArray(root.books) ? root.books : {};
  return {
    version: Number(root.version) || 1,
    updatedAt: typeof root.updatedAt === 'string' ? root.updatedAt : null,
    books,
  };
}

/** 读取某章的全部进度段落（paragraphs 对象）；无则 null */
export function getChapterProgressData(progressRoot, bookId, chapterIndex) {
  const chapter = progressRoot?.books?.[bookId]?.chapters?.[String(chapterIndex)];
  return chapter && chapter.paragraphs && typeof chapter.paragraphs === 'object' ? chapter.paragraphs : null;
}

/** 读取某一段的已保存进度；无则 null */
export function getParagraphData(progressRoot, bookId, chapterIndex, paragraphIndex) {
  const paragraphs = getChapterProgressData(progressRoot, bookId, chapterIndex);
  if (!paragraphs) return null;
  const data = paragraphs[String(paragraphIndex)];
  return data && typeof data === 'object' ? data : null;
}

/** 把一段进度写入进度根对象（就地修改并更新 updatedAt），返回该根对象 */
export function setParagraphData(progressRoot, payload) {
  const { bookId, chapterIndex, paragraphIndex, sentences, starred, review } = payload;
  const root = progressRoot && typeof progressRoot === 'object' ? progressRoot : emptyProgress();
  if (!root.books) root.books = {};
  const book = (root.books[bookId] ||= { chapters: {} });
  if (!book.chapters) book.chapters = {};
  const chapter = (book.chapters[String(chapterIndex)] ||= { paragraphs: {} });
  if (!chapter.paragraphs) chapter.paragraphs = {};
  const now = new Date().toISOString();
  chapter.paragraphs[String(paragraphIndex)] = {
    sentences: normalizeSentenceTranslations(sentences, Array.isArray(sentences) ? sentences.length : 0),
    starred: Boolean(starred),
    review: review && typeof review === 'object' ? review : null,
    updatedAt: now,
  };
  root.version = Number(root.version) || 1;
  root.updatedAt = now;
  return root;
}

/** 把译文数组补齐 / 截断到指定句数，元素一律为字符串 */
export function normalizeSentenceTranslations(value, length) {
  const size = Math.max(0, Number(length) || 0);
  const source = Array.isArray(value) ? value : [];
  return Array.from({ length: size }, (_, i) => (typeof source[i] === 'string' ? source[i] : ''));
}

export function countNonEmptyTranslations(sentences) {
  if (!Array.isArray(sentences)) return 0;
  let count = 0;
  for (const value of sentences) {
    if (typeof value === 'string' && value.trim()) count += 1;
  }
  return count;
}

/** 单章统计：{total, translated, percent} */
export function chapterStats(manifestChapter, chapterProgressParagraphs) {
  const total = Number(manifestChapter?.sentenceCount) || 0;
  let translated = 0;
  if (chapterProgressParagraphs && typeof chapterProgressParagraphs === 'object') {
    for (const paragraph of Object.values(chapterProgressParagraphs)) {
      translated += countNonEmptyTranslations(paragraph?.sentences);
    }
  }
  if (total > 0) translated = Math.min(translated, total);
  const percent = total > 0 ? (translated / total) * 100 : 0;
  return { total, translated, percent };
}

/** 单本统计：{total, translated, percent, chapters: {[index]: stats}} */
export function bookStats(manifestBook, bookProgressData) {
  let total = 0;
  let translated = 0;
  const chapters = {};
  for (const chapter of manifestBook?.chapters || []) {
    const paragraphs = bookProgressData?.chapters?.[String(chapter.index)]?.paragraphs;
    const stats = chapterStats(chapter, paragraphs);
    chapters[chapter.index] = stats;
    total += stats.total;
    translated += stats.translated;
  }
  const percent = total > 0 ? (translated / total) * 100 : 0;
  return { total, translated, percent, chapters };
}

/** 该段是否被 AI 判定需要改进（不包含收藏） */
export function isAiNeedsImprovement(paragraphData) {
  const review = paragraphData?.review;
  if (!review || typeof review !== 'object') return false;
  const overallVerdict = review.overall?.verdict;
  if (REVIEW_NEEDED_VERDICTS.includes(overallVerdict)) return true;
  return Array.isArray(review.sentences)
    && review.sentences.some((sentence) => REVIEW_NEEDED_VERDICTS.includes(sentence?.verdict));
}

/** 该段是否进入「待复习」：收藏 或 AI 判定需改进 */
export function isReviewNeeded(paragraphData) {
  if (!paragraphData) return false;
  if (paragraphData.starred) return true;
  return isAiNeedsImprovement(paragraphData);
}

/** 汇总所有待复习段落（依赖 manifest 限定合法章节） */
export function collectReviewItems(manifest, progressRoot) {
  const items = [];
  for (const book of manifest?.books || []) {
    for (const chapter of book.chapters || []) {
      const paragraphs = getChapterProgressData(progressRoot, book.id, chapter.index);
      if (!paragraphs) continue;
      for (const [key, data] of Object.entries(paragraphs)) {
        if (!isReviewNeeded(data)) continue;
        items.push({
          book,
          chapter,
          paragraphIndex: Number(key),
          data,
          starred: Boolean(data?.starred),
          aiNeeded: isAiNeedsImprovement(data),
          updatedAt: data?.updatedAt || null,
        });
      }
    }
  }
  return items;
}

/** 找出某本书里第一个未完成的章节（用于「继续练习」） */
export function findFirstIncompleteChapter(manifestBook, bookProgressData) {
  const chapters = manifestBook?.chapters || [];
  for (const chapter of chapters) {
    const stats = chapterStats(chapter, bookProgressData?.chapters?.[String(chapter.index)]?.paragraphs);
    if (stats.total === 0 || stats.translated < stats.total) return chapter;
  }
  return chapters[0] || null;
}
