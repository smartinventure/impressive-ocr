"""Score the two chart-to-table paths against charts whose values we chose.

The measure is per cell: for each category the chart plots, does the extracted table carry
that category's values? Matched as a multiset per row rather than by column position, which
is deliberately generous -- a model that gets every number right but orders or names the
series differently should still pass, because a person reading the table could use it.
"""

from __future__ import annotations

import difflib
import json
import os
import re
import sys
import warnings
from pathlib import Path

HERE = Path(__file__).parent
DATA = Path(r"D:\_PROGRAMMING_SourceTree\.impressive-ocr-data")
cache = DATA / "runtime" / "models"
os.environ.setdefault("PADDLE_PDX_CACHE_HOME", str(cache))
os.environ.setdefault("PADDLE_PDX_MODEL_SOURCE", "huggingface")
os.environ.setdefault("HF_HOME", str(cache / "huggingface"))
warnings.filterwarnings("ignore")


def rows_from(text: str) -> dict[str, list[float]]:
    """Every table row, as label -> numbers, from Markdown pipe tables or HTML."""
    rows: dict[str, list[float]] = {}

    for line in text.splitlines():
        line = line.strip()
        if line.startswith("|") and line.count("|") >= 3:
            cells = [c.strip() for c in line.strip("|").split("|")]
            if not cells or set(cells[0]) <= set("-: "):
                continue
            numbers = [float(m) for c in cells[1:] for m in re.findall(r"-?\d+\.?\d*", c)[:1]]
            if numbers:
                rows[cells[0].lower()] = numbers

    for match in re.finditer(r"<tr>(.*?)</tr>", text, re.DOTALL | re.IGNORECASE):
        cells = [
            re.sub(r"<[^>]+>", "", c).strip()
            for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", match.group(1), re.DOTALL | re.IGNORECASE)
        ]
        if not cells:
            continue
        numbers = [float(m) for c in cells[1:] for m in re.findall(r"-?\d+\.?\d*", c)[:1]]
        if numbers:
            rows[cells[0].lower()] = numbers

    return rows


def _orientation_score(labels: list[str], wanted: dict[str, list[float]], rows: dict) -> tuple:
    """How many of the wanted values appear in the row each label names."""
    hit, total, detail = 0, 0, []
    for label in labels:
        expected = sorted(wanted[label])
        total += len(expected)
        match = difflib.get_close_matches(label.lower(), list(rows), n=1, cutoff=0.6)
        got = sorted(rows[match[0]]) if match else []
        remaining = list(got)
        found = 0
        for value in expected:
            if value in remaining:
                remaining.remove(value)
                found += 1
        hit += found
        detail.append(f"{label}: want {expected} got {got or '-'}")
    return hit, total, detail


def score(truth: dict, text: str) -> dict:
    """Best of both orientations.

    A table with the categories down the side and one with the series down the side carry the
    same information; a reader would use either. Scoring only the first would fail a model for
    a choice that costs nobody anything.
    """
    rows = rows_from(text)
    categories = truth["categories"]
    series = truth["series"]

    by_category = {
        category: [float(values[index]) for values in series.values()]
        for index, category in enumerate(categories)
    }
    by_series = {label: [float(v) for v in values] for label, values in series.items()}

    candidates = [
        _orientation_score(categories, by_category, rows),
        _orientation_score(list(series), by_series, rows),
    ]
    hit, total, detail = max(candidates, key=lambda c: c[0])

    return {
        "cells": total,
        "correct": hit,
        "accuracy": round(100 * hit / total, 1) if total else 0.0,
        "rows_found": len(rows),
        "detail": detail,
    }


def extract(engine: str, image: Path) -> str:
    if engine == "chart2table":
        from paddleocr import PPStructureV3

        pipeline = PPStructureV3(device="gpu", use_chart_recognition=True)
        results = pipeline.predict(str(image), use_chart_recognition=True)
    else:
        from paddleocr import PaddleOCRVL

        pipeline = PaddleOCRVL(device="gpu")
        results = pipeline.predict(str(image), use_chart_recognition=True)

    text = ""
    for result in results:
        markdown = getattr(result, "markdown", None)
        if isinstance(markdown, dict):
            text += str(markdown.get("markdown_texts", ""))
    return text


def main() -> None:
    engine = sys.argv[1] if len(sys.argv) > 1 else "vl"
    print(f"== {engine} ==", flush=True)

    pattern = sys.argv[2] if len(sys.argv) > 2 else "synth-*.json"
    for truth_path in sorted(HERE.glob(pattern)):
        image = truth_path.with_suffix(".png")
        truth = json.loads(truth_path.read_text(encoding="utf-8"))
        text = extract(engine, image)
        (HERE / f"out-{engine}-{image.stem}.txt").write_text(text, encoding="utf-8")

        result = score(truth, text)
        print(
            f"\n{image.stem:22} {result['correct']}/{result['cells']} cells"
            f" = {result['accuracy']}%   (rows parsed: {result['rows_found']})",
            flush=True,
        )
        for line in result["detail"]:
            print("   ", line, flush=True)


if __name__ == "__main__":
    main()
