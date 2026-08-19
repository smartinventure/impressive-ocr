# AI Coding Agent Rules — Impressive OCR

This file defines how all AI assistants must behave in this repository.

Impressive OCR is an **AGPL-3.0**, local-first OCR workstation: a Node/TypeScript backend and
Vue 3 + Vuetify web UI that watch folders, queue documents, and OCR them through a Python
**PaddleOCR** sidecar, writing Markdown / JSON / TXT / DOCX / XLSX / searchable-PDF outputs.
It ships as an Electron desktop app and as a headless server.

---

## 1. Security

- Always validate server-side input. Cross every boundary as `unknown`, then parse with a zod
  schema from `packages/shared`. Never trust a client-supplied type.
- **Filesystem paths are the highest-risk input in this product.** Every user-supplied path must be
  canonicalized (`fs.realpath`) and validated against the configured folder allowlist before use.
  Reject `..`, symlink escapes, and UNC paths that resolve outside the allowlist. Use the helpers in
  `apps/server/src/infra/fs/` — never hand-roll path checks.
- Escape all HTML output. Never render OCR-derived text as raw HTML.
- Never trust client fields like role, owner, or redirect. Allow only internal redirects.
- Apply restrictive CORS (explicit origins only). Bind `127.0.0.1` by default; binding `0.0.0.0`
  requires authentication to be enabled.
- Use CSRF tokens for mutating requests once authentication exists.
- Apply security headers (CSP, X-Frame-Options, nosniff).
- Enforce safe file handling: validate MIME/extension, limit size, never execute input.
- Show generic user errors; log detailed errors server-side.
- Use parameterized queries via Drizzle. Never concatenate SQL.
- Never log secrets, tokens, or document contents. Document text is user PII.
- The sidecar auth token and the DB path are secrets. Keep dependencies patched.

If generated code violates any of these, fix it automatically.

---

## 2. File size & structure

- **Hard cap: ~500 lines per file.** Approaching it means the file has more than one
  responsibility — split it. Split by responsibility, never by arbitrary line count.
- Vue SFCs: ~300 lines. Move logic into `composables/`, keep the template declarative.
- Python modules: ~400 lines.
- One primary export concept per file. File name states the role.

### Layering rule

```
http/routes  →  modules  →  infra
```

- **Routes are thin**: validate input, call a service, map the response. No DB access, no business
  logic, no filesystem work.
- **Modules hold domain logic** and must not import Fastify, Electron, or anything HTTP-shaped.
  This is what keeps the backend runnable inside Electron *and* headless.
- **Infra** holds logging, paths, filesystem and process helpers. It imports nothing from modules.
- `packages/shared` is the **single source of truth** for contracts (server ↔ web ↔ sidecar) and
  imports nothing from `apps/`.
- Nothing Electron-specific may leak into `apps/server`.

### Where code goes

| Kind of change | Location |
|---|---|
| New REST endpoint | `apps/server/src/http/routes/` + a service in `modules/` |
| New domain rule | `apps/server/src/modules/<feature>/` |
| New shared type or contract | `packages/shared/src/` |
| New DB table/column | `packages/db/src/schema/` + a generated migration |
| New UI screen | `apps/web/src/features/<feature>/views/` |
| New OCR engine or output format | `sidecar/src/impressive_ocr_sidecar/engines/` or `writers/` |

---

## 3. Naming & style

**TypeScript**

- `camelCase` variables and functions; `PascalCase` types, interfaces, classes, Vue components.
- Booleans read as predicates: `isRunning`, `hasTextLayer`, `canUseGpu`, `shouldRetry`.
- Files: `lowercase.role.ts` — `pipeline.service.ts`, `sidecar.client.ts`, `safe-path.ts`.
- Folders: `kebab-case`.
- **Named exports only** (Vue SFCs and config files excepted).
- Do **not** prefix interfaces with `I`. Name the concept: `OcrEngine`, not `IOcrEngine`.
- CSS classes and element IDs: `kebab-case`.

**Python**

- `snake_case` functions and modules, `PascalCase` classes, `UPPER_SNAKE` constants.

Prefer clarity over brevity. Avoid abbreviations. No Hungarian notation.

---

## 4. Clean code & architecture

- Return early; avoid deep nesting.
- No magic strings or numbers — use named constants or config.
- Single responsibility per function. Follow SOLID.
- Avoid boolean parameters; use a union of string literals or separate functions.
- Limit parameters to 3; pass an options object beyond that.
- Remove dead code. Prefer composition over inheritance.
- **Inject dependencies via constructor or factory arguments.** No singletons, no module-level
  mutable state, no service locator. `app.ts` is the only composition root.
- Prefer an interface (or Python `Protocol`) for anything with more than one implementation —
  notably `OcrEngine`.

### TypeScript specifics

- `strict` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on. Respect them.
- **No `any`.** Use `unknown` and narrow. No `as` casts to silence the compiler; fix the type.
- Use `type` imports (`import type { … }`).
- Model states as discriminated unions, not optional-field soup.
- Return `Result`-style unions or throw typed errors — never return `null` to mean "failed".

### Async

- Every long-running operation takes an `AbortSignal` and honours it. OCR jobs, downloads, watchers
  and HTTP streams must all be cancellable — pause/stop in the UI depends on it.
- `Promise.all` for parallel work; always set timeouts on external calls.
- Never `process.exit()` outside an entry point. Shut down through the app handle.
- No floating promises. Await, or explicitly `void` with a comment.

### Errors, resources, logging

- Catch specific errors. Define typed errors in the module that owns them; map them to HTTP status
  codes in one central error handler.
- Structured logging with pino: `logger.error({ err, jobId }, 'OCR job failed')`. Never string
  concatenation, never `console.log`.
- Dispose what you open: file handles, watchers, child processes, DB statements, SSE connections.
- Retry external/flaky work with bounded exponential backoff, defined in one place per module.

---

## 5. Vue & Vuetify

- `<script setup lang="ts">` only. Props and emits fully typed via `defineProps`/`defineEmits`.
- Components are presentational. Business logic lives in composables or Pinia stores.
- Pinia for cross-view state only. Local state stays local.
- Use Vuetify theme tokens — never hard-code colours, spacing or fonts.
- All user-facing strings go through i18n (`en`, `de`). German runs ~30% longer; don't build
  layouts that break on it.
- Nothing may depend on Electron-only affordances: the same SPA must work in a plain browser
  against the headless server.

---

## 6. Electron

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. No remote module.
- All IPC channels are typed and their payloads validated on the main-process side.
- The preload script only uses `contextBridge` to expose a narrow, explicit API.
- Never load remote content into a `BrowserWindow`.

---

## 7. Python sidecar

- Type hints everywhere. `ruff` and `mypy` must be clean.
- The engine interface is a `typing.Protocol`; implementations live one per file.
- No global mutable state except the deliberate warm-model cache.
- Long operations report progress through the NDJSON stream rather than blocking silently.
- Never `print()`; use the configured logger.

---

## 8. Testing & workflow

- Vitest for TypeScript (unit + integration), pytest for the sidecar, Playwright for e2e.
- Test files mirror the source structure: `pipeline.service.test.ts` beside `pipeline.service.ts`.
- Naming: `describe('PipelineService')` > `it('rejects an input path outside the allowlist')`.
- Test behaviour and edge cases, not implementation details. Every bug fix gets a regression test.
- Code must pass `pnpm lint`, `pnpm typecheck` and `pnpm test` with zero warnings before commit.
- Verify the build passes before committing. Never commit generated output or user data.

---

## 9. Licensing

- The project is **AGPL-3.0-or-later**. New source files carry the standard SPDX header:
  `// SPDX-License-Identifier: AGPL-3.0-or-later`
- Third-party dependencies must be AGPL-compatible. Record them in `NOTICE`.
  PaddleOCR is Apache-2.0; PyMuPDF is AGPL-3.0.
- **No telemetry.** Nothing about a user's documents ever leaves their machine.

---

## 10. AI assistant behaviour

- Follow all rules above in generated code.
- When unsure, choose the secure and maintainable option.
- Never relax security rules unless explicitly requested.
- Match existing code style and conventions; follow the existing project structure for new files.
- Prefer minimal, focused changes.
- Verify generated code typechecks and lints.
- If a file would exceed ~500 lines, split it rather than appending.
