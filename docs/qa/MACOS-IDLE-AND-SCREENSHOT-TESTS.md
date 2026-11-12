# macOS: idle detection and screenshots

Statuses used: PASS, FAIL, PARTIAL, BLOCKED, NOT IMPLEMENTED, NOT RUN. A build or compile result is never counted as a runtime PASS. Date of the runs: 2026-11-12, host macOS (Apple Silicon). No Windows machine was available. Nothing was committed, pushed, merged or deployed.

The Rust and TypeScript suites ran on this Mac. The desktop app was not launched, no permission prompt was triggered and the screen was not captured: every row that needs a person at a Mac is NOT RUN.

## Features

| Feature | Implementation | Files changed | Tests executed | Actual result | Remaining limitations | Physical runtime test passed? | Production activation |
|---|---|---|---|---|---|---|---|
| Idle from `CGEventSourceSecondsSinceLastEventType` (HID system state) | PARTIAL | `src-tauri/src/activity.rs` | Rust unit tests | PASS for the logic | Remote-desktop input is not hardware input: such users show as idle (awaiting the owner) | No: NOT RUN | Pending |
| Locked screen = IDLE; sleep / other session unobserved; 15-minute idle split | PARTIAL | `activity.rs`, `collector.rs`, `session_events.rs` | 103 Rust tests incl. QA `mod qa` (6, one a 3,000-round fuzz) | PASS | Real lock, sleep, wake and fast user switching were not exercised | No: NOT RUN | Pending |
| Tracker cannot panic on a backwards timestamp; ACTIVE never before the first unlocked sample | PASS (unit) | `activity.rs:181,204,206` | `mod qa` tests | PASS | Release builds use `panic = "abort"` (`Cargo.toml:42`): the poisoned-lock recovery in `collector.rs:125-134` only matters in debug builds | Not applicable (unit level) | Pending |
| Live state report with keepalive and backoff | PARTIAL | `src/live-state.ts`, `src/activity-ui.ts` | desktop TypeScript tests (81 in total) | PASS | Not run in the app | No: NOT RUN | Pending |
| Screenshot capture (ScreenCaptureKit), masks, blur | PARTIAL | `screenshot.rs` | Rust tests with a fake OS; the real-capture benchmark is ignored | PASS for scheduling, gating, storage cap, redaction order | Real capture and the Screen Recording prompt were not exercised | No: NOT RUN | Pending |
| No capture while locked, asleep, with another session in front, or with the display asleep | PARTIAL | `screenshot.rs` (`session_capturable`, `CGDisplayIsAsleep`) | Rust tests with a fake OS | PASS | The OS level checks were not observed | No: NOT RUN | Pending |
| Awaiting-consent mode; a cached policy older than 24 h pauses capture | PARTIAL | `src/monitoring.ts`, `src/screenshot-sync.ts`, `src/screenshot-ui.ts` | `monitoring.test.ts`, `screenshots.test.ts` | PASS | Enforced in the webview only; setting the clock back defeats the 24 h rule | No: NOT RUN | Pending |
| Capture failures reported (`CAPTURE_FAILED`) and retried at the next interval | PARTIAL | `screenshot.rs`, `src/monitoring.ts` | Rust and TypeScript tests | PASS | none known | No: NOT RUN | Pending |
| Refresh token in the Keychain only | PARTIAL | `src-tauri/src/lib.rs` (unchanged) | code read only | not executed | Not observed at runtime | No: NOT RUN | Pending |
| Privacy: no event taps, key state, window titles, clipboard | PASS (source check) | none | `test/privacy-apis.test.ts` (6) | PASS | A static check of the sources | Not applicable (source check) | Pending |

## Runtime checklist (for the person at a Mac)

| Check | Status |
|---|---|
| Install the new build; sign in; Keychain prompt; device registers | NOT RUN |
| Clock in; no input for the threshold; dashboard shows Idle with the right start | NOT RUN |
| Mouse, trackpad and keyboard each end idle | NOT RUN |
| Lock (Ctrl+Cmd+Q) before the threshold: Idle from the lock; Touch ID unlock without typing: Active from the unlock, not before | NOT RUN |
| Lid closed / sleep, then wake: a gap, no idle or active time across it | NOT RUN |
| Fast user switching: nothing recorded while the other user is in front | NOT RUN |
| Display sleep without lock: no screenshot | NOT RUN |
| Screen Recording permission denied: "Permission denied" on the dashboard, no capture | NOT RUN |
| Permission granted and notice acknowledged: capture at the interval, masks and blur applied, upload stored | NOT RUN |
| Policy off / notice not acknowledged / break / clocked out: no capture | NOT RUN |
| Offline for more than 24 hours: capture pauses | NOT RUN |
| Quit the app: dashboard shows Unknown within 3 minutes | NOT RUN |
| A remote-desktop session into the Mac: is the user shown idle? (input for the owner's decision) | NOT RUN |
