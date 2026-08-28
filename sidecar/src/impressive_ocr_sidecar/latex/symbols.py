# SPDX-License-Identifier: AGPL-3.0-or-later
"""LaTeX command names mapped to the characters Word will render.

Deliberately not a complete LaTeX table. It covers what PaddleOCR-VL actually emits, which is
a narrow and stable subset: Greek letters, the arithmetic and relational operators, a handful
of set and calculus symbols, and the named functions. Everything outside it degrades to its
own name rather than disappearing, which is the behaviour that matters — an unrecognised
command in a physics paper should read as ``\\foo``'s letters, never as nothing at all.
"""

from __future__ import annotations

#: Greek, in both cases. The capitals Word wants upright; the lowercase italic, which is the
#: OMML default, so only the capitals carry a style below.
GREEK: dict[str, str] = {
    "alpha": "α",
    "beta": "β",
    "gamma": "γ",
    "delta": "δ",
    "epsilon": "ϵ",
    "varepsilon": "ε",
    "zeta": "ζ",
    "eta": "η",
    "theta": "θ",
    "vartheta": "ϑ",
    "iota": "ι",
    "kappa": "κ",
    "lambda": "λ",
    "mu": "μ",
    "nu": "ν",
    "xi": "ξ",
    "pi": "π",
    "rho": "ρ",
    "sigma": "σ",
    "tau": "τ",
    "upsilon": "υ",
    "phi": "ϕ",
    "varphi": "φ",
    "chi": "χ",
    "psi": "ψ",
    "omega": "ω",
    "Gamma": "Γ",
    "Delta": "Δ",
    "Theta": "Θ",
    "Lambda": "Λ",
    "Xi": "Ξ",
    "Pi": "Π",
    "Sigma": "Σ",
    "Upsilon": "Υ",
    "Phi": "Φ",
    "Psi": "Ψ",
    "Omega": "Ω",
}

#: Operators, relations and the rest of the punctuation of mathematics.
OPERATORS: dict[str, str] = {
    "times": "×",
    "div": "÷",
    "pm": "±",
    "mp": "∓",
    "cdot": "⋅",
    "cdots": "⋯",
    "ldots": "…",
    "dots": "…",
    "vdots": "⋮",
    "ddots": "⋱",
    "circ": "°",
    "degree": "°",
    "ast": "∗",
    "star": "⋆",
    "bullet": "∙",
    "leq": "≤",
    "le": "≤",
    "geq": "≥",
    "ge": "≥",
    "neq": "≠",
    "ne": "≠",
    "approx": "≈",
    "sim": "∼",
    "simeq": "≃",
    "equiv": "≡",
    "propto": "∝",
    "ll": "≪",
    "gg": "≫",
    "infty": "∞",
    "partial": "∂",
    "nabla": "∇",
    "int": "∫",
    "iint": "∬",
    "oint": "∮",
    "sum": "∑",
    "prod": "∏",
    "sqrt": "√",
    "angle": "∠",
    "perp": "⊥",
    "parallel": "∥",
    "in": "∈",
    "notin": "∉",
    "subset": "⊂",
    "cup": "∪",
    "cap": "∩",
    "emptyset": "∅",
    "forall": "∀",
    "exists": "∃",
    "rightarrow": "→",
    "to": "→",
    "leftarrow": "←",
    "Rightarrow": "⇒",
    "leftrightarrow": "↔",
    "hbar": "ℏ",
    "ell": "ℓ",
    "prime": "′",
    "%": "%",
    "$": "$",
    "&": "&",
    "#": "#",
    "_": "_",
    "{": "{",
    "}": "}",
}

#: Named functions. Upright, always: ``cos`` set in italics reads as c times o times s.
FUNCTIONS: frozenset[str] = frozenset(
    {
        "arccos", "arcsin", "arctan", "cos", "cosh", "cot", "coth", "csc", "deg", "det",
        "dim", "exp", "gcd", "hom", "inf", "ker", "lg", "lim", "ln", "log", "max", "min",
        "sec", "sin", "sinh", "sup", "tan", "tanh",
    }
)

#: Spacing commands, and how wide each one is. ``\!`` is negative space, which OMML has no
#: representation for, so it collapses to nothing rather than to a space that would be wrong
#: in the other direction.
SPACING: dict[str, str] = {
    " ": " ",
    ",": " ",
    ":": " ",
    ";": " ",
    "!": "",
    "quad": " ",
    "qquad": "  ",
    "thinspace": " ",
    "enspace": " ",
}

#: ``\mathrm`` and friends, mapped onto OMML's ``m:sty`` values: p plain, b bold, i italic,
#: bi bold-italic. Anything that only changes the typeface rather than the weight or slope —
#: ``\mathcal``, ``\mathbb`` — is deliberately absent: Word would need a font we cannot
#: guarantee is installed, and plain upright is a better wrong answer than a missing glyph.
FONT_STYLES: dict[str, str] = {
    "mathrm": "p",
    "operatorname": "p",
    "text": "p",
    "textrm": "p",
    "mathbf": "b",
    "textbf": "b",
    "boldsymbol": "bi",
    "mathit": "i",
    "textit": "i",
    "mathsf": "p",
    "mathtt": "p",
    "mathnormal": "i",
}

#: Delimiters ``\left`` and ``\right`` accept, mapped to the character Word should draw.
#: ``.`` means "no delimiter on this side", which LaTeX uses for one-sided groupings.
DELIMITERS: dict[str, str] = {
    "(": "(",
    ")": ")",
    "[": "[",
    "]": "]",
    "\\{": "{",
    "\\}": "}",
    "|": "|",
    "\\|": "‖",
    "\\langle": "⟨",
    "\\rangle": "⟩",
    "\\lfloor": "⌊",
    "\\rfloor": "⌋",
    "\\lceil": "⌈",
    "\\rceil": "⌉",
    ".": "",
}


def symbol_for(command: str) -> str | None:
    """The character a command produces, or None if this table does not know it."""
    if command in GREEK:
        return GREEK[command]
    return OPERATORS.get(command)
