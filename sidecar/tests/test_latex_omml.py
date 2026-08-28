# SPDX-License-Identifier: AGPL-3.0-or-later
"""LaTeX rendered as OMML, the equation markup Word draws.

These assert on element names rather than on exact XML, because the shape is what matters: a
fraction has to become ``m:f`` with ``m:num`` and ``m:den``, and nothing else Word understands
produces a fraction *bar*. Get the element wrong and the equation silently renders as a slash,
which is the bug this whole path exists to fix.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET

from impressive_ocr_sidecar.latex import M, latex_to_omml

TAG = f"{{{M}}}"


def render(latex: str, *, display: bool = False) -> ET.Element:
    element = latex_to_omml(latex, display=display)
    assert element is not None, f"{latex} did not convert"
    return element


def tags(element: ET.Element) -> set[str]:
    return {node.tag.removeprefix(TAG) for node in element.iter()}


def text_of(element: ET.Element) -> str:
    return "".join(node.text or "" for node in element.iter(f"{TAG}t"))


class TestShape:
    def test_a_fraction_becomes_a_fraction_element_with_a_bar(self) -> None:
        element = render(r"\frac{1}{2}")
        assert {"f", "num", "den"} <= tags(element)
        bar = element.find(f".//{TAG}fPr/{TAG}type")
        assert bar is not None and bar.get(f"{TAG}val") == "bar"

    def test_a_nested_fraction_keeps_both_levels(self) -> None:
        # The real case: a_r = v²/r, where the numerator is itself a superscript.
        element = render(r"a_{r}=\frac{v^{2}}{r}")
        assert {"sSub", "f", "sSup"} <= tags(element)

    def test_a_square_root_hides_its_degree_rather_than_omitting_it(self) -> None:
        # Leave `m:deg` out entirely and Word draws a radical with nowhere to sit an index,
        # which it renders as a malformed equation rather than as a square root.
        element = render(r"\sqrt{2}")
        hide = element.find(f".//{TAG}radPr/{TAG}degHide")
        assert hide is not None and hide.get(f"{TAG}val") == "1"
        assert element.find(f".//{TAG}deg") is not None

    def test_a_root_with_a_degree_shows_it(self) -> None:
        element = render(r"\sqrt[3]{8}")
        hide = element.find(f".//{TAG}radPr/{TAG}degHide")
        assert hide is not None and hide.get(f"{TAG}val") == "0"
        assert text_of(element).startswith("3")

    def test_sub_and_superscript_together_become_one_element(self) -> None:
        element = render("x_{i}^{2}")
        assert "sSubSup" in tags(element)
        assert "sSub" not in tags(element) and "sSup" not in tags(element)

    def test_delimiters_carry_their_characters(self) -> None:
        element = render(r"\left(x\right)")
        properties = element.find(f".//{TAG}dPr")
        assert properties is not None
        begin = properties.find(f"{TAG}begChr")
        end = properties.find(f"{TAG}endChr")
        assert begin is not None and begin.get(f"{TAG}val") == "("
        assert end is not None and end.get(f"{TAG}val") == ")"

    def test_an_aligned_block_becomes_an_equation_array(self) -> None:
        element = render(r"\begin{aligned}a&=b\\c&=d\end{aligned}")
        array = element.find(f".//{TAG}eqArr")
        assert array is not None
        assert len(array.findall(f"{TAG}e")) == 2

    def test_an_alignment_marker_becomes_an_alignment_run(self) -> None:
        # `&` is how a derivation stacks its equals signs. OMML spells it as an empty run
        # carrying `m:aln`, not as a column index.
        element = render(r"\begin{aligned}a&=b\end{aligned}")
        assert element.find(f".//{TAG}aln") is not None


class TestStyling:
    def test_display_math_gets_its_own_centred_paragraph(self) -> None:
        assert render(r"\frac{1}{2}", display=True).tag == f"{TAG}oMathPara"

    def test_inline_math_does_not(self) -> None:
        assert render("x^{2}", display=False).tag == f"{TAG}oMath"

    def test_operators_are_marked_upright(self) -> None:
        # Word italicises every character in an equation unless told otherwise, and a slanted
        # equals sign is visibly wrong.
        element = render("a=b")
        styles = [node.get(f"{TAG}val") for node in element.iter(f"{TAG}sty")]
        assert "p" in styles

    def test_a_variable_is_left_to_the_default_italic(self) -> None:
        element = render("x")
        assert element.find(f".//{TAG}sty") is None

    def test_mathbf_marks_its_contents_bold(self) -> None:
        element = render(r"\mathbf{v}")
        style = element.find(f".//{TAG}sty")
        assert style is not None and style.get(f"{TAG}val") == "b"


class TestFallback:
    def test_empty_input_converts_to_nothing_rather_than_an_empty_equation(self) -> None:
        # None tells the caller to leave the source text alone, which is the right outcome:
        # an equation that renders as nothing is worse than one that renders as its source.
        assert latex_to_omml("", display=False) is None
        assert latex_to_omml("   ", display=False) is None

    def test_a_formula_with_no_renderable_content_converts_to_nothing(self) -> None:
        assert latex_to_omml(r"\!", display=False) is None

    def test_an_unknown_command_still_renders_its_letters(self) -> None:
        assert "PE" in text_of(render(r"\PE"))

    def test_malformed_input_never_raises(self) -> None:
        for broken in [r"\frac{1", r"\left", "^", "_{", r"\begin{", "}{"]:
            latex_to_omml(broken, display=False)
