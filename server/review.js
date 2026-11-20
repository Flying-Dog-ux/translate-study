/**
 * AI 输出归一化/校验。
 *
 * DeepSeek 的 json_object 模式只能保证「是合法 JSON」，不能保证字段齐全、
 * 类型正确、句数与原文对齐。本模块把任意形状的 JSON 归一化成前端可安全渲染的固定结构：
 * - 缺字段补默认值；
 * - overall.score 夹在 0-100；
 * - sentences 长度补齐到原文句数（空译文强制 verdict=missing）；
 * - 非法 verdict 归到 needs_improvement；
 * - issues / vocabulary / tips 过滤非法项。
 */

export const VERDICTS = ['excellent', 'good', 'needs_improvement', 'incorrect', 'missing'];
export const OVERALL_VERDICTS = ['excellent', 'good', 'needs_improvement', 'incorrect'];
export const ISSUE_TYPES = ['漏译', '误译', '用词', '搭配', '语法', '语序', '语气', '文化', '标点', '冗余'];
export const DIMENSIONS = [
  { id: 'accuracy', label: '准确' },
  { id: 'fluency', label: '通顺' },
  { id: 'style', label: '文风' },
];

const MIN_SCORE = 0;
const MAX_SCORE = 100;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toClampedInt(value, fallback = 0, min = MIN_SCORE, max = MAX_SCORE) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(Math.min(max, Math.max(min, number)));
}

function toText(value, fallback = '') {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeVerdict(value, allowed, fallback) {
  const verdict = toText(value).toLowerCase().replace(/[\s-]+/g, '_');
  return allowed.includes(verdict) ? verdict : fallback;
}

function normalizeIssue(raw) {
  if (typeof raw === 'string') {
    const detail = raw.trim();
    return detail ? { type: '其他', detail } : null;
  }
  if (!isPlainObject(raw)) return null;
  const detail = toText(raw.detail) || toText(raw.message) || toText(raw.description);
  if (!detail) return null;
  const type = toText(raw.type);
  return { type: type || '其他', detail };
}

function normalizeSentence(raw, index, translation) {
  const source = isPlainObject(raw) ? raw : {};
  const hasTranslation = typeof translation === 'string' && translation.trim().length > 0;
  let verdict = normalizeVerdict(source.verdict, VERDICTS, 'needs_improvement');
  // 契约：用户未翻译（空串）必须标为 missing；有译文却标 missing 是不合理的，归到 needs_improvement。
  if (!hasTranslation) verdict = 'missing';
  else if (verdict === 'missing') verdict = 'needs_improvement';

  const issues = toArray(source.issues).map(normalizeIssue).filter(Boolean).slice(0, 6);
  const suggestion = toText(source.suggestion);
  let comment = toText(source.comment);
  if (!comment) {
    comment = verdict === 'missing' ? '这一句还未翻译，可先参考建议译文，再自己写一遍。' : '';
  }
  return { index, verdict, issues, suggestion, comment };
}

function normalizeOverall(raw, sentenceResults) {
  const source = isPlainObject(raw) ? raw : {};
  const score = toClampedInt(source.score, 0);
  const verdict = normalizeVerdict(source.verdict, OVERALL_VERDICTS, 'needs_improvement');

  const rawDimensions = toArray(source.dimensions);
  const dimensions = DIMENSIONS.map(({ id, label }, position) => {
    const matched = rawDimensions.find((item) => isPlainObject(item) && toText(item.id) === id)
      ?? rawDimensions[position];
    return { id, label, score: toClampedInt(isPlainObject(matched) ? matched.score : undefined, score) };
  });

  let summary = toText(source.summary);
  if (!summary) {
    const missingCount = sentenceResults.filter((item) => item.verdict === 'missing').length;
    if (score >= 85) summary = '整体表达准确流畅，理解到位，继续保持。';
    else if (score >= 70) summary = '整体理解基本准确，个别用词和中文表达还可以更地道。';
    else summary = '译文能看出大意，但准确性和通顺度还有较大提升空间，建议逐句对照修改。';
    if (missingCount > 0) summary += ` 本段还有 ${missingCount} 句未翻译，建议先补全再打磨。`;
  }
  return { score, verdict, summary, dimensions };
}

function normalizeVocabulary(raw) {
  return toArray(raw)
    .map((item) => {
      if (!isPlainObject(item)) return null;
      const term = toText(item.term);
      if (!term) return null;
      return {
        term,
        meaning: toText(item.meaning),
        note: toText(item.note),
      };
    })
    .filter(Boolean)
    .slice(0, 20);
}

/**
 * 归一化段落批改结果。
 * @param {unknown} raw DeepSeek 返回的 JSON
 * @param {number} sentenceCount 权威原文句数
 * @param {string[]} translations 用户逐句译文（用于判定 missing）
 */
export function normalizeReview(raw, sentenceCount, translations = []) {
  const count = toClampedInt(sentenceCount, 0, 0, 5000);
  const source = isPlainObject(raw) ? raw : {};
  const translationList = Array.isArray(translations) ? translations : [];
  const rawSentences = toArray(source.sentences);

  const sentences = [];
  for (let index = 0; index < count; index += 1) {
    const matched = rawSentences.find((item) => isPlainObject(item) && Number(item.index) === index)
      ?? rawSentences[index];
    sentences.push(normalizeSentence(matched, index, translationList[index]));
  }

  const overall = normalizeOverall(source.overall, sentences);

  const suggestionText = sentences.map((item) => item.suggestion).filter(Boolean).join('');
  const revisedParagraph = toText(source.revisedParagraph)
    || suggestionText
    || '本段参考译文暂缺（AI 返回内容不完整），请点击「重新批改」再试一次。';

  const vocabulary = normalizeVocabulary(source.vocabulary);
  const tips = toArray(source.tips)
    .map((item) => toText(item))
    .filter(Boolean)
    .slice(0, 5);

  return {
    overall,
    sentences,
    revisedParagraph,
    vocabulary,
    tips: tips.length > 0 ? tips : ['先通读整段，确认每句意思都译到了，再打磨中文表达。'],
  };
}

/**
 * 归一化参考译文。
 * @param {unknown} raw DeepSeek 返回的 JSON
 * @param {number} sentenceCount 权威原文句数
 */
export function normalizeReference(raw, sentenceCount) {
  const count = toClampedInt(sentenceCount, 0, 0, 5000);
  const source = isPlainObject(raw) ? raw : {};
  const rawSentences = toArray(source.sentences);

  const sentences = [];
  for (let index = 0; index < count; index += 1) {
    const matched = rawSentences.find((item) => isPlainObject(item) && Number(item.index) === index)
      ?? rawSentences[index];
    const sentence = isPlainObject(matched) ? matched : {};
    sentences.push({
      index,
      translation: toText(sentence.translation),
      note: toText(sentence.note),
    });
  }

  let translation = toText(source.translation);
  if (!translation) translation = sentences.map((item) => item.translation).join('');
  return { translation, sentences };
}

/**
 * 归一化单词/短语讲解。
 * @param {unknown} raw DeepSeek 返回的 JSON
 * @param {string} fallbackWord 请求里的原词（AI 未回填时兜底）
 */
export function normalizeWord(raw, fallbackWord = '') {
  const source = isPlainObject(raw) ? raw : {};
  const meanings = toArray(source.meanings)
    .map((item) => {
      if (!isPlainObject(item)) return null;
      const cn = toText(item.cn);
      if (!cn) return null;
      return { pos: toText(item.pos), cn };
    })
    .filter(Boolean)
    .slice(0, 10);
  const examples = toArray(source.examples)
    .map((item) => {
      if (!isPlainObject(item)) return null;
      const en = toText(item.en);
      if (!en) return null;
      return { en, cn: toText(item.cn) };
    })
    .filter(Boolean)
    .slice(0, 10);

  return {
    word: toText(source.word) || toText(fallbackWord),
    phonetic: toText(source.phonetic),
    meanings: meanings.length > 0 ? meanings : [{ pos: '', cn: '暂无释义，请重试。' }],
    explanation: toText(source.explanation),
    examples,
  };
}
