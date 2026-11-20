/**
 * 配置与 API Key 解析。
 *
 * Key 解析优先级（见 docs/CONTRACT.md §5）：
 *   1. process.env.DEEPSEEK_API_KEY
 *   2. 项目根 .env（逐行 KEY=VALUE，不引入 dotenv 包）
 *   3. Windows 系统变量（Machine，通过 reg query 读取 HKLM 会话环境）
 *   4. Windows 用户变量（HKCU\Environment）
 *
 * 安全约定：本模块解析出的 Key 只在服务端内存中传递，绝不打印、不写文件、
 * 不进任何 HTTP 响应。日志只允许输出 keyConfigured 布尔值与来源标签。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 项目根目录（server/ 的上一级）。 */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MACHINE_ENV_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
const USER_ENV_KEY = 'HKCU\\Environment';

function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version.trim() : '1.0.0';
  } catch {
    return '1.0.0';
  }
}

/** 服务版本号，来自 package.json（读不到则回退 1.0.0）。 */
export const VERSION = readPackageVersion();

const KEY_SOURCE_LABELS = {
  process: '环境变量',
  dotenv: '.env 文件',
  machine: 'Windows 系统变量',
  user: 'Windows 用户变量',
};

/** 把 Key 来源转成中文标签（只用于日志，绝不包含 Key 本身）。 */
export function keySourceLabel(source) {
  return KEY_SOURCE_LABELS[source] ?? '未配置';
}

/**
 * 解析 .env 文本为普通对象。
 * 支持 `#` 注释、空行、`export KEY=VALUE`、单/双引号包裹、行尾 ` # 注释`。
 */
export function parseEnvFile(text) {
  const result = {};
  if (typeof text !== 'string' || !text) return result;
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value[value.length - 1] === quote) {
      value = value.slice(1, -1);
    } else {
      const inlineComment = value.indexOf(' #');
      if (inlineComment >= 0) value = value.slice(0, inlineComment).trim();
    }
    result[match[1]] = value;
  }
  return result;
}

/** 读取 .env 文件，失败（不存在/无权限）返回空对象，不抛错。 */
export function readEnvFile(filePath) {
  try {
    return parseEnvFile(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * 从 `reg query` 的文本输出里解析指定变量值。
 * 输出形如：
 *   HKEY_LOCAL_MACHINE\...\Environment
 *       DEEPSEEK_API_KEY    REG_SZ    sk-xxxx
 */
export function parseRegQueryValue(output, name) {
  if (typeof output !== 'string' || typeof name !== 'string' || !name) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\s*${escaped}\\s+REG_(?:SZ|EXPAND_SZ)\\s+(.*)$`, 'mi');
  const match = pattern.exec(output);
  if (!match) return null;
  const value = match[1].trim();
  return value || null;
}

/**
 * 读取 Windows 持久化环境变量（不走 process.env，直接查注册表）。
 * @param {string} name 变量名
 * @param {'Machine'|'User'} scope Machine=系统变量，User=当前用户变量
 * @returns {string|null}
 */
export function readWindowsEnvironmentVariable(name, scope = 'Machine') {
  if (process.platform !== 'win32') return null;
  const keyPath = scope === 'User' ? USER_ENV_KEY : MACHINE_ENV_KEY;
  try {
    const output = execFileSync('reg', ['query', keyPath, '/v', name], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseRegQueryValue(String(output), name);
  } catch {
    // 变量不存在时 reg 返回非 0 退出码；无权限/注册表不可用时同样静默回退。
    return null;
  }
}

/**
 * 按契约优先级解析 DeepSeek API Key。
 * @param {Record<string, string|undefined>} env 环境变量表（默认 process.env，测试可注入）
 * @param {{envFile?: string}} [options]
 * @returns {{key: string, source: 'process'|'dotenv'|'machine'|'user'|null}}
 */
export function resolveApiKey(env = process.env, options = {}) {
  const envFile = options.envFile
    ?? (typeof env.DEEPSEEK_ENV_FILE === 'string' && env.DEEPSEEK_ENV_FILE.trim()
      ? path.resolve(PROJECT_ROOT, env.DEEPSEEK_ENV_FILE.trim())
      : path.join(PROJECT_ROOT, '.env'));

  // 1. 进程环境变量
  const fromProcess = typeof env.DEEPSEEK_API_KEY === 'string' ? env.DEEPSEEK_API_KEY.trim() : '';
  if (fromProcess) return { key: fromProcess, source: 'process' };

  // 2. 项目根 .env
  const envVars = readEnvFile(envFile);
  const fromFile = typeof envVars.DEEPSEEK_API_KEY === 'string' ? envVars.DEEPSEEK_API_KEY.trim() : '';
  if (fromFile) return { key: fromFile, source: 'dotenv' };

  // 测试钩子：DEEPSEEK_NO_SYSTEM_ENV=1 时跳过 Windows 注册表回退（防止测试受本机真实 Key 影响）。
  const skipSystemEnv = env.DEEPSEEK_NO_SYSTEM_ENV === '1' || env.DEEPSEEK_NO_SYSTEM_ENV === 'true';
  if (skipSystemEnv) return { key: '', source: null };

  // 3. Windows 系统变量（Machine）
  const fromMachine = readWindowsEnvironmentVariable('DEEPSEEK_API_KEY', 'Machine');
  if (fromMachine) return { key: fromMachine.trim(), source: 'machine' };

  // 4. Windows 用户变量（HKCU）
  const fromUser = readWindowsEnvironmentVariable('DEEPSEEK_API_KEY', 'User');
  if (fromUser) return { key: fromUser.trim(), source: 'user' };

  return { key: '', source: null };
}

function toInteger(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.trunc(parsed);
  if (min !== undefined && rounded < min) return min;
  if (max !== undefined && rounded > max) return max;
  return rounded;
}

function resolveDir(value, fallbackRelative) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw ? path.resolve(PROJECT_ROOT, raw) : path.join(PROJECT_ROOT, fallbackRelative);
}

function normalizeBaseUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const fallback = 'https://api.deepseek.com';
  if (!raw) return fallback;
  const trimmed = raw.replace(/\/+$/, '');
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fallback;
    return trimmed;
  } catch {
    return fallback;
  }
}

/**
 * 汇总运行配置。纯函数：只读取传入的 env 表，测试可完全隔离。
 * 支持测试覆盖项：PROGRESS_PATH / CORPUS_DIR / PUBLIC_DIR / DEEPSEEK_ENV_FILE / DEEPSEEK_NO_SYSTEM_ENV。
 */
export function loadConfig(env = process.env) {
  const envFile = typeof env.DEEPSEEK_ENV_FILE === 'string' && env.DEEPSEEK_ENV_FILE.trim()
    ? path.resolve(PROJECT_ROOT, env.DEEPSEEK_ENV_FILE.trim())
    : path.join(PROJECT_ROOT, '.env');
  const { key: apiKey, source: keySource } = resolveApiKey(env, { envFile });
  const baseUrl = normalizeBaseUrl(env.DEEPSEEK_BASE_URL);
  let baseUrlHost = '';
  try {
    baseUrlHost = new URL(baseUrl).host;
  } catch {
    baseUrlHost = '';
  }

  return {
    version: VERSION,
    host: typeof env.HOST === 'string' && env.HOST.trim() ? env.HOST.trim() : '127.0.0.1',
    port: toInteger(env.PORT, 5180, 0, 65535),
    model: typeof env.DEEPSEEK_MODEL === 'string' && env.DEEPSEEK_MODEL.trim()
      ? env.DEEPSEEK_MODEL.trim()
      : 'deepseek-chat',
    baseUrl,
    baseUrlHost,
    timeoutMs: toInteger(env.AI_TIMEOUT_MS, 120000, 50, 600000),
    progressPath: resolveDir(env.PROGRESS_PATH, 'data/progress.json'),
    corpusDir: resolveDir(env.CORPUS_DIR, 'data/corpus'),
    publicDir: resolveDir(env.PUBLIC_DIR, 'public'),
    // 以下为固定业务参数（契约 §4.3 / §4.6）
    maxBodyBytes: 256 * 1024,
    maxTokens: 2000,
    temperature: 0.3,
    aiConcurrency: 2,
    // 仅在服务端内存中存在，绝不出现在响应/日志里
    apiKey,
    keyConfigured: Boolean(apiKey),
    keySource,
    envFile,
  };
}
