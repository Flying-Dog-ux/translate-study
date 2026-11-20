/** AI 批改结果面板：完整渲染 /api/review 返回的 review 结构（docs/CONTRACT.md §4.3） */

import { clamp, el, formatClock, formatDateTime, formatElapsed } from '../utils.js';
import { icon } from '../icons.js';
import { VERDICTS } from '../constants.js';
import { copyWithToast, progressRing, spinner } from '../ui.js';

export function verdictBadge(verdict, extraClass = '') {
  const meta = VERDICTS[verdict] || { label: verdict || '未知', cls: 'missing' };
  return el('span', { class: `verdict verdict--${meta.cls} ${extraClass}`.trim(), text: meta.label });
}

function scoreTone(score) {
  if (score >= 80) return 'high';
  if (score >= 60) return 'mid';
  return 'low';
}

function dimensionRow(dimension) {
  const score = clamp(Number(dimension?.score) || 0, 0, 100);
  return el(
    'div',
    { class: 'dimension-row' },
    el('span', { class: 'dimension-label', text: dimension?.label || dimension?.id || '—' }),
    el(
      'span',
      { class: 'dimension-track', attrs: { 'aria-hidden': 'true' } },
      el('span', { class: `dimension-fill dimension-fill--${scoreTone(score)}`, style: { width: `${score}%` } }),
    ),
    el('span', { class: 'dimension-score', text: String(score) }),
  );
}

function copyButton(getText, label = '译文') {
  return el(
    'button',
    {
      class: 'icon-btn copy-btn',
      attrs: { type: 'button', 'aria-label': `复制${label}`, title: `复制${label}` },
      on: { click: (event) => { event.preventDefault(); event.stopPropagation(); copyWithToast(getText(), label); } },
    },
    icon('copy', { size: 15 }),
  );
}

function sentenceReviewItem(sentence, index) {
  const verdict = sentence?.verdict || 'missing';
  const meta = VERDICTS[verdict] || VERDICTS.missing;
  const issues = Array.isArray(sentence?.issues) ? sentence.issues : [];
  const suggestion = typeof sentence?.suggestion === 'string' ? sentence.suggestion : '';
  const comment = typeof sentence?.comment === 'string' ? sentence.comment : '';
  const item = el(
    'article',
    { class: `sentence-review sentence-review--${meta.cls}` },
    el(
      'div',
      { class: 'sentence-review-head' },
      el('span', { class: 'sentence-review-no', text: `第 ${index + 1} 句` }),
      verdictBadge(verdict),
      comment ? el('span', { class: 'sentence-review-comment', text: comment }) : null,
    ),
    issues.length
      ? el(
        'div',
        { class: 'issue-chips' },
        ...issues.map((issue) => el(
          'span',
          { class: 'issue-chip' },
          issue?.type ? el('b', { class: 'issue-chip-type', text: String(issue.type) }) : null,
          el('span', { text: issue?.detail || '' }),
        )),
      )
      : null,
    suggestion
      ? el(
        'div',
        { class: 'suggestion' },
        el(
          'div',
          { class: 'suggestion-body' },
          el('span', { class: 'suggestion-label' }, icon('quote', { size: 13 }), '建议译文'),
          el('p', { class: 'suggestion-text', text: suggestion }),
        ),
        copyButton(() => suggestion, '建议译文'),
      )
      : null,
  );
  return item;
}

/**
 * 渲染完整的批改面板。
 * @param {{review: object, meta?: object, reviewedAt?: string|number|Date|null, onClose?: Function, onRerun?: Function, rerunning?: boolean}} options
 */
export function renderReviewPanel({ review, meta = null, reviewedAt = null, onClose = null, onRerun = null } = {}) {
  const overall = review?.overall || {};
  const score = clamp(Number(overall.score) || 0, 0, 100);
  const verdict = overall.verdict || 'good';
  const dimensions = Array.isArray(overall.dimensions) ? overall.dimensions : [];
  const sentences = Array.isArray(review?.sentences) ? review.sentences : [];
  const revisedParagraph = typeof review?.revisedParagraph === 'string' ? review.revisedParagraph : '';
  const vocabulary = Array.isArray(review?.vocabulary) ? review.vocabulary : [];
  const tips = Array.isArray(review?.tips) ? review.tips : [];
  const tone = scoreTone(score);

  const panel = el('div', { class: 'review-panel' });

  /* 头部：总分环 + verdict + 总评 + 三维度 */
  const closeButton = el(
    'button',
    {
      class: 'icon-btn panel-close',
      attrs: { type: 'button', 'aria-label': '关闭批改面板', title: '关闭批改面板（Esc）' },
      on: { click: () => onClose && onClose() },
    },
    icon('x', { size: 17 }),
  );

  const head = el(
    'div',
    { class: 'review-head' },
    el(
      'div',
      { class: `review-score-ring ring--${tone}` },
      progressRing({
        percent: score,
        size: 104,
        strokeWidth: 7,
        label: String(score),
        tone: 'score',
        ariaLabel: `总分 ${score}`,
      }),
      el('span', { class: 'review-score-caption', text: '总分' }),
    ),
    el(
      'div',
      { class: 'review-head-main' },
      el(
        'div',
        { class: 'review-head-top' },
        el('span', { class: 'review-kicker' }, icon('sparkles', { size: 14 }), 'AI 批改'),
        verdictBadge(verdict),
        closeButton,
      ),
      el('p', { class: 'review-overall-text', text: overall.summary || '（无总评）' }),
      dimensions.length
        ? el('div', { class: 'dimensions' }, ...dimensions.map((dimension) => dimensionRow(dimension)))
        : null,
    ),
  );
  panel.append(head);

  /* 逐句结果 */
  if (sentences.length) {
    panel.append(
      el(
        'section',
        { class: 'review-block' },
        el(
          'div',
          { class: 'review-block-head' },
          el('h4', { class: 'review-block-title' }, icon('layers', { size: 15 }), '逐句结果'),
          el('span', { class: 'review-block-hint', text: '点右上角图标可复制建议译文' }),
        ),
        el('div', { class: 'sentence-review-list' }, ...sentences.map((sentence, index) => sentenceReviewItem(sentence, Number.isInteger(sentence?.index) ? sentence.index : index))),
      ),
    );
  }

  /* 整段修改稿（折叠 + 复制） */
  if (revisedParagraph) {
    const details = el('details', { class: 'review-block revised-block' });
    const summary = el(
      'summary',
      { class: 'review-block-head revised-summary' },
      el('h4', { class: 'review-block-title' }, icon('edit', { size: 15 }), '整段修改稿'),
      el('span', { class: 'review-block-hint', text: '点击展开 / 收起' }),
      copyButton(() => revisedParagraph, '整段修改稿'),
    );
    details.append(summary, el('p', { class: 'revised-text', text: revisedParagraph }));
    panel.append(details);
  }

  /* 词汇与表达 */
  if (vocabulary.length) {
    panel.append(
      el(
        'section',
        { class: 'review-block' },
        el(
          'div',
          { class: 'review-block-head' },
          el('h4', { class: 'review-block-title' }, icon('book-open', { size: 15 }), '词汇与表达'),
          el('span', { class: 'review-block-hint', text: `${vocabulary.length} 条` }),
        ),
        el(
          'ul',
          { class: 'vocab-list' },
          ...vocabulary.map((item) => el(
            'li',
            { class: 'vocab-item' },
            el(
              'div',
              { class: 'vocab-term-row' },
              el('span', { class: 'vocab-term', text: item?.term || '' }),
              item?.meaning ? el('span', { class: 'vocab-meaning', text: item.meaning }) : null,
            ),
            item?.note ? el('p', { class: 'vocab-note', text: item.note }) : null,
          )),
        ),
      ),
    );
  }

  /* 学习建议 */
  if (tips.length) {
    panel.append(
      el(
        'section',
        { class: 'review-block' },
        el(
          'div',
          { class: 'review-block-head' },
          el('h4', { class: 'review-block-title' }, icon('lightbulb', { size: 15 }), '学习建议'),
        ),
        el(
          'ol',
          { class: 'tips-list' },
          ...tips.map((tip) => el('li', { class: 'tips-item', text: typeof tip === 'string' ? tip : String(tip) })),
        ),
      ),
    );
  }

  /* 底部：meta + 重新批改 */
  const metaBits = [];
  if (meta?.model) metaBits.push(`模型 ${meta.model}`);
  if (meta?.elapsedMs) metaBits.push(`耗时 ${formatElapsed(meta.elapsedMs)}`);
  if (reviewedAt) metaBits.push(`批改于 ${formatClock(reviewedAt)}`);
  else if (meta?.receivedAt) metaBits.push(`批改于 ${formatClock(meta.receivedAt)}`);
  if (meta?.usage?.total_tokens) metaBits.push(`${Number(meta.usage.total_tokens).toLocaleString('zh-CN')} tokens`);

  const footer = el(
    'div',
    { class: 'review-foot' },
    el(
      'div',
      { class: 'review-meta' },
      el('span', { class: 'review-meta-model' }, icon('sparkles', { size: 13 }), meta?.model || 'AI 批改'),
      reviewedAt ? el('span', { text: formatDateTime(reviewedAt) }) : null,
      meta?.elapsedMs ? el('span', { text: `耗时 ${formatElapsed(meta.elapsedMs)}` }) : null,
      meta?.usage?.total_tokens ? el('span', { text: `${Number(meta.usage.total_tokens).toLocaleString('zh-CN')} tokens` }) : null,
    ),
    el(
      'button',
      {
        class: 'btn btn-sm',
        attrs: { type: 'button' },
        on: { click: () => onRerun && onRerun() },
      },
      icon('refresh', { size: 15 }),
      el('span', { text: '重新批改' }),
    ),
  );
  // metaBits / 备用信息用于无障碍标题
  if (metaBits.length) footer.setAttribute('aria-label', `批改信息：${metaBits.join('，')}`);
  panel.append(footer);

  return panel;
}

/** 批改中的骨架屏 + 轮换文案 */
export function renderReviewSkeleton() {
  return el(
    'div',
    { class: 'review-skeleton', attrs: { role: 'status', 'aria-live': 'polite' } },
    el(
      'div',
      { class: 'review-skeleton-head' },
      el('div', { class: 'skeleton review-skeleton-ring' }),
      el(
        'div',
        { class: 'review-skeleton-lines' },
        el('span', { class: 'skeleton', style: { width: '32%', height: '18px' } }),
        el('span', { class: 'skeleton', style: { width: '92%', height: '12px' } }),
        el('span', { class: 'skeleton', style: { width: '76%', height: '12px' } }),
        el('span', { class: 'skeleton', style: { width: '64%', height: '12px' } }),
      ),
    ),
    el('div', { class: 'skeleton', style: { width: '100%', height: '64px' } }),
    el('div', { class: 'skeleton', style: { width: '100%', height: '92px' } }),
    el(
      'p',
      { class: 'review-loading-text' },
      spinner(14),
      el('span', { class: 'review-loading-label', text: '正在逐句比对原文与译文…' }),
    ),
  );
}

export { scoreTone };
