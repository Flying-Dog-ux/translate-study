/**
 * 配置与 Key 解析单元测试（辅助覆盖 docs/CONTRACT.md §5）。
 *
 * 所有用例都显式注入 env 表并设置 DEEPSEEK_NO_SYSTEM_ENV=1 / 临时 .env 路径，
 * 因此既不依赖、也不读取本机真实的 Windows 环境变量，更不会发起网络请求。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  loadConfig,
  parseEnvFile,
  parseRegQueryValue,
  readWindowsEnvironmentVariable,
  resolveApiKey,
} from '../server/config.js';

async function tempFile(content) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'translate-study-config-'));
  const file = path.join(dir, '.env');
  await fsp.writeFile(file, content, 'utf8');
  return { dir, file };
}

describe('parseEnvFile', () => {
  it('解析注释、空行、export、引号与行尾注释', () => {
    const parsed = parseEnvFile([
      '# 这是注释',
      '',
      'DEEPSEEK_API_KEY=sk-abc123',
      'export DEEPSEEK_MODEL="deepseek-chat"',
      "HOST='127.0.0.1'",
      'PORT=5180 # 行尾注释',
    ].join('\n'));
    assert.deepEqual(parsed, {
      DEEPSEEK_API_KEY: 'sk-abc123',
      DEEPSEEK_MODEL: 'deepseek-chat',
      HOST: '127.0.0.1',
      PORT: '5180',
    });
  });

  it('忽略非法行并兼容 BOM / CRLF', () => {
    const parsed = parseEnvFile('\uFEFF# 注释\r\n没有等号的行\r\nA=1\r\n');
    assert.deepEqual(parsed, { A: '1' });
  });
});

describe('parseRegQueryValue（Windows 系统变量解析）', () => {
  it('从 reg query 输出中解析 REG_SZ / REG_EXPAND_SZ', () => {
    const machineOutput = [
      '',
      'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
      '    Path    REG_EXPAND_SZ    C:\\Windows\\system32',
      '    DEEPSEEK_API_KEY    REG_SZ    sk-machine-123',
      '',
    ].join('\r\n');
    assert.equal(parseRegQueryValue(machineOutput, 'DEEPSEEK_API_KEY'), 'sk-machine-123');
    assert.equal(parseRegQueryValue(machineOutput, 'Path'), 'C:\\Windows\\system32');
    assert.equal(parseRegQueryValue(machineOutput, 'NOT_EXIST'), null);
    assert.equal(parseRegQueryValue('', 'DEEPSEEK_API_KEY'), null);
  });

  it('不匹配名称为其他变量前缀的情况', () => {
    const output = '    DEEPSEEK_API_KEY_OLD    REG_SZ    sk-old';
    assert.equal(parseRegQueryValue(output, 'DEEPSEEK_API_KEY'), null);
  });

  it('非 Windows 平台读取系统变量返回 null（不抛错）', () => {
    if (process.platform === 'win32') {
      // Windows 上用一个几乎不可能存在的变量名验证「不存在 → null」
      assert.equal(readWindowsEnvironmentVariable('TRANSLATE_STUDY_TEST_NOT_EXIST_12345', 'Machine'), null);
    } else {
      assert.equal(readWindowsEnvironmentVariable('DEEPSEEK_API_KEY', 'Machine'), null);
    }
  });
});

describe('resolveApiKey 优先级', () => {
  it('process.env 优先于 .env 文件', async () => {
    const { dir, file } = await tempFile('DEEPSEEK_API_KEY=sk-from-dotenv\n');
    try {
      const resolved = resolveApiKey(
        { DEEPSEEK_API_KEY: 'sk-from-process', DEEPSEEK_ENV_FILE: file, DEEPSEEK_NO_SYSTEM_ENV: '1' },
        { envFile: file },
      );
      assert.deepEqual(resolved, { key: 'sk-from-process', source: 'process' });
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('process.env 为空时读取项目 .env（trim 后）', async () => {
    const { dir, file } = await tempFile('# 注释\nDEEPSEEK_API_KEY="sk-from-dotenv"\n');
    try {
      const resolved = resolveApiKey(
        { DEEPSEEK_ENV_FILE: file, DEEPSEEK_NO_SYSTEM_ENV: '1' },
        { envFile: file },
      );
      assert.deepEqual(resolved, { key: 'sk-from-dotenv', source: 'dotenv' });
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('任何来源都没有时返回空 Key（keyConfigured:false）', async () => {
    const missing = path.join(os.tmpdir(), 'translate-study-definitely-missing.env');
    const resolved = resolveApiKey({ DEEPSEEK_ENV_FILE: missing, DEEPSEEK_NO_SYSTEM_ENV: '1' });
    assert.deepEqual(resolved, { key: '', source: null });
  });

  it('空白字符串视为未配置（继续回退）', async () => {
    const { dir, file } = await tempFile('DEEPSEEK_API_KEY=   \n');
    try {
      const resolved = resolveApiKey(
        { DEEPSEEK_API_KEY: '   ', DEEPSEEK_ENV_FILE: file, DEEPSEEK_NO_SYSTEM_ENV: '1' },
        { envFile: file },
      );
      assert.equal(resolved.key, '');
      assert.equal(resolved.source, null);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('loadConfig 默认值与覆盖项', () => {
  const baseEnv = {
    DEEPSEEK_ENV_FILE: path.join(os.tmpdir(), 'translate-study-definitely-missing.env'),
    DEEPSEEK_NO_SYSTEM_ENV: '1',
  };

  it('默认值符合契约 §5', () => {
    const config = loadConfig({ ...baseEnv });
    assert.equal(config.port, 5180);
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.model, 'deepseek-chat');
    assert.equal(config.baseUrl, 'https://api.deepseek.com');
    assert.equal(config.baseUrlHost, 'api.deepseek.com');
    assert.equal(config.timeoutMs, 120000);
    assert.equal(config.keyConfigured, false);
    assert.equal(config.apiKey, '');
    assert.equal(config.keySource, null);
    assert.equal(config.maxBodyBytes, 256 * 1024);
    assert.equal(config.maxTokens, 2000);
    assert.equal(config.temperature, 0.3);
    assert.equal(config.aiConcurrency, 2);
    assert.equal(config.version, '1.0.0');
    assert.ok(config.progressPath.endsWith(path.join('data', 'progress.json')));
    assert.ok(config.corpusDir.endsWith(path.join('data', 'corpus')));
    assert.ok(config.publicDir.endsWith('public'));
    assert.ok(config.envFile.endsWith('.env'));
  });

  it('支持环境变量覆盖与路径解析', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'translate-study-paths-'));
    try {
      const env = {
        ...baseEnv,
        PORT: '5181',
        HOST: '0.0.0.0',
        DEEPSEEK_MODEL: 'deepseek-reasoner',
        DEEPSEEK_BASE_URL: 'http://127.0.0.1:9999/v1/',
        AI_TIMEOUT_MS: '12345',
        PROGRESS_PATH: path.join(root, 'p.json'),
        CORPUS_DIR: path.join(root, 'corpus'),
        PUBLIC_DIR: path.join(root, 'pub'),
      };
      const config = loadConfig(env);
      assert.equal(config.port, 5181);
      assert.equal(config.host, '0.0.0.0');
      assert.equal(config.model, 'deepseek-reasoner');
      assert.equal(config.baseUrl, 'http://127.0.0.1:9999/v1');
      assert.equal(config.baseUrlHost, '127.0.0.1:9999');
      assert.equal(config.timeoutMs, 12345);
      assert.equal(config.progressPath, path.resolve(root, 'p.json'));
      assert.equal(config.corpusDir, path.resolve(root, 'corpus'));
      assert.equal(config.publicDir, path.resolve(root, 'pub'));
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('.env 里的 Key 会反映到 keyConfigured，但不会进入任何可序列化字段名之外的日志（此处仅断言配置对象）', async () => {
    const { dir, file } = await tempFile('DEEPSEEK_API_KEY=sk-config-test\n');
    try {
      const config = loadConfig({ DEEPSEEK_ENV_FILE: file, DEEPSEEK_NO_SYSTEM_ENV: '1' });
      assert.equal(config.keyConfigured, true);
      assert.equal(config.keySource, 'dotenv');
      assert.equal(config.apiKey, 'sk-config-test');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('非法 PORT / AI_TIMEOUT_MS 回退默认值', () => {
    const config = loadConfig({ ...baseEnv, PORT: 'abc', AI_TIMEOUT_MS: 'NaN' });
    assert.equal(config.port, 5180);
    assert.equal(config.timeoutMs, 120000);
  });
});
