# Releasing Impressive OCR

Versioning starts at **1.0.0** and follows semver. The app, the sidecar and every workspace
package share one version number — a mismatched pair is the kind of bug that only shows up in
a user's install, so there is nothing to keep in sync by hand.

Releases are cut by pushing a tag (`v1.0.0`); GitHub Actions builds every target and publishes
them to one GitHub Release.

---

## Build matrix

| Target | Artifact | Notes |
|---|---|---|
| Windows x64 | NSIS installer `.exe` | Also the build ARM64 machines run, under emulation — see below |
| macOS arm64 | `.dmg` | Apple Silicon |
| macOS x64 | `.dmg` | Intel Macs |
| Linux x64 desktop | `.AppImage` + `.deb` | Desktop app with tray |
| Linux x64 server | `.tar.gz` | Headless — no Electron, just Node + the built SPA |
| Linux arm64 server | `.tar.gz` | For ARM boxes and SBCs, headless only |

### Windows on ARM: ship x64, not arm64

**PaddlePaddle publishes no `win-arm64` wheels.** Confirmed by running the full install on a
Snapdragon X laptop: `uv` resolves to `cpython-3.12-windows-**x86_64**` and PaddlePaddle
installs its `win_amd64` wheel, which then runs under Prism emulation.

Beware of one misleading signal while testing this. `platform.machine()` reports **`ARM64`**
even for an emulated x86-64 process, because Windows reports the *host* architecture. The
value that tells the truth is `sysconfig.get_platform()`, which returns `win-amd64`.

So Windows ships **x64 only**, and it genuinely works — see the emulation note below.

The proper fix is a third engine backend: ONNX Runtime with the QNN execution provider,
running PaddleOCR models on the Snapdragon NPU. Native ARM64 *and* considerably faster than
emulated x64, but a whole additional engine to build and test. Future work, not a 1.0 target.

macOS has no equivalent problem: PaddlePaddle ships arm64 wheels for Apple Silicon.

### Emulation requires oneDNN to be off

Verified end to end on a Snapdragon X: OCR works, but **only with MKL-DNN disabled**. PaddleX
enables it by default for CPU inference; emulated, inference fails inside
`onednn_instruction.cc` with `ConvertPirAttribute2RuntimeAttribute not support`.

`sidecar/.../structure_engine.py` detects the host/binary architecture mismatch and switches
oneDNN off automatically. Measured on that machine, 200 DPI A4, CPU:

| Pipeline | Load | OCR |
|---|---|---|
| `PaddleOCR` (text only) | — | **36 s** |
| `PPStructureV3` (layout + tables) | 20 s | **137 s** |

Slow, but usable for folder-watching batch work. Both were correct on a scanned German
invoice with no text layer.

> **Do not blame oneDNN for a silent process death.** While first testing this, the structure
> pipeline vanished mid-run with no traceback, and that was initially recorded here as a
> second oneDNN symptom. It was not — the C: drive had 178 MB free and Paddle could not write
> its temp files. The same disk exhaustion made seven Vitest files fail to collect. oneDNN
> produces a *loud, specific* exception; a silent exit means look at disk or memory first.

---

## The `latest` download URL

GitHub serves a permanent redirect to the newest release's asset:

```
https://github.com/smartinventure/impressive-ocr/releases/latest/download/<asset-name>
```

This only resolves if the **asset name is stable across releases** — it cannot contain the
version. But `electron-updater` needs versioned filenames, because that is what it writes into
`latest.yml`.

So each release publishes both:

| Purpose | Name | Example |
|---|---|---|
| Auto-update feed | versioned | `Impressive-OCR-Setup-1.0.0-x64.exe` |
| Website download | stable alias | `Impressive-OCR-Setup-win-x64.exe` |

The workflow uploads the versioned artifacts that `electron-builder` produces, then uploads a
copy of each under its stable name. Website links use the stable ones:

```
.../releases/latest/download/Impressive-OCR-Setup-win-x64.exe
.../releases/latest/download/Impressive-OCR-mac-arm64.dmg
.../releases/latest/download/Impressive-OCR-linux-x64.AppImage
.../releases/latest/download/impressive-ocr-server-linux-x64.tar.gz
```

Those URLs never change, so the website needs no edit when a version ships.

---

## Update detection

Two different mechanisms, because the two modes have different capabilities and different
users.

### Desktop (Electron)

`electron-updater` against the GitHub provider. It reads `latest.yml` from the newest release,
compares versions, downloads in the background and installs on quit.

Deliberate choices:

- **Never auto-install silently.** A pipeline may be mid-document; restarting under someone
  processing a 2,000-page backlog is unacceptable. The UI offers the update and the user picks
  the moment.
- **The download is offered, not forced.** Respects `autoUpdateEnabled` in Settings.
- **The update waits for an idle queue** before restarting, unless the user overrides.

### Headless server

`electron-updater` does not exist here — there is no Electron, and a server is often managed by
a package manager or a container image where an app that overwrites itself would be actively
wrong.

So the headless build **checks and notifies, but never installs**: it polls the GitHub releases
API (respecting `autoUpdateEnabled`), and surfaces "1.0.1 is available" in the UI with a link
to the release notes. Updating stays the administrator's action.

Both paths share one `/api/system/update` endpoint so the UI is identical; only the available
actions differ.

---

## Signing

Unsigned builds trigger SmartScreen on Windows and Gatekeeper on macOS, which for a
security-adjacent tool asking for filesystem access is a bad first impression.

- **Windows**: Authenticode certificate, ideally EV to skip SmartScreen reputation-building.
- **macOS**: Apple Developer ID plus notarisation — without it, the `.dmg` will not open at all
  on a current macOS.
- **Linux**: no signing requirement; the `.deb` can be signed if a repository is published later.

Certificates live in GitHub Actions secrets, never in the repository.

---

## Release checklist

1. `pnpm -r typecheck && pnpm lint && pnpm test && (cd sidecar && pytest)` all green.
2. Bump the version in every `package.json` and `sidecar/pyproject.toml`.
3. Update `CHANGELOG.md`.
4. Tag `vX.Y.Z` and push.
5. Confirm the workflow published every matrix target plus the stable aliases.
6. Check a `releases/latest/download/...` URL actually resolves.
7. Verify auto-update from the previous version on at least Windows.
