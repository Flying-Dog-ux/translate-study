/**
 * 极简 hash 路由。
 * 视图模块约定：export async function mount({ root, params, query, routeName }) => ({ destroy?: Function } | void)
 */

import { errorState } from './ui.js';

const routes = [
  {
    name: 'library',
    match: (path) => (path === '/' ? {} : null),
    load: () => import('./views/library.js'),
  },
  {
    name: 'book',
    match: (path) => {
      const result = path.match(/^\/book\/([^/]+)$/);
      return result ? { bookId: decodeURIComponent(result[1]) } : null;
    },
    load: () => import('./views/book.js'),
  },
  {
    name: 'practice',
    match: (path) => {
      // 允许尾部附加片段（例如演示链接 #/practice/mock/hp1/1），多出的部分忽略
      const result = path.match(/^\/practice\/([^/]+)\/([^/]+)(?:\/.*)?$/);
      return result
        ? { bookId: decodeURIComponent(result[1]), chapterIndex: decodeURIComponent(result[2]) }
        : null;
    },
    load: () => import('./views/practice.js'),
  },
  {
    name: 'review',
    match: (path) => (path === '/review' ? {} : null),
    load: () => import('./views/review.js'),
  },
  {
    name: 'settings',
    match: (path) => (path === '/settings' ? {} : null),
    load: () => import('./views/settings.js'),
  },
];

function parseHash(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  const splitIndex = raw.indexOf('?');
  const pathPart = splitIndex >= 0 ? raw.slice(0, splitIndex) : raw;
  const queryPart = splitIndex >= 0 ? raw.slice(splitIndex + 1) : '';
  let path = pathPart || '/';
  if (!path.startsWith('/')) path = `/${path}`;
  if (path.length > 1) path = path.replace(/\/+$/, '');
  const query = Object.fromEntries(new URLSearchParams(queryPart).entries());
  return { path, query };
}

function matchRoute(path) {
  for (const route of routes) {
    const params = route.match(path);
    if (params) return { route, params };
  }
  return null;
}

export function navigate(hash, { replace = false } = {}) {
  const next = hash.startsWith('#') ? hash : `#${hash.startsWith('/') ? '' : '/'}${hash}`;
  if (location.hash === next) return;
  if (replace) {
    history.replaceState(null, '', `${location.pathname}${location.search}${next}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    location.hash = next;
  }
}

export function createRouter(root, { onRouteChange = null } = {}) {
  let currentView = null;
  let token = 0;
  let started = false;

  async function teardownCurrent() {
    const view = currentView;
    currentView = null;
    if (!view || typeof view.destroy !== 'function') return;
    try {
      await view.destroy();
    } catch (error) {
      console.warn('[router] 视图清理失败', error);
    }
  }

  async function handleRoute() {
    const currentToken = ++token;
    const { path, query } = parseHash(location.hash);
    const matched = matchRoute(path);

    if (!matched) {
      // 未知路由回书架
      navigate('#/', { replace: true });
      return;
    }

    await teardownCurrent();
    if (currentToken !== token) return;

    let view = null;
    try {
      const module = await matched.route.load();
      if (currentToken !== token) return;
      root.replaceChildren();
      view = await module.mount({
        root,
        params: matched.params,
        query,
        routeName: matched.route.name,
      });
    } catch (error) {
      if (currentToken !== token) return;
      console.error('[router] 页面挂载失败', error);
      root.replaceChildren(errorState({
        title: '页面加载失败',
        error,
        actions: [
          { label: '回到书架', primary: true, onClick: () => navigate('#/') },
          { label: '重试', icon: 'refresh', onClick: () => handleRoute() },
        ],
      }));
      return;
    }

    if (currentToken !== token) {
      if (view && typeof view.destroy === 'function') {
        try { await view.destroy(); } catch { /* 忽略 */ }
      }
      return;
    }
    currentView = view && typeof view === 'object' ? view : null;
    root.setAttribute('aria-busy', 'false');
    if (onRouteChange) onRouteChange({ path, query });
  }

  function onHashChange() {
    handleRoute().catch((error) => {
      console.error('[router] 路由处理失败', error);
    });
  }

  function start() {
    if (started) return;
    started = true;
    window.addEventListener('hashchange', onHashChange);
    if (!location.hash) {
      history.replaceState(null, '', `${location.pathname}${location.search}#/`);
    }
    handleRoute().catch((error) => {
      console.error('[router] 首次路由失败', error);
    });
  }

  function destroy() {
    token += 1;
    window.removeEventListener('hashchange', onHashChange);
    teardownCurrent();
  }

  return { start, destroy, refresh: onHashChange };
}
