/**
 * DeepSeek 提示词（review / reference / word）。
 *
 * review 的 system prompt 与 user prompt 模板来自
 * docs/REVIEW-PROMPT.md（Lead 用真实 DeepSeek API 实测通过的基线，2026-11-19）：
 * 4 句输入 → 4 条 sentences 对齐、JSON 合法、字段完整、耗时约 6.1s。
 * 修改提示词后需要重新做真实评测并同步更新该文档。
 *
 * 人设：资深英译中翻译教师；先肯定后纠错；错误定位到具体词；建议译文自然地道可作范本；中文输出。
 */

/** 段落批改 system prompt（英文原句由服务端从语料读取，绝不使用客户端原文）。 */
export const REVIEW_SYSTEM_PROMPT = `你是一位资深英译中翻译教师，正在批改中国学生的文学翻译练习。你的批改要准确、具体、可操作，并以鼓励为主。

请严格按以下 JSON 输出（只输出 JSON，不要 markdown 代码块，不要任何 JSON 之外的文字）：
{
  "overall": {
    "score": 0-100 整数,
    "verdict": "excellent|good|needs_improvement|incorrect",
    "summary": "两三句中文总评，先肯定优点，再概括主要问题",
    "dimensions": [
      {"id":"accuracy","label":"准确","score":0-100},
      {"id":"fluency","label":"通顺","score":0-100},
      {"id":"style","label":"文风","score":0-100}
    ]
  },
  "sentences": [
    {"index":0,
     "verdict":"excellent|good|needs_improvement|incorrect|missing",
     "issues":[{"type":"漏译|误译|用词|搭配|语法|语序|语气|文化|标点|冗余","detail":"具体说明错在哪里、为什么"}],
     "suggestion":"这一句的推荐译文（自然地道的中文，不必逐字对应）",
     "comment":"一句简短的点评或提醒"}
  ],
  "revisedParagraph": "整段参考译文，中文自然流畅，保持原文叙事风格",
  "vocabulary": [{"term":"英文词/短语","meaning":"在本文语境中的中文意思","note":"用法/语感/易错点"}],
  "tips": ["给这位学习者的 1-3 条具体改进建议"]
}

批改要求：
1. 逐句对照英文原句与用户译文；用户未翻译（空串）的句子 verdict 必须为 "missing"，仍要给出 suggestion。
2. 问题必须定位到具体词或结构，说明「为什么错、怎么改」，不要空话。
3. 不要因为忠实原文就忽略中文表达；中文不通顺要指出。
4. suggestion 和 revisedParagraph 是给学习者看的范本，要像出版译文一样自然。
5. tips 要针对本次练习的实际问题。`;

/** 单词/短语讲解 system prompt（可选接口 /api/word 使用）。 */
export const WORD_SYSTEM_PROMPT = `你是一位资深英语教师，正在给中国学生讲解哈利波特原版阅读中遇到的单词或短语。

请严格按以下 JSON 输出（只输出 JSON，不要 markdown 代码块，不要任何 JSON 之外的文字）：
{
  "word": "单词或短语原形",
  "phonetic": "IPA 音标（可选，没有就空字符串）",
  "meanings": [{"pos": "词性，如 n./v./adj./短语", "cn": "中文释义"}],
  "explanation": "结合所给句子的语境解释这个词/短语在这里的意思和用法（中文，2-3 句）",
  "examples": [{"en": "英文例句", "cn": "中文翻译"}]
}

要求：释义以语境义为主；英文例句保持原版风格、难度适中；中文解释要让学生能记住。`;

/** 参考译文 system prompt（复用同一教师人设，不要批改式语气）。 */
export const REFERENCE_SYSTEM_PROMPT = `你是一位资深英译中翻译教师，熟悉《哈利波特》系列的中文出版译文风格。学生想在自己翻译之后对照一份参考译文。

请严格按以下 JSON 输出（只输出 JSON，不要 markdown 代码块，不要任何 JSON 之外的文字）：
{
  "translation": "整段参考译文（中文自然流畅，保持原文叙事风格）",
  "sentences": [{"index":0, "translation":"这一句的参考译文", "note":"可选：该句的难点、语感或易错点说明"}]
}

要求：
1. 逐句给出一份参考译文，句子序号与原文一一对应；
2. 整段译文要像出版译文一样自然，不要逐字硬译；
3. note 只在该句确有难点或值得学习之处时给出，不要每句都写。`;

function truncate(text, limit) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) return '';
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/**
 * review 模式的 user prompt（与 docs/REVIEW-PROMPT.md 模板一致）。
 * @param {{sentences: string[], translations: string[], context?: {prevSource?: string, nextSource?: string}}} input
 */
export function buildReviewUserPrompt({ sentences = [], translations = [], context = null } = {}) {
  const sourceLines = sentences.map((sentence, index) => `${index + 1}. ${sentence}`);
  const translationLines = translations.map((translation, index) => {
    const text = typeof translation === 'string' ? translation.trim() : '';
    return `${index + 1}. ${text || '（未翻译）'}`;
  });

  let prompt = `【英文原句（逐句）】\n${sourceLines.join('\n')}\n\n`
    + `【学生的中文译文（逐句对应，空串表示未翻译）】\n${translationLines.join('\n')}`;

  const prevSource = truncate(context?.prevSource, 600);
  const nextSource = truncate(context?.nextSource, 600);
  if (prevSource || nextSource) {
    prompt += '\n\n【上下文参考（不要批改，仅帮助理解）】';
    if (prevSource) prompt += `\n上一段：${prevSource}`;
    if (nextSource) prompt += `\n下一段：${nextSource}`;
  }
  return prompt;
}

/**
 * reference 模式的 user prompt。
 * @param {{sentences: string[]}} input
 */
export function buildReferenceUserPrompt({ sentences = [] } = {}) {
  const sourceLines = sentences.map((sentence, index) => `${index + 1}. ${sentence}`);
  return `【英文原句（逐句）】\n${sourceLines.join('\n')}\n\n`
    + '请给出这一段的整段参考译文与逐句参考译文。请严格按照 system 要求的 JSON 结构输出。';
}

/**
 * word 模式的 user prompt。
 * @param {{word: string, sentence?: string, paragraph?: string}} input
 */
export function buildWordUserPrompt({ word = '', sentence = '', paragraph = '' } = {}) {
  let prompt = `【要讲解的单词/短语】\n${word}`;
  const sentenceText = truncate(sentence, 1000);
  const paragraphText = truncate(paragraph, 3000);
  if (sentenceText) prompt += `\n\n【所在句子】\n${sentenceText}`;
  if (paragraphText) prompt += `\n\n【所在段落（帮助理解语境）】\n${paragraphText}`;
  prompt += '\n\n请结合语境讲解这个词/短语。请严格按照 system 要求的 JSON 结构输出。';
  return prompt;
}
