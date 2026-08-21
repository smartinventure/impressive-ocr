<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Impressive OCR — handover

Written for a fresh assistant session on a different machine. Read this before touching
anything: most of it is knowledge that cost real time to acquire and is not recoverable from
the code.

Also read `CLAUDE.md` in the repo root — it is the binding style and architecture contract.
This document is the state and the scar tissue.

---

## What the product is

A **local-first OCR workstation**, AGPL-3.0. Node/TypeScript backend, Vue 3 + Vuetify web UI,
Python **PaddleOCR** sidecar. It watches folders, queues documents, OCRs them, and writes
Markdown / JSON / TXT / DOCX / XLSX / HTML (and, one day, searchable PDF). It ships two ways
from one backend: an Electron desktop app, and a headless server serving the identical SPA.

Two modes of use:

- **Pipelines** — a watched input folder, an output folder, ~30 options. For "process
  everything that lands here, forever".
- **Quick Mode** — pick a few files, set five options, Start. For "I have three PDFs".

Nothing about a user's documents leaves their machine. No telemetry, no CDNs.

---

## Where things stand

**496 tests green** (373 server, 86 sidecar, 19 shared, 17 web). `pnpm lint`,
`pnpm -r typecheck`, `pnpm format:check`, `pnpm -r test`, plus `ruff`/`mypy`/`pytest` in
`sidecar/` all pass. Everything is committed and pushed to `main`.

Working end to end, verified on real hardware: runtime install, folder watching, the queue,
OCR through the sidecar, output writing, Quick Mode (both server-picked files and upload → ZIP
download), auth with sessions and CSRF, the dashboard, and the log viewer.

### Not done

- **Searchable PDF.** Declared in the `OutputFormat` union and deliberately absent from
  `SUPPORTED_FORMATS` in `sidecar/.../writers/registry.py`. It is the headline feature in the
  product description and the most valuable output format for most users. PyMuPDF is already
  a dependency and can do it (render mode 3, invisible text layer over the page image). The
  page-level `TextBox` coordinates it needs are already produced and already scaled correctly.
- **Cancel is not immediate.** A queued job is dropped at once; a *running* one is left to its
  `AbortSignal`, and the sidecar does not check it between pages. Now that pages are processed
  one at a time (see below), there is a natural place to check.
- **e2e tests.** Playwright is mandated by `CLAUDE.md` and does not exist. `apps/web` has
  component tests only, and only for the screens that broke.
- **The Electron app has never been run.** It builds and typechecks; nobody has launched it.

---

## The pitfalls

This is the part worth reading twice.

### 1. Windows on ARM cannot run this, and it lies about why

Development happened on a **Snapdragon X** laptop. That was a mistake nobody could have known
was a mistake up front, and it cost more time than every other problem combined.

PaddlePaddle 3.3.1 publishes exactly three wheel platforms:

```
macosx_11_0_arm64      manylinux1_x86_64      win_amd64
```

So **ARM is not the problem** — Apple Silicon has a native wheel and is fully supported. What
has no wheel is *Windows on ARM*. There the x86-64 build runs under Prism emulation, and
emulation is where everything falls apart:

- oneDNN raises `NotImplementedError: ConvertPirAttribute2RuntimeAttribute not support` —
  worked around by disabling MKL-DNN (`use_mkldnn()` in `structure_engine.py`).
- Inference **dies with no traceback at all**. Measured: `predict()` on a single 59 KB PNG
  killed the process silently. Not an exception — a native crash.
- A five-page 200 DPI scan sat at "page 0 of 5" for over ten minutes.

**Every symptom of this looks like a bug in the application.** Three separate times a silent
process death was diagnosed as something else before the platform turned out to be the cause.
`apps/server/src/modules/runtime/platform-support.ts` now detects and warns about it.

**Detection trap:** `PROCESSOR_ARCHITEW6432` is *not* set by Prism — it is a WOW64 (32-on-64)
signal. On the Snapdragon, `process.arch` is `x64` and `PROCESSOR_ARCHITECTURE` is `AMD64`,
indistinguishable from a real x86 box. The only signal that survives emulation is
**`os.cpus()[0].model`**, which still says "Snapdragon(R) X". The first version of the check
reported that very machine as native.

On x86-64, re-measure everything below before trusting any of the performance conclusions.

### 2. Editing sidecar source does not affect the running app

The runtime installer copies `sidecar/src/impressive_ocr_sidecar` into the app's venv. It is a
**copy, not an editable install**. Changing Python source in the repo and restarting changes
nothing, and you will conclude your fix did not work.

Until this is fixed, sync manually:

```bash
cp -r sidecar/src/impressive_ocr_sidecar/* \
  <dataDir>/runtime/venv/Lib/site-packages/impressive_ocr_sidecar/
```

Worth making `dev.sh`/`dev.ps1` do this, or installing editable in dev.

### 3. `predict()` on a whole document is a trap

PaddleOCR's `predict()` accepts a PDF and looks convenient. It processes the entire document
and yields nothing until finished. Measured, five pages, warm models:

```
after engine.load (40s)     1505 MB   threads=20
... ten minutes, zero pages yielded ...
```

That single fact produced three separate "bugs": no progress (the backend genuinely knew
nothing), memory scaling with document length (which took a 16 GB laptop into swapping), and
Cancel having nowhere to stop.

Pages are now rendered individually with PyMuPDF (`pipeline/rasterize.py`, ~0.4 s/page) and fed
to the engine one at a time. **Do not "simplify" this back.**

### 4. Paddle wants `OMP_NUM_THREADS=1`

It says so at startup and it means it — its own thread pool competes with OpenMP's. The user's
CPU budget travels through `FLAGS_paddle_num_threads` instead (lower case; Paddle reads it
case-sensitively, and ruff's SIM112 will try to upper-case it, which silently disables the
cap). With that plus table recognition off: **14 s / 892 MB** versus **40 s / 1505 MB**.

Table recognition is not one model but **five** — classifier, two structure models, two cell
detectors — all made resident at construction. It is off by default in Quick Mode for that
reason.

### 5. Module toggles must reach the *constructor*

`PPStructureV3` resolves and downloads its sub-models in `__init__`, from the toggles it is
given. Passing them only to `predict()` is too late: the models are already loaded. This was
downloading formula, chart and seal models for pipelines that had them switched off.

### 6. A bound socket is not a listening socket

The sidecar bound its port, announced it, and let uvicorn listen afterwards. A bound
non-listening socket **refuses** connections, so for ~80 ms the backend thought it was ready
and every request came back `ECONNREFUSED` → `fetch failed` → three retries → quarantined
document. `sock.listen()` now happens *before* the handshake. OCR did not work at all before
this fix.

### 7. Things that look like our bug but are not, and vice versa

- **Seven Vitest files "failing"** was the C: drive being full — they failed to *collect*, not
  to assert. The tell: `Tests 161 passed`, zero failed, but seven files failed.
- **A silent process death** means disk, memory, or emulation. A real oneDNN fault raises a
  loud, specific exception.
- **CPU at 20% with memory at 97%** is swapping, not idling. The dashboard shows both side by
  side precisely so this is legible.

### 8. Windows and PowerShell specifics

- **German Windows**: `netstat` prints `ABHÖREN`, not `LISTENING`. Never match the state word.
  The listening socket is the one whose *remote* address is the wildcard.
- **PowerShell 5.1**: no `&&`, no ternary, no `??`. Redirecting a native command's stderr
  (`2>&1`) produces a `NativeCommandError` even on success. `"$Var:"` in a string parses as a
  drive reference — use `"${Var}:"`. Keep `.ps1` files pure ASCII: 5.1 reads UTF-8-without-BOM
  as ANSI.
- **Heredocs into CRLF files** create mixed line endings that Prettier then rewrites wholesale.
- The user's **C: drive runs near-full**. Dev caches were relocated to `D:\dev-caches` with
  user-scope env vars. Point every new toolchain cache at D:.

### 9. Licensing is load-bearing

PyMuPDF is AGPL-3.0, which is why the project is. Before adding a dependency, check the licence
and record it in `NOTICE`.

PaddleX downloads **PingFang SC** (Apple) and **simfang** (Beijing Founder) from a Baidu CDN at
inference time. Both are proprietary and cannot be redistributed. DejaVu Sans is bundled and
`PADDLE_PDX_LOCAL_FONT_FILE_PATH` points at it. Do not "fix" the CDN by vendoring the
originals.

---

## Working on it

```bash
pnpm install
./dev/dev.sh          # or .\dev\dev.ps1 — menu: start / stop / restart / status / env
```

Set `IMPRESSIVE_OCR_DATA_DIR` (the launchers default it beside the repo) — the runtime and
models under it run to several GB, and the app's own default is on C:.

Web UI on `:5273`, API on `:8084`. The OCR runtime installs from the UI on first run and is a
multi-GB download.

Before every commit: `pnpm lint`, `pnpm -r typecheck`, `pnpm format:check`, `pnpm -r test`,
and in `sidecar/`: `ruff check .`, `mypy src`, `pytest -q`. CI runs lint, typecheck and test —
**not** `format:check`, so that one is easy to let drift.

### Layout

```
apps/server     Fastify + SQLite/Drizzle. Electron-agnostic; routes → modules → infra.
apps/web        Vue 3 SPA. Must work in a plain browser, not just Electron.
apps/desktop    Electron shell. Never launched.
packages/shared Zod schemas — the only place contracts are defined.
packages/db     Drizzle schema + migrations.
sidecar/        Python. Engines behind a Protocol; writers per format.
dev/            Menu launchers.
```

### Where the interesting code is

| Concern | File |
|---|---|
| Emulation / platform support | `apps/server/src/modules/runtime/platform-support.ts` |
| Thread + memory caps | `sidecar/.../core/resources.py` |
| Page-at-a-time rendering | `sidecar/.../pipeline/rasterize.py` |
| Reusing an existing text layer | `sidecar/.../pipeline/existing_text.py` |
| oneDNN workaround | `sidecar/.../engines/structure_engine.py` |
| Sidecar startup handshake | `sidecar/.../__main__.py` |
| Allowlist / path safety | `apps/server/src/infra/fs/safe-path.ts` |
| Auth, sessions, CSRF | `apps/server/src/modules/auth/`, `http/auth-hook.ts` |
| Quick Mode | `apps/server/src/modules/quick/`, `apps/web/src/features/quick/` |

---

## How the user works

Direct, technical, and tests on real hardware rather than trusting a green suite. Expect bug
reports with console output and screenshots, and expect them to be right.

Two habits that have paid off and are worth keeping:

1. **Measure before concluding.** Every performance claim in this document came from an
   instrumented run. One concurrency "fix" was based on assuming six documents were in flight
   when the user had submitted one — they corrected it, and the real cause was elsewhere.
2. **Say what was not verified.** Several fixes here shipped with an explicit note that they
   were not confirmed end to end. That is more useful than a confident claim that turns out to
   be wrong on the next run.
