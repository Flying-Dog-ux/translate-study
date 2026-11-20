/** 英文单词点击查词浮层（调用可选的 POST /api/word；失败时友好降级） */

import { el } from '../utils.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { spinner } from '../ui.js';

let active = null;

function positionPopover(popover, anchor) {
  const rect = anchor.getBoundingClientRect();
  const width = popover.offsetWidth;
  const height = popover.offsetHeight;
  let left = rect.left + rect.width / 2 - width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  let top = rect.bottom + 8;
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 8);
  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
}

function renderEntry(entry) {
  const meanings = Array.isArray(entry?.meanings) ? entry.meanings : [];
  const examples = Array.isArray(entry?.examples) ? entry.examples : [];
  return el(
    'div',
    { class: 'word-entry' },
    entry?.phonetic ? el('p', { class: 'word-phonetic', text: entry.phonetic }) : null,
    meanings.length
      ? el(
        'ul',
        { class: 'word-meanings' },
        ...meanings.map((meaning) => el(
          'li',
          { class: 'word-meaning' },
          meaning?.pos ? el('span', { class: 'word-pos', text: meaning.pos }) : null,
          el('span', { text: meaning?.cn || '' }),
        )),
      )
      : null,
    entry?.explanation ? el('p', { class: 'word-explanation', text: entry.explanation }) : null,
    examples.length
      ? el(
        'div',
        { class: 'word-examples' },
        ...examples.map((example) => el(
          'div',
          { class: 'word-example' },
          el('p', { class: 'word-example-en', text: example?.en || '' }),
          el('p', { class: 'word-example-cn', text: example?.cn || '' }),
        )),
      )
      : null,
  );
}

/**
 * 打开查词浮层（同一时间只会有一个）。
 * @param {{anchor: HTMLElement, word: string, sentence?: string, paragraph?: string, onClose?: Function}} options
 */
export function openWordPopover({ anchor, word, sentence = '', paragraph = '' }) {
  closeWordPopover();

  const popover = el('div', { class: 'word-popover', attrs: { role: 'dialog', 'aria-label': `查词：${word}` } });
  const stateBox = el('div', { class: 'word-popover-state' });

  const close = () => {
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll);
    popover.remove();
    if (active && active.popover === popover) active = null;
  };

  const onOutside = (event) => {
    if (popover.contains(event.target) || anchor.contains(event.target)) return;
    close();
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  const onScroll = () => close();

  const lookupButton = el(
    'button',
    {
      class: 'btn btn-sm btn-primary',
      attrs: { type: 'button' },
      on: { click: () => lookup() },
    },
    icon('sparkles', { size: 14 }),
    el('span', { text: 'AI 讲解' }),
  );

  function renderIdle() {
    stateBox.replaceChildren(
      el('p', { class: 'word-hint', text: '选中一个词，看看它在句子里的意思。' }),
      el(
        'div',
        { class: 'word-actions' },
        lookupButton,
        el(
          'button',
          {
            class: 'btn btn-sm btn-ghost',
            attrs: { type: 'button' },
            on: {
              click: async () => {
                try {
                  await navigator.clipboard.writeText(word);
                  stateBox.prepend(el('p', { class: 'word-copied', text: '已复制单词' }));
                } catch { /* 忽略 */ }
              },
            },
          },
          icon('copy', { size: 14 }),
          el('span', { text: '复制' }),
        ),
      ),
    );
  }

  async function lookup() {
    stateBox.replaceChildren(
      el('div', { class: 'word-loading' }, spinner(16), el('span', { text: '正在查词…' })),
    );
    try {
      const response = await api.word({ word, sentence, paragraph });
      if (!response?.entry) throw new Error('后端没有返回讲解内容。');
      stateBox.replaceChildren(renderEntry(response.entry));
    } catch (error) {
      stateBox.replaceChildren(
        el(
          'div',
          { class: 'word-error', attrs: { role: 'alert' } },
          el('p', { text: error?.code === 'NOT_FOUND' ? '后端暂未提供单词讲解功能（可选接口 /api/word）。' : (error?.message || '查词失败，请稍后重试。') }),
          el(
            'button',
            { class: 'btn btn-sm', attrs: { type: 'button' }, on: { click: () => lookup() } },
            icon('refresh', { size: 14 }),
            el('span', { text: '重试' }),
          ),
        ),
      );
    }
  }

  renderIdle();

  popover.append(
    el(
      'div',
      { class: 'word-popover-head' },
      el('span', { class: 'word-title', text: word }),
      el(
        'button',
        { class: 'icon-btn', attrs: { type: 'button', 'aria-label': '关闭查词浮层' }, on: { click: close } },
        icon('x', { size: 15 }),
      ),
    ),
    stateBox,
  );
  document.body.append(popover);
  positionPopover(popover, anchor);

  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll);

  active = { popover, close };
  return { close };
}

export function closeWordPopover() {
  if (active) active.close();
}
