/**
 * 进度持久化：data/progress.json 的原子读写与按段 patch 合并。
 *
 * - 写入方式：先写 `<file>.tmp` 再 rename 覆盖，保证进程崩溃时不产生半截 JSON；
 * - 并发安全：所有写入串行排队，串行化时重新序列化「最新内存状态」，因此并发 PUT 不会互相覆盖或损坏文件；
 * - 启动容错：文件损坏时备份为 `<file>.corrupt-<时间戳>` 并重建空进度，服务照常启动；
 * - 进度百分比：分子 = 非空译文句数，分母 = manifest 的 sentenceCount。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

const VERSION = 1;

function emptyState() {
  return { version: VERSION, updatedAt: null, books: {} };
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 归一化单段记录，保证 data 结构固定（前端可依赖）。 */
function normalizeParagraphRecord(raw) {
  return {
    sentences: Array.isArray(raw.sentences)
      ? raw.sentences.map((item) => (typeof item === 'string' ? item : item == null ? '' : String(item)))
      : [],
    starred: raw.starred === true,
    review: isPlainObject(raw.review) ? raw.review : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

/** 归一化整个进度文件；结构非法时抛错，由调用方备份重建。 */
function normalizeState(raw) {
  if (!isPlainObject(raw)) throw new Error('progress 根节点不是对象');
  const books = {};
  if (isPlainObject(raw.books)) {
    for (const [bookId, book] of Object.entries(raw.books)) {
      if (!isPlainObject(book) || !isPlainObject(book.chapters)) continue;
      const chapters = {};
      for (const [chapterIndex, chapter] of Object.entries(book.chapters)) {
        if (!isPlainObject(chapter) || !isPlainObject(chapter.paragraphs)) continue;
        const paragraphs = {};
        for (const [paragraphIndex, paragraph] of Object.entries(chapter.paragraphs)) {
          if (!isPlainObject(paragraph)) continue;
          paragraphs[paragraphIndex] = normalizeParagraphRecord(paragraph);
        }
        chapters[chapterIndex] = { paragraphs };
      }
      books[bookId] = { chapters };
    }
  }
  return {
    version: VERSION,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    books,
  };
}

function countTranslatedSentences(paragraphs) {
  let count = 0;
  for (const paragraph of Object.values(paragraphs ?? {})) {
    if (!paragraph || !Array.isArray(paragraph.sentences)) continue;
    for (const sentence of paragraph.sentences) {
      if (typeof sentence === 'string' && sentence.trim().length > 0) count += 1;
    }
  }
  return count;
}

export class ProgressStore {
  /**
   * @param {{filePath: string, corpus?: import('./corpus.js').CorpusStore, logger?: Console}} options
   */
  constructor({ filePath, corpus = null, logger = console }) {
    this.filePath = path.resolve(filePath);
    this.corpus = corpus;
    this.logger = logger;
    this.state = emptyState();
    this.loaded = false;
    this.loadingPromise = null;
    this.writeChain = Promise.resolve();
  }

  /** 懒加载：首次访问时读盘；损坏则备份并重建。永不把读取错误抛给接口。 */
  async ensureLoaded() {
    if (this.loaded) return;
    if (!this.loadingPromise) {
      this.loadingPromise = this.load().finally(() => {
        this.loadingPromise = null;
        this.loaded = true;
      });
    }
    await this.loadingPromise;
  }

  async load() {
    let text;
    try {
      text = await fsp.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        this.logWarning(`读取进度文件失败（${(error && error.code) || 'ERROR'}），本次按空进度运行：${this.filePath}`);
      }
      this.state = emptyState();
      return;
    }

    try {
      this.state = normalizeState(JSON.parse(text.replace(/^\uFEFF/, '')));
    } catch {
      this.logWarning(`进度文件损坏，已备份并重建空进度：${this.filePath}`);
      await this.backupCorruptFile();
      this.state = emptyState();
    }
  }

  async backupCorruptFile() {
    const backupPath = `${this.filePath}.corrupt-${Date.now()}`;
    try {
      await fsp.rename(this.filePath, backupPath);
      this.logWarning(`损坏的进度文件已备份为：${backupPath}`);
    } catch {
      // 备份失败（文件锁/无权限）不阻塞服务启动；下次写入会直接覆盖。
    }
  }

  logWarning(message) {
    if (this.logger && typeof this.logger.warn === 'function') this.logger.warn(`[progress] ${message}`);
  }

  /** 深拷贝快照，避免响应序列化期间被并发请求修改。 */
  async getSnapshot() {
    await this.ensureLoaded();
    return structuredClone(this.state);
  }

  async getUpdatedAt() {
    await this.ensureLoaded();
    return this.state.updatedAt;
  }

  /**
   * 合并保存一个段落。patch 里只有显式提供的字段会被覆盖：
   * hasSentences / hasStarred / hasReview 标记字段是否出现。
   */
  async setParagraph(patch) {
    await this.ensureLoaded();

    const bookId = String(patch.bookId);
    const chapterIndex = String(patch.chapterIndex);
    const paragraphIndex = String(patch.paragraphIndex);

    if (!this.state.books[bookId]) this.state.books[bookId] = { chapters: {} };
    const book = this.state.books[bookId];
    if (!book.chapters[chapterIndex]) book.chapters[chapterIndex] = { paragraphs: {} };
    const chapter = book.chapters[chapterIndex];

    const now = new Date().toISOString();
    const record = chapter.paragraphs[paragraphIndex]
      ? { ...chapter.paragraphs[paragraphIndex] }
      : { sentences: [], starred: false, review: null, updatedAt: null };
    if (patch.hasSentences) record.sentences = patch.sentences;
    if (patch.hasStarred) record.starred = patch.starred;
    if (patch.hasReview) record.review = patch.review;
    record.updatedAt = now;
    chapter.paragraphs[paragraphIndex] = record;

    this.state.updatedAt = now;
    const summary = await this.computeSummary(bookId, chapterIndex);
    await this.persist();
    return { updatedAt: now, summary };
  }

  /** 清空全部进度并落盘。 */
  async reset() {
    await this.ensureLoaded();
    const now = new Date().toISOString();
    this.state = emptyState();
    this.state.updatedAt = now;
    await this.persist();
    return { updatedAt: now };
  }

  /** 排队原子写入；写入时序列化当时的最新状态，保证并发安全。 */
  persist() {
    const run = async () => {
      const payload = JSON.stringify(this.state);
      await this.writeAtomic(payload);
    };
    const task = this.writeChain.then(run, run);
    this.writeChain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async writeAtomic(payload) {
    const dir = path.dirname(this.filePath);
    await fsp.mkdir(dir, { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    await fsp.writeFile(tmpPath, payload, 'utf8');
    // Windows 上 rename 覆盖偶发被安全软件短暂占用，做少量重试。
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await fsp.rename(tmpPath, this.filePath);
        return;
      } catch (error) {
        lastError = error;
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error && error.code)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    throw lastError ?? new Error('写入进度文件失败');
  }

  /** 用 manifest 统计计算本书/本章进度百分比。 */
  async computeSummary(bookId, chapterIndex) {
    let bookSentenceTotal = 0;
    let chapterSentenceTotal = 0;
    if (this.corpus) {
      try {
        const book = await this.corpus.getBook(bookId);
        bookSentenceTotal = Number(book.sentenceCount) || 0;
        if (!bookSentenceTotal && Array.isArray(book.chapters)) {
          bookSentenceTotal = book.chapters.reduce((sum, item) => sum + (Number(item?.sentenceCount) || 0), 0);
        }
        const chapterMeta = Array.isArray(book.chapters)
          ? book.chapters.find((item) => item && Number(item.index) === Number(chapterIndex))
          : null;
        chapterSentenceTotal = Number(chapterMeta?.sentenceCount) || 0;
      } catch {
        // 语料不可用时仍允许保存，只是进度按 0 展示。
      }
    }

    const bookData = this.state.books[String(bookId)];
    let translatedBook = 0;
    if (bookData && isPlainObject(bookData.chapters)) {
      for (const chapter of Object.values(bookData.chapters)) {
        translatedBook += countTranslatedSentences(chapter && chapter.paragraphs);
      }
    }
    const translatedChapter = countTranslatedSentences(
      bookData?.chapters?.[String(chapterIndex)]?.paragraphs,
    );

    const bookProgress = bookSentenceTotal > 0
      ? Math.min(100, round1((translatedBook / bookSentenceTotal) * 100))
      : 0;
    const chapterProgress = chapterSentenceTotal > 0
      ? Math.min(100, round1((translatedChapter / chapterSentenceTotal) * 100))
      : 0;
    return { bookProgress, chapterProgress };
  }
}
