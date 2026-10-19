# Windows activity collector: plan (not implemented)

**Status (Day 6):** not implemented and not compiled for Windows. This repository was developed
on macOS only; no Windows machine or `x86_64-pc-windows-msvc` toolchain was available. On
Windows the app compiles a stub (`activity::platform` with `SUPPORTED = false`): it records
attendance only and tells the employee that activity collection is not available. **No Windows
compatibility is claimed** for any part of the desktop app until it is built and tested there.

The Windows collector must produce exactly the same `Sample` as macOS (foreground app name +
identifier, milliseconds since last input, screen locked) so the tracker, queue, sync and
server rules are unchanged. Only `activity::platform` gets a Windows `imp` module.

## Foreground application

1. `GetForegroundWindow()` → `HWND` (null while switching or on the secure desktop: no app).
2. `GetWindowThreadProcessId(hwnd)` → process ID.
3. `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)` and
   `QueryFullProcessImageNameW` → executable path. Works for elevated processes from a normal
   user process; protected processes fail → record "Unknown application" rather than nothing.
4. **Identifier:** the executable file name only (e.g. `chrome.exe`), never the full path (it can
   contain the user name or a project folder name).
5. **Name:** `FileDescription` from the executable's version resource (`GetFileVersionInfoSizeW`,
   `GetFileVersionInfoW`, `VerQueryValueW`), falling back to the file name without `.exe`.
6. **Store/UWP apps:** the foreground window belongs to `ApplicationFrameHost.exe`; resolve the
   hosted app via its child `Windows.UI.Core.CoreWindow` (`EnumChildWindows` + process ID) or
   `GetApplicationUserModelId`, and use the AUMID as the identifier.
7. **Never** call `GetWindowTextW` / `WM_GETTEXT` (window titles), read command lines, or open
   documents.

## Idle detection

- `GetLastInputInfo` (`LASTINPUTINFO.dwTime`, a 32-bit tick count of the last input in this
  session) compared with `GetTickCount()` using wrapping subtraction (the tick count wraps every
  49.7 days). A counter only: no keyboard/mouse hooks (`SetWindowsHookEx` is never used), no
  raw input registration, no input contents.
- Known limitation: some remote-desktop and accessibility tools and game controllers update or
  do not update this counter; verify on the pilot hardware.

## Screen lock

- Polling (same model as macOS): `OpenInputDesktop` + `GetUserObjectInformationW(UOI_NAME)`.
  The input desktop is `Default` when unlocked and `Winlogon` (or access is denied) while
  locked or on the secure desktop (UAC prompt) → counted as idle.
- Alternative if polling proves unreliable: `WTSRegisterSessionNotification` and
  `WM_WTSSESSION_CHANGE` (`WTS_SESSION_LOCK` / `WTS_SESSION_UNLOCK`) on a message-only window.

## Sleep / wake and clock changes

- The tracker detects sleep by comparing the wall clock with a clock that **stops during
  sleep**. On macOS Rust's `Instant` does; on Windows `Instant` (QueryPerformanceCounter) must
  not be assumed to. Use `QueryUnbiasedInterruptTime` (excludes sleep and hibernation) for
  `Sample::mono_ms` on Windows, and verify on hardware with Modern Standby (S0ix), where the
  machine may keep running briefly while "asleep".
- Optional signal: `WM_POWERBROADCAST` (`PBT_APMSUSPEND`, `PBT_APMRESUMEAUTOMATIC`).
- Wall-clock changes are detected the same way as on macOS (wall vs monotonic divergence).

## Screenshots (Day 7: macOS only)

Not implemented on Windows; the stub reports `supported: false` and the app says screenshots
are not available. Plan: Windows.Graphics.Capture (`GraphicsCaptureItem` for the primary
monitor via `MonitorFromPoint(0,0)` + `IGraphicsCaptureItemInterop::CreateForMonitor`, Windows 10
1903+; shows the system capture border on 11), or `BitBlt` from the primary monitor's DC as a
fallback. Skip while the secure desktop is active (locked or UAC) and on sleep exactly as on
macOS. The same `Os` trait (`screenshot.rs`) is implemented; encoding, queue, upload and server
rules are shared. There is no OS-level permission prompt on Windows, so the in-app notice and
indicator are the only disclosure; HR/Legal should confirm that is sufficient.

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
- WebView2 runtime (preinstalled on Windows 11; the Tauri installer can bundle the evergreen
  bootstrapper for Windows 10).
- Installer: Tauri NSIS (per-user, no admin) or MSI (WiX) for managed deployment via Intune.
- Code signing: OV/EV certificate with timestamping to avoid SmartScreen warnings (Day 9).
- Credentials: Windows Credential Manager via `keyring` (`windows-native`), already in Cargo.toml
  but **untested**.
- Data: `%APPDATA%\com.insightworkfolio.desktop\attendance-queue.db` (per user).

## Verification checklist (on a Windows machine)

1. `pnpm install && pnpm build && pnpm test` and `cargo test` on Windows.
2. Sign-in, Credential Manager storage, device registration, offline attendance queue.
3. Foreground app: Win32 (Notepad, Chrome), Store app (Calculator), elevated app (Task Manager).
4. Idle threshold and resume; `Win+L` lock/unlock; sleep and wake (including Modern Standby).
5. Break, clock-out, crash (Task Manager → End task) and restart recovery.
6. The same checks as `verify:native` (port the script's prompts; the server-side checks are
   platform-independent).
