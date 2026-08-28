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
| `fast` | 0% | 30% | 0% | 0.5–10 s |
| `fast` + chart recognition | 58% | 54% | 63% | 26–56 s |
| `accurate` | 6% | 27% | 3% | 0.8–8 s |

The first row is not a recognition failure. With `chartRecognition` off, PP-StructureV3 files
the plot area as a figure and emits an `<img>` reference in its place, so the only text that
survives is the caption outside it — which is why the stacked bar, whose title sits inside the
frame, scores zero rather than low.

Two things worth knowing before choosing a profile for a chart-heavy document. **The engine
named "accurate" is the weakest of the three here**: PaddleOCR-VL is one end-to-end model with
no chart sub-model to enable, so there is no setting that improves it — the editor already
says so rather than offering switches that would do nothing. And chart recognition is
expensive in a way the "slower" tag understates: on this machine it added minutes of model
load and turned a half-second page into most of a minute.

Even at its best it reads about six strings in ten. That is worth having when the alternative
is none, and it is not a substitute for the chart's own data.

## Licensing

The textbook pages are from **Light and Matter** by Benjamin Crowell
(<https://www.lightandmatter.com/>), used under
[CC BY-SA 3.0](http://creativecommons.org/licenses/by-sa/3.0/) — excluding photographs and
drawings the author did not create, which that book lists in its own photo credits.

Recorded in `NOTICE` alongside the application's own third-party components.
