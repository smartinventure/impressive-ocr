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

## What hardware this needs

Read this before choosing a machine to develop on. Two of them have now turned out to be
unable to run the engine at all, for two different reasons, and in both cases every symptom
looked like an application bug.

**Required**

- **x86-64 with AVX**, or **Apple Silicon**. Not "x86-64" — *with AVX*. See pitfall 1.
- **Windows only:** the Microsoft Visual C++ 2015-2022 Redistributable (x64). A Windows
  install that has never run an MSVC-built application does not have it.
- **~8 GB RAM minimum, 16 GB realistic.** Models alone are 0.9–1.5 GB resident, and a 16 GB
  laptop was already swapping under the old whole-document pipeline.
- **~5 GB free** on the data-directory drive: 2.6 GB is enforced before install, models grow
  after.

**Optional**

- An **NVIDIA GPU** with compute capability ≥ 7.0 unlocks the `paddlepaddle-gpu` wheel; ≥ 8 GB
  VRAM additionally unlocks the `accurate` (PaddleOCR-VL) profile. Only the driver matters —
  the wheels bundle CUDA and cuDNN, so no CUDA Toolkit install is required.

**The app now checks all of this itself.** `GET /api/system/preflight` grades every item as
`ok`, `fixable` (a missing redistributable, a tight disk) or `blocked` (no AVX, emulated ARM):

- the **Dashboard** shows a banner when anything is wrong, and nothing at all when it is not;
- the **System** page shows the full Compatibility card, with the remedy and download link;
- `RuntimeInstaller.install()` refuses to start on anything `blocked`.

The check takes about two seconds. The download it prevents is several gigabytes.

---

## Where things stand

**535 tests green** — 402 server, 86 sidecar, 28 web, 19 shared. `pnpm lint`,
`pnpm -r typecheck`, `pnpm format:check`, `pnpm -r test`, `pnpm check:sources`, and
`ruff` / `mypy` / `pytest` in `sidecar/` all pass.

Worth knowing: **the sidecar suite runs on a machine that cannot run PaddleOCR.** Paddle is
deliberately not a dependency of `sidecar/pyproject.toml` — the backend installs the CPU or
GPU wheel at runtime after probing — so `ruff`, `mypy` and all 86 tests need only fastapi,
pydantic, pymupdf and the dev extras. Set it up with the bundled uv, no system Python needed:

```bash
vendor/uv/uv.exe venv --python 3.12 sidecar/.venv
vendor/uv/uv.exe pip install --python sidecar/.venv/Scripts/python.exe -e "sidecar[dev]"
```

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

### 1. The machine itself is the most likely problem, and it never says so

Two development machines have now been unable to run PaddleOCR, for two unrelated reasons.
Neither produced an error that pointed at the hardware. Budget for this being the answer
before spending a day inside the application.

#### 1a. Windows on ARM — emulation

Development happened first on a **Snapdragon X** laptop. That was a mistake nobody could have
known was a mistake up front, and it cost more time than every other problem combined.

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

#### 1b. x86-64 is not enough — PaddlePaddle requires AVX

The second machine was a **Surface Go (Intel Pentium 4415Y)**: genuinely native x86-64, no
emulation, `platform-support.ts` correctly reported `native` — and it still could not run the
engine, because **Intel disables AVX on the Pentium and Celeron SKUs** of a generation whose
Core parts have it. "Recent x86-64" tells you nothing about AVX.

What happens without AVX, in order:

```
paddle/base/common.dll   faults during DllMain with 0xC000001D (STATUS_ILLEGAL_INSTRUCTION)
Python reports           ImportError: DLL load failed while importing libpaddle
core.py line 388 then    NameError: name 'libpaddle' is not defined
```

That last line is a **bug in PaddlePaddle itself**, and it is why this is so hard to diagnose.
Their handler is written to print exactly the sentence you need:

```python
except Exception as e:
    if not avx_supported() and libpaddle.is_compiled_with_avx():
        sys.stderr.write("Error: Your machine doesn't support AVX, ...")
```

but `libpaddle` is only bound when the import *succeeded*, and this block only runs when it
*failed*. The AVX warning is unreachable. It can never be printed to any user, on any machine.

There is no way around it: no-AVX Windows CPU wheels stop at **paddlepaddle 2.4.2, cp38** —
the project needs 3.3.1 on cp312, and PaddleOCR 3.7 would not run on 2.4.2 regardless.

Detection is `IsProcessorFeaturePresent(39)` on Windows, `/proc/cpuinfo` flags on Linux,
`sysctl hw.optional.avx1_0` on macOS — all in
`apps/server/src/modules/runtime/cpu-features.ts`. Match `avx` as a whitespace-delimited
token, not a substring: `avx512f` contains `avx`.

#### 1c. Windows needs the Visual C++ runtime, separately from all of the above

On the same Surface Go, `vcomp140.dll` was also missing — a *second*, independent blocker
that would have stopped an AVX-capable machine dead:

```
libpaddle.pyd  ->  mkldnn.dll  ->  VCOMP140.DLL   (absent)
```

`vcomp140.dll` is the MSVC OpenMP runtime, supplied by the Visual C++ 2015-2022
Redistributable. A Windows install that has never run an MSVC-built application simply does
not have it, and the resulting `DLL load failed` names neither the DLL nor the redistributable.
This one is *fixable* — one download — which is precisely why preflight separates `fixable`
from `blocked`. Fixing only this on a non-AVX machine gets you a working `mkldnn.dll` and the
same failure one DLL later.

Useful diagnostic trick: parse the PE import table of `libpaddle.pyd` and each DLL in
`paddle/libs/`, then check each name against `System32`. That found `VCOMP140.DLL` in seconds
where reading Python tracebacks had found nothing.

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
- **Disk is usually the constraint.** On the Snapdragon, C: ran near-full and dev caches were
  moved to `D:\dev-caches` with user-scope env vars; the Surface Go had no D: at all. Check
  what drives exist before repeating either arrangement, and point new toolchain caches at
  whichever drive has room. `uv`'s caches are already redirected into the data directory by
  `RuntimeInstaller.uvEnvironment()` — that was a real bug, not tidiness.

### 9. An unanchored `.gitignore` pattern hid three real directories

`.gitignore` had `runtime/`, `logs/` and `build/` with no leading slash. Git matches an
unanchored pattern at **any depth**, so these were never committed:

```
apps/server/src/modules/runtime/    GPU probe, installer, wheel index — 18 files
apps/web/src/features/logs/         the log viewer
apps/desktop/build/                 icons, entitlements, the NSIS script
```

Nothing complained. `git status` was clean, every check passed, and the code was simply absent
from the repository — including from the first version of this very document, which cited a
file the repo did not contain. It surfaced only when someone cloned it onto another machine.

An ignored file is *invisible*, not untracked, so no ordinary workflow catches this.
`pnpm check:sources` (`deploy/check-tracked-sources.mjs`) now asks git directly, and CI runs
it. If you add a `.gitignore` entry for a data or output directory, **anchor it**: `/runtime/`,
not `runtime/`.

### 10. Two things a fresh clone hits before it ever builds

Both were found by cloning onto a second machine, and neither can be reproduced on a machine
that already works.

**`better-sqlite3` tries to compile, and fails without Python.** The package has a
`binding.gyp` and no `install` script, so pnpm applies npm's default of running
`node-gyp rebuild`. That build is a **no-op by design** — `binding.gyp` collapses to
`'type': 'none'` when `prebuilds/<platform>-<arch>.node` exists, which it does for every
platform this project targets. But node-gyp needs Python just to *parse* the gyp file and
discover there is nothing to do, so on a machine without Python the install dies with a wall
of `gyp ERR! find Python`. Fixed by `pnpm.neverBuiltDependencies: ["better-sqlite3"]` in the
root `package.json`. Note this is the pnpm 9 spelling; **pnpm 10 replaces it** with a
default-deny `onlyBuiltDependencies` allowlist, so revisit it when the pinned
`packageManager` moves.

**Line endings — `format:check` failed on 186 files.** `.prettierrc.json` sets
`"endOfLine": "lf"`, the repo has **no `.gitattributes`**, and Git for Windows clones with
`core.autocrlf=true`. So every file arrives as CRLF and Prettier rejects all of them, on a
tree nobody has touched. Worked around locally with `git config core.autocrlf false` and a
re-checkout. **The durable fix is a committed `.gitattributes`** (`* text=auto eol=lf`, with
CRLF kept for `*.bat`/`*.cmd`) — not yet done, because it renormalizes the whole repository
and deserves its own commit. CI does not run `format:check`, so this stays invisible there.

Node itself: `engines` says `>=22.12.0`. Prefer **Node 22 LTS** over 24 — not for any ABI
reason (the prebuilds above are N-API and version-independent) but because 22 is what the
lockfile and the original machine used.

### 11. Licensing is load-bearing

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
node deploy/fetch-uv.mjs     # vendor/uv/ is a 44 MB binary, correctly gitignored
./dev/dev.sh                 # or .\dev\dev.ps1 — start / stop / restart / status / env
```

`vendor/uv/` is the one thing a fresh clone legitimately lacks. Everything else is source and
must be in the repository — see pitfall 9 for what happens when it is not.

Set `IMPRESSIVE_OCR_DATA_DIR` (the launchers default it beside the repo) — the runtime and
models under it run to several GB, and the app's own default is on C:.

Web UI on `:5273`, API on `:8084`. The OCR runtime installs from the UI on first run and is a
multi-GB download.

Before every commit: `pnpm lint`, `pnpm -r typecheck`, `pnpm format:check`, `pnpm -r test`,
`pnpm check:sources`, and in `sidecar/`: `ruff check .`, `mypy src`, `pytest -q`. CI runs
lint, typecheck, test and `check:sources` — **not** `format:check`, so that one is easy to let
drift.

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
| Can this machine run it at all | `apps/server/src/modules/runtime/preflight.ts` |
| AVX / CPU instruction set | `apps/server/src/modules/runtime/cpu-features.ts` |
| Visual C++ runtime check | `apps/server/src/modules/runtime/vc-runtime.ts` |
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
