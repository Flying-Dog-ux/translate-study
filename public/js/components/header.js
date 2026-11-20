/** 站点顶栏（书架 / 待复习 / 设置 等页面共用） */

import { el } from '../utils.js';
import { brandMark, icon } from '../icons.js';
import { api } from '../api.js';
import * as store from '../store.js';
import { toast } from '../ui.js';

/**
 * @param {{current?: 'library'|'review'|'settings'|'book', reviewCount?: number}} [options]
 * @returns {HTMLElement}
 */
export function siteHeader({ current = 'library', reviewCount = 0 } = {}) {
  const themeNow = store.getEffectiveTheme();
  const themeButton = el(
    'button',
    {
      class: 'icon-btn theme-toggle',
      attrs: {
        type: 'button',
        'aria-label': themeNow === 'dark' ? '切换到浅色主题' : '切换到深色主题',
        title: themeNow === 'dark' ? '切换到浅色主题' : '切换到深色主题',
      },
    },
    icon(themeNow === 'dark' ? 'sun' : 'moon', { size: 18 }),
  );
  themeButton.addEventListener('click', () => {
    const next = store.toggleTheme();
    themeButton.replaceChildren(icon(next === 'dark' ? 'sun' : 'moon', { size: 18 }));
    const label = next === 'dark' ? '切换到浅色主题' : '切换到深色主题';
    themeButton.setAttribute('aria-label', label);
    themeButton.setAttribute('title', label);
    toast(next === 'dark' ? '已切换到深色主题' : '已切换到浅色主题', { type: 'info', duration: 1600 });
  });

  const navItems = [
    { id: 'library', label: '书架', href: '#/' },
    { id: 'review', label: '待复习', href: '#/review', count: reviewCount },
    { id: 'settings', label: '设置', href: '#/settings' },
  ];

  const nav = el(
    'nav',
    { class: 'site-nav', attrs: { 'aria-label': '主导航' } },
    ...navItems.map((item) => el(
      'a',
      {
        class: `site-nav-link${current === item.id ? ' is-active' : ''}`.trim(),
        attrs: { href: item.href, ...(current === item.id ? { 'aria-current': 'page' } : {}) },
      },
      el('span', { text: item.label }),
      item.count > 0 ? el('span', { class: 'nav-count', text: String(Math.min(item.count, 99)) }) : null,
    )),
    themeButton,
    api.isMock()
      ? el(
        'a',
        {
          class: 'mock-badge',
          attrs: { href: '#/settings', title: '当前为本地演示模式，数据保存在浏览器 localStorage' },
        },
        icon('sparkles', { size: 13 }),
        el('span', { text: '演示模式' }),
      )
      : null,
  );

  return el(
    'header',
    { class: 'site-header' },
    el(
      'a',
      { class: 'brand', attrs: { href: '#/', 'aria-label': '逐句译 · 返回书架' } },
      el('span', { class: 'brand-mark' }, brandMark(34)),
      el(
        'span',
        { class: 'brand-text' },
        el('strong', { text: '逐句译' }),
        el('small', { text: 'Translate Study' }),
      ),
    ),
    nav,
  );
}
