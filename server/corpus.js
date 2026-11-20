/**
 * 语料读取：manifest 索引 + 章节文件缓存 + 路径安全校验。
 *
 * 设计要点：
 * - 语料目录不存在 / manifest 缺失时服务仍可启动，接口抛出中文可读的 CorpusError；
 * - 加载失败后按冷却时间自动重试，便于「先起服务、后生成语料」的开发流程；
 * - bookId / chapterIndex / 章节文件路径全部校验，杜绝路径穿越；
 * - 章节文件解析结果在内存缓存（语料是只读静态数据）。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

const BOOK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const RELOAD_COOLDOWN_MS = 2000;

/** 语料相关错误：code = NOT_FOUND（404）或 SERVER_ERROR（500）。 */
export class CorpusError extends Error {
  constructor(message, code = 'SERVER_ERROR') {
    super(message);
    this.name = 'CorpusError';
    this.code = code;
  }
}

function parseInteger(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d{1,4}$/.test(value.trim())) return Number(value.trim());
  return NaN;
}

/** 安全切片错误信息里的用户输入，避免把超长/恶意字符串回显。 */
function shortInput(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/** 从句子里取纯文本（契约里句子是 {text, wordCount} 对象，兼容纯字符串）。 */
export function sentenceText(sentence) {
  if (typeof sentence === 'string') return sentence;
  if (sentence && typeof sentence === 'object' && typeof sentence.text === 'string') return sentence.text;
  return '';
}

/** 把段落句子数组转成英文原句字符串数组。 */
export function paragraphSentences(paragraph) {
  if (!paragraph || !Array.isArray(paragraph.sentences)) return [];
  return paragraph.sentences.map(sentenceText);
}

/** 把段落英文原句拼成一段文本（用作上下文/参考译文输入）。 */
export function paragraphSourceText(paragraph) {
  return paragraphSentences(paragraph).filter(Boolean).join(' ');
}

export class CorpusStore {
  /** @param {{corpusDir: string}} options */
  constructor({ corpusDir }) {
    this.corpusDir = path.resolve(corpusDir);
    this.manifestPath = path.join(this.corpusDir, 'manifest.json');
    this.manifest = null;
    this.manifestError = null;
    this.lastAttemptAt = 0;
    this.loadingPromise = null;
    this.chapterCache = new Map();
    this.chapterLoading = new Map();
  }

  /** 清空缓存（测试/热更新用）。 */
  resetCache() {
    this.manifest = null;
    this.manifestError = null;
    this.lastAttemptAt = 0;
    this.loadingPromise = null;
    this.chapterCache.clear();
    this.chapterLoading.clear();
  }

  /**
   * 读取并校验 manifest；失败时抛 CorpusError（500，中文说明）。
   * 失败后 2 秒内直接复用错误，超过冷却期会重新尝试读取（语料可能刚生成）。
   */
  async getManifest() {
    if (this.manifest) return this.manifest;
    if (this.manifestError && Date.now() - this.lastAttemptAt < RELOAD_COOLDOWN_MS) {
      throw new CorpusError(this.manifestError, 'SERVER_ERROR');
    }
    if (this.loadingPromise) return this.loadingPromise;
    this.loadingPromise = this.loadManifest().finally(() => {
      this.loadingPromise = null;
    });
    return this.loadingPromise;
  }

  async loadManifest() {
    this.lastAttemptAt = Date.now();
    let text;
    try {
      text = await fsp.readFile(this.manifestPath, 'utf8');
    } catch (error) {
      this.manifestError = error && error.code === 'ENOENT'
        ? `语料尚未就绪：未找到 ${this.manifestPath}。请先运行 python scripts/build_corpus.py 生成语料。`
        : `读取语料 manifest 失败（${(error && error.code) || 'ERROR'}）：${this.manifestPath}`;
      throw new CorpusError(this.manifestError, 'SERVER_ERROR');
    }

    let manifest;
    try {
      manifest = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
      this.manifestError = `语料 manifest.json 不是合法 JSON：${this.manifestPath}`;
      throw new CorpusError(this.manifestError, 'SERVER_ERROR');
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || !Array.isArray(manifest.books)) {
      this.manifestError = `语料 manifest.json 结构异常（缺少 books 数组）：${this.manifestPath}`;
      throw new CorpusError(this.manifestError, 'SERVER_ERROR');
    }

    this.manifest = manifest;
    this.manifestError = null;
    return manifest;
  }

  /** 健康检查用统计；语料不可用时返回 0，不抛错。 */
  async getStats() {
    try {
      const manifest = await this.getManifest();
      let chapters = 0;
      let sentences = 0;
      for (const book of manifest.books) {
        if (!book || typeof book !== 'object') continue;
        if (Array.isArray(book.chapters)) chapters += book.chapters.length;
        if (Number.isFinite(Number(book.sentenceCount))) sentences += Number(book.sentenceCount);
      }
      return { books: manifest.books.length, chapters, sentences };
    } catch {
      return { books: 0, chapters: 0, sentences: 0 };
    }
  }

  /** 校验 bookId 并返回 manifest 中的书对象；不存在/非法 → CorpusError(NOT_FOUND)。 */
  async getBook(bookId) {
    if (typeof bookId !== 'string' || !BOOK_ID_RE.test(bookId)) {
      throw new CorpusError(`书不存在：${shortInput(bookId)}`, 'NOT_FOUND');
    }
    const manifest = await this.getManifest();
    const book = manifest.books.find((item) => item && item.id === bookId);
    if (!book) throw new CorpusError(`书不存在：${bookId}`, 'NOT_FOUND');
    return book;
  }

  /** 校验章节文件路径必须落在语料目录内。 */
  safeCorpusPath(relPath) {
    if (typeof relPath !== 'string' || !relPath.trim()) {
      throw new CorpusError('语料章节文件路径缺失，manifest.json 可能已损坏。', 'SERVER_ERROR');
    }
    if (relPath.includes('\0')) {
      throw new CorpusError('语料章节文件路径非法。', 'SERVER_ERROR');
    }
    const normalized = relPath.replace(/\\/g, '/');
    const absolute = path.resolve(this.corpusDir, normalized);
    const rootWithSep = this.corpusDir.endsWith(path.sep) ? this.corpusDir : this.corpusDir + path.sep;
    if (absolute !== this.corpusDir && !absolute.startsWith(rootWithSep)) {
      throw new CorpusError('语料章节文件路径非法（疑似路径穿越），已拒绝读取。', 'SERVER_ERROR');
    }
    return absolute;
  }

  /** 读取章文件（带缓存）。不存在/损坏 → CorpusError。 */
  async getChapter(bookId, chapterIndex) {
    const book = await this.getBook(bookId);
    const index = parseInteger(chapterIndex);
    if (!Number.isInteger(index) || index < 1) {
      throw new CorpusError(`章节不存在：${shortInput(bookId)} 第 ${shortInput(chapterIndex)} 章`, 'NOT_FOUND');
    }
    const chapterMeta = Array.isArray(book.chapters)
      ? book.chapters.find((item) => item && Number(item.index) === index)
      : null;
    if (!chapterMeta) {
      throw new CorpusError(`章节不存在：${shortInput(bookId)} 第 ${shortInput(chapterIndex)} 章`, 'NOT_FOUND');
    }

    const cacheKey = `${bookId}/${index}`;
    if (this.chapterCache.has(cacheKey)) return this.chapterCache.get(cacheKey);
    if (this.chapterLoading.has(cacheKey)) return this.chapterLoading.get(cacheKey);

    const relPath = typeof chapterMeta.file === 'string' && chapterMeta.file.trim()
      ? chapterMeta.file
      : `${bookId}/chapter-${String(index).padStart(3, '0')}.json`;
    const absolutePath = this.safeCorpusPath(relPath);

    const loading = (async () => {
      let text;
      try {
        text = await fsp.readFile(absolutePath, 'utf8');
      } catch (error) {
        throw new CorpusError(
          `章节文件读取失败（${(error && error.code) || 'ERROR'}）：${relPath}`,
          'SERVER_ERROR',
        );
      }
      let chapter;
      try {
        chapter = JSON.parse(text.replace(/^\uFEFF/, ''));
      } catch {
        throw new CorpusError(`章节文件不是合法 JSON：${relPath}`, 'SERVER_ERROR');
      }
      if (!chapter || typeof chapter !== 'object' || !Array.isArray(chapter.paragraphs)) {
        throw new CorpusError(`章节文件结构异常（缺少 paragraphs 数组）：${relPath}`, 'SERVER_ERROR');
      }
      if (chapter.bookId !== undefined && chapter.bookId !== bookId) {
        throw new CorpusError(`章节文件 bookId 与 manifest 不一致：${relPath}`, 'SERVER_ERROR');
      }
      if (chapter.chapterIndex !== undefined && Number(chapter.chapterIndex) !== index) {
        throw new CorpusError(`章节文件 chapterIndex 与 manifest 不一致：${relPath}`, 'SERVER_ERROR');
      }
      this.chapterCache.set(cacheKey, chapter);
      return chapter;
    })().finally(() => {
      this.chapterLoading.delete(cacheKey);
    });

    this.chapterLoading.set(cacheKey, loading);
    return loading;
  }

  /** 读取段落（含权威英文原句）。不存在 → CorpusError(NOT_FOUND)。 */
  async getParagraph(bookId, chapterIndex, paragraphIndex) {
    const chapter = await this.getChapter(bookId, chapterIndex);
    const index = parseInteger(paragraphIndex);
    if (!Number.isInteger(index) || index < 0) {
      throw new CorpusError(`段落不存在：第 ${shortInput(paragraphIndex)} 段`, 'NOT_FOUND');
    }
    const paragraph = chapter.paragraphs[index];
    if (!paragraph) {
      throw new CorpusError(
        `段落不存在：第 ${index} 段（本章共 ${chapter.paragraphs.length} 段）`,
        'NOT_FOUND',
      );
    }
    return {
      book: await this.getBook(bookId),
      chapter,
      paragraph,
      sentences: paragraphSentences(paragraph),
    };
  }

  /** 取上一段/下一段原句（可选上下文，供提示词用）。 */
  async getNeighborSourceText(bookId, chapterIndex, paragraphIndex, offset) {
    const chapter = await this.getChapter(bookId, chapterIndex);
    const target = Number(paragraphIndex) + offset;
    if (!Number.isInteger(target) || target < 0 || target >= chapter.paragraphs.length) return '';
    return paragraphSourceText(chapter.paragraphs[target]);
  }
}
