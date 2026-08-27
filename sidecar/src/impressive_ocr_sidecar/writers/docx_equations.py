# SPDX-License-Identifier: AGPL-3.0-or-later
"""Replace the LaTeX PaddleOCR leaves in a .docx with equations Word can draw.

PaddleOCR's ``save_to_word`` writes its Markdown through more or less verbatim, so a document
whose formulas were recognised perfectly arrives carrying ``$$\\frac{v^{2}}{r}$$`` as literal
text. The recognition was right; only the delivery was wrong.

A post-processing pass rather than a different writer: reproducing Paddle's reading-order and
table-to-HTML work to gain one feature would be a large amount of code guaranteed to drift
from upstream. Rewriting the paragraphs it produced stays correct however that writer changes.

**Paragraphs are spliced, not reserialised.** Re-emitting the whole document through
ElementTree was the obvious implementation and produces a file Word refuses to open: the root
element declares 35 namespaces and lists ten of them in ``mc:Ignorable``, and ElementTree
re-declares only the ones its tree happens to use, under prefixes of its own choosing. The
document survives; ``mc:Ignorable`` is left naming prefixes that no longer exist. Rewriting
only the paragraphs that changed leaves the root exactly as it was, byte for byte.
"""

from __future__ import annotations

import re
import shutil
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

from ..core.logging import get_logger
from ..latex import M, latex_to_omml, register_namespace

_logger = get_logger()

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
_DOCUMENT = "word/document.xml"

#: The document element, whose declarations every spliced paragraph is parsed against.
_ROOT_TAG = re.compile(r"<(\w+:)?document\b[^>]*>")

#: One paragraph. ``w:p`` cannot contain another, so a non-greedy match is exact. The negative
#: lookahead matters more than it looks: without it this also matches ``<w:pPr>``, and a
#: paragraph's properties are not a paragraph.
_PARAGRAPH = re.compile(r"<(\w+:)?p(?:\s[^>]*)?>.*?</(\w+:)?p>", re.DOTALL)

#: Namespace declarations on the root, so a spliced paragraph keeps the prefixes it arrived
#: with rather than being handed ``ns0:``.
_XMLNS = re.compile(r'xmlns:([A-Za-z0-9_.-]+)="([^"]*)"')

#: ``$$…$$`` first, so a display equation is never read as two inline ones sharing a middle.
#: Newline-aware, because an ``aligned`` block spans lines.
_MATH = re.compile(r"\$\$(.+?)\$\$|\$(.+?)\$", re.DOTALL)

#: Relations, which are what make a span of text an equation rather than a phrase.
_RELATION = re.compile(r"[=<>≤≥≈∝≠]")

#: Arithmetic. Weaker evidence than a relation — a range written "$5 - $10" contains one —
#: so it only counts alongside a letter to act on.
_ARITHMETIC = re.compile(r"[+\-−×÷⋅*/]")

#: Words no formula contains. The guard they back is against currency: "$5 and $10" puts
#: "5 and " between two dollar signs, and it has to stay text.
_PROSE = re.compile(r"\b(?:and|or|the|to|for|of|per|from|is|are|was|were)\b", re.IGNORECASE)


def embed_equations(path: Path) -> bool:
    """Rewrite ``path`` in place. Returns whether anything changed.

    Never raises. A document that cannot be rewritten is left exactly as it was, which is the
    behaviour before this existed: the formulas read as LaTeX source, which is ugly and
    complete. Losing a document to an exception in a cosmetic pass is not a trade worth making.
    """
    try:
        return _rewrite(path)
    except Exception as error:  # noqa: BLE001 - cosmetic pass, never fatal
        _logger.warning(
            "Could not convert formulas to Word equations; the LaTeX was left as text",
            extra={"path": str(path), "error": str(error)},
        )
        return False


def _rewrite(path: Path) -> bool:
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if _DOCUMENT not in names:
            return False
        entries = {name: archive.read(name) for name in names}

    document = entries[_DOCUMENT].decode("utf-8")
    rewritten, converted = rewrite_document_xml(document)
    if converted == 0:
        return False

    entries[_DOCUMENT] = rewritten.encode("utf-8")

    # Written beside the original and moved into place, so an interrupted rewrite cannot leave
    # a truncated .docx where a complete one used to be.
    staging = path.with_suffix(".equations.docx")
    with zipfile.ZipFile(staging, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in names:
            archive.writestr(name, entries[name])
    shutil.move(str(staging), str(path))

    _logger.info(
        "Converted formulas to Word equations",
        extra={"count": converted, "path": str(path)},
    )
    return True


def rewrite_document_xml(document: str) -> tuple[str, int]:
    """Convert every LaTeX formula in a ``word/document.xml``.

    Returns the new XML and how many formulas were converted. Exported separately from the
    zip handling so the interesting half can be tested on a string.
    """
    root_match = _ROOT_TAG.search(document)
    if root_match is None:
        return document, 0

    root_tag = root_match.group(0)
    register_namespace()
    for prefix, uri in _XMLNS.findall(root_tag):
        ET.register_namespace(prefix, uri)

    converted = 0
    pieces: list[str] = []
    position = 0

    for match in _PARAGRAPH.finditer(document):
        if "$" not in match.group(0):
            continue

        replacement, count = _convert_paragraph_xml(match.group(0), root_tag)
        if count == 0:
            continue

        pieces.append(document[position : match.start()])
        pieces.append(replacement)
        position = match.end()
        converted += count

    if converted == 0:
        return document, 0

    pieces.append(document[position:])
    return "".join(pieces), converted


def _convert_paragraph_xml(paragraph_xml: str, root_tag: str) -> tuple[str, int]:
    """Convert one paragraph, given as XML. Returns the new XML and the formula count.

    Parsed inside a copy of the real document element so every prefix it uses is declared,
    then serialised back with that wrapper stripped — which is what keeps the result free of
    the redundant namespace declarations a standalone element would carry.
    """
    root_name = root_tag[1 : root_tag.index(" ")] if " " in root_tag else root_tag[1:-1]
    wrapper = ET.fromstring(f"{root_tag}{paragraph_xml}</{root_name}>")

    paragraph = wrapper[0]
    converted = _convert_paragraph(paragraph)
    if converted == 0:
        return paragraph_xml, 0

    serialised = ET.tostring(wrapper, encoding="unicode")
    inner = serialised[serialised.index(">") + 1 : serialised.rindex("</")]
    return inner, converted


def _convert_paragraph(paragraph: ET.Element) -> int:
    runs = [child for child in paragraph if child.tag == f"{{{W}}}r"]
    if not runs:
        return 0

    text = "".join(node.text or "" for run in runs for node in run.iter(f"{{{W}}}t"))
    if "$" not in text:
        return 0

    segments = _split(text)
    if not any(is_math and _is_formula(content) for content, is_math, _ in segments):
        return 0

    # A run's formatting — font, size, weight — is reused for the text this rebuilds, so a
    # heading that happens to contain a formula stays a heading.
    template = runs[0].find(f"{{{W}}}rPr")
    # Display rather than inline only when the paragraph is nothing but one equation: that is
    # how it sat on the page, and Word gives it its own centred line.
    display_allowed = len(segments) == 1

    rebuilt: list[ET.Element] = []
    converted = 0

    for content, is_math, was_display in segments:
        element = (
            latex_to_omml(content, display=was_display and display_allowed)
            if is_math and _is_formula(content)
            else None
        )
        if element is not None:
            rebuilt.append(element)
            converted += 1
            continue
        rebuilt.append(_text_run(_restore(content, is_math, was_display), template))

    if converted == 0:
        return 0

    _replace_runs(paragraph, rebuilt)
    return converted


def _is_formula(content: str) -> bool:
    r"""Is this ``$…$`` span mathematics, or two dollar signs in a sentence?

    The case that forces the question is currency: "I paid $5 and $10" puts "5 and " between
    two delimiters, and converting that produces an equation out of half a sentence. The cases
    that forbid simply demanding a backslash are ``$ PV = nkT $`` and ``$1 + by$`` — real
    formulas with no command and no script, recognisable only by an operator and a variable.

    So: a LaTeX command or a script settles it, a lone symbol like ``$m$`` settles it, and
    anything else needs an operator, a symbol to apply it to, and no English around it. That
    last clause is what keeps "5 and " and "5 - " out; both would otherwise qualify.
    """
    stripped = content.strip()
    if not stripped:
        return False
    if "\\" in stripped or "^" in stripped or "_" in stripped:
        return True
    if len(stripped) <= 2 and stripped.isalpha():
        return True
    if _PROSE.search(stripped):
        return False

    has_relation = bool(_RELATION.search(stripped))
    has_symbol = any(character.isalpha() for character in stripped)
    return has_relation or (has_symbol and bool(_ARITHMETIC.search(stripped)))


def _restore(content: str, is_math: bool, display: bool) -> str:
    """Put the delimiters back on a formula that could not be converted.

    Nothing is lost when the parser gives up: the paragraph reads exactly as it did before,
    which is a document carrying its own LaTeX rather than a gap where a formula was.
    """
    if not is_math:
        return content
    return f"$${content}$$" if display else f"${content}$"


def _split(text: str) -> list[tuple[str, bool, bool]]:
    """Break text into (content, is_math, is_display) segments."""
    segments: list[tuple[str, bool, bool]] = []
    position = 0

    for match in _MATH.finditer(text):
        if match.start() > position:
            segments.append((text[position : match.start()], False, False))
        display = match.group(1) is not None
        segments.append((match.group(1) or match.group(2) or "", True, display))
        position = match.end()

    if position < len(text):
        segments.append((text[position:], False, False))

    # Whitespace either side of a display equation is layout the equation now carries itself.
    return [
        segment
        for segment in segments
        if segment[1] or segment[0].strip() or len(segments) == 1
    ]


def _text_run(text: str, template: ET.Element | None) -> ET.Element:
    run = ET.Element(f"{{{W}}}r")
    if template is not None:
        run.append(_copy(template))
    node = ET.SubElement(run, f"{{{W}}}t")
    node.text = text
    if text != text.strip():
        node.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    return run


def _copy(element: ET.Element) -> ET.Element:
    clone = ET.Element(element.tag, dict(element.attrib))
    clone.text = element.text
    clone.tail = element.tail
    for child in element:
        clone.append(_copy(child))
    return clone


def _replace_runs(paragraph: ET.Element, rebuilt: list[ET.Element]) -> None:
    """Swap the paragraph's runs for the new mix of runs and equations, keeping everything else.

    Only ``w:r`` children are touched. Properties, bookmarks, hyperlinks and images stay where
    they are — a figure whose caption contains a formula must not lose the figure.
    """
    insert_at: int | None = None
    for index, child in enumerate(list(paragraph)):
        if child.tag == f"{{{W}}}r":
            if insert_at is None:
                insert_at = index
            paragraph.remove(child)

    position = insert_at if insert_at is not None else len(paragraph)
    for offset, element in enumerate(rebuilt):
        paragraph.insert(position + offset, element)


__all__ = ["M", "embed_equations", "rewrite_document_xml"]
