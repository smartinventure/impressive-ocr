# Web File Browser — reusable template

A server-side filesystem browser: an Express router that lists/stats/creates
directories, plus a React modal and a form field that uses it. Extracted from
borgmatic-ui so it can be dropped into other projects.

```
filebrowser/
├── frontend/
│   ├── FileExplorerModal.tsx    Full browser modal (navigate, filter, select, mkdir)
│   ├── PathSelectorField.tsx    Text input + "browse" button that opens the modal
│   └── filesystemApi.ts         Standalone axios client for the three endpoints
└── backend/
    ├── filesystem.js            Express router (browse / validate-path / create-directory)
    └── auth-middleware.js       Auth placeholder — FAILS CLOSED until you replace it
```

## Read this first: the security model

The router exposes **the entire filesystem the server process can reach**. There
is no root-directory jail, and that is deliberate — the original app is an
admin-only backup tool that has to be able to pick any path on the host.

Consequences for a new project:

- **Keep `requireAdmin`.** Browse + `create-directory` in the hands of a normal
  user is a filesystem disclosure and a write primitive.
- The bundled `auth-middleware.js` rejects every request with 501 until you
  replace it. That is intentional, so an unfinished port can't ship wide open.
- Inputs are checked for type/emptiness/null bytes and resolved with
  `path.resolve`, but **`..` is not rejected** — traversal is the feature here.
  If your project needs a jail, add it (see "Confining to a root" below).
- Responses include owner-ish metadata (octal permissions, sizes, mtimes).

## Backend

### Install

```bash
npm install express fs-extra
```

### Mount

```js
const filesystemRoutes = require('./routes/filesystem');
app.use('/api/filesystem', filesystemRoutes);
```

Then edit `auth-middleware.js` to re-export your own middleware:

```js
const { authenticateToken, requireAdmin } = require('../middleware/auth');
module.exports = { authenticateToken, requireAdmin };
```

`authenticateToken` must set `req.user` and answer 401 otherwise; `requireAdmin`
must answer 403 for non-admins.

### API

**`GET /browse`** — list a directory.

| Query | Values | Notes |
| --- | --- | --- |
| `path` | absolute path, default `/` | resolved with `path.resolve` |
| `mode` | `directories` \| `files` \| `both` | controls what is *selectable*, not what is listed |
| `detect_borg` | `true` / `1` | opt-in Borg-repository probe, off by default |

```jsonc
{
  "success": true,
  "data": {
    "current_path": "/home/user",
    "parent_path": "/home",
    "is_root": false,
    "total_items": 2,
    "items": [{
      "name": "documents",
      "path": "/home/user/documents",
      "is_directory": true,
      "is_file": false,
      "is_symlink": false,
      "size": 4096,          // null if the entry could not be stat'ed
      "modified": "2026-01-01T12:00:00.000Z",
      "is_borg_repo": false, // always false unless detect_borg=true
      "is_accessible": true, // false = listed but stat failed or timed out
      "permissions": "755"
    }]
  }
}
```

Errors: `400` invalid path / not a directory, `403` permission denied, `404`
missing path, `500` otherwise. All use `{ success: false, error }`.

**`POST /validate-path`** — `{ path }` → existence + stat info (`exists` is
`false` with `success: true` when the path is simply absent, so callers can
distinguish "missing" from "failed").

**`POST /create-directory`** — `{ path }` → creates recursively via
`fs.ensureDir`. `409` if the path already exists.

### Why the code looks the way it does

The non-obvious parts exist because this ran against network and cloud mounts,
where the naive version hangs:

- **Every probe is bounded.** A single `lstat` on a CIFS/NFS/Synology share can
  block until the reverse proxy times out and 504s the whole listing, so entry
  stats get `ENTRY_STAT_TIMEOUT_MS` (3s) and Borg probes `BORG_DETECT_TIMEOUT_MS`
  (1.5s). An entry that times out is still listed, flagged `is_accessible: false`.
- **`lstat`, not `stat`.** `stat` follows symlinks; a link to an offline target
  would stall the listing.
- **Borg detection is opt-in and cached** (5 min). It probes one level deeper
  than the listing, which on an rclone-mounted blob container with millions of
  objects can force a full enumeration.
- **Directories are always listed**, even in `files` mode — otherwise you cannot
  navigate to the files. `mode` only filters what the UI lets you select.
- **`EACCES` dumps process diagnostics** (uid/gid, capabilities, seccomp,
  AppArmor, target mode) to the log via `describeProcessEnvironment`. In a
  container an `EACCES` on a path the host root can read usually means a dropped
  capability or a userns remap, not a real POSIX permission problem, and this
  turns a support round-trip into one log line.

### Confining to a root

Not implemented here. If you need it, gate `absolutePath` in all three handlers:

```js
const ROOT = path.resolve(process.env.BROWSE_ROOT || '/srv/data');
if (absolutePath !== ROOT && !absolutePath.startsWith(ROOT + path.sep)) {
    return res.status(403).json({ success: false, error: 'Path outside allowed root' });
}
```

Note this still resolves symlinks late — use `fs.realpath` before the check if
the tree may contain links pointing out of the jail.

## Frontend

### Install

```bash
npm install axios react-query lucide-react react-hot-toast
```

Built against React 18, `react-query` **v3** (`useQuery(key, fn, opts)`,
`isLoading`), `lucide-react` for icons, `react-hot-toast` for mkdir feedback,
and Tailwind for styling — the markup assumes Tailwind utility classes and a
`<Toaster />` mounted somewhere. Porting to TanStack Query v4/v5 means switching
to the object signature, renaming `isLoading` → `isPending`, and moving the
query's `onError` out of the options.

`filesystemApi.ts` reads `import.meta.env.VITE_API_URL` (Vite) and a bearer
token from `localStorage.access_token`. If you already have an axios instance,
delete that block and point `filesystemAPI` at yours — only the three endpoints
matter.

### Usage

The field is what you want in a form — text input plus a folder button, so a
path can be typed or picked:

```tsx
<PathSelectorField
  label="Backup destination"
  value={path}
  onChange={setPath}
  selectMode="directories"
  helperText="Where archives are written"
  required
/>
```

The modal directly, when you need control:

```tsx
<FileExplorerModal
  isOpen={open}
  onClose={() => setOpen(false)}
  onSelect={(paths) => setPath(paths[0])}
  initialPath="/var/log"
  selectMode="files"
  multiSelect
  title="Select log files"
/>
```

| Prop | Default | Purpose |
| --- | --- | --- |
| `selectMode` | `directories` | `directories` \| `files` \| `both`; changes the footer buttons |
| `multiSelect` | `false` | Adds checkboxes; `onSelect` receives several paths |
| `initialPath` | `/` | Opening directory |
| `detectBorgRepos` | `false` | Enables the badge + select-instead-of-navigate behaviour |
| `selectButtonText` | `Select` | Confirm label in `files` mode |

`PathSelectorField` adds `onBrowseSelect`, a transform applied only to
browser-picked paths (not typed ones) — used in the original to rewrite a picked
path into a container-relative one. With `multiSelect`, it joins paths with
commas into the single input value.

Interaction model: single click navigates into a directory or selects a file;
double click selects and closes; breadcrumbs, home, up, refresh and a name
filter sit in the toolbar; the folder-plus button creates a directory and
navigates into it. A `404` renders "Directory does not exist" with a nudge
toward that create button, which makes "type a path that doesn't exist yet, then
create it" a one-step flow.

## Stripping the app-specific bits

Two features are borgmatic/Docker specific. Both are self-contained:

**Borg repository detection** — drop `detectBorgRepo`, the two `BORG_DETECT_*`
constants, `borgDetectCache`, the `detect_borg` query param and the
`is_borg_repo` field in `filesystem.js`; in `FileExplorerModal.tsx` drop the
`detectBorgRepos` prop, the `Database` icon branch, the "Borg Repo" badge and
the `is_borg_repo` branch in `handleItemClick`. Keep `withTimeout` — the entry
stat guard uses it too.

**`/host` Docker banner** — the blue "Running in Docker?" banner near the top of
the modal, plus the `Monitor` icon, the emerald row highlight and the "Host
System" badge keyed on `item.path === '/host'`. Delete or rewrite for your own
mount convention.

## Provenance

Copied from borgmatic-ui (frontend v1.0.68 / backend v1.0.68). The files are
**verbatim** apart from two rewired imports:

| File | Change from original |
| --- | --- |
| `frontend/FileExplorerModal.tsx` | imports `filesystemAPI` from `./filesystemApi` instead of `../services/api` |
| `frontend/PathSelectorField.tsx` | none |
| `backend/filesystem.js` | requires `./auth-middleware` instead of `../middleware/auth` |
| `frontend/filesystemApi.ts` | new — extracted from `frontend/src/services/api.ts` |
| `backend/auth-middleware.js` | new — fail-closed placeholder |

Originals: `frontend/src/components/{FileExplorerModal,PathSelectorField}.tsx`,
`frontend/src/services/api.ts` (`filesystemAPI`),
`nodejs/src/routes/filesystem.js`.
