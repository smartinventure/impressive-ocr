# SPDX-License-Identifier: AGPL-3.0-or-later
"""LaTeX to OMML, so recognised mathematics survives into a Word document.

The accurate engine reads typeset mathematics correctly and reports it as LaTeX. Word cannot
display LaTeX, so until this existed a .docx carried the source text — ``\\frac{v^{2}}{r}``
where the page had a fraction. The fast engine has the opposite problem: with no formula
recogniser it flattens the same fraction to ``v2ar =r``, losing the bar *and* the order.

This converts one to the other: a formula in, an ``m:oMath`` element out, which Word renders
as an equation with a real fraction bar.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET

from ..core.logging import get_logger
from .omml import M, register_namespace, to_omml
from .parser import parse

__all__ = ["M", "latex_to_omml", "register_namespace"]

_logger = get_logger()


def latex_to_omml(latex: str, *, display: bool) -> ET.Element | None:
    """Convert one formula, or return None if it cannot be represented.

    None rather than an exception, and never a partial element: the caller's fallback is to
    leave the original LaTeX in place as text, which is exactly what it should do when the
    conversion is not trustworthy. A formula that renders as nothing would be worse than one
    that renders as its own source.
    """
    stripped = latex.strip()
    if not stripped:
        return None

    try:
        element = to_omml(parse(stripped), display=display)
    except Exception:  # noqa: BLE001 - a bad formula must not fail the document
        _logger.warning(
            "Could not convert a formula to Word markup",
            extra={"latex": stripped[:80]},
        )
        return None

    # A formula that produced no runs at all converted to nothing, whatever the parser
    # thought. Falling back to the source text is the honest outcome.
    if element.find(f".//{{{M}}}t") is None:
        return None
    return element
