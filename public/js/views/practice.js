/**
 * 练习主界面：#/practice/:bookId/:chapterIndex
 * 支持 ?p=<paragraphIndex> 定位段落，?panel=review 自动展开已保存的批改面板（便于演示 / 深链）。
 */

import {
  autoResize,
  clamp,
  copyText,
  countWords,
  downloadJson,
  el,
  formatClock,
  formatNumber,
  formatPercent,
  sleep,
  timestampSlug,
  tokenizeEnglish,
} from '../utils.js';
import { icon } from '../icons.js';
import { api, saveParagraphKeepalive } from '../api.js';
import * as store from '../store.js';
import { countNonEmptyTranslations, normalizeSentenceTranslations } from '../progress.js';
import { REVIEW_LOADING_TEXTS, SAVE_DEBOUNCE_MS } from '../constants.js';
import {
  attachMenu,
  confirmDialog,
  copyWithToast,
  errorState,
  infoDialog,
  loadingState,
  shortcutsTable,
  spinner,
  toast,
} from '../ui.js';
import { renderReviewPanel, renderReviewSkeleton } from '../components/review-panel.js';
import { renderReferencePanel } from '../components/reference-panel.js';
import { closeWordPopover, openWordPopover } from '../components/word-popover.js';

const INITIAL_BATCH = 5;
const BATCH_SIZE = 4;

/** 路由入口 */
export async function mount({ root, params, query }) {
  document.title = '练习 · 逐句译';
  root.append(loadingState({ title: '正在准备练习…', message: '加载书目、章节与已保存的进度' }));

  let manifest;
  try {
    manifest = await store.loadManifest();
  } catch (error) {
    root.replaceChildren(buildFatalPage({
      title: '无法加载书目',
      error,
      actions: [
        { label: '回到书架', primary: true, onClick: () => { window.location.hash = '#/'; } },
        { label: '重试', icon: 'refresh', onClick: () => window.location.reload() },
      ],
    }));
    return {};
  }

  const book = store.resolveBook(params.bookId);
  if (!book) {
    root.replaceChildren(buildFatalPage({
      title: '没有找到这本书',
      message: `书目里没有「${params.bookId}」。可能是链接有误，或语料尚未生成。`,
      actions: [{ label: '回到书架', primary: true, onClick: () => { window.location.hash = '#/'; } }],
    }));
    return {};
  }

  const chapterMeta = store.resolveChapter(book, params.chapterIndex);
  if (!chapterMeta) {
    root.replaceChildren(buildFatalPage({
      title: '这本书还没有章节语料',
      message: '可以回到书架选择其他书，或用演示模式体验完整练习流程。',
      actions: [{ label: '回到书架', primary: true, onClick: () => { window.location.hash = '#/'; } }],
    }));
    return {};
  }

  const chapterIndex = Number(chapterMeta.index);

  let chapterData;
  try {
    chapterData = await api.chapter(book.id, chapterIndex);
  } catch (error) {
    root.replaceChildren(buildFatalPage({
      title: '章节加载失败',
      error,
      actions: [
        { label: '回到章节目录', primary: true, onClick: () => { window.location.hash = `#/book/${encodeURIComponent(book.id)}`; } },
        { label: '重试', icon: 'refresh', onClick: () => window.location.reload() },
      ],
    }));
    return {};
  }

  try {
    await store.loadProgress();
  } catch (error) {
    store.replaceProgress({ version: 1, updatedAt: null, books: {} });
    toast(`进度读取失败：${error.message}。本次输入仍会尝试保存。`, 'warn');
  }

  // ---------- 段落状态 ----------
  const savedParagraphs = store.getSavedChapterParagraphs(book.id, chapterIndex) || {};
  const paragraphs = (chapterData.paragraphs || []).map((paragraph) => {
    const saved = savedParagraphs[String(paragraph.index)] || null;
    const sentences = (paragraph.sentences || []).map((sentence) => ({
      text: typeof sentence?.text === 'string' ? sentence.text : '',
      wordCount: Number(sentence?.wordCount) || countWords(sentence?.text),
    }));
    return {
      index: Number(paragraph.index),
      sentences,
      translations: normalizeSentenceTranslations(saved?.sentences, sentences.length),
      starred: Boolean(saved?.starred),
      review: saved?.review && typeof saved.review === 'object' ? saved.review : null,
      reviewMeta: null,
      reviewedAt: saved?.updatedAt || null,
      reviewError: null,
      reviewing: false,
      reference: null,
      referenceMeta: null,
      referenceLoading: false,
      referenceError: null,
      panel: 'none',
      dirty: false,
      savedAt: saved?.updatedAt || null,
      el: null,
      textareas: [],
      saveState: saved ? 'saved' : 'idle',
      skeletonTimer: 0,
    };
  });

  document.title = `第 ${chapterIndex} 章 · ${chapterMeta.title} · 逐句译`;

  const state = {
    book,
    bookId: book.id,
    chapterIndex,
    chapterMeta,
    chapter: chapterData,
    paragraphs,
    renderedCount: 0,
    dirty: new Set(),
    savePromise: null,
    pendingFlush: false,
    status: 'idle',
    lastSavedAt: null,
    currentParagraph: null,
    destroyed: false,
    drawerOpen: false,
    observer: null,
  };

  if (paragraphs.some((paragraph) => paragraph.savedAt)) {
    state.status = 'saved';
    const latest = paragraphs.filter((paragraph) => paragraph.savedAt).sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt))[0];
    state.lastSavedAt = latest?.savedAt || null;
  }

  const initialTarget = Number.isInteger(Number(query.p)) ? Number(query.p) : null;
  const requestedParagraph = initialTarget !== null
    ? paragraphs.find((paragraph) => paragraph.index === initialTarget) || null
    : null;
  const startParagraph = requestedParagraph || paragraphs[0] || null;
  if (startParagraph) store.setLastLocation(book.id, chapterIndex, startParagraph.index);

  // ---------- DOM 骨架 ----------
  const progressFill = el('i', { class: 'practice-progress-fill', style: { width: '0%' } });
  const saveStatusEl = el('button', {
    class: 'save-status save-status--idle',
    attrs: { type: 'button', 'aria-live': 'polite', title: '输入内容会在 800 毫秒后自动保存' },
  });
  const progressTextEl = el('span', { class: 'topbar-progress-text', text: '' });
  const drawerToggle = el(
    'button',
    {
      class: 'icon-btn sidebar-toggle',
      attrs: { type: 'button', 'aria-label': '打开章节目录', 'aria-expanded': 'false' },
    },
    icon('menu', { size: 18 }),
  );
  const themeButton = buildThemeButton();
  const moreButton = el(
    'button',
    { class: 'icon-btn', attrs: { type: 'button', 'aria-label': '更多操作', title: '更多操作' } },
    icon('more', { size: 18 }),
  );
  const minusButton = el(
    'button',
    { class: 'icon-btn font-btn', attrs: { type: 'button', 'aria-label': '减小正文字号', title: '减小正文字号（A-）' } },
    icon('minus', { size: 15 }),
  );
  const plusButton = el(
    'button',
    { class: 'icon-btn font-btn', attrs: { type: 'button', 'aria-label': '增大正文字号', title: '增大正文字号（A+）' } },
    icon('plus', { size: 15 }),
  );

  const topbar = el(
    'header',
    { class: 'practice-topbar' },
    el(
      'div',
      { class: 'topbar-inner' },
      el(
        'a',
        {
          class: 'icon-btn topbar-back',
          attrs: { href: `#/book/${encodeURIComponent(book.id)}`, 'aria-label': '返回章节目录', title: '返回章节目录' },
        },
        icon('arrow-left', { size: 18 }),
      ),
      drawerToggle,
      el(
        'div',
        { class: 'topbar-title' },
        el(
          'div',
          { class: 'topbar-crumbs' },
          el('a', { class: 'topbar-crumb', attrs: { href: '#/' }, text: book.titleZh || book.title }),
          el('span', { class: 'topbar-dot', text: '·' }),
          el('span', { class: 'topbar-chapter', text: `第 ${chapterIndex} 章` }),
        ),
        el('h1', { class: 'topbar-title-text', text: chapterMeta.title }),
      ),
      el(
        'div',
        { class: 'topbar-actions' },
        saveStatusEl,
        progressTextEl,
        el('div', { class: 'font-control', attrs: { role: 'group', 'aria-label': '正文字号' } }, minusButton, plusButton),
        themeButton,
        moreButton,
      ),
    ),
    el('div', { class: 'practice-progress', attrs: { 'aria-hidden': 'true' } }, progressFill),
  );

  const paragraphList = el('div', { class: 'paragraph-list' });
  const sentinel = el('div', { class: 'load-sentinel' });
  const chapterHead = buildChapterHead();
  const main = el(
    'main',
    { class: 'practice-main', attrs: { id: 'practice-main' } },
    chapterHead,
    paragraphList,
    sentinel,
    el(
      'footer',
      { class: 'practice-foot' },
      el('p', {}, icon('keyboard', { size: 14 }), el('span', { text: '快捷键：Ctrl / ⌘ + Enter 批改当前段 · Ctrl / ⌘ + ↑ ↓ 切换段落 · Esc 关闭面板' })),
      el('p', { class: 'practice-foot-note', text: '输入会自动保存；收藏与 AI 批改结果也会随段落进度一起保存。' }),
    ),
  );
  const sidebar = buildSidebar();
  const drawerBackdrop = el('div', { class: 'drawer-backdrop', attrs: { 'aria-hidden': 'true' } });
  const shell = el(
    'div',
    { class: 'practice-shell' },
    topbar,
    el('div', { class: 'practice-layout' }, sidebar.element, main, drawerBackdrop),
  );
  root.replaceChildren(shell);
  updateSaveStatus(state.status);
  updateProgressUI();
  updateFontButtons();

  /* ---------------------------------- 保存 ---------------------------------- */

  function buildPayload(paragraph) {
    return {
      bookId: state.bookId,
      chapterIndex: state.chapterIndex,
      paragraphIndex: paragraph.index,
      sentences: paragraph.translations.map((text) => String(text ?? '')),
      starred: Boolean(paragraph.starred),
      review: paragraph.review || null,
    };
  }

  function updateSaveStatus(kind, error = null) {
    state.status = kind;
    saveStatusEl.className = `save-status save-status--${kind}`;
    if (kind === 'saving') {
      saveStatusEl.replaceChildren(spinner(13), el('span', { text: '保存中…' }));
      saveStatusEl.setAttribute('aria-label', '正在保存');
      saveStatusEl.setAttribute('title', '正在保存');
    } else if (kind === 'saved') {
      saveStatusEl.replaceChildren(icon('check', { size: 14 }), el('span', { text: state.lastSavedAt ? `已保存 ${formatClock(state.lastSavedAt)}` : '已保存' }));
      saveStatusEl.setAttribute('aria-label', '已保存');
      saveStatusEl.setAttribute('title', '所有修改已保存');
    } else if (kind === 'error') {
      saveStatusEl.replaceChildren(icon('alert-circle', { size: 14 }), el('span', { text: '保存失败 · 重试' }));
      saveStatusEl.setAttribute('aria-label', `保存失败：${error?.message || '请点击重试'}`);
      saveStatusEl.setAttribute('title', '点击重试保存');
    } else if (kind === 'pending') {
      saveStatusEl.replaceChildren(icon('edit', { size: 14 }), el('span', { text: '待保存…' }));
      saveStatusEl.setAttribute('aria-label', '有修改待保存');
      saveStatusEl.setAttribute('title', '输入停止 800 毫秒后自动保存');
    } else {
      saveStatusEl.replaceChildren(icon('edit', { size: 14 }), el('span', { text: '自动保存' }));
      saveStatusEl.setAttribute('aria-label', '自动保存已开启');
      saveStatusEl.setAttribute('title', '输入内容会在 800 毫秒后自动保存');
    }
  }

  function markDirty(paragraph) {
    paragraph.dirty = true;
    state.dirty.add(paragraph.index);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void flushSaves(); }, SAVE_DEBOUNCE_MS);
    if (state.status !== 'saving' && state.status !== 'error') updateSaveStatus('pending');
  }

  let saveTimer = 0;

  function scheduleImmediateSave() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    void flushSaves();
  }

  async function flushSaves() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (state.savePromise) {
      state.pendingFlush = true;
      return state.savePromise;
    }
    if (state.dirty.size === 0) return Promise.resolve();
    state.savePromise = doFlushSaves().finally(() => {
      state.savePromise = null;
      if (state.dirty.size > 0 && state.pendingFlush) {
        state.pendingFlush = false;
        void flushSaves();
      }
    });
    return state.savePromise;
  }

  async function doFlushSaves() {
    updateSaveStatus('saving');
    const indexes = [...state.dirty].sort((a, b) => a - b);
    for (const index of indexes) {
      const paragraph = state.paragraphs.find((item) => item.index === index);
      if (!paragraph || !paragraph.dirty) continue;
      try {
        await store.persistParagraph(buildPayload(paragraph));
        paragraph.dirty = false;
        paragraph.savedAt = new Date().toISOString();
        state.dirty.delete(index);
        updateProgressUI();
      } catch (error) {
        updateSaveStatus('error', error);
        toast(`保存失败：${error.message}`, 'error');
        return;
      }
    }
    if (state.dirty.size === 0) {
      state.lastSavedAt = new Date().toISOString();
      updateSaveStatus('saved');
    } else {
      updateSaveStatus('saving');
    }
  }

  saveStatusEl.addEventListener('click', () => {
    if (state.status === 'error') {
      void flushSaves();
    } else if (state.status === 'saving') {
      toast('正在保存，请稍候…', { duration: 1600 });
    } else if (state.dirty.size > 0) {
      void flushSaves();
    } else {
      toast(state.lastSavedAt ? `最近保存：${formatClock(state.lastSavedAt)}` : '暂时没有需要保存的修改', { duration: 1800 });
    }
  });

  /* ---------------------------------- 进度 ---------------------------------- */

  function computeChapterProgress() {
    const fallbackTotal = state.paragraphs.reduce((sum, paragraph) => sum + paragraph.sentences.length, 0);
    const total = Number(state.chapterMeta.sentenceCount) || fallbackTotal;
    const translated = state.paragraphs.reduce((sum, paragraph) => sum + countNonEmptyTranslations(paragraph.translations), 0);
    const percent = total > 0 ? Math.min(100, (translated / total) * 100) : 0;
    return { translated, total, percent };
  }

  function updateProgressUI() {
    const stats = computeChapterProgress();
    progressFill.style.width = `${stats.percent}%`;
    progressTextEl.textContent = `本章 ${formatPercent(stats.percent)}`;
    if (sidebar.chapterFill) sidebar.chapterFill.style.width = `${stats.percent}%`;
    if (sidebar.chapterPct) sidebar.chapterPct.textContent = formatPercent(stats.percent);
    const metaLine = chapterHead.querySelector('.practice-chapter-progress');
    if (metaLine) metaLine.textContent = `已译 ${formatNumber(stats.translated)} / ${formatNumber(stats.total)} 句 · 进度 ${formatPercent(stats.percent)}`;
  }

  /* ---------------------------------- 字号 / 主题 ---------------------------------- */

  function updateFontButtons() {
    minusButton.disabled = !store.canAdjustFontScale(-1);
    plusButton.disabled = !store.canAdjustFontScale(1);
    const percent = Math.round(store.getFontScale() * 100);
    minusButton.title = `减小正文字号（A-，当前 ${percent}%）`;
    plusButton.title = `增大正文字号（A+，当前 ${percent}%）`;
    minusButton.setAttribute('aria-label', minusButton.title);
    plusButton.setAttribute('aria-label', plusButton.title);
  }

  minusButton.addEventListener('click', () => { store.adjustFontScale(-1); updateFontButtons(); resizeAllTextareas(); });
  plusButton.addEventListener('click', () => { store.adjustFontScale(1); updateFontButtons(); resizeAllTextareas(); });

  function buildThemeButton() {
    const button = el(
      'button',
      { class: 'icon-btn', attrs: { type: 'button' } },
      icon(store.getEffectiveTheme() === 'dark' ? 'sun' : 'moon', { size: 18 }),
    );
    const initialLabel = store.getEffectiveTheme() === 'dark' ? '切换到浅色主题' : '切换到深色主题';
    button.setAttribute('aria-label', initialLabel);
    button.setAttribute('title', initialLabel);
    button.addEventListener('click', () => {
      const next = store.toggleTheme();
      button.replaceChildren(icon(next === 'dark' ? 'sun' : 'moon', { size: 18 }));
      const label = next === 'dark' ? '切换到浅色主题' : '切换到深色主题';
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
    });
    return button;
  }

  /* ---------------------------------- 顶部菜单 ---------------------------------- */

  const menuController = attachMenu(moreButton, () => [
    // 移动端顶栏的 A-/A+ 会隐藏（≤860px），这里提供等价入口，保证任何尺寸都能调字号。
    {
      label: `增大正文字号（A+）· 当前 ${Math.round(store.getFontScale() * 100)}%`,
      icon: 'plus',
      onClick: () => {
        store.adjustFontScale(1);
        toast(`正文字号 ${Math.round(store.getFontScale() * 100)}%`, { duration: 1400 });
      },
    },
    {
      label: '减小正文字号（A-）',
      icon: 'minus',
      onClick: () => {
        store.adjustFontScale(-1);
        toast(`正文字号 ${Math.round(store.getFontScale() * 100)}%`, { duration: 1400 });
      },
    },
    { divider: true },
    {
      label: '导出本章进度 JSON',
      icon: 'download',
      onClick: exportChapterProgress,
    },
    { label: '快捷键说明', icon: 'keyboard', onClick: () => infoDialog({ title: '快捷键', body: shortcutsTable() }) },
    { divider: true },
    { label: '前往设置页', icon: 'settings', onClick: () => { window.location.hash = '#/settings'; } },
    { label: '返回章节目录', icon: 'arrow-left', onClick: () => { window.location.hash = `#/book/${encodeURIComponent(book.id)}`; } },
    { label: '返回书架', icon: 'book', onClick: () => { window.location.hash = '#/'; } },
  ]);

  function exportChapterProgress() {
    const payload = {
      bookId: state.bookId,
      chapterIndex: state.chapterIndex,
      chapterTitle: state.chapterMeta.title,
      exportedAt: new Date().toISOString(),
      paragraphs: state.paragraphs.map((paragraph) => ({
        index: paragraph.index,
        sentences: paragraph.translations.map((text) => String(text ?? '')),
        starred: Boolean(paragraph.starred),
        review: paragraph.review || null,
      })),
    };
    downloadJson(`逐句译_${state.bookId}_第${state.chapterIndex}章_${timestampSlug()}.json`, payload);
    toast('已导出本章进度', 'success');
  }

  /* ---------------------------------- 侧栏 / 抽屉 ---------------------------------- */

  const desktopQuery = window.matchMedia ? window.matchMedia('(min-width: 1200px)') : null;

  function buildSidebar() {
    const refs = { element: null, chapterFill: null, chapterPct: null };
    const currentChapterHref = `#/practice/${encodeURIComponent(book.id)}/${encodeURIComponent(chapterIndex)}`;
    const bookStats = store.getBookProgress(book);
    const chapterRows = (book.chapters || []).map((chapter) => {
      const chapterStats = store.getChapterProgress(book, chapter.index);
      const isCurrent = Number(chapter.index) === chapterIndex;
      const fill = el('span', { class: 'sidebar-chapter-bar-fill', style: { width: `${chapterStats.percent}%` } });
      const pct = el('span', { class: 'sidebar-chapter-pct', text: chapterStats.percent > 0 ? formatPercent(chapterStats.percent) : '' });
      if (isCurrent) {
        refs.chapterFill = fill;
        refs.chapterPct = pct;
      }
      return el(
        'li',
        { class: `sidebar-chapter${isCurrent ? ' is-current' : ''}`.trim() },
        el(
          'a',
          {
            class: 'sidebar-chapter-link',
            attrs: {
              href: `#/practice/${encodeURIComponent(book.id)}/${encodeURIComponent(chapter.index)}`,
              ...(isCurrent ? { 'aria-current': 'page' } : {}),
            },
          },
          el('span', { class: 'sidebar-chapter-no', text: String(chapter.index).padStart(2, '0') }),
          el(
            'span',
            { class: 'sidebar-chapter-main' },
            el('span', { class: 'sidebar-chapter-title', text: chapter.title }),
            el('span', { class: 'sidebar-chapter-bar', attrs: { 'aria-hidden': 'true' } }, fill),
          ),
          pct,
        ),
      );
    });

    refs.element = el(
      'aside',
      { class: 'practice-sidebar', attrs: { 'aria-label': '章节目录' } },
      el(
        'div',
        { class: 'sidebar-card' },
        el(
          'div',
          { class: 'sidebar-head' },
          el('span', { class: 'sidebar-title' }, icon('layers', { size: 15 }), '章节目录'),
          el(
            'button',
            { class: 'icon-btn sidebar-close', attrs: { type: 'button', 'aria-label': '关闭章节目录' }, on: { click: closeDrawer } },
            icon('x', { size: 16 }),
          ),
        ),
        el(
          'div',
          { class: 'sidebar-book' },
          el('span', { class: 'sidebar-book-title', text: book.titleZh || book.title }),
          el('span', { class: 'sidebar-book-pct', text: `全书 ${formatPercent(bookStats.percent)}` }),
        ),
        el('ol', { class: 'sidebar-chapters' }, ...chapterRows),
        el(
          'div',
          { class: 'sidebar-foot' },
          el('a', { class: 'sidebar-link', attrs: { href: currentChapterHref } }, icon('target', { size: 14 }), el('span', { text: '回到本章开头' })),
          el('a', { class: 'sidebar-link', attrs: { href: '#/' } }, icon('book', { size: 14 }), el('span', { text: '返回书架' })),
        ),
      ),
    );
    return refs;
  }

  function openDrawer() {
    state.drawerOpen = true;
    sidebar.element.classList.add('is-open');
    drawerBackdrop.classList.add('is-open');
    drawerToggle.setAttribute('aria-expanded', 'true');
    drawerToggle.setAttribute('aria-label', '关闭章节目录');
    sidebar.element.inert = false;
    document.body.classList.add('drawer-open');
  }

  function closeDrawer() {
    state.drawerOpen = false;
    sidebar.element.classList.remove('is-open');
    drawerBackdrop.classList.remove('is-open');
    drawerToggle.setAttribute('aria-expanded', 'false');
    drawerToggle.setAttribute('aria-label', '打开章节目录');
    document.body.classList.remove('drawer-open');
    if (!desktopQuery || !desktopQuery.matches) sidebar.element.inert = true;
  }

  function toggleDrawer() {
    if (state.drawerOpen) closeDrawer();
    else openDrawer();
  }

  drawerToggle.addEventListener('click', toggleDrawer);
  drawerBackdrop.addEventListener('click', closeDrawer);

  function syncDrawerWithViewport() {
    if (desktopQuery && desktopQuery.matches) {
      sidebar.element.classList.remove('is-open');
      drawerBackdrop.classList.remove('is-open');
      lastToggle = false;
      state.drawerOpen = false;
      sidebar.element.inert = false;
      sidebar.element.removeAttribute('aria-hidden');
      document.body.classList.remove('drawer-open');
    } else if (!state.drawerOpen) {
      sidebar.element.inert = true;
      sidebar.element.setAttribute('aria-hidden', 'true');
    } else {
      sidebar.element.inert = false;
      sidebar.element.removeAttribute('aria-hidden');
    }
  }

  let lastToggle = false;
  function onDesktopChange() {
    lastToggle = !desktopQuery || !desktopQuery.matches;
    syncDrawerWithViewport();
  }
  if (desktopQuery) {
    if (typeof desktopQuery.addEventListener === 'function') desktopQuery.addEventListener('change', onDesktopChange);
    else if (typeof desktopQuery.addListener === 'function') desktopQuery.addListener(onDesktopChange);
  }
  syncDrawerWithViewport();
  // 移动端初始为抽屉关闭态，桌面端常显
  if (desktopQuery && !desktopQuery.matches) sidebar.element.inert = true;

  /* ---------------------------------- 段落渲染 ---------------------------------- */

  function findParagraphByElement(element) {
    const card = element?.closest?.('.para-card');
    if (!card) return null;
    const index = Number(card.dataset.paragraphIndex);
    return state.paragraphs.find((paragraph) => paragraph.index === index) || null;
  }

  function buildParagraphCard(paragraph) {
    const card = el('article', {
      class: 'para-card',
      attrs: {
        id: `para-${paragraph.index}`,
        'data-paragraph-index': String(paragraph.index),
        'aria-labelledby': `para-title-${paragraph.index}`,
      },
    });

    const words = paragraph.sentences.reduce((sum, sentence) => sum + (sentence.wordCount || countWords(sentence.text)), 0);
    const starButton = el(
      'button',
      {
        class: `star-btn${paragraph.starred ? ' is-active' : ''}`.trim(),
        attrs: {
          type: 'button',
          'aria-pressed': String(paragraph.starred),
          'aria-label': paragraph.starred ? '取消收藏本段' : '收藏本段',
          title: paragraph.starred ? '取消收藏（移出待复习）' : '收藏本段（加入待复习）',
        },
        on: { click: () => toggleStar(paragraph) },
      },
      icon(paragraph.starred ? 'star-filled' : 'star', { size: 18 }),
    );

    const head = el(
      'header',
      { class: 'para-head' },
      el('h2', { class: 'para-chip', attrs: { id: `para-title-${paragraph.index}` }, text: `第 ${paragraph.index + 1} 段` }),
      el('span', { class: 'para-meta', text: `${paragraph.sentences.length} 句 · ${formatNumber(words)} 词` }),
      starButton,
    );

    const sentencesWrap = el('div', { class: 'para-sentences' });
    paragraph.textareas = [];
    paragraph.sentences.forEach((sentence, sentenceIndex) => {
      sentencesWrap.append(buildSentenceRow(paragraph, sentence, sentenceIndex));
    });

    const countLabel = el('span', { class: 'para-count', text: `已译 ${countNonEmptyTranslations(paragraph.translations)} / ${paragraph.sentences.length} 句` });

    const reviewButton = el(
      'button',
      {
        class: 'btn btn-primary',
        attrs: { type: 'button' },
        on: { click: () => startReview(paragraph) },
      },
      icon('sparkles', { size: 16 }),
      el('span', { text: 'AI 批改本段' }),
    );
    const referenceButton = el(
      'button',
      {
        class: 'btn',
        attrs: { type: 'button' },
        on: { click: () => requestReference(paragraph) },
      },
      icon('book-open', { size: 16 }),
      el('span', { text: '参考译文' }),
    );
    const copyButton = el(
      'button',
      {
        class: 'btn btn-ghost',
        attrs: { type: 'button' },
        on: { click: () => copyMyTranslation(paragraph) },
      },
      icon('copy', { size: 16 }),
      el('span', { text: '复制我的译文' }),
    );

    const actions = el('footer', { class: 'para-actions' }, reviewButton, referenceButton, copyButton, countLabel);
    const panel = el('section', { class: 'para-panel', hidden: true });

    card.append(head, sentencesWrap, actions, panel);
    card._refs = { reviewButton, referenceButton, copyButton, countLabel, starButton, panel };
    return card;
  }

  function buildSentenceRow(paragraph, sentence, sentenceIndex) {
    const sourceEn = el('p', { class: 'source-en', attrs: { lang: 'en' } });
    for (const token of tokenizeEnglish(sentence.text)) {
      if (token.word) {
        sourceEn.append(el('span', { class: 'word', attrs: { 'data-word': token.word } }, token.word));
      } else {
        sourceEn.append(document.createTextNode(token.text));
      }
    }

    const sourceCell = el(
      'div',
      { class: 'sentence-source' },
      el('span', { class: 'sentence-no', attrs: { 'aria-hidden': 'true' }, text: String(sentenceIndex + 1) }),
      el('div', { class: 'sentence-source-body' }, el('span', { class: 'mini-label', text: '原文' }), sourceEn),
    );

    const textarea = el('textarea', {
      class: 'target-textarea',
      attrs: {
        rows: '2',
        placeholder: '写下这一句的中文译文…',
        'aria-label': `第 ${sentenceIndex + 1} 句的中文译文`,
        spellcheck: 'false',
      },
    });
    textarea.value = paragraph.translations[sentenceIndex] || '';

    const charCount = el('span', { class: 'char-count', text: `${textarea.value.replace(/\s/g, '').length} 字` });
    const dot = el('span', {
      class: `sentence-dot${textarea.value.trim() ? ' is-translated' : ''}`.trim(),
      attrs: { title: textarea.value.trim() ? '已翻译' : '未翻译', 'aria-hidden': 'true' },
    });
    const targetCell = el(
      'div',
      { class: 'sentence-target' },
      el('span', { class: 'mini-label', text: '我的译文' }),
      textarea,
      el('div', { class: 'target-meta' }, charCount, dot),
    );

    paragraph.textareas[sentenceIndex] = textarea;

    textarea.addEventListener('input', () => {
      paragraph.translations[sentenceIndex] = textarea.value;
      charCount.textContent = `${textarea.value.replace(/\s/g, '').length} 字`;
      dot.className = `sentence-dot${textarea.value.trim() ? ' is-translated' : ''}`;
      dot.title = textarea.value.trim() ? '已翻译' : '未翻译';
      autoResize(textarea);
      updateParaCount(paragraph);
      updateProgressUI();
      markDirty(paragraph);
    });

    textarea.addEventListener('focus', () => {
      state.currentParagraph = paragraph;
      store.setLastLocation(state.bookId, state.chapterIndex, paragraph.index);
    });

    return el('div', { class: 'sentence-row' }, sourceCell, targetCell);
  }

  function updateParaCount(paragraph) {
    const label = paragraph.el?._refs?.countLabel;
    if (label) label.textContent = `已译 ${countNonEmptyTranslations(paragraph.translations)} / ${paragraph.sentences.length} 句`;
  }

  function toggleStar(paragraph) {
    paragraph.starred = !paragraph.starred;
    const refs = paragraph.el?._refs;
    if (refs) {
      refs.starButton.classList.toggle('is-active', paragraph.starred);
      refs.starButton.setAttribute('aria-pressed', String(paragraph.starred));
      refs.starButton.setAttribute('aria-label', paragraph.starred ? '取消收藏本段' : '收藏本段');
      refs.starButton.setAttribute('title', paragraph.starred ? '取消收藏（移出待复习）' : '收藏本段（加入待复习）');
      refs.starButton.replaceChildren(icon(paragraph.starred ? 'star-filled' : 'star', { size: 18 }));
    }
    markDirty(paragraph);
    toast(paragraph.starred ? '已收藏本段，可在「待复习」中找到' : '已取消收藏', { type: 'info', duration: 1800 });
  }

  function copyMyTranslation(paragraph) {
    const text = paragraph.translations
      .map((translation, index) => `${index + 1}. ${translation.trim() || '（未译）'}`)
      .join('\n');
    copyWithToast(text, '我的译文');
  }

  /* ---------------------------------- 面板 ---------------------------------- */

  function renderPanel(paragraph) {
    const panel = paragraph.el?._refs?.panel;
    if (!panel) return;
    if (paragraph.skeletonTimer) {
      clearInterval(paragraph.skeletonTimer);
      paragraph.skeletonTimer = 0;
    }
    if (paragraph.panel === 'none') {
      panel.hidden = true;
      panel.replaceChildren();
      return;
    }
    panel.hidden = false;
    if (paragraph.panel === 'review') {
      if (paragraph.reviewing) {
        panel.replaceChildren(renderReviewSkeleton());
        const label = panel.querySelector('.review-loading-label');
        let index = 0;
        if (label) {
          paragraph.skeletonTimer = setInterval(() => {
            if (!label.isConnected) return;
            index = (index + 1) % REVIEW_LOADING_TEXTS.length;
            label.textContent = REVIEW_LOADING_TEXTS[index];
          }, 1700);
        }
        return;
      }
      if (paragraph.reviewError) {
        panel.replaceChildren(buildReviewError(paragraph));
        return;
      }
      if (paragraph.review) {
        panel.replaceChildren(renderReviewPanel({
          review: paragraph.review,
          meta: paragraph.reviewMeta,
          reviewedAt: paragraph.reviewedAt,
          onClose: () => closePanel(paragraph),
          onRerun: () => startReview(paragraph),
        }));
        return;
      }
      panel.hidden = true;
      return;
    }
    if (paragraph.panel === 'reference') {
      panel.replaceChildren(renderReferencePanel({
        reference: paragraph.reference,
        meta: paragraph.referenceMeta,
        loading: paragraph.referenceLoading,
        error: paragraph.referenceError,
        onClose: () => closePanel(paragraph),
        onRetry: () => loadReference(paragraph),
      }));
    }
  }

  function revealPanel(paragraph) {
    const panel = paragraph.el?._refs?.panel;
    if (!panel || panel.hidden) return;
    requestAnimationFrame(() => {
      const rect = panel.getBoundingClientRect();
      if (rect.top < 84 || rect.bottom > window.innerHeight - 40) {
        panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
    });
  }

  function closePanel(paragraph) {
    if (paragraph.skeletonTimer) {
      clearInterval(paragraph.skeletonTimer);
      paragraph.skeletonTimer = 0;
    }
    paragraph.panel = 'none';
    renderPanel(paragraph);
  }

  function buildReviewError(paragraph) {
    const error = paragraph.reviewError || {};
    const isAuth = error.code === 'AI_AUTH';
    const actions = [
      el(
        'button',
        { class: 'btn btn-primary btn-sm', attrs: { type: 'button' }, on: { click: () => startReview(paragraph) } },
        icon('refresh', { size: 14 }),
        el('span', { text: '重新批改' }),
      ),
      isAuth
        ? el('a', { class: 'btn btn-sm', attrs: { href: '#/settings' } }, icon('settings', { size: 14 }), el('span', { text: '去设置页' }))
        : null,
      el('button', { class: 'btn btn-ghost btn-sm', attrs: { type: 'button' }, on: { click: () => closePanel(paragraph) } }, el('span', { text: '关闭' })),
    ].filter(Boolean);
    return el(
      'div',
      { class: 'panel-error', attrs: { role: 'alert' } },
      el('div', { class: `panel-error-icon${isAuth ? ' panel-error-icon--warn' : ''}`.trim() }, icon(isAuth ? 'alert-triangle' : 'alert-circle', { size: 20 })),
      el(
        'div',
        { class: 'panel-error-body' },
        el('h4', { class: 'panel-error-title', text: isAuth ? '尚未配置 DeepSeek API Key' : '批改没有成功' }),
        el('p', { class: 'panel-error-message', text: error.message || '未知错误，请稍后重试。' }),
        isAuth
          ? el('p', { class: 'panel-error-hint', text: '在项目根目录的 .env 中配置 DEEPSEEK_API_KEY 后重启 npm start；也可以先到设置页查看服务状态。' })
          : el('p', { class: 'panel-error-hint', text: '请确认本地后端服务（npm start）正在运行；若网络不稳定，可以稍后重试。' }),
        el('div', { class: 'panel-error-actions' }, ...actions),
      ),
    );
  }

  async function startReview(paragraph) {
    if (paragraph.reviewing) return;
    if (!paragraph.sentences.length) return;
    if (!paragraph.translations.some((translation) => translation.trim())) {
      const confirmed = await confirmDialog({
        title: '本段还没有译文',
        message: '现在批改会把每一句都判定为「未翻译」，但 AI 仍会给出逐句参考译法。仍要发送吗？',
        confirmText: '仍要批改',
        cancelText: '先写译文',
      });
      if (!confirmed) return;
    }

    paragraph.reviewing = true;
    paragraph.panel = 'review';
    paragraph.reviewError = null;
    setReviewButtonLoading(paragraph, true);
    renderPanel(paragraph);
    revealPanel(paragraph);

    const previous = state.paragraphs.find((item) => item.index === paragraph.index - 1);
    const next = state.paragraphs.find((item) => item.index === paragraph.index + 1);

    try {
      const response = await api.review({
        bookId: state.bookId,
        chapterIndex: state.chapterIndex,
        paragraphIndex: paragraph.index,
        translations: paragraph.translations.map((translation) => translation.trim()),
        context: {
          prevSource: previous ? previous.sentences.map((sentence) => sentence.text).join(' ') : '',
          nextSource: next ? next.sentences.map((sentence) => sentence.text).join(' ') : '',
        },
      });
      if (state.destroyed || !paragraph.el) return;
      paragraph.review = response.review;
      paragraph.reviewMeta = { ...(response.meta || {}), receivedAt: Date.now() };
      paragraph.reviewedAt = Date.now();
      paragraph.reviewing = false;
      paragraph.reviewError = null;
      paragraph.panel = 'review';
      paragraph.dirty = true;
      state.dirty.add(paragraph.index);
      setReviewButtonLoading(paragraph, false);
      renderPanel(paragraph);
      scheduleImmediateSave();
      toast('批改完成，结果已随进度保存', { type: 'success' });    } catch (error) {
      if (state.destroyed || !paragraph.el) return;
      paragraph.reviewing = false;
      paragraph.reviewError = error;
      paragraph.panel = 'review';
      setReviewButtonLoading(paragraph, false);
      renderPanel(paragraph);
      if (error.code !== 'AI_AUTH') toast(`批改失败：${error.message}`, 'error');
    }
  }

  function setReviewButtonLoading(paragraph, loading) {
    const button = paragraph.el?._refs?.reviewButton;
    if (!button) return;
    button.disabled = loading;
    button.replaceChildren(
      loading ? spinner(15) : icon('sparkles', { size: 16 }),
      el('span', { text: loading ? '批改中…' : 'AI 批改本段' }),
    );
  }

  async function requestReference(paragraph) {
    if (paragraph.referenceLoading) return;
    const confirmed = await confirmDialog({
      title: '查看参考译文？',
      message: '建议先自己翻完、对照过 AI 批改，再来看参考译文。现在就打开吗？',
      confirmText: '打开参考译文',
      cancelText: '先自己译',
    });
    if (!confirmed) return;
    await loadReference(paragraph);
  }

  async function loadReference(paragraph) {
    paragraph.panel = 'reference';
    paragraph.referenceLoading = true;
    paragraph.referenceError = null;
    renderPanel(paragraph);
    revealPanel(paragraph);
    try {
      const response = await api.reference({
        bookId: state.bookId,
        chapterIndex: state.chapterIndex,
        paragraphIndex: paragraph.index,
      });
      if (state.destroyed || !paragraph.el) return;
      paragraph.reference = response.reference;
      paragraph.referenceMeta = response.meta || null;
      paragraph.referenceLoading = false;
      renderPanel(paragraph);
    } catch (error) {
      if (state.destroyed || !paragraph.el) return;
      paragraph.referenceLoading = false;
      paragraph.referenceError = error;
      renderPanel(paragraph);
    }
  }

  /* ---------------------------------- 逐段加载 ---------------------------------- */

  function renderNextBatch() {
    if (state.renderedCount >= state.paragraphs.length) return;
    const end = Math.min(state.renderedCount + BATCH_SIZE, state.paragraphs.length);
    for (let i = state.renderedCount; i < end; i += 1) {
      const paragraph = state.paragraphs[i];
      const card = buildParagraphCard(paragraph);
      paragraph.el = card;
      paragraphList.append(card);
    }
    state.renderedCount = end;
    requestAnimationFrame(() => {
      for (let i = 0; i < state.paragraphs.length; i += 1) {
        const paragraph = state.paragraphs[i];
        paragraph.textareas.forEach((textarea) => autoResize(textarea));
      }
    });
    if (state.renderedCount >= state.paragraphs.length) {
      state.observer?.disconnect();
      sentinel.replaceChildren(el('p', { class: 'end-of-chapter' }, icon('sparkles', { size: 14 }), el('span', { text: '已经是本章最后一段了' })));
    } else {
      sentinel.replaceChildren(el('p', { class: 'load-sentinel-text' }, spinner(14), el('span', { text: '向下滚动，加载后续段落…' })));
    }
  }

  function renderInitial() {
    const end = Math.min(INITIAL_BATCH, state.paragraphs.length);
    for (let i = 0; i < end; i += 1) {
      const paragraph = state.paragraphs[i];
      const card = buildParagraphCard(paragraph);
      paragraph.el = card;
      paragraphList.append(card);
    }
    state.renderedCount = end;
    requestAnimationFrame(() => {
      state.paragraphs.forEach((paragraph) => paragraph.textareas.forEach((textarea) => autoResize(textarea)));
    });
    if (state.renderedCount >= state.paragraphs.length) {
      sentinel.replaceChildren(el('p', { class: 'end-of-chapter' }, icon('sparkles', { size: 14 }), el('span', { text: '已经是本章最后一段了' })));
    } else {
      sentinel.replaceChildren(el('p', { class: 'load-sentinel-text' }, spinner(14), el('span', { text: '向下滚动，加载后续段落…' })));
      state.observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) renderNextBatch();
      }, { rootMargin: '600px 0px' });
      state.observer.observe(sentinel);
    }
  }

  function ensureRenderedThrough(index) {
    while (state.renderedCount <= index && state.renderedCount < state.paragraphs.length) {
      renderNextBatch();
    }
  }

  function scrollToParagraph(index, { highlight = true } = {}) {
    const paragraph = state.paragraphs.find((item) => item.index === index);
    if (!paragraph) return;
    ensureRenderedThrough(state.paragraphs.indexOf(paragraph));
    requestAnimationFrame(() => {
      const card = paragraph.el;
      if (!card) return;
      card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (highlight) {
        card.classList.add('is-highlighted');
        setTimeout(() => card.classList.remove('is-highlighted'), 1800);
      }
    });
  }

  /* ---------------------------------- 键盘 ---------------------------------- */

  function onKeyDown(event) {
    if (document.getElementById('modal-root')?.childElementCount) return;
    const mod = event.ctrlKey || event.metaKey;
    if (event.key === 'Escape') {
      const openParagraph = state.paragraphs.find((paragraph) => paragraph.panel !== 'none');
      if (openParagraph) {
        event.preventDefault();
        closePanel(openParagraph);
        return;
      }
      if (state.drawerOpen) {
        event.preventDefault();
        closeDrawer();
        return;
      }
      closeWordPopover();
      return;
    }
    if (!mod) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      const paragraph = currentParagraphFromFocus() || state.currentParagraph || state.paragraphs[0];
      if (paragraph) void startReview(paragraph);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveParagraphFocus(event.key === 'ArrowDown' ? 1 : -1);
    }
  }

  function currentParagraphFromFocus() {
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      const paragraph = findParagraphByElement(active);
      if (paragraph) return paragraph;
    }
    return null;
  }

  function moveParagraphFocus(direction) {
    if (!state.paragraphs.length) return;
    const current = currentParagraphFromFocus() || state.currentParagraph;
    const currentIndex = current ? state.paragraphs.indexOf(current) : -1;
    const targetIndex = clamp(currentIndex + direction, 0, state.paragraphs.length - 1);
    const target = state.paragraphs[targetIndex];
    if (!target || target === current) return;
    ensureRenderedThrough(targetIndex);
    state.currentParagraph = target;
    store.setLastLocation(state.bookId, state.chapterIndex, target.index);
    requestAnimationFrame(() => {
      const card = target.el;
      if (!card) return;
      card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const textarea = target.textareas[0] || card.querySelector('textarea');
      if (textarea) textarea.focus({ preventScroll: true });
    });
  }

  paragraphList.addEventListener('keydown', (event) => {
    // 键盘快捷键统一由 document 上的 onKeyDown 处理；此处仅保留占位以便后续扩展
    void event;
  });

  /* ---------------------------------- 事件绑定 ---------------------------------- */

  document.addEventListener('keydown', onKeyDown);

  paragraphList.addEventListener('click', (event) => {
    const wordElement = event.target.closest?.('.source-en .word');
    if (!wordElement) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && String(selection).trim()) return;
    const paragraph = findParagraphByElement(wordElement);
    const sourceEn = wordElement.closest('.source-en');
    openWordPopover({
      anchor: wordElement,
      word: String(wordElement.dataset.word || ''),
      sentence: sourceEn?.textContent || '',
      paragraph: paragraph ? paragraph.sentences.map((sentence) => sentence.text).join(' ') : '',
    });
  });

  function resizeAllTextareas() {
    for (const paragraph of state.paragraphs) {
      paragraph.textareas.forEach((textarea) => autoResize(textarea));
    }
  }
  let resizeTimer = 0;
  function onWindowResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resizeAllTextareas, 160);
  }
  window.addEventListener('resize', onWindowResize);

  function onVisibilityChange() {
    if (document.hidden && state.dirty.size > 0) void flushSaves();
  }
  document.addEventListener('visibilitychange', onVisibilityChange);

  function onBeforeUnload() {
    for (const index of state.dirty) {
      const paragraph = state.paragraphs.find((item) => item.index === index);
      if (paragraph) saveParagraphKeepalive(buildPayload(paragraph));
    }
  }
  window.addEventListener('beforeunload', onBeforeUnload);

  /* ---------------------------------- 初始化渲染 ---------------------------------- */

  if (!state.paragraphs.length) {
    paragraphList.append(errorState({
      title: '本章没有段落',
      message: '该章节的段落语料为空，可以回到章节目录选择其他章节。',
      actions: [{ label: '回到章节目录', primary: true, onClick: () => { window.location.hash = `#/book/${encodeURIComponent(book.id)}`; } }],
    }));
    sentinel.remove();
  } else {
    renderInitial();
    updateProgressUI();
    if (requestedParagraph) {
      setTimeout(() => {
        scrollToParagraph(requestedParagraph.index);
        if (query.panel === 'review' && requestedParagraph.review) {
          requestedParagraph.panel = 'review';
          renderPanel(requestedParagraph);
          revealPanel(requestedParagraph);
        }
      }, 120);
    } else if (query.panel === 'review' && state.paragraphs[0]?.review) {
      setTimeout(() => {
        const first = state.paragraphs[0];
        scrollToParagraph(first.index, { highlight: false });
        first.panel = 'review';
        renderPanel(first);
        revealPanel(first);
      }, 120);
    }
  }

  // 保存首次位置
  if (state.paragraphs.length) {
    store.setLastLocation(state.bookId, state.chapterIndex, startParagraph?.index ?? 0);
  }

  return {
    async destroy() {
      if (state.destroyed) return;
      closeDrawer();
      closeWordPopover();
      menuController.destroy();
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('resize', onWindowResize);
      if (desktopQuery) {
        if (typeof desktopQuery.removeEventListener === 'function') desktopQuery.removeEventListener('change', onDesktopChange);
        else if (typeof desktopQuery.removeListener === 'function') desktopQuery.removeListener(onDesktopChange);
      }
      clearTimeout(saveTimer);
      clearTimeout(resizeTimer);
      state.observer?.disconnect();
      for (const paragraph of state.paragraphs) {
        if (paragraph.skeletonTimer) clearInterval(paragraph.skeletonTimer);
      }
      if (state.dirty.size > 0) {
        try {
          await Promise.race([flushSaves(), sleep(2000)]);
        } catch { /* 忽略 */ }
      }
      state.destroyed = true;
    },
  };

  /* ---------------------------------- 章节头部 ---------------------------------- */

  function buildChapterHead() {
    const progressLine = el('p', { class: 'practice-chapter-progress', text: '' });
    const lastSaved = findLastSavedParagraph();
    return el(
      'header',
      { class: 'practice-chapter-head' },
      el(
        'div',
        { class: 'practice-chapter-head-main' },
        el('p', { class: 'practice-chapter-eyebrow', text: `CHAPTER ${chapterMeta.number || String(chapterIndex).padStart(2, '0')}` }),
        el('h1', { class: 'practice-chapter-title', text: chapterMeta.title }),
        progressLine,
      ),
      el(
        'div',
        { class: 'practice-chapter-head-side' },
        lastSaved
          ? el(
            'button',
            {
              class: 'btn btn-sm btn-ghost',
              attrs: { type: 'button' },
              on: { click: () => { ensureRenderedThrough(state.paragraphs.indexOf(lastSaved)); scrollToParagraph(lastSaved.index); lastSaved.textareas[0]?.focus({ preventScroll: true }); } },
            },
            icon('target', { size: 14 }),
            el('span', { text: '跳到上次翻译的段落' }),
          )
          : null,
        el('span', { class: 'practice-chapter-tip' }, icon('keyboard', { size: 13 }), 'Ctrl / ⌘ + Enter 批改当前段'),
      ),
    );
  }

  function findLastSavedParagraph() {
    const saved = state.paragraphs
      .filter((paragraph) => paragraph.savedAt)
      .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
    return saved[0] || null;
  }
}

/* ------------------------------- 页面级错误页 ------------------------------- */

function buildFatalPage({ title, message = '', error = null, actions = [] }) {
  return el(
    'div',
    { class: 'page practice-fatal' },
    el(
      'header',
      { class: 'fatal-header' },
      el('a', { class: 'brand', attrs: { href: '#/' } }, el('span', { class: 'brand-text' }, el('strong', { text: '逐句译' }), el('small', { text: 'Translate Study' }))),
      el('a', { class: 'back-link', attrs: { href: '#/' } }, icon('arrow-left', { size: 16 }), el('span', { text: '返回书架' })),
    ),
    el('div', { class: 'fatal-body' }, errorState({ title, message, error, actions })),
  );
}
