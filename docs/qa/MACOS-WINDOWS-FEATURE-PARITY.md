# macOS vs Windows desktop feature parity (master report)

Date 2026-11-13. Code: `deploy/hostinger-vps` at `4d66269` (desktop tree identical to GitHub; the uncommitted
invitation-email work touches no desktop file). Audit only: no code was changed.

Inputs: `MACOS-FEATURE-INVENTORY.md` (reference, 111 features), `WINDOWS-FEATURE-INVENTORY.md` (110 Windows
items), the shared-layer audit, local test runs on this Mac, and **CI run
[43388023773](https://github.com/YashSinghal2001/insight-workfolio/actions/runs/43388023773)** dispatched for this
audit on `4d66269` (the first Windows CI run after the 2026-11-12 desktop changes; it supersedes the "CI evidence is
stale" rows O06/D10 in the Windows inventory). Remediation: `FEATURE-PARITY-REMEDIATION-PLAN.md`.

## 1. Answer in one paragraph

Windows has an equivalent implementation for every macOS feature that should exist there. **None of it has run on
a physical Windows PC**, so no Windows feature is runtime-verified and the Windows app is **not** parity-ready. The
logic shared by both platforms passes its tests on Windows CI, and the Windows-native smoke tests pass on CI.
**The Windows CI job is currently red**: three privacy-guard tests fail there because of CRLF line endings and
backslash paths (test portability, not a privacy problem). As a result the Windows installer was not built for the
current commit. Twelve features are only partially equivalent; the most important are injected input counting as
activity, credentials that roam with domain profiles, no file-permission hardening, logs that are lost in release
builds, and webview timers that are not protected while the window is hidden to the tray.

## 2. Status rules

| Status | Used when |
|---|---|
| PASS | Windows equivalent exists and the behaviour is fully checkable by automated tests that **ran and passed for Windows** (Windows CI, or server-side API tests that are platform-independent). Pure logic only: nothing here needs a real desktop |
| PARTIAL | Windows equivalent exists but is incomplete or behaves materially differently from macOS |
| FAIL | A test covering the feature failed |
| MISSING | No Windows equivalent where one is needed |
| BLOCKED | Equivalent implemented and its automated tests pass, but the feature needs a real Windows desktop (input, lock, sleep, tray, WebView2 UI, Credential Manager in a user session, installer) and none is available |
| NOT TESTED | Equivalent implemented; no relevant test ran, although one could run on Windows CI |
| N/A | macOS-only by nature; Windows has no such concept (the Windows analogue is named) |

Hosts: **M** = this Mac (2026-11-13), **CW** = Windows CI `windows-latest` (Windows Server, service session, no
user input; run 43388023773), **CM** = CI macOS, **U** = CI Ubuntu. CI is never counted as runtime verification.

## 3. Summary counts

| Measure | Count |
|---|---|
| macOS features identified (reference) | **111** |
| macOS-only by nature (N/A) | **6** (L2, S3, S4, S5, O1, O4) |
| Features that need a Windows equivalent | **105** (111 minus L2, S3, S4, S5, O1, O4) |
| Windows equivalent implemented | **104 of 105** (missing: O2, the native runtime harness) |
| PASS | **40** |
| PARTIAL | **12** |
| FAIL | **1** (X7, privacy guard on Windows CI) |
| MISSING | **1** (O2) |
| BLOCKED (needs a physical PC) | **45** |
| NOT TESTED (testable on Windows CI, not tested) | **6** |
| Windows features verified on real hardware | **0** |
| Windows features exercised only by CI native smoke tests | **7** (A1, A6, A8, A11, S1, L17, A9 notification thread): Win32 calls executed on Windows Server without user input; range and leak checks only |
| macOS features with earlier real-Mac evidence whose code is unchanged | **41** (2026-10-19 to 2026-11-02); **0** re-run after `4d66269`; **21** changed or new since the last native run |

Note: N/A counts features with no Windows concept at all (6). L7 (Dock reopen), L16 (Dock icon) and U5 (menu-bar
title) do have Windows analogues (second-launch focus, taskbar button, tray tooltip) and are rated on those.
Row totals: 40 + 12 + 1 + 1 + 45 + 6 = 105.

## 4. Critical differences (ranked)

| # | Difference | Impact | Evidence |
|---|---|---|---|
| 1 | **Windows CI red: privacy guard fails on Windows** (3 tests), so the NSIS installer step was skipped; no installer exists for the current commit | Every future Windows build is blocked until fixed; the guard that proves "no keylogger" is not effective on Windows | CW run 43388023773: `✖ Rust sources: no hook…` (comment text read as code: `split("\n")` leaves `\r`, so `.*$` comment stripping fails), `✖ TypeScript sources…` (`src\records.ts` vs `src/records.ts`), `✖ the input-related OS calls…` (`CGEventPost`, `CGSession` in comments). `apps/desktop/test/privacy-apis.test.ts:24,35`; repo has no `.gitattributes`. Passes on M and U. Manual reading: no forbidden API on either OS |
| 2 | **Injected input counts as activity on Windows** (`GetLastInputInfo`); macOS counts hardware input only (HID system state) | A software mouse jiggler keeps a Windows employee ACTIVE | `win/activity.rs:207-215`, `activity.rs:369`; `docs/windows.md:67-128` (hooks await owner decision) |
| 3 | **Credentials roam on Windows**: keyring writes refresh token and installation ID with `CRED_PERSIST_ENTERPRISE` | With domain roaming profiles, two PCs share one device identity and one refresh token; rotation on one signs the other out (reuse detection) | `keyring-3.6.3/src/windows.rs:246,555` (verified); `lib.rs:47-76,240-260` |
| 4 | **Webview timers unprotected while hidden** to the tray: `backgroundThrottling` is unsupported on Windows; EcoQoS opt-out covers only the main process, not `msedgewebview2.exe` | Live state (60 s keepalive vs 180 s staleness), uploads and policy refresh could stall; dashboard would show UNKNOWN | `tauri-utils-2.10.2/src/config.rs:2248`; `power.rs:78-87`; `activity-ui.ts:379-384`. Impact unproven (medium-low confidence) |
| 5 | **No owner-only file permissions on Windows**: all `0600/0700` code is `#[cfg(unix)]` | Queue DB, screenshots spool and prefs rely on the default `%LOCALAPPDATA%` profile ACL | `queue.rs:33-43`, `lib.rs:457-461,488-492`, `screenshot.rs:623,632`, `prefs.rs:38-43` |
| 6 | **Logs are lost in release builds** (`windows_subsystem = "windows"`, `eprintln!` only, no log file); `docs/windows.md:338` tells testers to read `[session] Locked` "in the log" | Physical-PC testing cannot observe lock/sleep/display events as documented; field failures leave no trace. (macOS release builds also persist no log file) | `main.rs:2`; 26 `eprintln!` in `src-tauri/src` (verified) |
| 7 | **Display-off detection is notification-only on Windows** (no level query; failed registration only logged) | A missed notification means capture continues on a dark screen | `win/session.rs:157-163`, `screenshot.rs:1002-1004` |
| 8 | **Shutdown/sign-out not handled explicitly** (no `WM_QUERYENDSESSION`/`WM_ENDSESSION`) | Possibly a "recovered from unclean shutdown" notice after every Windows restart; open interval closed by recovery, not cleanly | `lib.rs:558-577`; grep finds no ENDSESSION (verified) |
| 9 | **Server takes the activity `source` from the client** (`req.platform`), and the client defaults to `"macos"` if `app_info` fails | Windows intervals could be stored as `DESKTOP_MACOS` | `apps/api/src/activity/activity.service.ts:194`, `apps/desktop/src/main.ts:116` (verified) |
| 10 | **Secure desktop counts as locked** on Windows (UAC prompt, Ctrl+Alt+Del, screen saver) | Seconds of UAC time recorded IDLE; by design, differs from macOS | `win/activity.rs:62-71` |
| 11 | **Permission states**: Windows has no screen-capture permission, so `PERMISSION_DENIED` never occurs | Correct, but HR/Legal should confirm the Windows disclosure wording | `screenshot.rs` platform `permission() == true`; `platform.ts` |

Also affecting both platforms (found during this audit, from the 2026-11-12 lock-as-idle change):
`apps/desktop/scripts/verify-native.mjs:158-169` still expects nothing recorded while locked, so it will FAIL on a
correct build; `apps/desktop/src/activity-ui.ts:323` gap notice still says "asleep or locked"; `collector.rs:154-156`
status flags ignore the 5 s lock grace (UI could say "Screen locked" while the tracker records ACTIVE).

## 5. Parity matrix

Columns: Feature (macOS ID) | macOS implementation | Windows implementation (Windows inventory ID) | Code parity |
Test coverage (hosts) | Runtime verification | Final Windows status. Paths: Rust `src-tauri/src/`, TS `src/` under
`apps/desktop`. "Same" = identical shared code.

### L. Lifecycle

| Feature | macOS | Windows | Code parity | Tests | Runtime | Status |
|---|---|---|---|---|---|---|
| L1 Bundle and installer | `.app`/`.dmg`, `tauri.conf.json` | NSIS per-user + WebView2 bootstrapper (L01, L02, L04); `targets: all` also builds an MSI (O03) | Equivalent | `desktop-config.test.ts` M U CW; NSIS build **skipped** in CW run (prior step failed); last NSIS build 2026-11-03 at an older commit | Never installed on a PC | NOT TESTED |
| L2 macOS 14 minimum, hardened runtime | `bundle.macOS` | — | N/A | — | — | N/A |
| L3 Code signing / notarization | optional in `desktop-config.mjs` | optional signtool/Azure plan (L05) | Equivalent | `desktop-config.test.ts` M U CW | No certificates on either OS | BLOCKED |
| L4 Release packaging (https, CSP pin) | `desktop-config.mjs` | same script; CW grep of packaged exe (N03) | Same | M U CW pass; packaged-exe grep skipped in CW run | — | PASS |
| L5 Startup, data dir | `~/Library/Application Support` 0700 | `%LOCALAPPDATA%\<id>`, no ACL (X02) | Partial (no hardening) | `history.test.ts` M U CW | none | PARTIAL |
| L6 Single instance | `flock` | `tauri-plugin-single-instance` mutex (L13) | Equivalent (session-local) | unix flock test M CM only; Windows none | none | BLOCKED |
| L7 Reopen shows window | Dock `RunEvent::Reopen` | second launch focuses window (L13) | Equivalent | none | none | BLOCKED |
| L8 Sign-in | `session.ts` | same in WebView2; origin `http://tauri.localhost` must be in `CORS_ORIGINS` (N02) | Same | `client.test.ts` M U CW; API `auth.e2e` | never in WebView2 | BLOCKED |
| L9 Session restore | Keychain | Credential Manager, **roaming** (L10, D1) | Partial | `client.test.ts` CW (logic); Credential Manager never exercised | none | PARTIAL |
| L10 Sign-out clears credentials | Keychain delete | `CredDeleteW` | Equivalent | none on Windows | none | NOT TESTED |
| L11 Device registration | installation ID in Keychain, `platform: macos` | ID in Credential Manager (roams, D1), `platform: windows` | Partial | API `devices-audit`, `device-sessions` M U | none | PARTIAL |
| L12 Launch at login | `SMAppService` | HKCU `Run` + `StartupApproved` (L12) | Equivalent | pure value tests M CM CW; registry calls never executed | none | NOT TESTED |
| L13 Close hides window | `prevent_close` | same (L16) | Same | none | none | BLOCKED |
| L14 Quit confirmation while clocked in | `NSAlert`; menu Quit + Cmd+Q | `MessageBoxW` from tray Exit (L18); no keyboard Exit (by design) | Equivalent | `tray::quit_asks…` M CM CW | none | BLOCKED |
| L15 Exit stops recording | `RunEvent::Exit` | same, but no `WM_QUERYENDSESSION`/`WM_ENDSESSION` (L19, D12) | Partial | collector quit test M CM CW | none | PARTIAL |
| L16 Hide Dock icon | Accessory policy | hide taskbar button (L17) | Equivalent | none | none | BLOCKED |
| L17 Background power opt-out | App Nap (`NSProcessInfo`) | EcoQoS, main process only; `backgroundThrottling` unsupported (L20, L21) | Partial | `windows_throttling_opt_out_applies_and_restores` CW PASS | none | PARTIAL |
| L18 Crash recovery | `queue::activity_recover` | same | Same | queue tests M CM CW | — | PASS |
| L19 Collector worker | `collector.rs` | same + Windows samplers | Same | collector tests M CM CW | none | BLOCKED |

### A. Activity

| Feature | macOS | Windows | Code parity | Tests | Runtime | Status |
|---|---|---|---|---|---|---|
| A1 Idle source | `CGEventSourceSecondsSinceLastEventType` (HID state) | `GetLastInputInfo` + `GetTickCount` (A01); counts injected input (A05) | Partial | `idle_ticks_wrap…` M CM CW; `native_samples_are_sane` CW (range only) | none | PARTIAL |
| A2 Repeated / held keys | HID counter | same counter; held key via typematic repeat (~85 %) (A02-A04) | Equivalent | none on either OS | none | BLOCKED |
| A3 Threshold from policy | `activity_configure` | same (A06) | Same | tracker M CM CW; API policy e2e M U | — | PASS |
| A4 Threshold display | `activity-ui.ts` | same | Same | `live-state`/UI logic M U CW | never rendered in WebView2 | BLOCKED |
| A5 ACTIVE/IDLE transitions | `Tracker::sample` | same (A07) | Same | ~35 tracker tests incl. fuzz and QA adversarial M CM CW | — | PASS |
| A6 Foreground app | CGWindowList owner | `GetForegroundWindow` → exe name/FileDescription, UWP host resolution, protected process fallback (A10-A12) | Equivalent | helpers M CM CW; native smoke CW | none | BLOCKED |
| A7 Idle-excluded apps | bundle id | exe file name (A08) | Same (server list must use `name.exe`) | M CM CW | — | PASS |
| A8 Lock = IDLE | CGSession lock + notifications | `OpenInputDesktop` level + WTS lock events (A13-A16); secure desktop = locked | Equivalent (UAC differs) | lock tests M CM CW; native smoke CW | none | BLOCKED |
| A9 Sleep/wake | `NSWorkspaceWillSleep/DidWake` + stalled clock | `PBT_APMSUSPEND/RESUME*` + gap rule; Modern Standby unknown (A17, A18) | Equivalent (mechanism differs) | mapping M CM CW; thread start CW | none | BLOCKED |
| A10 Display sleep (informational) | `ScreensDidSleep/Wake` | `GUID_CONSOLE_DISPLAY_STATE` (A19) | Equivalent | mapping M CM CW | none | BLOCKED |
| A11 User switching / logout | session resign/active | WTS console/connect state (A20) | Equivalent | `session_in_front…` M CM CW; native CW | none | BLOCKED |
| A12 Clock change | wall vs monotonic | same (A21) | Same | M CM CW | — | PASS |
| A13 Gap notice | `activity-ui.ts:323` | same | Same (wording stale on both: says "or locked") | none on wording | none | PARTIAL |
| A14 Mode from attendance | `monitoring.ts` | same | Same | `monitoring.test.ts` M U CW | — | PASS |
| A15 Break / clock-out stop | collector `stop` | same (A23, A24) | Same | M CM CW | — | PASS |
| A16 15-minute split | tracker | same | Same | M CM CW | — | PASS |
| A17 Checkpoint / backlog limit | `queue.rs` | same (A25) | Same | M CM CW | — | PASS |
| A18 Interval upload | `activity-ui.ts` on webview timers | same; hidden-window timers unprotected (N10) | Same | `client.test.ts` M U CW; API `activity.e2e` | none | BLOCKED |
| A19 Live state report | `live-state.ts`, 5 s poll, 60 s keepalive | same (A09) | Same | `live-state.test.ts` M U CW; API `role-separation-live-status` | never sent from a real Windows app | BLOCKED |
| A20 Activity card | `activity-ui.ts` | same, Windows wording | Same | logic M U CW | none | BLOCKED |
| A21 Activity notice and consent | server text + POST consent | same | Same | API "consent and policy" M U; `monitoring.test.ts` CW | server enforcement tested | PASS |

### S. Screenshots

| Feature | macOS | Windows | Code parity | Tests | Runtime | Status |
|---|---|---|---|---|---|---|
| S1 Capture | ScreenCaptureKit | GDI `BitBlt` primary monitor (S01) | Equivalent | `captures_the_primary_display…`, `repeated_captures_release…` CW PASS | service-session desktop only | BLOCKED |
| S2 Primary display only | `CGMainDisplayID` | `MonitorFromPoint(PRIMARY)` (S02) | Equivalent | `monitor_rectangles` M CM CW | none | BLOCKED |
| S3 Permission preflight | `CGPreflightScreenCaptureAccess` | no OS permission (S03) | N/A | — | — | N/A |
| S4 Permission request | `CGRequestScreenCaptureAccess` | — (button hidden, U06) | N/A | — | — | N/A |
| S5 Denied / revoked | NEEDS_PERMISSION | cannot occur | N/A | — | — | N/A |
| S6 Interval from policy | `Shooter::due` | same (S05) | Same | Shooter tests (fake OS) M CM CW | — | PASS |
| S7 Consent / policy gating | `monitoring.ts` | same (S12) | Same | M U CW; API rejects uploads when off / before consent | — | PASS |
| S8 Stale policy (24 h) | `screenshot-sync.ts` | same | Same | M U CW | — | PASS |
| S9 No capture locked / asleep / other session | `session_capturable` | same rule over Windows checks (S10) | Equivalent | fake-OS tests M CM CW | none | BLOCKED |
| S10 No capture with display asleep | `CGDisplayIsAsleep` (level) | notification only (S11, D7) | Partial | mapping M CM CW | none | PARTIAL |
| S11 Encoding | SCK scaling + WebP | CPU box downscale + WebP (S04, S06) | Equivalent | encode tests M CM CW; in-memory capture+encode CW | — | PASS |
| S12 Masks | `redact` | same | Same | M CM CW | — | PASS |
| S13 Blur | same | same | Same | M CM CW | — | PASS |
| S14 Durable local queue | `screenshot.rs` states | same (S07, S18) | Same (file mode in X4) | M CM CW | — | PASS |
| S15 500 MB cap / 1 GB free disk | `statvfs` | `GetDiskFreeSpaceExW` (S07) | Equivalent | cap tests M CM CW; Windows free-disk call never executed | none | NOT TESTED |
| S16 Upload | register → PUT → STORED, webview timers | same (S09) | Same | `screenshots.test.ts` M U CW; API e2e | none | BLOCKED |
| S17 Retry with backoff | queue | same | Same | M CM CW | — | PASS |
| S18 Storage via API to OneDrive | API brokered | same (server-side) | Same | API e2e with local storage and fake Graph; real OneDrive not run (both) | — | PASS |
| S19 Cleanup after upload | `screenshot.rs` | same | Same | M CM CW | — | PASS |
| S20 Non-latching capture failure | `skipped` "Capture failed:" | same | Same | M CM CW | — | PASS |
| S21 State to server | OK / PERMISSION_DENIED / CAPTURE_FAILED | OK / CAPTURE_FAILED (S13) | Same | M U CW | — | PASS |
| S22 Screenshot card | `screenshot-ui.ts` | same, Windows wording | Same | logic M U CW | none | BLOCKED |
| S23 Config / capture race | generation counter | same | Same | M CM CW | — | PASS |

### N. Sync and networking

| Feature | macOS | Windows | Code parity | Tests | Runtime | Status |
|---|---|---|---|---|---|---|
| N1 API client | `fetch` in WKWebView | `fetch` in WebView2; TLS via Windows store; system proxy (N01, N04, N05) | Same code, different engine | `client.test.ts` M U CW | never in WebView2 | BLOCKED |
| N2 Auth refresh | 401 → refresh once | same (N08) | Same | M U CW; API `auth`, `sessions` | — | PASS |
| N3 Online/offline detection | `/health` 15 s | same | Same | logic M U CW | timers in hidden WebView2 unverified | BLOCKED |
| N4 Reconnection | queues kicked | same | Same | logic M U CW | none | BLOCKED |
| N5 Offline attendance queue | SQLite WAL | same (N06) | Same | queue M CM CW; API "offline sync" | — | PASS |
| N6 Sync engine backoff | `sync.ts` | same (N07) | Same | M U CW | — | PASS |
| N7 Idempotency | client UUIDs, server keys | same | Same | API e2e M U | — | PASS |
| N8 Rejected items kept | queue | same | Same | M CM CW | — | PASS |
| N9 Offline projection | shared reducer | same | Same | M U CW | — | PASS |
| N10 Device status / revocation | `/devices/me`, 401/403 → blocked | same (N09) | Same | M U CW; API devices e2e | — | PASS |
| N11 Device header | installation ID header | same | Same | M U CW; API | — | PASS |
| N12 Server clock offset | display | same | Same | M U CW | — | PASS |

### U. User interface

| Feature | macOS | Windows | Code parity | Tests | Runtime | Status |
|---|---|---|---|---|---|---|
| U1 Login view and errors | `main.ts` | same | Same | logic M U CW | none | BLOCKED |
| U2 Credential-store wait notice | "Keychain" | generic wording (U07) | Same | none | none | BLOCKED |
| U3 Identity card | shared | same | Same | M U CW | none | BLOCKED |
| U4 Status card | shared | same | Same | M U CW | none | BLOCKED |
| U5 Elapsed time display | menu-bar title | tray tooltip, visible on hover only (L15, U04) | Equivalent (platform limit) | tooltip tests M CM CW | none | BLOCKED |
| U6 Attendance card and buttons | shared | same | Same | M U CW | none | BLOCKED |
| U7 Sync card | shared | same | Same | M U CW | none | BLOCKED |
| U8 Device register / blocked cards | shared | same | Same | M U CW | none | BLOCKED |
| U9 "What is recorded" card | shared | same, Windows wording | Same | `platform.test.ts` M U CW | none | BLOCKED |
| U10 Settings tab | seconds, Dock, login item | seconds (tooltip), taskbar button, Run key (U11) | Equivalent | prefs M CM CW | none | BLOCKED |
| U11 OS notifications | notification plugin | WinRT toast, needs Start-menu app id (N11) | Equivalent | `notify.test.ts` M U CW | none | BLOCKED |
| U12 History tab, CSV/XLSX export | shared | same; download path check case-sensitive (X11) | Same | M U CW | none | BLOCKED |
| U13 Corrections tab | shared | same | Same | M U CW | none | BLOCKED |
| U14 Leave tab | shared | same | Same | M U CW | none | BLOCKED |
| U15 Tasks tab | shared | same | Same | M U CW | none | BLOCKED |
| U16 Websites tab | shared | same | Same | M U CW | none | BLOCKED |
| U17 My screenshots tab | shared | same | Same | M U CW | none | BLOCKED |
| U18 Version display | `app_info` | same (U13) | Same | none | none | BLOCKED |
| U19 Platform wording | `platform.ts` | `WINDOWS` table (U01, U02, U09-U11) | Same mechanism | `platform.test.ts` M U CW | — | PASS |
| U20 Notices (recovered, logout with unsynced) | shared | same; may appear after every Windows restart (L15) | Same | M U CW | none | BLOCKED |

### X. Security and privacy

| Feature | macOS | Windows | Code parity | Tests | Runtime | Status |
|---|---|---|---|---|---|---|
| X1 Refresh token in OS store | Keychain | Credential Manager, `CRED_PERSIST_ENTERPRISE` (X01, D1) | Partial | none on Windows | none | PARTIAL |
| X2 Installation ID | Keychain UUID | Credential Manager UUID, roams (X08) | Partial | none on Windows | none | PARTIAL |
| X3 Staging vs production isolation | service + identifier | same + Run value name (O04) | Equivalent | `desktop-config.test.ts` M U CW (config only) | none | NOT TESTED |
| X4 Owner-only local files | 0600 / 0700 | none (`#[cfg(unix)]`; profile ACL) (X02-X04) | Partial | unix-only asserts | none | PARTIAL |
| X5 CSP | `tauri.conf.json` | same + `ipc.localhost` (X07) | Same | `desktop-config.test.ts` M U CW | — | PASS |
| X6 https-only release API | `desktop-config.mjs` | same | Same | M U CW | — | PASS |
| X7 Privacy guard (no hooks, taps, key state, titles, clipboard) | static test | static test | Same | **FAIL on CW** (3 tests, CRLF and backslash paths); PASS on M and U | manual reading: no such API on either OS | **FAIL** |
| X8 Consent enforced before recording | client + server | same | Same | M U CW; API | — | PASS |
| X9 Download allow-list | `allowed_download` | same; case-sensitive path compare (X11) | Same | unix paths only | none | NOT TESTED |
| X10 Logging | stderr | stderr discarded (no console, no file) (X06) | Partial | none | none | PARTIAL |
| X11 Sign-out clears per-user cache | shared | same | Same | M U CW | — | PASS |
| X12 Masked pixels only in memory | shared | same | Same | M CM CW | — | PASS |

### O. Other

| Feature | macOS | Windows | Code parity | Tests | Runtime | Status |
|---|---|---|---|---|---|---|
| O1 objc2 bindings | AppKit etc. | windows-sys (equivalent role) | N/A | — | — | N/A |
| O2 Native runtime harness | `verify-native.mjs`, debug e2e hook | none (O02) | Missing | — | — | **MISSING** |
| O3 Browser-extension pairing | via API | same | Same | API `websites.e2e` M U; extension 7/7 | — | PASS |
| O4 Plain-browser dev mode | `pnpm dev:web` | development tool | N/A | — | — | N/A |

### Windows-specific items with no macOS row

| Item | Status | Note |
|---|---|---|
| WebView2 missing at launch (L03) | NOT TESTED | message-box path never observed |
| Uninstall (L06) | BLOCKED | leaves Credential Manager entries and `StartupApproved\Run` value (D9) |
| Upgrade over running app (L07) | BLOCKED | killed app → recovery notice |
| UWP / ApplicationFrameHost (A11) | BLOCKED | pure helper tested M CM CW |
| Protected processes (A12) | BLOCKED | recorded as "Unknown app (protected)" |
| Modern Standby (A18) | BLOCKED | delivery of suspend/resume unknown |
| DPI scaling 125-200 % (S14) | BLOCKED | |
| HDR / Advanced Color (S15) | BLOCKED | likely washed-out frames (D13) |
| Protected content (S16) | BLOCKED | black areas expected |
| Corporate proxy / TLS with the 6-day IP certificate (N04, N05) | BLOCKED | |
| MSI per-machine build (O03) | NOT TESTED | produced by `targets: all`, never built in CI |
| Windows on ARM64 (O01) | MISSING | x64 only |
| Several Windows users on one PC (O05) | BLOCKED | per-session mutex, per-user data |
| Auto-update (L23) | MISSING on both | not a parity gap |

## 6. Test results behind this matrix

| Suite | Host | Result |
|---|---|---|
| typecheck, lint (eslint + clippy `-D warnings`) | M | PASS |
| Desktop TypeScript | M | 81/81 PASS |
| Desktop TypeScript | CW | **78/81, 3 FAIL** (privacy guard portability) |
| Desktop TypeScript | U | 81/81 PASS |
| Desktop Rust `cargo test` | M | 103 PASS, 1 ignored (screen-capture benchmark, not run) |
| Desktop Rust `cargo test` | CM | 103 PASS, 1 ignored |
| Desktop Rust `cargo test` incl. 6 Windows-native smoke tests | CW | **107 PASS**, 1 ignored |
| clippy `--all-targets -D warnings` | CW, M, gnu cross-check | PASS |
| `cargo check` / clippy for `x86_64-pc-windows-gnu` (fresh target dir, full rebuild) | M | PASS (gnu, not the MSVC toolchain used for releases) |
| API | M | 491/491 PASS (incl. uncommitted invitations suite); U: 471 pass, 8 skipped |
| shared / database / browser extension | M, U | 76/76, 49/49, 7/7 PASS |
| Dashboard browser suites | CM | PASS |
| NSIS installer | CW | **not built** (skipped after the TS failure) |
| macOS `.app` (placeholder API, unsigned) | M | built, 6.6 MiB, not opened |
| Physical Windows PC | — | **BLOCKED: no hardware** |
| Native macOS (`verify:native`, `verify:screenshots`) | — | **NOT RUN**: they launch the app, write to the production Keychain service on this Mac, and ask a person to lock and sleep the Mac; `verify-screenshots` captures the real screen. `verify-native`'s lock check is also outdated (will FAIL on a correct build) |

Windows-native smoke tests that ran on CW (all PASS): `win::activity::native_samples_are_sane`,
`win::capture::captures_the_primary_display_and_encodes_it_in_memory`,
`win::capture::repeated_captures_release_their_gdi_objects`, `win::session::constants_match_windows_sys`,
`win::session::notification_thread_starts_and_stops_cleanly`, `power::windows_throttling_opt_out_applies_and_restores`.
They execute the Win32 calls on Windows Server without a user, so they prove the calls work and do not leak; they
do not observe input, lock or sleep.

## 7. Windows idle detection verdict

| Question | Answer | Evidence | Status |
|---|---|---|---|
| Detects genuine keyboard input | Yes by API contract (`GetLastInputInfo` covers keyboard and mouse) | `win/activity.rs:207-215`; never observed | BLOCKED |
| Mouse movement and clicks | Yes by API contract | same | BLOCKED |
| Repeated presses of one key | Each press is input | same | BLOCKED |
| Held key | Expected via typematic repeat (about 85 % confidence); not with Filter Keys | no test on any OS | BLOCKED |
| Resets the idle timer | Yes: idle backdated to last input, wrap-safe | `idle_ticks_wrap_at_49_7_days` M CM CW PASS | PASS (logic) |
| IDLE after the configured threshold | At the first sample past the threshold (≤ 15 s default) | tracker tests incl. fuzz CW PASS | PASS (logic) |
| ACTIVE when input resumes | From the input time, at the next sample | CW PASS | PASS (logic) |
| Lock/unlock | Polled input-desktop level + WTS events; locked = IDLE | logic CW PASS; events never observed | BLOCKED |
| Sleep/wake | Suspend/resume messages + gap rule | logic CW PASS; Modern Standby unknown | BLOCKED |
| Sends live state | Same code as macOS, on webview timers | `live-state.test.ts` CW PASS; hidden-window throttling unverified | BLOCKED |
| Ignores synthetic input | **No**: injected input counts | documented; hooks need owner approval | PARTIAL |
| Records key content | **No**: counter only; no hooks, key state, titles or clipboard | static guard PASS on M/U, red on CW for portability only | — |

Verdict: the Windows idle pipeline is complete in code and its logic is tested on Windows CI; whether it works on
a real PC is unverified. The one known behavioural gap is injected input.

## 8. Screenshot pipeline parity

| Stage | macOS | Windows | Same code? | Status (Windows) |
|---|---|---|---|---|
| Capture API | ScreenCaptureKit | GDI BitBlt | No | BLOCKED (CW in-memory capture PASS) |
| Permission | Screen Recording (preflight, request, revoke) | none exists | No | N/A |
| Interval | server policy, ≥ 60 s | same | Yes | PASS |
| Encoding | WebP after SCK scaling | WebP after CPU box downscale | Mostly | PASS |
| Local storage | 0600 files, 0700 dir, fsync dir | NTFS, profile ACL, no dir fsync | Partly | PARTIAL (X4) |
| Queue | durable states | same | Yes | PASS |
| Upload / retry | API register + PUT, backoff | same, webview timers | Yes | BLOCKED |
| Failure recovery | non-latching | same | Yes | PASS |
| OneDrive | via API | via API | Yes (server) | PASS (fake Graph); real OneDrive NOT RUN on both |
| Consent / policy | client + server | same | Yes | PASS |
| Display asleep | level read | notification only | No | PARTIAL |
| Admin visibility / employee access | dashboard, server RBAC | same (platform-independent) | Yes | PASS (API e2e and browser suites) |

No screenshot was captured from a real desktop on either OS during this audit, and screenshot capture remains off
by default everywhere.
