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

## Two engines, and the difference is not just speed

| | Fast | Accurate |
|---|---|---|
| Model | PP-StructureV3 + PP-OCRv6 | PaddleOCR-VL (0.9B vision-language) |
| Good at | letters, invoices, forms, single-column text | magazines, newspapers, columns, tables, difficult scans |
| Speed | ~5 s/page on a desktop GPU | ~80 s/page on the same GPU |
| Needs | runs on CPU too | a GPU with enough memory |

They fail differently, which matters more than the speed gap. The fast engine reads characters
well and reconstructs page *structure* poorly: on a multi-column page it can interleave columns
and tear a drop capital off its word, producing output that looks plausible and is unusable.
The accurate engine rebuilds reading order.

Use Fast for folder-watching volume. Use Accurate for pages someone will actually read.

## How accurate is it?

Measured on a dense German magazine page — two columns, a drop capital, a photograph, ~640
words — against a hand-checked transcript produced by ChatGPT.

| Output | Character similarity | Word similarity | Umlaut words | Words |
|---|---|---|---|---|
| ChatGPT transcript (reference) | 100% | 100% | 39/39 | 637 |
| Fast | 48.6% | 94.2% | 36/39 | 620 |
| **Accurate** | **98.8%** | **98.3%** | 36/39 | **637** |

Two numbers, because either alone misleads. **Word similarity** asks whether the right words
were read; **character similarity** compares the page as one string, so it is sensitive to
order. The fast engine scores 94% on words and 49% on characters — it reads the letters and
misplaces them. An early comparison using word similarity alone ranked the better engine last.

In accurate mode, seven differences remained across 637 words: two dropped letters, two added,
one transposition, one spurious space, and one German line-break hyphen left unjoined
(`zu- frieden`). The kicker above the headline was missed.

This is one page on one machine, not a benchmark suite. A single-column invoice would narrow
the gap considerably — which is the case where Fast is the right answer anyway.

### Where the time goes

Sampling the GPU during an accurate run: 68% utilisation, 2790 MHz, and **41 W of a ~160 W
budget** — a card waiting on memory rather than computing. Vision-language decoding writes the
page out token by token, streaming the model's weights for each one, so throughput follows
**memory bandwidth**. More VRAM does not make it faster; a wider memory bus does.

Input resolution is not a lever either. Feeding the same page at 120, 150 and 200 DPI produced
the same runtime within noise, because the cost tracks how much text comes *out*, not how many
pixels went in. 300 DPI took 2.3× as long and scored worse.

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

On first start the app downloads its Python runtime and the OCR models — several gigabytes,
once. It picks the CPU or GPU build after probing the hardware, which is why they are not
bundled.

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
