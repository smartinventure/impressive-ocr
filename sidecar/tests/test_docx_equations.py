# SPDX-License-Identifier: AGPL-3.0-or-later
"""Rewriting a .docx so its LaTeX becomes equations Word draws.

The bug this closes: the accurate engine recognises typeset mathematics correctly and reports
it as LaTeX, and ``save_to_word`` writes that through as literal text. A physics page came out
carrying ``$$\\frac{v^{2}}{r}$$`` where the original had a fraction.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

from impressive_ocr_sidecar.writers.docx_equations import (
    _is_formula,
    embed_equations,
    rewrite_document_xml,
)

M = "http://schemas.openxmlformats.org/officeDocument/2006/math"
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

#: A document element shaped like the one PaddleOCR produces: many namespaces, and an
#: `mc:Ignorable` naming prefixes that have to survive the rewrite.
ROOT = (
    f'<w:document xmlns:w="{W}" xmlns:m="{M}" '
    'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
    'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" '
    'xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" '
    'mc:Ignorable="w14 w15">'
)


def document(*paragraphs: str) -> str:
    body = "".join(paragraphs)
    declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    return f"{declaration}{ROOT}<w:body>{body}</w:body></w:document>"


def paragraph(text: str, *, para_id: str = "12345678") -> str:
    return (
        f'<w:p w14:paraId="{para_id}"><w:pPr><w:jc w:val="both"/></w:pPr>'
        f'<w:r><w:rPr><w:sz w:val="24"/></w:rPr><w:t>{text}</w:t></w:r></w:p>'
    )


def build_docx(path: Path, xml: str) -> Path:
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("word/document.xml", xml)
        archive.writestr("word/styles.xml", f'<w:styles xmlns:w="{W}"/>')
    return path


class TestConversion:
    def test_turns_a_display_formula_into_an_equation(self) -> None:
        rewritten, count = rewrite_document_xml(document(paragraph(r"$$\frac{v^{2}}{r}$$")))

        assert count == 1
        assert "<m:oMathPara" in rewritten
        assert "<m:f>" in rewritten
        assert "$" not in rewritten

    def test_keeps_the_prose_around_an_inline_formula(self) -> None:
        rewritten, count = rewrite_document_xml(
            document(paragraph(r"The radius is $r^{2}$ in metres."))
        )

        assert count == 1
        assert "The radius is " in rewritten
        assert " in metres." in rewritten
        assert "<m:sSup>" in rewritten

    def test_an_inline_formula_does_not_get_its_own_paragraph(self) -> None:
        # oMathPara centres the equation on a line of its own, which is right for a display
        # equation and wrong for one sitting mid-sentence.
        rewritten, _ = rewrite_document_xml(document(paragraph(r"is $r^{2}$ in metres")))
        assert "<m:oMathPara" not in rewritten
        assert "<m:oMath" in rewritten

    def test_converts_several_formulas_in_one_paragraph(self) -> None:
        _, count = rewrite_document_xml(
            document(paragraph(r"$a^{2}$ plus $b^{2}$ equals $c^{2}$"))
        )
        assert count == 3

    def test_leaves_a_document_with_no_formulas_untouched(self) -> None:
        original = document(paragraph("Just prose, no mathematics at all."))
        rewritten, count = rewrite_document_xml(original)

        assert count == 0
        assert rewritten == original


class TestDocumentIntegrity:
    """The rewrite must not damage the parts of the document it is not interested in."""

    def test_preserves_every_namespace_declaration_on_the_root(self) -> None:
        # Reserialising the whole tree through ElementTree drops the namespaces it does not
        # happen to use and renames the rest, leaving `mc:Ignorable` naming prefixes that no
        # longer exist. Word rejects the file outright. Paragraphs are spliced for exactly
        # this reason, and this is the test that says so.
        rewritten, _ = rewrite_document_xml(document(paragraph(r"$$x^{2}$$")))

        assert rewritten.count("xmlns:") == ROOT.count("xmlns:")
        assert 'mc:Ignorable="w14 w15"' in rewritten
        assert "xmlns:ns0" not in rewritten

    def test_keeps_attributes_on_a_rewritten_paragraph(self) -> None:
        rewritten, _ = rewrite_document_xml(document(paragraph(r"$$x^{2}$$", para_id="ABCD1234")))
        assert 'w14:paraId="ABCD1234"' in rewritten

    def test_keeps_paragraph_properties(self) -> None:
        # Alignment, spacing and indentation live in w:pPr, which is not a run and must not
        # be swept up with them.
        rewritten, _ = rewrite_document_xml(document(paragraph(r"$$x^{2}$$")))
        assert "<w:pPr>" in rewritten

    def test_reuses_the_original_run_formatting_for_surviving_text(self) -> None:
        rewritten, _ = rewrite_document_xml(document(paragraph(r"before $x^{2}$ after")))
        assert rewritten.count('<w:sz w:val="24"') >= 2

    def test_leaves_other_paragraphs_byte_for_byte(self) -> None:
        plain = paragraph("Untouched prose.", para_id="AAAA1111")
        rewritten, _ = rewrite_document_xml(document(plain, paragraph(r"$$x^{2}$$")))
        assert plain in rewritten


class TestFallback:
    def test_puts_the_delimiters_back_on_a_formula_it_cannot_convert(self) -> None:
        # Nothing is ever lost: an unconvertible formula reads exactly as it did before, as
        # its own source, rather than leaving a gap where an equation was.
        rewritten, count = rewrite_document_xml(
            document(paragraph(r"see $x^{2}$ and also $\!$ here"))
        )

        assert count == 1
        assert r"$\!$" in rewritten

    def test_ignores_dollar_signs_that_are_currency(self) -> None:
        original = document(paragraph("I paid $5 and $10 for it."))
        rewritten, count = rewrite_document_xml(original)

        assert count == 0
        assert rewritten == original

    def test_returns_the_input_unchanged_when_there_is_no_document_element(self) -> None:
        assert rewrite_document_xml("<not-a-document/>") == ("<not-a-document/>", 0)


class TestIsFormula:
    def test_accepts_anything_carrying_a_command_or_a_script(self) -> None:
        assert _is_formula(r"\frac{1}{2}")
        assert _is_formula("x^2")
        assert _is_formula("v_{0}")

    def test_accepts_a_lone_symbol(self) -> None:
        assert _is_formula("m")
        assert _is_formula("PV")

    def test_accepts_a_plain_equation_with_nothing_but_an_equals_sign(self) -> None:
        # The case that rules out demanding a backslash: a real formula, no LaTeX in it.
        assert _is_formula(" PV = nkT ")

    def test_accepts_arithmetic_on_a_variable(self) -> None:
        assert _is_formula("1 + by")

    def test_rejects_currency_and_ranges(self) -> None:
        assert not _is_formula("5 and ")
        assert not _is_formula("10 to ")
        assert not _is_formula("5 - ")
        assert not _is_formula("1,000 ")

    def test_rejects_nothing(self) -> None:
        assert not _is_formula("")
        assert not _is_formula("   ")


class TestOnDisk:
    def test_rewrites_a_docx_in_place_keeping_every_other_part(self, tmp_path: Path) -> None:
        path = build_docx(tmp_path / "out.docx", document(paragraph(r"$$\frac{1}{2}$$")))

        assert embed_equations(path) is True

        with zipfile.ZipFile(path) as archive:
            assert set(archive.namelist()) == {
                "[Content_Types].xml",
                "word/document.xml",
                "word/styles.xml",
            }
            body = archive.read("word/document.xml").decode("utf-8")
            assert "<m:f>" in body
            # Every part still parses, which is the cheapest proxy for "Word will open it".
            for name in archive.namelist():
                ET.fromstring(archive.read(name))

    def test_reports_no_change_for_a_document_without_formulas(self, tmp_path: Path) -> None:
        path = build_docx(tmp_path / "plain.docx", document(paragraph("No mathematics here.")))
        before = path.read_bytes()

        assert embed_equations(path) is False
        assert path.read_bytes() == before

    def test_leaves_the_file_alone_when_it_is_not_a_document(self, tmp_path: Path) -> None:
        # Never raises: this is a cosmetic pass, and losing a finished document to it would
        # be far worse than leaving the LaTeX as text.
        path = tmp_path / "broken.docx"
        path.write_bytes(b"not a zip at all")

        assert embed_equations(path) is False
        assert path.read_bytes() == b"not a zip at all"

    def test_leaves_a_zip_with_no_document_part_alone(self, tmp_path: Path) -> None:
        path = tmp_path / "empty.docx"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("word/styles.xml", f'<w:styles xmlns:w="{W}"/>')

        assert embed_equations(path) is False
