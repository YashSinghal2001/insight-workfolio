# Windows runtime test checklist (physical PC)

For a person with a physical **Windows 10 (21H2+) or 11, x64** PC. Every row is a runtime check that has never been
performed: no Windows hardware has been available, so every Result is **BLOCKED**. Allowed statuses: PASS, PARTIAL,
FAIL, MISSING, BLOCKED, NOT TESTED, NOT RUN. A build or CI result never counts as PASS here.
Feature IDs refer to `docs/qa/WINDOWS-FEATURE-INVENTORY.md`.

## Setup (once)

- A **non-production API** (local or staging) and a dashboard pointing at it. Never the production server for rows S*.
- Two test employees ("TEST Windows A", "TEST Windows B"), each with its own setup link. Default policy: activity on, screenshots **off**.
- Installer built for that API: `WORKFOLIO_API_URL=<non-prod https URL> pnpm --filter @workfolio/desktop package -- --bundles nsis` on Windows, or the CI `workflow_dispatch` with `desktop_api_url`. **As of 2026-11-13 the CI route is broken**: the Windows job fails in the privacy-guard tests and skips the installer (remediation item 1).
- **Logs:** release builds have no console and no log file (inventory D4). Start the app from `cmd` as
  `"%LOCALAPPDATA%\Insight Workfolio\insight-workfolio-desktop.exe" 2> "%TEMP%\wf.log"` and read `wf.log`; if that file stays empty, record the log steps as BLOCKED and use a debug build.
- Default timings: sample every 15 s, idle threshold 300 s (shown as "Idle after" in the app). For speed, set the threshold to 60 s in the dashboard policy for the test employee.
- Where to look: **App** = the app window status card and Activity monitoring card; **Admin** = dashboard › Employees › the test employee (live activity column, day timeline, devices); **Self** = employee dashboard (live status, timeline).

## 1. Install, launch, sign-in (L)

| # | ID | Check | Steps | Expected | Observe in | Result |
|---|---|---|---|---|---|---|
| 1 | L01 | Per-user install | Run `Insight Workfolio_0.1.0_x64-setup.exe` as a standard user; SmartScreen › More info › Run anyway | No UAC prompt; installs to `%LOCALAPPDATA%\Insight Workfolio`; Start-menu entry | Explorer; Settings › Apps › Installed apps | BLOCKED |
| 2 | L02 | WebView2 present/bootstrapped | On a PC without WebView2 (VM), install with internet | Installer downloads WebView2 and completes | Installer UI; Apps list "Microsoft Edge WebView2 Runtime" | BLOCKED |
| 3 | L03 | WebView2 missing at launch | Uninstall WebView2 in a VM, start the app | Message box naming the download page; app exits; no crash dialog | Screen | BLOCKED |
| 4 | L08 | First launch | Start from Start menu | Window opens, sign-in screen, no configuration error; tray icon appears (maybe in overflow ^) | App; notification area | BLOCKED |
| 5 | L04 | Tray icon legibility | Switch Settings › Personalization › Colors light/dark | Icon readable on both | Taskbar | BLOCKED |
| 6 | L09 | Sign in | Sign in as TEST Windows A; then try a wrong password | Accepted, name and code shown; wrong password refused | App | BLOCKED |
| 7 | L10, X01 | Credential Manager storage | Control Panel › Credential Manager › Windows Credentials, or `cmdkey /list` | Generic credentials `refresh-token.com.insightworkfolio.desktop` and `installation-id.com.insightworkfolio.desktop`; no token in `%LOCALAPPDATA%`/`%APPDATA%` files (search for it) | Credential Manager; `findstr /s` | BLOCKED |
| 8 | L10 | Session persists | Exit from tray, start again | Still signed in, no password | App | BLOCKED |
| 9 | L11 | Device registration | After sign-in, register device (default name "My PC") | Device listed with platform Windows | Admin › Devices | BLOCKED |
| 10 | L11, X01 | Roaming-profile check (only if the domain uses roaming profiles) | Sign in to a second domain PC as the same Windows user; open the app | Record whether `installation-id.*` already exists there (inventory D1) | `cmdkey /list` on PC 2 | BLOCKED |
| 11 | L09 | Sign out | Sign out in the app | Credential entries removed; sign-in screen | Credential Manager; App | BLOCKED |

## 2. Shell, startup, background (L)

| # | ID | Check | Steps | Expected | Observe in | Result |
|---|---|---|---|---|---|---|
| 12 | L14 | Tray clicks | Left click tray icon; right click it | Left: window shows and focuses. Right: menu with status, monitoring line, Open, Exit | Screen | BLOCKED |
| 13 | L15 | Tooltip timer | Clock in; hover the tray icon; turn on "Show seconds in the tray tooltip" | "Working · h:mm", then "h:mm:ss" | Tooltip | BLOCKED |
| 14 | L16 | Close keeps running | Close button, then Alt+F4 on reopened window | Window hides; first time a notice explains the tray; process still in Task Manager | Task Manager › Details | BLOCKED |
| 15 | L18 | Exit while clocked in | Tray › Exit Insight Workfolio while working; Cancel; then OK | Warning box; Cancel keeps running; OK exits. Clocked out: exits without asking | Screen; Task Manager | BLOCKED |
| 16 | L13 | Single instance | With app running (window hidden), start it again from Start menu | Existing window comes to front; one process, one tray icon | Task Manager; tray | BLOCKED |
| 17 | L17 | Hide taskbar button | Toggle "Hide the taskbar button"; restart app | Button disappears/returns; setting survives restart | Taskbar | BLOCKED |
| 18 | L12 | Open at sign-in | Turn on; `reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v "Insight Workfolio"`; disable in Task Manager › Startup apps; reopen prefs; sign out and in with it enabled | Quoted exe path; listed in Startup apps; app shows off after Task Manager disable; app starts at sign-in | Registry; Task Manager; App | BLOCKED |
| 19 | L20 | EcoQoS opt-out | Task Manager › Details › add "Efficiency mode" column; clock in, hide window 10 min; clock out | Main process not in efficiency mode while recording; default after clock-out. Also record the state of the `msedgewebview2.exe` children (inventory D3) | Task Manager | BLOCKED |
| 20 | L20 | Sleep not blocked | While recording run `powercfg /requests` | Nothing listed for the app; PC sleeps on its timer | cmd | BLOCKED |
| 21 | L21, N10 | Hidden-window timers | Clock in, hide to tray for 15 min while active; note live state and upload times | Live state stays current (< 3 min old) and intervals upload while hidden | Admin live column; API log timestamps | BLOCKED |
| 22 | L19 | Windows shutdown/sign-out while clocked in | Clock in; sign out of Windows; sign in, open app | Either a clean close or one recovery notice; no duplicate or overlapping intervals | App; Admin timeline | BLOCKED |
| 23 | N11 | Notifications | Make uploads fail (stop the API) while clocked in | One Windows toast "Insight Workfolio …"; none repeated | Action Center | BLOCKED |

## 3. Activity and idle (A)

| # | ID | Check | Steps | Expected | Observe in | Result |
|---|---|---|---|---|---|---|
| 24 | A10 | Foreground app | Clock in; use Notepad, Chrome, Task Manager (elevated) 1 min each | Names "Notepad", "Google Chrome", "Task Manager"; identifiers `notepad.exe`, `chrome.exe`, `taskmgr.exe`; never paths | App current app; Admin activity | BLOCKED |
| 25 | A11 | UWP app | Use Calculator 1 min | "Calculator"/`calculatorapp.exe`, not Application Frame Host | Admin activity | BLOCKED |
| 26 | A12 | Protected process | Focus a protected process window if available (e.g. some AV UI) | "Unknown app (protected)", ACTIVE | Admin activity | BLOCKED |
| 27 | A02 | Keyboard input | Leave idle until "no input for …" shows ~30 s; press one key | Counter drops to 0 at next poll (≤5 s) | App Activity card | BLOCKED |
| 28 | A02 | Mouse move | Same, move mouse only | Counter resets | App | BLOCKED |
| 29 | A02 | Click / wheel | Same, click only; then wheel only | Counter resets each time | App | BLOCKED |
| 30 | A03 | Repeated key | Press a key every 10 s for 3 × threshold | Never IDLE | App; Admin timeline | BLOCKED |
| 31 | A04 | Held key | In Notepad hold one key for longer than the threshold (Filter Keys off) | Counter stays near 0; no IDLE recorded. Repeat with Filter Keys on and record result | App; Admin timeline | BLOCKED |
| 32 | A07 | Idle transition | No input for threshold + 1 min | App "Idle since <last input>"; IDLE row starting at last input | App; Admin/Self timeline | BLOCKED |
| 33 | A07 | Active transition | After 32, move mouse | ACTIVE within one sample (≤15 s) in app; IDLE ends at the input | App; timeline | BLOCKED |
| 34 | A09 | Live state on dashboard | During 32 and 33 | Admin live column IDLE within ~1 min, ACTIVE within ~1 min; never UNKNOWN while app runs | Admin | BLOCKED |
| 35 | A09 | Live state with window hidden | Repeat 32–34 with window hidden ≥10 min | Same timings as 34 | Admin | BLOCKED |
| 36 | A05 | Injected input (documented limitation) | Run a software mouse jiggler (e.g. PowerShell `SendInput`) only in the test VM for threshold + 1 min | Record result. Expected per code: stays ACTIVE (injected input counts; no hooks by decision) | App; timeline | BLOCKED |
| 37 | A06 | Threshold shown | Change policy threshold in dashboard; wait 1 min | "Idle after" updates; new threshold applies | App | BLOCKED |
| 38 | A08 | Idle-excluded app | Add `notepad.exe` to the exclusion list; leave Notepad in front with no input past threshold | No IDLE while Notepad in front | Timeline | BLOCKED |
| 39 | A13–A15 | Lock / unlock (Win+L) | Active; Win+L; wait 2 min; type password; unlock | Log `[session] Locked`/`Unlocked`; IDLE from the lock to unlock; ACTIVE only after unlock | App; timeline; log | BLOCKED |
| 40 | A15 | Windows Hello unlock | Lock, wait 1 min, face/fingerprint unlock | Locked time IDLE | Timeline | BLOCKED |
| 41 | A16 | UAC prompt | Start an elevated installer; leave the prompt 30 s; Cancel | ~30 s IDLE (secure desktop counts as locked) | Timeline | BLOCKED |
| 42 | A16 | Ctrl+Alt+Del screen | Open it 30 s, Cancel | IDLE for that time | Timeline | BLOCKED |
| 43 | A17 | Sleep / wake (S3) | Start › Power › Sleep, 3 min, wake, unlock | Log WillSleep, DidWake; no ACTIVE/IDLE across the sleep; gap shown; resumes after unlock | App gap note; timeline; Event Viewer › System Kernel-Power 42/107 | BLOCKED |
| 44 | A18 | Modern Standby | On an S0ix laptop (`powercfg /a` shows "Standby (S0 Low Power Idle)"), press power button, 5 min, resume | Same as 43; record whether WillSleep/DidWake appear | Log; timeline; Event Viewer | BLOCKED |
| 45 | A19 | Display off (activity) | Set "turn off screen" 1 min, no lock; wait 3 min | Activity becomes IDLE by threshold only; log `ScreensSlept`/`ScreensWoke` | Log; timeline | BLOCKED |
| 46 | A20 | Fast user switch | Switch to another Windows user 2 min, back | `SessionResigned`, then `SessionActive`; nothing recorded while away | Log; timeline | BLOCKED |
| 47 | A20 | RDP | RDP into the same account from another PC, work 2 min; disconnect 2 min | Observed while connected; nothing recorded while disconnected | Timeline | BLOCKED |
| 48 | A21 | Clock change | Settings › Time: turn off auto time, move clock +1 h, back | Interval closed at change; no hour of fake activity | Timeline | BLOCKED |
| 49 | A22 | Crash recovery | Task Manager › End task while clocked in; reopen | Recovery notice once; no overlap | App; timeline | BLOCKED |

## 4. Attendance and sync (A, N)

| # | ID | Check | Steps | Expected | Observe in | Result |
|---|---|---|---|---|---|---|
| 50 | A23 | Clock in / out | Clock in, work 5 min, clock out | State "Working" then "Clocked out"; attendance on dashboard within 1 min; nothing pending | App; Admin attendance | BLOCKED |
| 51 | A24 | Break | Start break 3 min, end | Break shown; no activity during it; tray "On break" | App; timeline | BLOCKED |
| 52 | N06 | Offline queue | Wi-Fi off; clock out/in; work 2 min; Wi-Fi on | App shows offline, then syncs; events keep original times; none rejected | App; Admin | BLOCKED |
| 53 | N08 | Token refresh | Keep app running past access-token expiry | Calls continue without sign-in | App; API log | BLOCKED |
| 54 | N09 | Device revocation | Admin revokes the device | App stops syncing and says so; no retry storm | App; API log | BLOCKED |
| 55 | N02, N04 | CORS / TLS | Use the https non-prod API | No CORS or certificate error | App; WebView2 devtools (debug build) | BLOCKED |
| 56 | N05 | System proxy | Configure a corporate proxy/PAC | App reaches API through it | App | BLOCKED |
| 57 | — | Second device refused | Sign TEST Windows A in on a second PC | "Another device is already registered" | App | BLOCKED |
| 58 | A09 | Unknown after exit | Exit app while clocked in; wait 3 min | Admin shows Unknown within 3 min | Admin | BLOCKED |

## 5. Screenshots — isolated, authorised test only (S)

Precondition for every row: non-production API; screenshot policy enabled **only** for TEST Windows B; notice text marked as test; tester is the employee and has agreed in writing; no other person's screen or data visible.

| # | ID | Check | Steps | Expected | Observe in | Result |
|---|---|---|---|---|---|---|
| 59 | S12 | Gating before consent | Enable policy; do not acknowledge notice | "Awaiting consent"; no capture | App screenshot card | BLOCKED |
| 60 | S03 | No permission prompt | Acknowledge notice | No OS prompt; permission row says Windows doesn't ask; no request button | App | BLOCKED |
| 61 | S01, S05 | Capture at interval | Interval 60 s, wait 3 min | One capture per interval; "last capture" size = primary monitor physical pixels (or max dimension) | App | BLOCKED |
| 62 | S06 | Masks and blur | Set a mask and blur on; capture | Mask black at expected position; blur applied | Admin gallery | BLOCKED |
| 63 | S09 | Upload and retrieval | Wait for upload | Stored; viewable in Admin gallery and Self "My screenshots"; local copy removed after 24 h | Admin; Self; `%LOCALAPPDATA%\com.insightworkfolio.desktop\screenshots` | BLOCKED |
| 64 | S14 | DPI | Repeat 61 at 100 %, 150 %, 200 % scaling | Full resolution, correct aspect, no cropping | Gallery | BLOCKED |
| 65 | S02 | Multi-monitor | Two monitors, primary right/left | Only primary captured | Gallery | BLOCKED |
| 66 | S15 | HDR | Turn on HDR (Settings › Display) | Record image quality (washed out / clipped?) | Gallery | BLOCKED |
| 67 | S16 | Protected content | Play DRM video in Edge | Black area acceptable | Gallery | BLOCKED |
| 68 | S10 | Lock / UAC at capture time | Win+L across a due capture; then UAC prompt across a due capture | "Not taken: the screen was locked"; no frame kept | App; gallery | BLOCKED |
| 69 | S11 | Display off, not locked | Screen-off 1 min without lock; wait 3 min | "Not taken: the display was asleep" | App | BLOCKED |
| 70 | S10 | Sleep / user switch | Sleep and fast user switch across a due capture | No capture; no catch-up burst after | App; gallery | BLOCKED |
| 71 | S13 | Capture failure reported | Change/unplug primary display between captures | "Capture failed" shown, report CAPTURE_FAILED, next interval recovers | App; Admin screenshot state badge | BLOCKED |
| 72 | S12 | Policy off / break / clock-out | Turn policy off; also break and clock-out | No capture in each case | App; gallery | BLOCKED |
| 73 | S07 | Local cap / disk | (Optional, VM) fill disk to < 1 GB free | "Paused: less than 1 GB free" | App | BLOCKED |
| 74 | X04 | File permissions | `icacls "%LOCALAPPDATA%\com.insightworkfolio.desktop"` | Only user, SYSTEM, Administrators | cmd | BLOCKED |

## 6. Uninstall and upgrade (L)

| # | ID | Check | Steps | Expected | Observe in | Result |
|---|---|---|---|---|---|---|
| 75 | L07 | Upgrade | Install a higher version over the running app | App closed by installer; data and prefs kept; one recovery notice at most | App | BLOCKED |
| 76 | L06 | Uninstall, keep data | Settings › Apps › Uninstall, box unticked | Program and Run value gone; data folders remain | Explorer; `reg query` | BLOCKED |
| 77 | L06 | Uninstall, delete data | Reinstall, uninstall with "Delete the application data" | `%APPDATA%` and `%LOCALAPPDATA%` `com.insightworkfolio.desktop` removed. Record whether Credential Manager entries and `…\StartupApproved\Run` value remain (expected: they remain, inventory D9) | Explorer; Credential Manager; regedit | BLOCKED |

## Summary

| Section | Rows | PASS | FAIL | BLOCKED |
|---|---|---|---|---|
| 1 Install/sign-in | 11 | 0 | 0 | 11 |
| 2 Shell/background | 12 | 0 | 0 | 12 |
| 3 Activity/idle | 26 | 0 | 0 | 26 |
| 4 Attendance/sync | 9 | 0 | 0 | 9 |
| 5 Screenshots | 16 | 0 | 0 | 16 |
| 6 Uninstall | 3 | 0 | 0 | 3 |
| **Total** | **77** | **0** | **0** | **77** |
