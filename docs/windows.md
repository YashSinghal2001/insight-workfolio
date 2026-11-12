# Windows activity collector

**Status (2026-11-02): implemented, cross-compiled, NOT RUNTIME-VERIFIED.** The code lives in
`src-tauri/src/win/activity.rs` (sampling), `src-tauri/src/win/session.rs` (session and power
notifications) and the Windows branch of `src-tauri/src/power.rs`. `activity::platform` reports
`SUPPORTED = true` on Windows. It is verified on macOS only by unit tests of the pure logic,
and for Windows by `cargo check`/`cargo clippy --all-targets --target x86_64-pc-windows-gnu`.
The `#[cfg(windows)]` smoke tests run only on a Windows CI runner and have **not been run**. No Windows runtime behaviour is claimed until
the checklist at the end has been run on a real machine.

The Windows collector produces exactly the same `Sample` as macOS (foreground app name +
identifier, milliseconds since last input, unobservable flag), so the tracker, queue, sync and
server rules are unchanged.

| Piece | Implementation | Pure logic tested on macOS | Windows runtime |
|---|---|---|---|
| Foreground app | `GetForegroundWindow` → `GetWindowThreadProcessId` → `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` → `QueryFullProcessImageNameW` | `identifier`, `display_name` | NOT RUN |
| App name | `GetFileVersionInfoSizeW`/`GetFileVersionInfoW`/`VerQueryValueW` (`\VarFileInfo\Translation`, then `\StringFileInfo\<lang><cp>\FileDescription`, then `040904b0`), cached per executable; fallback: exe file stem | `display_name`, `description_subblock` | NOT RUN |
| Idle | `GetLastInputInfo` vs `GetTickCount`, wrapping subtraction | `idle_ms` (wrap at 49.7 days) | NOT RUN |
| Lock / secure desktop | `OpenInputDesktop` + `GetUserObjectInformationW(UOI_NAME)` | `locked_from_input_desktop` | NOT RUN |
| User in front | `WTSGetActiveConsoleSessionId`, `ProcessIdToSessionId`, `WTSQuerySessionInformationW(WTSConnectState)` | `session_in_front` | NOT RUN |
| Events | message-only window thread: `WTSRegisterSessionNotification`, `RegisterSuspendResumeNotification` | `event_for` | NOT RUN (CI smoke test: start/stop) |
| Background throttling | `SetProcessInformation(ProcessPowerThrottling)` while recording | `throttling_masks` | NOT RUN |

## Foreground application

1. `GetForegroundWindow()` → `HWND` (null while switching or on the secure desktop: no app).
2. `GetWindowThreadProcessId(hwnd)` → process ID.
3. `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)` and
   `QueryFullProcessImageNameW` → executable path. This works for elevated processes from a normal
   user process. Protected processes fail, and are recorded as ACTIVE with the name
   **"Unknown app (protected)"** and **no identifier** (`None`). IDLE is still decided by the idle
   counter, the same as for any app. A failure is never retried in a loop: it's one cheap call per sample.
4. **Identifier (lead decision, 2026-11-02):** the executable's **file name only**, lowercased (e.g. `chrome.exe`),
   never the full path: per-user installs live under `c:\users\<name>\appdata\…`, so a path would send the
   Windows user name to the server (data minimisation). Display names are cached per full path in memory only.
5. **UWP / Store apps** (Calculator, Settings) are hosted in `ApplicationFrameHost.exe`. When the
   foreground process is that host, `EnumChildWindows` on its window gives the first child owned by
   another process (`hosted_app_pid`), and that process's executable is used instead (e.g.
   `calculatorapp.exe`), file name only as above. No child of another process (suspended or closing
   app): the host is kept. Windows runtime **not verified**.

## Idle detection

- `GetLastInputInfo` (`LASTINPUTINFO.dwTime`, a 32-bit tick of the last input in this session),
  read **before** `GetTickCount()`; difference with wrapping subtraction (the tick wraps every
  49.7 days). A difference above 2^31 ms is a race (the last input landed between the two reads)
  and counts as 0, never as ~49 days. A counter only: no keyboard/mouse hooks
  (`SetWindowsHookEx` is never used), no raw input, no input contents.
- Known limitation: some remote-desktop/accessibility tools and game controllers update or do
  not update this counter; verify on pilot hardware.
- Mouse movement, buttons and wheel, and every key press, reset the counter. A held key is
  expected to keep resetting it through typematic repeat (repeats arrive as ordinary keyboard
  input); this is from documentation knowledge and is **NOT RUN** on a PC.
- The threshold is the server policy (`idleThresholdSeconds`, default 300 s). The app shows it
  at all times in the Activity monitoring card ("Idle after").
- A long idle stretch is split every 15 minutes (like a long active interval), so it uploads as it
  goes instead of only when input resumes.
- **Live state.** The open interval is never uploaded, so the app also reports its current state
  (`ACTIVE`, `IDLE`, `UNOBSERVED`) in the `current` field of `POST /activity/sync`: with every
  interval upload, and in an upload with no intervals when the state changes or 60 s have passed
  (`src/live-state.ts`). Nothing is reported while clocked out, on a break, without consent,
  offline, or while attendance changes are still waiting to sync. Locked = `IDLE`; asleep or
  another user in front = `UNOBSERVED`. The reporting runs on webview timers: whether WebView2
  keeps them on time while the window is hidden to the tray is **NOT RUN**.

### Injected (synthetic) input: counts as activity today — awaiting a decision

`GetLastInputInfo` is also refreshed by input that programs inject (`SendInput`, `keybd_event`,
`mouse_event`): software "mouse jigglers", AutoHotkey scripts, remote-control tools. Such input
currently counts as activity and prevents IDLE. A hardware jiggler (a USB device) is a real input
device and cannot be told apart by any method.

Option, **not implemented**: low-level hooks (`WH_KEYBOARD_LL` + `WH_MOUSE_LL`) that read only the
`LLKHF_INJECTED` / `LLMHF_INJECTED` flag and discount input positively flagged as injected, with
`GetLastInputInfo` staying the authority. Costs:
- It reverses the no-hooks promise above. The keyboard hook structure carries the key code even
  though the code would never read it; the employee notice and this document would need review.
- The binary is unsigned: antivirus/EDR products may flag a keyboard hook as keylogger behaviour.
- Windows silently removes a hook whose callback exceeds the timeout (about 300 ms), so it needs
  a periodic reinstall; every mouse move costs a synchronous hop to the hook thread.
- People who legitimately work through injected input would be marked idle: TeamViewer/AnyDesk
  sessions, the on-screen keyboard, AutoHotkey remaps, software KVMs.
- Raw Input (`hDevice == NULL`) was considered and rejected: touchpads and touch may report a
  null device too, which would mark real users idle.

This needs the owner's explicit sign-off; until then `GetLastInputInfo` stays as it is.

## Screen lock and user switching (polled, authoritative)

- `OpenInputDesktop(DESKTOP_READOBJECTS)` + `GetUserObjectInformationW(UOI_NAME)`. Any name other than
  `Default` (`Winlogon`: lock screen, UAC prompt, Ctrl+Alt+Del; screen saver) means locked.
  Access denied (error 5) when opening also means locked. Any other failure is treated as unknown
  and counts as unlocked, as on macOS, so a broken query never stops monitoring by itself.
- **A locked screen is IDLE**, from the lock to the unlock, on macOS and Windows alike: the
  employee notice says idle time includes a locked screen. With the `WTS_SESSION_LOCK` event the
  active interval ends at the lock; if only the poll sees it, it ends at the last unlocked sample.
  Input at the lock screen never counts, and activity never resumes before the screen was last
  seen locked (so a face or fingerprint unlock cannot turn the locked time active).
- **A UAC prompt is treated as locked**: the few seconds the secure desktop is up are IDLE.
- Sleep, fast user switching / another user in front, an invalid idle reading and clock jumps
  stay unobserved (neither ACTIVE nor IDLE).
- The user counts as in front if this process's session is the console session
  (`WTSGetActiveConsoleSessionId`), **or** the session is connected (`WTSConnectState ==
  WTSActive`, e.g. the user working over Remote Desktop). Fast user switching or an RDP
  disconnect leaves the session disconnected, so it is not observed. Unknown own session = in front.

## Session and power events

`session_events::start()` (Tauri `setup`) starts a `session-events` thread with a message-only window
(`HWND_MESSAGE`) and its own `GetMessageW` loop:

| Message | Event |
|---|---|
| `WM_WTSSESSION_CHANGE` `WTS_SESSION_LOCK` / `UNLOCK` | `Locked` / `Unlocked` |
| `WTS_CONSOLE_DISCONNECT`, `WTS_REMOTE_DISCONNECT`, `WTS_SESSION_LOGOFF` | `SessionResigned` |
| `WTS_CONSOLE_CONNECT`, `WTS_REMOTE_CONNECT`, `WTS_SESSION_LOGON` | `SessionActive` |
| `WM_POWERBROADCAST` `PBT_APMSUSPEND` | `WillSleep` |
| `PBT_APMRESUMEAUTOMATIC`, `PBT_APMRESUMESUSPEND` | `DidWake` (it can arrive twice; that's harmless) |

Message-only windows receive no broadcasts, so power events are registered explicitly with
`RegisterSuspendResumeNotification(DEVICE_NOTIFY_WINDOW_HANDLE)` (Windows 8+).
`observable_now()` works the same as on macOS:
- The polled checks above are the level.
- An event alone counts for 5 s (the lock grace).
- A missed resume clears itself after 60 s awake.

If a registration fails (for example, the session service isn't ready right after logon), it is logged and the polled
checks still cover lock and user switching. There is no retry yet.
Display on/off: the same thread registers `RegisterPowerSettingNotification(GUID_CONSOLE_DISPLAY_STATE)`
and maps `PBT_POWERSETTINGCHANGE` data 0 → `ScreensSlept`, 1 or 2 (on, dimmed) → `ScreensWoke`.
Screenshots are skipped while the display is off (`display_asleep`), so an unlocked PC with a
dark screen is not captured. If the registration fails or no notification arrives, the display
counts as on: a missing notification never stops capture by itself. Activity tracking is
unaffected (the idle counter covers it). Delivery to a message-only window is **NOT RUN** on a PC.

## Background throttling (power)

While recording, `SetProcessInformation(GetCurrentProcess(), ProcessPowerThrottling,
{Version 1, ControlMask EXECUTION_SPEED, StateMask 0})` opts the process out of EcoQoS
("Efficiency mode"), so the 15 s collector timer is not stretched when the window is hidden.
When recording stops, `{ControlMask 0, StateMask 0}` hands the decision back to Windows.
`SetThreadExecutionState` is never used, so sleep and display sleep are unaffected. The status
field `appNapPrevented` keeps its name; on Windows it means "background throttling disabled".

## Sleep / wake and clock changes

- The tracker detects sleep by comparing the wall clock with a monotonic clock
  (`Instant`, `collector.rs`), and by any monotonic gap longer than 3 samples.
- On Windows, `Instant` (QueryPerformanceCounter) may keep counting during sleep. The long-gap
  rule and the `WillSleep`/`DidWake` events still close the interval at sleep.
- Not done: `QueryUnbiasedInterruptTime` for `mono_ms`. Add it if Modern Standby (S0ix) runs show
  attribution while "asleep".
- Wall-clock changes are detected the same way as on macOS (wall vs monotonic divergence).

## Screenshots (implemented; Windows runtime unverified)

Status: implemented and cross-compiled (`x86_64-pc-windows-gnu`, check + clippy clean). Pure
helpers are unit-tested on macOS; the Win32 capture itself has only `#[cfg(windows)]` smoke
tests that run on the Windows CI runner. **Not yet run on a real Windows PC.**

- **Code:** `src-tauri/src/win/capture.rs` (`primary()`: GDI adapter; `bgra_to_rgb`,
  `monitor_size`: pure) and the `#[cfg(windows)]` `platform::imp` in `screenshot.rs`.
- **Capture:** the primary monitor only (`MonitorFromPoint(0,0, MONITOR_DEFAULTTOPRIMARY)` +
  `GetMonitorInfoW`), re-queried on every capture so display changes are picked up. `GetDC(NULL)`
  → `CreateCompatibleDC`/`CreateCompatibleBitmap` → `BitBlt(SRCCOPY|CAPTUREBLT)` → `GetDIBits`
  (32-bit, top-down) → RGB. All GDI handles are released on every path (RAII guards). No cursor and
  no capture border (GDI draws none).
- **Pipeline:** scaled to `max_dimension` on the CPU (`screenshot::downscale`, box filter; macOS
  scales inside ScreenCaptureKit), then the shared masks → blur → masks → WebP path, unchanged.
  Measured on an M2 Mac (synthetic, release): 1920×1080 BGRA→RGB ~2 ms (no scaling needed at
  1920); 3840×2160 BGRA→RGB 8 ms + downscale to 1920×1080 11 ms.
- **No permission prompt:** Windows has no screen-capture permission, so the permission status is
  always granted and the employee-facing text says so ("Screen capture needs no permission on
  Windows; your organisation's notice explains what is captured"). The in-app notice and the
  always-visible capture state are the only disclosure; HR/Legal should confirm that is
  sufficient (P6-03).
- **DPI:** captures are in physical pixels because the process is per-monitor DPI aware v2: tao
  0.37 (`EventLoop::new`, `dpi_aware` defaults to true and Tauri does not change it) calls
  `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` before `setup()` starts the screenshot
  worker. No manifest or `main.rs` change is needed. (Test binaries are not DPI aware, so CI
  smoke tests may see scaled sizes; they only assert non-zero sizes.)
- **Locked / secure desktop:** skipped with the same rule as macOS
  (`!session_events::observable_now()`, which uses the Windows lock/console checks: input desktop
  not "Default" = locked or UAC/Ctrl+Alt+Del; session not on the console; sleep). If BitBlt still
  fails (desktop switched mid-capture, display removed), the interval ends with an error status and
  the next interval retries; nothing panics.
- **Protected content:** DRM video and windows marked `WDA_EXCLUDEFROMCAPTURE`/`WDA_MONITOR` may
  appear black. This is expected and not worked around.
- **Free disk check:** `GetDiskFreeSpaceExW` on the screenshot directory.

Manual checks still needed on Windows 10/11: capture at 100 %, 150 % and 200 % scaling (full
physical resolution, correct aspect); multi-monitor with the primary on the right/left/second
(only the primary is captured); lock (Win+L) and a UAC prompt at capture time (skipped, no black
frame kept); unplugging/changing the primary display between captures (error then recovery);
blur on/off and masks at the expected positions.

## Permissions

None beyond a normal user account: no administrator rights, no accessibility or input
permissions. The app must stay visible (window or tray icon) while monitoring.

## Required APIs (Rust `windows` crate features)

`Win32_UI_WindowsAndMessaging` (GetForegroundWindow, GetWindowThreadProcessId, EnumChildWindows),
`Win32_System_Threading` (OpenProcess, QueryFullProcessImageNameW),
`Win32_UI_Input_KeyboardAndMouse` (GetLastInputInfo), `Win32_System_SystemInformation`
(GetTickCount), `Win32_System_StationsAndDesktops` (OpenInputDesktop,
GetUserObjectInformationW), `Win32_Storage_FileSystem` (version info),
`Win32_System_WindowsProgramming` (QueryUnbiasedInterruptTime), `Win32_Foundation`.

## Packaging prerequisites

- Windows 10 (21H2+) or 11; x64 first, ARM64 later.
- Build machine: Rust stable with the `x86_64-pc-windows-msvc` target, Visual Studio Build
  Tools (MSVC + Windows SDK), Node.js ≥ 24.7, pnpm.
- WebView2 runtime: see "Installer" under "App shell" below.
- Installer: Tauri NSIS (per-user, no admin) or MSI (WiX) for managed deployment via Intune.
- Code signing: see docs/deployment.md "Windows signing and SmartScreen".
- Credentials: Windows Credential Manager via `keyring` (`windows-native`), already in Cargo.toml
  but **untested**.
- Data: `%LOCALAPPDATA%\com.insightworkfolio.desktop\` (queue `attendance-queue.db`, `screenshots\`;
  local, never roaming). Prefs: `%APPDATA%\com.insightworkfolio.desktop\prefs.json`.
- API URL: same as macOS, `WORKFOLIO_API_URL=https://… pnpm --filter @workfolio/desktop package`
  (docs/deployment.md "Desktop API URL"). The release CSP keeps `http://ipc.localhost` (Windows
  IPC); the API's `CORS_ORIGINS` needs `http://tauri.localhost`. **Untested on Windows.**

## App shell: tray, single instance, startup, installer

Code: `src-tauri/src/tray.rs`, `prefs.rs`, `lib.rs`, `tauri.conf.json` `bundle.windows`. Compiled
and linted for `x86_64-pc-windows-gnu` on macOS; **never run on Windows**.

**Tray (notification area).**
- Icon `icons/tray-windows.png` (32×32, made by `scripts/tray-icon.py … windows`): a white clock
  with a dark outline, legible on light and dark taskbars. Windows does not tint tray icons, so
  the black macOS template glyph is not used. New icons first land in the taskbar overflow (^);
  the employee can drag it out (Settings › Personalization › Taskbar › Other system tray icons).
- Windows has no tray title text, so the elapsed time is in the **tooltip**: "Working · 2:14", or
  "Working · 2:14:05" with *Show seconds*. Cut to 127 characters (the tooltip buffer).
- **Left click** shows and focuses the window. **Right click** opens the menu: status, monitoring
  line, *Open Insight Workfolio*, *Exit Insight Workfolio*.
- **Close button / Alt+F4** hide the window to the tray (like macOS). The app is exited only from
  the tray menu's *Exit Insight Workfolio*. While clocked in (working, on a break, or offline or
  needing attention with the timer running) a warning box asks first: "Exit Insight Workfolio?
  Exiting stops activity and screenshot recording until you open the app again." (OK exits,
  Cancel keeps it running). Signing out of Windows or shutting down exits without asking.

**Single instance.** `tauri-plugin-single-instance` (Windows only). While the app is built,
before any worker starts, it creates the named mutex `com.insightworkfolio.desktop-sim` (per
Windows session, so another signed-in user on the same PC runs their own copy). A second launch
(Start menu, desktop shortcut, Run key) finds the first copy's message window, grants it the
foreground, sends it its arguments and exits; the first copy shows and focuses its window. Chosen
over FindWindowW + ShowWindow from the second process because tao only tracks visibility it set
itself, so a window shown from outside would fail to hide on the next close.

**Preferences.**
- *Hide from taskbar* (pref key `hideDockIcon`): removes the taskbar button; the tray icon stays,
  so the app is always visible somewhere. Applied at start and immediately on change.
- *Open at sign-in* (`launchAtLogin`): `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, value
  `Insight Workfolio` = the quoted exe path (`"C:\Users\…\AppData\Local\Insight Workfolio\<app>.exe"`).
  Per user, no admin, no scheduled task or service. Visible and switchable in **Task Manager ›
  Startup apps** and Settings › Apps › Startup. The app reads the live state every time: on only
  if the value points at this exe *and* Task Manager has not disabled it
  (`…\Explorer\StartupApproved\Run`). Turning it on in the app clears a Task Manager "Disabled".
  The value name equals the product name, which is what the Tauri uninstaller removes.
- `prefs.json` is in `%APPDATA%` (roaming profile folder; it holds only two booleans). Its ACL is
  the default per-user profile ACL (the user, SYSTEM, Administrators); no extra ACL is set.

**Data directory.** `%LOCALAPPDATA%\com.insightworkfolio.desktop` (Tauri `app_local_data_dir`):
queue, activity, screenshots. Never Roaming AppData: screenshots and the queue must not follow a
roaming profile to other PCs. Default per-user profile ACL; the unix `0700` has no Windows
equivalent applied. On macOS `app_local_data_dir` and `app_data_dir` are the same folder (dirs 7.0
`src/mac.rs:12-13`, both `~/Library/Application Support`; Tauri `src/path/desktop.rs:251-271`, no
`appDirectoriesOverride` configured), so existing macOS queues did not move.

**Installer** (`bundle.windows`).
- NSIS, `installMode: "currentUser"`: installs to `%LOCALAPPDATA%\Insight Workfolio` without admin,
  uninstall entry under HKCU. English only, no language selector.
- WebView2: `downloadBootstrapper` (default; small installer, needs internet when WebView2 is
  missing, which is rare: Windows 11 and updated Windows 10 ship it). Alternatives:
  `embedBootstrapper` (+1.8 MB, still needs internet), `offlineInstaller` (+127 MB, no internet;
  use for air-gapped sites), `fixedRuntime` (+180 MB, pinned version, the company updates it).
  Enterprise: WebView2 can be deployed and its updates controlled by Group Policy / Intune
  (Microsoft Edge WebView2 policies); do not block the Evergreen runtime's updates without a plan.
- WebView2 missing at launch (removed after install, or a copied exe): before building the Tauri app,
  `win::webview2::ensure` checks `tauri::webview_version()`; on failure it shows a message box with
  the download page (https://developer.microsoft.com/microsoft-edge/webview2/) and exits cleanly
  instead of the silent abort. Windows runtime **not verified**.
- MSI (WiX): `targets: "all"` also builds an MSI on a Windows build machine (WiX is fetched by the
  Tauri CLI). The Tauri MSI installs per machine (admin), which suits Intune/GPO deployment. Build
  only what you ship: `pnpm package -- --bundles nsis` (or `msi`).
- Upgrade: running the new installer over the old one keeps data (only the program folder is
  replaced). If the app is running the installer offers to close it ("Click OK to kill it"); a
  killed app does not close its activity interval cleanly, so the next start shows the usual
  crash-recovery notice. Downgrades are allowed by default (`allowDowngrades`).
- Uninstall: Settings › Apps › Installed apps › Insight Workfolio › Uninstall. Removes the program
  and the Run value. Data stays unless *Delete the application data* is ticked, which removes
  `%APPDATA%\com.insightworkfolio.desktop` and `%LOCALAPPDATA%\com.insightworkfolio.desktop`. Manual
  cleanup otherwise: delete those two folders and, in Credential Manager › Windows Credentials,
  the entries for `com.insightworkfolio.desktop` (refresh token, installation id). Unsent data in the
  queue is lost: sync (stay online, clocked out) before uninstalling.
- Cross-build proof on macOS: `cargo build --release --target x86_64-pc-windows-gnu` links (see the
  phase report for size and imports). That GNU exe imports `WebView2Loader.dll` dynamically, so it
  proves linking only and is not a runnable deliverable. MSVC builds link the loader statically.
  The installer itself (NSIS `makensis`, MSVC target, signing) is built on a `windows-latest` CI
  runner (job `windows-desktop`, unsigned test artifact).
- Screenshot files: after the atomic rename, the directory is fsynced only on unix. Windows can't
  open a directory with `File::open` or flush it, and NTFS journals the rename.

### Shell checks on Windows (manual, not yet run)

1. Install the NSIS setup as a standard (non-admin) user: no UAC prompt; app in Start menu.
2. Tray icon visible on a light and a dark taskbar (Settings › Personalization › Colors).
3. Left click opens/focuses the window; right click shows the menu; tooltip shows the timer while
   clocked in, with seconds when *Show seconds* is on.
4. Close button and Alt+F4 hide to the tray; *Open Insight Workfolio* brings it back.
5. *Exit Insight Workfolio* while clocked in shows the warning box; Cancel keeps running, OK exits.
   Clocked out: exits without asking.
6. Launch again from the Start menu while running: the existing window comes to the front, no
   second tray icon, no second process in Task Manager.
7. *Hide from taskbar*: the taskbar button disappears and returns when turned off; survives restart.
8. *Open at sign-in*: `reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v "Insight Workfolio"`
   shows the quoted path; Task Manager › Startup apps lists it; disabling it there shows the
   preference off in the app; sign out and in: the app starts.
9. Uninstall with and without *Delete the application data*; the Run value is gone either way.
10. Upgrade: install a higher version over the running app; queue and prefs are kept.

## Verification checklist (on a Windows machine)

1. `pnpm install && pnpm build && pnpm test` and `cargo test` on Windows.
2. Sign-in, Credential Manager storage, device registration, offline attendance queue.
3. Foreground app: Win32 (Notepad, Chrome), Store app (Calculator), elevated app (Task Manager). **NOT RUN.**
   Expected: names from FileDescription ("Notepad", "Google Chrome"), identifiers = lowercased
   file names (e.g. `notepad.exe`), never paths; Task Manager (elevated) resolves normally. A protected process shows
   "Unknown app (protected)"; Calculator shows its own name and `calculatorapp.exe`, not "Application Frame Host".
4. Idle threshold and resume; `Win+L` lock/unlock; sleep and wake (including Modern Standby). **NOT RUN.**
   Expected:
   - `Win+L`: `[session] Locked` in the log; IDLE from the lock until unlock (no ACTIVE time, even while typing the password), then `[session] Unlocked` and ACTIVE again.
   - Hold one key for 30 s in Notepad: the app never shows "no input for …" and no IDLE is recorded.
   - Leave the PC for the threshold: "Idle since …" in the app, IDLE in the admin and employee dashboards within about a minute; touch the mouse: ACTIVE again within about a minute. Repeat with the window closed to the tray for 10+ minutes.
   - Windows Hello (face/fingerprint) unlock: the locked time stays IDLE.
   - Sleep (Start → Power → Sleep): `WillSleep`, then after wake `DidWake` (once or twice). The interval closes at sleep.
   - Fast user switch (Start → user icon → other user, then back): `SessionResigned`, then `SessionActive` and `Unlocked`.
   - UAC prompt (e.g. run an installer): IDLE while the prompt is up.
   - Elevated app in front (Task Manager): ACTIVE with its name.
   - Remote Desktop into the same account: observed. Disconnect: not observed.
4a. Background throttling. **NOT RUN.** Task Manager → Details → right-click a column header →
   Select columns → enable "Efficiency mode" (Windows 11). While clocked in and recording, the
   app's process (`insight-workfolio-desktop.exe`) must not show Efficiency mode, even with the
   window hidden. After clocking out it returns to the system default. The PC still sleeps on
   its normal timer while recording (`powercfg /requests` lists nothing from the app).
4b. `cargo test` on Windows runs the `#[cfg(windows)]` smoke tests. **NOT RUN.**
   - `win::activity::tests::native_samples_are_sane`
   - `win::session::tests::{constants_match_windows_sys, notification_thread_starts_and_stops_cleanly}`
   - `power::tests::windows_*`
5. Break, clock-out, crash (Task Manager → End task) and restart recovery.
6. The same checks as `verify:native` (port the script's prompts; the server-side checks are
   platform-independent).
