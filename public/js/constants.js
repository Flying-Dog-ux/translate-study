/**
 * 常量与文案映射。
 * 所有 UI 文案中文；英文书名 / 原句保持原样。
 */

export const APP_NAME = '逐句译';
export const APP_SUBTITLE = 'Translate Study';

/** AI 判定枚举 → 中文标签与样式类名 */
export const VERDICTS = {
  excellent: { label: '优秀', cls: 'excellent' },
  good: { label: '良好', cls: 'good' },
  needs_improvement: { label: '需改进', cls: 'needs-improvement' },
  incorrect: { label: '有误', cls: 'incorrect' },
  missing: { label: '未翻译', cls: 'missing' },
};

/** 需要进入「待复习」的批改结论 */
export const REVIEW_NEEDED_VERDICTS = ['needs_improvement', 'incorrect'];

/** 批改问题类型（后端建议枚举）→ 展示颜色 */
export const ISSUE_TYPES = ['漏译', '误译', '用词', '搭配', '语法', '语序', '语气', '文化', '标点', '冗余'];

/** 批改中的轮换文案 */
export const REVIEW_LOADING_TEXTS = [
  '正在逐句比对原文与译文…',
  '正在提炼具体的修改建议…',
  '正在整理词汇与表达…',
  '正在给整段译文润色…',
];

/** 键盘快捷键说明（设置页 / 练习页面板共用） */
export const SHORTCUTS = [
  { keys: 'Ctrl / ⌘ + Enter', label: '批改当前聚焦的段落' },
  { keys: 'Ctrl / ⌘ + ↓', label: '跳到下一段' },
  { keys: 'Ctrl / ⌘ + ↑', label: '跳到上一段' },
  { keys: 'Esc', label: '关闭批改 / 参考译文面板、查词浮层或目录抽屉' },
];

/** 书籍封面用的罗马数字（按 order） */
export const ROMAN_NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

/** 本地区块链无 — 这里只是 UI 常量占位 */
export const SAVE_DEBOUNCE_MS = 800;
