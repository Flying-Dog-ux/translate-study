# 逐句译 · 独立 QA 报告

- **项目**：Translate Study（逐句译）— 本地单用户「哈利波特逐句英译中 + DeepSeek 段落批改」
- **QA 角色**：独立 QA 工程师（不修改业务代码，仅验证与报告）
- **验证日期**：2026-11-19 17:56 – 18:33（Asia/Shanghai）
- **被测版本**：`package.json` version 1.0.0；最终语料 `data/corpus`（manifest generatedAt 2026-11-19T09:51:28.216Z）
- **结论**：**PASS** — 用户可见主流程与契约 §4/§6/§7 验收项全部通过；**P0 = 0，P1（产品缺陷）= 0，P2 = 3**（见 §8）；12 项未覆盖/未验证事项已在 §9 如实列出。

| 维度 | 结果 |
|---|---|
| 自动化检查项合计 | **105 / 105 PASS**（API 50 + 浏览器 49 + AI-Key-未配置 6） |
| 后端单元/集成测试 | `npm test` → **47 / 47 PASS**（QA 独立复跑） |
| 真实 AI 调用 | `/api/review` 1 次（5.35s，面板字段完整并落库）、`/api/word` 1 次（最终回归 2.9s，结构化词条；QA 迭代中另复跑 1 次）；另有 Lead 早前 1 次真实批改 |
| 浏览器截图 | **35 张**：桌面 1440×1000 / 平板 768×1024 / 手机 390×844，各路由 + 批改面板 + 错误态 + 空状态 + 暗色 |
| 进度数据 | 测试前备份 → 测试后恢复，**内容差异 0 处**（仅 `updatedAt` 变为恢复时刻） |
| 发现并关闭的问题 | 1 项 P1 环境时序（服务缓存旧 manifest，Lead 重启后复核归零，非产品缺陷，见 §7） |

---

## 1. 环境与基线

| 项 | 值 |
|---|---|
| 操作系统 | Microsoft Windows 11 Home China 10.0.26300 |
| Node.js | v24.14.0（零外部依赖；CDP 使用 Node 自带全局 `WebSocket`） |
| 浏览器 | Microsoft Edge 157.0.4341.60（`--headless=new`，CDP 驱动） |
| 被测服务 | `http://127.0.0.1:5180`，PID 41620，启动于 2026-11-19 18:04:13（语料最终重建后由 Lead 重启） |
| 语料（最终，磁盘与运行态一致） | 7 本 / **199 章** / **37,852 段** / **80,204 句** / 1,118,964 词 |
| AI 配置 | `keyConfigured: true`，model `deepseek-chat`，host `api.deepseek.com`（响应/日志未见 Key） |
| 语料质量报告 | `data/corpus/quality-report.json`：80/80 checks pass，4 条已知 warning（超长真实长句、跨段续引号），QA 未重跑 PDF 管线 |
| 测试数据 | 进度备份于 `.scratch/qa/progress-backup-before-qa.json`（2 段：hp1/1/1 收藏+批改、hp1/1/2 批改，共 9 非空句） |

> **基线口径说明**：任务下达时给出的「80,349 句」是旧版语料统计。语料 Agent 在 17:56 最终重建为 **80,204 句 / 37,852 段**，Lead 于 18:04 重启服务加载最终版。本报告全部断言以 **80,204 / 37,852 / 199** 为最终口径复核；旧值差异属环境时序问题，见 §7。

---

## 2. 验证方法与可复现脚本

所有验证均由 QA 编写的零依赖脚本执行（`tests/e2e/`，仅 Node 内置模块 + Edge headless CDP），未修改 `server/`、`public/`、`scripts/`、`data/` 任何源码。

```powershell
# 前置：服务已启动（npm start，5180）且加载最终语料
node tests/e2e/api-blackbox.mjs          # 黑盒 API + 数据一致性（50 项）
node tests/e2e/browser-e2e.mjs           # 浏览器 E2E（49 项，含 1 次真实 AI 批改）
node tests/e2e/ai-auth-e2e.mjs           # 5185 独立实例：Key 未配置场景（6 项）
# 或：node tests/e2e/run-all.mjs          # 编排三阶段 + 测试前进度备份/恢复
```

脚本用法与参数（`--skip-live-review` / `--no-ai` / `--skip-auth` 等）见 [`tests/e2e/README.md`](../tests/e2e/README.md)。

**证据文件**

| 文件 | 内容 |
|---|---|
| `.scratch/qa/qa-summary.json` | 总汇总：105/105、进度恢复状态、三阶段结果 |
| `.scratch/qa/api-results.json` / `api-run-final.log` | 黑盒 API 逐项 PASS/FAIL + 关键响应证据 |
| `.scratch/qa/browser-results.json` / `browser-run-live.log` | 浏览器 E2E 逐项结果、控制台错误分布、截图清单 |
| `.scratch/qa/ai-auth-results.json` / `ai-auth-run.log` | Key 未配置场景逐项结果 |
| `.scratch/qa/screenshots/` | 35 张截图（见附录 B） |
| `.scratch/qa/evidence/` | 原始 health/manifest 响应、导出进度、控制台错误、对比度/触控目标数据、数据一致性报告等 |
| `.scratch/qa/evidence/manifest-stale-cache-incident.md` | §7 P1 环境时序问题的完整记录与复核 |

---

## 3. 结果总览

| 阶段 | 检查项 | PASS | FAIL | 产物 |
|---|---|---|---|---|
| A. 黑盒 API（契约 §4/§7） | 50 | 50 | 0 | `api-results.json` |
| B. 浏览器端到端（契约 §6） | 49 | 49 | 0 | `browser-results.json` + 33 张截图 |
| C. AI Key 未配置降级（5185 独立实例） | 6 | 6 | 0 | `ai-auth-results.json` + 2 张截图 |
| D. 后端单测复核 `npm test` | 47 | 47 | 0 | 终端输出（2.7s） |
| **合计** | **105** | **105** | **0** | |

浏览器 E2E 分阶段：桌面路由 5/5、平板路由 5/5、手机路由 7/7、练习页交互 18/18、错误态 2/2、设置页 4/4 + 健康兜底 1/1 + 主题 1/1、可访问性/网络健全性 6/6。

---

## 4. 黑盒 API 逐项结果（50/50 PASS）

证据：`.scratch/qa/api-results.json`、`.scratch/qa/evidence/*.json`。

### 4.1 健康检查 / 静态资源 / manifest / 章节

| 检查 | 结果 | 关键实测 |
|---|---|---|
| `GET /api/health` | PASS | 7 本 / 199 章 / **80,204 句**；`keyConfigured:true`、`model:deepseek-chat`、`baseUrlHost:api.deepseek.com`；响应无 `sk-` 形态 Key、无 `apiKey/secret` 字段 |
| `GET /`、`/css/app.css`、`/js/app.js` | PASS | 均 200，`text/html; charset=utf-8` / `text/css` / `text/javascript`，CSS 体积正常 |
| 未知静态路由（如 `/some/unknown/route`） | PASS | 按契约 §4.6 回退 `index.html`（200，含 `id="app"`），不 404 |
| `GET /api/manifest` | PASS | 7 本、id 顺序 hp1..hp7、章节数 17/18/22/37/38/30/37=199、章级 file 均为正斜杠、句数合计 80,204 |
| `GET /api/chapters/hp1/1` | PASS | `The Boy Who Lived`、110 段、段落 index 从 0 连续、句对象含 `text/wordCount` |
| `GET /api/chapters/hp7/37` | PASS | EPILOGUE / `Nineteen Years Later`，77 段 150 句 |

### 4.2 404 / 路径穿越 / 请求体上限 / 方法限制

| 检查 | 结果 | 关键实测 |
|---|---|---|
| 11 类 404 场景 | PASS | 章号 999/0/-1/abc/1.5、书 hp9、非法 bookId、缺章节参数/序号、未知 API、`/api` 根路径 → 均 404 + `{"ok":false,"error":{"code":"NOT_FOUND","message":"中文"}}` |
| 方法不匹配 | PASS | `POST /api/health` → 404；`GET /api/review` → 404 |
| 路径穿越 7 项（编码 `../`、`%2e%2e`、子目录、API 层穿越） | PASS | 全部 **404 JSON 错误**，响应不含源码/语料/Key；含 `/..%2fserver/config.js`、`/..%2f..%2fserver%2findex.js`、`/api/chapters/..%2f..%2fpackage.json/1` 等 |
| 敏感目录明文路径（`/server/config.js`、`/data/corpus/manifest.json`） | PASS | 仅回退 `index.html` 外壳（或 404），**未泄露**任何源文件/语料内容（`DEEPSEEK_API_KEY`、`resolveApiKey`、`"books":[` 均不出现） |
| 非法 URL 编码 / NUL 字节 | PASS | `GET /%E0%A4%A`、`GET /api/%00health` → **400 BAD_REQUEST** |
| 请求体 > 256KB | PASS | 300KB PUT → **400 BAD_REQUEST**，message「请求体过大（上限 256KB）」（契约允许 400/413；实现选 400） |

### 4.3 进度 `GET/PUT/DELETE /api/progress*`

| 检查 | 结果 | 关键实测 |
|---|---|---|
| GET 结构 | PASS | `{ok:true, version:1, updatedAt, data:{version, updatedAt, books}}`，books 下章节/段落结构符合契约 §4.2 |
| PUT 幂等保存 + summary | PASS | 200，回读 sentences 完全一致；`chapterProgress/bookProgress` 与 QA 独立计算（非空译文/ manifest 句数，1 位小数）**完全相等** |
| 8 类非法参数 | PASS | 空 patch、`sentences` 非数组、句数不齐、`starred` 非布尔、`review` 数组、chapterIndex=0、bookId 空串、paragraphIndex=-1 → 均为 400 `BAD_REQUEST` |
| 不存在的段落 | PASS | 404 `NOT_FOUND` |
| 缺请求体 / 非法 JSON | PASS | 400 |
| 并发写 | PASS | 3 个段落并发 PUT 全部 200 且逐段落盘，`/api/progress` JSON 结构完好 |
| DELETE 重置 | PASS | 设置页 E2E 中调用：200 → 再 GET 段落数归零 → 待复习页真实空状态（截图） |

### 4.4 `/api/review` 参数边界（不触发真实 AI）

| 检查 | 结果 | 关键实测 |
|---|---|---|
| 缺 `translations` / 非数组 | PASS | 400，message 指明 translations（在调用 AI 前拦截） |
| 译文句数与原文不齐 | PASS | 400，message 含「句数」 |
| 段落不存在 | PASS | 404（在调用 AI 前拦截） |
| **真实批改（浏览器侧 1 次）** | PASS | 5,352ms；面板：总分环、verdict、三维度（准确/通顺/文风）、逐句 verdict+issues+suggestion、整段修改稿、5 条词汇、3 条建议、重新批改；结果随进度保存并在刷新后恢复 |

### 4.5 `/api/word` 真实调用 1 次

PASS — 2,895ms，`privet` → `phonetic:/ˈprɪvɪt/`、2 条释义（含词性/中文）、2 条例句、`explanation` 非空；响应含 `meta.model=deepseek-chat`、`elapsedMs/usage`。证据：`.scratch/qa/evidence/word-response.json`。

### 4.6 数据一致性（3/3 PASS）

- **磁盘**：199 个章文件的 `title/bookId/chapterIndex/paragraphCount/sentenceCount` 与 `manifest.json` **逐项一致**，合计 37,852 段 / 80,204 句 / 1,118,964 词；段落 index 连续、无空句/换行/双空格/`\x91` 残留。
- **运行态**：重启后 `GET /api/manifest` 与磁盘 manifest **差异 0 处**（此前 38 处差异已随重启消除，见 §7）。
- **进度引用**：进度中所有 book/chapter/paragraph 索引均存在于 manifest 与章文件，且译文句数与原文句数一致。
- **导入/导出往返（设置页 UI）**：导出 8 段（18 非空句 / 2 收藏 / 3 已批改）→ 重置（0 段）→ 导入 → 服务端回读与导出快照 **内容差异 0 处**，状态「导入完成：共 8 段」。

---

## 5. 浏览器端到端逐项结果（49/49 PASS）

证据：`.scratch/qa/browser-results.json`；截图见附录 B。

### 5.1 路由 × 尺寸 × 横向溢出

| 检查 | 结果 | 关键实测 |
|---|---|---|
| 5 个 hash 路由 × 3 尺寸（桌面 1440×1000 / 平板 768×1024 / 手机 390×844，CDP `mobile:true`） | PASS（15/15） | `#/`、`#/book/hp1`、`#/practice/hp1/1`、`#/review`、`#/settings` 均正常渲染，`documentElement.scrollWidth === clientWidth`、`body.scrollWidth === clientWidth`（全部尺寸无横向溢出）；截图 15 张 |
| 手机端章节目录抽屉 | PASS | 打开/关闭正常，`aria-expanded` 正确，无横向溢出（截图 `mobile-390-practice-drawer.png`） |
| 手机端已保存批改面板 | PASS | 390px 宽完整渲染（总分 88、三维度、逐句），无横向溢出（截图 `mobile-390-practice-review-panel.png`） |

### 5.2 练习页核心交互

| 检查 | 结果 | 关键实测 |
|---|---|---|
| 逐句 textarea 可输入 / 字数 / 状态点 | PASS | placeholder「写下这一句的中文译文…」、`aria-label`「第 N 句的中文译文」；输入后字数与「已译」状态点实时更新 |
| 800ms 防抖自动保存 | PASS | 输入后先「待保存」，**859ms** 后「已保存」并落库（≥ 800ms 防抖生效） |
| 刷新后译文恢复 | PASS | 页面 reload 后 textarea 内容仍在 |
| 已保存批改结果恢复 | PASS | `?p=2&panel=review` 展开：总分环 88 + 总评、3 维条形图（准确 90/通顺 88/文风 85）、6 条逐句结果（verdict + issue chips + 建议译文 + 复制）、整段修改稿、5 条词汇、3 条学习建议、重新批改；截图 `desktop-1440-practice-review-saved.png` |
| 真实 Ctrl+Enter 批改 | PASS | 5,352ms 返回并渲染完整面板；结果写入进度（`review.overall.score` 可回读）；截图 `desktop-1440-practice-live-review.png` |
| Ctrl+↓ 跳段 | PASS | 焦点移动到下一段 textarea |
| Esc 关闭面板 | PASS | 面板隐藏 |
| 参考译文二次确认 | PASS | 弹窗「查看参考译文？」+ 提醒文案；点「先自己译」取消后 **`/api/reference` 请求数 0**（不产生费用） |
| 收藏 → 待复习 | PASS | 点击星标后 `aria-pressed=true`，`#/review` 出现「第 1 段」卡片；分类 tab：全部 2 / 收藏 2 / 需改进 1，切换正常 |
| XSS 防护 | PASS | textarea 输入 `<img src=x onerror=window.__xss=1>` → 保存 → reload：仍为**纯文本**、注入 `img[src=x]` 数量 0、`window.__xss === undefined`；截图 `desktop-1440-xss-after-reload.png` |
| 字号/主题刷新持久化 | PASS | 深色主题 + 字号 110% → reload 后 `data-theme=dark`、`--reading-scale=1.1`、localStorage `zs.theme/zs.fontScale` 均保持 |
| 章节目录 / 继续上次练习 | PASS | 书架「继续上次练习」链接 = localStorage lastLocation；章节目录 17 行、继续练习按钮 href 正确、点击第 2 章跳转 `#/practice/hp1/2` |
| 未知路由回书架 | PASS | `#/definitely-not-a-route` → hash 被替换为 `#/` 并渲染书架 |

### 5.3 空状态 / 错误态 / 设置页

| 检查 | 结果 | 关键实测 |
|---|---|---|
| 空状态：全未翻译章节 | PASS | `#/practice/hp2/1`：本章 0%、16 个输入框全空、章节进度「已译 0 / 182 句 · 进度 0%」；截图 `desktop-1440-practice-empty-chapter.png` |
| 空状态：待复习为空（真实 + 演示模式） | PASS | 重置后真实模式显示「还没有待复习的段落」；`?mock=1` 演示模式同样友好空状态（桌面+手机截图） |
| 错误态：后端 500（拦截 `/api/manifest`） | PASS | 书架显示「无法连接后端服务」错误面板 + 重试/演示数据/启动指引，页面非白屏；解除拦截后恢复 7 本书 |
| 错误态：断网保存 | PASS | 显示「保存失败 · 重试」+ 错误 toast，页面不白屏、卡片仍在；恢复网络后点重试 → 已保存且译文落库（截图 `desktop-1440-offline-save-error.png`） |
| 设置页健康状态 | PASS | 「服务运行中 / Key 已配置 / deepseek-chat / api.deepseek.com / 7 本 · 199 章 · 80,204 句」，15 个设置行、6 个卡片（截图 `desktop-1440-settings-health.png`） |
| 设置页导出 | PASS | 下载 `逐句译_进度备份_20261119-1829.json`，结构 `{version, exportedAt, books}`，8 段（证据 `evidence/exported-progress.json`） |
| 设置页重置 | PASS | 二次确认弹窗（含「无法恢复」提示）→ 服务端进度清空为 0 段 → 待复习真实空状态（截图） |
| 设置页导入 | PASS | 选择导出文件 → 确认「导入 8 段」→「导入完成：共 8 段」，回读与导出快照差异 0；截图 `desktop-1440-settings-after-import.png` |
| 设置页健康兜底 | PASS | 拦截 `/api/health` 使其失败 → 内联错误「无法连接本机后端服务」+ npm start 指引，非白屏（截图） |
| 主题三段切换 | PASS | 浅色/深色/跟随系统按钮 `aria-pressed` 正确，最终恢复浅色 |

---

## 6. AI Key 未配置降级（5185 独立实例，6/6 PASS）

隔离方式：`PORT=5185 DEEPSEEK_NO_SYSTEM_ENV=1` + 临时 `PROGRESS_PATH`（`.scratch/qa/tmp-5185-progress.json`），**未触碰 5180 与真实进度**，结束后进程与临时文件均清理（5185 无监听）。

| 检查 | 结果 | 关键实测 |
|---|---|---|
| health | PASS | `keyConfigured:false`，7/199/80,204 正常；启动 3 行日志无 Key、含访问地址 |
| `/api/review` | PASS | **401 `AI_AUTH`**，message「尚未配置 DeepSeek API Key。请在项目根目录 .env 中设置…」 |
| `/api/reference` | PASS | **401 `AI_AUTH`** |
| 练习页输入/保存 | PASS | 未配置 Key 时仍可输入并「已保存」落库（练习功能不受影响） |
| 点「AI 批改」降级 UI | PASS | 面板标题「尚未配置 DeepSeek API Key」+ `.env` 指引 + 「去设置页」链接，页面不白屏（截图 `ai-auth-panel-error.png`） |
| 设置页降级 UI | PASS | 状态 pill「服务运行中 / 未配置」+ 配置指引，不报红不白屏（截图 `ai-auth-settings.png`） |

---

## 7. 已发现并关闭的问题：服务缓存旧 manifest（P1 环境时序，非产品缺陷）

- **现象**：17:56 首轮黑盒测试发现 `GET /api/health` 报 80,349 句，且运行态 `/api/manifest` 与磁盘 `data/corpus/manifest.json` 有 **38 处统计不一致**（14 个章 + 5 本书；最大 hp7/18：服务端 201 段/348 句 vs 磁盘实际 82 段/229 句）。
- **根因**：服务进程 PID 25508 启动于 17:43:05，早于语料最终重建写入（manifest mtime 17:51:28），manifest 被进程内存缓存；磁盘语料自身完全自洽（37,852 段 / 80,204 句）。
- **处理**：Lead 于 18:04:13 重启 5180（PID 41620）加载最终语料。
- **复核**：重启后 health 80,204 句；served manifest vs 磁盘 **差异 0**；数据一致性 3 项 PASS；全部后续测试基于重启后服务完成。
- **结论**：**测试环境时序问题，不计入产品缺陷**（不需改代码）。保留一条运维注意事项：**语料重建后必须重启服务**（manifest 有内存缓存）。
- 完整记录与证据：`.scratch/qa/evidence/manifest-stale-cache-incident.md`。

---

## 8. 问题清单（P0/P1/P2）

### P0（阻断使用）— 0 项

未发现阻断使用的缺陷；所有主路径功能可用。

### P1（产品缺陷）— 0 项

（唯一 P1 级别发现为 §7 环境时序问题，已由 Lead 重启复核关闭，非产品缺陷。）

### P2（次要 / 文档 / 体验）— 3 项

#### P2-1｜README 章节数与最终语料不一致（文档错误）

- **现象**：`README.md` 第 10 行写「**共 208 章**」；实际最终语料为 **199 章**（17+18+22+37+38+30+37，与 `docs/CONTRACT.md` §3.4 一致）。`/api/health` 与书架统计均显示 199。
- **影响**：用户/新协作者对规模认知错误；无功能影响。
- **复现**：对比 `README.md:10`、`docs/CONTRACT.md:146` 与 `GET /api/health`（chapters=199）。
- **建议**：Lead 修改 README「共 199 章」（契约 §4.1 示例里的 `chapters:208` 建议同步改为 199）。

#### P2-2｜手机端练习页顶栏字号 A-/A+ 被隐藏（响应式可用性）

- **现象**：视口 ≤860px 时 `.font-control { display:none }`（`public/css/app.css:4270-4277`），练习页顶栏不再有字号调整入口；设置页仍保留「正文字号」控制，功能未丢失。
- **影响**：手机用户需离开练习去设置页调字号，契约 §6.2「顶栏字号 A-/A+」在手机断点未满足。
- **证据**：浏览器 E2E「移动端触控目标」检查记录字号按钮高度 = 0（隐藏）；`.scratch/qa/browser-results.json`。
- **复现**：手机尺寸（390×844）打开 `#/practice/hp1/1`，顶栏无 A-/A+；`#/settings` 仍有正文字号控件。
- **建议**：确认是否为有意取舍；若保留设置页入口，建议在契约 §6.2 标注手机端例外，或顶栏改用「更多」菜单提供字号。

#### P2-3｜手机端顶栏图标按钮 38×38px，低于契约「触控目标 ≥40px」

- **现象**：≤860px 时 `.topbar-actions .icon-btn` / `.topbar-back` / `.sidebar-toggle` 为 38×38px（`public/css/app.css:4490-4517`）；正文主按钮 40px、textarea 76px 均达标。
- **影响**：略小于契约 §6.2 触控目标建议，可点击但偏小。
- **证据**：`.scratch/qa/browser-results.json` 中「移动端触控目标」检查记录 iconButtons 高度 38；截图 `mobile-390-practice-hp1-1.png`。
- **建议**：将移动端顶栏图标按钮调到 ≥40px，或在契约中放宽到 38px。

---

## 9. 未验证 / 未覆盖项（UNVERIFIED）与风险

| # | 项目 | 原因 / 状态 |
|---|---|---|
| 1 | 真实 `/api/reference` 成功生成（非 401 场景） | 成本控制：仅验证「二次确认 + 取消不发请求」与「未配置 Key→401」；未真实调用生成参考译文（契约未强制 QA 验证，后端 47 单测覆盖该接口结构） |
| 2 | `/api/review` AI 异常路径（坏 JSON 重试、超时、429）端到端 | 由后端 `node:test`（47 项全绿）用 mock DeepSeek 覆盖；QA 未制造真实 AI 故障（成本/时间） |
| 3 | `run-all.mjs` 整体编排端到端 | 3 个子脚本均**单独执行并全 PASS**；进度「备份→恢复→内容比对」逻辑用等价收尾脚本（`.scratch/qa/finalize.mjs`）实测差异 0；未为省真实 AI 调用而整体重跑编排 |
| 4 | 超长章节（如 hp4 37 章 606 段）整章懒加载与性能压力 | 仅验证初始 5 段渲染 + 滚动加载机制 + 多章切换；未做整章全量渲染/滚动压力与内存测试 |
| 5 | 大进度文件导入（数千段） | 仅 8 段导出→重置→导入往返；导入代码有 5000 段上限保护，未做大规模压测 |
| 6 | 真机移动端 / 其他浏览器（iOS Safari、Chrome、Firefox） | 仅在 Edge 157 headless + CDP 移动模拟下验证；未真机、未跨浏览器 |
| 7 | 屏幕阅读器（NVDA/VoiceOver）实际朗读 | 仅自动化抽查：aria-label、焦点可见、暗色对比度；未做读屏实机测试 |
| 8 | AI 批改质量（内容是否「教得好」） | 属内容质量而非功能验收；本次仅验证结构化字段与落库/恢复 |
| 9 | `/api/export`（契约可选接口） | 后端未实现（契约 §4 标注「可选，可省略」），QA 不视为失败；未验证 |
| 10 | 语料 PDF 重建管线（Python） | 未重跑 `build_corpus.py --selfcheck`（成本高、且会重写 data/，超出 QA 写权限）；只读复核 quality-report 80/80 + 独立校验 manifest/章文件一致性 |
| 11 | 键盘 Ctrl+↑/Ctrl+↓ 全部组合、Esc 关闭抽屉、更多菜单各项 | 已验证 Ctrl+Enter、Ctrl+↓、Esc 关面板；其余组合抽查未逐一断言 |
| 12 | 进度并发场景下的 UI 多标签页同步 | 未测试多标签页同时编辑同一段落 |

**风险提示**

1. 真实 AI 输出内容不可控：本 QA 只抽 1 次真实批改（字段完整、5.35s），AI 慢/超时/格式异常依赖后端归一化与重试兜底；极端网络下用户可能等待较久（前端有 skeleton 与 150s 超时）。
2. 语料重建后不重启服务会再次出现 §7 的「统计与进度分母与实际不符」现象，建议启动日志或开发文档明确「重建语料后重启」。
3. 进度文件为单文件 JSON（当前 2 段，符合设计）；长期大量练习后文件增长与原子写耗时尚无压测数据。

---

## 10. 测试副作用与进度恢复（重要）

- **破坏性操作**：设置页测试按任务要求执行了「导出 → 重置全部进度 → 导入」完整往返；重置会清空真实 `data/progress.json`。
- **已先备份**：测试开始前 `GET /api/progress` 备份到 `.scratch/qa/progress-backup-before-qa.json`（2 段 / 9 非空句 / 1 收藏 / 2 批改）。
- **已恢复并校验**：测试结束后通过 API 逐段 PUT 回写，`diffProgress` 比对 **内容差异 0 处**（仅 `updatedAt` 为恢复时刻）；最终 `/api/progress` 仅含 hp1 第 1 章 1、2 段，与测试前一致。`qa-summary.json` 中 `progressRestored: true`。
- 浏览器 localStorage（字号/主题/lastLocation）只存在于 headless 临时 profile，随浏览器关闭销毁，不影响用户浏览器。
- 测试产生的临时文件：`.scratch/qa/tmp-5185-progress.json` 已清理；5185 临时实例已关闭（无监听）。

---

## 11. 附录 A：证据文件索引

| 路径 | 说明 |
|---|---|
| `.scratch/qa/qa-summary.json` | 总汇总（105/105、进度恢复 true） |
| `.scratch/qa/api-results.json` | API 50 项逐项结果 |
| `.scratch/qa/browser-results.json` | 浏览器 49 项逐项结果 + 截图清单 + 控制台错误分布 |
| `.scratch/qa/ai-auth-results.json` | Key 未配置 6 项结果 |
| `.scratch/qa/evidence/health.json` | 重启后 health 响应（80,204 句） |
| `.scratch/qa/evidence/manifest-disk.json` / `manifest-served.json` / `manifest-served-vs-disk-diff.json` | 磁盘/服务端 manifest 及差异（0） |
| `.scratch/qa/evidence/corpus-disk-consistency.json` | 199 章文件 vs manifest 一致性（0 差异） |
| `.scratch/qa/evidence/chapter-hp1-1.json` | 章节样例响应 |
| `.scratch/qa/evidence/progress-before-tests.json` / `progress-concurrent-after.json` | 进度结构 / 并发写后 |
| `.scratch/qa/evidence/exported-progress.json` / `import-roundtrip-diff.json` | 导出文件、导入往返差异（0） |
| `.scratch/qa/evidence/saved-review-panel-facts.json` / `live-review-panel-facts.json` | 批改面板字段实测 |
| `.scratch/qa/evidence/word-response.json` | `/api/word` 真实响应 |
| `.scratch/qa/evidence/console-errors.json` / `bad-responses.json` / `request-origins.json` | 控制台/网络证据（正常阶段 0 error、0 异常响应、仅同源） |
| `.scratch/qa/evidence/a11y-unlabeled.json` | 无可访问名称元素扫描（空） |
| `.scratch/qa/evidence/manifest-stale-cache-incident.md` | 环境时序问题记录与复核 |

## 12. 附录 B：截图清单（35 张，`.scratch/qa/screenshots/`）

**桌面 1440×1000（19 张）**：`desktop-1440-library` / `book-hp1` / `practice-hp1-1` / `review` / `settings`（5 路由）、`practice-review-saved`、`practice-live-review`、`reference-confirm`、`review-after-star`、`xss-after-reload`、`practice-dark`、`practice-empty-chapter`、`review-empty-mock`、`review-empty-real`、`manifest-error`、`offline-save-error`、`settings-health`、`settings-after-import`、`settings-health-error`

**平板 768×1024（5 张）**：`tablet-768-{library,book-hp1,practice-hp1-1,review,settings}`

**手机 390×844（9 张）**：`mobile-390-{library,book-hp1,practice-hp1-1,review,settings}`、`practice-drawer`、`practice-review-panel`、`practice-dark`、`review-empty-mock`

**AI Key 未配置（2 张）**：`ai-auth-panel-error`、`ai-auth-settings`

> 说明：截图均由 CDP `Page.captureScreenshot` 生成；手机尺寸使用 `Emulation.setDeviceMetricsOverride {mobile:true, deviceScaleFactor:2}`，非 `--window-size`，避免误判移动端布局。

---

## 13. 附：契约逐条对照（§7 后端验收）

| 契约 §7 项 | 状态 | 依据 |
|---|---|---|
| 1. 静态文件 `/`、`/css/app.css` 200；路径穿越 404 | PASS | `api-results.json` static/traversal |
| 2. manifest / hp1 章节正常；不存在章节 404；非法 bookId 不穿越 | PASS | manifest/chapters/404/traversal |
| 3. 无 Key：health false，review `AI_AUTH` | PASS | 5185 独立实例 E2E |
| 4. mock DeepSeek 正常/坏 JSON/超时/401 | PASS（后端 47 单测，QA 复核 `npm test`） | `npm test` 47/47 |
| 5. 进度 PUT→GET 一致、重启在、并发不损坏、DELETE | PASS（并发 PUT + DELETE 实测；重启持久化由后端单测覆盖，且本次服务重启后测试写进度仍完整回读） | progress 阶段 |
| 6. `node --test test/` 全绿、`npm test` 可用、不调用真实 DeepSeek | PASS | `npm test` 47/47，全程未触发测试内真实调用 |

---

**报告结论**：在当前最终语料（7 本 / 199 章 / 80,204 句）与重启后的服务（keyConfigured=true）上，**用户可见功能、API 契约、数据一致性、安全边界（XSS/路径穿越/Key 不泄露）、错误与空状态降级均通过**；仅 3 项 P2 级文档/响应式/触控目标建议与若干未覆盖项，无阻断发布的问题。

*QA 未修改 `server/`、`public/`、`scripts/`、`data/` 任何文件；写入范围仅 `tests/e2e/`、`docs/QA-REPORT.md`、`.scratch/qa/`。*

---

## 14. 后续处理（Lead 收尾，2026-11-19）

QA 报告生成后，Lead 完成 3 项 P2 收尾（未改动 `server/` 与数据）：

- **P2-1（文档）**：README 与 `docs/CONTRACT.md` 的章节/句数已在报告生成前修正为 **199 章 / 80,204 句**（§8 的观察基于修正前文本，实际当前文档已正确）。
- **P2-2（移动端字号入口）**：练习页「更多操作（⋯）」菜单新增「增大/减小正文字号（A±）」两项；390px 下实测可调（100% → 110% 且 localStorage 持久化），不再依赖设置页。
- **P2-3（触控目标）**：≤860px 顶栏图标按钮由 38×38 调整为 **40×40**（返回 / 目录 / 主题 / 更多实测均为 40×40）。

**修复后回归**：重跑 `node tests/e2e/browser-e2e.mjs --skip-live-review` → 全 PASS（5 路由 × 3 尺寸无横向溢出、移动端触控目标、XSS、防抖保存与恢复、控制台 0 error）；`npm test` 47/47；服务已重置为初始进度（0 段）交付。
