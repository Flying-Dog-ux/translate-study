# 逐句译 · Translate Study — 项目契约（唯一事实来源）

> 本文件由 Lead 维护。所有 Agent 开始工作前必须完整阅读；契约变更由 Lead 修改并通知。
> 工作目录：`D:\Blog\spark\translate_study`（Windows，pwsh，Node v24，Python 3.14）。
> 本地单用户 Web 应用：英文语料（哈利波特 7 本 PDF）→ 逐句英译中练习 → 段落级 DeepSeek AI 批改。

---

## 1. 目标与非目标

**目标（MVP 必须全部可用）**
1. 从 7 本 PDF 抽取干净语料：书 → 章 → 段 → 句，质量经校验（无页眉页脚/连字符残留，句子切分正确）。
2. 书架/章节目录，逐句翻译输入（英文原句 + 中文输入框），自动保存到服务器。
3. 段落级「AI 批改」：把本段英文原句 + 用户译文发给 DeepSeek，返回结构化修改意见（总评/逐句问题/建议译文/整段修改稿/词汇积累）。
4. 「参考译文」按需生成（用户可以先练后看）。
5. 进度统计、收藏/待复习、导出；设置页可看 API 状态。
6. 一键启动（`npm start`），浏览器打开 `http://127.0.0.1:5180` 即可用。中文 UI。

**非目标**：多用户/注册、云端部署、TTS、移动 App、原文全文按页显示（只按段练习）。

**硬约束**
- **零外部 npm 依赖**：只用 Node 内置模块（`node:http`、`node:fs`、`node:path`、`node:test`、全局 `fetch`）。前端零框架、零构建，原生 ES modules + CSS。不得引入 React/Vite/Express/tailwind 等。
- Python 语料管线只用已安装的 `pymupdf`（import fitz 会有 Deprecation warning，可忽略；推荐 `import pymupdf`）。不要求 pip install。
- **绝不修改/移动源 PDF**。源目录只读。
- **API Key 永不写入源码、日志、前端、测试、文档、git 文件**。服务端运行时读取（见 §5）。
- 仅本机访问：默认绑定 `127.0.0.1`。除 DeepSeek API 外不访问外网。
- 所有文本文件 UTF-8（无 BOM）。Windows 路径用正斜杠或 `path.join`。
- 代码注释和 UI 文案用中文；英文语料保持原样（不机翻、不改写）。

---

## 2. 目录结构与写入范围（严格不越界）

```
translate_study/
├─ docs/                     # Lead
│  ├─ CONTRACT.md            # 本文件
│  ├─ QA-REPORT.md           # QA
│  └─ REVIEW-PROMPT.md       # 可并入 backend prompts，可选
├─ scripts/                  # corpus-builder
│  ├─ build_corpus.py        # 主程序：PDF → data/corpus
│  ├─ test_corpus.py         # 语料管线单元测试（python scripts/test_corpus.py）
│  └─ README.md              # 用法
├─ data/
│  ├─ corpus/                # corpus-builder（生成物，可重建）
│  │  ├─ manifest.json
│  │  ├─ quality-report.json
│  │  └─ hp1/chapter-001.json … hp7/chapter-037.json
│  └─ progress.json          # 运行期生成（backend），不手写
├─ server/                   # backend-dev
│  ├─ index.js               # 入口：HTTP server + 静态服务 + 路由
│  ├─ corpus.js              # 读取 manifest/章节缓存，路径校验
│  ├─ deepseek.js            # DeepSeek 客户端（fetch、超时、重试、并发队列、JSON 解析）
│  ├─ prompts.js             # 系统提示词 & user prompt 构造（review / reference / word）
│  ├─ review.js              # 批改结果 schema 归一化/校验
│  ├─ progress.js            # data/progress.json 原子读写、按段 patch
│  └─ config.js              # 端口/模型/Key 解析（含 Windows 系统变量回退）
├─ test/                     # backend-dev（node:test）
│  ├─ server.test.js         # 用 mock DeepSeek + 临时数据目录做黑盒 HTTP 测试
│  └─ fixtures/              # 测试用迷你语料
├─ public/                   # frontend-dev
│  ├─ index.html
│  ├─ css/app.css
│  ├─ js/app.js              # 路由 + 状态 + API 封装
│  ├─ js/views/*.js          # library/practice/review/settings 视图（可再拆）
│  └─ js/mock/*.json         # 仅前端自救用 mock（正式联调走 API）
├─ tests/e2e/                # QA
├─ package.json              # backend-dev（仅 scripts: start/test/…，无 dependencies）
├─ .env.example              # backend-dev（注释说明，不含真实 key）
├─ .gitignore                # Lead
├─ README.md                 # Lead
└─ legacy/index.html         # 旧原型，不动（Lead 归档）
```

**写入范围**：每个 Agent 只能写自己范围内的文件。跨范围需求发消息给 Lead 协调。禁止并行修改同一文件。

---

## 3. 语料契约

### 3.1 源文件
`D:\书籍\优质资源合集0724（1）\优质书籍\哈利波特电子书\J.K.+Rowling+-+HP+{1..7}*.pdf`
（共 7 本。**另一组** `Harry Potter and the … - J.K. Rowling.pdf` 排版异常，不要使用。）

书名（按顺序）：Sorcerer's Stone / Chamber of Secrets / Prisoner of Azkaban / Goblet of Fire / Order of the Phoenix / Half-Blood Prince / Deathly Hallows。
中文短名：魔法石 / 密室 / 阿兹卡班的囚徒 / 火焰杯 / 凤凰社 / 混血王子 / 死亡圣器。
id 固定：`hp1`…`hp7`。

### 3.2 PDF 版式已知信号（HP1 实测，其他本需自行校验）
- 正文 span 字号 13.0；正文左边距 x0≈39.7，**段首行缩进 x0≈53.9**（缩进即新段）。
- 章首页顶部 `C H A P T E R  O N E`（26pt，y≈39），下方章名（36pt），再下方首字母 drop cap（~85pt 单字母）。
- 后续页页眉：26pt、y≈48，奇数页 `CHAPTER  ONE`，偶数页章名；页脚页码 20pt、y≈583，形如 `\x91 10 \x91`（`\x91`=0x91 控制符）。
- 行尾连字符断词：`Mug-\ngles` → `Muggles`（去连字符直接拼）；`You-\nKnow-Who` → `You-Know-Who`。
- `. . .` 空格化省略号保留原文写法；弯引号 ’ “ ” 正常；`\x91` 统一替换为 `—`。
- 段落/句子重建是核心难点，必须用测试验证，不允许把整页文字直接当一句。

### 3.3 生成物

`data/corpus/manifest.json`（精确 schema）：
```json
{
  "version": 1,
  "generatedAt": "2026-11-19T12:00:00.000Z",
  "sourceDir": "D:\\书籍\\...\\哈利波特电子书",
  "books": [
    {
      "id": "hp1",
      "order": 1,
      "title": "Harry Potter and the Sorcerer's Stone",
      "titleZh": "哈利·波特与魔法石",
      "wordCount": 79000,
      "paragraphCount": 850,
      "sentenceCount": 5200,
      "chapters": [
        { "index": 1, "number": "ONE", "title": "The Boy Who Lived",
          "paragraphCount": 52, "sentenceCount": 305,
          "file": "hp1/chapter-001.json" }
      ]
    }
  ]
}
```
- `index` 从 1 连续；`file` 用正斜杠；`wordCount`=正文词数（空格切分）；章级统计与章文件一致。
- HP7 的 epilogue 若单独成节：追加 `index:37, number:"EPILOGUE", title:"Nineteen Years Later"`。

`data/corpus/hp1/chapter-001.json`：
```json
{
  "bookId": "hp1",
  "chapterIndex": 1,
  "title": "The Boy Who Lived",
  "paragraphs": [
    {
      "index": 0,
      "sentences": [
        { "text": "Mr. and Mrs. Dursley, of number four, Privet Drive, were proud to say that they were perfectly normal, thank you very much.", "wordCount": 24 }
      ]
    }
  ]
}
```
- `paragraphs[].index` 本章内从 0 连续；`sentences` 是纯文本数组元素，无 id（索引即 id）。
- 句末标点后不允许多余空格；段内句子按原文顺序紧密还原。

### 3.4 语料验收标准（必须写进 `scripts/build_corpus.py --selfcheck` 并输出到 quality-report）
1. 7 本齐全，章节数：hp1=17, hp2=18, hp3=22, hp4=37, hp5=38, hp6=30, hp7=36(+epilogue 则 37)。
2. 每本 `wordCount` 在官方量级 ±10%：77k/85k/107k/190k/257k/169k/198k。
3. 正文句子里不得出现：页眉页脚残留（`^CHAPTER [A-Z]+$` 独立串、纯页码行、`\x91`、`Contents`）、双空格、行尾连字符、`\n`（句子内）、BOM。
4. 句长分布：每本平均句长 12–22 词，无 >120 词句子；最长句抽查 5 条无截断（结尾有 . ! ? ” ’ ) 等）。
5. 每章首段/末段人工抽查 10 条，语义完整、无跨段粘连。
6. 引号成对性：每本 `“` 与 `”` 数量差 < 0.5%；`，` 不出现（中文标点不得混入英文语料）。
7. 输出报告 JSON：`{ checks: [{id, pass, detail}], books: [...], samples: [...] }`，失败项 exit code 1。

---

## 4. HTTP API 契约（backend 实现，frontend 消费）

Base：`http://127.0.0.1:5180`。所有响应 JSON（静态文件除外），UTF-8。
成功：`200`，失败统一结构：`{"ok":false,"error":{"code":"...","message":"中文可读信息"}}`。
错误码：`BAD_REQUEST` 400 / `NOT_FOUND` 404 / `AI_AUTH` 401 / `AI_RATE_LIMIT` 429 / `AI_TIMEOUT` 504 / `AI_BAD_FORMAT` 502 / `SERVER_ERROR` 500。
AI 类响应未标明 `ok` 时，前端按 `error.message` 弹 toast。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | `{ok:true, version, keyConfigured, model, baseUrlHost, corpus:{books, chapters, sentences}, progressUpdatedAt}`；key 不泄露 |
| GET | `/api/manifest` | 原样返回 manifest.json |
| GET | `/api/chapters/:bookId/:chapterIndex` | 返回章文件；不存在 404 |
| GET | `/api/progress` | `{ok:true, version:1, updatedAt, data:{...}}` |
| PUT | `/api/progress/paragraph` | 见 4.2 |
| DELETE | `/api/progress` | 重置全部进度 `{ok:true}` |
| POST | `/api/review` | 段落 AI 批改，见 4.3 |
| POST | `/api/reference` | 段落参考译文，见 4.4 |
| POST | `/api/word` | 单词/短语讲解（可选但建议），见 4.5 |
| GET | `/api/export?books=hp1&chapter=1` | 可选：本次批改导出 markdown；若无精力可省略 |

### 4.1 健康检查示例
```json
{ "ok": true, "version": "1.0.0", "keyConfigured": true, "model": "deepseek-chat",
  "baseUrlHost": "api.deepseek.com",
  "corpus": { "books": 7, "chapters": 199, "sentences": 80204 },
  "progressUpdatedAt": "2026-11-19T12:00:00.000Z" }
```

### 4.2 保存段落进度
`PUT /api/progress/paragraph`
```json
{
  "bookId": "hp1", "chapterIndex": 1, "paragraphIndex": 0,
  "sentences": ["我翻译的第一句。", "", "第三句的译文"],
  "starred": false,
  "review": { ...review 对象或 null... }
}
```
返回 `{ok:true, updatedAt, summary:{bookProgress: 12.3, chapterProgress: 45.6}}`。
- 服务端合并进 `data/progress.json`，原子写（写 `.tmp` 再 rename）；节流/防抖由前端做。
- `data` 结构固定（前端可依赖）：
```json
{ "version":1, "updatedAt":"...",
  "books": { "hp1": { "chapters": { "1": { "paragraphs": {
      "0": { "sentences": ["…"], "starred": false, "review": null,
             "updatedAt": "…" } } } } } } }
```
- 服务端计算进度时以 manifest 的 sentenceCount 为分母，翻译非空句数为分子。

### 4.3 段落 AI 批改
`POST /api/review`
```json
{ "bookId": "hp1", "chapterIndex": 1, "paragraphIndex": 0,
  "translations": ["…中文…", ""], "context": { "prevSource": "optional", "nextSource": "optional" } }
```
- 服务端从语料按 bookId/chapterIndex/paragraphIndex 取权威英文原句（不信任客户端原文）；句数必须对齐，否则 400。
- `translations` 中空串/纯空白 = 未译，仍要批改（给参考译法）。
返回：
```json
{
  "ok": true,
  "review": {
    "overall": {
      "score": 78,
      "verdict": "good",
      "summary": "整体理解准确……",
      "dimensions": [
        {"id":"accuracy","label":"准确","score":80},
        {"id":"fluency","label":"通顺","score":76},
        {"id":"style","label":"文风","score":74}
      ]
    },
    "sentences": [
      { "index": 0,
        "verdict": "needs_improvement",
        "issues": [{"type":"用词","detail":"normal 在此处是「正常/普通」，不是「正规」"}],
        "suggestion": "建议译文……",
        "comment": "……" }
    ],
    "revisedParagraph": "整段修改后的参考译文……",
    "vocabulary": [{"term":"thank you very much","meaning":"（这里）说得好听点/还真是","note":"英式口语反讽"}],
    "tips": ["……"]
  },
  "meta": { "model": "deepseek-chat", "elapsedMs": 8200, "usage": {"prompt_tokens":0,"completion_tokens":0,"total_tokens":0} }
}
```
- `verdict` 枚举：`excellent|good|needs_improvement|incorrect|missing`（missing=用户未翻译）。
- `issues[].type` 建议枚举：`漏译|误译|用词|搭配|语法|语序|语气|文化|标点|冗余`。
- 服务端必须兜底归一化：缺字段给默认值，`sentences` 长度补齐到原句数，`score` 夹在 0–100，格式错误重试 1 次仍失败返回 `AI_BAD_FORMAT`（message 提示可重试）。
- DeepSeek 请求用 `response_format:{type:"json_object"}`；`temperature`≈0.3；`max_tokens` 2000；超时 120s。
- 提示词要求（写到 `server/prompts.js`）：资深英译中教师人设；逐句对照原文与译文；先肯定再指出问题；错误定位到具体词；建议译文自然地道、可作范本；中文输出；严禁输出 JSON 以外内容；评分标准（准确 50% / 通顺 30% / 文风 20%）。

### 4.4 参考译文
`POST /api/reference` body `{bookId, chapterIndex, paragraphIndex}` → 
```json
{ "ok": true, "reference": { "translation": "整段中文", "sentences": [{"index":0,"translation":"…","note":"可选难点说明"}] }, "meta": {...} }
```

### 4.5 单词讲解（可选，优先级低）
`POST /api/word` body `{ "word": "privet", "sentence": "…", "paragraph": "…" }` → `{ok:true, entry:{word, phonetic, meanings:[{pos, cn}], explanation, examples:[{en,cn}]}}`。

### 4.6 非 API
- 静态文件：`public/` 为根，`/` → `index.html`；404 返回 index.html（前端 hash 路由）。
- CORS 不需要（同源）。请求体上限 256KB。GET 静态文件禁止路径穿越。
- 服务启动后打印三行：访问地址、AI 配置状态（key 是否配置 / model / base host，绝不打印 key）、语料统计。

---

## 5. 配置与 Key 解析

优先级（config.js 实现）：
1. `process.env.DEEPSEEK_API_KEY`
2. 项目根 `.env`（`KEY=VALUE` 逐行解析，忽略 `#`；不引入 dotenv 包）
3. Windows **系统变量**（Machine）：`[Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY','Machine')` 等价路径（用 `reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v DEEPSEEK_API_KEY` 解析，Node 内置 `child_process.execFileSync`）
4. Windows 用户变量（HKCU\Environment）兜底
- 读取后 `trim()`；为空/读取失败 → `keyConfigured:false`，`/api/review` 返回 `AI_AUTH`，message 提示去设置页看配置指引。
- 其他 env：`PORT`(5180) `HOST`(127.0.0.1) `DEEPSEEK_BASE_URL`(https://api.deepseek.com) `DEEPSEEK_MODEL`(deepseek-chat) `AI_TIMEOUT_MS`(120000) `PROGRESS_PATH`（测试覆盖）`CORPUS_DIR`（测试覆盖）。
- `.env.example` 只有占位和注释；`.gitignore` 忽略 `.env`。

---

## 6. 前端规格（public/，原生 JS）

### 6.1 路由（hash）
- `#/` 书架：7 本书卡片（书名、中文名、总进度环、章节数、句子数、词数），点击进入章节列表。
- `#/book/:bookId` 章节目录：章号+英文标题+每章进度；继续上次练习按钮（读 localStorage 记录 `lastLocation`）。
- `#/practice/:bookId/:chapterIndex` 练习主界面。
- `#/review` 待复习：收藏段 + AI 判定 `needs_improvement/incorrect` 的段落，可跳回。
- `#/settings` 设置：API 状态（`/api/health`，显示 keyConfigured、model；可点「重新检测」）、导出进度 JSON、导入、重置、快捷键说明、数据来源说明。
- 未知路由回书架。

### 6.2 练习主界面（核心，必须好用）
- 顶栏：← 书架 | 书名·第N章 标题 | 进度条 xx% | 字号 A-/A+（localStorage；≤860px 时收进「更多操作」菜单，顶栏图标按钮 ≥40px）| 主题切换 | 更多菜单（字号/本章导出/重置本章）。
- 左侧栏（≥1100px 显示）：全书章节目录（当前章高亮、每章进度点），可滚动；移动端收进抽屉。
- 主区按段渲染卡片（懒加载：先渲染前 5 段，滚动加载；或一次渲染全章但图片无—文字量可接受，章均 700 句；建议虚拟化/分段加载，避免卡顿）。
- 每段卡片：
  - 段号 chip + 本段句子数 + 收藏星标。
  - 每个句子一行两栏：左英文原句（serif，可选中复制；点击可选词→查词 popover），右中文 textarea（自动增高，placeholder「写下这一句的中文译文…」，字数提示）。
  - 句子状态点：未译/已译（输入非空即已译，不必精确）。
  - 底部按钮：「AI 批改本段」（主按钮）、「参考译文」（次级，先二次确认「先自己翻，确定要看参考吗？」或直接生成但记录看过）、「复制我的译文」。
  - 批改结果面板（同卡片下方展开）：
    - 总分环形/大数字 + verdict 徽章 + 总评；三维度条形图。
    - 逐句结果列表：句子序号 + verdict 徽章（颜色：excellent/good 绿、needs_improvement 橙、incorrect 红、missing 灰）+ 问题 chips（类型+说明）+ 建议译文（浅绿底，带复制按钮）。
    - 「整段修改稿」折叠块，复制按钮。
    - 「词汇与表达」列表；「学习建议」列表。
    - 底部：模型/耗时/时间，按钮「重新批改」。
  - 批改中：按钮 loading、面板 skeleton + 进度文案轮换（「正在逐句比对…」「正在提炼修改建议…」），禁止重复提交。
  - 批改结果随进度保存（保存到 review），刷新后恢复。
- 自动保存：输入 800ms 防抖 `PUT /api/progress/paragraph`；右上角「保存中/已保存/保存失败(点击重试)」状态；离开页面前 flush（`visibilitychange`/`beforeunload` 用 `navigator.sendBeacon` 可选）。
- 空状态/错误态/加载态都要有。API key 未配置时点批改 → 弹设置提示，不报红。
- 键盘：`Ctrl/Cmd+Enter` 批改当前聚焦段；`Ctrl+↓/↑` 跳下/上一段；`Esc` 关面板。设置页有说明。
- 无障碍：按钮有 aria-label，焦点可见，对比度达标；中文字体 system-ui，英文 serif（Georgia/Charter）。
- 视觉方向：安静、书卷气、专注阅读。浅色=暖米白纸感 + 深墨绿/靛蓝强调色；深色=深灰蓝 + 柔和米色文字。避免第三方图片/字体/CDN，图标用 inline SVG。**不要**使用哈利波特官方 logo/插画/字体，可有极简星形/闪电装饰线条（抽象、原创）。
- 响应式：手机单栏可用，句子栏上下堆叠；触控目标 ≥40px。

### 6.3 前端技术约束
- 原生 ES modules；`fetch` 封装 `api.js`；集中状态（简单 store 即可）；不引第三方库。
- XSS：所有用户/语料文本用 `textContent` 或转义后插入，禁止裸 innerHTML 拼语料。
- 所有 UI 文案中文（英文书名/原句除外）。

---

## 7. 后端验收（test/ 必须自动覆盖）
1. 静态文件：`/` 200、`/css/app.css` 200、路径穿越 404。
2. `GET /api/manifest` 与 `GET /api/chapters/hp1/1` 正常；不存在章节 404；非法 bookId 404（不得路径穿越）。
3. 启动时读不到 key：健康检查 `keyConfigured:false`，`/api/review` 返回 `AI_AUTH`。
4. mock DeepSeek（本地 http server）：正常返回时 `/api/review` 结构化字段齐全；返回坏 JSON 时重试后 `AI_BAD_FORMAT`；超时 → `AI_TIMEOUT`；401 → `AI_AUTH`。
5. 进度：PUT → GET 回读一致；重启后仍在（临时 PROGRESS_PATH）；并发 PUT 不损坏 JSON；DELETE 重置。
6. `node --test test/` 全绿。`npm test` 可用。测试不得调用真实 DeepSeek（用 mock / `DEEPSEEK_BASE_URL` 指向本地）。

## 8. 运行与联调（Lead 负责最终启动）
- `npm start` → http://127.0.0.1:5180
- 后端 Agent 可用 `PORT=5181 node server/index.js` 自测后关闭，勿留后台进程。
- 前端 Agent 可临时 `python -m http.server 5182 -d public` 自测后关闭；API 联调由 Lead 起完整服务。
- QA 用 Edge headless 截图：`"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless=new --disable-gpu --window-size=1440,1000 --screenshot=... http://127.0.0.1:5180/#/...`（需等页面加载，可加 `--virtual-time-budget=5000`）。

## 9. 协作协议
- 每个 Agent 认领对应共享任务（team_task_list → get → claim），完成后 `complete` 并给 Lead 发一条简报：交付物、验证命令与结果、遗留问题。
- 遇到契约未覆盖的取舍：选简单稳妥方案并在简报中说明，不要阻塞。
- 不记录、不打印 API Key；不使用真实 key 做批量测试（Lead 只做少量真实联调）。
- 不修改他人范围内文件；需要时发消息给 Lead。
