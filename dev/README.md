<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# dev

Menu launchers for the development stack: the Fastify API and the Vite web UI.

| Platform                       | Run                |
| ------------------------------ | ------------------ |
| Windows (PowerShell)           | `.\dev\dev.ps1`    |
| Linux, macOS, Git Bash         | `./dev/dev.sh`     |

Both present the same menu — **Start**, **Stop**, **Restart**, **Status**,
**Environment**, **Check / install prerequisites** — and both accept a subcommand
for scripting:

```bash
./dev/dev.sh start          # or: .\dev\dev.ps1 -Action start
./dev/dev.sh stop
./dev/dev.sh status
./dev/dev.sh env            # the full "where does everything go" screen
./dev/dev.sh doctor         # what is missing, and the command that installs it
```

Execution policy (Powershell):
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned


Start waits until the API actually answers before reporting success, and tells you
whether the OCR runtime still needs installing. Stop kills the process **tree** —
`pnpm dev` spawns `vite` and `tsx`, and killing only the parent leaves both holding
their ports — then sweeps the ports themselves, so it also cleans up a stack you
started by hand.

| Service | URL                     |
| ------- | ----------------------- |
| Web UI  | http://localhost:5273   |
| API     | http://127.0.0.1:8084   |

## Windows: script execution policy

A stock Windows machine refuses to run `dev.ps1` at all:

```
.\dev.ps1 ist nicht digital signiert. Sie koennen dieses Skript im aktuellen
System nicht ausfuehren.
```

That is `LocalMachine` sitting at `AllSigned`, not anything wrong with the script.
Allow scripts for your own account, once:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

`CurrentUser` takes precedence over `LocalMachine` and needs no admin rights. For a
single session instead use `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`,
or run the script as `powershell -ExecutionPolicy Bypass -File .\dev\dev.ps1` and change
nothing at all.

`RemoteSigned` still blocks a script carrying the internet-download marker; a git
clone does not set one, but a script out of a downloaded zip needs `Unblock-File`.

Check what is actually in force with `Get-ExecutionPolicy -List`. If `MachinePolicy`
or `UserPolicy` is anything but `Undefined`, Group Policy decides and neither of the
first two options will override it — use the `-File` form.

## Environment

Only three variables are yours to set. Everything else prefixed `IMPRESSIVE_OCR_`
is injected by the server when it spawns the Python sidecar; setting those by hand
will confuse it.

| Variable                   | Default                            | What it controls                       |
| -------------------------- | ---------------------------------- | -------------------------------------- |
| `IMPRESSIVE_OCR_DATA_DIR`  | `%LOCALAPPDATA%\ImpressiveOCR`     | database, logs, and the entire runtime |
| `IMPRESSIVE_OCR_PORT`      | `8084`                             | API port (1024–65535)                  |
| `IMPRESSIVE_OCR_UV_BINARY` | `<repo>/vendor/uv/uv[.exe]`        | the `uv` that builds the Python runtime |

**These scripts override the data dir default** to a sibling of the repository, so
it lands on the same drive as your checkout. The application's own default is under
`%LOCALAPPDATA%` on C:, and what goes underneath runs to several gigabytes.

To make it stick, copy `dev.env.example` to `dev.env` and edit it — both scripts
load that file on every run, and it is gitignored.

Changing `IMPRESSIVE_OCR_PORT` also means changing `BACKEND_PORT` in
`apps/web/vite.config.ts`, since the Vite dev server proxies `/api` there.

## What gets stored where

```
<data dir>/
  runtime/venv        Python interpreter and packages    ~2 GB
  runtime/models      PaddleOCR weights                  ~1-4 GB, grows
  runtime/uv-cache    uv download cache                  ~1 GB
  impressive-ocr.db   job history and settings           small
  logs/               server logs                        small
```

Scratch for in-flight jobs goes to `<temp>/impressive-ocr-work`, and this folder's
own `.run/` holds the launcher's pid and log. Both are safe to delete at any time.

Nothing here is precious except `impressive-ocr.db`. Deleting the runtime just means
installing it again from the UI.

## Prerequisites

Node 22+, pnpm 9+, and `pnpm install` already run. `uv` is only needed to install the
OCR runtime, not to boot the stack, so the scripts warn rather than refuse when it is
missing — `vendor/` is gitignored and fetched at build time, so a fresh clone has to
supply it before OCR will work.

`doctor` (menu entry 6) is the quick way to find out what a machine lacks. It checks
Node against `engines.node` and pnpm against `packageManager` in the root
`package.json` — a version check rather than "is it installed", because Node 20
passes the latter and then fails somewhere far less obvious — prints the exact
command that fixes each miss, and offers to run the ones that only touch the
checkout (`pnpm install`, `node deploy/fetch-uv.mjs`, the pinned global pnpm). A Node
upgrade it prints rather than runs: that replaces a system-wide interpreter and asks
for elevation, which a dev launcher should not do behind your back.

It also warns about a CPU with no PaddlePaddle wheel — Windows on ARM and Linux on
ARM. Apple Silicon has a native wheel and is fine.
