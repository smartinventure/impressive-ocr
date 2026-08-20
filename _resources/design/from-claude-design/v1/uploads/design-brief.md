# Impressive OCR — UI design brief

> Paste this whole document into Claude Design.

---

## What I need

A **multi-artboard design canvas** for a desktop application called **Impressive OCR**, covering the eight screens listed below in **both light and dark themes**.

Design desktop-first at **1440 px** wide, and make sure every layout still holds at **1024 px**. Everything must map onto **Vuetify 3 components (Material Design 3)** — please don't invent widgets that would have to be hand-built from scratch, because this design goes straight into a Vue 3 + Vuetify 3 implementation.

---

## The product

Impressive OCR is a **local-first, privacy-preserving OCR workstation**. It is open source (AGPL-3.0) and runs entirely on the user's own machine — no cloud, no telemetry, no document ever leaves the computer. That privacy promise is a real selling point and the design should feel like it: calm, solid, self-contained. Not a SaaS dashboard.

Users set up **pipelines**. A pipeline is:

```
watched input folder  →  OCR with a chosen engine + options  →  output folder
```

Drop a PDF (or PNG/JPEG/TIFF) into a watched folder and the app picks it up, queues it, runs OCR on the CPU or GPU, and writes the results out as Markdown, JSON, TXT, DOCX, XLSX, HTML, or a searchable PDF. Then it either leaves the original alone, deletes it, or moves it to an archive.

**The central design problem:** this is a long-running background process. A single pipeline might chew through 2,000 scanned documents over several hours. The UI's job is to make that feel **calm, legible, and controllable** — the user should be able to glance at it and instantly know: is it working, how far along is it, is anything stuck, and can I stop it. It should be pleasant to leave open on a second monitor all day.

**Audience:** technically confident professionals — legal, archives, research, accounting, IT. People who scan a lot of paper and need the text out of it. They are comfortable with folder paths and settings; they are not impressed by hand-holding, but they do need dense information to stay readable.

---

## Brand

### The logo

The existing logo is a horizontal lockup:

- A **rounded square** (100×100, corner radius 22) containing **four white horizontal bars** representing lines of text. The bars are at y=28, 45, 62 — the first two are full width (56 units), and the **fourth line is broken into two segments** (34 units + a gap + 14 units).
- That break is the entire idea of the brand: it reads as **recognised** text, text that has been parsed into pieces — not just a generic "document" icon. Please build on this motif rather than replacing it.
- Next to it, the wordmark: **"Impressive"** in weight 400 and **"OCR"** in weight 700, set in **Space Grotesk**, tight letter-spacing (about −1.6 at 52px).

Here is the mark's geometry, if useful:

```svg
<g>
  <rect width="100" height="100" rx="22" fill="#14532D"/>
  <g fill="#ffffff">
    <rect x="22" y="28" width="56" height="9"/>
    <rect x="22" y="45" width="56" height="9"/>
    <rect x="22" y="62" width="34" height="9"/>
    <rect x="64" y="62" width="14" height="9"/>
  </g>
</g>
```

### Colour

The logo square was originally near-black `#111111`. **It is changing to dark green.** Use **`#14532D`** (deep forest) as the anchor — you own the final value, but it has to survive being rendered as a 16 px Windows tray icon and a favicon, so it must not turn to mud at small sizes.

The wordmark stays near-black `#111111` in light theme and white in dark theme.

**Dark green becomes the brand primary colour.** Please build the full palette from it.

⚠️ **Watch this collision:** green also reads as "success". In a queue UI full of status indicators, a user must never confuse *"this pipeline is running"* with *"this job finished"*. Keep the deep brand green for chrome, navigation and primary buttons, and give the `succeeded` state a clearly distinct treatment — different lightness or hue, and always lead with an icon.

### Typography

**Space Grotesk** for headings and the wordmark. Pick a companion for body and data — the UI has a lot of dense tables, file paths and numbers, so a readable UI sans plus a monospace for paths/filenames would be welcome.

### Status palette

Define six states that stay distinguishable in dark theme **and** for colour-blind users:

`queued` · `running` · `paused` · `succeeded` · `failed` · `quarantined`

Status must **never** rely on colour alone — always pair colour with an icon and a text label.

---

## Icon assets I need from you

| Asset | Used for |
|---|---|
| Horizontal logo — light and dark variants | App header, README, docs |
| **Square app icon** (the mark alone) | Windows/macOS/Linux desktop shortcut for the main app |
| **Square "Server" icon variant** | A *second* shortcut for headless server mode. Must read as clearly the same product, yet be unmistakably not the desktop app at 32 px. Perhaps an outlined or monochrome treatment, or a subtle server/terminal cue. |
| Tray icons: idle · running · paused · error | System tray, incl. a macOS template-image version |
| Favicon | Browser tab |

---

## The eight screens

### 1. First-run setup wizard

Steps: welcome → choose port + http/https → hardware detection result → runtime download & install → done.

This is the user's first impression **and** the step most likely to fail, so the error states matter as much as the happy path.

- The hardware step reports either "NVIDIA RTX 4070, 12 GB VRAM — GPU acceleration available" or "No compatible GPU — processing will run on the CPU", **always with the specific reason**. A user who just bought a graphics card deserves to know it's a 4 GB card, not a silent fallback.
- The install step downloads several gigabytes of Python packages and AI models. It needs a **real progress bar with a step label**, plus an expandable log for people who want to watch the detail.

### 2. Pipelines overview — the home screen

A list or card grid of pipelines. Each shows: name, input → output folders, engine profile, device (CPU/GPU), and **live counters** like *"142 of 380 processed · 238 queued"*, plus a per-pipeline play/pause button. There's also a global pause/play affecting everything at once.

Must stay readable with **1 pipeline and with 15**. Also design the **empty state** — a brand-new install with no pipelines yet.

### 3. Pipeline detail

What's happening right now: current file name, size, "page 12 of 340", device in use, throughput in pages/minute. Below it, the queue waiting, recent history, and throughput over time.

### 4. Pipeline editor — the hardest screen

Roughly **30 settings** across eight groups:

- **Source** — input folder, recurse subfolders, mirror folder structure, include/exclude file patterns, max file size, watch mode (events vs polling for network shares), file-stability delay, skip duplicates
- **Engine** — profile (**Accurate**: a vision-language model, GPU, best on complex tables and messy scans / **Fast**: classic pipeline, runs fine on CPU), device (auto/GPU/CPU), language, model size, scan resolution (DPI), max pages per document
- **Engine modules** — toggles for document orientation, dewarping, text-line orientation, table recognition, formula recognition, chart recognition, seal recognition
- **Text-layer strategy** — always OCR / skip PDFs that already contain text / hybrid
- **Output** — which formats (multi-select), filename template, what to do on a name collision, text encoding
- **After success** — keep / delete / move the original
- **Reliability** — retry attempts, backoff, quarantine folder, concurrency
- **Schedule & integration** — priority, active hours, completion webhook

This needs **progressive disclosure**: good defaults visible, advanced options collapsed. The engine module toggles need inline **speed-vs-quality hints** — e.g. *"Formula recognition — significantly slower"*, *"Table recognition — recommended"* — because these are the settings that turn a 20-minute job into a 3-hour one.

### 5. Jobs & history

A filterable table across all pipelines, plus a **job detail drawer** showing a page-by-page timeline, the output files produced, any errors, and a retry button.

### 6. System status

CPU and GPU utilisation, VRAM usage, engine and model versions, worker process health.

### 7. Settings

Port, protocol, bind address, authentication, the folder allowlist (which folders the app is permitted to touch), history retention, language (English/German), theme, updates.

### 8. States to design explicitly

Empty (no pipelines) · everything paused · quarantine review (files that failed) · runtime not installed yet · **"GPU unavailable, fell back to CPU"** notice.

---

## Constraints

- **Vuetify 3 / Material Design 3 components only.**
- **Light and dark theme, both first-class.** Long sessions, often on a second monitor — dark is not an afterthought here.
- **English and German.** German strings run about 30% longer, so no layout that breaks on a longer label. `Ausgabeformate` vs `Output formats`, `Dokumentausrichtung erkennen` vs `Detect orientation`.
- The **same UI is served in a plain browser** when the app runs in headless server mode, so nothing may depend on native desktop affordances like OS menus or native folder-picker dialogs. In particular, the **folder picker needs a typed-path fallback** with inline validation.
- Please solve these **recurring patterns once** and reuse them everywhere: folder picker · output-format multi-select · live progress bar with ETA · play/pause control · status chip · CPU/GPU device badge.

---

## Tone

Calm, precise, trustworthy. This is a tool that runs unattended on someone's own hardware, handling their invoices, contracts and archives. It should feel like well-made professional equipment — closer to a good NAS admin interface or a build server than to a consumer app. Restrained use of the brand green; let the data and the status be what the eye goes to.
