/**
 * 内联 SVG 图标库（无第三方依赖、无 CDN）。
 * 所有图标均为 24×24 线性图标；路径为本项目自绘 / 通用几何图形。
 * 注意：仅静态字符串走 innerHTML，不接收任何用户或语料文本。
 */

const PATHS = {
  'arrow-left': '<path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>',
  'arrow-right': '<path d="M5 12h14"/><path d="M12 5l7 7-7 7"/>',
  'chevron-down': '<path d="M6 9l6 6 6-6"/>',
  'chevron-right': '<path d="M9 6l6 6-6 6"/>',
  'chevron-left': '<path d="M15 6l-6 6 6 6"/>',
  book: '<path d="M20 3H6.6A2.6 2.6 0 0 0 4 5.6v12.8A2.6 2.6 0 0 0 6.6 21H20z"/><path d="M4 18.4A2.6 2.6 0 0 1 6.6 15.8H20"/>',
  bookmark: '<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.5L5 21V4a1 1 0 0 1 1-1z"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.94a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15.06 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c.2.6.76 1.01 1.4 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  star: '<path d="M12 2.8l2.9 5.9 6.5.95-4.7 4.58 1.11 6.47L12 17.64 6.19 20.7 7.3 14.23 2.6 9.65l6.5-.95z"/>',
  'star-filled': '<path d="M12 2.8l2.9 5.9 6.5.95-4.7 4.58 1.11 6.47L12 17.64 6.19 20.7 7.3 14.23 2.6 9.65l6.5-.95z" fill="currentColor" stroke="none"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2.2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  x: '<path d="M18 6L6 18"/><path d="M6 6l12 12"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="M4.93 4.93l1.42 1.42"/><path d="M17.65 17.65l1.42 1.42"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="M4.93 19.07l1.42-1.42"/><path d="M17.65 6.35l1.42-1.42"/>',
  sparkles:
    '<path d="M12 3l1.7 4.9 4.8 1.7-4.8 1.7L12 16l-1.7-4.7L5.5 9.6l4.8-1.7z"/><path d="M18.5 14l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z"/>',
  bolt: '<path d="M13 2L4.5 13.5H11l-1 8.5L19.5 10H13z"/>',
  menu: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
  more: '<circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
  list: '<path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/><path d="M4 6h.01"/><path d="M4 12h.01"/><path d="M4 18h.01"/>',
  download: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/>',
  upload: '<path d="M12 21V9"/><path d="M7 14l5-5 5 5"/><path d="M5 3h14"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 15H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  keyboard:
    '<rect x="2" y="6" width="20" height="12" rx="2.2"/><path d="M6 10h.01"/><path d="M10 10h.01"/><path d="M14 10h.01"/><path d="M18 10h.01"/><path d="M7 14h10"/>',
  'alert-triangle': '<path d="M12 3.2L22 20.5H2z"/><path d="M12 9.5v4.5"/><path d="M12 17.5h.01"/>',
  'alert-circle': '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.5h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7.5h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.2 1.9"/>',
  'external-link': '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.4h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  play: '<path d="M7 4.8v14.4L19.5 12z"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  quote: '<path d="M9 7H5v6h4v4H5"/><path d="M19 7h-4v6h4v4h-4"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>',
  activity: '<path d="M3 12h4l2.4 6.5L14 5l2.5 7H21"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01"/><path d="M7 16.5h.01"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z"/>',
  cloud: '<path d="M6.5 19a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 17.5 9.5 4.25 4.25 0 0 1 17 19z"/>',
  'rotate-ccw': '<path d="M3 12a9 9 0 1 0 2.64-6.36"/><path d="M3 3v6h6"/>',
  'arrow-up-right': '<path d="M7 17L17 7"/><path d="M8 7h9v9"/>',
  'book-open': '<path d="M12 6.5C10.5 4.9 8.4 4 6 4H2.5v15H6c2.4 0 4.5.9 6 2.5 1.5-1.6 3.6-2.5 6-2.5h3.5V4H18c-2.4 0-4.5.9-6 2.5z"/><path d="M12 6.5V21"/>',
  lightbulb: '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.3 11c.5.4.8 1.1.8 1.8V16h5v-.2c0-.7.3-1.4.8-1.8A6 6 0 0 0 12 3z"/>',
  eye: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>',
  'volume-2': '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
};

/**
 * 创建图标元素。
 * @param {string} name
 * @param {{size?: number, cls?: string, label?: string, strokeWidth?: number}} [options]
 */
export function icon(name, options = {}) {
  const { size = 18, cls = '', label = '', strokeWidth = 1.8 } = options;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(strokeWidth));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', `icon ${cls}`.trim());
  svg.setAttribute('focusable', 'false');
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  svg.innerHTML = PATHS[name] || PATHS.info;
  return svg;
}

/** 品牌标记：抽象四角星 + 折线闪电（原创几何图形，不使用任何官方素材） */
export function brandMark(size = 34) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 48 48');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('class', 'brand-mark-svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.innerHTML = `
    <circle cx="24" cy="24" r="22" fill="none" stroke="currentColor" stroke-opacity=".22" stroke-width="1"/>
    <circle cx="24" cy="24" r="16.5" fill="none" stroke="currentColor" stroke-opacity=".12" stroke-width="1" stroke-dasharray="1 5"/>
    <path d="M24 8l3.7 10.3L38 22l-10.3 3.7L24 36l-3.7-10.3L10 22l10.3-3.7z" fill="currentColor"/>
    <path d="M31 30l-7 12 4.4-.8-2.1 5.5 7.6-11-4.2.7z" fill="currentColor" fill-opacity=".62"/>
    <circle cx="38" cy="10" r="1.6" fill="currentColor" fill-opacity=".55"/>
    <circle cx="9" cy="35" r="1.2" fill="currentColor" fill-opacity=".45"/>`;
  return svg;
}
