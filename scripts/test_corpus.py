# -*- coding: utf-8 -*-
"""逐句译 · 语料管线单元测试。

运行：
    python scripts/test_corpus.py
    python scripts/test_corpus.py -v

覆盖：
  - 英文句子切分（缩写 / 首字母 / 小数 / 省略号 / 引号对话 / 破折号 / ?! + 引号）
  - 行尾连字符合并（Mug-/gles、You-/Know-Who、good-for-/nothing、theory-/centered）
  - 章节标题 Title Case、章节编号规整
  - 文本规范化（U+0091、双空格、Trajan 字体错位解码）
  - 段落重建（缩进 / 跨页续接 / drop cap / 信件等特殊块 / 跨页断词）
  - 引号配对状态机、断词残留识别
  - 已生成语料的整体契约校验（data/corpus 存在时）
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import build_corpus as bc  # noqa: E402


# ---------------------------------------------------------------------------
# 句子切分
# ---------------------------------------------------------------------------

class SentenceSplitTests(unittest.TestCase):
    def assert_sentences(self, text: str, expected: list[str]) -> None:
        self.assertEqual(bc.split_sentences(text), expected)

    def test_plain_sentences(self) -> None:
        self.assert_sentences(
            "Harry stared at the letter. Then he read it again.",
            ["Harry stared at the letter.", "Then he read it again."],
        )

    def test_abbreviations_mr_mrs(self) -> None:
        self.assert_sentences(
            "Mr. and Mrs. Dursley of number four were proud. They were normal.",
            ["Mr. and Mrs. Dursley of number four were proud.",
             "They were normal."],
        )

    def test_abbreviations_dr_prof_st(self) -> None:
        self.assert_sentences(
            "Dr. Smith met Prof. Snape at St. Mungo's. They talked.",
            ["Dr. Smith met Prof. Snape at St. Mungo's.", "They talked."],
        )

    def test_initials_j_k(self) -> None:
        self.assert_sentences(
            "The book was written by J. K. Rowling. It sold well.",
            ["The book was written by J. K. Rowling.", "It sold well."],
        )
        self.assert_sentences(
            "That was J.K. Rowling's idea. Nobody knew.",
            ["That was J.K. Rowling's idea.", "Nobody knew."],
        )

    def test_single_initial_i_is_sentence_end(self) -> None:
        self.assert_sentences(
            "He looked at me and I. Then we left.",
            ["He looked at me and I.", "Then we left."],
        )

    def test_decimal_number(self) -> None:
        self.assert_sentences(
            "The price rose by 3.5 percent. Nobody cared.",
            ["The price rose by 3.5 percent.", "Nobody cared."],
        )

    def test_ellipsis_mid_sentence_no_split(self) -> None:
        self.assert_sentences(
            "Well, I just thought . . . maybe . . . it was something else.",
            ["Well, I just thought . . . maybe . . . it was something else."],
        )

    def test_ellipsis_ends_sentence(self) -> None:
        self.assert_sentences(
            "He did not know. . . . He walked away.",
            ["He did not know. . . .", "He walked away."],
        )

    def test_ellipsis_closing_quote(self) -> None:
        self.assert_sentences(
            "“I can’t believe it . . .” said Harry.",
            ["“I can’t believe it . . .” said Harry."],
        )

    def test_leading_ellipsis_not_orphan(self) -> None:
        self.assert_sentences(
            ". . . Hermione said Sirius was becoming reckless.",
            [". . . Hermione said Sirius was becoming reckless."],
        )

    def test_question_exclamation_with_quotes(self) -> None:
        self.assert_sentences(
            "“What?” said Ron. “No!” she shouted.",
            ["“What?” said Ron.", "“No!” she shouted."],
        )

    def test_lowercase_after_exclamation_no_split(self) -> None:
        self.assert_sentences(
            "“Stop!” he yelled.",
            ["“Stop!” he yelled."],
        )

    def test_period_inside_quote_then_capital(self) -> None:
        self.assert_sentences(
            "“Wait here.” She walked away.",
            ["“Wait here.”", "She walked away."],
        )

    def test_dash_does_not_split(self) -> None:
        self.assert_sentences(
            "They were the last people you would expect — or want — to be involved.",
            ["They were the last people you would expect — or want — to be involved."],
        )

    def test_list_marker_not_split(self) -> None:
        self.assert_sentences(
            "1. Three sets of robes. 2. One pointed hat.",
            ["1. Three sets of robes.", "2. One pointed hat."],
        )

    def test_unicode_ellipsis(self) -> None:
        self.assert_sentences(
            "He paused… Then he spoke.",
            ["He paused…", "Then he spoke."],
        )

    def test_no_double_space_in_output(self) -> None:
        sents = bc.split_sentences("Harry   ran.   Ron   followed.")
        self.assertEqual(sents, ["Harry ran.", "Ron followed."])


# ---------------------------------------------------------------------------
# 标题 / 章节编号
# ---------------------------------------------------------------------------

class TitleCaseTests(unittest.TestCase):
    def test_basic(self) -> None:
        self.assertEqual(bc.to_title_case("THE BOY WHO LIVED"), "The Boy Who Lived")

    def test_stop_words(self) -> None:
        self.assertEqual(bc.to_title_case("THE KEEPER OF THE KEYS"), "The Keeper of the Keys")

    def test_apostrophe(self) -> None:
        self.assertEqual(bc.to_title_case("DOBBY’S REWARD"), "Dobby’s Reward")

    def test_punctuation_preserved(self) -> None:
        self.assertEqual(bc.to_title_case("CAT, RAT, AND DOG"), "Cat, Rat, and Dog")
        self.assertEqual(bc.to_title_case("THE MADNESS OF MR. CROUCH"), "The Madness of Mr. Crouch")

    def test_hyphen_title(self) -> None:
        self.assertEqual(
            bc.to_title_case("THE JOURNEY FROM PLATFORM NINE AND THREE-QUARTERS"),
            "The Journey from Platform Nine and Three-Quarters",
        )
        self.assertEqual(
            bc.to_title_case("THE LIGHTNING-STRUCK TOWER"), "The Lightning-Struck Tower")

    def test_acronym(self) -> None:
        self.assertEqual(bc.to_title_case("O.W.L.S"), "O.W.L.S")

    def test_is_might(self) -> None:
        self.assertEqual(bc.to_title_case("MAGIC IS MIGHT"), "Magic Is Might")


class ChapterNumberTests(unittest.TestCase):
    def test_simple(self) -> None:
        self.assertEqual(bc.normalize_chapter_number(" O N E "), "ONE")

    def test_compound(self) -> None:
        self.assertEqual(bc.normalize_chapter_number(" T W E N T Y - O N E "), "TWENTY-ONE")
        self.assertEqual(bc.normalize_chapter_number("T W E N T y - F O U R"), "TWENTY-FOUR")

    def test_irregular_spacing(self) -> None:
        self.assertEqual(bc.normalize_chapter_number("T  H  R  E  E"), "THREE")


# ---------------------------------------------------------------------------
# 文本规范化 / Trajan 解码
# ---------------------------------------------------------------------------

class NormalizeTests(unittest.TestCase):
    def test_control_dash(self) -> None:
        self.assertEqual(bc.normalize_text("hello\x91world"), "hello—world")

    def test_double_space(self) -> None:
        self.assertEqual(bc.normalize_text("a   b  c"), "a b c")

    def test_trajan_decode(self) -> None:
        # Trajan 字体整体 +29 偏移：'g^jbp=mlqqbo' 实际是 'JAMES POTTER'
        self.assertEqual(bc.decode_span_text("g^jbp=mlqqbo", "Trajan"), "JAMES|POTTER")
        decoded = bc.cleanup_trajan_text(bc.decode_span_text("_lok=OT=j^o`e=NVSM=", "Trajan"))
        self.assertEqual(decoded, "BORN 27 MARCH 1960")
        self.assertEqual(
            bc.cleanup_trajan_text(bc.decode_span_text("q l j = o f a a i b =", "Trajan")),
            "TOM RIDDLE",
        )

    def test_span_join_missing_space_digit_letter(self) -> None:
        spans = [{"text": "since 382", "size": 13.0, "font": "f", "bbox": (0, 0, 1, 1)},
                 {"text": "b.c.", "size": 9.0, "font": "f", "bbox": (1, 0, 2, 1)}]
        self.assertTrue(bc._join_spans(spans)[0].endswith("382 b.c."))

    def test_span_join_ordinal_no_space(self) -> None:
        spans = [{"text": "31", "size": 13.0, "font": "f", "bbox": (0, 0, 1, 1)},
                 {"text": "st October", "size": 10.5, "font": "f", "bbox": (1, 0, 2, 1)}]
        self.assertTrue(bc._join_spans(spans)[0].startswith("31st October"))


# ---------------------------------------------------------------------------
# 连字符合并
# ---------------------------------------------------------------------------

class HyphenTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.ctx = bc.HyphenContext(
            intact_hyphenated={"You-Know-Who", "good-for-nothing", "half-blood"},
            intact_words={"muggles", "although", "minister", "twenty-five", "centered",
                          "theory", "penknife", "midnight", "something"},
        )

    def test_soft_hyphen_removed(self) -> None:
        text, kept = bc.merge_hyphen("the Mug-", "gles were", self.ctx)
        self.assertEqual(text, "the Muggles were")
        self.assertFalse(kept)

    def test_keep_compound_proper_noun(self) -> None:
        text, kept = bc.merge_hyphen("the You-", "Know-Who was", self.ctx)
        self.assertEqual(text, "the You-Know-Who was")
        self.assertTrue(kept)

    def test_keep_known_compound(self) -> None:
        text, _ = bc.merge_hyphen("a good-for-", "nothing idea", self.ctx)
        self.assertEqual(text, "a good-for-nothing idea")

    def test_soft_hyphen_mid_word(self) -> None:
        text, _ = bc.merge_hyphen("al-", "though he", self.ctx)
        self.assertEqual(text, "although he")

    def test_keep_twenty_five(self) -> None:
        text, _ = bc.merge_hyphen("twenty-", "five", self.ctx)
        self.assertEqual(text, "twenty-five")

    def test_keep_compound_from_vocab(self) -> None:
        text, _ = bc.merge_hyphen("theory-", "centered", self.ctx)
        self.assertEqual(text, "theory-centered")


# ---------------------------------------------------------------------------
# 段落重建
# ---------------------------------------------------------------------------

def _line(page: int, y: float, x: float, text: str, x1: float = 400.0) -> bc.BodyLine:
    return bc.BodyLine(page=page, y0=y, x0=x, text=text, x1=x1)


class ParagraphBuildTests(unittest.TestCase):
    def setUp(self) -> None:
        self.layout = bc.LayoutParams(margin=40.0, indent=54.0, pitch=16.5, right=400.0)
        self.ctx = bc.HyphenContext(
            intact_hyphenated={"You-Know-Who"},
            intact_words={"muggles", "minister", "although"},
        )

    def test_indent_starts_paragraph(self) -> None:
        lines = [
            _line(1, 100.0, 40.0, "First paragraph continues here and"),
            _line(1, 116.5, 40.0, "ends."),
            _line(1, 133.0, 54.0, "Second paragraph starts here."),
            _line(1, 149.5, 40.0, "and continues."),
        ]
        paras = bc.build_paragraphs(lines, self.layout, 1, "", self.ctx)
        self.assertEqual(
            [p.text for p in paras],
            ["First paragraph continues here and ends.",
             "Second paragraph starts here. and continues."],
        )

    def test_cross_page_continuation(self) -> None:
        lines = [
            _line(1, 500.0, 40.0, "The paragraph continues across the"),
            _line(2, 100.0, 40.0, "page break."),
        ]
        paras = bc.build_paragraphs(lines, self.layout, 1, "", self.ctx)
        self.assertEqual([p.text for p in paras],
                         ["The paragraph continues across the page break."])

    def test_cross_page_hyphen(self) -> None:
        lines = [
            _line(1, 500.0, 40.0, "They wanted Dumbledore fer Minis-"),
            _line(2, 100.0, 40.0, "ter, o’ course, but he’d never leave."),
        ]
        paras = bc.build_paragraphs(lines, self.layout, 1, "", self.ctx)
        self.assertEqual([p.text for p in paras],
                         ["They wanted Dumbledore fer Minister, o’ course, but he’d never leave."])

    def test_drop_cap_first_paragraph(self) -> None:
        lines = [
            _line(1, 300.0, 74.0, "he door swung open at once."),
            _line(1, 316.5, 74.0, "A tall witch stood there."),
            _line(1, 333.0, 40.0, "She had a stern face."),
            _line(1, 349.5, 54.0, "Second paragraph here."),
        ]
        paras = bc.build_paragraphs(lines, self.layout, 1, "T", self.ctx)
        self.assertEqual(paras[0].text,
                         "The door swung open at once. A tall witch stood there. She had a stern face.")
        self.assertEqual(paras[1].text, "Second paragraph here.")

    def test_letter_block_inner_indent(self) -> None:
        lines = [
            _line(1, 100.0, 40.0, "He read the letter:"),
            _line(1, 133.0, 62.0, "Dear Ron,"),
            _line(1, 149.5, 76.0, "How are you? I think the best"),
            _line(1, 166.0, 62.0, "thing will be to send him"),
            _line(1, 182.5, 62.0, "over with friends next week."),
            _line(1, 215.0, 40.0, "Harry folded the letter."),
        ]
        paras = bc.build_paragraphs(lines, self.layout, 1, "", self.ctx)
        texts = [p.text for p in paras]
        self.assertEqual(texts[0], "He read the letter:")
        self.assertEqual(texts[1], "Dear Ron,")
        self.assertEqual(
            texts[2],
            "How are you? I think the best thing will be to send him "
            "over with friends next week.",
        )
        self.assertEqual(texts[3], "Harry folded the letter.")

    def test_poem_block_joined(self) -> None:
        lines = [
            _line(1, 100.0, 40.0, "The hat began to sing:"),
            _line(1, 133.0, 110.0, "“Oh, you may not think I’m pretty,"),
            _line(1, 149.5, 110.0, "But don’t judge on what you see,"),
            _line(1, 166.0, 110.0, "I’ll eat myself if you can find"),
            _line(1, 182.5, 110.0, "A smarter hat than me.”"),
            _line(1, 215.0, 40.0, "The hall burst into applause."),
        ]
        paras = bc.build_paragraphs(lines, self.layout, 1, "", self.ctx)
        self.assertIn("But don’t judge", paras[1].text)
        self.assertIn("The hall burst into applause.", [p.text for p in paras])


# ---------------------------------------------------------------------------
# 引号配对 / 断词残留
# ---------------------------------------------------------------------------

def _chapter(index: int, paragraphs: list[list[str]]) -> bc.ChapterData:
    return bc.ChapterData(index=index, number="ONE", title="Test", paragraphs=paragraphs)


class QuoteBalanceTests(unittest.TestCase):
    def test_balanced(self) -> None:
        ch = _chapter(1, [["“Hello,” she said."], ["“Bye.”"]])
        stats = bc.quote_balance_stats([ch])
        self.assertEqual(stats["quoteResidual"], 0)

    def test_continuation_paragraphs(self) -> None:
        ch = _chapter(1, [
            ["“This is a long speech that continues."],
            ["“And continues in the next paragraph."],
            ["“And ends here.”"],
        ])
        stats = bc.quote_balance_stats([ch])
        self.assertEqual(stats["quoteContinuationParagraphs"], 2)
        self.assertEqual(stats["quoteResidual"], 0)

    def test_missing_close_detected(self) -> None:
        ch = _chapter(1, [["“This one never closes."]])
        stats = bc.quote_balance_stats([ch])
        self.assertEqual(stats["quoteResidual"], 1)


class BrokenWordTests(unittest.TestCase):
    def test_broken_word_detected(self) -> None:
        vocab = {"minister", "muggles"}
        bad = bc.find_broken_words(["fer Minis- ter, o’ course"], vocab)
        self.assertEqual(len(bad), 1)

    def test_intentional_dash_not_detected(self) -> None:
        vocab = {"minister"}
        bad = bc.find_broken_words(["he’s going to sc- no, stopped"], vocab)
        self.assertEqual(bad, [])


# ---------------------------------------------------------------------------
# 生成语料契约校验（data/corpus 存在时才运行）
# ---------------------------------------------------------------------------

CORPUS_DIR = bc.DEFAULT_CORPUS_DIR
MANIFEST = CORPUS_DIR / "manifest.json"


@unittest.skipUnless(MANIFEST.is_file(), "data/corpus/manifest.json 未生成，跳过集成测试")
class CorpusIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        cls.books = {b["id"]: b for b in cls.manifest["books"]}

    def test_manifest_all_books(self) -> None:
        expected = {b.id: b.order for b in bc.BOOKS}
        self.assertEqual(set(self.books), set(expected))
        for bid, book in self.books.items():
            self.assertEqual(book["order"], expected[bid])
            self.assertTrue(book["title"])
            self.assertTrue(book["titleZh"])
            self.assertGreater(book["wordCount"], 0)

    def test_chapter_counts_and_files(self) -> None:
        for meta in bc.BOOKS:
            book = self.books[meta.id]
            self.assertEqual(len(book["chapters"]), meta.expected_chapters,
                             f"{meta.id} 章节数不符")
            self.assertEqual([c["index"] for c in book["chapters"]],
                             list(range(1, meta.expected_chapters + 1)))
            for ch in book["chapters"]:
                path = CORPUS_DIR / ch["file"]
                self.assertTrue(path.is_file(), f"缺少章节文件 {path}")
                self.assertIn("/", ch["file"])
                data = json.loads(path.read_text(encoding="utf-8"))
                self.assertEqual(data["bookId"], meta.id)
                self.assertEqual(data["chapterIndex"], ch["index"])
                self.assertEqual(len(data["paragraphs"]), ch["paragraphCount"])
                para_sentences = [s for p in data["paragraphs"] for s in p["sentences"]]
                self.assertEqual(len(para_sentences), ch["sentenceCount"])
                for pi, para in enumerate(data["paragraphs"]):
                    self.assertEqual(para["index"], pi)
                    self.assertTrue(para["sentences"])
                    for sent in para["sentences"]:
                        self.assertTrue(sent["text"].strip())
                        self.assertEqual(sent["wordCount"], len(sent["text"].split()))

    def test_word_count_magnitude(self) -> None:
        for meta in bc.BOOKS:
            book = self.books[meta.id]
            ratio = book["wordCount"] / meta.ref_words
            self.assertTrue(0.9 <= ratio <= 1.1,
                            f"{meta.id} wordCount={book['wordCount']} 参考={meta.ref_words}")

    def test_hp7_epilogue(self) -> None:
        hp7 = self.books["hp7"]
        last = hp7["chapters"][-1]
        self.assertEqual(last["index"], 37)
        self.assertEqual(last["number"], "EPILOGUE")
        self.assertEqual(last["title"], "Nineteen Years Later")

    def test_text_hygiene(self) -> None:
        """抽样全量检查：无控制字符/页眉页脚残留/双空格/换行/中文标点。"""
        bad_headers = 0
        bad_chars = 0
        bad_spaces = 0
        for meta in bc.BOOKS:
            for ch in self.books[meta.id]["chapters"]:
                data = json.loads((CORPUS_DIR / ch["file"]).read_text(encoding="utf-8"))
                for para in data["paragraphs"]:
                    for sent in para["sentences"]:
                        t = sent["text"]
                        if any(c in t for c in ("\x91", "\x92", "\x93", "\x94")):
                            bad_chars += 1
                        if "  " in t or "\n" in t:
                            bad_spaces += 1
                        if "CHAPTER" in t or "Contents" in t:
                            bad_headers += 1
                        self.assertFalse(
                            any(c in t for c in "，。！？；：、（）《》"),
                            f"中文标点混入：{t[:60]}")
        self.assertEqual(bad_chars, 0)
        self.assertEqual(bad_spaces, 0)
        self.assertEqual(bad_headers, 0)

    def test_quality_report(self) -> None:
        report_path = CORPUS_DIR / "quality-report.json"
        self.assertTrue(report_path.is_file())
        report = json.loads(report_path.read_text(encoding="utf-8"))
        self.assertIn("checks", report)
        self.assertIn("books", report)
        self.assertIn("samples", report)
        failed = [c for c in report["checks"] if not c["pass"]]
        self.assertEqual(failed, [], f"quality-report 存在失败项：{failed}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
