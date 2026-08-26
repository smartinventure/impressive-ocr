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
| `stamp-seal.png` | Seal artwork, transcribed by hand in `seal-truth.json`. |
| `text-truth.json` | Extracted text layers, regenerated from the PDFs. |
| `rendered/`, `all-*/` | Rendered pages. Derived, gitignored, regenerable. |

## Licensing

The textbook pages are from **Light and Matter** by Benjamin Crowell
(<https://www.lightandmatter.com/>), used under
[CC BY-SA 3.0](http://creativecommons.org/licenses/by-sa/3.0/) — excluding photographs and
drawings the author did not create, which that book lists in its own photo credits.

Recorded in `NOTICE` alongside the application's own third-party components.
