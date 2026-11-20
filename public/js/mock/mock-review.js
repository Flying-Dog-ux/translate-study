/**
 * 演示模式（mock）的批改结果生成器。
 * 目标：在没有后端 / API Key 时也能完整演示「AI 批改」面板的全部字段与状态。
 * 输出结构与 docs/CONTRACT.md §4.3 完全一致；内容为本地规则生成，不是真实 AI 结果。
 */

import { hashString, mulberry32, pickEnglishWord } from '../utils.js';

const SUMMARY_POOL = {
  excellent: [
    '整段理解准确，中文表达也相当自然，句子之间的衔接顺畅。可以再留意个别词语的语感，让译文更贴近中文读者的阅读习惯。',
    '译文完成度很高，信息完整、语气也把握得不错。若能在长句里适当调整语序，读起来会更从容。',
  ],
  good: [
    '整体理解到位，主要信息都传达出来了。个别词语和语序还可以再打磨，特别是让中文的句子节奏更自然一些。',
    '译文基本准确，能读懂原文的意思。部分表达稍显直译，建议多读一遍中文，看看是否符合中文的说话顺序。',
  ],
  needs_improvement: [
    '主要信息大体译出，但有几处词语理解偏差和语序问题，影响了中文的通顺度。建议对照逐句建议译文，重点看标注的问题。',
    '本段能看出你理解了原文大意，不过部分句子还是英文语序的直译。建议先把每句的主干找出来，再用中文重新组织。',
  ],
  incorrect: [
    '本段的翻译与原文有较大出入，部分句子可能理解错了主语或动作方向。建议先回到原文，逐句确认主干信息后再尝试。',
    '译文漏掉了不少关键信息，个别句子偏离原意。可以先看参考译法，理解之后再自己重译一遍。',
  ],
  missing: [
    '本段还没有填写译文，以下为逐句参考译法与关键词汇，供你先打一个草稿。',
  ],
};

const COMMENT_POOL = {
  good: [
    '理解正确，句子结构也处理得比较顺。',
    '意思传达完整，中文读起来不拗口。',
    '这一句处理得不错，信息点齐全。',
  ],
  needs_improvement: [
    '主干信息没问题，但中文语序还可以更自然。',
    '意思大致译出来了，个别词语可以考虑更贴切的表达。',
    '建议先译出「谁做了什么」，再补状语和修饰成分。',
  ],
  excellent: [
    '译得很自然，像中文原生的表达。',
    '用词准确，语气也贴合原文的叙述节奏。',
    '这一句可以作为范本，注意保持这种语感。',
  ],
  incorrect: [
    '这一句的主语 / 动作关系需要再确认一下原文。',
    '译文和原文的意思有明显偏差，建议对照参考译法重译。',
  ],
  missing: [
    '这一句还没有译文，建议先自己写一版，再对照参考译法。',
    '空白句不会扣分，但练习效果会打折扣，试着写完整吧。',
  ],
};

const TIP_POOL = [
  '先分清主句与从句，再决定中文的断句位置；长句不必强行译成一个长句。',
  '英文代词在中文里往往要还原成具体的人或物，否则读者会失去指代对象。',
  '对话中的语气可以适度用中文口语词润色，不必逐字对应英文句式。',
  '遇到插入语（同位语、定语从句）时，中文可以先拆成短句，再用「他 / 这」来承接。',
  '不要为了对应英文词性而硬造名词化结构，中文里动词优先通常更自然。',
  '人名、地名首次出现时可以保留英文，后续统一用中文译名，避免前后不一致。',
  '翻译完成后出声读一遍：中文里读着别扭的地方，通常就是需要调整语序的地方。',
];

const VOCAB_POOL = [
  { term: 'thank you very much', meaning: '（这里）说得好听点；还真是', note: '英式口语中的反讽，常用于强调自己接下来说的话。' },
  { term: 'hold with', meaning: '赞同；容忍', note: '英式旧式表达，多用于否定句：not hold with sth。' },
  { term: 'beefy', meaning: '魁梧的；壮实的', note: '口语里形容人块头大、肌肉多，不是「像牛肉的」。' },
  { term: 'crane over', meaning: '伸长脖子（越过……）看', note: 'crane 本义是「鹤」，作动词时表示探头张望。' },
  { term: 'good-for-nothing', meaning: '一无是处的；不务正业的', note: '带贬义的口语表达，可作形容词也可作名词。' },
  { term: 'shudder to think', meaning: '一想到……就不寒而栗', note: '固定表达，后面常接 what / how 引导的从句。' },
  { term: 'tawny', meaning: '黄褐色的', note: '多用于形容动物毛色，如 tawny owl（灰林鸮）。' },
  { term: 'mantelpiece', meaning: '壁炉架', note: '英美家庭常在上面摆放照片、钟表和摆件。' },
  { term: 'shrill', meaning: '尖利的；刺耳的', note: '常形容声音或嗓音，shrill voice 是常见搭配。' },
  { term: 'screech', meaning: '尖声叫喊', note: '比 shout 更刺耳，常指人或动物发出的尖叫。' },
  { term: 'creep into', meaning: '悄悄溜进；不知不觉地进入', note: '主语常是光线、声音、感觉等抽象事物。' },
  { term: 'be no longer a baby', meaning: '不再是婴儿了', note: 'no longer 表示状态的改变，注意别译成「不再是个宝宝」的口语腔。' },
];

const ISSUE_TEMPLATES = [
  (word) => ({ type: '用词', detail: `“${word}” 在这个语境里更接近具体动作，直译会显得生硬，建议换成更自然的中文说法。` }),
  () => ({ type: '语序', detail: '英文状语的位置直接搬到中文里不顺，中文习惯把时间 / 方式状语放在动作之前。' }),
  (word) => ({ type: '搭配', detail: `“${word}” 的中文搭配不太自然，可以换一个更常用的动词或介词组合。` }),
  () => ({ type: '语气', detail: '叙述句的语气偏硬，中文里可以加一点语气词或调整句末节奏，读起来更从容。' }),
  () => ({ type: '冗余', detail: '译文里有一些可以从上下文推出来的重复信息，中文表达可以更简洁。' }),
];

function normalize(value, length) {
  const source = Array.isArray(value) ? value : [];
  return Array.from({ length }, (_, i) => (typeof source[i] === 'string' ? source[i] : ''));
}

function clampScore(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function pickWith(rand) {
  return (list) => list[Math.floor(rand() * list.length) % list.length];
}

/**
 * 生成 mock 批改结果。
 * @param {{chapter: object, paragraph: object, translations: string[], reference?: {sentences: string[], notes?: object}}} options
 */
export function buildMockReview({ chapter, paragraph, translations, reference }) {
  const sources = (paragraph?.sentences || []).map((sentence) => String(sentence?.text ?? ''));
  const total = sources.length;
  const translationList = normalize(translations, total);
  const references = arrayReferences(reference, total);
  const translatedCount = translationList.filter((text) => text.trim()).length;
  const missingCount = total - translatedCount;
  const seed = hashString(`${chapter?.bookId || 'hp1'}:${chapter?.chapterIndex || 1}:${paragraph?.index || 0}:${translationList.join('|')}`);
  const rand = mulberry32(seed);
  const pick = pickWith(rand);

  let score;
  if (translatedCount === 0) score = 8 + Math.floor(rand() * 8);
  else score = clampScore(38 + (translatedCount / total) * 46 + rand() * 12);
  if (missingCount > 0 && translatedCount > 0) score = Math.min(score, 76);

  const verdict = score >= 86
    ? 'excellent'
    : score >= 70
      ? 'good'
      : score >= 45
        ? 'needs_improvement'
        : translatedCount === 0
          ? 'missing'
          : 'incorrect';

  const summaryPool = SUMMARY_POOL[verdict] || SUMMARY_POOL.good;
  let summary = pick(summaryPool);
  if (missingCount > 0 && translatedCount > 0) {
    summary = `本段共 ${total} 句，其中 ${missingCount} 句尚未翻译。已译部分的理解基本准确，建议先补全空白句，再对照逐句建议打磨表达。`;
  }

  const pattern = ['good', 'needs_improvement', 'excellent', 'good', 'needs_improvement', 'incorrect'];
  const sentences = sources.map((source, index) => {
    const userText = translationList[index];
    if (!userText.trim()) {
      return {
        index,
        verdict: 'missing',
        issues: [{ type: '漏译', detail: '这一句还没有填写译文，批改时按未翻译处理。' }],
        suggestion: references[index] || '',
        comment: pick(COMMENT_POOL.missing),
      };
    }
    let sentenceVerdict = pattern[(index + Math.floor(rand() * pattern.length)) % pattern.length];
    // 有些句子在演示里保持稳定：第一句通常是 good，第二句通常给一处具体建议
    if (index === 0 && score >= 45) sentenceVerdict = 'good';
    if (index === 1 && total > 1 && score < 90) sentenceVerdict = 'needs_improvement';
    if (sentenceVerdict === 'incorrect' && score >= 70) sentenceVerdict = 'needs_improvement';
    const word = pickEnglishWord(source) || '关键词';
    const issueCount = sentenceVerdict === 'incorrect' ? 2 : sentenceVerdict === 'needs_improvement' ? (rand() > 0.45 ? 2 : 1) : 0;
    const issues = [];
    const usedTemplates = new Set();
    for (let i = 0; i < issueCount; i += 1) {
      let templateIndex = Math.floor(rand() * ISSUE_TEMPLATES.length);
      let guard = 0;
      while (usedTemplates.has(templateIndex) && guard < 8) { templateIndex = (templateIndex + 1) % ISSUE_TEMPLATES.length; guard += 1; }
      usedTemplates.add(templateIndex);
      issues.push(ISSUE_TEMPLATES[templateIndex](word));
    }
    return {
      index,
      verdict: sentenceVerdict,
      issues,
      suggestion: references[index] || '',
      comment: pick(COMMENT_POOL[sentenceVerdict] || COMMENT_POOL.good),
    };
  });

  const revisedParagraph = references.every(Boolean)
    ? references.join('')
    : sentences.map((sentence) => sentence.suggestion).filter(Boolean).join('');

  const sourceLower = sources.join(' ').toLowerCase();
  const contextVocab = VOCAB_POOL.filter((item) => sourceLower.includes(item.term.toLowerCase()));
  const vocabulary = [];
  for (const item of contextVocab) {
    if (vocabulary.length >= 3) break;
    vocabulary.push({ ...item });
  }
  while (vocabulary.length < Math.min(3, VOCAB_POOL.length)) {
    const candidate = VOCAB_POOL[Math.floor(rand() * VOCAB_POOL.length)];
    if (!vocabulary.some((item) => item.term === candidate.term)) vocabulary.push({ ...candidate });
  }

  const tips = [];
  while (tips.length < 3) {
    const tip = TIP_POOL[Math.floor(rand() * TIP_POOL.length)];
    if (!tips.includes(tip)) tips.push(tip);
  }

  const dimensions = [
    { id: 'accuracy', label: '准确', score: clampScore(score + (rand() * 12 - 6)) },
    { id: 'fluency', label: '通顺', score: clampScore(score + (rand() * 14 - 7)) },
    { id: 'style', label: '文风', score: clampScore(score + (rand() * 16 - 8)) },
  ];

  const promptTokens = 780 + Math.floor(rand() * 260);
  const completionTokens = 620 + Math.floor(rand() * 380);
  return {
    ok: true,
    review: {
      overall: {
        score,
        verdict,
        summary,
        dimensions,
      },
      sentences,
      revisedParagraph,
      vocabulary,
      tips,
    },
    meta: {
      model: 'deepseek-chat（本地演示）',
      elapsedMs: 1800 + Math.floor(rand() * 2400),
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    },
  };
}

function arrayReferences(reference, length) {
  const values = Array.isArray(reference)
    ? reference
    : Array.isArray(reference?.sentences)
      ? reference.sentences
      : [];
  return Array.from({ length }, (_, i) => (typeof values[i] === 'string' ? values[i] : ''));
}

/** mock 参考译文的句子备注 */
export function buildMockReference({ reference, paragraph }) {
  const sentences = arrayReferences(reference?.sentences, (paragraph?.sentences || []).length);
  const notes = reference?.notes && typeof reference.notes === 'object' ? reference.notes : {};
  return {
    ok: true,
    reference: {
      translation: sentences.join(''),
      sentences: sentences.map((translation, index) => ({
        index,
        translation,
        ...(notes[String(index)] ? { note: String(notes[String(index)]) } : {}),
      })),
    },
    meta: {
      model: 'deepseek-chat（本地演示）',
      elapsedMs: 900,
      usage: { prompt_tokens: 300, completion_tokens: 420, total_tokens: 720 },
    },
  };
}
