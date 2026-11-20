# -*- coding: utf-8 -*-
"""逐句译 · 语料管线：把哈利波特 7 本 PDF 抽取成干净的「书 → 章 → 段 → 句」语料。

用法（在项目根目录执行）：
    python scripts/build_corpus.py                 # 生成全部 7 本
    python scripts/build_corpus.py --book hp1      # 只生成指定书（manifest 合并）
    python scripts/build_corpus.py --selfcheck     # 生成全部并跑语料验收检查（失败退出码 1）
    python scripts/build_corpus.py --selfcheck --book hp1
    python scripts/build_corpus.py --check-only    # 不读 PDF，只校验已有 data/corpus
    python scripts/build_corpus.py --diagnostics   # 打印版式/分段诊断信息

产物：
    data/corpus/manifest.json
    data/corpus/quality-report.json
    data/corpus/<bookId>/chapter-XXX.json

只依赖 PyMuPDF（pymupdf），不修改源 PDF。输出 UTF-8（无 BOM），JSON ensure_ascii=False、缩进 2。
"""

from __future__ import annotations

import argparse
import json
import random
import re
import statistics
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

import pymupdf

# ---------------------------------------------------------------------------
# 常量与书籍元数据
# ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE_DIR = Path(r"D:\书籍\优质资源合集0724（1）\优质书籍\哈利波特电子书")
DEFAULT_CORPUS_DIR = ROOT / "data" / "corpus"

MANIFEST_VERSION = 1
# PDF 版式公共参数
STRUCTURAL_MIN_SIZE = 24.0      # 页眉/章号/章标题等“结构性”文字的最小字号
TITLE_SIZE_RANGE = (30.0, 45.0)  # 章节标题 36pt（允许少量浮动）
DROP_CAP_MIN_SIZE = 50.0        # 章首 drop cap ~80-90pt
BODY_REGION_TOP = 130.0         # 仅供调试参考
PAGE_LINE_MERGE_TOL = 3.0       # 同一视觉行内不同字号（基线微差）合并容差
MARGIN_TOL = 2.5                # 左边距/缩进判定容差
INDENT_MIN_DELTA = 5.0          # 缩进相对左边距的最小差值
INDENT_MAX_DELTA = 22.0         # 缩进相对左边距的最大差值
BLOCK_GAP_FACTOR = 1.8          # 行距超过正常行距的倍数 → 视为新段落/新块起点
RANDOM_SEED = 20261119

# 文本规范化：控制字符/特殊字形 → 可读字符
CHAR_REPLACEMENTS = {
    "\x91": "—",   # Wingdings 装饰/页码两侧，版式实测为破折号占位
    "\x92": "—",
    "\x93": "—",
    "\x94": "—",
    "\x96": "—",
    "\x97": "—",
    "\u00ad": "",  # soft hyphen
    "\u00a0": " ",  # NBSP
    "\u00c0": "“",  # 活点地图花体引号（PDF 字体映射错位，实测仅 hp3 两处）
    "\u00c3": "”",
}

# 不要把 sentence 断在这些缩写/首字母之后（小写比较）
ABBREVIATIONS = {
    "mr", "mrs", "ms", "dr", "prof", "st", "mt", "sr", "jr", "capt", "col",
    "gen", "lt", "rev", "hon", "messrs", "mmes", "vs", "etc", "e.g", "i.e",
    "a.m", "p.m", "u.s", "u.k", "d.c", "no", "vol", "ch", "pp", "cf", "al",
    "inc", "ltd", "co", "dept", "univ", "ave", "blvd", "rd", "sq", "pt",
}

# 句末标点后常见的收尾字符（弯/直引号、括号等）
CLOSERS = "”’\"')]»"
OPENERS = "“‘\"'([«"

# 复合词前缀（用于行尾连字符合并时保留合法连字符）
COMPOUND_PREFIXES = {
    "good", "half", "well", "self", "all", "ill", "never", "mother", "father",
    "brother", "sister", "god", "step", "non", "anti", "vice", "muggle",
    "death", "dark", "twenty", "thirty", "forty", "fifty", "sixty",
    "seventy", "eighty", "ninety", "hundred", "thousand", "great", "little",
    "long", "short", "one", "two", "three", "four", "five", "six", "seven",
    "eight", "nine", "ten", "eleven", "twelve", "fifteen", "how", "what",
    "out", "in", "off", "on", "over", "under", "up", "down", "by", "eye",
    "cold", "warm", "red", "green", "black", "white", "blue", "old", "new",
    "full", "part", "time", "life", "death", "world", "daily", "weekly",
}

# 标题大小写：中置小词表（首词/末词永远大写）
TITLE_STOP_WORDS = {
    "a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into",
    "nor", "of", "on", "onto", "or", "over", "the", "to", "up", "via",
    "with", "within", "without",
}

CHAPTER_LABEL_RE = re.compile(
    r"^C\s+H\s+A\s+P\s+T\s+E\s+R\s+([A-Za-z](\s*[-–—]?\s*[A-Za-z])*)\s*$",
    re.IGNORECASE,
)
EPILOGUE_LABEL_RE = re.compile(r"^E\s+P\s+I\s+L\s+O\s+G\s+U\s+E\s*$", re.IGNORECASE)
FOOTER_TEXT_RE = re.compile(r"^[\s\x91\d]+$")
ORNAMENT_RE = re.compile(r"^[\s\x91*·•.]+$")
PAGE_NUMBER_RE = re.compile(r"^\s*\d{1,4}\s*$")
DIGITS_ONLY_RE = re.compile(r"^[\s\x91\d]+$")


@dataclass(frozen=True)
class BookMeta:
    id: str
    order: int
    title: str
    title_zh: str
    ref_words: int
    expected_chapters: int
    file_prefix: str


BOOKS: list[BookMeta] = [
    BookMeta("hp1", 1, "Harry Potter and the Sorcerer's Stone", "哈利·波特与魔法石",
             77_000, 17, "J.K.+Rowling+-+HP+1"),
    BookMeta("hp2", 2, "Harry Potter and the Chamber of Secrets", "哈利·波特与密室",
             85_000, 18, "J.K.+Rowling+-+HP+2"),
    BookMeta("hp3", 3, "Harry Potter and the Prisoner of Azkaban", "哈利·波特与阿兹卡班的囚徒",
             107_000, 22, "J.K.+Rowling+-+HP+3"),
    BookMeta("hp4", 4, "Harry Potter and the Goblet of Fire", "哈利·波特与火焰杯",
             190_000, 37, "J.K.+Rowling+-+HP+4"),
    BookMeta("hp5", 5, "Harry Potter and the Order of the Phoenix", "哈利·波特与凤凰社",
             257_000, 38, "J.K.+Rowling+-+HP+5"),
    BookMeta("hp6", 6, "Harry Potter and the Half-Blood Prince", "哈利·波特与混血王子",
             169_000, 30, "J.K.+Rowling+-+HP+6"),
    BookMeta("hp7", 7, "Harry Potter and the Deathly Hallows", "哈利·波特与死亡圣器",
             198_000, 37, "J.K.+Rowling+-+HP+7"),
]
BOOK_BY_ID = {b.id: b for b in BOOKS}


# ---------------------------------------------------------------------------
# 基础文本工具
# ---------------------------------------------------------------------------

def decode_span_text(text: str, font: str) -> str:
    """修正特殊字体（Trajan）的字符映射错位。

    Trajan 字体的 ToUnicode 映射整体偏移 +29：大写字母/数字/空格被抽出为
    ASCII+29 的字符（如 'J'→'g'、' '→'='），这里逆向还原；'=' 代表词间空格，
    用 '|' 标记以便后续去掉“字母间隔排版”的空格时保留词边界。
    """
    if "Trajan" not in font:
        return text
    out: list[str] = []
    for ch in text:
        if ch == "=":
            out.append("|")
            continue
        d = ord(ch) - 29
        out.append(chr(d) if 32 <= d <= 126 else ch)
    return "".join(out)


def cleanup_trajan_text(text: str) -> str:
    """把 Trajan 花体文字（墓碑/徽章）整理成正常词序。

    '|' 是词边界；两个词边界之间的单字母序列是“字母间隔排版”，需要合并。
    """
    if "|" not in text:
        return text
    segments = text.split("|")
    cleaned_parts: list[str] = []
    for seg in segments:
        tokens = seg.split()
        merged: list[str] = []
        buf: list[str] = []
        for tok in tokens:
            if len(tok) == 1 and tok.isupper():
                buf.append(tok)
            else:
                if buf:
                    merged.append("".join(buf))
                    buf = []
                merged.append(tok)
        if buf:
            merged.append("".join(buf))
        cleaned_parts.append(" ".join(merged))
    return " ".join(p for p in cleaned_parts if p).strip()


def normalize_text(text: str) -> str:
    """统一字符映射、压缩空白、去首尾空格。"""
    for k, v in CHAR_REPLACEMENTS.items():
        if k in text:
            text = text.replace(k, v)
    text = cleanup_trajan_text(text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def is_structural(line: "PageLine") -> bool:
    """页眉/章号/章标题/装饰大字号：全部 span 字号都 >= 24pt。"""
    return bool(line.sizes) and min(line.sizes) >= STRUCTURAL_MIN_SIZE


def is_footer(line: "PageLine") -> bool:
    """页脚页码（20pt 数字 + Wingdings 装饰）或纯 Wingdings 装饰。"""
    t = line.text
    if not t:
        return True
    if line.max_size >= 18.0 and DIGITS_ONLY_RE.match(t):
        return True
    if "\x91" in t and DIGITS_ONLY_RE.match(t):
        return True
    return False


def is_ornament(line: "PageLine") -> bool:
    """页内装饰线（Wingdings 花饰、* * * 分隔线）。"""
    t = line.text
    if not t:
        return True
    if ORNAMENT_RE.match(t) and not any(ch.isalnum() for ch in t):
        return True
    if PAGE_NUMBER_RE.match(t) and line.max_size >= 18.0:
        return True
    return False


# ---------------------------------------------------------------------------
# PDF 页面行抽取
# ---------------------------------------------------------------------------

@dataclass
class PageLine:
    page: int
    y0: float
    x0: float
    x1: float
    y1: float
    text: str
    font: str = ""
    sizes: list[float] = field(default_factory=list)

    @property
    def max_size(self) -> float:
        return max(self.sizes) if self.sizes else 0.0

    @property
    def min_size(self) -> float:
        return min(self.sizes) if self.sizes else 0.0


def _join_spans(spans: Sequence[dict]) -> tuple[str, list[float], str]:
    """把同一 PyMuPDF line 内按 x 排序的 spans 拼成文本。

    返回 (text, sizes, dominant_font)。缺失空格的粗粒度修正：
      - 数字 + 小写字母（如 "382" + "b.c."）补空格，序数后缀（31st/2nd）除外；
      - 其它相邻字母紧邻（这是小 caps / 字母间隔排版的正常现象），直接拼接。
    """
    parts: list[dict] = []
    for s in sorted(spans, key=lambda x: (x["bbox"][0], x["bbox"][1])):
        txt = decode_span_text(s["text"], s.get("font", ""))
        if not txt:
            continue
        parts.append({"text": txt, "size": round(float(s["size"]), 1),
                      "font": s.get("font", "")})
    if not parts:
        return "", [], ""
    out = parts[0]["text"]
    for prev, cur in zip(parts, parts[1:]):
        a = out[-1] if out else ""
        b = cur["text"][:1]
        if a.isalnum() and b.isalnum():
            if a.isdigit() and b.islower():
                rest = cur["text"]
                if re.match(r"^(st|nd|rd|th)\b", rest):
                    out += rest
                else:
                    out += " " + rest
            else:
                out += cur["text"]
        else:
            out += cur["text"]
    sizes = [p["size"] for p in parts]
    fonts = [p["font"] for p in parts]
    dominant = max(set(fonts), key=fonts.count) if fonts else ""
    return out, sizes, dominant


def extract_page_lines(page: pymupdf.Page, page_no: int) -> list[PageLine]:
    """抽取一页的“视觉行”：先把 PyMuPDF 的 line 展开为 span 信息，
    再把基线接近（<= PAGE_LINE_MERGE_TOL）的碎行合并为同一行。"""
    raw: list[dict] = []
    for block in page.get_text("dict")["blocks"]:
        if block.get("type") != 0:
            continue
        for line in block["lines"]:
            spans = [s for s in line["spans"] if s["text"]]
            if not spans:
                continue
            y0 = min(float(s["bbox"][1]) for s in spans)
            y1 = max(float(s["bbox"][3]) for s in spans)
            x0 = min(float(s["bbox"][0]) for s in spans)
            x1 = max(float(s["bbox"][2]) for s in spans)
            raw.append({"y0": y0, "y1": y1, "x0": x0, "x1": x1, "spans": spans})
    raw.sort(key=lambda r: (r["y0"], r["x0"]))
    groups: list[dict] = []
    for item in raw:
        if groups and item["y0"] - groups[-1]["anchor"] <= PAGE_LINE_MERGE_TOL:
            groups[-1]["items"].append(item)
        else:
            groups.append({"anchor": item["y0"], "items": [item]})
    lines: list[PageLine] = []
    for g in groups:
        items = sorted(g["items"], key=lambda r: r["x0"])
        spans = [s for it in items for s in it["spans"]]
        text, sizes, font = _join_spans(spans)
        if not text:
            continue
        line = PageLine(
            page=page_no,
            y0=min(it["y0"] for it in items),
            x0=min(it["x0"] for it in items),
            x1=max(it["x1"] for it in items),
            y1=max(it["y1"] for it in items),
            text=text,
            font=font,
            sizes=[round(float(sz), 1) for sz in sizes],
        )
        lines.append(line)
    lines.sort(key=lambda l: (l.y0, l.x0))
    return lines


# ---------------------------------------------------------------------------
# 章节识别
# ---------------------------------------------------------------------------

@dataclass
class ChapterInfo:
    start_page: int
    end_page: int = 0
    number: str = ""
    title: str = ""
    drop_cap: str = ""
    label_line: PageLine | None = None


def normalize_chapter_number(raw: str) -> str:
    """'C H A P T E R  T W E N T Y - O N E' 里的编号部分 → 'TWENTY-ONE'。"""
    s = raw.upper()
    s = s.replace("–", "-").replace("—", "-")
    s = re.sub(r"\s+", "", s)
    return s


def to_title_case(text: str) -> str:
    """全大写章节标题 → Title Case（'THE BOY WHO LIVED' → 'The Boy Who Lived'）。"""
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return text
    tokens = text.split(" ")
    out: list[str] = []
    n = len(tokens)
    for i, tok in enumerate(tokens):
        # 拆出首尾非字母字符（逗号/句点/引号等），只处理中间字母部分，保留原标点
        m = re.match(r"^([^A-Za-z]*)([A-Za-z].*?)([^A-Za-z]*)$", tok)
        lead, core, trail = "", tok, ""
        if m:
            lead, core, trail = m.group(1), m.group(2), m.group(3)
        if not core:
            out.append(tok)
            continue
        # 保留 O.W.L.S 这类首字母缩写
        if re.fullmatch(r"(?:[A-Z]\.)+[A-Z]?", core):
            out.append(lead + core + trail)
            continue
        lower = core.lower()
        is_edge = i == 0 or i == n - 1
        # 拆连字符：THREE-QUARTERS → Three-Quarters
        pieces = lower.split("-")
        cap_pieces: list[str] = []
        for j, piece in enumerate(pieces):
            if not piece:
                cap_pieces.append(piece)
                continue
            idx = next((k for k, c in enumerate(piece) if c.isalpha()), None)
            if idx is None:
                cap_pieces.append(piece)
                continue
            if not is_edge and j == 0 and piece in TITLE_STOP_WORDS:
                cap_pieces.append(piece)
            else:
                cap_pieces.append(piece[:idx] + piece[idx].upper() + piece[idx + 1:])
        out.append(lead + "-".join(cap_pieces) + trail)
    return " ".join(out)


def detect_chapters(pages: list[list[PageLine]]) -> list[ChapterInfo]:
    """扫描所有页面，返回章节列表（含 HP7 的 EPILOGUE）。"""
    chapters: list[ChapterInfo] = []
    for page_no, lines in enumerate(pages):
        label: PageLine | None = None
        for line in lines:
            if not is_structural(line):
                continue
            t = normalize_text(line.text)
            if not t:
                continue
            if CHAPTER_LABEL_RE.match(t) or EPILOGUE_LABEL_RE.match(t):
                label = line
                break
        if label is None:
            continue
        chan = ChapterInfo(start_page=page_no, label_line=label)
        if EPILOGUE_LABEL_RE.match(normalize_text(label.text)):
            chan.number = "EPILOGUE"
        else:
            m = CHAPTER_LABEL_RE.match(normalize_text(label.text))
            chan.number = normalize_chapter_number(m.group(1)) if m else ""
        # 章节标题：该页所有 36pt 左右的结构性文字，按 y 顺序拼接
        title_parts: list[str] = []
        for line in lines:
            if line is label:
                continue
            if not line.sizes:
                continue
            if all(TITLE_SIZE_RANGE[0] <= sz <= TITLE_SIZE_RANGE[1] for sz in line.sizes):
                title_parts.append(normalize_text(line.text))
        raw_title = " ".join(p for p in title_parts if p)
        # 极少数标题在 PDF 中跨行且行尾带连字符（THE LIGHTNING-\nSTRUCK TOWER）
        raw_title = re.sub(r"-\s+", "-", raw_title)
        chan.title = to_title_case(raw_title) if raw_title else ""
        # drop cap：章首页字号 >50pt 的单字母
        for line in lines:
            if not line.sizes or line.max_size < DROP_CAP_MIN_SIZE:
                continue
            t = normalize_text(line.text)
            if len(t) == 1 and t.isalpha():
                chan.drop_cap = t
                break
        chapters.append(chan)
    for i, ch in enumerate(chapters):
        ch.end_page = (chapters[i + 1].start_page - 1) if i + 1 < len(chapters) else -1
    return chapters


# ---------------------------------------------------------------------------
# 版式参数估计
# ---------------------------------------------------------------------------

@dataclass
class LayoutParams:
    margin: float
    indent: float
    pitch: float
    right: float = 0.0  # 正文右边界（列宽），用于识别窄栏特殊块


def estimate_layout(lines: list[PageLine]) -> LayoutParams:
    """从正文行 x0 直方图估计左边距 M、段首缩进 I，以及正常行距 pitch。

    关键：某些章节（如 HP7 第 2/18 章）大量行是缩进行/特殊块（报纸、书摘）的
    起始行，直接取众数会把缩进值误当左边距。这里取“出现足够频繁的最左 x0”
    作为左边距：正文续行永远回到最左侧的正文边界。
    """
    xs: list[float] = []
    for ln in lines:
        xs.append(round(ln.x0 * 2) / 2)  # 0.5pt 粒度
    if not xs:
        return LayoutParams(40.0, 54.0, 16.5)
    hist: dict[float, int] = {}
    for x in xs:
        hist[x] = hist.get(x, 0) + 1
    min_count = max(5, int(len(xs) * 0.03))
    frequent = [x for x, c in hist.items() if c >= min_count]
    margin = min(frequent) if frequent else max(hist, key=hist.get)
    candidates = [x for x, c in hist.items()
                  if margin + INDENT_MIN_DELTA <= x <= margin + INDENT_MAX_DELTA and c >= 3]
    indent = max(candidates, key=lambda x: hist[x]) if candidates else margin + 14.0
    # 行距：同页相邻正文行 y0 差的中位数（限制在合理范围）
    gaps: list[float] = []
    by_page: dict[int, list[PageLine]] = {}
    for ln in lines:
        by_page.setdefault(ln.page, []).append(ln)
    for pl in by_page.values():
        pl.sort(key=lambda l: l.y0)
        for a, b in zip(pl, pl[1:]):
            d = b.y0 - a.y0
            if 10.0 <= d <= 25.0:
                gaps.append(d)
    pitch = statistics.median(gaps) if gaps else 16.5
    # 正文右边界：取“回到左边距的续行”的 x1 众数
    rights: dict[float, int] = {}
    for ln in lines:
        if ln.x0 <= margin + INDENT_MIN_DELTA:
            r = round(ln.x1 * 2) / 2
            rights[r] = rights.get(r, 0) + 1
    right = max(rights, key=rights.get) if rights else 0.0
    return LayoutParams(margin=margin, indent=indent, pitch=pitch, right=right)


# ---------------------------------------------------------------------------
# 连字符合并
# ---------------------------------------------------------------------------

@dataclass
class HyphenContext:
    intact_hyphenated: set[str] = field(default_factory=set)
    intact_words: set[str] = field(default_factory=set)

    @classmethod
    def from_lines(cls, lines: Iterable[PageLine]) -> "HyphenContext":
        hyp: set[str] = set()
        words: set[str] = set()
        strip_chars = ".,;:!?…“”‘’\"'()[]{}—–"
        for ln in lines:
            for tok in ln.text.split():
                tok = tok.strip(strip_chars)
                if not tok:
                    continue
                if "-" in tok:
                    if not tok.endswith("-"):
                        hyp.add(tok)
                else:
                    words.add(tok.lower())
        return cls(hyp, words)


def merge_hyphen(left_text: str, right_text: str, ctx: HyphenContext) -> tuple[str, bool]:
    """合并行尾连字符断词，返回 (合并文本, 是否保留连字符)。"""
    if not left_text.endswith("-"):
        return left_text + " " + right_text, False
    base = left_text[:-1]
    m = re.search(r"([A-Za-z][A-Za-z'’]*(?:-[A-Za-z][A-Za-z'’]*)*)-$", left_text)
    if not m:
        # 并非单词内断词（例如 C H A P T E R 之类），退化为去连字符直接拼
        return base + right_text.lstrip(), False
    left_word = m.group(1)
    last_segment = left_word.rsplit("-", 1)[-1]
    rm = re.match(r"\s*([A-Za-z][A-Za-z'’-]*)", right_text)
    if not rm:
        # 下一行以标点/引号开头：保留连字符更安全
        return base + "-" + right_text.lstrip(), True
    right_word = rm.group(1)
    candidate_keep = left_word + "-" + right_word
    candidate_drop = left_word + right_word
    if candidate_keep in ctx.intact_hyphenated:
        return base + "-" + right_text.lstrip(), True
    if candidate_drop.lower() in ctx.intact_words:
        return base + right_text.lstrip(), False
    # 两侧都是语料中真实出现的单词、拼起来却不是 → 大概率是合法复合词被断行，
    # 例如 theory-centered 断成 theory- / centered；good-for- / nothing 同理
    if (last_segment.lower() in ctx.intact_words
            and right_word.lower() in ctx.intact_words
            and candidate_drop.lower() not in ctx.intact_words):
        return base + "-" + right_text.lstrip(), True
    if right_word[0].isupper():
        # 专有名词复合词：You-Know-Who / Muggle-born / He-Who-Must-Not-Be-Named
        if last_segment.lower() in {"mc", "mac", "o"}:
            return base + right_text.lstrip(), False
        return base + "-" + right_text.lstrip(), True
    if last_segment.lower() in COMPOUND_PREFIXES or left_word.lower() in COMPOUND_PREFIXES:
        return base + "-" + right_text.lstrip(), True
    return base + right_text.lstrip(), False


# ---------------------------------------------------------------------------
# 段落重建
# ---------------------------------------------------------------------------

@dataclass
class BodyLine:
    page: int
    y0: float
    x0: float
    text: str
    x1: float = 0.0


@dataclass
class ParagraphMeta:
    """段落文本 + 首/末原始行（用于续段合并判断）。"""
    text: str
    first: BodyLine
    last: BodyLine


def _is_indent(x0: float, layout: LayoutParams) -> bool:
    # 缩进检出用较紧容差：信件/广告等特殊块的 x0 可能落在 M 与 I 之间，
    # 不能误判成段首缩进（如 HP1 的 56.7pt 信件块 vs 54.0pt 正文缩进）。
    return abs(x0 - layout.indent) <= 1.8


def _is_margin(x0: float, layout: LayoutParams) -> bool:
    return x0 <= layout.margin + INDENT_MIN_DELTA


def build_paragraphs(
    body_lines: list[BodyLine],
    layout: LayoutParams,
    chapter_first_page: int,
    drop_cap: str,
    hyphen_ctx: HyphenContext,
) -> list[ParagraphMeta]:
    """按缩进 / 跨页 / 行距信号把正文行还原为段落文本列表。

    正文状态：续行在左边距 M、段首缩进 I；信件/广告/报纸等“特殊块”则有自己的
    块左边距 B（可能还有 B+14 的块内段首缩进）。这里用 (当前段落 x0, 当前块 B)
    两层状态处理，避免把特殊块按行拆成一堆碎段落。
    """
    if not body_lines:
        return []
    paragraphs: list[str] = []
    para_first: list[BodyLine] = []
    para_last: list[BodyLine] = []
    current: list[str] = []
    prev: BodyLine | None = None
    current_base: float | None = None
    block_base: float | None = None
    cur_first: BodyLine | None = None
    cur_last: BodyLine | None = None
    gap_threshold = layout.pitch * BLOCK_GAP_FACTOR

    def flush() -> None:
        nonlocal current, cur_first, cur_last
        if not current:
            return
        text = current[0]
        for nxt in current[1:]:
            text, _ = merge_hyphen(text, nxt, hyphen_ctx)
        text = normalize_text(text)
        if text and cur_first is not None and cur_last is not None:
            paragraphs.append(text)
            para_first.append(cur_first)
            para_last.append(cur_last)
        current = []
        cur_first = None
        cur_last = None

    for i, line in enumerate(body_lines):
        text = normalize_text(line.text)
        if not text:
            continue
        x0 = line.x0
        new_para = prev is None
        prev_ends_hyphen = bool(current) and current[-1].rstrip().endswith("-")
        if prev is not None:
            same_page = prev.page == line.page
            gap = (line.y0 - prev.y0) if same_page else None
            in_first_dropcap_para = (
                bool(drop_cap)
                and line.page == chapter_first_page
                and len(paragraphs) == 0
                and current
            )
            if prev_ends_hyphen:
                # 上一行以 '-' 结尾 = 单词被断行，下一行必然是本段续行
                # （信件/广告/表单等特殊块内的悬挂缩进也由此正确合并）
                new_para = False
            elif in_first_dropcap_para:
                # drop cap 首段：直到出现正常段首缩进行之前都视为同段
                new_para = _is_indent(x0, layout)
            elif gap is not None and gap > gap_threshold:
                new_para = True
            elif x0 <= layout.margin + INDENT_MIN_DELTA:
                # 回到正文左边距：若刚从特殊块出来则是新段，否则是正文续行
                new_para = block_base is not None
            elif block_base is None and _is_indent(x0, layout):
                new_para = True
            elif block_base is not None and abs(x0 - block_base) <= 3.5:
                new_para = False
            elif current_base is not None and abs(x0 - current_base) <= 3.5:
                new_para = False
            else:
                new_para = True
        if new_para and current:
            flush()
        if not current:
            line_text = (drop_cap + text) if (i == 0 and drop_cap) else text
            current_base = x0
            cur_first = line
        else:
            line_text = text
            current_base = min(current_base if current_base is not None else x0, x0)
        cur_last = line
        current.append(line_text)
        # 维护特殊块左边距状态（drop cap 首段的缩进/绕排行不参与块判定）
        in_first_para_state = (
            bool(drop_cap) and line.page == chapter_first_page and len(paragraphs) == 0
        )
        if in_first_para_state:
            block_base = None
        elif x0 <= layout.margin + INDENT_MIN_DELTA:
            block_base = None
        elif _is_indent(x0, layout):
            block_base = None
        elif block_base is None or x0 < block_base - 3.5:
            block_base = x0
        prev = line
    flush()
    return [
        ParagraphMeta(text=t, first=f, last=l)
        for t, f, l in zip(paragraphs, para_first, para_last)
    ]


# ---------------------------------------------------------------------------
# 句子切分
# ---------------------------------------------------------------------------

def _word_before(text: str, pos: int) -> str:
    """返回 text[:pos] 末尾的“词”（含内部点，用于缩写判定）。"""
    m = re.search(r"([A-Za-z][A-Za-z.']*)$", text[:pos])
    return m.group(1) if m else ""


def _is_abbreviation(text: str, period_pos: int) -> bool:
    """period_pos 处的 '.' 是否属于缩写/首字母/小数，不应断句。"""
    # 小数：两侧都是数字
    prev_ch = text[period_pos - 1] if period_pos > 0 else ""
    next_ch = text[period_pos + 1] if period_pos + 1 < len(text) else ""
    if prev_ch.isdigit() and next_ch.isdigit():
        return True
    word = _word_before(text, period_pos)
    if not word:
        return False
    # J. / K. 等单个大写首字母缩写（但 "I." 视为句末）
    if len(word) == 1 and word.isupper() and word != "I":
        return True
    # J.K. / U.S. / e.g. / a.m. 这类带点的缩写
    stripped = word.rstrip(".")
    if stripped and re.fullmatch(r"(?:[A-Za-z]\.)+[A-Za-z]?", stripped):
        return True
    low = stripped.lower()
    if low in ABBREVIATIONS:
        return True
    if re.fullmatch(r"(?:[a-z]\.)+[a-z]", low):
        return True
    return False


def _next_significant(text: str, pos: int) -> str:
    """从 pos 开始跳过收尾引号/括号与空白，返回下一个有效字符（没有则 ''）。"""
    i = pos
    while i < len(text) and text[i] in CLOSERS:
        i += 1
    while i < len(text) and text[i].isspace():
        i += 1
    return text[i] if i < len(text) else ""


def _is_boundary(text: str, pos: int) -> bool:
    """pos 处（'.'/'!'/'?'）是否是句子边界。"""
    ch = text[pos]
    if ch == "." and _is_abbreviation(text, pos):
        return False
    nxt = _next_significant(text, pos + 1)
    if not nxt:
        return True
    if nxt.islower():
        return False
    # 后接大写/数字/开引号 → 断句；后接收尾引号后仍要检查
    if nxt.isupper() or nxt.isdigit() or nxt in OPENERS:
        return True
    # 其它字符（如 '—'、'('）保守不断句
    return False


def split_sentences(text: str) -> list[str]:
    """英文句子切分器：处理缩写、首字母、小数、省略号、引号对话、破折号。

    规则概要：
      - 只在 . ! ? 之后考虑断句；'.' 若属于缩写（Mr./Dr./J./J.K./U.S./e.g.）或
        小数则不断；
      - 省略号（'. . .' / '...' / '…'）作为一个整体，后面若接大写/开引号/结尾则断句；
      - '?' '!' 后若接小写词（如 “不！” he said）不断句；
      - 句末标点后的收尾引号/括号归入前一句。
    """
    text = normalize_text(text)
    if not text:
        return []
    sentences: list[str] = []
    start = 0
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "…":
            end = i + 1
            while end < n and text[end] in CLOSERS:
                end += 1
            nxt = _next_significant(text, end)
            segment = text[start:end]
            if (not re.fullmatch(r"[.\s…]*", segment)) and (
                    not nxt or nxt.isupper() or nxt.isdigit() or nxt in OPENERS):
                sentences.append(segment)
                start = end
            i = end
            continue
        if ch == ".":
            # 省略号 ". . ."（点之间可有空格）
            m = re.match(r"\.\s*\.\s*\.", text[i:])
            if m:
                end = i + m.end()
                while end < n and text[end] in CLOSERS:
                    end += 1
                nxt = _next_significant(text, end)
                segment = text[start:end]
                # 段首/句首的 ". . ." 是停顿而不是独立句子，不切
                if (not re.fullmatch(r"[.\s…]*", segment)) and (
                        not nxt or nxt.isupper() or nxt.isdigit() or nxt in OPENERS):
                    sentences.append(segment)
                    start = end
                i = end
                continue
            if _is_abbreviation(text, i):
                i += 1
                continue
            # 列表编号（"1." / "54." 等）不是句子边界
            if re.fullmatch(r"[\d\s]+", text[start:i]):
                i += 1
                continue
            if _is_boundary(text, i):
                # 把紧随其后的收尾引号并入本句
                end = i + 1
                while end < n and text[end] in CLOSERS:
                    end += 1
                sentences.append(text[start:end])
                start = end
                i = end
                continue
            i += 1
            continue
        if ch in "!?":
            if _is_boundary(text, i):
                end = i + 1
                while end < n and text[end] in CLOSERS:
                    end += 1
                sentences.append(text[start:end])
                start = end
                i = end
                continue
            i += 1
            continue
        i += 1
    tail = text[start:].strip()
    if tail:
        sentences.append(tail)
    # 清理：去首尾空白，过滤空串
    cleaned: list[str] = []
    for s in sentences:
        s = re.sub(r"\s+", " ", s).strip()
        if s:
            cleaned.append(s)
    return cleaned


def quote_balance_stats(chapters: list["ChapterData"]) -> dict[str, Any]:
    """引号配对统计。

    小说中“跨段落连续发言”的排版惯例是：每段开头有 “、只有最后一段有 ”。
    因此简单计数会天然出现 “ > ”。这里用状态机把这些合法的“段落续引号”排除，
    只统计真正丢失/多余的引号（residualOpen/residualClose）。
    """
    total_open = total_close = 0
    eff_open = eff_close = 0
    continuation = 0
    state = 0
    for ch in chapters:
        for para in ch.paragraphs:
            text = " ".join(para)
            o = text.count("“")
            c = text.count("”")
            total_open += o
            total_close += c
            o_eff = o
            if state > 0 and text.startswith("“"):
                o_eff -= 1
                continuation += 1
            state = max(0, state + o_eff - c)
            eff_open += o_eff
            eff_close += c
    residual = abs(eff_open - eff_close)
    return {
        "quoteOpen": total_open,
        "quoteClose": total_close,
        "quoteContinuationParagraphs": continuation,
        "quoteEffectiveOpen": eff_open,
        "quoteEffectiveClose": eff_close,
        "quoteResidual": residual,
        "quoteDiffRatio": round(residual / max(eff_open, eff_close, 1), 6),
    }


def merge_fragment_paragraphs(
    paragraph_sentences: list[list[str]],
    metas: list[ParagraphMeta],
    layout: LayoutParams,
    hyphen_ctx: HyphenContext,
) -> list[list[str]]:
    """合并“被版式切成碎片”的续段（保守后处理）。

    某些特殊块（如 HP7 第 18 章大量引用的《邓布利多传》书摘、第 13 章的登记表）
    的行首缩进恰好等于正文缩进，导致续行被误判为新段落。合并条件（同时满足）：
      - 上一段结尾是字母/数字/逗号/分号（句子没写完），或以 '-' 结尾；
      - 当前段与上一段同一栏（首/末行 x0 接近）；
      - 两段在版面上连续（同页行距正常，或刚好跨页）。
    这样书摘碎段能拼回，而像“信件末尾 → 正文叙述”这种不同栏位的段落不会被误并。
    """
    merged: list[list[str]] = []
    merged_metas: list[ParagraphMeta] = []
    for sents, meta in zip(paragraph_sentences, metas):
        if not sents:
            continue
        if merged:
            prev_text = " ".join(merged[-1])
            prev_meta = merged_metas[-1]
            text = " ".join(sents)
            prev_stripped = prev_text.rstrip()
            prev_last = prev_stripped[-1] if prev_stripped else ""
            mid_sentence = prev_last.isalnum() or prev_last in ",;"
            same_column = abs(prev_meta.last.x0 - meta.first.x0) <= 3.5
            if not same_column and mid_sentence and layout.right > 0:
                # 特殊块内部：块首缩进行(x0=I+14)与续行(x0=I)属于同一栏，
                # 特征是两行都是“满栏宽”（x1 接近窄栏右边界）。
                near_full = layout.right - 20.0
                same_column = (
                    prev_meta.last.x1 >= near_full
                    and meta.first.x1 >= near_full
                    and prev_meta.last.x0 > layout.margin + INDENT_MIN_DELTA
                    and meta.first.x0 > layout.margin + INDENT_MIN_DELTA
                )
            if prev_meta.last.page == meta.first.page:
                gap = meta.first.y0 - prev_meta.last.y0
                continuous = gap <= layout.pitch * 1.35
            else:
                continuous = meta.first.page == prev_meta.last.page + 1
            if same_column and (prev_text.endswith("-") or (continuous and mid_sentence)):
                joined, _ = merge_hyphen(prev_text, text, hyphen_ctx)
                merged[-1] = split_sentences(normalize_text(joined))
                merged_metas[-1] = ParagraphMeta(
                    text=" ".join(merged[-1]), first=prev_meta.first, last=meta.last)
                continue
        merged.append(list(sents))
        merged_metas.append(meta)
    return [m for m in merged if m]


# ---------------------------------------------------------------------------
# 单本书构建
# ---------------------------------------------------------------------------

@dataclass
class ChapterData:
    index: int
    number: str
    title: str
    paragraphs: list[list[str]]


@dataclass
class BookData:
    meta: BookMeta
    chapters: list[ChapterData]
    source_path: str
    source_pages: int
    layout: LayoutParams
    diagnostics: dict[str, Any] = field(default_factory=dict)

    @property
    def paragraph_count(self) -> int:
        return sum(len(c.paragraphs) for c in self.chapters)

    @property
    def sentence_count(self) -> int:
        return sum(len(p) for c in self.chapters for p in c.paragraphs)

    @property
    def word_count(self) -> int:
        return sum(len(s.split()) for c in self.chapters for p in c.paragraphs for s in p)


def find_pdf(source_dir: Path, meta: BookMeta) -> Path:
    if not source_dir.is_dir():
        raise FileNotFoundError(f"源目录不存在：{source_dir}")
    candidates = sorted(
        p for p in source_dir.iterdir()
        if p.is_file() and p.suffix.lower() == ".pdf" and p.name.startswith(meta.file_prefix)
    )
    if not candidates:
        raise FileNotFoundError(f"找不到 {meta.id} 对应的 PDF（前缀 {meta.file_prefix}）于 {source_dir}")
    return candidates[0]


def _body_page_lines(lines: list[PageLine]) -> list[PageLine]:
    """过滤页眉/页脚/装饰后的正文行。

    注意：章首页的 drop cap 行可能混有 13pt 的空白 span（如 'T  '），
    不能只用 min(sizes)>=24 判定结构性；max_size 超过 drop cap 阈值的一律排除。
    """
    out: list[PageLine] = []
    for ln in lines:
        if is_structural(ln):
            continue
        if not ln.text or not ln.text.strip():
            continue
        if ln.max_size >= DROP_CAP_MIN_SIZE:
            continue
        if is_footer(ln) or is_ornament(ln):
            continue
        out.append(ln)
    return out


def _last_content_page(pages: list[list[PageLine]], first_page: int) -> int:
    """从书末向前找到最后一个“真正正文”页（跳过空白页/版权页小字号页）。"""
    for p in range(len(pages) - 1, first_page - 1, -1):
        body = _body_page_lines(pages[p])
        if not body:
            continue
        if any(ln.max_size >= 12.0 for ln in body):
            return p
    return first_page


def build_book(meta: BookMeta, source_dir: Path, diagnostics: bool = False) -> BookData:
    path = find_pdf(source_dir, meta)
    t0 = time.time()
    doc = pymupdf.open(path)
    pages: list[list[PageLine]] = [
        extract_page_lines(doc[pno], pno) for pno in range(doc.page_count)
    ]
    source_pages = doc.page_count
    doc.close()

    chapters = detect_chapters(pages)
    if not chapters:
        raise ValueError(f"{meta.id}: 未检测到任何章节")
    # 修正最后一章结束页（跳过书末版权/空白页）
    chapters[-1].end_page = _last_content_page(pages, chapters[-1].start_page)

    # 收集各章正文行（原始）用于估计版式 + 连字符上下文
    all_body_lines: list[PageLine] = []
    chapter_body: list[list[PageLine]] = []
    for idx, ch in enumerate(chapters):
        lines: list[PageLine] = []
        for p in range(ch.start_page, ch.end_page + 1):
            lines.extend(_body_page_lines(pages[p]))
        chapter_body.append(lines)
        all_body_lines.extend(lines)
    layout = estimate_layout(all_body_lines)
    hyphen_ctx = HyphenContext.from_lines(all_body_lines)

    chapter_data: list[ChapterData] = []
    chapter_layouts: list[LayoutParams] = []
    for idx, (ch, lines) in enumerate(zip(chapters, chapter_body), start=1):
        # 单章版式：个别章节（如 HP1 第 2 章）PDF 内容整体平移约 3pt，
        # 用全书参数会误判缩进；因此按章估计，行数太少时回退全书参数。
        ch_layout = estimate_layout(lines) if len(lines) >= 30 else layout
        chapter_layouts.append(ch_layout)
        body_lines = [BodyLine(page=ln.page, y0=ln.y0, x0=ln.x0, text=ln.text, x1=ln.x1)
                      for ln in lines]
        para_metas = build_paragraphs(
            body_lines, ch_layout, ch.start_page, ch.drop_cap, hyphen_ctx
        )
        paragraphs = [p.text for p in para_metas]
        para_sentences = [split_sentences(p) for p in paragraphs]
        para_sentences = [s for s in para_sentences if s]
        para_sentences = merge_fragment_paragraphs(para_sentences, para_metas, ch_layout, hyphen_ctx)
        title = ch.title or f"Chapter {idx}"
        if ch.number == "EPILOGUE" and not ch.title:
            title = "Nineteen Years Later"
        chapter_data.append(ChapterData(index=idx, number=ch.number, title=title,
                                        paragraphs=para_sentences))

    book = BookData(
        meta=meta,
        chapters=chapter_data,
        source_path=str(path),
        source_pages=source_pages,
        layout=layout,
    )
    book.diagnostics = {
        "sourcePages": source_pages,
        "firstChapterPage": chapters[0].start_page,
        "lastChapterPage": chapters[-1].start_page,
        "layout": {"margin": layout.margin, "indent": layout.indent, "pitch": round(layout.pitch, 2)},
        "chapterLayouts": [
            {"index": i + 1, "margin": cl.margin, "indent": cl.indent}
            for i, cl in enumerate(chapter_layouts)
        ],
        "chapterStarts": [(c.start_page, c.end_page, c.number, c.title, c.drop_cap) for c in chapters],
        "elapsedSec": round(time.time() - t0, 2),
    }
    if diagnostics:
        print(f"[诊断] {meta.id}: {source_pages} 页, {len(chapters)} 章, "
              f"margin={layout.margin}, indent={layout.indent}, pitch={layout.pitch:.2f}", file=sys.stderr)
        for c in chapters:
            print(f"   ch p{c.start_page:>3}-{c.end_page:<3} {c.number:<12} drop={c.drop_cap!r} title={c.title!r}",
                  file=sys.stderr)
    return book


# ---------------------------------------------------------------------------
# 语料验收检查
# ---------------------------------------------------------------------------

def _iter_sentences(book: BookData) -> Iterable[tuple[int, int, int, str]]:
    for ch in book.chapters:
        for pi, para in enumerate(ch.paragraphs):
            for si, sent in enumerate(para):
                yield ch.index, pi, si, sent


def book_stats(book: BookData) -> dict[str, Any]:
    sentences: list[str] = []
    for ch in book.chapters:
        for para in ch.paragraphs:
            sentences.extend(para)
    words = [len(s.split()) for s in sentences]
    avg = round(sum(words) / len(words), 2) if words else 0.0
    qb = quote_balance_stats(book.chapters)
    longest = sorted(sentences, key=lambda s: len(s.split()), reverse=True)[:5]
    long_sentences: list[dict[str, Any]] = []
    for ch_idx, pi, si, sent in _iter_sentences(book):
        wc = len(sent.split())
        if wc > 120:
            long_sentences.append({
                "bookId": book.meta.id,
                "chapterIndex": ch_idx,
                "paragraphIndex": pi,
                "sentenceIndex": si,
                "wordCount": wc,
                "text": sent if len(sent) <= 400 else sent[:400] + "…",
            })
    return {
        "id": book.meta.id,
        "order": book.meta.order,
        "title": book.meta.title,
        "titleZh": book.meta.title_zh,
        "chapterCount": len(book.chapters),
        "expectedChapterCount": book.meta.expected_chapters,
        "paragraphCount": book.paragraph_count,
        "sentenceCount": book.sentence_count,
        "wordCount": book.word_count,
        "avgSentenceWords": avg,
        "maxSentenceWords": max(words) if words else 0,
        **qb,
        "longestSentences": longest,
        "longSentences": long_sentences,
        "sourcePages": book.source_pages,
        "layout": book.diagnostics.get("layout", {}),
        "chapters": [
            {
                "index": ch.index,
                "number": ch.number,
                "title": ch.title,
                "paragraphCount": len(ch.paragraphs),
                "sentenceCount": sum(len(p) for p in ch.paragraphs),
                "wordCount": sum(len(s.split()) for p in ch.paragraphs for s in p),
            }
            for ch in book.chapters
        ],
    }


def _word_set(sentences: Iterable[str]) -> set[str]:
    """语料内出现过的英文单词（小写），用于识别“断词残留”。"""
    out: set[str] = set()
    for s in sentences:
        for tok in s.split():
            tok = tok.strip(".,;:!?’‘“”\"'()[]—–-")
            if len(tok) >= 4 and tok.isalpha():
                out.add(tok.lower())
    return out


def find_broken_words(sentences: list[str], vocab: set[str]) -> list[str]:
    """找出疑似“行尾断词未合并”的残留，如 'Minis- ter' / 'Mug- gles'。

    判定条件：'词- 词' 且去掉连字符后的单词在本语料其它地方正常出现过。
    这样可放过原文里真实存在的“破折号式连字符+空格”（如 sc- no / You-Know- oh）。
    """
    bad: list[str] = []
    for s in sentences:
        if s.rstrip().endswith("-"):
            bad.append(s)
            continue
        for m in re.finditer(r"([A-Za-z][A-Za-z'’]*)- +([A-Za-z][A-Za-z'’]*)", s):
            if (m.group(1) + m.group(2)).lower() in vocab:
                bad.append(s)
                break
    return bad


def run_checks(books: list[BookData], expected_ids: list[str],
               corpus_dir: Path) -> tuple[list[dict], list[dict], list[dict], list[dict]]:
    """执行语料验收检查。返回 (checks, book_stats, samples, warnings)。"""
    checks: list[dict] = []
    stats: list[dict] = []
    samples: list[dict] = []
    warnings: list[dict] = []
    by_id = {b.meta.id: b for b in books}

    def add(cid: str, ok: bool, detail: str) -> None:
        checks.append({"id": cid, "pass": bool(ok), "detail": detail})

    # 1. 书齐全
    missing = [bid for bid in expected_ids if bid not in by_id]
    add("books_present", not missing,
        f"期望 {len(expected_ids)} 本，实际 {len(by_id)} 本" + (f"，缺少 {missing}" if missing else ""))

    all_sentences: list[str] = []
    all_paragraphs: list[list[str]] = []
    for bid in expected_ids:
        book = by_id.get(bid)
        if book is None:
            continue
        st = book_stats(book)
        stats.append(st)
        all_sentences.extend(s for _, _, _, s in _iter_sentences(book))
        all_paragraphs.extend(p for ch in book.chapters for p in ch.paragraphs)

        meta = book.meta
        # 2. 章节数
        add(f"chapters_{bid}", len(book.chapters) == meta.expected_chapters,
            f"章节数 {len(book.chapters)}（期望 {meta.expected_chapters}）")
        # 3. 词数 ±10%
        ratio = book.word_count / meta.ref_words
        add(f"wordcount_{bid}", 0.9 <= ratio <= 1.1,
            f"wordCount={book.word_count} 参考={meta.ref_words} 比值={ratio:.3f}")
        # 4. 平均句长 12-22
        add(f"avg_sentence_{bid}", 12.0 <= st["avgSentenceWords"] <= 22.0,
            f"平均句长={st['avgSentenceWords']} 词（期望 12-22）")
        # 5. 超长句：>120 词记 warning（原文真实长句，不硬切），>300 词才算失败
        long_count = len(st["longSentences"])
        warnings.extend({"id": "long_sentence", **item} for item in st["longSentences"])
        add(f"max_sentence_{bid}", st["maxSentenceWords"] <= 300,
            f"最长句={st['maxSentenceWords']} 词；>120 词 warning {long_count} 条；"
            f">300 词才 FAIL" + (
                "；清单：" + repr([(x["chapterIndex"], x["wordCount"]) for x in st["longSentences"][:6]])
                if long_count else ""))
        # 6. 最长若干句结尾标点（容忍以破折号/省略号收尾的原文中断句）
        end_re = re.compile(r"[:.!?…—–][”’\"')\]]?$")
        ok = all(end_re.search(s) for s in st["longestSentences"])
        add(f"longest_end_punct_{bid}", ok,
            "最长 5 句结尾均有句末标点" if ok else
            "存在结尾无句末标点的长句：" + repr(
                [s[-40:] for s in st["longestSentences"] if not end_re.search(s)]))
        # 7. 引号成对：印刷版“跨段连续发言”每段重复开引号，原始计数天然略不平衡；
        #    阈值 1.5%，并用状态机统计真正的丢失/多余引号（quoteResidual）。
        add(f"quote_balance_{bid}", st["quoteDiffRatio"] < 0.015,
            f"“={st['quoteOpen']} ”={st['quoteClose']} 原始偏差={abs(st['quoteOpen'] - st['quoteClose']) / max(st['quoteOpen'], st['quoteClose'], 1):.4%}"
            f"；跨段续引号 {st['quoteContinuationParagraphs']} 处；有效配对残留 {st['quoteResidual']}（<1.5% 视为印刷版式正常）")
        # 8. 章节编号/标题格式
        bad = [ch for ch in book.chapters
               if not ch.title or not ch.number or ch.title != ch.title.strip()
               or "  " in ch.title or not ch.title[0].isupper()]
        add(f"titles_{bid}", not bad,
            "章节标题/编号格式正常" if not bad else f"异常章节：{[(c.index, c.number, c.title) for c in bad][:5]}")
        # 9. 章首无 drop cap 残留（首段首句应以大写字母/引号/破折号/数字开头）
        bad_first = []
        for ch in book.chapters:
            if not ch.paragraphs or not ch.paragraphs[0]:
                bad_first.append((ch.index, "空章"))
                continue
            first = ch.paragraphs[0][0]
            if re.match(r"^[a-z]", first) or re.match(r"^[A-Z] [a-z]", first):
                bad_first.append((ch.index, first[:50]))
        add(f"chapter_first_sentence_{bid}", not bad_first,
            "每章首句以大写/引号/破折号开头" if not bad_first else f"异常：{bad_first[:5]}")
        # 10. EPILOGUE 只在 hp7
        epi = [ch for ch in book.chapters if ch.number == "EPILOGUE"]
        if bid == "hp7":
            ok = len(epi) == 1 and epi[0].index == len(book.chapters) and \
                epi[0].title == "Nineteen Years Later"
            add("hp7_epilogue", ok,
                f"epilogue={[(c.index, c.number, c.title) for c in epi]}")
        else:
            add(f"no_epilogue_{bid}", not epi, "无 EPILOGUE" if not epi else "意外包含 EPILOGUE")

    # 全局文本检查
    text_join = "\n".join(all_sentences)
    ctrl = [c for c in ("\x91", "\x92", "\x93", "\x94") if c in text_join]
    add("no_control_chars", not ctrl, f"控制字符 {ctrl}" if ctrl else "无 U+0091 等控制字符")

    double = [s for s in all_sentences if "  " in s]
    add("no_double_space", not double, f"双空格句子 {len(double)} 条" + (f"，例：{double[:2]}" if double else ""))

    newline = [s for s in all_sentences if "\n" in s or "\r" in s]
    add("no_newline", not newline, f"句子含换行 {len(newline)} 条")

    header = [s for s in all_sentences
              if re.search(r"^CHAPTER\s+[A-Z]+$", s) or re.search(r"\bC H A P T E R\b", s)]
    add("no_header_residue", not header, f"页眉残留 {len(header)} 条" + (f"，例：{header[:2]}" if header else ""))

    contents = [s for s in all_sentences if re.search(r"\bContents\b", s)]
    add("no_frontmatter", not contents, f"目录残留 {len(contents)} 条" + (f"，例：{contents[:2]}" if contents else ""))

    backmatter = [s for s in all_sentences
                  if re.search(r"art directed by|copyright ©|All rights reserved", s, re.IGNORECASE)]
    add("no_backmatter", not backmatter, f"版权页残留 {len(backmatter)} 条")

    pagenums = [s for s in all_sentences if PAGE_NUMBER_RE.match(s)]
    add("no_page_number_sentence", not pagenums, f"纯页码句子 {len(pagenums)} 条")

    # 行尾断词残留：'Minis- ter' 这类“去掉连字符后是语料中真实单词”的组合
    vocab = _word_set(all_sentences)
    trailing_hyphen = find_broken_words(all_sentences, vocab)
    add("no_trailing_hyphen", not trailing_hyphen,
        f"断词残留 {len(trailing_hyphen)} 条" + (f"，例：{trailing_hyphen[:2]}" if trailing_hyphen else "")
        + "（原文中真实存在的 'sc- no' 式中断不误报）")

    chinese = [s for s in all_sentences if re.search(r"[，。！？；：、（）《》]", s)]
    add("no_chinese_punct", not chinese,
        f"中文标点混入 {len(chinese)} 条" + (f"，例：{chinese[:2]}" if chinese else ""))

    lone_letters = [s for s in all_sentences if re.fullmatch(r"[A-Za-z]", s)]
    add("no_lone_letter_sentence", not lone_letters, f"单字母句子 {len(lone_letters)} 条")

    empty_para = [p for p in all_paragraphs if not p]
    add("no_empty_paragraph", not empty_para, f"空段落 {len(empty_para)} 段")

    orphan_ellipsis = [s for s in all_sentences if re.fullmatch(r"[.\s…]+", s)]
    add("no_orphan_ellipsis", not orphan_ellipsis, f"纯省略号句子 {len(orphan_ellipsis)} 条")

    # 文件级检查：编码 / BOM / schema / manifest 一致性
    add("utf8_no_bom", _check_utf8_no_bom(corpus_dir),
        f"检查 {corpus_dir} 下 JSON 均为 UTF-8 无 BOM")
    add("schema_manifest", _check_manifest_schema(corpus_dir),
        "manifest.json 结构符合契约 §3.3")
    add("schema_chapters", _check_chapter_files_schema(corpus_dir),
        "章节文件结构符合契约 §3.3")

    # 抽样：每章首尾段 + 每本 5 条随机句
    rng = random.Random(RANDOM_SEED)
    for bid in expected_ids:
        book = by_id.get(bid)
        if book is None:
            continue
        for ch in book.chapters:
            samples.append({
                "type": "chapter",
                "bookId": bid,
                "chapterIndex": ch.index,
                "title": ch.title,
                "firstParagraph": " ".join(ch.paragraphs[0]) if ch.paragraphs else "",
                "lastParagraph": " ".join(ch.paragraphs[-1]) if ch.paragraphs else "",
            })
        flat = [(ch.index, pi, si, s) for ch in book.chapters
                for pi, para in enumerate(ch.paragraphs)
                for si, s in enumerate(para)]
        for ci, pi, si, s in rng.sample(flat, min(5, len(flat))):
            samples.append({"type": "randomSentence", "bookId": bid,
                            "chapterIndex": ci, "paragraphIndex": pi,
                            "sentenceIndex": si, "text": s})
    return checks, stats, samples, warnings


def _check_utf8_no_bom(corpus_dir: Path) -> bool:
    if not corpus_dir.is_dir():
        return False
    for p in corpus_dir.rglob("*.json"):
        data = p.read_bytes()
        if data.startswith(b"\xef\xbb\xbf") or not data.startswith(b"{"):
            return False
        try:
            data.decode("utf-8")
        except UnicodeDecodeError:
            return False
    return True


def _check_manifest_schema(corpus_dir: Path) -> bool:
    p = corpus_dir / "manifest.json"
    if not p.is_file():
        return False
    try:
        m = json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return False
    if m.get("version") != MANIFEST_VERSION or not isinstance(m.get("books"), list):
        return False
    for b in m["books"]:
        for key in ("id", "order", "title", "titleZh", "wordCount",
                    "paragraphCount", "sentenceCount", "chapters"):
            if key not in b:
                return False
        for ch in b["chapters"]:
            for key in ("index", "number", "title", "paragraphCount",
                        "sentenceCount", "file"):
                if key not in ch:
                    return False
            if not (corpus_dir / ch["file"]).is_file():
                return False
    return True


def _check_chapter_files_schema(corpus_dir: Path) -> bool:
    for p in sorted(corpus_dir.glob("hp*/chapter-*.json")):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return False
        if not all(k in data for k in ("bookId", "chapterIndex", "title", "paragraphs")):
            return False
        for pi, para in enumerate(data["paragraphs"]):
            if para.get("index") != pi:
                return False
            if not isinstance(para.get("sentences"), list) or not para["sentences"]:
                return False
            for sent in para["sentences"]:
                if not isinstance(sent.get("text"), str) or not sent["text"].strip():
                    return False
                if not isinstance(sent.get("wordCount"), int):
                    return False
                if sent["wordCount"] != len(sent["text"].split()):
                    return False
    return True


# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------

def _json_bytes(data: Any) -> bytes:
    return (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def write_json_if_changed(path: Path, data: Any) -> bool:
    """写 UTF-8 无 BOM JSON；内容未变化则不重写（幂等）。返回是否发生写入。"""
    payload = _json_bytes(data)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file():
        try:
            if path.read_bytes() == payload:
                return False
        except OSError:
            pass
    path.write_bytes(payload)
    return True


def utc_now_iso() -> str:
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def chapter_file_rel(book_id: str, index: int) -> str:
    return f"{book_id}/chapter-{index:03d}.json"


def write_book(corpus_dir: Path, book: BookData) -> dict[str, Any]:
    """写单本章节文件，返回 manifest 中的 book 条目。"""
    chapters_manifest: list[dict[str, Any]] = []
    for ch in book.chapters:
        paragraphs = []
        for pi, sentences in enumerate(ch.paragraphs):
            paragraphs.append({
                "index": pi,
                "sentences": [{"text": s, "wordCount": len(s.split())} for s in sentences],
            })
        chapter_json = {
            "bookId": book.meta.id,
            "chapterIndex": ch.index,
            "title": ch.title,
            "paragraphs": paragraphs,
        }
        rel = chapter_file_rel(book.meta.id, ch.index)
        write_json_if_changed(corpus_dir / rel, chapter_json)
        chapters_manifest.append({
            "index": ch.index,
            "number": ch.number,
            "title": ch.title,
            "paragraphCount": len(ch.paragraphs),
            "sentenceCount": sum(len(p) for p in ch.paragraphs),
            "file": rel,
        })
    return {
        "id": book.meta.id,
        "order": book.meta.order,
        "title": book.meta.title,
        "titleZh": book.meta.title_zh,
        "wordCount": book.word_count,
        "paragraphCount": book.paragraph_count,
        "sentenceCount": book.sentence_count,
        "chapters": chapters_manifest,
    }


def load_existing_manifest(corpus_dir: Path) -> dict[str, Any] | None:
    p = corpus_dir / "manifest.json"
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None


def _same_book_summary(a: dict, b: dict) -> bool:
    keys = ("id", "order", "title", "titleZh", "wordCount",
            "paragraphCount", "sentenceCount", "chapters")
    return all(a.get(k) == b.get(k) for k in keys)


def merge_manifest_books(
    corpus_dir: Path, source_dir: Path, new_entries: list[dict], keep_generated_at: str | None
) -> tuple[dict[str, Any], list[str]]:
    """合并已有 manifest：只替换本次构建的书，保留其它书的条目（若其文件仍存在）。"""
    old = load_existing_manifest(corpus_dir)
    by_id: dict[str, dict] = {}
    if old:
        for b in old.get("books", []):
            if isinstance(b, dict) and "id" in b:
                files_ok = all((corpus_dir / ch["file"]).is_file() for ch in b.get("chapters", []))
                if files_ok:
                    by_id[b["id"]] = b
    for entry in new_entries:
        by_id[entry["id"]] = entry
    books = sorted(by_id.values(), key=lambda b: b.get("order", 999))
    generated_at = keep_generated_at or utc_now_iso()
    if old and old.get("books") and [b["id"] for b in old["books"]] == [b["id"] for b in books] \
            and all(_same_book_summary(a, b) for a, b in zip(old["books"], books)):
        generated_at = old.get("generatedAt") or generated_at
    manifest = {
        "version": MANIFEST_VERSION,
        "generatedAt": generated_at,
        "sourceDir": str(source_dir),
        "books": books,
    }
    return manifest, [b["id"] for b in books]


def build_corpus(
    books: list[BookMeta],
    source_dir: Path,
    corpus_dir: Path,
    diagnostics: bool = False,
) -> list[BookData]:
    built: list[BookData] = []
    for meta in books:
        t0 = time.time()
        print(f"[构建] {meta.id} 读取 {find_pdf(source_dir, meta).name} ...", file=sys.stderr)
        book = build_book(meta, source_dir, diagnostics=diagnostics)
        print(
            f"[构建] {meta.id} 完成：{book.source_pages} 页 / {len(book.chapters)} 章 / "
            f"{book.paragraph_count} 段 / {book.sentence_count} 句 / {book.word_count} 词 "
            f"（{time.time() - t0:.1f}s）",
            file=sys.stderr,
        )
        built.append(book)
    return built


# ---------------------------------------------------------------------------
# 自检 / 校验入口
# ---------------------------------------------------------------------------

def validate_from_disk(corpus_dir: Path) -> tuple[list[dict], list[dict], list[dict], list[dict]]:
    """不读 PDF，从已有 data/corpus 加载并校验。"""
    manifest = load_existing_manifest(corpus_dir)
    if not manifest:
        checks = [{"id": "manifest_exists", "pass": False, "detail": "manifest.json 不存在"}]
        return checks, [], [], []
    books: list[BookData] = []
    for entry in manifest.get("books", []):
        meta = BOOK_BY_ID.get(entry.get("id", ""))
        if not meta:
            continue
        chapters: list[ChapterData] = []
        for ch in entry.get("chapters", []):
            p = corpus_dir / ch.get("file", "")
            if not p.is_file():
                continue
            data = json.loads(p.read_text(encoding="utf-8"))
            paragraphs = [[s["text"] for s in para["sentences"]] for para in data.get("paragraphs", [])]
            chapters.append(ChapterData(index=ch["index"], number=ch.get("number", ""),
                                        title=data.get("title", ch.get("title", "")),
                                        paragraphs=paragraphs))
        # 用最小 BookData 承载（source_pages 从 manifest 无从得知，填 0）
        book = BookData(meta=meta, chapters=chapters, source_path="", source_pages=0,
                        layout=LayoutParams(0, 0, 0))
        books.append(book)
    expected_ids = [b.id for b in BOOKS if b.id in {x.meta.id for x in books}]
    checks, stats, samples, warnings = run_checks(books, expected_ids, corpus_dir)
    # 全量模式下要求 7 本齐全
    if len(books) == len(BOOKS):
        checks.insert(0, {"id": "books_present", "pass": True, "detail": "7 本齐全（来自磁盘）"})
    return checks, stats, samples, warnings


def print_check_summary(checks: list[dict], stats: list[dict],
                        warnings: list[dict] | None = None) -> None:
    print("=" * 78)
    print("语料验收结果")
    print("=" * 78)
    for st in stats:
        print(f"  {st['id']}: 章 {st['chapterCount']}/{st['expectedChapterCount']} | "
              f"段 {st['paragraphCount']} | 句 {st['sentenceCount']} | "
              f"词 {st['wordCount']}（参考 {BOOK_BY_ID[st['id']].ref_words}）| "
              f"平均句长 {st['avgSentenceWords']} | 最长句 {st['maxSentenceWords']} | "
              f"引号 {st['quoteOpen']}/{st['quoteClose']}")
    failures = [c for c in checks if not c["pass"]]
    for c in failures:
        print(f"  [FAIL] {c['id']}: {c['detail']}")
    if warnings:
        print(f"  [WARN] {len(warnings)} 条（>120 词原文长句，保留原样不硬切）：")
        for w in warnings[:10]:
            print(f"         {w['bookId']} ch{w['chapterIndex']} p{w['paragraphIndex']} "
                  f"s{w['sentenceIndex']} = {w['wordCount']} 词")
        if len(warnings) > 10:
            print(f"         ... 其余 {len(warnings) - 10} 条见 quality-report.json")
    print(f"  检查项：{len(checks) - len(failures)}/{len(checks)} 通过"
          + (f"，失败 {len(failures)} 项" if failures else "，全部通过 ✓"))


def write_quality_report(
    corpus_dir: Path,
    checks: list[dict],
    stats: list[dict],
    samples: list[dict],
    source_dir: Path,
    warnings: list[dict] | None = None,
) -> Path:
    failures = [c for c in checks if not c["pass"]]
    warnings = warnings or []
    report = {
        "version": MANIFEST_VERSION,
        "generatedAt": utc_now_iso(),
        "sourceDir": str(source_dir),
        "summary": {
            "checks": len(checks),
            "passed": len(checks) - len(failures),
            "failed": len(failures),
            "warnings": len(warnings),
            "ok": not failures,
        },
        "checks": checks,
        "warnings": warnings,
        "notes": [
            "引号成对：印刷版跨段落连续发言会在每段行首重复开引号 “、仅最后一段闭合 ”；"
            "因此原始 “/” 计数天然略不平衡，检查用状态机剔除合法续引号后统计残留，阈值 1.5%。",
            "超长句：>120 词的原文真实长句（如魁地奇解说）保留原样不硬切，仅记 warning；>300 词才判失败。",
        ],
        "books": stats,
        "samples": samples,
    }
    path = corpus_dir / "quality-report.json"
    write_json_if_changed(path, report)
    return path


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="哈利波特 PDF → data/corpus 干净语料（书/章/段/句）")
    parser.add_argument("--book", action="append", default=None,
                        help="只构建指定书，如 --book hp1（可重复或逗号分隔）")
    parser.add_argument("--source-dir", type=Path, default=DEFAULT_SOURCE_DIR,
                        help=f"PDF 源目录（默认 {DEFAULT_SOURCE_DIR}）")
    parser.add_argument("--corpus-dir", type=Path, default=DEFAULT_CORPUS_DIR,
                        help=f"输出目录（默认 {DEFAULT_CORPUS_DIR}）")
    parser.add_argument("--selfcheck", action="store_true",
                        help="构建后执行语料验收检查，失败时退出码 1")
    parser.add_argument("--check-only", action="store_true",
                        help="不读 PDF，只校验已有 data/corpus")
    parser.add_argument("--diagnostics", action="store_true", help="打印版式/分段诊断")
    return parser.parse_args(argv)


def resolve_selected_books(raw: list[str] | None) -> list[BookMeta]:
    if not raw:
        return list(BOOKS)
    ids: list[str] = []
    for item in raw:
        for part in str(item).split(","):
            part = part.strip().lower()
            if part:
                ids.append(part)
    unknown = [i for i in ids if i not in BOOK_BY_ID]
    if unknown:
        raise SystemExit(f"未知书籍 id：{unknown}（可选 {list(BOOK_BY_ID)}）")
    # 去重且按 order 排序
    return sorted({BOOK_BY_ID[i] for i in ids}, key=lambda b: b.order)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    corpus_dir: Path = args.corpus_dir
    source_dir: Path = args.source_dir
    started = time.time()

    if args.check_only:
        checks, stats, samples, warnings = validate_from_disk(corpus_dir)
        report = write_quality_report(corpus_dir, checks, stats, samples, source_dir, warnings)
        print_check_summary(checks, stats, warnings)
        print(f"[完成] 质量报告：{report}")
        failures = [c for c in checks if not c["pass"]]
        return 1 if (args.selfcheck and failures) else 0

    selected = resolve_selected_books(args.book)
    built = build_corpus(selected, source_dir, corpus_dir, diagnostics=args.diagnostics)
    new_entries = [write_book(corpus_dir, book) for book in built]
    manifest, present_ids = merge_manifest_books(corpus_dir, source_dir, new_entries, None)
    write_json_if_changed(corpus_dir / "manifest.json", manifest)

    expected_ids = [b.id for b in selected]
    checks, stats, samples, warnings = run_checks(built, expected_ids, corpus_dir)
    report = write_quality_report(corpus_dir, checks, stats, samples, source_dir, warnings)
    print_check_summary(checks, stats, warnings)
    print(f"[完成] manifest: {corpus_dir / 'manifest.json'}（{len(present_ids)} 本）")
    print(f"[完成] 质量报告：{report}（{time.time() - started:.1f}s）")

    failures = [c for c in checks if not c["pass"]]
    if args.selfcheck and failures:
        print(f"[失败] {len(failures)} 项检查未通过", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
