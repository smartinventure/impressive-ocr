# Changelog

All notable changes to Impressive OCR are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Releases start at
1.0.0; the release workflow refuses anything below that.

Add entries under **Unreleased** as work lands. `deploy/release.ps1` / `release.sh` do not
edit this file — promoting the section to a version heading is a deliberate step in the
release checklist, because deciding what is worth telling users about is not automatable.

## [Unreleased]

### Added

- Release pipeline: tag-triggered builds for Windows, macOS, Linux desktop, the headless
  server tarball and a container image on GHCR, published to one GitHub Release with stable
  `latest` download links.
- Windows code signing through Azure Trusted Signing.
- `deploy/docker/` — the headless server image and a worked Compose file.
- `IMPRESSIVE_OCR_BIND_ADDRESS`, a startup-only bind override so the server can run in a
  container.
- CI now packages the server, starts it, and requires `/api/health` and the SPA to respond;
  it also builds the container image on every pull request.
- Overlay image output, a PNG per page showing the detected regions. The writer existed
  but no screen ever offered the format.
- A plain-text encoding setting in the pipeline editor, shown only when `.txt` is one of
  the outputs.
- An **Expert settings** panel on a pipeline: detection and recognition thresholds, box
  expansion, detection resolution, layout confidence, and block types to leave out of the
  Markdown. Collapsed by default, every field optional — an unset field is omitted from
  the OCR call rather than sent as a default, so a pipeline never pins a value that a
  later PaddleOCR improves.

- An **update card** on the System page: check, download and "restart and install".
  `UpdateService` and the preload bridge already did all three, but nothing in the UI ever
  called them, so a user could not learn a release existed.
- Quitting the desktop app while documents are being processed now asks first. Closing the
  window still just hides it — this is about the explicit Quit.

### Fixed

- `deploy/release.ps1` ignored a failing lint or typecheck and released anyway. Windows
  PowerShell does not raise an error when a native command exits non-zero — not even
  under `$ErrorActionPreference = 'Stop'` — and the script checked `$LASTEXITCODE` once,
  after four commands, so only the last one counted. Every step is now checked
  individually, the git operations included. `release.sh` was never affected, because
  `set -e` covers it.

- The `txtEncoding` pipeline setting was never applied. It reached no further than the
  schema: `resolve_encoding` was never called, the sidecar's job request had no field to
  carry it, and `create_writers` was invoked without it, so every `.txt` was UTF-8
  whatever the pipeline said. Had it been wired up naively it would have crashed — the
  setting name `utf-8-bom` is not a Python codec, and the resulting `LookupError` is not
  among the errors the writer catches.
- The pipeline editor showed only the already-selected output formats. The format chips bound
  `model-value`, which on Vuetify's `VChip` controls the chip's own visibility, so every
  unselected format rendered nothing — and because a chip that is not rendered cannot be
  clicked, Word, Excel, HTML, plain text and searchable PDF could be removed from a pipeline
  but never added back.

### Removed

- The `language` engine setting. It existed in the shared schema and the sidecar protocol
  but was never passed to PaddleOCR, so it had no effect. Wiring it would have made things
  worse rather than better: PaddleOCR ignores `lang` once model names are pinned, and
  honouring it would mean swapping the pinned multilingual recogniser for a smaller
  language-specific one — forcing a single language onto documents that mix German and
  English. Mixed-language documents need no configuration.

### Changed

- **The `fast` profile now pins PP-OCRv6_medium** for text detection and recognition.
  PP-StructureV3's own default, PP-OCRv5_server, was mangling German: `groB` for `groß`,
  `bestatigen` for `bestätigen`, `Uberfülle` for `Überfülle` — wrong words, not near
  misses. On the English sample it lost 73 word boundaries per page. v6_medium is also
  2.7× faster on GPU, 1.7× on CPU, and the smaller model. Pinned rather than left to
  PaddleOCR's defaults, which is how the engine came to claim PP-OCRv6 in its docstring
  while actually running v5.
- Output formats now default to Markdown alone, in both pipelines and Quick Mode, instead of
  Markdown plus JSON.
- The last selected output format cannot be deselected in either screen; its chip is disabled
  rather than silently ignoring the click.
- The bundled `uv` binary is vendored per architecture, at `vendor/uv-<arch>/`.
- macOS builds now produce a `.zip` alongside the `.dmg`, which is what `electron-updater`
  installs from.
- The headless server is bundled with esbuild instead of `tsc`.

[Unreleased]: https://github.com/smartinventure/impressive-ocr/compare/v1.0.0...HEAD
