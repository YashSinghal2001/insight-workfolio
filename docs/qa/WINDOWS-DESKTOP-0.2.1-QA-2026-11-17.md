# Windows desktop 0.2.1 — QA (2026-11-17)

> Public repository: no employee names, emails, tokens, screenshots or device names appear here.

## Verdict

**NOT PRODUCTION-READY — physical Windows QA not run.** Mac-side checks and the Windows CI build pass; the
on-PC tests are pending.

## Build record

| Item | Value |
|---|---|
| Base | `deploy/hostinger-vps` / `main` at `3a28114f3782f72bcfc2efcead60a737906dc348` |
| Build commit | `3a315bb` on branch `release/desktop-0.2.1` (= `3a28114` + version bump + these docs) |
| Builder | GitHub Actions run 44042098660: `CI` → `windows-desktop` job on `windows-latest`, `workflow_dispatch` with `desktop_api_url=https://189.72.144.117`, `desktop_dashboard_url=https://189.72.144.117` |
| Artifact | `insight-workfolio-windows-nsis-UNSIGNED` → `Insight Workfolio_0.2.1_x64-setup.exe`, 3,519,222 bytes (expires 2026-11-24) |
| Installer SHA-256 | `241663ad540d02ce5da03efa658263540de80e2bc6ff5fd5c7cde6ee6febc273` (CI log and Mac download match) |
| Signing | None (no Windows certificate configured) |
| Updater | Off (no `WORKFOLIO_UPDATER_PUBKEY`) |

## Automated checks

| Check | Where | Result |
|---|---|---|
| Version 0.2.1 in package.json, Cargo.toml, tauri.conf.json, Cargo.lock | Mac | PASS (`cargo update -p insight-workfolio-desktop`: only this crate changed) |
| Desktop TypeScript tests | Mac | PASS 92/92 |
| Rust tests | Mac | PASS 104, 1 ignored |
| Clippy `--all-targets -D warnings` | Mac | PASS |
| Packager production config (`desktop-config.mjs --print`) | Mac | PASS: API and CSP `https://189.72.144.117`, identity `com.insightworkfolio.desktop` |
| Packager refuses `http://localhost:4000` and `http://189.72.144.117` | Mac | PASS |
| Rust tests incl. Windows native smoke tests, clippy, TS tests | Windows CI | PASS: Rust 108, 1 ignored; clippy clean; TS 92/92 |
| Packaged exe names the production origin, not `localhost:4000` or `example.invalid` | Windows CI | PASS (`packaged API origin: https://189.72.144.117`) |
| Installer SHA-256 matches after download | Mac | PASS |

## Code verification (read on the Mac; runtime on Windows still required)

| Area | Finding |
|---|---|
| Idle source | `win/activity.rs`: `GetLastInputInfo` + `GetTickCount` with 49.7-day wrap handling; unit-tested |
| Foreground app | Executable file name and version-resource description only; UWP hosts resolved; no titles |
| Lock / other session | Input desktop name (`Default` = unlocked), WTS console/connected state |
| Collector lifecycle | Native thread (`collector.rs`), 15 s samples, interval checkpointing and crash recovery |
| Live state | `live-state.ts`: reported on change and every 60 s while monitoring is ACTIVE; locked = IDLE; asleep/other user = UNOBSERVED; server marks UNKNOWN after 3 min |
| Tray | Tray timer ticks in a native thread; tray menu is Open/Exit only |
| Background | `backgroundThrottling: "disabled"` is a no-op on Windows (wry docs). Uploads/live reports are webview timers → test H below |
| Breaks | Manual Start/End, recorded with device time and server skew correction; no automatic timer |
| Screenshot capture | GDI `BitBlt` of the primary monitor; process is per-monitor DPI aware (tao), so full-resolution pixels |
| Idle / break suppression | Due captures skipped while input-idle (`screenshot.rs`); worker paused before a break/clock-out time is taken (`main.ts` halt/release) |
| Queue / upload | WebP in local queue; register → upload → `STORED` only after storage confirmed; local bytes kept until then; 410 → kept as rejected; other errors retried with backoff; same ID on retry (no duplicates) |
| Upgrade | Same identity, Credential Manager service, install mode (`currentUser`) and queue schema as installed builds |

## Physical Windows QA (all PENDING)

Machine: Dell Latitude 5410, Windows 10 Pro 22H2. QA account only; screenshot tests only with synthetic screen
content and only after HR/legal approval. Run `wf-windows-diag.ps1` during A–H and attach `summary.txt`.

| # | Test | Expected | Result |
|---|---|---|---|
| A1 | Install 0.2.1 over the existing app | No uninstall needed; same sign-in; same device ID in Dashboard → Devices | PENDING |
| A2 | Exe version / diag markers | 0.2.1; markers 4d66269, 03421f8, 6940607 true | PENDING |
| B1 | Keyboard, then mouse | Dashboard ACTIVE within ~1 min | PENDING |
| B2 | No input 6 min | IDLE, *since* = last input | PENDING |
| B3 | Resume | ACTIVE | PENDING |
| B4 | Switch Notepad ↔ Calculator | Both apps in the activity timeline | PENDING |
| B5 | Lock (Win+L) / unlock | IDLE while locked, then ACTIVE | PENDING |
| B6 | Sleep / wake | Nothing recorded while asleep; resumes after wake | PENDING |
| C1 | Start break, wait 2 min, end break | ON_BREAK on dashboard; break duration correct; monitoring paused | PENDING |
| C2 | Quit and reopen during a break | Still on break, timer continues from the recorded start | PENDING |
| D1 | Screenshot during activity (QA tenant only) | WebP stored, server STORED, local copy removed | PENDING |
| D2 | Idle ≥ threshold | "Not taken: no keyboard or mouse input" | PENDING |
| D3 | Network off → capture → network on | Kept locally, uploaded once on reconnect | PENDING |
| E1 | Sign out / sign in | Same installation ID; no re-registration | PENDING |
| H1 | Close to tray 15 min while active | Dashboard stays ACTIVE/IDLE (not UNKNOWN); *last received* advances | PENDING |

H1 decides whether a hidden-window workaround is needed (release notes, limitation 2).

## Known limitations

See `docs/releases/DESKTOP-0.2.1-RELEASE-NOTES-2026-11-17.md`.
