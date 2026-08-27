# SPDX-License-Identifier: AGPL-3.0-or-later
"""Turn a parsed formula into OMML, the equation markup Word actually renders.

OMML rather than MathML because a .docx displays only OMML: MathML has to be converted on the
way in, and the stylesheet Microsoft ships for that is not ours to redistribute. Emitting OMML
directly avoids the question, and the subset needed is small — fractions, radicals, scripts,
growing delimiters, equation arrays and styled runs.

The output of this module is what makes a fraction show a fraction *bar* rather than a slash,
which is the whole reason it exists: the recogniser reads ``\\frac{v^2}{r}`` correctly and Word
has no way to display that until it is markup rather than text.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET

from .nodes import Accent, Array, Delimited, Fraction, Node, Radical, Row, Script, Text

M = "http://schemas.openxmlformats.org/officeDocument/2006/math"


def register_namespace() -> None:
    """Emit ``m:`` prefixes rather than ElementTree's generated ``ns0:``.

    Word reads either, but a document full of ``ns0:`` is unreadable to anyone opening the XML
    to work out why an equation looks wrong.
    """
    ET.register_namespace("m", M)


def _element(tag: str, parent: ET.Element | None = None) -> ET.Element:
    if parent is None:
        return ET.Element(f"{{{M}}}{tag}")
    return ET.SubElement(parent, f"{{{M}}}{tag}")


def _property(parent: ET.Element, tag: str, value: str) -> None:
    _element(tag, parent).set(f"{{{M}}}val", value)


def to_omml(node: Node, *, display: bool) -> ET.Element:
    """Render a formula as ``m:oMathPara`` (display) or ``m:oMath`` (inline).

    Display equations get the paragraph wrapper so Word centres them on their own line, which
    is how they appeared on the page. Inline ones sit in the run sequence beside the text.
    """
    math = _element("oMath")
    _render(node, math)

    if not display:
        return math

    paragraph = _element("oMathPara")
    _element("oMathParaPr", paragraph)
    paragraph.append(math)
    return paragraph


def _render(node: Node, parent: ET.Element) -> None:
    if isinstance(node, Text):
        _render_text(node, parent)
    elif isinstance(node, Row):
        for item in node.items:
            _render(item, parent)
    elif isinstance(node, Fraction):
        _render_fraction(node, parent)
    elif isinstance(node, Radical):
        _render_radical(node, parent)
    elif isinstance(node, Script):
        _render_script(node, parent)
    elif isinstance(node, Delimited):
        _render_delimited(node, parent)
    elif isinstance(node, Array):
        _render_array(node, parent)
    elif isinstance(node, Accent):
        _render_accent(node, parent)


def _render_text(node: Text, parent: ET.Element) -> None:
    if not node.value:
        return

    run = _element("r", parent)
    style = node.style
    if style is None and node.upright:
        # Word italicises every letter in an equation by default. Operators, digits and
        # brackets have to say otherwise, or `a + b` comes out with a slanted plus sign.
        style = "p"

    if style is not None:
        properties = _element("rPr", run)
        _property(properties, "sty", style)

    text = _element("t", run)
    text.text = node.value
    # Leading and trailing spaces are meaningful between two symbols and XML would collapse
    # them, so they are protected the same way a Word run protects them.
    if node.value != node.value.strip():
        text.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")


def _wrap(tag: str, parent: ET.Element, node: Node) -> None:
    """Render ``node`` inside a new child element — the shape every OMML slot takes."""
    _render(node, _element(tag, parent))


def _render_fraction(node: Fraction, parent: ET.Element) -> None:
    fraction = _element("f", parent)
    properties = _element("fPr", fraction)
    _property(properties, "type", "bar")
    _wrap("num", fraction, node.numerator)
    _wrap("den", fraction, node.denominator)


def _render_radical(node: Radical, parent: ET.Element) -> None:
    radical = _element("rad", parent)
    properties = _element("radPr", radical)
    # A square root hides its degree rather than omitting the element: leave `deg` out
    # entirely and Word draws the radical without a hook to sit the index in.
    _property(properties, "degHide", "0" if node.degree is not None else "1")

    degree = _element("deg", radical)
    if node.degree is not None:
        _render(node.degree, degree)
    _wrap("e", radical, node.radicand)


def _render_script(node: Script, parent: ET.Element) -> None:
    has_sub = node.subscript is not None
    has_sup = node.superscript is not None

    if has_sub and has_sup:
        element = _element("sSubSup", parent)
        _element("sSubSupPr", element)
        _wrap("e", element, node.base)
        _wrap("sub", element, node.subscript)  # type: ignore[arg-type]
        _wrap("sup", element, node.superscript)  # type: ignore[arg-type]
        return

    if has_sub:
        element = _element("sSub", parent)
        _element("sSubPr", element)
        _wrap("e", element, node.base)
        _wrap("sub", element, node.subscript)  # type: ignore[arg-type]
        return

    if has_sup:
        element = _element("sSup", parent)
        _element("sSupPr", element)
        _wrap("e", element, node.base)
        _wrap("sup", element, node.superscript)  # type: ignore[arg-type]
        return

    _render(node.base, parent)


def _render_delimited(node: Delimited, parent: ET.Element) -> None:
    delimited = _element("d", parent)
    properties = _element("dPr", delimited)
    # An empty string is `\left.` — a genuinely one-sided grouping — and OMML spells that as
    # an explicitly empty character, not as an absent attribute, which would mean "default".
    _property(properties, "begChr", node.left)
    _property(properties, "endChr", node.right)
    _wrap("e", delimited, node.body)


def _render_array(node: Array, parent: ET.Element) -> None:
    array = _element("eqArr", parent)
    _element("eqArrPr", array)

    for row in node.rows:
        element = _element("e", array)
        for index, cell in enumerate(row):
            # `&` becomes an alignment run: OMML lines rows up at these rather than at a
            # column index, which is what makes a derivation's equals signs stack.
            if index > 0:
                run = _element("r", element)
                _element("aln", _element("rPr", run))
            _render(cell, element)


def _render_accent(node: Accent, parent: ET.Element) -> None:
    accent = _element("acc", parent)
    properties = _element("accPr", accent)
    _property(properties, "chr", node.mark)
    _wrap("e", accent, node.base)
