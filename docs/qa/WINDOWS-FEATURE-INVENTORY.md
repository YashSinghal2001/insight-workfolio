# Windows feature inventory (desktop app)

Audit date 2026-11-13. Source read at `4d66269` (desktop tree clean). Read-only: nothing built, run or tested for this file.
macOS is the reference; this file records only what the Windows code path actually does.

> **Coordinator update (2026-11-13, after this file was written):** CI run
> [43388023773](https://github.com/YashSinghal2001/insight-workfolio/actions/runs/43388023773) ran the Windows job on
> `4d66269` itself. `cargo test` 107 PASS (1 ignored) including all six `[win]` smoke tests; clippy PASS; TypeScript
> **78/81, 3 FAIL** (`privacy-apis.test.ts` portability: CRLF and backslash paths); the NSIS installer step was
> therefore **skipped**. So CI codes `0` below now mean "logic ran on Windows CI and passed"; `B` rows were **not**
> built for this commit. O06/D10 (stale CI) are resolved and replaced by that failure.
> See `MACOS-WINDOWS-FEATURE-PARITY.md`.

**Legend**
- Tests: `[all]` pure test, runs on every host (incl. macOS); `[win]` `#[cfg(windows)]`, runs only on Windows; `[ts]` node test (platform-independent); `none`.
- CI: the only Windows CI evidence is run **41673001562** (2026-11-03, `windows-latest`, MSVC: clippy, `cargo test`, TS tests, unsigned NSIS; cited in `docs/status/DESKTOP-CROSS-PLATFORM-READINESS.md:16`). It predates commit `4d66269` (2026-11-12), which changed `activity.rs`, `collector.rs`, `screenshot.rs`, `session_events.rs`, `win/session.rs`, `live-state.ts`. Codes: **R** = a `[win]` smoke test exercised the Win32 call in that run; **L** = only pure logic ran there; **C** = compiled/linted only; **B** = packaged into the NSIS artifact; **0** = code changed after that run, never on Windows CI (only `cargo check` for `x86_64-pc-windows-gnu` on macOS, 2026-11-12, `docs/qa/WINDOWS-IDLE-AND-SCREENSHOT-TESTS.md:5`); **-** = not CI-testable.
- Physical PC: **None** for every row. Confirmed by `docs/windows.md:3-9,44-50` ("NOT RUNTIME-VERIFIED") and `docs/qa/WINDOWS-IDLE-AND-SCREENSHOT-TESTS.md:5,9-41` (every runtime row BLOCKED). Column omitted below to save space; read it as "None" everywhere.
- Paths: Rust under `apps/desktop/src-tauri/src/`, TS under `apps/desktop/src/`. `D#` = suspected defect, listed at the end.

## L — Lifecycle

| ID | Feature | Windows implementation (file:function) | Win API | Win-specific? | Tests | CI | Limitations / suspected defects |
|---|---|---|---|---|---|---|---|
| L01 | NSIS installer, per-user | `tauri.conf.json` `bundle.windows.nsis` (`installMode: currentUser`, no language selector) | NSIS (Tauri CLI 2.12.2 template) | Yes | none | B | Unsigned (SmartScreen "Run anyway"); never installed on a PC. `targets: all` also builds a per-machine MSI on Windows; CI builds only `--bundles nsis` |
| L02 | WebView2 provisioning at install | `bundle.windows.webviewInstallMode: downloadBootstrapper` | WebView2 bootstrapper | Yes | none | B | Needs internet if WebView2 is absent |
| L03 | WebView2 missing at launch | `win/webview2.rs:ensure` (called first in `lib.rs:run`) | `tauri::webview_version`, `MessageBoxW` | Yes | `message_only_when_the_runtime_is_missing` [all] | L | Message-box path never observed |
| L04 | Icons | `tauri.conf.json` `bundle.icon` (`icon.ico`), `nsis.installerIcon`; tray `icons/tray-windows.png` (`tray.rs:24`) | — | Partly | none | B | Tray glyph legibility on light/dark taskbar unverified |
| L05 | Code signing | `certificateThumbprint: null`; optional `scripts/desktop-config.mjs:windowsSigningPlan` | signtool / Azure Trusted Signing | Yes | `desktop-config.test.ts` [ts] | C | **BLOCKED**: no certificate. AV/EDR may flag an unsigned monitoring app |
| L06 | Uninstall | NSIS template (Tauri CLI): deletes HKCU Run value `${PRODUCTNAME}`; with "Delete app data" removes `%APPDATA%` and `%LOCALAPPDATA%\com.insightworkfolio.desktop` | NSIS `DeleteRegValue`, `RmDir` | Yes | none | - | Leaves Credential Manager entries and the `StartupApproved\Run` value (D9) |
| L07 | Upgrade over a running app | NSIS (kills app) → `queue::activity_recover` at next start | — | Yes (installer) | recovery logic [all] | - | Killed app = crash-recovery notice (documented `docs/windows.md:333-336`) |
| L08 | First launch, window creation | `lib.rs:run` setup → `WebviewWindowBuilder::from_config` | tao/wry WebView2 | Shared | none | C | `backgroundThrottling: disabled` has no effect on Windows (D2) |
| L09 | Login / logout | `session.ts:login/logout` (shared) + `lib.rs:save/load/clear_refresh_token` | via keyring: `CredWriteW/CredReadW/CredDeleteW` | Shared logic, Win store | `client.test.ts` [ts] | L | Credential Manager never exercised (not even in CI) |
| L10 | Session persistence (refresh token) | `lib.rs:credential` → keyring 3.6.3 `windows-native`; target `refresh-token.com.insightworkfolio.desktop` | `CredWriteW` `CRED_TYPE_GENERIC`, **`CRED_PERSIST_ENTERPRISE`** | Win store | none | C | Enterprise persistence roams with roaming profiles (D1) |
| L11 | Device registration / installation ID | `lib.rs:installation_id` (UUID v4 in credential store) → `main.ts` `POST /devices/register {platform:"windows"}` | `CredReadW/CredWriteW` | Shared + Win store | `client.test.ts` [ts] | L | Installation ID roams with the credential (D1) → two PCs could present the same device |
| L12 | Launch at sign-in | `prefs.rs:login_item::{enabled,set}`: HKCU `…\CurrentVersion\Run` value = quoted exe; reads `…\Explorer\StartupApproved\Run` | `RegSetKeyValueW`, `RegGetValueW`, `RegDeleteKeyValueW` | Yes | `run_key_value_is_the_quoted_exe_path`, `task_manager_startup_switch` [all] | L | Registry calls never executed anywhere (no `[win]` test). Turning on deletes a Task-Manager "Disabled" |
| L13 | Single instance / reopen | `lib.rs:run` `tauri_plugin_single_instance::init` → `tray::open_main` | `CreateMutexW("<id>-sim")`, `WM_COPYDATA`, `AllowSetForegroundWindow` (plugin 2.5.5) | Yes (macOS uses `flock` + `RunEvent::Reopen`) | none (unix `flock` test only) | C | Per-session mutex: other Windows users run their own copy (intended) |
| L14 | Tray icon and menu | `tray.rs:Shell::init` (`show_menu_on_left_click(false)`, left-click → `open_main`), `menu` | tray-icon crate (`Shell_NotifyIconW`) | Partly | `windows_tooltip_carries_the_timer_and_fits_the_buffer` [all] | L | New icon lands in overflow (^) |
| L15 | Elapsed timer | `tray.rs:tick_forever` → `set_tooltip(tooltip(label, elapsed))` (macOS: `set_title`) | `Shell_NotifyIconW` tooltip | Yes | tooltip/format tests [all] | L | Timer only visible on hover (no tray text on Windows) |
| L16 | Close keeps running | `lib.rs` `WindowEvent::CloseRequested` → `prevent_close` + `tray::hide_main` | tao `ShowWindow(SW_HIDE)` | Shared | none | C | Alt+F4 also hides; WebView2 controller stays "visible" (wry not told) |
| L17 | Hide from taskbar | `tray.rs:apply_dock` → `set_skip_taskbar` | `ITaskbarList` (tao) | Yes | none | C | — |
| L18 | Exit with confirmation | `tray.rs:quit` → `confirm_quit` (Windows) | `MessageBoxW(MB_OKCANCEL|MB_TOPMOST|MB_SETFOREGROUND)` | Yes | `quit_asks_whenever_clocked_in…` [all] | L | No keyboard shortcut (macOS Cmd+Q app menu has no Windows equivalent) |
| L19 | Shutdown / sign-out exit | `lib.rs` `RunEvent::Exit` → collector/shooter STOPPED | tao `WM_ENDSESSION` handling | Shared | none | - | No own `WM_QUERYENDSESSION` handling; whether `Exit` runs before termination is unverified; fallback = crash recovery (D12) |
| L20 | EcoQoS opt-out while recording | `power.rs:imp::begin/apply` (from `collector.rs:259 configure`) | `SetProcessInformation(ProcessPowerThrottling, EXECUTION_SPEED)` | Yes | `windows_throttling_opt_out_masks` [all]; `windows_throttling_opt_out_applies_and_restores` [win] | R | Main process only; WebView2 renderer/network processes (all uploads, live state) are not covered (D3). Never touches `SetThreadExecutionState` |
| L21 | Webview background throttling | `tauri.conf.json` `"backgroundThrottling": "disabled"` | — | macOS-only effect | none | - | **MISSING on Windows**: Tauri documents it as unsupported on Windows (`tauri-utils-2.10.2/src/config.rs:2248`) (D2) |
| L22 | Show-seconds preference | `prefs.rs:save/load` (`%APPDATA%`), `tray.rs:set_show_seconds` | file I/O | Shared | `defaults_when_missing…` [all] | L | Applies to tooltip only |
| L23 | Auto-update | — | — | — | — | - | **MISSING** (both platforms) |

## A — Activity

| ID | Feature | Windows implementation (file:function) | Win API | Win-specific? | Tests | CI | Limitations / suspected defects |
|---|---|---|---|---|---|---|---|
| A01 | Idle source | `win/activity.rs:idle_ms_now` → `idle_ms` (wrapping u32, >2^31 → 0); wired by `activity.rs:426` | `GetLastInputInfo`, `GetTickCount` | Yes | `idle_ticks_wrap_at_49_7_days` [all]; `native_samples_are_sane` [win] (range only) | R | CI runner has no user input: detection itself never observed. `-1` on API failure = unobserved |
| A02 | Keyboard, mouse move, click, wheel reset idle | same (session-wide last-input tick) | `GetLastInputInfo` | Yes | none | - | Expected by API contract; NOT RUN. Game controllers do not update it |
| A03 | Repeated key presses | same | `GetLastInputInfo` | Yes | none | - | Each press is input; NOT RUN |
| A04 | Held key (typematic repeat) | same | `GetLastInputInfo` | Yes | none | - | Assumed (~85%, `WINDOWS-IDLE-AND-SCREENSHOT-TESTS.md:11`); Filter Keys / repeat disabled would stop refreshing |
| A05 | Injected (synthetic) input | not filtered | `GetLastInputInfo` counts `SendInput` | Yes | `privacy-apis.test.ts` [ts] (proves no hooks) | L | **Differs from macOS** (macOS uses HID state, `activity.rs:369`). Software jigglers keep Windows ACTIVE. Hooks need owner decision (`docs/windows.md:108-128`) |
| A06 | Idle threshold source + display | server `idleThresholdSeconds` → `lib.rs:activity_configure` → `Config::new`; shown in `activity-ui.ts` | — | Shared | tracker tests [all] | 0 | UI display not launched on Windows |
| A07 | ACTIVE↔IDLE transitions | `activity.rs:Tracker::sample/settle` (idle backdated to last input; resume at input) | — | Shared | ~35 tracker tests incl. fuzz [all] | 0 | IDLE seen at next sample (≤15 s default) |
| A08 | Idle-excluded apps (W22) | `activity.rs:idle_excluded` (Windows id = exe file name) | — | Shared | `excluded_app_in_front…` [all] | 0 | Server list must use `xxx.exe` names on Windows |
| A09 | Live state to backend | `live-state.ts:liveState/reportDue`, `activity-ui.ts:reportLive` (5 s poll, 60 s keepalive) | WebView2 `fetch` | Shared | `live-state.test.ts` [ts] | 0 | Runs on webview timers; hidden-window throttling on Windows unmitigated (D2, D3) |
| A10 | Foreground app | `win/activity.rs:frontmost`, `exe_path`, `file_description` (cached) | `GetForegroundWindow`, `GetWindowThreadProcessId`, `OpenProcess(QUERY_LIMITED)`, `QueryFullProcessImageNameW`, `GetFileVersionInfo*W`, `VerQueryValueW` | Yes | `identifier_…`, `name_prefers_…` [all]; `native_samples_are_sane` [win] | R | Identifier = lowercased exe name, never path |
| A11 | UWP / ApplicationFrameHost | `win/activity.rs:child_pids`, `hosted_app_pid` | `EnumChildWindows` | Yes | `frame_host_resolves…` [all] | L | Suspended UWP keeps "Application Frame Host" |
| A12 | Protected processes | `frontmost` → `PROTECTED_APP` | `OpenProcess` failure | Yes | none | C | Recorded ACTIVE "Unknown app (protected)", no id |
| A13 | Lock/unlock (polled level) | `win/activity.rs:screen_locked`, `locked_from_input_desktop` | `OpenInputDesktop(DESKTOP_READOBJECTS)`, `GetUserObjectInformationW(UOI_NAME)` | Yes | `input_desktop_other_than_default…` [all]; native [win] | R | Only error 5 counts as locked (D5) |
| A14 | Lock/unlock (events) | `win/session.rs:run/wndproc/event_for` | `WTSRegisterSessionNotification(NOTIFY_FOR_THIS_SESSION)`, `WM_WTSSESSION_CHANGE` | Yes | `session_and_power_messages_map_to_events` [all]; `notification_thread_starts_and_stops_cleanly`, `constants_match_windows_sys` [win] | R (thread start only) | Lock event alone counts 5 s (`session_events.rs:127`); no retry if registration fails at logon (`win/session.rs:146`) |
| A15 | Lock = IDLE | `activity.rs:Tracker::lock/locked_sample`; `collector.rs:on_transition` | — | Shared | lock tests [all] | 0 | — |
| A16 | UAC / Ctrl+Alt+Del / screen saver | `locked_from_input_desktop` (desktop ≠ "Default") | `OpenInputDesktop` | Yes | [all] | L | **Differs from macOS**: UAC prompt time = IDLE, not active (D6, by design) |
| A17 | Sleep/wake | `win/session.rs` `PBT_APMSUSPEND`→WillSleep, `PBT_APMRESUME*`→DidWake; tracker gap rule `activity.rs:130` | `RegisterSuspendResumeNotification(DEVICE_NOTIFY_WINDOW_HANDLE)` | Yes | mapping [all]; stall test [all] | R (registration only) | `Instant` (QPC) keeps counting in sleep on Windows: detection relies on `dm > 3·sample+5 s` and the event (D8) |
| A18 | Modern Standby (S0ix) | same as A17 | same | Yes | none | - | Delivery of suspend/resume and DAM suspension behaviour unknown; `QueryUnbiasedInterruptTime` not used |
| A19 | Display off (activity) | `win/session.rs:display_event` → `ScreensSlept` (informational for activity) | `RegisterPowerSettingNotification(GUID_CONSOLE_DISPLAY_STATE)` | Yes | `display_event` asserts [all] | 0 | Activity unaffected by design |
| A20 | Fast user switching / RDP | `win/activity.rs:on_console/session_in_front`; WTS connect/disconnect/logon/logoff events | `WTSGetActiveConsoleSessionId`, `ProcessIdToSessionId`, `WTSQuerySessionInformationW(WTSConnectState)` | Yes | `session_in_front_on_console_or_connected_remotely` [all]; native [win] | R | RDP into own session = observed |
| A21 | Clock changes | `activity.rs:130` wall vs `Instant` | — | Shared | `clock_changes_and_stalls…` [all] | 0 | — |
| A22 | Crash recovery | `queue.rs:activity_recover` (`lib.rs:478`) | — | Shared | queue tests [all] | L | — |
| A23 | Clock-in / clock-out | `main.ts`, `sync.ts`, `queue.rs` | — | Shared | `client.test.ts` [ts], queue [all] | L | — |
| A24 | Breaks | `monitoring.ts` decision → `activity_configure` PAUSED | — | Shared | `monitoring.test.ts` [ts] | L | — |
| A25 | Activity upload + backpressure | `activity-ui.ts` engine, `queue.rs`, `collector.rs:record` | — | Shared | [ts]/[all] | L | — |

## S — Screenshots

| ID | Feature | Windows implementation (file:function) | Win API | Win-specific? | Tests | CI | Limitations / suspected defects |
|---|---|---|---|---|---|---|---|
| S01 | Capture API | `win/capture.rs:primary` | `MonitorFromPoint(0,0,PRIMARY)`, `GetMonitorInfoW`, `GetDC`, `CreateCompatibleDC/Bitmap`, `BitBlt(SRCCOPY|CAPTUREBLT)`, `GetDIBits` | Yes | `captures_the_primary_display_and_encodes_it_in_memory`, `repeated_captures_release_their_gdi_objects` [win]; `bgra_*`, `monitor_rectangles` [all] | R | GDI (not DXGI / Graphics Capture) |
| S02 | Multi-monitor | primary only | — | Same as macOS | none | - | Secondary screens never captured |
| S03 | Permission | `screenshot.rs:platform::imp::permission/request_permission` → always `true` | none | Yes | none | C | No OS permission exists; `PERMISSION_DENIED` never reported from Windows |
| S04 | Scaling | `screenshot.rs:downscale` (CPU box filter) | — | Win path only | `capture_conversion_benchmark` [all] | L | macOS scales inside ScreenCaptureKit |
| S05 | Interval / schedule | `screenshot.rs:Shooter::due/tick` (min 60 s) | — | Shared | Shooter tests (fake OS) [all] | 0 | — |
| S06 | Masks, blur, WebP | `screenshot.rs:redact/encode` | libwebp | Shared | [all]; also inside [win] capture test | R (in-memory) | — |
| S07 | Local queue + 500 MB cap + 1 GB free-disk check | `screenshot.rs:save/local_bytes`; `Native::free_bytes` | `GetDiskFreeSpaceExW` | Free-disk call Win | cap tests [all] | C (free-disk) | — |
| S08 | File durability / permissions | `screenshot.rs:save` (`create_new`, `sync_all`, rename) | NTFS | Partly | `captures_on_schedule…` (mode check unix only) [all] | L | No dir fsync, no `0600`: inherits `%LOCALAPPDATA%` ACL (X02) |
| S09 | Upload / retry | `screenshot-sync.ts`, `screenshot.rs:mark/next_upload` | WebView2 `fetch` | Shared | `screenshots.test.ts` [ts] | 0 | Webview timers (D2) |
| S10 | No capture when locked / secure desktop / asleep / other session | `screenshot.rs:session_capturable` via `Native::locked` | as A13/A14/A17/A20 | Shared rule, Win level checks | fake-OS tests [all] | 0 | Mid-capture switch → BitBlt error → `CAPTURE_FAILED`, retried |
| S11 | No capture with display off | `Native::display_asleep` = `session_events::current().display_asleep` | `GUID_CONSOLE_DISPLAY_STATE` notifications | Yes | mapping [all] | 0 | **Differs**: event-only, no level read (macOS `CGDisplayIsAsleep`); failed registration only logged (D7) |
| S12 | Consent + policy gating | `monitoring.ts:screenshotDecision` (24 h cached-policy limit) | — | Shared | `monitoring.test.ts` [ts] | 0 | — |
| S13 | States to server | `monitoring.ts:screenshotReport` → OK / CAPTURE_FAILED | — | Shared | [ts] | 0 | Never PERMISSION_DENIED on Windows |
| S14 | DPI scaling | per-monitor-v2 set by tao before setup (`win/capture.rs:1-2`) | `SetProcessDpiAwarenessContext` (tao) | Yes | none (test binaries not DPI aware) | - | 125–200 % scaling unverified |
| S15 | HDR / Advanced Color | not handled | GDI | Yes | none | - | Likely clipped/washed-out SDR frame; unverified (D13) |
| S16 | Protected content | not handled | `WDA_EXCLUDEFROMCAPTURE`, DRM | Yes | none | - | Black areas expected |
| S17 | Cursor | not drawn (GDI BitBlt excludes it) | — | Yes | none | - | Matches macOS (`setShowsCursor(false)`) |
| S18 | Startup recovery of interrupted saves | `screenshot.rs:recover` | — | Shared | [all] | L | — |

## N — Sync and networking

| ID | Feature | Windows implementation | Win API | Win-specific? | Tests | CI | Limitations / suspected defects |
|---|---|---|---|---|---|---|---|
| N01 | API client | `session.ts`, `sync.ts` (`fetch` in WebView2) | Chromium net stack in WebView2 | Shared code, Win engine | `client.test.ts` [ts] | L | Never run inside WebView2 |
| N02 | Origin / CORS | WebView2 origin `http://tauri.localhost`; API allows it (`apps/api/src/config/env.ts:33-35`) | — | Yes | API tests | - | Production preflight reported OK in readiness doc; no Windows client ever connected |
| N03 | CSP / IPC | `tauri.conf.json` CSP incl. `http://ipc.localhost`; release `desktop-config.mjs:releaseConfig` pins API origin | — | Yes (`ipc.localhost`) | `desktop-config.test.ts` [ts]; CI grep of packaged exe | B | — |
| N04 | TLS | WebView2 (Windows root store) | Schannel/Chromium verifier | Yes | none | - | LE IP certificate (6-day) unverified on Windows |
| N05 | Proxy | none in app; WebView2 follows system proxy | WinINET settings | Yes | none | - | Corporate proxy/PAC untested |
| N06 | Offline attendance queue | `queue.rs` (bundled SQLite, WAL, FULL) at `%LOCALAPPDATA%\…\attendance-queue.db` | — | Shared | queue tests [all] | L | `0600` code is unix-only (X03) |
| N07 | Retry / backoff | `sync.ts` | — | Shared | [ts] | L | — |
| N08 | Auth refresh | `session.ts:refresh` (401 → refresh once) | — | Shared | [ts] | L | — |
| N09 | Device revocation | `sync.ts:145` 401/403 → blocked, no retry | — | Shared | [ts] | L | — |
| N10 | Timers while hidden to tray | `activity-ui.ts:379-384` `setInterval` 5 s / 60 s | WebView2 page lifecycle | Yes (no mitigation) | none | - | D2/D3: throttling or EcoQoS on webview processes could delay live state and uploads |
| N11 | OS notifications | `notify.ts` → `tauri-plugin-notification` 2.8.0 | WinRT toast (needs Start-menu AUMID) | Yes | `notify.test.ts` [ts] | C | Unverified; dev builds show a foreign app id |

## U — UI

| ID | Feature | Windows implementation | Win API | Win-specific? | Tests | CI | Limitations / suspected defects |
|---|---|---|---|---|---|---|---|
| U01 | Platform detection | `lib.rs:app_info` (`std::env::consts::OS`) → `main.ts:633-640`, `platform.ts:platformOf/setPlatform` | — | Shared | `platform.test.ts` [ts] | L | Browser fallback uses `navigator.userAgent` |
| U02 | Static text swap (11 elements) | `platform.ts:STATIC_TEXT/applyStaticWording` (`WINDOWS` wording) | — | Yes | `platform.test.ts` [ts] | L | Never rendered in WebView2 |
| U03 | Tray menu | `tray.rs:menu`: status, monitoring line, "Open Insight Workfolio", "Exit Insight Workfolio" | — | Label differs | [all] | L | — |
| U04 | Tray tooltip | `tray.rs:tooltip` "Working · 2:14[:05]", 127-unit cut | — | Yes | [all] | L | — |
| U05 | Exit dialog text | `tray.rs:270` | `MessageBoxW` | Yes | none | C | — |
| U06 | Screen-capture permission UI | `permissionLabel/Help` "Windows doesn't ask…", `permissionRequestable:false` hides the request button | — | Yes | [ts] | L | HR/Legal to confirm disclosure (`docs/windows.md:214-218`) |
| U07 | Credential-store wait message | `main.ts:230` (generic Keychain/Credential Manager) | — | Shared | none | - | — |
| U08 | Default device name | `main.ts:642` "My PC" | — | Yes | none | - | — |
| U09 | Power wording | `powerOptOut` "Windows efficiency mode is off…" | — | Yes | [ts] | L | Claim covers main process only (D3) |
| U10 | Sleep wording | `asleep` "Computer asleep…" | — | Yes | [ts] | L | — |
| U11 | Close / hidden notices, prefs labels | `hiddenNotice`, `closeHint`, `hideDockIcon` "Hide the taskbar button", `launchAtLogin` "Open at sign-in" | — | Yes | [ts] | L | — |
| U12 | App menu / Cmd+Q | macOS only (`lib.rs:529-530`) | — | Absent | — | - | No Windows keyboard Exit (by design) |
| U13 | Version info | `lib.rs:app_info.version` | — | Shared | none | - | — |
| U14 | Unsupported-platform hint | `records.ts:46` | — | Text names Windows | none | - | — |

## X — Security and privacy

| ID | Feature | Windows implementation | Win API | Win-specific? | Tests | CI | Limitations / suspected defects |
|---|---|---|---|---|---|---|---|
| X01 | Credential storage | keyring 3.6.3: targets `refresh-token.<service>`, `installation-id.<service>` (service = `WORKFOLIO_KEYCHAIN_SERVICE`, `lib.rs:47`) | `CredWriteW` generic, `CRED_PERSIST_ENTERPRISE` (`keyring-3.6.3/src/windows.rs:246`) | Yes | none | C | Roams with roaming profile (D1); blob ≤2560 B (token is 43 chars: fine) |
| X02 | Data directory | `lib.rs:454` `app_local_data_dir` = `%LOCALAPPDATA%\com.insightworkfolio.desktop` | — | Path Win | none | - | `0700` (`lib.rs:457-461`) is unix-only: no ACL set on Windows (default profile ACL) |
| X03 | Queue DB file mode | `queue.rs:33-41` unix only | — | No-op on Windows | unix-only test | - | Same as X02 |
| X04 | Screenshot file mode | `screenshot.rs:623-624` unix only | — | No-op on Windows | unix-only assert | - | Same as X02 |
| X05 | Prefs file | `%APPDATA%\…\prefs.json` (roaming), `prefs.rs:save` | — | Path Win | [all] | L | Two booleans only |
| X06 | Logging | `eprintln!` everywhere; `main.rs:2` `windows_subsystem = "windows"` | — | Yes | none | - | Release build has no console and no log file: logs lost unless stderr is redirected (D4) |
| X07 | CSP | as N03 | — | — | [ts] | B | — |
| X08 | Device identity | random UUID (X01); no hardware IDs | — | Shared | none | - | D1 |
| X09 | No hooks / key state / titles / clipboard | static guard `test/privacy-apis.test.ts` | — | Shared | [ts] | L | Static check, not runtime |
| X10 | Identifier minimisation | `win/activity.rs:identifier` (no user path) | — | Yes | [all] | L | — |
| X11 | Download allow-list | `lib.rs:allowed_download/is_export_name` | — | Shared | `download_tests` [all] (unix paths only) | L | Windows path forms untested |
| X12 | Capabilities | `capabilities/*.json`: `core:default`, `notification:allow-notify` | — | Shared | `privacy-apis.test.ts` [ts] | L | — |

## O — Other

| ID | Feature | Status on Windows | Evidence | Limitations |
|---|---|---|---|---|
| O01 | Windows on ARM64 | MISSING | readiness doc "Missing" | x64 only |
| O02 | Native runtime harness (`verify:native`) | MISSING for Windows | `scripts/verify-native.mjs:296` macOS prompts (Command-Tab) | No scripted Windows runtime check exists |
| O03 | MSI per-machine build | Present but not built in CI | `targets: all`; CI `--bundles nsis` | Intune/GPO path untested |
| O04 | Staging identity separation | Implemented | `prefs.rs:113` `WORKFOLIO_PRODUCT_NAME` (Run value), `lib.rs:47` service | Untested |
| O05 | Multiple Windows users on one PC | Implemented | per-session mutex, per-user data/credentials | Untested |
| O06 | CI evidence is stale | Resolved 2026-11-13 | run 43388023773 on `4d66269`: Rust 107 PASS; TS 3 FAIL (privacy guard portability); NSIS skipped | Windows CI is red until the privacy guard is fixed |
| O07 | Doc drift | — | `docs/windows.md:8,49,393` say smoke tests "not run" (contradicts readiness doc); `docs/windows.md:251` lists `Win32_System_WindowsProgramming`/`QueryUnbiasedInterruptTime`, absent from `Cargo.toml` | D11 |

## Suspected defects and gaps

| # | Finding | Location | Confidence |
|---|---|---|---|
| D1 | Refresh token and installation ID written with `CRED_PERSIST_ENTERPRISE`: in a domain with roaming profiles they follow the user to other PCs, so two PCs can register as the same device and refresh-token rotation on one PC signs out the other. Contradicts the "local, never roaming" intent for data | `lib.rs:54-76,240-260`; `keyring-3.6.3/src/windows.rs:246` | High (code), Medium (impact: needs roaming profiles) |
| D2 | `backgroundThrottling: "disabled"` does nothing on Windows; wry does not mark WebView2 hidden on window hide, so behaviour depends on WebView2's own visibility detection. Live state, uploads and policy refresh all run on webview timers | `tauri.conf.json` window config; `tauri-utils-2.10.2/src/config.rs:2248`; `activity-ui.ts:379-384` | High (no effect), Medium (that throttling actually bites) |
| D3 | EcoQoS opt-out applies to the app process only; WebView2 runs in `msedgewebview2.exe` processes, which Edge may put in efficiency mode | `power.rs:78-87`; wording `platform.ts` `powerOptOut` | Medium |
| D4 | Release logs are discarded (GUI subsystem, stderr only). The Windows checklist asks testers to read `[session] Locked` "in the log" | `main.rs:2`; `docs/windows.md:379` | High |
| D5 | Lock level relies on `OpenInputDesktop` failing with error 5; any other error = unlocked, and the WTS lock event counts only 5 s | `win/activity.rs:66-71`; `session_events.rs:127,143` | Low–Medium |
| D6 | UAC/secure desktop counted as locked → IDLE (by design; differs from macOS) | `win/activity.rs:62-71`; `docs/windows.md:141` | High (behaviour) |
| D7 | Display-off is notification-only (no level query); a failed `RegisterPowerSettingNotification` is only logged and capture continues on a dark/unattended screen | `win/session.rs:157-163`; `screenshot.rs:1002-1004` | Low |
| D8 | Sleep self-heal and tracker comments assume a monotonic clock that stops in sleep; on Windows `Instant` (QPC) keeps counting. Covered by the `dm > 3·sample` rule and WillSleep; short suspends without the event would not be detected | `session_events.rs:81-83,98`; `activity.rs:39,130` | Medium (mechanism), Low (impact) |
| D9 | Uninstall leaves Credential Manager entries and `StartupApproved\Run` value | Tauri NSIS template; `prefs.rs:111` | High |
| D10 | ~~Windows CI evidence predates the 2026-11-12 desktop changes~~ Resolved by run 43388023773; replaced by: Windows CI red (3 privacy-guard tests fail on CRLF/backslash paths), installer not built | `apps/desktop/test/privacy-apis.test.ts:24,35`; no `.gitattributes` | High (verified in the CI log) |
| D11 | `docs/windows.md` contradicts itself and the readiness doc about CI; lists an unused windows-sys feature | `docs/windows.md:8,251,393` | High |
| D12 | No explicit `WM_QUERYENDSESSION`/`WM_ENDSESSION` handling; clean interval close at Windows shutdown unverified | `lib.rs:564-575` | Low |
| D13 | No HDR handling in GDI capture | `win/capture.rs:99` | Low–Medium |

## Counts

| Category | Features |
|---|---|
| L Lifecycle | 23 |
| A Activity | 25 |
| S Screenshots | 18 |
| N Sync/networking | 11 |
| U UI | 14 |
| X Security | 12 |
| O Other | 7 |
| **Total** | **110** |

Windows status in one line: implemented for every macOS feature except webview background-throttling control (L21), a native runtime harness (O02) and ARM64 (O01); auto-update is missing on both. Physical-PC runtime evidence: none for any row.
