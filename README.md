# Impressive OCR

A local-first OCR workstation. It watches folders, queues whatever lands in them, and turns
scanned documents into Markdown, JSON, plain text, Word, Excel, HTML or a searchable PDF —
using [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) on your own machine.

Nothing is uploaded. There is no account, no cloud service and no telemetry. Documents are
usually the last thing anyone wants to hand to a third party, and scanned mail, invoices and
contracts are exactly the material this is built for.

Ships as a **desktop app** for Windows, macOS and Linux, and as a **headless server** — the
same backend either way, so a spare machine can do the processing while everyone else uses a
browser.

## What it does

- **Watched folders.** Point it at a directory; anything dropped in gets processed. Files are
  queued, retried with backoff, and quarantined if they keep failing.
- **Quick Mode.** Drag a handful of files in for a one-off conversion, without configuring
  anything. Upload from a browser and get a ZIP back, or process files already on the machine.
- **Output formats.** Markdown, JSON, plain text, DOCX, XLSX, HTML, searchable PDF, and an
  overlay image showing what was detected. Any combination, per pipeline.
- **Layout aware.** Tables, formulas, charts and seals are separate recognisers you can switch
  on and off — they cost time, so they are opt-in.
- **Existing text layers.** A PDF that already contains text can be passed through, skipped, or
  re-OCRed. The hybrid default only processes the pages that need it.
- **After processing.** Leave the original alone, delete it, or move it to an archive folder.

## Two engines

| | Fast | Accurate |
|---|---|---|
| Model | PP-StructureV3 + PP-OCRv6 | PaddleOCR-VL (0.9B vision-language) |
| Good at | letters, invoices, forms, single-column text | magazines, newspapers, columns, tables, difficult scans |
| On a desktop GPU | ~3.5 s/page | **~2 s/page** |
| On CPU only | ~100 s/page | **~11 s/page** |

They fail differently, and that matters more than the speed. The fast engine reads characters
well and reconstructs page *structure* less reliably: on a multi-column page it can interleave
columns and tear a drop capital off its word. The accurate engine rebuilds reading order.

Accurate is now the faster of the two as well as the better one, on either kind of machine.
Fast remains for its specialised table, formula, chart and seal recognisers, and for anyone
who prefers a smaller install.

## How accurate is it?

Measured on a dense German magazine page — two columns, a drop capital, a photograph, 637
words — against a hand-checked reference transcript.

| Output | Word accuracy | Bag recall | Reading-order loss |
|---|---|---|---|
| Fast | 95.1% | 97.2% | 2.0 pts |
| **Accurate** | **98.4%** | **98.7%** | **0.3 pts** |

Two numbers, because either alone misleads. **Word accuracy** is order-sensitive — one minus
the word edit distance against the reference. **Bag recall** ignores order entirely: how much
of the page was read at all, wherever it ended up. The gap between them is what reading-order
damage costs you, which is precisely where the two engines differ.

In accurate mode six differences remain across 637 words: two words split in two, one dropped
letter, one added, one misread, and one German line-break hyphen left unjoined (`zu- frieden`).
The kicker above the headline was missed.

This is one page on one machine, not a benchmark suite. A single-column invoice narrows the
gap considerably.

### Why the accurate engine used to be slow

It was never the model. PaddleOCR's built-in backend pins the language model to a **batch size
of one**, so each of a page's layout regions — 23 on the page above — re-streams all 0.9 B
weights in turn. That is the worst possible shape for a decoder whose throughput is set by
memory bandwidth, and the card shows it: 68% utilisation at 41 W of a ~160 W budget, waiting
on memory rather than working.

The same weights behind a local [llama.cpp](https://github.com/ggml-org/llama.cpp) server,
which recognises eight regions at once, do the same work in a fortieth of the time and in half
the video memory. The model is byte-identical; only the way it is driven changed. It is
installed with the runtime, quantised on your machine from PaddlePaddle's official release,
and if it is ever missing the app quietly uses the built-in backend instead.

Input resolution is not a lever for it, and lowering it actively hurts. The accurate engine is
handed the PDF and derives its own page geometry; rendering to an image first costs reading
order — bag recall stays above 97% while word accuracy falls as low as 60%, the signature of
correctly-read text assembled in the wrong sequence.

## Running it

**Desktop** — download the installer for your platform from
[Releases](https://github.com/smartinventure/impressive-ocr/releases/latest).

**Server** — a container image, for a machine that should just process:

```sh
docker run -d --name impressive-ocr \
  -p 127.0.0.1:8084:8084 \
  -v impressive-ocr-data:/data \
  ghcr.io/smartinventure/impressive-ocr:latest
```

Then open <http://127.0.0.1:8084>. The port is bound to loopback on purpose: the API can read
and write every folder on its allowlist, so publish it further only behind a reverse proxy
with authentication enabled.

On first start the app downloads its Python runtime, the OCR models and the inference engine
— several gigabytes, once. It picks the CPU or GPU build of each after probing the hardware,
which is why they are not bundled.

## Building from source

Requires Node 22+, pnpm 9 and Python 3.11–3.13.

```sh
pnpm install
node deploy/fetch-uv.mjs          # the bundled uv, which installs the Python runtime
pnpm dev                          # API and web UI
```

`dev/dev.ps1` and `dev/dev.sh` wrap the whole stack with a menu, and set up anything missing.

## How it fits together

```
apps/desktop     Electron shell - runs the backend in-process
apps/server      Fastify backend: queue, watcher, pipelines, HTTP
apps/web         Vue 3 + Vuetify SPA, served by the backend
packages/shared  Zod schemas - the single source of truth for every contract
packages/db      Drizzle schema and migrations (SQLite)
sidecar/         Python worker: PaddleOCR, and the writers for each output format
```

The backend is deliberately Electron-agnostic, so the same code runs inside the desktop app and
headless. The SPA never depends on an Electron-only affordance, so the same page works in a
browser against the server.

## Licence

AGPL-3.0-or-later. See [LICENSE](LICENSE), and [NOTICE](NOTICE) for third-party components —
PaddleOCR is Apache-2.0, PyMuPDF is AGPL-3.0.
