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
| `accurate` + `use_chart_recognition` | 76% | 51% | 54% | 13–176 s |

The first row was never a recognition failure, and finding that out changed what needed
fixing. PP-StructureV3 runs one page-wide OCR pass and separately assembles a Markdown
document from the layout blocks; a block labelled `chart` becomes an image reference, so its
text is dropped on the way out while remaining in `overall_ocr_res`. The txt and
searchable-PDF writers read the boxes and never lost it — which is why the same run scored 0%
and 97% depending only on which file you opened.

`chart_text.py` puts it back in the Markdown, using text that was already recognised and
paid for. That is the third row: no extra model, no extra inference, no measurable time.

The rows below it are the alternatives that cost something, kept because they answer a
different question. Both chart-recognition paths try to reconstruct the plotted *values* as
a table rather than transcribe the labels, which is why they score lower on a text inventory
while being the only options that can tell you a bar's height. PP-Chart2Table needs a
separate 1.4 GB model; `use_chart_recognition` on PaddleOCR-VL reuses the model already
loaded, and is the better of the two on the panel chart.

One caveat on all of these. Scoring is exact string match after case folding, so a real
misread — `How Bl Customers` for `How BI Customers` — counts as a complete miss. The figures
are a floor.

## Licensing

The textbook pages are from **Light and Matter** by Benjamin Crowell
(<https://www.lightandmatter.com/>), used under
[CC BY-SA 3.0](http://creativecommons.org/licenses/by-sa/3.0/) — excluding photographs and
drawings the author did not create, which that book lists in its own photo credits.

Recorded in `NOTICE` alongside the application's own third-party components.
