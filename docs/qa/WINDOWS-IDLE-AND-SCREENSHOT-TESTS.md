# Windows: idle detection and screenshots

Statuses used: PASS, FAIL, PARTIAL, BLOCKED, NOT IMPLEMENTED, NOT RUN. A build or compile result is never counted as a runtime PASS. Date of the runs: 2026-11-12, host macOS (Apple Silicon). No Windows machine was available. Nothing was committed, pushed, merged or deployed.

**No test in this file was executed on Windows.** The Windows code was compiled for `x86_64-pc-windows-gnu` (260 crates, exit 0) and its platform-independent logic was unit-tested on macOS. A compile result is not a runtime result: every runtime row is BLOCKED.

## Features

| Feature | Implementation | Files changed | Tests executed | Actual result | Remaining limitations | Physical runtime test passed? | Production activation |
|---|---|---|---|---|---|---|---|
| Idle from `GetLastInputInfo` | PARTIAL | `src-tauri/src/activity.rs` (the Windows call in `win/activity.rs` is unchanged) | Tracker unit tests, run on macOS | PASS for the logic | Held-key auto-repeat refreshing the counter is unconfirmed (about 85% confidence). Injected input counts as activity (no hook, by decision) | No: BLOCKED | Pending |
| Locked screen / secure desktop = IDLE; sleep and other session unobserved | PARTIAL | `activity.rs`, `collector.rs`, `session_events.rs`, `win/session.rs` | Rust tests incl. QA `mod qa` (6 tests, one a fuzz) | PASS for the logic | Lock and session notifications never observed on a PC | No: BLOCKED | Pending |
| Live state report (ACTIVE / IDLE / UNOBSERVED) | PARTIAL | `src/live-state.ts`, `src/activity-ui.ts` | `live-state.test.ts`, API tests | PASS | Not run inside the Windows webview | No: BLOCKED | Pending |
| Idle threshold always visible | PARTIAL | `index.html`, `src/activity-ui.ts` | code read only | not executed | UI not launched | No: BLOCKED | Pending |
| Screen capture (BitBlt), masks, blur, WebP | PARTIAL | `screenshot.rs` (`win/capture.rs` unchanged) | Rust tests with a fake OS | PASS for scheduling, gating, storage cap | Real capture never run on Windows | No: BLOCKED | Pending |
| No capture while locked, asleep or with another session in front | PARTIAL | `screenshot.rs` (`session_capturable`) | Rust tests with a fake OS | PASS | The Windows level checks were never observed | No: BLOCKED | Pending |
| No capture with the display off | PARTIAL | `win/session.rs`, `screenshot.rs:1002` | unit test of the event mapping | PASS for the mapping | State unknown until the first power notification after start; a failed registration is only logged | No: BLOCKED | Pending |
| Capture failures reported and retried | PARTIAL | `screenshot.rs`, `src/monitoring.ts` | Rust and TypeScript tests | PASS | none known | No: BLOCKED | Pending |
| Privacy: no hooks, key state, window titles, clipboard | PASS (source check) | none | `test/privacy-apis.test.ts` | PASS | A static check of the sources, not an observation of a running app | No: BLOCKED | Pending |

## Runtime checklist (for the person with a Windows PC)

The full list is in `docs/windows.md`, "Verification checklist (on a Windows machine)". Status of every row today:

| Check | Status |
|---|---|
| Install the new build; sign in; device registers | BLOCKED |
| Clock in; no input for the threshold; dashboard shows Idle with the right start | BLOCKED |
| Mouse move, click, wheel and key press each end idle | BLOCKED |
| Hold a key for longer than the threshold: stays Active | BLOCKED |
| Lock (Win+L) before the threshold: Idle from the lock; unlock: Active from the unlock | BLOCKED |
| UAC prompt / Ctrl+Alt+Del: Idle, no capture | BLOCKED |
| Sleep and wake: a gap, no idle or active time across it | BLOCKED |
| Fast user switch / RDP disconnect: nothing recorded | BLOCKED |
| Display off, not locked: no screenshot | BLOCKED |
| Screenshots on and notice acknowledged: capture at the interval, masks and blur applied, upload stored | BLOCKED |
| Notice not acknowledged / policy off / break / clocked out: no capture | BLOCKED |
| A capture failure shows "Capture failed" and recovers | BLOCKED |
| Dashboard shows Unknown within 3 minutes of quitting the app | BLOCKED |
| Refresh token present in Credential Manager and nowhere on disk | BLOCKED |
| Installer, tray, single instance, start at sign-in | BLOCKED |
