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

- **The accurate profile is roughly 28x faster, and now runs without a graphics card.**
  Measured on a dense magazine page: 56.4 s/page to 2.0 s/page on a desktop GPU, and 10.6 s
  on a CPU where it was previously not offered at all — at the same accuracy, on the same
  model, using less than half the video memory.

  The engine never was the problem. PaddleOCR's own backend pins the language model to a
  batch size of one, so every layout region on a page re-streams all 0.9 B of weights; a
  dense page has 23 of them. The identical weights behind a local `llama-server`, which
  batches those regions eight at a time, do the same work in a fortieth of the time. What
  changed is how the model is driven, not what it is.

  Installed alongside the Python runtime and quantised on the machine from PaddlePaddle's
  official BF16 release — about four seconds, once — so the only weights that ever run are
  the ones they published. Falls back to the built-in backend whenever the server is missing
  or will not start: slower, but never broken, and the reason is logged.
- The pre-install confirmation now includes the inference engine. It previously quoted only
  the Python side, understating the download by ~1.9 GB and the disk footprint by ~2.3 GB —
  on the one screen whose entire job is to prevent that surprise. Sizes are per build, because
  extracted CUDA binaries are 1.1 GB where the CPU ones are a tenth of that.
- Two settings for it, under **OCR engine**: whether to use the fast inference engine at all,
  and how many page regions it recognises at once. Eight measured fastest; sixteen and
  twenty-four were slower, because more slots divide the same memory between them.
- Linux desktop builds are published again: AppImage and deb, x64, with stable `latest`
  download links alongside Windows and macOS.
- A first-run screen: the Terms and Conditions, the Privacy Policy and a plain summary of
  the licence, agreed to before anything else. Recorded server-side against a version
  number, so raising that version re-asks everyone exactly once. Asked by the application
  rather than by an installer, because the installer is not a place every user passes
  through — the AppImage is run rather than installed, the container has no installer, and
  someone using the headless server from a browser never sees one.
- Immediately after that, on a machine where the OCR engine is not installed yet, a prompt
  pointing at the System page, where the install lives. Nothing could be processed until
  that had been done and nothing said so.

### Changed

- The fast profile renders pages at 150 DPI rather than 200. Measured across thirteen pages of
  tables, formulas, fine print and body text against each page's own text layer, 150 and 200
  are *identical* at 87.9% word accuracy and 150 is 23% faster. 100 DPI is faster again and
  does finally cost accuracy, so 150 is the floor rather than a step on the way down. Higher
  does not help either: 300 DPI is slower and no more accurate, including on the small print
  it is supposed to be for.
- The licence summary on the first-run screen now states that the AGPL grant is for private
  use, and directs commercial users to speedbits.io for a paid licence.

### Removed

- The desktop app no longer opens a browser tab at startup, and the `openBrowserOnStart`
  setting is gone with it. The Electron window is already the interface, so a second copy in
  a browser was an interruption rather than a convenience — and the setting existed only for
  that one behaviour, so keeping it would have left a switch that did nothing. Opening the
  interface in a browser is still one click away, in the tray menu, where it is asked for
  rather than assumed.

### Fixed

- Dense pages silently lost text in accurate mode. Each inference slot held 2048 tokens, and
  a slot has to fit a layout region's image *plus* everything written back about it, so a
  full-width block of small print — a page of photo credits, a wall of terms — simply stopped
  mid-sentence. One page scored 37% word accuracy against its own text layer, having dropped
  555 words of 901; at 4096 tokens it scores 94%. Peak video memory moved by about 150 MB.
  Found by benchmarking real pages rather than generated ones, which is the whole argument for
  having them.
- The README's accuracy table published a character-similarity column that cannot be
  reproduced from the outputs it was derived from — it rated a visibly scrambled page at
  ~95% and a well-ordered one at 48.6%, and no variant of that metric yields both published
  figures. The whole "reads the letters and misplaces them" framing rested on it. Replaced
  with word accuracy (order-sensitive edit distance) and bag recall (order-blind), whose
  difference measures reading-order damage directly. The word column was sound and survives
  unchanged at 98.3%.
- The README's speed figures were stale: the accurate engine is ~56 s/page on the reference
  machine, not ~80, and the fast engine ~3.5 s/page, not ~5. Both now also state CPU cost.
- The release workflow built every platform and then failed to publish: `download-artifact`
  could not fetch the artifacts the six build jobs had just uploaded. GitHub is force-running
  actions that target Node 20 on Node 24, and the pinned `@v4` was one of them. Every action
  is now on a version that targets Node 24 natively. The publish job also gained `actions:
  read` — declaring any permission drops the rest to `none`, and reading artifacts is an
  Actions API call.
- The publish job then failed on a different artifact: buildx quietly uploads a
  `.dockerbuild` build record, and "download every artifact" meant downloading that too. It
  failed to verify, which failed the release — and had it verified, the flattening step
  would have published a 72 KB build record as a release asset, since it copies every file
  it finds. The record is no longer produced, and the four platform artifacts are now
  fetched by name, so a stray artifact cannot reach the release and a missing platform
  fails at the step that can name it.
- `softprops/action-gh-release` moved from v2 to v3, the first release that runs on
  Node 24. It sits immediately after the download step and had never been reached, so it
  would have failed next for exactly the reason the artifact actions did.
- Long documents failed with the single word "terminated", after the GPU had already done
  most of the work. `fetch` abandons a response body that has been idle for five minutes,
  and PaddleOCR-VL parses an entire PDF before it yields its first page — so any accurate
  job past roughly five minutes, which is any multi-page scan, killed itself. The sidecar
  now sends a keepalive newline every 30 seconds while an engine is working; the backend's
  line reader already discarded blank lines, so no message type had to be invented.
- A queued document burned its whole retry budget while it waited. Claiming a job counts an
  attempt, and the scheduler claimed one every half-second only to hand it straight back
  whenever the device it needed was busy — several hundred "attempts" for a document that
  had not been touched. Its first real failure then quarantined it immediately, with
  nothing left to retry. The scheduler now only offers the claim pipelines whose device has
  a free slot.
- The Linux build failed while packaging the `deb`. `fpm` requires a Debian `Maintainer`,
  which electron-builder derives from `author` — and a bare name string does not carry the
  address it needs. The AppImage was never the problem; it had been building correctly all
  along, behind the failure that stopped the run before the artefacts were collected.
- Linux windows were not associated with their launcher entry: `desktopName` was unset, so
  the running application appeared separately from the icon that started it.

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
- The Linux build failed: `executableName` defaults to the package name, and this package is
  scoped, so `@impressive-ocr/desktop` became `@impressive-ocrdesktop` — which AppImage
  refuses, because of the `@`. Pinned to `impressive-ocr`.
- The macOS build failed with "apps/desktop not a file". An unset GitHub secret still defines
  the variable as an empty string, and electron-builder reads an empty `CSC_LINK` as a
  certificate *path*, resolving it to the project directory. Absent and empty are not the same
  thing to it, so the signed and unsigned paths are now separate steps, as on Windows.
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
