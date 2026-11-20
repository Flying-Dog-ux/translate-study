# 语料管线（scripts/）

把 7 本哈利波特 PDF 抽取成干净的「书 → 章 → 段 → 句」语料，供「逐句译」后端/前端直接消费。
只依赖 **PyMuPDF**（`pymupdf`），不修改源 PDF，不引入其它依赖。

```
scripts/
├─ build_corpus.py   # 主程序：PDF → data/corpus
├─ test_corpus.py    # 单元测试（python scripts/test_corpus.py）
└─ README.md         # 本文件
```

## 快速开始

在项目根目录（`D:\Blog\spark\translate_study`）执行：

```bash
# 生成全部 7 本 + 跑语料验收检查（失败退出码 1）
python scripts/build_corpus.py --selfcheck

# 只生成单本（manifest 会与已有书合并，其他书保留）
python scripts/build_corpus.py --book hp1 --selfcheck

# 不读 PDF，只校验已有 data/corpus（适合 CI / QA 复核）
python scripts/build_corpus.py --check-only --selfcheck

# 单元测试（英语句子切分 / 连字符 / 段落重建 / 契约校验，55 个用例）
python scripts/test_corpus.py
```

可选参数：`--source-dir`（PDF 源目录，默认按契约固定路径）、`--corpus-dir`（输出目录，默认 `data/corpus`）、`--diagnostics`（打印每章版式/标题识别诊断）。

## 产物

```
data/corpus/
├─ manifest.json                 # 书目录（契约 §3.3）
├─ quality-report.json           # 验收报告：checks / warnings / books / samples
├─ hp1/chapter-001.json … chapter-017.json
├─ hp2/…  hp7/chapter-037.json   # 共 199 个章节文件
```

- 全部 UTF-8（无 BOM），JSON `ensure_ascii=False` + 2 空格缩进。
- `manifest.json` 的 `wordCount/paragraphCount/sentenceCount` 与章节文件一致；`file` 使用正斜杠。
- `quality-report.json`：`checks` 为逐项 PASS/FAIL；`warnings` 为 >120 词原文长句清单；`books` 为每本统计；`samples` 为每章首/末段 + 每本 5 条随机句，供人工抽检。
- 幂等：内容未变化时不重写文件；manifest 的 `generatedAt` 在内容一致时保持不变，可重复运行。

## 抽取流程

1. **页面行抽取**：`page.get_text("dict")` → span 级信息；把基线相近（±3pt）的碎行合并成“视觉行”，按 x 排序拼接 span。缺失空格的粗粒度修正：数字+小写字母补空格（`382`+`b.c.`），序数后缀（`31st`）除外。
2. **版式过滤**：全部 span ≥24pt 视为结构性文字（26pt 页眉章节名、36pt 章标题、32pt 分隔页标题）；`max size ≥50pt` 为 drop cap；Wingdings 装饰（`\x91`）、页码行、`* * *` 分隔线全部剔除。正文为 13pt（报纸/信件/广告有 7–23pt 的正文字号，保留）。
3. **页面/章节范围**：从第一个章首页（`C H A P T E R  X` 26pt 逐字母排版，或 HP7 `E P I L O G U E`）开始；最后一章向前跳过空白页/版权页（10–11.5pt 小字），避免混入 back matter；front matter（封面/版权/目录）全部跳过。
4. **章节识别**：`C H A P T E R` 标签 → 编号（`T W E N T Y - O N E` → `TWENTY-ONE`）；同页 36pt 行拼接为标题并转 Title Case（`THE BOY WHO LIVED` → `The Boy Who Lived`）；HP7 追加 `index:37, number:"EPILOGUE", title:"Nineteen Years Later"`。
5. **版式参数**：按章估计左边距 M（取“出现足够频繁的最左 x0”，避免把缩进行/特殊块误当左边距）、段首缩进 I、行距 pitch、正文右边界；个别章节 PDF 内容整体平移约 3pt（如 HP1 第 2 章），按章估计可正确处理。
6. **段落重建**：以「段首缩进 I / 正文续行 M」为主信号；`x0≈I` 开新段、`x0≈M` 续段；drop cap 首段特殊处理（首字母 + 下一行拼接，直到出现正常缩进行）；跨页时新页首行回到 M 视为同段续接；行尾 `-` 一律与下一行做连字符合并；信件/报纸/广告等特殊块用「块左边距 B + 块内缩进」两层状态处理，避免按行拆碎；间距大于 1.8 倍行距视为新段落/新块。最后对“版式造成的续段碎片”做保守合并（同栏位 + 版面连续 + 上段未以句末标点结束）。
7. **连字符合并**：行尾 `-` 时按上下文决定保留/去掉：
   - 下一行以大写开头 → 保留（`You-/Know-Who`、`Muggle-/born`）；
   - 语料中该复合词完整出现过 → 保留（`good-for-/nothing`）；
   - 拼接后是语料中真实单词 → 去掉（`Mug-/gles`、`Minis-/ter`）；
   - 两侧都是真实单词但拼接不是 → 保留（`theory-/centered`）。
8. **句子切分**：自实现英文切分器（`split_sentences`），处理 `Mr./Mrs./Dr./Prof./St.` 等缩写、`J./K.` 首字母、`J.K./U.S./e.g.` 带点缩写、小数、`. . .`/`…` 省略号、引号对话（“….” he said 不断句）、问号/感叹号后接引号、列表编号（`1.` 不断句）、破折号；句末收尾引号/括号归入前一句。

## 验收检查（--selfcheck / quality-report.json）

- 7 本齐全；章节数：hp1=17, hp2=18, hp3=22, hp4=37, hp5=38, hp6=30, hp7=37（36 + EPILOGUE）。
- 每本 wordCount 在官方量级 ±10%：77k/85k/107k/190k/257k/169k/198k。
- 平均句长 12–22 词；>120 词原文长句只记 warning（保留原句不硬切，见下）；>300 词才 FAIL。
- 无页眉页脚残留（`CHAPTER …`、纯页码）、无 `U+0091` 等控制字符、无双空格、句内无换行、无中文标点、无行尾断词残留。
- 引号配对：小说“跨段落连续发言”会每段行首重复开引号、仅最后一段闭合，原始 `“/”` 计数天然略不平衡；检查用状态机剔除合法续引号后统计真实残留，阈值 1.5%。
- 每章首句必须以大写字母/引号/破折号开头（drop cap 残留检查）；章节标题/编号格式检查；JSON UTF-8 无 BOM 与 schema 校验。
- HP7 最后一章必须为 `EPILOGUE / Nineteen Years Later`。
- 失败项退出码 1。

## 已知瑕疵 / 取舍（已写入 quality-report 的 notes / warnings）

1. **>120 词原文长句**（4 条）：HP1 魁地奇解说 199 词、HP2 复方汤剂变形 136 词、HP5 分院仪式 152 词、HP7 七个波特 138 词——这是原书真实的单句，按 Lead 决定保留原句完整、只记 warning，不硬切。
2. **HP7 第 16 章墓地双墓碑**：两列碑文按行合并（`JAMES POTTER LILY POTTER` / `BORN … BORN … DIED … DIED …`），内容完整但语序按视觉行，属装饰性排版。
3. **HP1 第 8 章首段开引号缺失**（`There, look.”`）：PDF 文本层缺字符，未改写原文。
4. **HP3 第 18 章标题**在 PDF 中印作 `MOONEY, …`（原书应为 `Moony`）：保留 PDF 原样。
5. 信件/表单/报纸等特殊块中的少量列表行会被拆成独立短段（如霍格沃茨录取通知书装备清单、课程目标列表），约占全部段落的 0.1%，不影响正文阅读。
6. 源 PDF 本身偶有字符级瑕疵（如 `git’’` 双撇号、个别错别字），只做版式级规范化（`\x91`→`—`、软连字符、空白压缩），不机翻、不改写正文。

## 输出结构（契约 §3.3 摘要）

`manifest.json`：

```json
{
  "version": 1,
  "generatedAt": "2026-11-19T09:51:28.216Z",
  "sourceDir": "D:\\书籍\\...\\哈利波特电子书",
  "books": [{
    "id": "hp1", "order": 1,
    "title": "Harry Potter and the Sorcerer's Stone",
    "titleZh": "哈利·波特与魔法石",
    "wordCount": 79197, "paragraphCount": 2954, "sentenceCount": 6372,
    "chapters": [{"index": 1, "number": "ONE", "title": "The Boy Who Lived",
                  "paragraphCount": 110, "sentenceCount": 346,
                  "file": "hp1/chapter-001.json"}]
  }]
}
```

`hp1/chapter-001.json`：

```json
{
  "bookId": "hp1",
  "chapterIndex": 1,
  "title": "The Boy Who Lived",
  "paragraphs": [
    {"index": 0, "sentences": [
      {"text": "Mr. and Mrs. Dursley, of number four, Privet Drive, were proud to say that they were perfectly normal, thank you very much.", "wordCount": 24}
    ]}
  ]
}
```

## 当前语料规模

| 书 | 章 | 段 | 句 | 词 | 平均句长 |
|---|---|---|---|---|---|
| hp1 | 17 | 2954 | 6372 | 79197 | 12.43 |
| hp2 | 18 | 3175 | 6714 | 87434 | 13.02 |
| hp3 | 22 | 4168 | 9033 | 111327 | 12.32 |
| hp4 | 37 | 6080 | 14016 | 197956 | 14.12 |
| hp5 | 38 | 8856 | 17655 | 266210 | 15.08 |
| hp6 | 30 | 5718 | 11862 | 174544 | 14.71 |
| hp7 | 37 | 6901 | 14552 | 202296 | 13.90 |
| **合计** | **199** | **37852** | **80204** | **1,118,964** | — |

（数值以 `quality-report.json` 为准；单次全量构建约 30–50 秒。）
