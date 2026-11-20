# tests/e2e — 逐句译 端到端 / 黑盒回归脚本（零依赖）

本目录是 QA 独立验证脚本，**只用 Node 内置模块 + Microsoft Edge headless（CDP）**，不依赖任何 npm 包。
所有脚本可重复运行；会临时改写 `data/progress.json` 的进度，但 `run-all.mjs` 会在测试前备份、测试后逐段写回，
并在最后做「内容一致」校验（只忽略 `updatedAt` 时间戳）。

## 前置条件

| 条件 | 说明 |
|---|---|
| 服务已启动 | `npm start`，默认 `http://127.0.0.1:5180`，且已加载最终语料（`/api/health` 显示 `80204` 句） |
| Node.js | 建议 v24（需要全局 `WebSocket` / `fetch`；v20 也可运行大部分脚本，但 CDP 需要自带 WebSocket 的版本） |
| Microsoft Edge | 默认路径 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`；可在 `lib/cdp.mjs` 的 `EDGE_CANDIDATES` 中调整 |
| 桌面空间 | 截图输出到 `.scratch/qa/screenshots/`（约 30 张 PNG） |
| 真实 AI | 浏览器阶段默认调用 1 次真实 `/api/review`（Ctrl+Enter 流程）；API 阶段调用 1 次 `/api/word`。可用 `--skip-live-review` / `--no-ai` 跳过 |

## 快速开始

```powershell
cd D:\Blog\spark\translate_study
npm start                                  # 另开一个终端，保持服务运行

node tests/e2e/run-all.mjs                 # 一次跑完：API 黑盒 + 浏览器 E2E + AI Key 未配置场景
```

只看报告与截图：

```
.scratch/qa/qa-summary.json        # 总汇总（阶段结果、检查项、进度恢复状态）
.scratch/qa/api-results.json       # API 黑盒逐项 PASS/FAIL
.scratch/qa/browser-results.json   # 浏览器 E2E 逐项 PASS/FAIL + 截图清单
.scratch/qa/ai-auth-results.json   # Key 未配置场景逐项 PASS/FAIL
.scratch/qa/screenshots/           # 桌面 1440×1000 / 平板 768×1024 / 手机 390×844 各路由截图
.scratch/qa/evidence/              # 原始响应、导出进度、控制台错误等证据 JSON
```

## 脚本说明

| 脚本 | 作用 | 产物 |
|---|---|---|
| `run-all.mjs` | 全量回归编排：备份进度 → API 黑盒 → 浏览器 E2E → AI Key 未配置实例 → 恢复并校验进度 | `.scratch/qa/qa-summary.json` |
| `api-blackbox.mjs` | 契约 §4/§7 黑盒：health / manifest / 199 章统计一致性 / 404 / 路径穿越 / 400-413 / 进度读写与百分比 / review 参数边界 / word 真实调用 | `api-results.json`、`evidence/*.json` |
| `browser-e2e.mjs` | 浏览器 E2E：5 路由 × 3 尺寸、练习页完整交互、真实 AI 批改面板、XSS、刷新恢复、错误态、空状态、设置页导出/重置/导入、可访问性、控制台/网络 | `browser-results.json`、`screenshots/*.png` |
| `ai-auth-e2e.mjs` | 在 5185 端口另起临时实例（`DEEPSEEK_NO_SYSTEM_ENV=1` + 临时进度文件），验证未配置 Key 时 API 401 与前端降级提示（不影响 5180 与真实进度） | `ai-auth-results.json`、`ai-auth-*.png` |
| `lib/cdp.mjs` | 零依赖 CDP 客户端（启动 Edge headless、导航、点击、截图、断网/请求拦截、下载捕获、键盘事件）与断言工具 | — |
| `lib/progress-utils.mjs` | 进度备份/恢复/对比/摘要（全部走 HTTP API，不直接改 `data/progress.json`） | — |

## 常用参数

```powershell
# 不调用真实 AI（复用已有批改数据），适合反复回归
node tests/e2e/run-all.mjs --skip-live-review

# API 阶段也跳过真实 /api/word
node tests/e2e/run-all.mjs --no-ai

# 跳过 5185 Key 未配置独立实例测试
node tests/e2e/run-all.mjs --skip-auth

# 单独跑某一阶段
node tests/e2e/api-blackbox.mjs
node tests/e2e/browser-e2e.mjs --skip-live-review
node tests/e2e/ai-auth-e2e.mjs

# 调试用：跑浏览器阶段但保留测试产生的进度（不自动恢复）
node tests/e2e/browser-e2e.mjs --keep-progress
```

## 结果判读

- 每个脚本退出码 `0` = 全部 PASS，`1` = 存在 FAIL 或脚本异常；`run-all.mjs` 还要求进度恢复成功。
- 失败项会带中文原因（期望/实际值、超时 selector 等），并尽量附截图/证据文件路径。
- `browser-e2e.mjs` 的「已知错误态」阶段（manifest 500、断网、health 失败）允许出现预期的网络错误日志；
  其余阶段要求控制台 **0 error**、页面 **0 未捕获异常**。
- 截图默认视口：桌面 `1440×1000`、平板 `768×1024`、手机 `390×844`（CDP `Emulation.setDeviceMetricsOverride mobile:true`，不是 `--window-size`，避免误判移动端布局）。

## 注意事项

1. **不要同时跑两个 E2E**：它们都会写同一份进度文件。
2. 服务和语料更新后请**重启服务**（manifest 有内存缓存）；否则 `api-blackbox` 的「运行态一致性」检查会失败并提示重启。
3. 手机截图使用 CDP 设备模拟（`deviceScaleFactor=2`），PNG 逻辑分辨率仍为 390×844。
4. 脚本不读取、不打印 `DEEPSEEK_API_KEY`；Key 未配置场景使用显式清空环境变量的临时实例。
5. 真实 `/api/review` 调用次数：`browser-e2e.mjs` 默认 1 次（`--skip-live-review` 为 0 次）；真实 `/api/word`：`api-blackbox.mjs` 1 次（`--no-ai` 为 0 次）。
