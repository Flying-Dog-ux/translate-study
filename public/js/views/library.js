/** 书架页：#/ */

import { el, formatNumber, formatPercent } from '../utils.js';
import { icon } from '../icons.js';
import { siteHeader } from '../components/header.js';
import { api } from '../api.js';
import * as store from '../store.js';
import { emptyState, errorState, progressRing, skeletonLine, toast } from '../ui.js';
import { ROMAN_NUMERALS } from '../constants.js';

const HERO_ART = `
<svg class="hero-svg" viewBox="0 0 440 380" fill="none" aria-hidden="true" focusable="false">
  <defs>
    <radialGradient id="zs-hero-glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="currentColor" stop-opacity=".16"/>
      <stop offset="100%" stop-color="currentColor" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <circle cx="238" cy="176" r="150" fill="url(#zs-hero-glow)"/>
  <circle class="hero-orbit" cx="238" cy="176" r="128" stroke="currentColor" stroke-opacity=".18"/>
  <circle class="hero-orbit hero-orbit--dashed" cx="238" cy="176" r="98" stroke="currentColor" stroke-opacity=".22" stroke-dasharray="1 7"/>
  <path class="hero-line" d="M96 288c44-36 78-42 118-22 32 16 56 20 86 8 28-12 42-38 46-74" stroke="currentColor" stroke-opacity=".22"/>
  <path class="hero-line" d="M126 92c36 24 52 46 58 78 5 27 20 42 46 48" stroke="currentColor" stroke-opacity=".13" stroke-dasharray="2 6"/>
  <path class="hero-star" d="M238 62l17.6 55.4L311 135l-55.4 17.6L238 208l-17.6-55.4L165 135l55.4-17.6z" fill="currentColor"/>
  <path class="hero-bolt" d="M312 236l-40 66 23-4-14 44 42-58-24 4z" fill="currentColor" fill-opacity=".72"/>
  <circle class="hero-dot hero-dot--1" cx="352" cy="96" r="3.4" fill="currentColor"/>
  <circle class="hero-dot hero-dot--2" cx="118" cy="212" r="2.6" fill="currentColor"/>
  <circle class="hero-dot hero-dot--3" cx="386" cy="276" r="2" fill="currentColor"/>
  <circle class="hero-dot hero-dot--4" cx="172" cy="48" r="2.2" fill="currentColor"/>
  <path d="M330 130l7 2-7 2-2 7-2-7-7-2 7-2 2-7z" fill="currentColor" fill-opacity=".7"/>
  <path d="M148 318l5.5 1.6-5.5 1.6-1.6 5.5-1.6-5.5-5.5-1.6 5.5-1.6 1.6-5.5z" fill="currentColor" fill-opacity=".5"/>
</svg>`;

function headerSkeleton() {
  return el(
    'header',
    { class: 'site-header' },
    el('div', { class: 'brand' }, el('span', { class: 'brand-mark skeleton', style: { borderRadius: '50%' } })),
    el('div', { class: 'skeleton-header-lines' }, skeletonLine('220px', 16), skeletonLine('160px', 12)),
  );
}

function heroSkeleton() {
  return el(
    'div',
    { class: 'library-loading', attrs: { role: 'status', 'aria-live': 'polite' } },
    el('div', { class: 'skeleton skeleton--hero' }),
    el(
      'div',
      { class: 'book-grid' },
      ...[0, 1, 2].map(() => el(
        'div',
        { class: 'skeleton skeleton--card' },
        skeletonLine('70%', 20),
        skeletonLine('45%', 14),
        skeletonLine('90%', 12),
      )),
    ),
  );
}

/** 解析「继续练习」目标 */
function resolveContinue(manifest) {
  const last = store.getLastLocation();
  if (last) {
    const book = store.resolveBook(last.bookId);
    if (book) {
      const chapter = store.resolveChapter(book, last.chapterIndex);
      if (chapter) {
        return {
          book,
          chapter,
          paragraphIndex: Math.max(0, Number(last.paragraphIndex) || 0),
          label: '继续上次练习',
          detail: `${book.titleZh || book.title} · 第 ${chapter.index} 章`,
          fromLast: true,
        };
      }
    }
  }
  const book = manifest.books?.[0];
  if (!book) return null;
  const chapter = store.resolveChapter(book, book.chapters?.[0]?.index);
  if (!chapter) return null;
  return {
    book,
    chapter,
    paragraphIndex: 0,
    label: '从第一章开始',
    detail: `${book.titleZh || book.title} · 第 ${chapter.index} 章`,
    fromLast: false,
  };
}

function practiceHref({ book, chapter, paragraphIndex = 0 }) {
  const base = `#/practice/${encodeURIComponent(book.id)}/${encodeURIComponent(chapter.index)}`;
  return paragraphIndex > 0 ? `${base}?p=${paragraphIndex}` : base;
}

function buildHero(manifest, overall, reviewCount) {
  const continueTarget = resolveContinue(manifest);
  const totalChapters = (manifest.books || []).reduce((sum, book) => sum + (book.chapters?.length || 0), 0);
  const totalSentences = (manifest.books || []).reduce((sum, book) => sum + (Number(book.sentenceCount) || 0), 0);
  const heroText = el(
    'div',
    { class: 'hero-copy' },
    el(
      'p',
      { class: 'eyebrow' },
      el('span', { class: 'eyebrow-rule' }),
      'Harry Potter · 英译中 · 逐句练习',
    ),
    el(
      'h1',
      { class: 'hero-title' },
      '把每一句英文，',
      el('br'),
      el('span', { class: 'hero-title-accent', text: '译成自己的中文。' }),
    ),
    el('p', {
      class: 'hero-sub',
      text: '七本原著的语料在书架上等你了。逐句翻译、段落 AI 批改、收藏待复习——安静地读完，也写下自己的版本。',
    }),
    el(
      'div',
      { class: 'hero-actions' },
      continueTarget
        ? el(
          'a',
          { class: 'btn btn-primary btn-lg', attrs: { href: practiceHref(continueTarget) } },
          icon('play', { size: 16 }),
          el('span', { text: continueTarget.label }),
        )
        : el('a', { class: 'btn btn-primary btn-lg', attrs: { href: '#/review' } }, icon('book-open', { size: 16 }), el('span', { text: '开始探索' })),
      el(
        'a',
        { class: 'btn btn-lg', attrs: { href: '#/review' } },
        icon('star', { size: 16 }),
        el('span', { text: '待复习' }),
        reviewCount > 0 ? el('span', { class: 'btn-badge', text: String(reviewCount) }) : null,
      ),
    ),
    continueTarget && continueTarget.fromLast ? el('p', { class: 'hero-continue-hint', text: `上次停在：${continueTarget.detail}` }) : null,
    el(
      'div',
      { class: 'hero-stats' },
      statBlock(manifest.books?.length || 0, '本原著'),
      statBlock(totalChapters, '章'),
      statBlock(formatNumber(totalSentences), '句'),
      statBlock(formatPercent(overall.percent), overall.translated > 0 ? `已翻译 · ${formatNumber(overall.translated)} 句` : '已翻译'),
    ),
  );
  return el(
    'section',
    { class: 'hero' },
    heroText,
    el('div', { class: 'hero-art', html: HERO_ART }),
  );
}

function statBlock(value, label) {
  return el(
    'div',
    { class: 'hero-stat' },
    el('b', { text: String(value) }),
    el('span', { text: label }),
  );
}

function buildBookCard(book) {
  const stats = store.getBookProgress(book);
  const last = store.getLastLocation();
  const isLastBook = Boolean(last && last.bookId === book.id);
  const roman = ROMAN_NUMERALS[(Number(book.order) || 1) - 1] || String(book.order || '');
  const percent = stats.percent;
  const card = el(
    'a',
    {
      class: `book-card${isLastBook ? ' book-card--current' : ''}`.trim(),
      attrs: { href: `#/book/${encodeURIComponent(book.id)}` },
    },
    el(
      'div',
      { class: 'book-card-head' },
      el(
        'div',
        { class: 'book-card-titles' },
        el(
          'div',
          { class: 'book-card-index-row' },
          el('p', { class: 'book-card-index', text: `BOOK ${roman}` }),
          isLastBook ? el('span', { class: 'book-card-badge', text: '上次练习' }) : null,
        ),
        el('h3', { class: 'book-card-en', text: book.title }),
        el('p', { class: 'book-card-zh', text: book.titleZh || '' }),
      ),
      progressRing({
        percent,
        size: 68,
        strokeWidth: 5,
        label: formatPercent(percent),
        ariaLabel: `${book.titleZh || book.title} 翻译进度 ${formatPercent(percent)}`,
      }),
    ),
    el(
      'div',
      { class: 'book-card-stats' },
      el('span', {}, el('b', { text: String(book.chapters?.length || 0) }), ' 章'),
      el('span', {}, el('b', { text: formatNumber(book.sentenceCount) }), ' 句'),
      el('span', {}, el('b', { text: formatNumber(book.wordCount) }), ' 词'),
    ),
    el(
      'div',
      { class: 'book-card-foot' },
      el('span', {
        class: 'book-card-progress-text',
        text: percent >= 100
          ? '已全部译完'
          : stats.translated > 0
            ? `已译 ${formatNumber(stats.translated)} / ${formatNumber(stats.total)} 句`
            : '尚未开始',
      }),
      el('span', { class: 'book-card-cta' }, el('span', { text: isLastBook ? '继续练习' : '查看章节' }), icon('arrow-right', { size: 14 })),
    ),
    el('span', { class: 'book-card-spine', attrs: { 'aria-hidden': 'true' } }),
    el('span', { class: 'book-card-roman', attrs: { 'aria-hidden': 'true' }, text: roman }),
  );
  return card;
}

function buildShelf(manifest) {
  const books = manifest.books || [];
  return el(
    'section',
    { class: 'shelf-section' },
    el(
      'div',
      { class: 'section-head' },
      el('h2', { class: 'section-title', text: '书架' }),
      el('span', { class: 'section-meta', text: `共 ${books.length} 本书` }),
    ),
    el('div', { class: 'book-grid' }, ...books.map((book) => buildBookCard(book))),
  );
}

function buildFooter() {
  return el(
    'footer',
    { class: 'site-footer' },
    el('span', { text: '逐句译 · Translate Study' }),
    el('span', { class: 'footer-dot', text: '·' }),
    el('span', { text: '本地单用户 · 零外部依赖 · 语料与进度只保存在本机' }),
    api.isMock() ? el('span', { class: 'footer-mock', text: '当前为演示模式（数据存于浏览器 localStorage）' }) : null,
  );
}

function buildErrorPanel(error, reviewCount) {
  const isMock = api.isMock();
  const actions = [
    { label: '重试', icon: 'refresh', primary: true, onClick: () => window.location.reload() },
  ];
  if (!isMock) {
    actions.push({
      label: '使用演示数据',
      icon: 'sparkles',
      onClick: () => {
        api.setMockMode(true);
        window.location.reload();
      },
    });
  }
  return el(
    'section',
    { class: 'error-panel-wrap' },
    errorState({
      title: isMock ? '演示数据加载失败' : '无法连接后端服务',
      message: error?.message || '加载书架数据失败。',
      error,
      actions,
    }),
    !isMock
      ? el(
        'div',
        { class: 'error-help' },
        el('h3', { text: '如何启动正式服务' }),
        el('ol', {},
          el('li', {}, el('code', { text: 'npm start' }), ' 启动本地服务（默认 http://127.0.0.1:5180）'),
          el('li', {}, '在项目根目录的 ', el('code', { text: '.env' }), ' 中配置 ', el('code', { text: 'DEEPSEEK_API_KEY' }), '（仅服务端读取）'),
          el('li', {}, '如需只看界面：地址后加 ', el('code', { text: '?mock=1&demo=1' }), ' 使用本地演示数据'),
        ),
      )
      : null,
  );
}

/** 路由入口 */
export async function mount({ root }) {
  document.title = '书架 · 逐句译';
  const page = el('div', { class: 'page page--library' });
  page.append(headerSkeleton(), heroSkeleton());
  root.append(page);

  let alive = true;

  let manifest;
  try {
    manifest = await store.loadManifest();
  } catch (error) {
    if (!alive) return {};
    page.replaceChildren(siteHeader({ current: 'library' }), buildErrorPanel(error));
    return { destroy() { alive = false; } };
  }

  try {
    await store.loadProgress();
  } catch (error) {
    if (alive) toast(`进度读取失败：${error.message}`, 'error');
  }

  if (!alive) return {};

  const reviewItems = store.getReviewItems();
  const overall = store.getOverallStats();
  const books = manifest.books || [];

  const content = books.length
    ? el('div', { class: 'library-content' }, buildHero(manifest, overall, reviewItems.length), buildShelf(manifest), buildFooter())
    : el(
      'div',
      { class: 'library-content' },
      el(
        'section',
        { class: 'empty-shelf' },
        emptyState({
          icon: 'book',
          title: '书架还是空的',
          message: '还没有找到语料。请先运行语料构建脚本生成 data/corpus，然后刷新页面；或用 ?mock=1&demo=1 查看界面演示。',
          actions: [
            { label: '刷新页面', primary: true, onClick: () => window.location.reload() },
            { label: '使用演示数据', onClick: () => { api.setMockMode(true); window.location.reload(); } },
          ],
        }),
      ),
      buildFooter(),
    );

  page.replaceChildren(siteHeader({ current: 'library', reviewCount: reviewItems.length }), content);

  return {
    destroy() {
      alive = false;
    },
  };
}
