/** 参考译文面板：POST /api/reference 的结构化渲染 */

import { el, formatElapsed } from '../utils.js';
import { icon } from '../icons.js';
import { copyWithToast, spinner } from '../ui.js';

function copyButton(getText, label) {
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

/**
 * 渲染参考译文面板。
 * @param {{reference?: object, meta?: object, loading?: boolean, error?: Error, onClose?: Function, onRetry?: Function}} options
 */
export function renderReferencePanel({ reference = null, meta = null, loading = false, error = null, onClose = null, onRetry = null } = {}) {
  const panel = el('div', { class: 'reference-panel' });
  const closeButton = el(
    'button',
    {
      class: 'icon-btn panel-close',
      attrs: { type: 'button', 'aria-label': '关闭参考译文', title: '关闭参考译文（Esc）' },
      on: { click: () => onClose && onClose() },
    },
    icon('x', { size: 17 }),
  );

  panel.append(
    el(
      'div',
      { class: 'reference-head' },
      el('span', { class: 'reference-kicker' }, icon('book-open', { size: 15 }), '参考译文'),
      el('span', { class: 'reference-hint', text: 'AI 生成 · 仅供对照，建议先完成自己的译文' }),
      closeButton,
    ),
  );

  if (loading) {
    panel.append(
      el(
        'div',
        { class: 'reference-loading', attrs: { role: 'status', 'aria-live': 'polite' } },
        el('span', { class: 'skeleton', style: { width: '100%', height: '16px' } }),
        el('span', { class: 'skeleton', style: { width: '86%', height: '16px' } }),
        el('p', { class: 'reference-loading-text' }, spinner(14), el('span', { text: '正在生成参考译文…' })),
      ),
    );
    return panel;
  }

  if (error) {
    panel.append(
      el(
        'div',
        { class: 'reference-error', attrs: { role: 'alert' } },
        icon('alert-circle', { size: 18 }),
        el('div', { class: 'reference-error-body' }, el('p', { text: error.message || '参考译文获取失败。' })),
        onRetry
          ? el(
            'button',
            { class: 'btn btn-sm', attrs: { type: 'button' }, on: { click: () => onRetry() } },
            icon('refresh', { size: 14 }),
            el('span', { text: '重试' }),
          )
          : null,
      ),
    );
    return panel;
  }

  if (!reference) {
    panel.append(el('p', { class: 'reference-empty', text: '暂无参考译文。' }));
    return panel;
  }

  const wholeTranslation = typeof reference.translation === 'string' ? reference.translation : '';
  const sentences = Array.isArray(reference.sentences) ? reference.sentences : [];

  panel.append(
    el(
      'section',
      { class: 'reference-block' },
      el(
        'div',
        { class: 'reference-block-head' },
        el('h4', { class: 'review-block-title' }, icon('quote', { size: 15 }), '整段参考译文'),
        copyButton(() => wholeTranslation, '参考译文'),
      ),
      el('p', { class: 'reference-whole', text: wholeTranslation || sentences.map((item) => item.translation || '').join('') }),
    ),
  );

  if (sentences.length) {
    panel.append(
      el(
        'section',
        { class: 'reference-block' },
        el(
          'div',
          { class: 'reference-block-head' },
          el('h4', { class: 'review-block-title' }, icon('layers', { size: 15 }), '逐句对照'),
        ),
        el(
          'ol',
          { class: 'reference-list' },
          ...sentences.map((sentence, index) => el(
            'li',
            { class: 'reference-item' },
            el(
              'div',
              { class: 'reference-item-head' },
              el('span', { class: 'reference-item-no', text: `第 ${(Number.isInteger(sentence?.index) ? sentence.index : index) + 1} 句` }),
              copyButton(() => sentence?.translation || '', '这句参考译文'),
            ),
            el('p', { class: 'reference-item-text', text: sentence?.translation || '' }),
            sentence?.note ? el('p', { class: 'reference-item-note' }, icon('lightbulb', { size: 13 }), el('span', { text: sentence.note })) : null,
          )),
        ),
      ),
    );
  }

  panel.append(
    el(
      'div',
      { class: 'reference-meta' },
      el('span', { text: meta?.model || 'AI 生成' }),
      meta?.elapsedMs ? el('span', { text: `耗时 ${formatElapsed(meta.elapsedMs)}` }) : null,
      el('span', { class: 'reference-warn', text: '参考译文不唯一，请以自己的表达为主。' }),
    ),
  );

  return panel;
}
