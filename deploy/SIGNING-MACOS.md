<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Signing and notarising an Electron app for macOS

Written for Impressive OCR, but nothing here is specific to it: any Electron app built with
electron-builder and released from GitHub Actions needs exactly these steps. Hand it to
another team as-is.

Windows signing is a separate, unrelated path — Azure Trusted Signing in our case — and the
two share no credentials, no runner and no configuration. Setting up macOS changes nothing
about Windows.

---

## The one thing to understand first

**Signing and notarising are two different things, and you need both.**

| | What it is | What happens without it |
|---|---|---|
| **Signing** | Your Developer ID certificate proves who built the app | macOS says "unidentified developer" and refuses to open it |
| **Notarising** | Apple scans the signed app and issues a ticket | Gatekeeper blocks it — *on other people's machines only* |

That last column is why this catches people out. A signed but un-notarised app **runs
perfectly on the machine that built it**. It fails only after someone downloads it, because
the quarantine flag that triggers the check is set by the browser, not by the build. You
cannot test this by double-clicking your own build; you have to check the notarisation ticket
explicitly, which is what `xcrun stapler validate` does and what our CI now does for you.

---

## Part 1 — What you do at Apple (about 30 minutes)

You need an Apple Developer Program membership (99 USD/year). Everything below is done once.

### 1. Find your Team ID

[developer.apple.com/account](https://developer.apple.com/account) → **Membership details**.

It looks like `A1B2C3D4E5` — ten characters. Save it; it becomes `APPLE_TEAM_ID`.

### 2. Create a Developer ID Application certificate

**Certificates, Identifiers & Profiles → Certificates → ➕ → Developer ID Application.**

Pick **Developer ID Application**, not "Mac App Distribution" and not "Developer ID
Installer". Those are for the Mac App Store and for `.pkg` installers respectively; we ship a
`.dmg` containing a `.app`, which is what "Developer ID Application" signs.

**Then Apple asks which intermediate certificate authority to use. Choose
`Developer ID G2 Sub-CA`** — the default.

The alternative exists only for signing software that must run through Xcode older than
11.4.1 (2020), which is irrelevant here: this is electron-builder, not Xcode, and notarisation
needs current tooling anyway. It is also a trap, because Apple's own note on that screen says
certificates on the previous Sub-CA **expire on 01 February 2027** regardless of when they are
created. Choosing it buys a certificate with months of life instead of five years.

### Creating the Certificate Signing Request

**On a Mac:** Keychain Access → Certificate Assistant → *Request a Certificate From a
Certificate Authority*, choose "Saved to disk".

**On Windows or Linux** — no Mac is needed for this, which matters because most Apple guides
assume one.

> **Windows: use WSL or Git Bash, not PowerShell.** OpenSSL is not on the PowerShell PATH —
> Git for Windows ships it at `C:\Program Files\Git\usr\bin\openssl.exe` — and the `\`
> line-continuations below are shell syntax PowerShell does not accept; it uses a backtick.
>
> **WSL is the easier of the two**, because it is real Linux: no path mangling, so
> `MSYS_NO_PATHCONV=1` does nothing there and can be left in or dropped as you prefer.
>
> If you use WSL, work in a Windows directory rather than the WSL home directory:
>
> ```sh
> mkdir -p /mnt/c/Users/<you>/apple-signing && cd $_
> ```
>
> You have to upload the `.csr` from a Windows browser and pick the `.cer` back up out of
> Windows Downloads, and a file under `/mnt/c` is visible to both sides with no copying.
> Keep that folder outside any git repository, and move it to offline backup when you are done.

```sh
# Git Bash, macOS or Linux.
#
# MSYS_NO_PATHCONV=1 applies to Windows only, and there it is not optional: without it Git
# Bash rewrites the leading slash of -subj into a Windows path and openssl fails with
#   "This name is not in that format: 'C:/Program Files/Git/emailAddress=...'"
# It is harmless everywhere else, so the command stays the same on every platform.
MSYS_NO_PATHCONV=1 openssl req -new -newkey rsa:2048 -nodes \
  -keyout developer-id.key \
  -out developer-id.csr \
  -subj "/emailAddress=you@example.com/CN=Your Company Name/C=DE"
```

Check it recorded what you meant before uploading anything:

```sh
openssl req -in developer-id.csr -noout -subject
# subject=emailAddress=you@example.com, CN=Your Company Name, C=DE
```

Do not agonise over those values. Apple **ignores** the CN and email in the request for a
Developer ID certificate: the issued certificate is always named
`Developer ID Application: <your team name> (<TEAMID>)`, taken from your account rather than
from the CSR. What must be right is the key — RSA 2048, which is what `-newkey rsa:2048`
above produces.

Upload `developer-id.csr`, download the resulting `developerID_application.cer`, then combine
it with your private key into the `.p12` electron-builder wants:

```sh
openssl x509 -inform DER -in developerID_application.cer -out developer-id.pem
openssl pkcs12 -export \
  -inkey developer-id.key \
  -in developer-id.pem \
  -out developer-id.p12 \
  -name "Developer ID Application"
```

It asks for an export password. Choose a strong one — it becomes `APPLE_CERT_PASSWORD`.

`developer-id.key` is the private half and never leaves your machine; Apple only ever sees the
`.csr`. Keep the key until the `.p12` exists, then back both up together.

> **If the CI runner later fails to import the `.p12`**, re-export with the older algorithms
> macOS has always accepted — OpenSSL 3 defaults to AES-256, which some `security import`
> paths reject:
>
> ```sh
> openssl pkcs12 -export -inkey developer-id.key -in developer-id.pem \
>   -out developer-id.p12 -name "Developer ID Application" \
>   -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
> ```
>
> Do not reach for `-legacy` instead: it needs OpenSSL's legacy provider, which a default Git
> for Windows install does not load.

**On a Mac**, the `.p12` comes out of Keychain Access instead: double-click the `.cer` to
install it, then *My Certificates* → right-click `Developer ID Application: …` → Export.

> **Back up `developer-id.p12` and its password somewhere safe and offline.** Apple allows
> only a limited number of Developer ID certificates per account, and they cannot be
> re-downloaded with the private key. Losing it is genuinely painful.

### 3. Notarisation credentials

Two options. The API key is better, but it is **not available on day one**, so read both
before deciding which to start with.

#### 3a. App Store Connect API key — preferred, but gated

[appstoreconnect.apple.com](https://appstoreconnect.apple.com) → **Users and Access** →
**Integrations** → **App Store Connect API**.

**On a new account there is no "Team Keys" tab — only a `Request Access` button.** API access
is a one-time opt-in that has to be granted before any key can be created:

1. Click **Request Access**.
2. Tick the box to accept the terms, and **Submit**.

Two things about that request:

- **Only the Account Holder can make it.** For anyone else the button is disabled, and no
  Admin can substitute.
- **It is not instant.** Apple's documentation says the request "is reviewed and approved on
  a case-by-case basis" and gives no timeline.

Once granted, the **Team Keys** and **Individual Keys** tabs appear. Then → **Team Keys** → ➕

- Name it something like `notarization-ci`.
- Access: **Developer** is enough.

- It must be a **Team Key**, not an Individual Key. Individual keys cannot notarise —
  `notarytool` rejects them and the error does not say why.
- The `.p8` file **downloads exactly once**. Save it immediately and back it up.

That gives three values: the `AuthKey_XXXXXXXXXX.p8` file, the **Key ID** (in the filename and
the table) and the **Issuer ID** (a UUID above the key list).

#### 3b. Apple ID and an app-specific password — the fallback

Works immediately, notarises identically, and is the sensible way to get a release out while
the API request is pending. The only difference is breadth: this credential is tied to your
whole Apple account rather than scoped to notarisation, and it breaks when you change your
password or your 2FA device.

[account.apple.com](https://account.apple.com) → **Sign-In and Security** →
**App-Specific Passwords** → ➕. Name it `notarization-ci`. You get `abcd-efgh-ijkl-mnop`,
shown once.

You need the Apple ID email, that password, and your Team ID.

**The build picks whichever set you have configured**, preferring the API key when both are
present, and warns in the log while it is using an Apple ID. Migrating later means adding the
three API-key secrets — nothing in the workflow changes, and you can delete the Apple-ID pair
afterwards.

---

## Part 2 — What you put into GitHub

Repository → **Settings → Secrets and variables → Actions → Secrets** → *New repository
secret*. All six are **secrets**, not variables — a value on the Variables tab is public.

Always, whichever notarisation route you took:

| Secret | Value |
|---|---|
| `APPLE_CERT_BASE64` | The `.p12`, base64-encoded |
| `APPLE_CERT_PASSWORD` | The `.p12` export password |
| `APPLE_TEAM_ID` | Team ID, e.g. `A1B2C3D4E5` |

Then **either** the API key (3a):

| Secret | Value |
|---|---|
| `APPLE_API_KEY_BASE64` | The `.p8`, base64-encoded |
| `APPLE_API_KEY_ID` | Key ID, e.g. `ABC123XYZ9` |
| `APPLE_API_ISSUER` | Issuer ID, the UUID |

**or** the Apple ID (3b):

| Secret | Value |
|---|---|
| `APPLE_ID` | The Apple ID email |
| `APPLE_APP_PASSWORD` | The app-specific password, `abcd-efgh-ijkl-mnop` |

Setting both is safe — the API key wins and the build says so. Setting neither, with a
certificate present, fails the build rather than shipping something un-notarised.

Encoding the two files — the flags differ per platform, and a wrapped base64 string is the
single most common cause of a failed setup:

```sh
# macOS — Terminal
base64 -i developer-id.p12 | pbcopy
base64 -i AuthKey_ABC123XYZ9.p8 | pbcopy

# Linux — any shell. -w0 keeps it on one line
base64 -w0 developer-id.p12
base64 -w0 AuthKey_ABC123XYZ9.p8

# Windows — Git Bash. Note -w0, as on Linux
base64 -w0 developer-id.p12
base64 -w0 AuthKey_ABC123XYZ9.p8
```

```powershell
# Windows — PowerShell. This one is PowerShell, unlike the openssl commands above,
# which need Git Bash. Copies straight to the clipboard, always on a single line.
[Convert]::ToBase64String([IO.File]::ReadAllBytes("developer-id.p12")) | Set-Clipboard
[Convert]::ToBase64String([IO.File]::ReadAllBytes("AuthKey_ABC123XYZ9.p8")) | Set-Clipboard
```

Our workflow checks that `APPLE_API_KEY_BASE64` decodes to something starting with
`BEGIN PRIVATE KEY` and fails immediately if not, rather than letting a truncated paste
surface twenty minutes later as an opaque `notarytool` error.

---

## Part 3 — What the build already does

Two pieces of electron-builder behaviour are worth knowing, because both are counter-intuitive
and both are easy to get wrong from a blog post.

**Notarisation is on by default.** In electron-builder 25 and later, `mac.notarize` exists
only to *disable* it — the schema literally reads *"whether to disable … notarize
integration"*. Notarisation runs whenever credentials resolve. Advice telling you to set
`"notarize": true` is either about an older version or simply wrong; it is harmless but
unnecessary. Advice telling you to nest signing options under `mac.sign` is about
**electron-builder 27** and will not work on 26.

**Apple-ID credentials silently beat the API key.** electron-builder checks `APPLE_ID` and
`APPLE_APP_SPECIFIC_PASSWORD` *first*, and if **either** is set it commits to that path and
throws if the rest is missing. It never falls back to the API key — so passing both through
would quietly use the weaker one, and a half-configured Apple ID would fail a build that had
a perfectly good API key sitting next to it.

Our workflow therefore chooses **one** set in a step of its own and puts only that into scope,
rather than handing electron-builder everything and hoping. If you write your own, do the
same: an empty string is falsy to electron-builder, but an accidentally-set `APPLE_ID` is not.

The configuration this needs is already in `apps/desktop/electron-builder.yml`:

```yaml
mac:
  hardenedRuntime: true # a notarisation prerequisite; Apple rejects unhardened apps
  gatekeeperAssess: false # the runner has no notarisation ticket yet at signing time
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
```

The entitlements are not boilerplate. Electron needs `allow-jit` and
`allow-unsigned-executable-memory` or the app **crashes on launch once hardened**, and an app
that downloads a runtime after installation — as this one does — needs
`disable-library-validation` or the hardened runtime refuses to load it.

---

## Part 4 — Prove it works, before a release depends on it

Do **not** discover a broken signing setup by cutting a release. Run the verification workflow
first:

**Actions → Verify code signing → Run workflow → platform: `macos`**

It builds, signs, notarises and then checks four things that can each fail while the build
still reports success:

1. `codesign --verify --deep --strict` — the signature is intact.
2. The signing authority actually begins `Developer ID Application:`.
3. The `runtime` flag is present, i.e. the app really is hardened.
4. **`xcrun stapler validate`** — the only local proof Apple notarised it, rather than
   electron-builder having skipped the step with a warning nobody read.

Then `spctl --assess --type exec` reports what Gatekeeper will say on a user's machine. A
notarised app prints:

```text
source=Notarized Developer ID
```

Expect the first run to take **10–40 minutes**: notarisation is a round trip to Apple, and it
is occasionally much slower than that. The build is not hung.

Once that passes, `deploy/release.sh` needs nothing new — the release workflow uses the same
steps.

---

## Building on a Mac by hand

`deploy/build-local.sh` signs and notarises too, from `deploy/.env.local`:

```sh
CSC_LINK=/absolute/path/to/developer-id.p12
CSC_KEY_PASSWORD=…
APPLE_API_KEY_FILE=/absolute/path/to/AuthKey_ABC123XYZ9.p8
APPLE_API_KEY_ID=ABC123XYZ9
APPLE_API_ISSUER=…
APPLE_TEAM_ID=…
```

Then `./deploy/build-local.sh desktop` on a Mac. With the certificate but no
`APPLE_API_KEY_FILE` it signs without notarising and says so — useful for a quick local check,
never for something you hand to anyone.

---

## When it goes wrong

| Symptom | Cause |
|---|---|
| `This name is not in that format: 'C:/Program Files/Git/emailAddress=...'` | Git Bash rewrote the `-subj` path. Prefix the command with `MSYS_NO_PATHCONV=1` |
| `openssl: command not found` in PowerShell | OpenSSL ships with Git, not Windows. Run it in Git Bash |
| `APPLE_ID env var needs to be set` | Something set `APPLE_ID` or `APPLE_APP_SPECIFIC_PASSWORD`; electron-builder took that path and ignored the API key |
| `skipped macOS notarization: options were unable to be generated` | No credentials resolved. The build **succeeds** and ships an un-notarised app — this is the dangerous one, and why CI checks the staple |
| `Team ID is not valid` / `Unable to notarize` | An Individual API key instead of a Team key |
| No **Team Keys** tab, only `Request Access` | API access has not been granted yet. Only the Account Holder can request it, and Apple reviews it. Use 3b meanwhile |
| `Request Access` is greyed out | You are not the Account Holder |
| `The specified item could not be found in the keychain` | `APPLE_CERT_BASE64` is truncated, wrapped, or the wrong file |
| Notarised, but crashes at launch | Missing `allow-jit` / `allow-unsigned-executable-memory` entitlements |
| `spctl` says `source=Unnotarized Developer ID` | Signed but never notarised |
| Rejected: "The binary is not signed with a valid Developer ID certificate" | A Mac App Store certificate was used instead of Developer ID |

Apple's own log for a rejected submission is the fastest way to a real answer:

```sh
xcrun notarytool log <submission-id> \
  --key AuthKey_ABC123XYZ9.p8 --key-id ABC123XYZ9 --issuer <issuer-uuid>
```

---

## Renewals

- The **Developer ID certificate** lasts five years. It does **not** expire out from under
  already-notarised apps: notarisation tickets remain valid, so shipped software keeps working.
  You need a new certificate only to sign something new.
- The **Apple Developer Program membership** is annual. Let it lapse and the certificate is
  revoked, which *does* break new signing.
- The **API key** does not expire, but revoke it if it leaks — it can be replaced in minutes,
  which is another reason to prefer it over Apple-ID credentials.
