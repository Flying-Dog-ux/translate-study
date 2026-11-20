/** 章节目录页：#/book/:bookId */

import { el, formatNumber, formatPercent } from '../utils.js';
import { icon } from '../icons.js';
import { siteHeader } from '../components/header.js';
import * as store from '../store.js';
import { emptyState, errorState, progressRing, skeletonLine } from '../ui.js';
import { ROMAN_NUMERALS } from '../constants.js';
import { findFirstIncompleteChapter } from '../progress.js';

function loadingShell() {
  return el(
    'div',
    { class: 'page page--book' },
    el(
      'header',
      { class: 'site-header' },
      el('div', { class: 'brand' }, el('span', { class: 'brand-mark skeleton', style: { borderRadius: '50%' } })),
    ),
    el(
      'div',
      { class: 'book-loading' },
      el('div', { class: 'skeleton skeleton--cover' }),
      el(
        'div',
        { class: 'book-loading-info' },
        skeletonLine('120px', 14),
        skeletonLine('320px', 30),
        skeletonLine('180px', 18),
        skeletonLine('90%', 12),
        skeletonLine('70%', 12),
      ),
    ),
  );
}

function buildCover(book) {
  const roman = ROMAN_NUMERALS[(Number(book.order) || 1) - 1] || String(book.order || '');
  return el(
    'div',
    { class: 'book-cover', attrs: { 'aria-hidden': 'true', 'data-order': String(book.order || 1) } },
    el('span', { class: 'book-cover-border' }),
    el('span', { class: 'book-cover-star' }, icon('sparkles', { size: 22 })),
    el('span', { class: 'book-cover-roman', text: roman }),
    el('span', { class: 'book-cover-title', text: book.title }),
    el('span', { class: 'book-cover-zh', text: book.titleZh || '' }),
    el('span', { class: 'book-cover-rule' }),
    el('span', { class: 'book-cover-foot', text: '逐句译 · 原著练习本' }),
    el('span', { class: 'book-cover-bolt', text: 'ϟ' }),
  );
}

function buildChapterRow(book, chapter, chapterStats, { isCurrent = false } = {}) {
  const percent = chapterStats.percent;
  const translated = chapterStats.translated;
  const status = percent >= 100 ? 'completed' : translated > 0 ? 'in-progress' : 'not-started';
  const statusLabel = status === 'completed' ? '已完成' : status === 'in-progress' ? '继续练习' : '开始练习';
  const statusIcon = status === 'completed' ? 'check' : 'arrow-right';
  const number = chapter.number || String(chapter.index).padStart(2, '0');
  return el(
    'li',
    { class: `chapter-row chapter-row--${status}${isCurrent ? ' is-current' : ''}`.trim() },
    el(
      'a',
      {
        class: 'chapter-row-link',
        attrs: {
          href: `#/practice/${encodeURIComponent(book.id)}/${encodeURIComponent(chapter.index)}`,
          'aria-label': `第 ${chapter.index} 章 ${chapter.title}，进度 ${formatPercent(percent)}`,
        },
      },
      el(
        'span',
        { class: 'chapter-row-num' },
        el('span', { class: 'chapter-row-num-index', text: String(chapter.index).padStart(2, '0') }),
        el('span', { class: 'chapter-row-num-label', text: number }),
      ),
      el(
        'span',
        { class: 'chapter-row-main' },
        el('span', { class: 'chapter-row-title', text: chapter.title }),
        el(
          'span',
          { class: 'chapter-row-meta' },
          `${chapter.paragraphCount ?? '—'} 段 · ${formatNumber(chapter.sentenceCount ?? 0)} 句`,
          translated > 0 ? ` · 已译 ${formatNumber(translated)} 句` : '',
        ),
        el(
          'span',
          { class: 'chapter-row-bar', attrs: { 'aria-hidden': 'true' } },
          el('span', { class: 'chapter-row-bar-fill', style: { width: `${Math.min(100, Math.max(0, percent))}%` } }),
        ),
      ),
      el(
        'span',
        { class: 'chapter-row-status' },
        el('span', { class: `chapter-row-pct chapter-row-pct--${status}`, text: percent > 0 ? formatPercent(percent) : '未开始' }),
        el('span', { class: 'chapter-row-cta' }, el('span', { text: statusLabel }), icon(statusIcon, { size: 14 })),
      ),
    ),
  );
}

export async function mount({ root, params }) {
  document.title = '章节目录 · 逐句译';
  const page = el('div', { class: 'page page--book' });
  page.append(loadingShell());
  root.append(page);

  let alive = true;

  let manifest;
  try {
    manifest = await store.loadManifest();
  } catch (error) {
    if (alive) {
      page.replaceChildren(
        siteHeader({ current: 'library' }),
        errorState({
          title: '无法加载书目',
          error,
          actions: [
            { label: '回到书架', primary: true, onClick: () => { window.location.hash = '#/'; } },
            { label: '重试', icon: 'refresh', onClick: () => window.location.reload() },
          ],
        }),
      );
    }
    return { destroy() { alive = false; } };
  }

  try {
    await store.loadProgress();
  } catch { /* 进度失败时仍展示目录，只是进度显示为 0 */ }

  if (!alive) return {};

  const book = store.resolveBook(params.bookId);
  if (!book) {
    page.replaceChildren(
      siteHeader({ current: 'library' }),
      el(
        'div',
        { class: 'page-inner' },
        errorState({
          title: '没有找到这本书',
          message: `书目里没有「${params.bookId}」。可能是链接有误，或语料尚未生成。`,
          actions: [{ label: '回到书架', primary: true, onClick: () => { window.location.hash = '#/'; } }],
        }),
      ),
    );
    return { destroy() { alive = false; } };
  }

  document.title = `${book.titleZh || book.title} · 逐句译`;
  const stats = store.getBookProgress(book);
  const last = store.getLastLocation();
  const lastChapter = last && last.bookId === book.id
    ? store.resolveChapter(book, last.chapterIndex)
    : null;
  const continueChapter = lastChapter || findFirstIncompleteChapter(book, store.getCachedProgress()?.books?.[book.id]);
  const continueParagraph = lastChapter && lastChapter.index === continueChapter?.index ? (last.paragraphIndex || 0) : 0;
  const continueHref = continueChapter
    ? `#/practice/${encodeURIComponent(book.id)}/${encodeURIComponent(continueChapter.index)}${continueParagraph > 0 ? `?p=${continueParagraph}` : ''}`
    : '#/';
  const continueLabel = lastChapter ? '继续上次练习' : continueChapter && (stats.translated > 0) ? '继续练习' : '从第一章开始';
  const chapterCount = book.chapters?.length || 0;
  const reviewCount = store.getReviewItems().length;

  const chaptersSection = chapterCount
    ? el(
      'section',
      { class: 'chapters-section' },
      el(
        'div',
        { class: 'section-head' },
        el('h2', { class: 'section-title', text: '章节目录' }),
        el('span', { class: 'section-meta', text: `共 ${chapterCount} 章 · 已完成 ${Object.values(stats.chapters).filter((item) => item.percent >= 100).length} 章` }),
      ),
      el(
        'ol',
        { class: 'chapter-list' },
        ...(book.chapters || []).map((chapter) => buildChapterRow(book, chapter, stats.chapters[chapter.index] || { translated: 0, total: chapter.sentenceCount || 0, percent: 0 }, {
          isCurrent: Boolean(lastChapter && lastChapter.index === chapter.index),
        })),
      ),
    )
    : el(
      'section',
      { class: 'empty-shelf' },
      emptyState({
        icon: 'book',
        title: '这本书还没有章节语料',
        message: '语料构建脚本可能只生成了一部分书。可以回到书架看看其他书，或用演示模式体验完整流程。',
        actions: [{ label: '回到书架', primary: true, href: '#/' }],
      }),
    );

  page.replaceChildren(
    siteHeader({ current: 'library', reviewCount }),
    el(
      'div',
      { class: 'page-inner page-inner--book' },
      el('a', { class: 'back-link', attrs: { href: '#/' } }, icon('arrow-left', { size: 16 }), el('span', { text: '返回书架' })),
      el(
        'section',
        { class: 'book-hero' },
        buildCover(book),
        el(
          'div',
          { class: 'book-hero-info' },
          el('p', { class: 'eyebrow' }, el('span', { class: 'eyebrow-rule' }), `BOOK ${ROMAN_NUMERALS[(Number(book.order) || 1) - 1] || ''}`),
          el('h1', { class: 'book-hero-title', text: book.title }),
          el('p', { class: 'book-hero-zh', text: book.titleZh || '' }),
          el(
            'div',
            { class: 'book-hero-stats' },
            el('span', {}, el('b', { text: formatNumber(book.wordCount) }), ' 词'),
            el('span', {}, el('b', { text: formatNumber(book.sentenceCount) }), ' 句'),
            el('span', {}, el('b', { text: formatNumber(book.paragraphCount) }), ' 段'),
            el('span', {}, el('b', { text: formatNumber(chapterCount) }), ' 章'),
          ),
          el(
            'div',
            { class: 'book-hero-progress' },
            progressRing({
              percent: stats.percent,
              size: 72,
              strokeWidth: 5,
              label: formatPercent(stats.percent),
              ariaLabel: `全书进度 ${formatPercent(stats.percent)}`,
            }),
            el(
              'div',
              { class: 'book-hero-progress-text' },
              el('strong', { text: stats.percent >= 100 ? '全书已完成' : stats.translated > 0 ? '正在翻译中' : '尚未开始' }),
              el('span', { text: `已译 ${formatNumber(stats.translated)} / ${formatNumber(stats.total)} 句` }),
            ),
          ),
          el(
            'div',
            { class: 'book-hero-actions' },
            continueChapter
              ? el('a', { class: 'btn btn-primary btn-lg', attrs: { href: continueHref } }, icon('play', { size: 16 }), el('span', { text: continueLabel }))
              : null,
            el('a', { class: 'btn btn-lg', attrs: { href: '#/review' } }, icon('star', { size: 16 }), el('span', { text: '待复习' }), reviewCount > 0 ? el('span', { class: 'btn-badge', text: String(reviewCount) }) : null),
          ),
        ),
      ),
      chaptersSection,
      el(
        'footer',
        { class: 'site-footer' },
        el('span', { text: '逐句译 · Translate Study' }),
        el('span', { class: 'footer-dot', text: '·' }),
        el('span', { text: '英文原句来自原著语料，中文译文由你写下' }),
      ),
    ),
  );

  return {
    destroy() {
      alive = false;
    },
  };
}
