# Changelog

All notable changes to Impressive OCR are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Releases start at
1.0.0; the release workflow refuses anything below that.

Add entries under **Unreleased** as work lands. `deploy/release.ps1` / `release.sh` do not
edit this file — promoting the section to a version heading is a deliberate step in the
release checklist, because deciding what is worth telling users about is not automatable.

## [Unreleased]

## [1.0.0] - 2026-08-24

The first public release. Everything below records the development that led to it — several
entries describe defects that no released version ever shipped, kept because the reasoning is
worth having.


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
- The System page reports the OCR engine version installed in the runtime, and offers to
  update it. The engine is copied into its virtual environment once and never touched again,
  so an application update otherwise leaves the old Python in place, silently.
- An engine selector in Quick Mode, with an explanation of when each is worth its time. It
  defaulted to the fast engine with no control, so the accurate one was unreachable outside a
  pipeline — which is backwards, since Quick Mode is the "one document, make it right" case.
- An update indicator in the navigation footer, beside the version it refers to. The check
  already ran at startup and on an interval; its only surface was a card on a page nobody
  visits when nothing is wrong.
- Controls for the two desktop startup settings, `openBrowserOnStart` and
  `startMinimizedToTray`. Both existed in the schema from the beginning with no control
  anywhere, so the app opened a browser tab on every start and there was no way to stop it.
- Quick Mode shows the settings a run was started with while it runs. Starting a run replaced
  the form with a progress card, taking every choice that shaped the result with it.

### Fixed

- `deploy/set-version.mjs` refused to write a version the tree already held, reporting that
  `package.json` had no version field. All three writers tested whether the text had *changed*
  rather than whether the field had *matched*, and those differ precisely when the value is
  already correct — which is the normal case for a first release asking for 1.0.0 while the
  tree says 1.0.0. It failed after every check had run.
- The release scripts aborted when the version write changed nothing. `git commit` exits 1
  for an empty commit, which under `set -e` and the PowerShell exit-code check read as a
  failure — but "the tree already carries this version" is the normal state for a first
  release, and the right response is to tag the commit that is already there.
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
- The accurate profile failed on every document with "`_PaddleOCRVLPipeline` object has no
  attribute `doc_preprocessor_pipeline`". PaddleOCR-VL builds its document preprocessor in the
  constructor or not at all, and we asked for it at predict time instead; since orientation
  detection is on by default, that was the whole profile rather than an edge case.
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
[1.0.0]: https://github.com/smartinventure/impressive-ocr/releases/tag/v1.0.0
