"""Draw charts from values we choose, so the answer key is exact rather than eyeballed.

The three hand-written samples cannot settle whether a chart-to-table model reads values
correctly: nobody knows what the true numbers are, and estimating them off a 576px stacked
bar would mean scoring the models against a guess. Drawing the chart from a table we already
have removes that problem entirely -- the ground truth is the input.

Deliberately easy charts. Few categories, few series, values well separated, gridlines and
tick labels present. If a model cannot read these it will not read a real one, and if it can,
that tells us the failure on the Gartner charts is about density rather than about the idea.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Literal

import pymupdf

OUT = Path(__file__).parent

WIDTH, HEIGHT = 720.0, 480.0
PLOT = (90.0, 60.0, 660.0, 380.0)  # x0, y0, x1, y1
PALETTE = [(0.16, 0.40, 0.72), (0.85, 0.42, 0.15), (0.30, 0.62, 0.30)]

Variant = Literal["labelled", "bare"]

CHARTS = {
    "synth-bar-single": {
        "title": "Units Shipped by Region",
        "categories": ["North", "South", "East", "West", "Central"],
        "series": {"Units": [40, 65, 25, 80, 55]},
        "y_max": 100,
    },
    "synth-bar-grouped": {
        "title": "Revenue by Quarter",
        "categories": ["Q1", "Q2", "Q3", "Q4"],
        "series": {"Hardware": [30, 45, 60, 75], "Software": [50, 40, 35, 20]},
        "y_max": 80,
    },
    "synth-bar-three": {
        "title": "Support Tickets by Month",
        "categories": ["Jan", "Feb", "Mar"],
        "series": {"Open": [20, 35, 15], "Closed": [60, 45, 70], "Pending": [10, 25, 40]},
        "y_max": 80,
    },
}


def draw(name: str, spec: dict, variant: Variant) -> None:
    doc = pymupdf.open()
    page = doc.new_page(width=WIDTH, height=HEIGHT)
    x0, y0, x1, y1 = PLOT

    page.insert_text((x0, 38), spec["title"], fontname="hebo", fontsize=16)

    # Y axis: gridline and label at every step, so the scale is unambiguous.
    y_max = spec["y_max"]
    step = y_max // 4
    for value in range(0, y_max + 1, step):
        y = y1 - (value / y_max) * (y1 - y0)
        page.draw_line((x0, y), (x1, y), color=(0.85, 0.85, 0.85), width=0.5)
        page.insert_text((x0 - 34, y + 4), str(value), fontsize=11)

    page.draw_line((x0, y0), (x0, y1), color=(0, 0, 0), width=1)
    page.draw_line((x0, y1), (x1, y1), color=(0, 0, 0), width=1)

    categories = spec["categories"]
    series = spec["series"]
    slot = (x1 - x0) / len(categories)
    bar_width = slot * 0.7 / len(series)

    for index, category in enumerate(categories):
        base = x0 + index * slot + slot * 0.15
        for order, (label, values) in enumerate(series.items()):
            value = values[index]
            height = (value / y_max) * (y1 - y0)
            left = base + order * bar_width
            rect = pymupdf.Rect(left, y1 - height, left + bar_width, y1)
            page.draw_rect(rect, color=None, fill=PALETTE[order % len(PALETTE)])
            # Printed only for the labelled variant. Without it the model has to measure the
            # bar against the axis, which is the thing a chart-to-table model claims to do --
            # with the number printed, succeeding only proves it can read.
            if variant == "labelled":
                page.insert_text(
                    (left + 2, y1 - height - 5), str(value), fontsize=10, fontname="hebo"
                )
        page.insert_text((base + slot * 0.15, y1 + 18), category, fontsize=12)

    # Legend, one entry per series, below the plot.
    legend_x = x0
    for order, label in enumerate(series):
        swatch = pymupdf.Rect(legend_x, y1 + 40, legend_x + 14, y1 + 52)
        page.draw_rect(swatch, color=None, fill=PALETTE[order % len(PALETTE)])
        page.insert_text((legend_x + 20, y1 + 51), label, fontsize=12)
        legend_x += 150

    pixmap = page.get_pixmap(dpi=150)
    pixmap.save(str(OUT / f"{name}.png"))
    doc.close()

    truth = {
        "title": spec["title"],
        "categories": categories,
        "series": series,
        "values": {
            label: dict(zip(categories, values, strict=True)) for label, values in series.items()
        },
    }
    (OUT / f"{name}.json").write_text(json.dumps(truth, indent=2), encoding="utf-8")
    print(f"  {name}.png  {len(categories)} categories x {len(series)} series")


if __name__ == "__main__":
    variant: Variant = "bare" if "--bare" in sys.argv else "labelled"
    suffix = "" if variant == "labelled" else "-bare"
    print(f"drawing charts from known values ({variant}):")
    for chart_name, chart_spec in CHARTS.items():
        draw(chart_name + suffix, chart_spec, variant)
