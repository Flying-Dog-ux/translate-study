/**
 * 应用入口：初始化阅读偏好、演示模式、路由与全局错误提示。
 */

import { api } from './api.js';
import { initPreferences } from './store.js';
import { createRouter } from './router.js';
import { errorState, toast } from './ui.js';
import { isMockRange } from './utils.js';

const appRoot = document.getElementById('app');

function showBootError(error) {
  if (!appRoot) return;
  appRoot.replaceChildren(errorState({
    title: '应用启动失败',
    message: error?.message || '未知错误，请刷新页面重试。',
    error,
  }));
}

async function bootstrap() {
  initPreferences();

  const params = new URLSearchParams(window.location.search);
  // URL 参数优先：?mock=1 强制演示模式，?mock=0 强制正式模式（仅本次会话，不写入 localStorage）
  if (params.has('mock')) {
    api.setMockMode(isMockRange(params.get('mock')), { persist: false });
  }

  // 演示模式下可通过 ?demo=1 播种示例进度，便于独立展示完整 UI（含批改结果 / 待复习）
  if (api.isMock() && params.get('demo') === '1') {
    try {
      const { seedDemoProgress } = await import('./mock/mock-api.js');
      const seeded = await seedDemoProgress();
      if (seeded) toast('已载入演示进度（已译 / 收藏 / AI 批改示例）', { type: 'info', duration: 3600 });
    } catch (error) {
      console.warn('[app] 演示进度播种失败', error);
    }
  }

  if (!appRoot) throw new Error('页面缺少 #app 根节点。');

  const router = createRouter(appRoot, {
    onRouteChange: () => {
      appRoot.setAttribute('aria-busy', 'false');
    },
  });
  router.start();

  // 开发期把关键对象挂到 window，便于在控制台排查（不含任何密钥）
  window.__zs = { api, router };
}

// 全局兜底：未捕获异常给一个 toast，避免用户面对白屏毫无反馈
window.addEventListener('unhandledrejection', (event) => {
  console.error('[app] 未处理的 Promise 拒绝', event.reason);
  const message = event.reason?.message || '发生未知错误，请刷新页面重试。';
  if (document.readyState !== 'loading') toast(message, 'error');
});
window.addEventListener('error', (event) => {
  console.error('[app] 未捕获异常', event.error || event.message);
});

bootstrap().catch((error) => {
  console.error('[app] 启动失败', error);
  showBootError(error);
});

// 某些浏览器在 bfcache 恢复时不会触发 hashchange，这里保证返回时重新渲染
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    window.location.reload();
  }
});
