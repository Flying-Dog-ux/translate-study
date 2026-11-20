/**
 * 通用 UI 组件：toast、modal / confirm、进度环、加载 / 空 / 错误状态、下拉菜单、快捷键表。
 */

import { clamp, copyText, el } from './utils.js';
import { icon } from './icons.js';
import { SHORTCUTS } from './constants.js';

/* ----------------------------------- toast ----------------------------------- */

const TOAST_ICONS = {
  success: 'check',
  error: 'alert-circle',
  warn: 'alert-triangle',
  info: 'info',
};

/**
 * 轻量 toast 提示。
 * @param {string} message
 * @param {'info'|'success'|'error'|'warn'|{type?: string, duration?: number}} [options]
 */
export function toast(message, options = {}) {
  const { type = 'info', duration = 3200 } = typeof options === 'string' ? { type: options } : options;
  const region = document.getElementById('toast-region');
  if (!region) return () => {};
  const node = el(
    'div',
    { class: `toast toast--${type}`, attrs: { role: type === 'error' ? 'alert' : 'status' } },
    icon(TOAST_ICONS[type] || 'info', { size: 16, cls: 'toast-icon' }),
    el('span', { class: 'toast-text', text: message }),
  );
  region.append(node);
  requestAnimationFrame(() => node.classList.add('is-visible'));
  let timer = setTimeout(remove, duration);
  node.addEventListener('click', remove);
  function remove() {
    clearTimeout(timer);
    node.classList.remove('is-visible');
    setTimeout(() => node.remove(), 240);
  }
  return remove;
}

/** 复制文本并给出 toast 反馈 */
export async function copyWithToast(text, label = '译文') {
  const value = String(text ?? '');
  if (!value.trim()) {
    toast(`没有可复制的${label}`, 'warn');
    return false;
  }
  const ok = await copyText(value);
  toast(ok ? `已复制${label}` : '复制失败，请手动选择文本复制', ok ? 'success' : 'error');
  return ok;
}

/* ----------------------------------- modal ----------------------------------- */

function focusableIn(panel) {
  return [...panel.querySelectorAll('a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((node) => node.offsetParent !== null || node === document.activeElement);
}

/**
 * 打开一个模态框。
 * @returns {{close: (result?: unknown) => void, element: HTMLElement}}
 */
export function createModal({ title = '', body = null, footer = null, size = 'md', dismissible = true, onClose = null, initialFocus = null } = {}) {
  const root = document.getElementById('modal-root');
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (!root) return { close() {}, element: null };

  const overlay = el('div', { class: 'modal-overlay' });
  const panel = el('div', {
    class: `modal modal--${size}`,
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '对话框' },
  });
  if (title) panel.append(el('h2', { class: 'modal-title', text: title }));
  const bodyWrap = el('div', { class: 'modal-body' });
  if (body) bodyWrap.append(body);
  panel.append(bodyWrap);
  if (footer && footer.length) {
    const footerWrap = el('div', { class: 'modal-footer' });
    for (const node of footer) if (node) footerWrap.append(node);
    panel.append(footerWrap);
  }
  const closeButton = el(
    'button',
    {
      class: 'icon-btn modal-close',
      attrs: { type: 'button', 'aria-label': '关闭对话框' },
      on: { click: () => close(null) },
    },
    icon('x', { size: 18 }),
  );
  panel.append(closeButton);
  overlay.append(panel);
  root.append(overlay);
  requestAnimationFrame(() => overlay.classList.add('is-open'));

  let closed = false;
  function close(result = null) {
    if (closed) return;
    closed = true;
    overlay.classList.remove('is-open');
    document.removeEventListener('keydown', onKeyDown, true);
    setTimeout(() => overlay.remove(), 220);
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      setTimeout(() => previouslyFocused.focus(), 0);
    }
    if (onClose) onClose(result);
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && dismissible) {
      event.preventDefault();
      event.stopPropagation();
      close(null);
      return;
    }
    if (event.key === 'Tab') {
      const focusables = focusableIn(panel);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay && dismissible) close(null);
  });
  document.addEventListener('keydown', onKeyDown, true);

  const focusTarget = initialFocus || focusableIn(panel).find((node) => !node.classList.contains('modal-close')) || panel;
  setTimeout(() => { try { focusTarget.focus(); } catch { /* 忽略 */ } }, 30);

  return { close, element: panel };
}

/**
 * 二次确认对话框。
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title = '请确认', message = '', confirmText = '确定', cancelText = '取消', danger = false, note = '', size = 'sm' } = {}) {
  return new Promise((resolve) => {
    let confirmed = false;
    const body = el(
      'div',
      { class: 'confirm-content' },
      message ? el('p', { class: 'confirm-message', text: message }) : null,
      note ? el('p', { class: 'confirm-note', text: note }) : null,
    );
    let modal = null;
    const cancelBtn = el('button', {
      class: 'btn',
      attrs: { type: 'button' },
      text: cancelText,
      on: { click: () => modal.close(false) },
    });
    const okBtn = el('button', {
      class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`,
      attrs: { type: 'button' },
      text: confirmText,
      on: { click: () => { confirmed = true; modal.close(true); } },
    });
    modal = createModal({
      title,
      body,
      footer: [cancelBtn, okBtn],
      size,
      onClose: () => resolve(confirmed),
      initialFocus: okBtn,
    });
  });
}

/** 信息弹窗（只有「知道了」） */
export function infoDialog({ title = '提示', message = '', confirmText = '知道了', body = null } = {}) {
  return new Promise((resolve) => {
    let modal = null;
    const okBtn = el('button', {
      class: 'btn btn-primary',
      attrs: { type: 'button' },
      text: confirmText,
      on: { click: () => modal.close() },
    });
    modal = createModal({
      title,
      body: body || el('p', { class: 'confirm-message', text: message }),
      footer: [okBtn],
      size: 'sm',
      onClose: () => resolve(),
      initialFocus: okBtn,
    });
  });
}

/* ---------------------------------- 状态视图 ---------------------------------- */

export function spinner(size = 18, cls = '') {
  return el('span', { class: `spinner ${cls}`.trim(), style: { width: `${size}px`, height: `${size}px` }, attrs: { 'aria-hidden': 'true' } });
}

export function loadingState({ title = '正在加载…', message = '' } = {}) {
  return el(
    'div',
    { class: 'state-view state-view--loading', attrs: { role: 'status', 'aria-live': 'polite' } },
    spinner(24),
    el('h3', { class: 'state-title', text: title }),
    message ? el('p', { class: 'state-message', text: message }) : null,
  );
}

export function skeletonLine(width = '100%', height = 14) {
  return el('span', { class: 'skeleton', style: { width, height: `${height}px` }, attrs: { 'aria-hidden': 'true' } });
}

/**
 * 错误状态。
 * @param {{title?: string, message?: string, error?: Error & {code?: string}, actions?: Array<{label: string, onClick: Function, primary?: boolean, icon?: string}>, compact?: boolean}} options
 */
export function errorState({ title = '加载失败', message = '', error = null, actions = [], compact = false } = {}) {
  const detail = error && error.code ? `错误码：${error.code}` : '';
  const text = message || error?.message || '出了点问题，请稍后重试。';
  const actionNodes = actions
    .filter(Boolean)
    .map((action) => el(
      'button',
      {
        class: `btn ${action.primary ? 'btn-primary' : ''}`.trim(),
        attrs: { type: 'button' },
        on: { click: action.onClick },
      },
      action.icon ? icon(action.icon, { size: 16 }) : null,
      el('span', { text: action.label }),
    ));
  return el(
    'div',
    { class: `state-view state-view--error${compact ? ' state-view--compact' : ''}`, attrs: { role: 'alert' } },
    el('div', { class: 'state-icon state-icon--error' }, icon('alert-triangle', { size: 24 })),
    el('h3', { class: 'state-title', text: title }),
    el('p', { class: 'state-message', text }),
    detail ? el('p', { class: 'state-detail', text: detail }) : null,
    actionNodes.length ? el('div', { class: 'state-actions' }, ...actionNodes) : null,
  );
}

/**
 * 空状态。
 * @param {{icon?: string, title?: string, message?: string, actions?: Array<{label: string, onClick?: Function, href?: string, primary?: boolean}>}} options
 */
export function emptyState({ icon: iconName = 'book-open', title = '这里还是空的', message = '', actions = [] } = {}) {
  const actionNodes = actions.filter(Boolean).map((action) => {
    if (action.href) {
      return el('a', { class: `btn ${action.primary ? 'btn-primary' : ''}`.trim(), attrs: { href: action.href } }, el('span', { text: action.label }));
    }
    return el(
      'button',
      { class: `btn ${action.primary ? 'btn-primary' : ''}`.trim(), attrs: { type: 'button' }, on: { click: action.onClick } },
      action.icon ? icon(action.icon, { size: 16 }) : null,
      el('span', { text: action.label }),
    );
  });
  return el(
    'div',
    { class: 'state-view state-view--empty' },
    el('div', { class: 'state-icon state-icon--empty' }, icon(iconName, { size: 26 })),
    el('h3', { class: 'state-title', text: title }),
    message ? el('p', { class: 'state-message', text: message }) : null,
    actionNodes.length ? el('div', { class: 'state-actions' }, ...actionNodes) : null,
  );
}

/* ---------------------------------- 进度环 ---------------------------------- */

/**
 * 环形进度（SVG）。
 * @param {{percent?: number, size?: number, strokeWidth?: number, label?: string|null, tone?: 'accent'|'gold'|'score', ariaLabel?: string, className?: string}} options
 */
export function progressRing({ percent = 0, size = 56, strokeWidth = 4, label = null, tone = 'accent', ariaLabel = '', className = '' } = {}) {
  const svgNs = 'http://www.w3.org/2000/svg';
  const value = clamp(Number(percent) || 0, 0, 100);
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dash = (value / 100) * circumference;

  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('class', 'ring-svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const track = document.createElementNS(svgNs, 'circle');
  track.setAttribute('class', 'ring-track');
  track.setAttribute('cx', String(size / 2));
  track.setAttribute('cy', String(size / 2));
  track.setAttribute('r', String(radius));
  track.setAttribute('fill', 'none');
  track.setAttribute('stroke-width', String(strokeWidth));

  const fill = document.createElementNS(svgNs, 'circle');
  fill.setAttribute('class', 'ring-fill');
  fill.setAttribute('cx', String(size / 2));
  fill.setAttribute('cy', String(size / 2));
  fill.setAttribute('r', String(radius));
  fill.setAttribute('fill', 'none');
  fill.setAttribute('stroke-width', String(strokeWidth));
  fill.setAttribute('stroke-linecap', 'round');
  fill.setAttribute('stroke-dasharray', `${dash} ${circumference}`);
  fill.setAttribute('transform', `rotate(-90 ${size / 2} ${size / 2})`);

  svg.append(track, fill);
  const wrap = el(
    'div',
    {
      class: `ring ring--${tone} ${className}`.trim(),
      style: { width: `${size}px`, height: `${size}px` },
      attrs: { role: 'img', 'aria-label': ariaLabel || (label ? `进度 ${label}` : `进度 ${Math.round(value)}%`) },
    },
    svg,
    label !== null ? el('span', { class: 'ring-label', text: String(label) }) : null,
  );
  return wrap;
}

/* ---------------------------------- 下拉菜单 ---------------------------------- */

/**
 * 给触发按钮挂一个下拉菜单。
 * @param {HTMLElement} trigger
 * @param {() => Array<{label?: string, icon?: string, hint?: string, danger?: boolean, divider?: boolean, onClick?: Function}>} buildItems
 * @returns {{close: Function, destroy: Function}}
 */
export function attachMenu(trigger, buildItems) {
  let menu = null;

  const close = () => {
    if (!menu) return;
    menu.remove();
    menu = null;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onOutsideClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', positionMenu);
    window.removeEventListener('scroll', positionMenu, true);
  };

  const positionMenu = () => {
    if (!menu) return;
    const rect = trigger.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    let left = rect.right - width;
    left = clamp(left, 8, window.innerWidth - width - 8);
    let top = rect.bottom + 8;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 8);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  };

  function onOutsideClick(event) {
    if (!menu) return;
    if (menu.contains(event.target) || trigger.contains(event.target)) return;
    close();
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }

  const open = () => {
    if (menu) return close();
    menu = el('div', { class: 'menu', attrs: { role: 'menu' } });
    for (const item of buildItems() || []) {
      if (!item) continue;
      if (item.divider) {
        menu.append(el('div', { class: 'menu-divider', attrs: { role: 'separator' } }));
        continue;
      }
      const node = el(
        'button',
        {
          class: `menu-item${item.danger ? ' menu-item--danger' : ''}`.trim(),
          attrs: { type: 'button', role: 'menuitem' },
          on: {
            click: () => {
              close();
              if (item.onClick) item.onClick();
            },
          },
        },
        item.icon ? icon(item.icon, { size: 16 }) : el('span', { class: 'menu-item-icon' }),
        el('span', { class: 'menu-item-label', text: item.label || '' }),
        item.hint ? el('span', { class: 'menu-item-hint', text: item.hint }) : null,
      );
      menu.append(node);
    }
    document.body.append(menu);
    trigger.setAttribute('aria-expanded', 'true');
    positionMenu();
    document.addEventListener('click', onOutsideClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', positionMenu);
    window.addEventListener('scroll', positionMenu, true);
    const first = menu.querySelector('button');
    if (first) setTimeout(() => first.focus(), 0);
  };

  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.addEventListener('click', open);

  return { close, destroy: close };
}

/* ---------------------------------- 快捷键表 ---------------------------------- */

export function shortcutsTable() {
  const rows = SHORTCUTS.map((item) => el(
    'div',
    { class: 'shortcut-row' },
    el('span', { class: 'shortcut-label', text: item.label }),
    el('kbd', { class: 'shortcut-keys', text: item.keys }),
  ));
  return el('div', { class: 'shortcut-table' }, ...rows);
}
