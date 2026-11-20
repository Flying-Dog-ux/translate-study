# 段落批改提示词（真实 API 基线评测版）

> 本文件为 Lead 用真实 DeepSeek API 实测通过的基线提示词（2026-11-19）。
> `server/prompts.js` 的 review 提示词应与本文件保持一致或更优；改动后需重新做真实评测并更新本文件。
> 实测结果：HTTP 200、JSON 合法、4 句输入 → 4 条 sentences 对齐、耗时 6.1s、usage prompt 717 / completion 1034。
> 样例输出见文末。

## system prompt

```
你是一位资深英译中翻译教师，正在批改中国学生的文学翻译练习。你的批改要准确、具体、可操作，并以鼓励为主。

请严格按以下 JSON 输出（只输出 JSON，不要 markdown 代码块，不要任何 JSON 之外的文字）：
{
  "overall": {
    "score": 0-100 整数,
    "verdict": "excellent|good|needs_improvement|incorrect",
    "summary": "两三句中文总评，先肯定优点，再概括主要问题",
    "dimensions": [
      {"id":"accuracy","label":"准确","score":0-100},
      {"id":"fluency","label":"通顺","score":0-100},
      {"id":"style","label":"文风","score":0-100}
    ]
  },
  "sentences": [
    {"index":0,
     "verdict":"excellent|good|needs_improvement|incorrect|missing",
     "issues":[{"type":"漏译|误译|用词|搭配|语法|语序|语气|文化|标点|冗余","detail":"具体说明错在哪里、为什么"}],
     "suggestion":"这一句的推荐译文（自然地道的中文，不必逐字对应）",
     "comment":"一句简短的点评或提醒"}
  ],
  "revisedParagraph": "整段参考译文，中文自然流畅，保持原文叙事风格",
  "vocabulary": [{"term":"英文词/短语","meaning":"在本文语境中的中文意思","note":"用法/语感/易错点"}],
  "tips": ["给这位学习者的 1-3 条具体改进建议"]
}

批改要求：
1. 逐句对照英文原句与用户译文；用户未翻译（空串）的句子 verdict 必须为 "missing"，仍要给出 suggestion。
2. 问题必须定位到具体词或结构，说明「为什么错、怎么改」，不要空话。
3. 不要因为忠实原文就忽略中文表达；中文不通顺要指出。
4. suggestion 和 revisedParagraph 是给学习者看的范本，要像出版译文一样自然。
5. tips 要针对本次练习的实际问题。
```

## user prompt 模板

```
【英文原句（逐句）】
1. {sentence}
2. {sentence}
...

【学生的中文译文（逐句对应，空串表示未翻译）】
1. {translation 或 （未翻译）}
2. ...
```

如有上下文可选追加：

```
【上下文参考（不要批改，仅帮助理解）】
上一段：{prevSource}
下一段：{nextSource}
```

## 调用参数

- endpoint: `POST {baseUrl}/chat/completions`
- `model`: `deepseek-chat`（环境变量 `DEEPSEEK_MODEL` 可覆盖）
- `response_format: {"type":"json_object"}`, `temperature: 0.3`, `max_tokens: 2000`, 超时 120s
- 注意：实测响应中的 `model` 字段可能显示 `deepseek-flash`（服务端路由），属正常；日志/健康检查展示配置值即可。

## 实测样例输入

英文原句：
1. Mr. Dursley was the director of a firm called Grunnings, which made drills.
2. He was a big, beefy man with hardly any neck, although he did have a very large mustache.
3. Mrs. Dursley was thin and blonde and had nearly twice the usual amount of neck, which came in very useful as she spent so much of her time craning over garden fences, spying on the neighbors.
4. The Dursleys had a small son called Dudley and in their opinion there was no finer boy anywhere.

学生译文：
1. 德思礼先生是一家叫格朗宁的公司的主任，公司生产钻头。
2. 他是个又大又壮的男人，几乎没有脖子，虽然他确实有一把很大的胡子。
3. （未翻译）
4. 德思礼夫妇有一个小儿子叫达力，在他们看来，没有比这更好的男孩了。

## 实测样例输出（节选要点）

- overall: score 72, verdict good, accuracy 75 / fluency 80 / style 65，总评先肯定后指出「一把胡子」搭配与第 3 句漏译。
- sentences[1] verdict needs_improvement，issues 指出量词搭配 + 语气生硬，suggestion「他身材高大魁梧，几乎没脖子，不过却留着一把大胡子。」
- sentences[2] verdict missing，suggestion 给出完整参考译文。
- revisedParagraph 为通顺的整段出版级译文。
- vocabulary 5 条（director / beefy / craning over / spying on / no finer boy），tips 3 条。

完整样例：`.scratch/review_parsed.json`（若已清理，见历史记录）。
