/** 待复习页：#/review —— 收藏段落 + AI 判定需改进的段落 */

import { el, relativeTime } from '../utils.js';
import { icon } from '../icons.js';
import { siteHeader } from '../components/header.js';
import { verdictBadge } from '../components/review-panel.js';
import { api } from '../api.js';
import * as store from '../store.js';
import { emptyState, errorState, loadingState, toast } from '../ui.js';

function keyOf(item) {
  return `${item.book.id}:${item.chapter.index}:${item.paragraphIndex}`;
}

function truncate(text, max = 220) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function buildLoading() {
  return el(
    'div',
    { class: 'page page--review' },
    el(
      'header',
      { class: 'site-header' },
      el('div', { class: 'brand' }, el('span', { class: 'brand-mark skeleton', style: { borderRadius: '50%' } })),
      el('div', { class: 'skeleton-header-lines' }, el('span', { class: 'skeleton', style: { width: '240px', height: '18px' } })),
    ),
    el('div', { class: 'page-inner page-inner--narrow' }, loadingState({ title: '正在整理待复习的段落…' })),
  );
}

function buildEmptyAll() {
  return emptyState({
    icon: 'star',
    title: '还没有待复习的段落',
    message: '练习时点击段落右上角的星标，或让 AI 批改。被判定为「需改进 / 有误」的段落会自动出现在这里。',
    actions: [{ label: '去书架挑一本书', primary: true, href: '#/' }],
  });
}

function buildFilteredEmpty(filter) {
  const labels = { starred: '收藏', needs: '需改进' };
  return emptyState({
    icon: 'sparkles',
    title: `「${labels[filter] || '这个分类'}」下暂时没有段落`,
    message: '换个分类看看，或继续练习新的段落。',
  });
}

export async function mount({ root }) {
  document.title = '待复习 · 逐句译';
  root.append(buildLoading());

  let manifest;
  try {
    manifest = await store.loadManifest();
    await store.loadProgress();
  } catch (error) {
    root.replaceChildren(
      el(
        'div',
        { class: 'page page--review' },
        siteHeader({ current: 'review' }),
        el(
          'div',
          { class: 'page-inner page-inner--narrow' },
          errorState({
            title: '无法加载待复习数据',
            error,
            actions: [
              { label: '回到书架', primary: true, onClick: () => { window.location.hash = '#/'; } },
              { label: '重试', icon: 'refresh', onClick: () => window.location.reload() },
            ],
          }),
        ),
      ),
    );
    return {};
  }

  let items = store.getReviewItems();
  const sourceMap = new Map();
  const chapterPromises = new Map();

  async function loadChapterSentences(bookId, chapterIndex) {
    const key = `${bookId}:${chapterIndex}`;
    if (!chapterPromises.has(key)) {
      chapterPromises.set(key, api.chapter(bookId, chapterIndex).catch(() => null));
    }
    return chapterPromises.get(key);
  }

  await Promise.all(items.map(async (item) => {
    const chapter = await loadChapterSentences(item.book.id, item.chapter.index);
    if (!chapter) return;
    const paragraph = (chapter.paragraphs || []).find((entry) => Number(entry.index) === item.paragraphIndex);
    if (!paragraph) return;
    sourceMap.set(keyOf(item), (paragraph.sentences || []).map((sentence) => sentence?.text || ''));
  }));

  let filter = 'all';
  const page = el('div', { class: 'page page--review' });
  root.replaceChildren(page);

  function counts() {
    return {
      all: items.length,
      starred: items.filter((item) => item.starred).length,
      needs: items.filter((item) => item.aiNeeded).length,
    };
  }

  function filteredItems() {
    if (filter === 'starred') return items.filter((item) => item.starred);
    if (filter === 'needs') return items.filter((item) => item.aiNeeded);
    return items;
  }

  function sortedItems() {
    return [...filteredItems()].sort((a, b) => {
      if (a.starred !== b.starred) return a.starred ? -1 : 1;
      return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
    });
  }

  const tabsEl = el('div', { class: 'filter-tabs', attrs: { role: 'tablist', 'aria-label': '待复习分类' } });
  const listEl = el('div', { class: 'review-items' });
  const summaryEl = el('div', { class: 'review-summary' });

  function renderTabs() {
    const data = counts();
    const tabs = [
      { id: 'all', label: '全部', count: data.all },
      { id: 'starred', label: '收藏', count: data.starred },
      { id: 'needs', label: '需改进', count: data.needs },
    ];
    tabsEl.replaceChildren(...tabs.map((tab) => el(
      'button',
      {
        class: `filter-tab${filter === tab.id ? ' is-active' : ''}`.trim(),
        attrs: { type: 'button', role: 'tab', 'aria-selected': String(filter === tab.id) },
        on: { click: () => { filter = tab.id; renderTabs(); renderList(); } },
      },
      el('span', { text: tab.label }),
      el('span', { class: 'filter-count', text: String(tab.count) }),
    )));
  }

  function renderSummary() {
    const data = counts();
    summaryEl.replaceChildren(
      summaryCard('待复习', data.all, '所有需要回头看的段落', 'bookmark'),
      summaryCard('已收藏', data.starred, '你主动标记的段落', 'star'),
      summaryCard('需改进', data.needs, 'AI 判定需要打磨的译文', 'sparkles'),
    );
  }

  function summaryCard(label, value, hint, iconName) {
    return el(
      'div',
      { class: 'summary-card' },
      el('span', { class: 'summary-card-icon' }, icon(iconName, { size: 17 })),
      el('span', { class: 'summary-card-value', text: String(value) }),
      el('span', { class: 'summary-card-label', text: label }),
      el('span', { class: 'summary-card-hint', text: hint }),
    );
  }

  function renderList() {
    const list = sortedItems();
    if (!items.length) {
      listEl.replaceChildren(el('div', { class: 'review-empty' }, buildEmptyAll()));
      return;
    }
    if (!list.length) {
      listEl.replaceChildren(el('div', { class: 'review-empty' }, buildFilteredEmpty(filter)));
      return;
    }
    listEl.replaceChildren(...list.map((item) => buildItemCard(item)));
  }

  function buildItemCard(item) {
    const review = item.data?.review || null;
    const verdict = review?.overall?.verdict || null;
    const score = review?.overall?.score;
    const sources = sourceMap.get(keyOf(item));
    const sourcePreview = sources?.length
      ? truncate(sources.join(' '))
      : '（原文暂时无法加载，不影响练习进度）';
    const myTranslations = (item.data?.sentences || []).map((text) => String(text || '').trim()).filter(Boolean);
    const myPreview = myTranslations.length
      ? truncate(myTranslations.join(' '), 160)
      : '';
    const href = `#/practice/${encodeURIComponent(item.book.id)}/${encodeURIComponent(item.chapter.index)}?p=${encodeURIComponent(item.paragraphIndex)}${review ? '&panel=review' : ''}`;
    const card = el(
      'article',
      { class: 'review-item' },
      el(
        'div',
        { class: 'review-item-top' },
        el(
          'div',
          { class: 'review-item-loc' },
          el('span', { class: 'chip chip--book', text: `${item.book.titleZh || item.book.title} · 第 ${item.chapter.index} 章` }),
          el('span', { class: 'chip chip--para', text: `第 ${item.paragraphIndex + 1} 段` }),
          item.chapter.title ? el('span', { class: 'chip chip--chapter', text: item.chapter.title }) : null,
        ),
        el(
          'div',
          { class: 'review-item-badges' },
          item.starred
            ? el('span', { class: 'flag flag--star' }, icon('star-filled', { size: 12 }), el('span', { text: '已收藏' }))
            : null,
          verdict ? verdictBadge(verdict) : null,
          Number.isFinite(Number(score))
            ? el('span', { class: 'review-score-chip', text: `${Math.round(Number(score))} 分` })
            : null,
        ),
      ),
      el('p', { class: 'review-item-source', attrs: { lang: 'en' }, text: sourcePreview }),
      myPreview
        ? el('p', { class: 'review-item-translation', text: `我的译文：${myPreview}` })
        : el('p', { class: 'review-item-translation is-empty', text: '我的译文：（还没有填写）' }),
      el(
        'div',
        { class: 'review-item-foot' },
        el(
          'span',
          { class: 'review-item-time' },
          item.updatedAt ? icon('clock', { size: 12 }) : null,
          item.updatedAt ? `更新于 ${relativeTime(item.updatedAt)}` : '',
        ),
        el(
          'div',
          { class: 'review-item-actions' },
          el('a', { class: 'btn btn-primary btn-sm', attrs: { href } }, icon('arrow-right', { size: 14 }), el('span', { text: '回到练习' })),
          item.starred
            ? el(
              'button',
              {
                class: 'btn btn-ghost btn-sm',
                attrs: { type: 'button' },
                on: { click: () => removeStar(item) },
              },
              icon('star', { size: 14 }),
              el('span', { text: '取消收藏' }),
            )
            : null,
        ),
      ),
    );
    return card;
  }

  async function removeStar(item) {
    try {
      await store.persistParagraph({
        bookId: item.book.id,
        chapterIndex: item.chapter.index,
        paragraphIndex: item.paragraphIndex,
        sentences: item.data?.sentences || [],
        starred: false,
        review: item.data?.review || null,
      });
      items = store.getReviewItems();
      renderSummary();
      renderTabs();
      renderList();
      toast('已取消收藏', { type: 'success' });
    } catch (error) {
      toast(`取消收藏失败：${error.message}`, 'error');
    }
  }

  function buildPage() {
    return el(
      'div',
      { class: 'page-inner page-inner--narrow' },
      el('a', { class: 'back-link', attrs: { href: '#/' } }, icon('arrow-left', { size: 16 }), el('span', { text: '返回书架' })),
      el(
        'section',
        { class: 'page-head' },
        el('p', { class: 'eyebrow' }, el('span', { class: 'eyebrow-rule' }), 'REVIEW'),
        el('h1', { class: 'page-title', text: '待复习' }),
        el('p', { class: 'page-sub', text: '收藏的段落、以及 AI 判定「需改进 / 有误」的译文，都收在这里。回到练习，把没把握的句子再译一遍。' }),
      ),
      summaryEl,
      tabsEl,
      listEl,
    );
  }

  page.replaceChildren(siteHeader({ current: 'review', reviewCount: items.length }), buildPage());
  renderSummary();
  renderTabs();
  renderList();

  return {
    destroy() { /* 无需要清理的监听 */ },
  };
}
