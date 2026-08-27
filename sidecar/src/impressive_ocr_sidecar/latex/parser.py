# SPDX-License-Identifier: AGPL-3.0-or-later
"""Parse the LaTeX subset PaddleOCR-VL emits into a :mod:`.nodes` tree.

Scope is set by what the engine actually produces, surveyed across a corpus: fractions, roots,
scripts, ``\\left``/``\\right`` groupings, ``aligned`` environments, the font-style commands and
a few hundred symbols. That is not most of LaTeX and is not meant to be.

The rule everywhere is that **nothing is ever dropped**. An unknown command becomes its own
letters, an unclosed group closes at the end of input, a stray brace is skipped. A formula
this cannot understand comes out looking wrong; it never comes out empty, and it never raises.
Recognised text that renders badly can still be read and corrected. Text that vanished cannot.
"""

from __future__ import annotations

from .nodes import Accent, Array, Delimited, Fraction, Node, Radical, Row, Script, Text
from .symbols import DELIMITERS, FONT_STYLES, FUNCTIONS, SPACING, symbol_for

#: Characters that are operators rather than variables, so they stay upright.
_UPRIGHT = frozenset("0123456789+-=<>()[]|,.;:!/*")

#: Accents, mapped to the combining-free character OMML puts in ``m:chr``.
_ACCENTS: dict[str, str] = {
    "vec": "⃗",
    "hat": "̂",
    "bar": "̅",
    "overline": "̅",
    "tilde": "̃",
    "dot": "̇",
    "ddot": "̈",
}

#: Environments treated as aligned rows. ``cases`` and ``matrix`` are close enough in shape
#: that rendering them as an equation array beats refusing them.
_ARRAY_ENVIRONMENTS = frozenset(
    {"aligned", "align", "align*", "gathered", "gather", "cases", "matrix", "array", "split"}
)


class _Scanner:
    """A cursor over the source, with the small lookaheads the grammar needs."""

    def __init__(self, source: str) -> None:
        self.source = source
        self.position = 0

    @property
    def done(self) -> bool:
        return self.position >= len(self.source)

    def peek(self) -> str:
        return "" if self.done else self.source[self.position]

    def take(self) -> str:
        char = self.peek()
        self.position += 1
        return char

    def skip_spaces(self) -> None:
        while not self.done and self.source[self.position] in " \t\n\r":
            self.position += 1

    def take_command(self) -> str:
        r"""Read the name after a backslash.

        A command is either letters (``\alpha``) or exactly one non-letter (``\{``, ``\\``,
        ``\,``). Getting that second case wrong is what turns ``\\`` — the row separator of
        an aligned block — into an escaped backslash and collapses every equation onto one line.
        """
        if self.done:
            return ""
        if not self.peek().isalpha():
            return self.take()

        start = self.position
        while not self.done and self.peek().isalpha():
            self.position += 1
        return self.source[start : self.position]

    def take_literal(self, text: str) -> bool:
        """Consume ``text`` if it is next, and report whether it was."""
        if self.source.startswith(text, self.position):
            self.position += len(text)
            return True
        return False


def parse(latex: str) -> Node:
    """Parse a formula. Never raises: malformed input degrades rather than failing."""
    scanner = _Scanner(latex)
    node = _parse_sequence(scanner, stop_at_brace=False)
    return node


def _parse_sequence(scanner: _Scanner, *, stop_at_brace: bool) -> Node:
    """Read nodes until a closing brace or the end, folding scripts onto their bases."""
    items: list[Node] = []

    while not scanner.done:
        char = scanner.peek()

        if char == "}":
            if stop_at_brace:
                scanner.take()
                break
            # A brace with nothing open. Skipping it is the only non-destructive option.
            scanner.take()
            continue

        if char in "^_":
            scanner.take()
            _attach_script(items, char, _parse_argument(scanner))
            continue

        node = _parse_one(scanner)
        if node is not None:
            items.append(node)

    return items[0] if len(items) == 1 else Row(tuple(items))


def _attach_script(items: list[Node], kind: str, argument: Node) -> None:
    """Fold a script onto the node before it, merging ``x^2_i`` into a single element."""
    base: Node = items.pop() if items else Row(())

    if isinstance(base, Script):
        # The second half of a sub-and-super pair. Keep whichever slot is still empty; a
        # repeated one would be a malformed formula, and overwriting loses less than nesting.
        subscript = argument if kind == "_" else base.subscript
        superscript = argument if kind == "^" else base.superscript
        items.append(Script(base.base, subscript, superscript))
        return

    items.append(
        Script(base, argument, None) if kind == "_" else Script(base, None, argument)
    )


def _parse_argument(scanner: _Scanner) -> Node:
    r"""Read one argument: a braced group, a command, or a single character.

    ``x^2`` and ``x^{2}`` mean the same thing, and so does ``x^\alpha``. Treating an argument
    as always braced is the commonest way to mis-parse a superscript.
    """
    scanner.skip_spaces()
    if scanner.done:
        return Row(())

    if scanner.peek() == "{":
        scanner.take()
        return _parse_sequence(scanner, stop_at_brace=True)

    node = _parse_one(scanner)
    return node if node is not None else Row(())


def _parse_one(scanner: _Scanner) -> Node | None:
    """Read exactly one node. None means the input was consumed without producing anything."""
    char = scanner.take()

    if char == "{":
        return _parse_sequence(scanner, stop_at_brace=True)
    if char == "\\":
        return _parse_command(scanner)
    if char == "~":
        return Text(" ", upright=True)
    if char in " \t\n\r":
        # Whitespace between tokens is layout, not content: LaTeX ignores it and so does Word.
        return None
    if char == "&":
        # Only meaningful inside an array, which consumes its own cells before reaching here.
        return None

    return Text(char, upright=char in _UPRIGHT)


def _parse_command(scanner: _Scanner) -> Node | None:
    name = scanner.take_command()

    if name == "frac" or name == "dfrac" or name == "tfrac":
        return Fraction(_parse_argument(scanner), _parse_argument(scanner))

    if name == "sqrt":
        degree = None
        if scanner.peek() == "[":
            scanner.take()
            degree = _parse_until(scanner, "]")
        return Radical(_parse_argument(scanner), degree)

    if name in FONT_STYLES:
        return _apply_style(_parse_argument(scanner), FONT_STYLES[name])

    if name in _ACCENTS:
        return Accent(_parse_argument(scanner), _ACCENTS[name])

    if name == "left":
        return _parse_delimited(scanner)

    if name == "right":
        # Reached only when the matching \left is missing. The delimiter itself is still
        # content, so it is kept rather than swallowed along with the command.
        return Text(_take_delimiter(scanner), upright=True)

    if name == "begin":
        return _parse_environment(scanner)

    if name == "end":
        _parse_until(scanner, "}") if scanner.take_literal("{") else None
        return None

    if name in SPACING:
        spacing = SPACING[name]
        return Text(spacing, upright=True) if spacing else None

    if name in FUNCTIONS:
        return Text(name, style="p")

    symbol = symbol_for(name)
    if symbol is not None:
        # Capital Greek is upright in every typesetting convention worth following; lowercase
        # is italic, which is already OMML's default for a letter.
        return Text(symbol, upright=symbol in "ΓΔΘΛΞΠΣΥΦΨΩ")

    if not name:
        return None

    # Unrecognised: the OCR misread a command, or it is outside this subset. Its letters are
    # still the best guess at what was on the page.
    return Text(name)


def _apply_style(node: Node, style: str) -> Node:
    """Push a font style down to the text runs, which is where OMML carries it."""
    if isinstance(node, Text):
        # Bold has to be stated on operators too; plain does not, since they are upright
        # already and marking them would fight Word's own handling of the surrounding style.
        upright = node.upright and style != "b"
        return Text(node.value, style=style, upright=upright)
    if isinstance(node, Row):
        return Row(tuple(_apply_style(item, style) for item in node.items))
    return node


def _parse_delimited(scanner: _Scanner) -> Node:
    r"""Parse ``\left( … \right)`` into one growing-bracket group."""
    left = _take_delimiter(scanner)
    body_items: list[Node] = []

    while not scanner.done:
        if scanner.take_literal("\\right"):
            return Delimited(_collapse(body_items), left, _take_delimiter(scanner))

        char = scanner.peek()
        if char == "}":
            # The group ended inside an enclosing brace: \right is missing. Close it here
            # rather than consuming the rest of the formula looking for one.
            break
        if char in "^_":
            scanner.take()
            _attach_script(body_items, char, _parse_argument(scanner))
            continue

        node = _parse_one(scanner)
        if node is not None:
            body_items.append(node)

    return Delimited(_collapse(body_items), left, "")


def _take_delimiter(scanner: _Scanner) -> str:
    """Read the delimiter after ``\\left`` or ``\\right``."""
    scanner.skip_spaces()
    if scanner.done:
        return ""

    if scanner.peek() == "\\":
        scanner.take()
        name = scanner.take_command()
        return DELIMITERS.get(f"\\{name}", "")

    char = scanner.take()
    return DELIMITERS.get(char, char)


def _parse_environment(scanner: _Scanner) -> Node | None:
    r"""Parse ``\begin{aligned} … \end{aligned}`` into rows of cells."""
    if not scanner.take_literal("{"):
        return None
    name = _raw_until(scanner, "}")

    if name not in _ARRAY_ENVIRONMENTS:
        # An environment outside the subset. Its body is still content, so it is parsed as an
        # ordinary sequence and only the wrapper is lost.
        return _parse_sequence(scanner, stop_at_brace=False)

    if name == "array":
        # The column specification, which OMML has no use for.
        scanner.skip_spaces()
        if scanner.take_literal("{"):
            _raw_until(scanner, "}")

    rows: list[tuple[Node, ...]] = []
    cells: list[Node] = []
    current: list[Node] = []

    def end_cell() -> None:
        cells.append(_collapse(current))
        current.clear()

    def end_row() -> None:
        end_cell()
        rows.append(tuple(cells))
        cells.clear()

    while not scanner.done:
        if scanner.take_literal("\\end"):
            if scanner.take_literal("{"):
                _raw_until(scanner, "}")
            break

        if scanner.take_literal("\\\\"):
            end_row()
            continue

        if scanner.peek() == "&":
            scanner.take()
            end_cell()
            continue

        if scanner.peek() in "^_":
            kind = scanner.take()
            _attach_script(current, kind, _parse_argument(scanner))
            continue

        node = _parse_one(scanner)
        if node is not None:
            current.append(node)

    if current or cells:
        end_row()

    return Array(tuple(rows))


def _parse_until(scanner: _Scanner, closer: str) -> Node:
    """Parse nodes until ``closer``, which is consumed."""
    items: list[Node] = []
    while not scanner.done and scanner.peek() != closer:
        if scanner.peek() in "^_":
            kind = scanner.take()
            _attach_script(items, kind, _parse_argument(scanner))
            continue
        node = _parse_one(scanner)
        if node is not None:
            items.append(node)
    if not scanner.done:
        scanner.take()
    return _collapse(items)


def _raw_until(scanner: _Scanner, closer: str) -> str:
    """Read raw characters up to ``closer``, for the parts that are names rather than maths."""
    start = scanner.position
    while not scanner.done and scanner.peek() != closer:
        scanner.position += 1
    text = scanner.source[start : scanner.position]
    if not scanner.done:
        scanner.take()
    return text


def _collapse(items: list[Node]) -> Node:
    """A one-item sequence is that item; anything else is a row."""
    return items[0] if len(items) == 1 else Row(tuple(items))
