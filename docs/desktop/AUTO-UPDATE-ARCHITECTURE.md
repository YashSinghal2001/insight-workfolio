# Desktop auto-update: architecture

Status (2026-11-17): implemented and tested locally. The macOS update flow was verified end to end with a QA
build against an isolated QA API. Windows has not been tested on a physical machine, nothing is deployed, and
no release has been published. See `docs/qa/AUTO-UPDATE-MACOS-QA.md` and `docs/qa/AUTO-UPDATE-WINDOWS-QA.md`.

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Mechanism | The official **Tauri updater plugin**, version 2.14.1. That is the Rust crate `tauri-plugin-updater` and the npm package `@tauri-apps/plugin-updater`, both pinned exactly. The app uses Tauri 2.12.3 and CLI 2.12.2. | It verifies minisign signatures and, with `requireSignedVersion`, the version a package is signed for. It enforces https endpoints in release builds, and it handles both the NSIS installer and the macOS `.app.tar.gz` package. |
| Manifest source | A **dynamic endpoint on the API**: `GET /api/v1/desktop-updates/manifest/{{target}}/{{arch}}/{{current_version}}`. It is public and never cached. | The decision lives centrally in the database (status, rollout, policy, minimum version). No release URL is hardcoded in the app. The app only knows its API URL, which is already baked in at build time. |
| Package storage | Releases **reference** https URLs plus `.sig` content. The CI workflow attaches packages to a GitHub *pre-release*. Any https host, such as a download folder on the VPS behind Caddy, works too. | No upload pipeline or storage quota on the VPS. The packages aren't secret. A URL is useless without a matching signature from the private key. |
| Channels (dev / QA / production) | **One channel per deployment, not a column.** Development builds have no updater. QA uses the staging build (`WORKFOLIO_ENV=staging`) with the staging API and its own key pair. Production uses the production build with the production API and its own key pair. | Each build has its API URL and public key baked in, so a QA build can't read the production manifest, and it would reject production-signed packages if it did. |
| Who sees a release | `DRAFT`: nobody. `TESTING`: only devices registered to an **administrator** account. `PUBLISHED`: employees, subject to rollout. `DISABLED`: nobody. | IT tests on their own machines without a separate allow-list. |
| Mandatory updates | The **minimum supported version** is the highest of every published release's `minimumVersion` and the version of every published `MANDATORY` release. An installation below it gets `mandatory: true` and bypasses the rollout. | One rule covers both "this release is mandatory" and "versions below X are unsupported". |
| Enforcement | **In the app.** Below the minimum, *Clock in* is disabled and the update can't be postponed. Clock-out, breaks, sync and everything else keep working. The API does not refuse old clients. | The prompt requires never terminating active work. The installed 0.2.0 doesn't send its version, so server-side refusal couldn't target it anyway. |
| Restart | Never automatic. The employee clicks **Update now** (download and verify), then **Restart to update**, then **Restart now** after the warning ("You are clocked in… Save your work first"). | Restarting doesn't clock anyone out. Activity and screenshots pause for the restart (about a minute). |
| Device identity | **Untouched by design.** The updater replaces only the app bundle or binary. The installation ID and refresh token stay in the OS credential store under the bundle identifier, and the queue database stays in the app data directory. Both are keyed by the identifier, which an update never changes. | `installation_id()` creates an ID only when the credential store reports *no entry*. Any other error, such as a denied Keychain prompt, is returned to the app and never replaced. |

## Components

```
GitHub Actions (manual)                API (NestJS)                         Desktop app (Tauri)
desktop-release.yml                    desktop-updates module               src/updates-ui.ts
 ├ builds + tests                       ├ releases CRUD (admin)              ├ check() at start (+5 s), every 4 h, on demand
 ├ signs packages (updater key)  ──►    ├ verify packages on Test/Publish    ├ shows version, notes, size, policy
 ├ code-signs/notarizes (opt.)          │   (download + minisign + version)  ├ download() with progress → verified by plugin
 └ GitHub pre-release + .sig            ├ GET manifest/{target}/{arch}/{v}   ├ install() → restart (with confirmation)
                                        │   (public, rollout, minimum)  ◄─── ├ POST /desktop-updates/status
Dashboard /desktop-updates ───────────► ├ POST status (desktop session)      └ mandatory: Clock in disabled
 releases, publish, history, devices    └ GET devices (update status)
```

### API (`apps/api/src/desktop-updates/`)

| Route | Permission | Purpose |
| --- | --- | --- |
| `GET /desktop-updates/manifest/:target/:arch/:version` | public | Tauri "dynamic" manifest (`version`, `notes`, `pub_date`, `url`, `signature`), plus `policy`, `mandatory`, `minimumVersion`, `postponeHours`, `sizeBytes`, `releaseId`. Returns 204 when there is nothing to install. The optional `X-Device-Id` header is used for the rollout bucket and to recognise administrators' test devices. It is hashed and not stored. |
| `POST /desktop-updates/status` | `updates:report` (desktop session) | Body: `installedVersion`, `availableVersion`, `state` (one of `UP_TO_DATE`, `AVAILABLE`, `POSTPONED`, `DOWNLOADING`, `INSTALLING`, `FAILED`), `failureReason`. The device is resolved from the account plus the installation. |
| `GET/POST /desktop-updates/releases`, `PATCH /desktop-updates/releases/:id` | `updates:manage` | Create and edit releases. Changing a *published* release's policy, rollout or minimum version also needs `updates:publish`. A published release's packages can't change. |
| `POST /desktop-updates/releases/:id/status` | `updates:manage`, plus `updates:publish` for anything to or from `PUBLISHED` except disabling | Moving to `TESTING` or `PUBLISHED` downloads every package and verifies it first. Publishing also requires a version higher than every other published one. |
| `GET /desktop-updates/releases/:id/history` | `updates:manage` | Append-only release events: who, what, why. |
| `GET /desktop-updates/devices` | `updates:manage` | Every registered device with its last reported state. Devices on apps that predate updates show as "unknown". |

Rollout bucket: `sha256(releaseId + ":" + installationId)`, first 4 bytes, modulo 100. It is stable per device and release, so the same machine stays in or out as the percentage grows.

### Database (migration `0032_desktop_updates`, additive)

- `desktop_releases`: the version (unique), notes, status, policy, `postpone_hours`, `rollout_percent`, `minimum_version`, and who created and published it, and when.
- `desktop_release_artifacts`: one row per release and target (`windows-x86_64`, `darwin-aarch64`, `darwin-x86_64`), holding the URL, signature, `size_bytes`, `sha256` and `verified_at`. Only verified rows are served.
- `desktop_release_events`: the append-only release history; triggers refuse UPDATE and DELETE.
- `desktop_update_status`: one row per device, overwritten on each report. When the installed version goes up, it records `last_updated_at` and `last_updated_from`.

Nothing else is collected: only versions, the update state and a short reason. There is no activity, no screenshots and no paths.

### Desktop app

- `src-tauri/src/lib.rs`
  - The plugin is registered only when the build config contains `plugins.updater`. `app_info.updatesEnabled` tells the UI.
  - `update_stop_recording` and `update_restart` close the open activity interval and stop screenshots before the installer takes over. On Windows the installer exits the process; on macOS `app.restart()` relaunches through LaunchServices.
  - The macOS single-instance lock now waits up to 5 s for a copy that is still exiting. Without this, the relaunched version could quit when it lost the race for the lock.
- `src-tauri/capabilities/default.json` grants `updater:default`: check, download and install. Nothing else is added.
- `src/update-policy.ts` holds the pure rules (postponement, mandatory handling, wording of error reasons) and is unit tested. `src/updates-ui.ts` holds the UI and flow.
- Release config: `scripts/desktop-config.mjs` adds the updater only when `WORKFOLIO_UPDATER_PUBKEY` is set, and then requires `TAURI_SIGNING_PRIVATE_KEY`. With both set, it writes `bundle.createUpdaterArtifacts: true`, `plugins.updater.{pubkey, endpoints, requireSignedVersion: true, windows.installMode: "passive"}`. The committed `tauri.conf.json` has no updater, so dev builds and CI test installers never check for updates.

### Platforms

| Target | Package the updater installs | Notes |
| --- | --- | --- |
| `windows-x86_64` | NSIS `…_x64-setup.exe` (signed with the updater key; Authenticode-signed when a certificate or Azure Trusted Signing is configured) | Installed in *passive* mode for the current user, the same mode as the existing installer. The app restarts afterwards. App data and Credential Manager entries are not touched by an upgrade install. |
| `darwin-aarch64` | `.app.tar.gz` | The default macOS build (`macos-latest` is Apple Silicon). |
| `darwin-x86_64` | `.app.tar.gz` of a universal build (`--target universal-apple-darwin`) | Intel is served only if a release includes it. 0.1.0 shipped as a universal DMG, so the CI workflow offers `macos_universal`. Reference the same universal package for both darwin targets. |

## Limits and known gaps

- **The first auto-updating version has to be installed by hand.** 0.2.0, already on employee machines, has no updater. Every version from the first updater build onwards can update itself.
- The version is still `0.2.0` in the repository. The release guide covers bumping it; this work doesn't choose the next version.
- macOS: Keychain items are bound to the app's code signature. Updates between builds signed with the **same Developer ID** keep silent access. An unsigned or ad-hoc build that updates to a differently signed one triggers a Keychain prompt. The item and the installation ID are kept either way, but the employee is asked.
- The package URL check refuses IP-literal and localhost hosts in production. It does not resolve DNS names, so this isn't SSRF-proof. Only administrators can enter URLs.
- Windows: not run on a physical machine yet (`docs/qa/AUTO-UPDATE-WINDOWS-QA.md`).
