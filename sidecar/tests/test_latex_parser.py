# SPDX-License-Identifier: AGPL-3.0-or-later
"""The LaTeX subset PaddleOCR-VL emits, parsed into a tree.

Cases are taken from real recogniser output, not invented: every formula quoted here appeared
in a physics textbook processed by the accurate engine.
"""

from __future__ import annotations

from impressive_ocr_sidecar.latex.nodes import (
    Accent,
    Array,
    Delimited,
    Fraction,
    Radical,
    Row,
    Script,
    Text,
)
from impressive_ocr_sidecar.latex.parser import parse


class TestStructure:
    def test_reads_a_fraction_as_a_numerator_and_a_denominator(self) -> None:
        assert parse(r"\frac{1}{2}") == Fraction(Text("1", upright=True), Text("2", upright=True))

    def test_reads_a_superscript(self) -> None:
        assert parse("x^{2}") == Script(Text("x"), None, Text("2", upright=True))

    def test_treats_an_unbraced_argument_the_same_as_a_braced_one(self) -> None:
        # `x^2` and `x^{2}` mean the same thing. Assuming an argument is always braced is the
        # commonest way to mis-parse a superscript, and it silently eats the next character.
        assert parse("x^2") == parse("x^{2}")

    def test_merges_a_subscript_and_a_superscript_onto_one_base(self) -> None:
        # LaTeX writes these as three sibling tokens; OMML needs one sSubSup element.
        assert parse("x_{i}^{2}") == Script(Text("x"), Text("i"), Text("2", upright=True))
        assert parse("x^{2}_{i}") == Script(Text("x"), Text("i"), Text("2", upright=True))

    def test_reads_a_square_root_without_a_degree(self) -> None:
        assert parse(r"\sqrt{2}") == Radical(Text("2", upright=True), None)

    def test_reads_an_explicit_root_degree(self) -> None:
        assert parse(r"\sqrt[3]{8}") == Radical(Text("8", upright=True), Text("3", upright=True))

    def test_pairs_left_and_right_into_one_group(self) -> None:
        parsed = parse(r"\left(x\right)")
        assert parsed == Delimited(Text("x"), "(", ")")

    def test_keeps_a_one_sided_grouping(self) -> None:
        # `\left.` is a genuine construction: a brace on one side only.
        assert parse(r"\left.x\right|") == Delimited(Text("x"), "", "|")

    def test_splits_an_aligned_block_into_rows_and_cells(self) -> None:
        parsed = parse(r"\begin{aligned}a&=b\\c&=d\end{aligned}")
        assert isinstance(parsed, Array)
        assert len(parsed.rows) == 2
        assert parsed.rows[0][0] == Text("a")
        assert parsed.rows[1][0] == Text("c")

    def test_reads_an_accent(self) -> None:
        assert isinstance(parse(r"\vec{v}"), Accent)


class TestSymbols:
    def test_maps_greek_to_its_character(self) -> None:
        assert parse(r"\theta") == Text("θ")

    def test_leaves_capital_greek_upright(self) -> None:
        # Slanting a capital delta is wrong in every typesetting convention worth following.
        assert parse(r"\Delta") == Text("Δ", upright=True)

    def test_sets_a_named_function_upright(self) -> None:
        # `cos` in italics reads as c times o times s.
        assert parse(r"\cos") == Text("cos", style="p")

    def test_marks_operators_and_digits_upright(self) -> None:
        # Word italicises everything in an equation by default, so `a + b` would otherwise
        # come out with a slanted plus sign.
        assert parse("+") == Text("+", upright=True)
        assert parse("7") == Text("7", upright=True)

    def test_leaves_a_variable_to_the_default_italic(self) -> None:
        assert parse("x") == Text("x")

    def test_pushes_a_font_style_down_to_the_text(self) -> None:
        assert parse(r"\mathrm{kg}") == Row((Text("k", style="p"), Text("g", style="p")))
        assert parse(r"\mathbf{v}") == Text("v", style="b")


class TestDegradation:
    """Nothing is ever dropped. A formula this cannot understand still reads."""

    def test_keeps_the_letters_of_an_unknown_command(self) -> None:
        # The recogniser occasionally emits these — `\PE` for the symbol PE. Rendering the
        # letters is a far better answer than rendering nothing.
        assert parse(r"\PE") == Text("PE")

    def test_closes_an_unclosed_group_at_the_end_of_input(self) -> None:
        assert parse("{x") == Text("x")

    def test_closes_an_unmatched_left_at_the_end_of_input(self) -> None:
        assert parse(r"\left(x") == Delimited(Text("x"), "(", "")

    def test_skips_a_stray_closing_brace(self) -> None:
        assert parse("x}") == Text("x")

    def test_reads_a_row_separator_rather_than_an_escaped_backslash(self) -> None:
        # `\\` is two characters that look like an escape and are not. Reading them as one
        # would collapse every row of an aligned block onto a single line.
        parsed = parse(r"\begin{aligned}a\\b\end{aligned}")
        assert isinstance(parsed, Array)
        assert len(parsed.rows) == 2

    def test_returns_an_empty_row_for_empty_input(self) -> None:
        assert parse("") == Row(())

    def test_never_raises_on_malformed_input(self) -> None:
        for broken in [r"\frac{1", r"\left", "^", "_{", r"\begin{", r"\sqrt[", "&&&", "}{"]:
            parse(broken)
