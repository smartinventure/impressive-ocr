# samples/

Benchmark material for the OCR measurements in the root `README.md`. **Not** part of the
application and not shipped with it — nothing in `apps/` or `sidecar/` reads this directory.

## Why these files are here

Every published accuracy figure needs a reference to be measured against, and a claim nobody
can reproduce is not much of a claim. The PDFs under `pdfs-with-text/` are born-digital, so
each page carries its own text layer: rendering a page to an image and OCR'ing it produces a
result that can be scored against text the file already knows it contains. That is ground
truth for free, and it is why those files are worth keeping.

| | |
|---|---|
| `pdfs-with-text/` | Born-digital. The text layer is the reference. |
| `pdfs-with-graphics/` | Image-only, no text layer, so no automatic reference. |
| `charts/` | Chart images with a hand-written text inventory in a matching `.md`. |
| `charts-synthetic/` | Charts drawn from known values. The answer key is the input. |
| `stamp-seal.png` | Seal artwork, transcribed by hand in `seal-truth.json`. |
| `text-truth.json` | Extracted text layers, regenerated from the PDFs. |
| `rendered/`, `all-*/` | Rendered pages. Derived, gitignored, regenerable. |

## What `charts/` is for

A chart is the case the born-digital PDFs cannot cover. Their text layers give OCR long lines
of prose with context on every side; a chart gives it 7pt vendor names in colour, axis ticks,
and a legend split across two columns, with nothing nearby to make a bad guess recoverable.
The `.md` beside each image lists every string a reader can see in it, so the question these
score is recall: of the text that is there, how much came out?

They are read by hand, not generated, which is why there are three of them and not thirty.

### What they measured

Recall over the three images, each string counted once, matched case-insensitively:

| Configuration | Panels | Dot plot | Stacked bar | Per chart |
|---|---|---|---|---|
| `fast`, Markdown, before the recovery below | 0% | 30% | 0% | 0.5–5 s |
| `fast`, txt and searchable PDF | 97% | 95% | 94% | 0.5–5 s |
| **`fast`, Markdown, now** | **97%** | **95%** | **94%** | **0.5–5 s** |
| `fast` + chart recognition (PP-Chart2Table) | 58% | 54% | 63% | 26–56 s |
| `accurate` | 6% | 27% | 3% | 0.7–7 s |
| `accurate` + extract chart data | 76% | 51% | 54% | 13–176 s |

The first row was never a recognition failure, and finding that out changed what needed
fixing. PP-StructureV3 runs one page-wide OCR pass and separately assembles a Markdown
document from the layout blocks; a block labelled `chart` becomes an image reference, so its
text is dropped on the way out while remaining in `overall_ocr_res`. The txt and
searchable-PDF writers read the boxes and never lost it — which is why the same run scored 0%
and 97% depending only on which file you opened.

`chart_text.py` puts it back, using text that was already recognised and paid for. That is
the third row: no extra model, no extra inference, no measurable time.

It is applied by the Markdown *writer*, not by the result adapter, and the difference is not
academic. `save_to_markdown` writes the file itself from Paddle's raw result and never reads
`PageResult.markdown`, so the first version of this fix passed every unit test and changed
nothing about the document anyone opened. What caught it was running a chart through the
application and finding 117 bytes of Markdown beside 533 bytes of txt from the same job.

The rows below it are the alternatives that cost something, kept because they answer a
different question. Both chart-data paths try to reconstruct the plotted *values* as a table
rather than transcribe the labels, which is why they score lower on a text inventory while
being the only options that can tell you a bar's height. PP-Chart2Table needs a separate
1.4 GB model; PaddleOCR-VL reuses the model already loaded, and is the better of the two on
the panel chart.

The last row was unreachable until recently, and the reason is worth recording. The sidecar
forwarded no module toggles to PaddleOCR-VL at all, so the switch was inert on that profile
and the profile looked incapable of charts when it had simply never been asked. It is
forwarded at predict time rather than construction, because `EngineCache` pins an engine for
the life of the process and a constructor argument cannot follow a per-pipeline setting.

### Charts inside a page, not cropped to one

`rendered/charts-p01.png` and `-p02.png` are the harder shape and are what the geometry was
tested against: a page of body prose with a small plot in the corner. Of 78 and 96 recognised
boxes on those pages, 8 and 16 fall inside the chart region, and no body text is drawn in —
including the rotated y-axis title, whose box centre lands inside the region despite the
text reading sideways.

They also caught a bug the three cropped charts could not. Suppressing any string already
present in the Markdown is right for a chart's title and wrong for an axis tick: `0`, `5` and
`10` collide with the prose of almost any page, and skipping them removed the whole scale of
the plot. Dedup now applies only from four characters up.

One caveat on all of these. Scoring is exact string match after case folding, so a real
misread — `How Bl Customers` for `How BI Customers` — counts as a complete miss. The figures
are a floor.

## What `charts-synthetic/` is for

Reading a chart's labels and reading its *values* are different jobs, and the hand-written
inventories can only score the first. Nobody knows what the true numbers behind the Gartner
charts are, and estimating them off the pixels would mean scoring a model against a guess.

So these are drawn from a table we already have, by `make_charts.py`. The ground truth is the
input, exact by construction. Each chart exists twice: once with the value printed above each
bar, and a `-bare` variant without. That pair is the whole point — with the numbers printed,
a model can score full marks by reading them, and only the bare variant asks whether it can
measure a bar against an axis.

`score.py <engine> "synth-*-bare.json"` runs one of the two chart-to-table paths and scores
each cell, accepting either orientation of the table.

### What they settled

Per-cell accuracy over the three charts, 22 values:

| Model | Values printed | **Bare** |
|---|---|---|
| PaddleOCR-VL (`accurate`) | 22/22 | **21/22** |
| PP-Chart2Table (was `fast`) | 22/22 | **3/22** |

Both look perfect until the printed labels come off. PP-Chart2Table then returns
`6.5, 8.5, 5.0, 9.0, 7.0` for bars of `40, 65, 25, 80, 55` — the right shape on a scale it
invented — which is how we know its full marks came from reading the numbers rather than
measuring the plot. PaddleOCR-VL measures: its single miss is 68 for 65 on a 0–100 axis.

That is why the fast engine no longer offers chart data and no longer downloads
PP-Chart2Table's 1.4 GB. Chart *text* is unaffected on both engines — it needs no model and
no switch.

The honest limit: these are easy charts, three or fewer series. Neither model produces usable
values for the 19-category, 8-series charts in `charts/`, and both fail there *silently*, by
emitting a plausible table of wrong numbers.

## Licensing

The textbook pages are from **Light and Matter** by Benjamin Crowell
(<https://www.lightandmatter.com/>), used under
[CC BY-SA 3.0](http://creativecommons.org/licenses/by-sa/3.0/) — excluding photographs and
drawings the author did not create, which that book lists in its own photo credits.

Recorded in `NOTICE` alongside the application's own third-party components.
