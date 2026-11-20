/** 设置页：#/settings —— 服务状态、外观、数据管理、快捷键、关于 */

import { el, formatDateTime, formatNumber, timestampSlug, downloadJson } from '../utils.js';
import { icon } from '../icons.js';
import { siteHeader } from '../components/header.js';
import { api } from '../api.js';
import * as store from '../store.js';
import { confirmDialog, errorState, loadingState, shortcutsTable, spinner, toast } from '../ui.js';

function sectionCard({ title, subtitle = '', iconName = 'settings', actions = [] }, ...children) {
  return el(
    'section',
    { class: 'settings-card' },
    el(
      'div',
      { class: 'settings-card-head' },
      el('div', { class: 'settings-card-heading' }, el('span', { class: 'settings-card-icon' }, icon(iconName, { size: 17 })), el('h2', { class: 'settings-card-title', text: title })),
      actions.length ? el('div', { class: 'settings-card-actions' }, ...actions) : null,
    ),
    subtitle ? el('p', { class: 'settings-card-subtitle', text: subtitle }) : null,
    el('div', { class: 'settings-card-body' }, ...children),
  );
}

function settingsRow(label, valueNode, hint = '') {
  return el(
    'div',
    { class: 'settings-row' },
    el(
      'div',
      { class: 'settings-row-label' },
      el('span', { class: 'settings-row-name', text: label }),
      hint ? el('span', { class: 'settings-row-hint', text: hint }) : null,
    ),
    el('div', { class: 'settings-row-value' }, valueNode),
  );
}

function statusPill(kind, label) {
  return el('span', { class: `status-pill status-pill--${kind}` }, el('span', { class: 'status-dot' }), el('span', { text: label }));
}

export async function mount({ root }) {
  document.title = '设置 · 逐句译';
  const page = el('div', { class: 'page page--settings' });
  root.append(loadingState({ title: '正在读取设置与服务状态…' }));

  let alive = true;
  let manifest = null;
  let manifestError = null;
  let progressError = null;

  try {
    manifest = await store.loadManifest();
    await store.loadProgress();
  } catch (error) {
    if (manifestError == null) manifestError = error;
  }
  try {
    await store.loadProgress();
  } catch (error) {
    progressError = error;
  }

  const healthState = { data: null, error: null, loading: true };
  const importState = { text: '', importing: false };

  function safeReviewCount() {
    try { return store.getReviewItems().length; } catch { return 0; }
  }

  function safeOverall() {
    try { return store.getOverallStats(); } catch { return { translated: 0, total: 0, percent: 0 }; }
  }

  async function refreshHealth() {
    healthState.loading = true;
    if (alive) renderAll();
    try {
      healthState.data = await store.loadHealth({ force: true });
      healthState.error = null;
    } catch (error) {
      healthState.data = null;
      healthState.error = error;
    }
    healthState.loading = false;
    if (alive) renderAll();
  }

  /* ---------------------------------- 服务状态 ---------------------------------- */

  function buildHealthSection() {
    const refreshButton = el(
      'button',
      {
        class: 'btn btn-sm',
        attrs: { type: 'button', disabled: healthState.loading || undefined },
        on: { click: () => { void refreshHealth(); } },
      },
      healthState.loading ? spinner(14) : icon('refresh', { size: 15 }),
      el('span', { text: healthState.loading ? '检测中…' : '重新检测' }),
    );

    const content = [];
    if (healthState.error) {
      content.push(
        el(
          'div',
          { class: 'settings-inline-error', attrs: { role: 'alert' } },
          icon('alert-triangle', { size: 18 }),
          el(
            'div',
            {},
            el('p', { class: 'settings-inline-error-title', text: '无法连接本机后端服务' }),
            el('p', { class: 'settings-inline-error-msg', text: healthState.error.message }),
            healthState.error.code === 'NOT_FOUND' || healthState.error.code === 'NETWORK'
              ? el('p', { class: 'settings-inline-error-hint', text: '请确认在项目根目录运行了 npm start；如果你只想预览界面，可以开启演示模式。' })
              : null,
          ),
        ),
      );
    } else if (healthState.data) {
      const data = healthState.data;
      const corpus = data.corpus || {};
      content.push(
        el(
          'div',
          { class: 'health-hero' },
          el(
            'div',
            { class: 'health-hero-main' },
            statusPill('ok', api.isMock() ? '演示服务运行中' : '服务运行中'),
            el('p', { class: 'health-hero-title', text: api.isMock() ? '这是本地演示模式' : '本机服务已就绪' }),
            el('p', {
              class: 'health-hero-sub',
              text: api.isMock()
                ? '当前使用 public/js/mock 下的示例数据，AI 批改为本地模拟结果，进度保存在浏览器 localStorage。'
                : '前端已连接到本机 Node 服务；AI 批改通过服务端调用 DeepSeek，API Key 只在服务端读取。',
            }),
          ),
          el(
            'div',
            { class: 'health-hero-meta' },
            el('span', {}, el('b', { text: data.version || '—' }), ' 版本'),
            el('span', {}, el('b', { text: data.model || '—' }), ' 模型'),
          ),
        ),
        el(
          'div',
          { class: 'settings-rows' },
          settingsRow('API Key', data.keyConfigured ? statusPill('ok', '已配置') : statusPill('warn', '未配置'), data.keyConfigured ? '批改功能可用' : '批改会返回 AI_AUTH，请配置 .env 后重启'),
          settingsRow('模型', el('code', { class: 'settings-code', text: data.model || '—' })),
          settingsRow('接口地址', el('code', { class: 'settings-code', text: data.baseUrlHost || '—' }), 'DeepSeek API host'),
          settingsRow(
            '语料',
            el('span', { class: 'settings-value-text', text: `${formatNumber(corpus.books || 0)} 本 · ${formatNumber(corpus.chapters || 0)} 章 · ${formatNumber(corpus.sentences || 0)} 句` }),
          ),
          settingsRow('进度更新时间', el('span', { class: 'settings-value-text', text: data.progressUpdatedAt ? formatDateTime(data.progressUpdatedAt) : '暂无保存' })),
          settingsRow('本机翻译进度', el('span', { class: 'settings-value-text', text: `${formatNumber(safeOverall().translated)} / ${formatNumber(safeOverall().total)} 句` })),
        ),
      );
      if (!data.keyConfigured) {
        content.push(
          el(
            'div',
            { class: 'settings-notice settings-notice--warn' },
            icon('info', { size: 16 }),
            el('p', { text: '如需 AI 批改：在项目根目录创建 .env，写入 DEEPSEEK_API_KEY=你的密钥，然后重启 npm start。密钥不会写入日志或前端。' }),
          ),
        );
      }
    } else if (healthState.loading) {
      content.push(
        el(
          'div',
          { class: 'settings-skeleton-rows' },
          el('span', { class: 'skeleton', style: { width: '60%', height: '18px' } }),
          el('span', { class: 'skeleton', style: { width: '80%', height: '14px' } }),
          el('span', { class: 'skeleton', style: { width: '50%', height: '14px' } }),
        ),
      );
    }

    return sectionCard(
      { title: '服务状态', subtitle: '查看本机服务、AI Key 与语料统计（来自 /api/health）', iconName: 'activity', actions: [refreshButton] },
      ...content,
    );
  }

  /* ---------------------------------- 演示模式 ---------------------------------- */

  function buildMockSection() {
    if (api.isMock()) {
      return sectionCard(
        { title: '演示模式', subtitle: '无需后端即可体验完整界面；数据仅保存在当前浏览器', iconName: 'sparkles' },
        el('div', { class: 'settings-notice' }, icon('info', { size: 16 }), el('p', { text: '当前为演示模式：书架只有《魔法石》前两章的示例语料，AI 批改为本地模拟。进度保存在 localStorage（dev_progress_v1），与真实 data/progress.json 互不影响。' })),
        el(
          'div',
          { class: 'settings-button-row' },
          el('button', { class: 'btn btn-primary', attrs: { type: 'button' }, on: { click: handleSeedDemo } }, icon('sparkles', { size: 15 }), el('span', { text: '载入示例进度' })),
          el('button', { class: 'btn', attrs: { type: 'button' }, on: { click: handleExitMock } }, icon('arrow-right', { size: 15 }), el('span', { text: '退出演示模式' })),
        ),
        el('p', { class: 'settings-hint', text: '「载入示例进度」会写入几段已译、收藏和 AI 批改结果，方便查看完整界面（会覆盖当前演示数据）。' }),
      );
    }
    return sectionCard(
      { title: '演示模式', subtitle: '还没有启动后端？可以先看一眼完整界面', iconName: 'sparkles' },
      el(
        'div',
        { class: 'settings-notice' },
        icon('info', { size: 16 }),
        el('p', { text: '演示模式使用 public/js/mock 下的示例语料与本地模拟批改，进度保存在浏览器 localStorage，不会影响真实进度。' }),
      ),
      el(
        'div',
        { class: 'settings-button-row' },
        el('button', { class: 'btn', attrs: { type: 'button' }, on: { click: handleEnterMock } }, icon('sparkles', { size: 15 }), el('span', { text: '体验演示模式（含示例进度）' })),
      ),
    );
  }

  async function handleSeedDemo() {
    try {
      const { seedDemoProgress } = await import('../mock/mock-api.js');
      await seedDemoProgress({ force: true });
      toast('已载入示例进度，正在刷新…', { type: 'success' });
      setTimeout(() => window.location.reload(), 700);
    } catch (error) {
      toast(`载入示例进度失败：${error.message}`, 'error');
    }
  }

  function handleEnterMock() {
    const url = new URL(window.location.href);
    url.searchParams.set('mock', '1');
    url.searchParams.set('demo', '1');
    window.location.href = url.toString();
  }

  function handleExitMock() {
    api.setMockMode(false);
    const url = new URL(window.location.href);
    url.searchParams.delete('mock');
    url.searchParams.delete('demo');
    window.location.href = `${url.pathname}${url.search || ''}${url.hash || '#/'}`;
  }

  /* ---------------------------------- 外观 ---------------------------------- */

  function buildAppearanceSection() {
    const fontValue = el('span', { class: 'font-size-value', text: `${Math.round(store.getFontScale() * 100)}%` });
    const minusBtn = el('button', { class: 'btn btn-sm', attrs: { type: 'button', 'aria-label': '减小字号' } }, icon('minus', { size: 14 }), el('span', { text: 'A-' }));
    const plusBtn = el('button', { class: 'btn btn-sm', attrs: { type: 'button', 'aria-label': '增大字号' } }, icon('plus', { size: 14 }), el('span', { text: 'A+' }));

    function syncFontButtons() {
      fontValue.textContent = `${Math.round(store.getFontScale() * 100)}%`;
      minusBtn.disabled = !store.canAdjustFontScale(-1);
      plusBtn.disabled = !store.canAdjustFontScale(1);
    }
    minusBtn.addEventListener('click', () => { store.adjustFontScale(-1); syncFontButtons(); });
    plusBtn.addEventListener('click', () => { store.adjustFontScale(1); syncFontButtons(); });
    syncFontButtons();

    const themeOptions = [
      { id: 'light', label: '浅色', iconName: 'sun' },
      { id: 'dark', label: '深色', iconName: 'moon' },
      { id: 'auto', label: '跟随系统', iconName: 'target' },
    ];
    const themeButtons = themeOptions.map((option) => {
      const button = el(
        'button',
        {
          class: 'segmented-btn',
          attrs: { type: 'button', 'aria-pressed': String(store.getThemePreference() === option.id) },
          on: {
            click: () => {
              store.setTheme(option.id);
              syncThemeButtons();
            },
          },
        },
        icon(option.iconName, { size: 15 }),
        el('span', { text: option.label }),
      );
      button._themeId = option.id;
      return button;
    });

    function syncThemeButtons() {
      for (const button of themeButtons) {
        const active = store.getThemePreference() === button._themeId;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
      }
    }
    syncThemeButtons();

    return sectionCard(
      { title: '外观', subtitle: '阅读偏好会保存在本机浏览器，下次打开自动恢复', iconName: 'sun' },
      settingsRow('主题', el('div', { class: 'segmented', attrs: { role: 'group', 'aria-label': '主题' } }, ...themeButtons)),
      settingsRow('正文字号', el('div', { class: 'font-size-control' }, minusBtn, fontValue, plusBtn), '影响练习页英文原句与中文输入框的字号'),
    );
  }

  /* ---------------------------------- 数据管理 ---------------------------------- */

  function buildDataSection() {
    const exportBtn = el(
      'button',
      { class: 'btn', attrs: { type: 'button' }, on: { click: () => { void handleExport(); } } },
      icon('download', { size: 15 }),
      el('span', { text: '导出进度 JSON' }),
    );

    const fileInput = el('input', { class: 'visually-hidden', attrs: { type: 'file', accept: 'application/json,.json', 'aria-label': '选择进度 JSON 文件' } });
    fileInput.addEventListener('change', (event) => { void handleImportFile(event); });

    const importBtn = el(
      'button',
      { class: 'btn', attrs: { type: 'button', disabled: importState.importing || undefined }, on: { click: () => fileInput.click() } },
      icon('upload', { size: 15 }),
      el('span', { text: importState.importing ? '导入中…' : '导入进度 JSON' }),
    );

    const resetBtn = el(
      'button',
      { class: 'btn btn-danger', attrs: { type: 'button', disabled: importState.importing || undefined }, on: { click: () => { void handleReset(); } } },
      icon('trash', { size: 15 }),
      el('span', { text: '重置全部进度' }),
    );

    const overall = safeOverall();
    const progressLine = el('span', {
      class: 'settings-value-text',
      text: `${formatNumber(overall.translated)} / ${formatNumber(overall.total)} 句已翻译 · 收藏与批改结果随段落进度一起导出`,
    });

    const importStatusEl = el('p', {
      class: 'import-status',
      attrs: { role: 'status', 'aria-live': 'polite' },
    });
    if (importState.text) importStatusEl.textContent = importState.text;
    else importStatusEl.hidden = true;
    // 导入过程需要直接更新状态文案，挂到闭包变量上
    dataStatusUpdater = (text) => { importState.text = text; importStatusEl.hidden = !text; importStatusEl.textContent = text; };

    return sectionCard(
      { title: '数据管理', subtitle: '进度保存在本机；建议在重置前先导出备份', iconName: 'folder' },
      settingsRow(
        '进度与备份',
        el('div', { class: 'settings-button-row' }, exportBtn, importBtn, fileInput),
        progressError ? `进度读取失败：${progressError.message}` : '导出文件包含译文、收藏与 AI 批改结果',
      ),
      el('div', { class: 'settings-divider' }),
      settingsRow(
        '危险操作',
        el('div', { class: 'settings-button-row' }, resetBtn),
        dataStorageHint(),
      ),
      el('div', { class: 'settings-progress-line' }, progressLine),
      importStatusEl,
    );
  }

  let dataStatusUpdater = () => {};

  function dataStorageHint() {
    if (api.isMock()) return '演示模式：重置会清空浏览器 localStorage 中的演示进度';
    return '正式模式：重置会删除服务端 data/progress.json 中的全部进度';
  }

  async function handleExport() {
    try {
      const response = await api.getProgress();
      const data = response?.data && typeof response.data === 'object' ? response.data : { books: {} };
      downloadJson(`逐句译_进度备份_${timestampSlug()}.json`, {
        version: 1,
        exportedAt: new Date().toISOString(),
        books: data.books || {},
      });
      toast('进度已导出', { type: 'success' });
    } catch (error) {
      toast(`导出失败：${error.message}`, 'error');
    }
  }

  function extractBooks(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.books && typeof parsed.books === 'object') return parsed.books;
    if (parsed.data && typeof parsed.data === 'object' && parsed.data.books) return parsed.data.books;
    return null;
  }

  async function handleImportFile(event) {
    if (importState.importing) return;
    const file = event.target?.files?.[0];
    if (event.target) event.target.value = '';
    if (!file) return;
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('文件过大（超过 20MB）。');
      const text = await file.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw new Error('不是合法的 JSON 文件。'); }
      const books = extractBooks(parsed);
      if (!books) throw new Error('文件缺少 books 字段，可能不是逐句译导出的进度文件。');

      const entries = [];
      for (const [bookId, bookData] of Object.entries(books)) {
        const chapters = bookData?.chapters && typeof bookData.chapters === 'object' ? bookData.chapters : {};
        for (const [chapterIndex, chapterData] of Object.entries(chapters)) {
          const paragraphs = chapterData?.paragraphs && typeof chapterData.paragraphs === 'object' ? chapterData.paragraphs : {};
          for (const [paragraphIndex, paragraphData] of Object.entries(paragraphs)) {
            entries.push({
              bookId,
              chapterIndex: Number(chapterIndex),
              paragraphIndex: Number(paragraphIndex),
              data: paragraphData && typeof paragraphData === 'object' ? paragraphData : {},
            });
          }
        }
      }
      if (!entries.length) throw new Error('文件里没有可导入的段落进度。');
      if (entries.length > 5000) throw new Error(`段落数量过多（${entries.length}），请确认文件来源。`);

      const confirmed = await confirmDialog({
        title: '导入进度',
        message: `共发现 ${entries.length} 个段落进度。导入会覆盖本机上相同段落的数据，是否继续？`,
        confirmText: `导入 ${entries.length} 段`,
        cancelText: '取消',
        note: '建议先导出一份当前进度作为备份。',
      });
      if (!confirmed) return;

      importState.importing = true;
      dataStatusUpdater(`导入中 0 / ${entries.length}…`);
      renderAll();
      let done = 0;
      let failed = 0;
      for (const entry of entries) {
        try {
          await store.persistParagraph({
            bookId: entry.bookId,
            chapterIndex: entry.chapterIndex,
            paragraphIndex: entry.paragraphIndex,
            sentences: Array.isArray(entry.data.sentences) ? entry.data.sentences : [],
            starred: Boolean(entry.data.starred),
            review: entry.data.review && typeof entry.data.review === 'object' ? entry.data.review : null,
          });
          done += 1;
        } catch {
          failed += 1;
        }
        if ((done + failed) % 3 === 0 || done + failed === entries.length) {
          dataStatusUpdater(`导入中 ${done + failed} / ${entries.length}…`);
        }
      }
      importState.importing = false;
      dataStatusUpdater(failed ? `导入完成：成功 ${done} 段，失败 ${failed} 段（可再次尝试）` : `导入完成：共 ${done} 段`);
      toast(failed ? `导入完成，${failed} 段失败` : '进度导入完成', failed ? 'warn' : 'success');
      await store.loadProgress({ force: true }).catch(() => {});
      renderAll();
    } catch (error) {
      importState.importing = false;
      if (alive) toast(`导入失败：${error.message}`, 'error');
      renderAll();
    }
  }

  async function handleReset() {
    const confirmed = await confirmDialog({
      title: '重置全部进度',
      message: '将删除本机保存的所有译文、收藏与 AI 批改结果，且无法恢复。确定继续吗？',
      confirmText: '确认重置',
      cancelText: '取消',
      danger: true,
      note: '建议先导出进度备份。',
    });
    if (!confirmed) return;
    try {
      await store.resetProgress();
      await store.loadProgress({ force: true }).catch(() => {});
      importState.text = '';
      toast('已重置全部进度', { type: 'success' });
      renderAll();
    } catch (error) {
      toast(`重置失败：${error.message}`, 'error');
    }
  }

  /* ---------------------------------- 快捷键 / 关于 ---------------------------------- */

  function buildShortcutsSection() {
    return sectionCard(
      { title: '快捷键', subtitle: '在练习页使用，输入框内同样生效', iconName: 'keyboard' },
      shortcutsTable(),
      el('p', { class: 'settings-hint', text: '输入内容会在停止输入 800 毫秒后自动保存；切换章节或关闭页面前会自动保存。' }),
    );
  }

  function buildAboutSection() {
    return sectionCard(
      { title: '关于', subtitle: '本地单用户 · 零外部依赖 · 数据只保存在本机', iconName: 'info' },
      el(
        'div',
        { class: 'settings-rows' },
        settingsRow('语料来源', el('span', { class: 'settings-value-text', text: '本机哈利波特英文 PDF，经 scripts/build_corpus.py 抽取为 data/corpus' })),
        settingsRow('AI 批改', el('span', { class: 'settings-value-text', text: 'DeepSeek；API Key 由本机服务端读取，不会出现在前端或日志里' })),
        settingsRow('进度存储', el('span', { class: 'settings-value-text', text: api.isMock() ? '浏览器 localStorage（演示模式）' : 'data/progress.json（服务端原子写入）' })),
        settingsRow('前端技术', el('span', { class: 'settings-value-text', text: '原生 ES modules + CSS，零框架 / 零构建 / 零 CDN' })),
        settingsRow('隐私', el('span', { class: 'settings-value-text', text: '除批改请求发往 DeepSeek 外，所有数据都留在本机' })),
      ),
      el(
        'div',
        { class: 'settings-footer-note' },
        el('span', { text: '逐句译 · Translate Study' }),
        el('span', { class: 'footer-dot', text: '·' }),
        el('span', { text: manifest ? `${formatNumber((manifest.books || []).length)} 本书 · ${formatNumber((manifest.books || []).reduce((sum, book) => sum + (book.chapterCount || book.chapters?.length || 0), 0))} 章` : '语料未加载' }),
      ),
    );
  }

  /* ---------------------------------- 页面 ---------------------------------- */

  function renderAll() {
    if (!alive) return;
    const content = el(
      'div',
      { class: 'page-inner page-inner--narrow' },
      el('a', { class: 'back-link', attrs: { href: '#/' } }, icon('arrow-left', { size: 16 }), el('span', { text: '返回书架' })),
      el(
        'section',
        { class: 'page-head' },
        el('p', { class: 'eyebrow' }, el('span', { class: 'eyebrow-rule' }), 'SETTINGS'),
        el('h1', { class: 'page-title', text: '设置' }),
        el('p', { class: 'page-sub', text: '查看服务状态、调整阅读偏好、备份进度，或了解数据都去了哪里。' }),
      ),
      manifestError
        ? el(
          'div',
          { class: 'settings-card' },
          errorState({
            title: '语料数据加载失败',
            error: manifestError,
            actions: [
              { label: '重试', icon: 'refresh', primary: true, onClick: () => { window.location.reload(); } },
              { label: '使用演示数据', icon: 'sparkles', onClick: () => { api.setMockMode(true); window.location.reload(); } },
            ],
          }),
        )
        : null,
      buildHealthSection(),
      buildMockSection(),
      buildAppearanceSection(),
      buildDataSection(),
      buildShortcutsSection(),
      buildAboutSection(),
      el(
        'footer',
        { class: 'site-footer site-footer--settings' },
        el('span', { text: '所有设置均保存在本机浏览器；重置进度不影响设置。' }),
      ),
    );
    page.replaceChildren(siteHeader({ current: 'settings', reviewCount: safeReviewCount() }), content);
    root.replaceChildren(page);
  }

  renderAll();
  void refreshHealth();

  return {
    destroy() {
      alive = false;
    },
  };
}
