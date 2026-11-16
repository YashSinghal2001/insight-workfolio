# Desktop client cross-platform readiness audit

Date: 2026-11-11. Scope: `apps/desktop` (Tauri 2, Rust + TypeScript) against the live production API at
`https://189.72.144.117`. Read-only: no code, configuration or production setting was changed, nothing was built,
no account or activity was created. Screenshots, timelapses and website tracking stay off.

Classification used: **Implemented and tested** / **Implemented but not tested** / **Partially implemented** /
**Missing** / **Blocked**. "Tested" always names where; a platform is never called working without a run on that
platform.

## 1. Findings

| # | Question | macOS | Windows | Evidence |
|---|---|---|---|---|
| 1 | Buildable and installable (macOS) | Build: implemented and tested. Production-URL install: implemented but not tested | n/a | Release `.app` and `Insight Workfolio_0.1.0_aarch64.dmg` built on this Mac on 2026-11-02; CI job "Desktop Rust" green on 2026-11-03. No build for `https://189.72.144.117` exists yet |
| 2 | Buildable and installable (Windows) | n/a | Build: implemented and tested in CI. Install on a real PC: implemented but not tested | CI run 41673001562 (2026-11-03, `windows-latest`, MSVC): clippy, `cargo test` including the native smoke tests, and an unsigned NSIS installer all succeeded. That installer used a placeholder API and its artifact has expired. Never installed on a Windows PC |
| 3 | Tauri configuration for both platforms | Implemented and tested (build) | Implemented and tested (build) | `tauri.conf.json`: targets `all`, macOS minimum 14.0 with hardened runtime, Windows NSIS per-user install with the WebView2 bootstrapper; icons for both. Both unsigned |
| 4 | Rust targets and platform dependencies | Implemented and tested | Implemented and tested (CI) | `Cargo.toml`: `objc2*` crates under `cfg(target_os = "macos")`, `windows-sys` and the single-instance plugin under `cfg(windows)`, `keyring` with both native stores, bundled SQLite. This Mac: Rust 1.98.1 with `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-pc-windows-gnu` (cross-check only; a real Windows build needs MSVC on Windows) |
| 5 | Production API: desktop authentication and employee registration | Implemented but not tested against production | same | `POST /auth/login` with `client: "desktop"` returns bearer and refresh tokens (refresh token in the OS credential store). Live preflight on production: `tauri://localhost` and `http://tauri.localhost` are allowed, another origin is not. Employees do not self-register: an administrator creates them in the dashboard and hands over a one-time setup link (72 h). Production has one user (the admin) and no employee profile |
| 6 | Device registration and association | Implemented and tested (local API) | Implemented but not tested (Credential Manager never exercised) | `POST /devices/register`: random installation ID kept in the credential store, only its SHA-256 on the server, idempotent per installation, revocable. **One active device per employee**: a second device is refused until an administrator revokes the first |
| 7 | Activity collection, idle, lock/unlock, sync | Implemented and tested natively (`verify:native` 8/8 on 2026-10-19: app switching, idle, resume, lock, sleep/wake, break, clock-out), on a debug build against a local API | Implemented but not tested on a PC (CI smoke tests on Windows Server only) | macOS: `activity.rs`, `session_events.rs`. Windows: `win/activity.rs`, `win/session.rs` (docs/windows.md lists every runtime check as NOT RUN) |
| 8 | Offline queue and retry | Implemented and tested (Rust queue tests, TypeScript sync tests, native run) | Implemented but not tested at runtime (same code, same bundled SQLite) | `queue.rs` (durable SQLite, owner-only files), `sync.ts` (FIFO drain, exponential backoff; 401/403 blocks without retry). Offline events older than 7 days are rejected by the server |
| 9 | Screenshots implemented but safely disabled | Partially implemented: capture verified natively, one sleep retest outstanding; **off** | Implemented but not tested on a PC; **off** | Off by default in code (`DEFAULT_SCREENSHOT_SETTINGS.enabled = false`); production has 0 screenshot policy rows; the desktop takes none while the policy is off and the API rejects registrations made while it is off |
| 10 | Secure connection to the production VPS | Implemented but not tested | Implemented but not tested | Release builds are https only and must go through `pnpm package`, which pins the CSP `connect-src` to the API origin. Dry run for `https://189.72.144.117` succeeds. Certificate valid (Let's Encrypt, IP address, 6-day). No desktop build has contacted production yet |

Not in the ten questions but relevant:

| Item | Status |
|---|---|
| Code signing and notarization (Apple Developer ID, Windows Authenticode) | **Blocked**: no certificates. Test builds are unsigned: Gatekeeper and SmartScreen warn |
| Auto-update | **Missing** (not decided) |
| Windows on ARM64 | **Missing** (x64 only) |
| Final wording of the monitoring notice | **Blocked** on HR/Legal; the app shows the current draft and asks for acknowledgement |
| Several desktop tabs "not run in the packaged Tauri window" (self-view, leave) | Implemented but not tested in a packaged app |

Desktop code is identical on `main` and `deploy/hostinger-vps`, and unchanged since the green CI run.

## 2. What device testing will and will not touch

- Activity monitoring (foreground application name and idle time while clocked in) is **on by default** once the
  employee acknowledges the notice. That is the feature under test. It is real data of a real test session, stored
  in the production database; there is no staging server.
- Screenshots, timelapses and website tracking are not enabled by any step below.
- Each test device needs its own test employee (one active device per employee).

## A. macOS (Apple Silicon, M2): install and test

Prerequisites on the build Mac (all present on this Mac): macOS 14 or later, Xcode Command Line Tools, Rust stable,
Node 24.7 or later, pnpm 11.9.

1. Build (section C). Result: `apps/desktop/src-tauri/target/release/bundle/dmg/Insight Workfolio_0.1.0_aarch64.dmg`.
2. Open the DMG and drag **Insight Workfolio** to Applications.
3. First launch. On the Mac that built it, it opens normally. On another Mac the unsigned app is blocked: open
   System Settings › Privacy & Security, scroll to the message about Insight Workfolio and choose **Open Anyway**.
4. Sign in with the test employee. macOS may ask to allow keychain access: choose **Always Allow**.
5. Acknowledge the monitoring notice, then run the checklist in section D.
6. Do not grant Screen Recording; nothing asks for it while screenshots are off.

Known limits of an unsigned build: *Open at login* may fail to register; each rebuild can re-trigger the keychain
prompt.

## B. Windows: install and test

Target: Windows 10 (21H2 or later) or Windows 11, **x64**.

Two ways to get an installer:

- **Option 1, GitHub Actions (recommended).** The existing Windows CI job already builds the NSIS installer. It
  needs a small workflow change so the production URL can be passed in, then the installer is downloaded as a
  private artifact. Nothing to install on the laptop except the app itself.
- **Option 2, build on the laptop.** No repository change, but about 8 GB of tools: Git, Node 24.7+, pnpm 11.9.0,
  Rust stable (`x86_64-pc-windows-msvc`), Visual Studio Build Tools 2022 with "Desktop development with C++"
  (MSVC and the Windows SDK), and GitHub access to the private repository.

Install and test:

1. Run `Insight Workfolio_0.1.0_x64-setup.exe` as a normal user. SmartScreen shows "Windows protected your PC":
   **More info › Run anyway** (the build is unsigned). No administrator prompt is expected.
2. If WebView2 is missing (rare on Windows 11), the installer downloads it; the laptop needs internet.
3. Start the app from the Start menu. The tray icon may sit in the overflow area (^).
4. Sign in with the second test employee, acknowledge the notice, run section D.

## C. Build commands and packaging

Same command on both platforms, run from the repository root on a machine of that platform:

```bash
pnpm install --frozen-lockfile
pnpm build:packages
WORKFOLIO_API_URL=https://189.72.144.117 WORKFOLIO_DASHBOARD_URL=https://189.72.144.117 \
  pnpm --filter @workfolio/desktop package -- --bundles app,dmg     # macOS
```

```powershell
$env:WORKFOLIO_API_URL="https://189.72.144.117"; $env:WORKFOLIO_DASHBOARD_URL="https://189.72.144.117"
pnpm --filter @workfolio/desktop package -- --bundles nsis          # Windows
```

Dry run without building (prints the configuration override):

```bash
WORKFOLIO_API_URL=https://189.72.144.117 WORKFOLIO_DASHBOARD_URL=https://189.72.144.117 \
  node apps/desktop/scripts/desktop-config.mjs --print
```

Outputs: macOS `apps/desktop/src-tauri/target/release/bundle/{macos,dmg}/`; Windows
`apps\desktop\src-tauri\target\release\bundle\nsis\`. Both unsigned and for testing only. Before building, the
usual checks: `pnpm --filter @workfolio/desktop test` (TypeScript and `cargo test`).

## D. Real-device checklist

Run on each platform with that platform's test employee. Record PASS, FAIL or NOT RUN per row.

| # | Step | Expected result |
|---|---|---|
| 1 | Install and first launch | App opens; sign-in screen shows no configuration error |
| 2 | Sign in | Accepted; name and employee code shown. Wrong password is refused |
| 3 | Credential storage | macOS: Keychain item for `com.insightworkfolio.desktop`. Windows: Credential Manager › Windows Credentials entries with that name |
| 4 | Device registration | Dashboard › Employees › the test employee › Devices lists this device with the right platform |
| 5 | Quit and reopen | Still signed in, no password asked |
| 6 | Monitoring notice | Notice shown; nothing is recorded before it is acknowledged |
| 7 | Clock in | State "Working"; dashboard attendance shows the session within a minute |
| 8 | Application activity | Use two or three applications for a few minutes each: they appear by name in the employee's activity. Windows: identifiers are file names such as `chrome.exe`, never full paths |
| 9 | Idle | Leave the machine untouched for more than 5 minutes: that time is recorded as idle, not active |
| 10 | Lock and unlock | macOS Ctrl+Cmd+Q, Windows Win+L, wait 1 minute, unlock: no active time during the lock |
| 11 | Sleep and wake | Sleep for 2 minutes: nothing recorded while asleep; recording resumes after wake |
| 12 | Break | Start and end a break: break shown in the dashboard; no activity attributed during it |
| 13 | Offline queue | Turn Wi-Fi off, clock out and in again, wait 2 minutes, turn Wi-Fi on: the app shows offline, then syncs; all events appear with their original times and nothing is rejected |
| 14 | Kill and recover | Force-quit while clocked in, reopen: session restored with a recovery notice, no duplicate events |
| 15 | Clock out | State "Clocked out"; everything uploaded (no pending items) |
| 16 | Screenshots stay off | The app says screenshots are off; no permission prompt; dashboard shows no screenshots; server count stays 0 |
| 17 | Second device refused | Sign the same employee in on the other machine: registration is refused with "Another device is already registered" |
| 18 | Revoke | Administrator revokes the device in the dashboard: the app stops syncing and says so |
| 19 | Shell | Tray or menu-bar icon and timer; closing the window keeps the app running; second launch focuses the first; Windows: exit only from the tray menu |
| 20 | Uninstall | App removed; decide whether to keep or delete local data |

Server-side cross-checks after each platform (read-only): activity and attendance rows for the test employee only,
`screenshots` 0, `timelapses` 0, `website_policies` 0, no error-level lines in the API log.

## E. Backend or API changes required before device testing

**No code or configuration change is required.**

- CORS already allows both desktop origins (verified live on production).
- The release configuration accepts the production URL (dry run).
- Data prerequisites, done in the dashboard by the administrator: two test employees (one per device), each with
  its own setup link. Use clearly labelled names such as "TEST macOS" and "TEST Windows".
- Optional, only for Windows Option 1: a workflow change so CI can build the installer for the production URL.

## Risks to keep in mind

1. Windows has never run on a real PC; expect findings.
2. No release build has ever talked to the production API; the first sign-in is the real test of items 5 and 10.
3. The server certificate is valid for six days at a time; a device with a wrong clock will refuse it.
4. Test activity is stored in the production database and cannot simply be deleted (activity retention is not
   approved, the audit trail is append-only). Deactivate the test employees afterwards.
5. Unsigned builds: Gatekeeper and SmartScreen warnings; company antivirus may block the installer.
