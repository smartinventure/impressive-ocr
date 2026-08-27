# SPDX-License-Identifier: AGPL-3.0-or-later
"""The tree a LaTeX formula is parsed into, before it becomes OMML.

An intermediate representation rather than translating LaTeX straight to XML, because the two
disagree about shape: LaTeX writes ``x^2_i`` as three sibling tokens where OMML needs one
``sSubSup`` element holding all three, and ``\\left(`` and ``\\right)`` are separate tokens for
one ``m:d``. Rearranging that in a tree is straightforward; doing it while emitting XML is not.

Frozen dataclasses, so a parsed formula can be compared in a test by writing the expected tree
out literally.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Text:
    """A literal run. ``style`` is an OMML ``m:sty`` value, or None for the default."""

    value: str
    style: str | None = None
    #: True for a character that must never be italicised whatever the surrounding style —
    #: an operator, a digit, a bracket. Word italicises letters by default and leaves these
    #: alone, but inside \\mathbf we have to say so explicitly.
    upright: bool = False


@dataclass(frozen=True)
class Row:
    """A sequence of nodes, which is what a group or an argument parses to."""

    items: tuple[Node, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class Fraction:
    numerator: Node
    denominator: Node


@dataclass(frozen=True)
class Radical:
    radicand: Node
    #: None for a square root, which OMML draws by hiding the degree rather than by omitting
    #: the element.
    degree: Node | None = None


@dataclass(frozen=True)
class Script:
    """A base carrying a subscript, a superscript, or both."""

    base: Node
    subscript: Node | None = None
    superscript: Node | None = None


@dataclass(frozen=True)
class Delimited:
    """A group in brackets that grow with their contents."""

    body: Node
    left: str = "("
    right: str = ")"


@dataclass(frozen=True)
class Array:
    """Aligned equations: rows of cells, split on ``\\\\`` and ``&``."""

    rows: tuple[tuple[Node, ...], ...]


@dataclass(frozen=True)
class Accent:
    """A mark set over its base — ``\\vec``, ``\\hat``, ``\\bar``, ``\\dot``."""

    base: Node
    mark: str


Node = Text | Row | Fraction | Radical | Script | Delimited | Array | Accent
