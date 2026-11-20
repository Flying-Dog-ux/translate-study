/**
 * 零依赖 CDP（Chrome DevTools Protocol）客户端。
 *
 * 用途：QA 端到端测试用 Edge headless 打开真实页面，做点击 / 输入 / 截图 /
 * 请求拦截 / 断网模拟 / 下载捕获 / 移动端设备模拟。Node 24 自带全局 WebSocket，
 * 因此不需要任何 npm 依赖。
 *
 * 设计要点：
 * - 一个 Edge 进程 = 一个 page target，测试脚本通过高级 helper 操作；
 * - 事件（console / 异常 / 网络 / 页面生命周期）统一缓存到实例上，供断言使用；
 * - 请求拦截（Fetch 域）交给注册的 handler 处理，未注册的请求一律放行。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

export function findEdge() {
  const found = EDGE_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!found) throw new Error('找不到 Microsoft Edge，请确认已安装 Edge（路径：Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe）');
  return found;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询直到 fn() 返回真值；超时抛错。 */
export async function waitUntil(fn, { timeoutMs = 30000, intervalMs = 200, label = 'condition' } = {}) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  const suffix = lastError ? `（最后错误：${lastError.message}）` : '';
  throw new Error(`等待超时（${timeoutMs}ms）：${label}${suffix}`);
}

/** 浏览器实例：启动 Edge、连接 page target、暴露 send/eval/截图等能力。 */
export class Browser {
  constructor({ port, edgePath, userDataDir, width = 1440, height = 1000, mobile = false }) {
    this.port = port;
    this.edgePath = edgePath;
    this.userDataDir = userDataDir;
    this.viewport = { width, height, mobile };
    this.proc = null;
    this.ws = null;
    this.msgId = 0;
    this.pending = new Map();
    this.consoleMessages = [];
    this.pageErrors = [];
    this.requests = [];
    this.responses = [];
    this.loadingFailures = [];
    this.fetchHandlers = [];
    this._closed = false;
  }

  async launch() {
    mkdirSync(this.userDataDir, { recursive: true });
    // 用 --remote-debugging-port=0 让 Edge 自己挑空闲端口，再从 stderr 的
    // 「DevTools listening on ws://...」解析实际地址。避免写死端口被 Windows
    // 动态端口范围占用/权限拦截（实测 9600-9800 段 IPv4 bind 会 WSAEACCES）。
    const launchArgs = [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--mute-audio',
      '--hide-scrollbars',
      `--remote-debugging-port=${this.port || 0}`,
      `--user-data-dir=${this.userDataDir}`,
      'about:blank',
    ];
    this.proc = spawn(this.edgePath, launchArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.stderr = '';
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      this.stderr += chunk;
      if (this.stderr.length > 40000) this.stderr = this.stderr.slice(-40000);
    });

    let debugBase = null;
    try {
      const wsUrlText = await waitUntil(() => {
        const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(this.stderr);
        return match ? match[1] : null;
      }, { timeoutMs: 30000, intervalMs: 150, label: '等待 Edge DevTools 就绪' });
      const wsUrl = new URL(wsUrlText);
      debugBase = `${wsUrl.protocol === 'wss:' ? 'https' : 'http'}://${wsUrl.host}`;
      this.debugPort = Number(wsUrl.port);
    } catch (error) {
      try { this.proc.kill(); } catch { /* 忽略 */ }
      throw new Error(`${error.message}。Edge stderr 片段：${this.stderr.slice(0, 500)}`);
    }

    const target = await waitUntil(async () => {
      const response = await fetch(`${debugBase}/json/list`).catch(() => null);
      if (!response || !response.ok) return null;
      const targets = await response.json();
      return targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl) || null;
    }, { timeoutMs: 30000, intervalMs: 150, label: '等待 Edge page target' });

    this.ws = new WebSocket(target.webSocketDebuggerUrl);
    this.ws.onmessage = (event) => this._onMessage(JSON.parse(event.data));
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error('CDP WebSocket 连接失败'));
    });

    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    await this.send('Network.enable');
    await this.send('DOM.enable');
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: this.viewport.width,
      height: this.viewport.height,
      deviceScaleFactor: this.viewport.mobile ? 2 : 1,
      mobile: this.viewport.mobile,
    });
    await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    return this;
  }

  _onMessage(message) {
    if (message.id && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(`CDP ${entry.method} 失败：${JSON.stringify(message.error)}`));
      else entry.resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      const type = message.params.type;
      const text = (message.params.args || []).map((arg) => arg.value ?? arg.description ?? '').join(' ').slice(0, 500);
      this.consoleMessages.push({ type, text, ts: Date.now() });
    } else if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails || {};
      this.pageErrors.push({
        text: details.exception?.description || details.text || '未知页面异常',
        ts: Date.now(),
      });
    } else if (message.method === 'Log.entryAdded') {
      const entry = message.params.entry || {};
      this.consoleMessages.push({ type: entry.level === 'error' ? 'error' : entry.level, text: `[log] ${entry.text || ''}`, ts: Date.now() });
    } else if (message.method === 'Network.requestWillBeSent') {
      this.requests.push({
        id: message.params.requestId,
        url: message.params.request.url,
        method: message.params.request.method,
        type: message.params.type,
        ts: Date.now(),
      });
    } else if (message.method === 'Network.responseReceived') {
      this.responses.push({
        url: message.params.response.url,
        status: message.params.response.status,
        mimeType: message.params.response.mimeType,
        ts: Date.now(),
      });
    } else if (message.method === 'Network.loadingFailed') {
      this.loadingFailures.push({ requestId: message.params.requestId, errorText: message.params.errorText, ts: Date.now() });
    } else if (message.method === 'Fetch.requestPaused') {
      this._handlePaused(message.params);
    }
  }

  async _handlePaused(params) {
    const url = params.request.url;
    for (const handler of this.fetchHandlers) {
      if (!handler.matches(url)) continue;
      try {
        await handler.onPause(this, params);
      } catch (error) {
        await this.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
        this.consoleMessages.push({ type: 'error', text: `[e2e] 拦截处理器异常：${error.message}`, ts: Date.now() });
      }
      return;
    }
    await this.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
  }

  send(method, params = {}, { timeoutMs = 180000 } = {}) {
    if (this._closed) return Promise.reject(new Error('浏览器已关闭'));
    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        reject(error);
        return;
      }
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP 调用超时：${method}`));
      }, timeoutMs).unref?.();
    });
  }

  /** 在页面里执行表达式（支持 await），返回 JSON 可序列化结果。 */
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(`页面表达式执行失败：${description}`);
    }
    return result.result?.value;
  }

  /** 轮询页面表达式直到返回真值。 */
  waitFor(expression, { timeoutMs = 30000, intervalMs = 250, label = expression } = {}) {
    return waitUntil(() => this.eval(`Boolean(${expression})`), { timeoutMs, intervalMs, label });
  }

  async navigate(url, { waitForLoad = true } = {}) {
    await this.send('Page.navigate', { url });
    if (waitForLoad) await this.waitForLoad(20000);
    return this;
  }

  async reload() {
    await this.send('Page.reload', { ignoreCache: true });
    await this.waitForLoad(20000);
  }

  async waitForLoad(timeoutMs = 20000) {
    try {
      await waitUntil(() => this.eval(`document.readyState === 'complete' || document.readyState === 'interactive'`), {
        timeoutMs,
        intervalMs: 100,
        label: 'document.readyState',
      });
    } catch { /* 页面可能在导航中，交由后续 waitFor 处理 */ }
  }

  async setDeviceMetrics({ width, height, mobile, deviceScaleFactor }) {
    this.viewport = { width, height, mobile };
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: deviceScaleFactor ?? (mobile ? 2 : 1),
      mobile: Boolean(mobile),
    });
  }

  async setColorScheme(scheme) {
    await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  }

  /** 模拟断网 / 恢复网络（会影响页面内 fetch 与后续导航）。 */
  async setOffline(offline) {
    await this.send('Network.emulateNetworkConditions', {
      offline: Boolean(offline),
      latency: 0,
      downloadThroughput: offline ? 0 : -1,
      uploadThroughput: offline ? 0 : -1,
    });
  }

  /** 注册请求拦截器；matches(url) 为真的请求交给 onPause。 */
  async intercept(matches, onPause) {
    this.fetchHandlers.push({ matches, onPause });
    await this.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
    });
  }

  async clearInterceptors() {
    this.fetchHandlers = [];
    await this.send('Fetch.disable').catch(() => {});
  }

  async screenshot(filePath, { fullPage = false } = {}) {
    const result = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, Buffer.from(result.data, 'base64'));
    return filePath;
  }

  async setDownloadBehavior(downloadDir) {
    mkdirSync(downloadDir, { recursive: true });
    await this.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir }).catch(async () => {
      // 旧版协议使用 Page.setDownloadBehavior
      await this.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
    });
  }

  /** 给 <input type=file> 塞入本地文件（用于导入进度测试）。 */
  async setFileInput(selector, filePath) {
    const doc = await this.send('DOM.getDocument', { depth: -1 });
    const node = await this.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    if (!node.nodeId) throw new Error(`找不到文件输入框：${selector}`);
    await this.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [filePath] });
  }

  /** 模拟真实键盘按键（用于 Ctrl/Cmd+Enter 等快捷键测试）。 */
  async pressKey(key, { modifiers = 0 } = {}) {
    const keyMap = {
      Enter: { code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' },
      Escape: { code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
      ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
      ArrowUp: { code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 },
      Tab: { code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
    };
    const info = keyMap[key];
    if (!info) throw new Error(`不支持的按键：${key}`);
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, modifiers, ...info });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      modifiers,
      code: info.code,
      windowsVirtualKeyCode: info.windowsVirtualKeyCode,
      nativeVirtualKeyCode: info.nativeVirtualKeyCode,
    });
  }

  /** 取当前页面 console 中 level=error 的消息（不含已知网络失败提示的过滤由调用方做）。 */
  consoleErrors() {
    return this.consoleMessages.filter((entry) => entry.type === 'error');
  }

  /** 取所有非本机源请求（第三方请求检查）。 */
  thirdPartyRequests(origin) {
    const allowed = new Set([origin]);
    return this.requests.filter((entry) => {
      if (entry.url.startsWith('data:') || entry.url.startsWith('blob:')) return false;
      try {
        const url = new URL(entry.url);
        return !allowed.has(url.origin);
      } catch {
        return false;
      }
    });
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    try { this.ws?.close(); } catch { /* 忽略 */ }
    try { this.proc?.kill(); } catch { /* 忽略 */ }
    await sleep(400);
    try { rmSync(this.userDataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

/** 启动一个 headless Edge 并返回连接好的 Browser 实例。 */
export async function launchBrowser(options = {}) {
  // port 缺省为 0：交给 Edge 自动选择空闲端口（更稳，避免端口冲突）。
  const port = options.port ?? 0;
  const userDataDir = options.userDataDir ?? mkdtempSync(path.join(tmpdir(), 'zs-e2e-'));
  const browser = new Browser({
    port,
    edgePath: options.edgePath ?? findEdge(),
    userDataDir,
    width: options.width ?? 1440,
    height: options.height ?? 1000,
    mobile: options.mobile ?? false,
  });
  await browser.launch();
  return browser;
}

/** 简易断言收集器：check(name, fn) 包住单条检查，返回 PASS/FAIL 记录。 */
export function createChecker() {
  const checks = [];
  async function check(name, fn, { phase = '' } = {}) {
    const startedAt = Date.now();
    try {
      const detail = await fn();
      checks.push({ name, phase, status: 'PASS', detail: detail === undefined ? null : detail, elapsedMs: Date.now() - startedAt });
      return true;
    } catch (error) {
      checks.push({ name, phase, status: 'FAIL', detail: error.message, elapsedMs: Date.now() - startedAt });
      return false;
    }
  }
  function fail(name, message, { phase = '' } = {}) {
    checks.push({ name, phase, status: 'FAIL', detail: message, elapsedMs: 0 });
  }
  function pass(name, detail, { phase = '' } = {}) {
    checks.push({ name, phase, status: 'PASS', detail: detail ?? null, elapsedMs: 0 });
  }
  return {
    check,
    fail,
    pass,
    checks,
    get failed() { return checks.filter((entry) => entry.status === 'FAIL'); },
    get passed() { return checks.filter((entry) => entry.status === 'PASS'); },
  };
}

/** 断言辅助 */
export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
  return actual;
}

export function assertContains(haystack, needle, message) {
  if (!String(haystack).includes(needle)) {
    throw new Error(`${message}（未找到 ${JSON.stringify(needle)}；实际内容片段：${String(haystack).slice(0, 300)}）`);
  }
  return haystack;
}
