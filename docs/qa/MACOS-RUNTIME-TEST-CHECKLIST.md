# macOS runtime test checklist (after commit 4d66269)

Date: 2026-11-13. For a person at a Mac. Feature IDs refer to `docs/qa/MACOS-FEATURE-INVENTORY.md`. Every Result is NOT RUN: nothing below has been run on the current build. Allowed results: PASS, PARTIAL, FAIL, MISSING, BLOCKED, NOT TESTED, NOT RUN.

Use a test Mac or a separate macOS user account, a throwaway or test API, and a test employee (one active device per employee). Production defaults: sample 15 s, idle threshold 300 s; the verify scripts use dev values (5 s / 30 s).

"Automated by" names the verify script step that covers the row. "Partly" means the script observes it but does not check everything in the Expected column.

## 1. Lifecycle and shell

| # | Check | Features | Steps | Expected | Automated by | Result |
|---|---|---|---|---|---|---|
| 1 | Install and first start | L1, L2, L5 | Install the build (`.dmg`), open it; accept the Gatekeeper warning (unsigned) | App opens; data dir `~/Library/Application Support/<id>` is mode 0700 | none | NOT RUN |
| 2 | Sign in and Keychain | L8, X1, U2 | Sign in as the test employee; answer any Keychain prompt | Signed-in view; refresh token in Keychain only (Keychain Access shows item `refresh-token` under the bundle id) | verify-native, verify-screenshots (partly) | NOT RUN |
| 3 | Device registration | L11, X2, N10 | Register "My Mac"; then sign in the same employee on a second device | First registers; second shows "Another device is already registered…" | verify-native (first part only) | NOT RUN |
| 4 | Session restore | L9 | Quit, reopen online; then quit, disconnect network, reopen | Online: signed in without password. Offline: "Offline mode", cached identity, attendance buttons work (queued) | none on this build (verify-tasks-packaged did on 2026-10-30) | NOT RUN |
| 5 | Close hides, menu bar stays | L13, U5 | Close the window | Window hides, menu-bar item stays, one-time notice when reopened from the menu bar | none | NOT RUN |
| 6 | Menu-bar item | U5, U4 | Clock in; open the menu-bar menu; turn on "Show seconds" | Title shows elapsed `h:mm` (then `h:mm:ss`); menu shows status, monitoring line, Open, Quit | none | NOT RUN |
| 7 | Quit confirmation | L14, L15 | While clocked in: menu-bar Quit, then Cmd+Q, then Dock › Quit | Menu-bar Quit and Cmd+Q ask first; Cancel keeps running. Dock › Quit: record whether it asks (code suggests it does not, inventory G4) | none | NOT RUN |
| 8 | Reopen / single instance | L6, L7 | With the app running (window hidden) open it again from Finder; click the Dock icon | Window shows; no second process (`pgrep -fl insight-workfolio`) | none | NOT RUN |
| 9 | Hide Dock icon | L16, U10 | Settings › Hide the Dock icon on, then off | Dock icon and app menu disappear / come back; window stays usable from the menu bar | none | NOT RUN |
| 10 | Open at login | L12, U10 | Settings › Open at login on; approve in System Settings › Login Items if asked; log out and in | Listed in Login Items; app starts at login; not clocked in automatically | none | NOT RUN |
| 11 | Sign out | L10, X11 | With an unsynced event pending, Log out | Warning about unsynced events; login view; monitoring and screenshots stop; event uploads at next sign-in on this Mac | none | NOT RUN |
| 12 | App Nap opt-out | L17 | Clock in, hide window 10 min; then start a break | Samples stay on time while hidden; App Nap note shown while On, gone on break | verify-native step 5 (checks the flag only) | NOT RUN |

## 2. Activity

| # | Check | Features | Steps | Expected | Automated by | Result |
|---|---|---|---|---|---|---|
| 13 | Consent gate | A14, A21, X8 | Before acknowledging the notice, clock in | Monitoring "Off", nothing recorded; after acknowledging: "On" | verify-native (acknowledges; does not check the off state) | NOT RUN |
| 14 | App switching | A5, A6 | Use two or three apps for a minute | Each app recorded with name and bundle id, no overlaps | verify-native step 1 | NOT RUN |
| 15 | Idle after threshold (HID source) | A1, A3 | No input for threshold + 15 s | IDLE from the last input; dashboard live state IDLE with that start | verify-native step 2 (not the dashboard) | NOT RUN |
| 16 | Each input type ends idle | A1, A5 | While idle: move mouse; next time trackpad; next time a key | Each ends idle at the input | verify-native step 2 (one input only) | NOT RUN |
| 17 | Held key | A2 | While idle, hold one key down for 20 s without other input | Record whether idle ends and whether the counter keeps resetting while held (HID behaviour) | none | NOT RUN |
| 18 | Software input is not activity | A1 | Run a software mouse jiggler (posts CGEvents) for > threshold | Stays IDLE (HID-only source) | none | NOT RUN |
| 19 | Lock = IDLE | A8, A19 | Before the threshold, lock (Ctrl+Cmd+Q) for 60 s; unlock with password | IDLE from the lock to the unlock; ACTIVE resumes at the unlock, not at the password typing; live state IDLE while locked | verify-native step 3: its check expects NO idle while locked and will FAIL against this build (inventory G1) | NOT RUN |
| 20 | Touch ID / Apple Watch unlock | A8 | Lock, then unlock without typing | ACTIVE only from the unlock | none | NOT RUN |
| 21 | Sleep/wake | A9 | Apple menu › Sleep (or lid) ≥ 60 s; wake and unlock | Nothing recorded while asleep; gap notice shown; lock screen after wake counted IDLE | verify-native step 4 (gap and no intervals; not the post-wake IDLE) | NOT RUN |
| 22 | Display sleep without lock | A10, S10 | Turn off "require password"; sleep the display only (`pmset displaysleepnow`, run by the person) for 2 min | Activity: idle after threshold, no gap; screenshots: "Not taken: the display was asleep" | none | NOT RUN |
| 23 | Fast user switching | A11 | Switch to another account 60 s, switch back | Nothing recorded while away (no ACTIVE, no IDLE); live state UNOBSERVED | verify-native `--only=userswitch` | NOT RUN |
| 24 | Automatic foreground switch while idle | A5 | Hands off; another app comes to the front by itself | No active time for that app; idle from the last input | verify-native `--only=autoswitch` | NOT RUN |
| 25 | Clock change | A12 | While clocked in, change the system time by 10 min and back | Interval closes; gap notice; no overlap or negative interval | none | NOT RUN |
| 26 | Break and clock-out | A14, A15 | Start a break 2 min; end; clock out | Nothing recorded on break or after clock-out; uploads drain | verify-native steps 5-6 | NOT RUN |
| 27 | Idle threshold display | A4 | Change the org idle threshold on the dashboard; wait 1 min | Card shows the new value and "or as soon as the screen is locked" | none | NOT RUN |
| 28 | Live state on the dashboard | A19 | Watch the dashboard live view through ACTIVE → idle → lock → sleep → quit | ACTIVE, IDLE (since last input), IDLE (since lock), UNOBSERVED/none, UNKNOWN within 3 min of quit | none | NOT RUN |
| 29 | Crash recovery | L18 | While clocked in, `kill -9` the app; reopen | "The app closed unexpectedly…" notice; intervals kept up to the last checkpoint; no time while not running | none | NOT RUN |

## 3. Screenshots (enable screenshots for the test org; hide anything sensitive)

| # | Check | Features | Steps | Expected | Automated by | Result |
|---|---|---|---|---|---|---|
| 30 | Screenshot consent gate | S7 | Screenshots on, notice not acknowledged, clock in | "Awaiting consent", no capture | verify-screenshots (acknowledges; does not check the gate) | NOT RUN |
| 31 | Permission request | S3, S4 | Fresh install: click "Allow screen recording…" | macOS prompt once; after granting and relaunch: "Allowed" | verify-screenshots step 1 (asks the person) | NOT RUN |
| 32 | Permission denied | S5, S21 | Deny (or never grant) | "Needs permission", tray Needs attention, no capture; dashboard shows Permission denied | none | NOT RUN |
| 33 | Permission revoked while running | S3, S5 | Granted and capturing; turn it off in System Settings | Next tick: "Needs permission"; no capture; report PERMISSION_DENIED | none | NOT RUN |
| 34 | Capture at interval + upload | S1, S2, S6, S11, S16 | Clock in; wait one interval | One capture of the main display ≤ max size, WebP; "Last cloud" set after the API confirms; dashboard shows it | verify-screenshots steps 2 | NOT RUN |
| 35 | Multi-display | S2 | Two displays connected | Only the primary display is captured | none | NOT RUN |
| 36 | Masks and blur | S12, S13 | Add a mask; later turn blur on | Masked area black; blurred capture registered blurred | verify-screenshots step 5 (blur only) | NOT RUN |
| 37 | Break / clock-out | S7 | Break longer than the interval; clock out | No capture during break or after clock-out | verify-screenshots steps 3, 8 | NOT RUN |
| 38 | Lock | S9 | Lock for longer than the interval | No capture; "Not taken: the screen was locked." | verify-screenshots step 6 | NOT RUN |
| 39 | Sleep ≥ 60 s | S6, S9 | Sleep longer than the interval; wake | No capture during sleep or right at wake; next one interval after wake | verify-screenshots step 7 | NOT RUN |
| 40 | Capture failure is not latching | S20, S21 | No reliable way to force one on a real Mac; watch for any "Capture failed" during rows 34-39 | "Capture failed" pill and CAPTURE_FAILED report; next interval retries and clears it | none | NOT RUN |
| 41 | Offline queue and retry | S14, S16, S17 | Disconnect network for 3 intervals; reconnect | Captures kept locally, retrying count shown; all upload after reconnect, nothing lost | none | NOT RUN |
| 42 | Stale policy | S8 | Offline for more than 24 h (or clock forward on a test Mac) | Capture pauses with the "could not be checked … for over a day" reason | none | NOT RUN |
| 43 | Storage cap / low disk | S15 | Not practical on a real Mac; rely on Rust test | n/a | none | NOT RUN |
| 44 | Real storage provider | S18 | Test API with Microsoft Graph storage | Uploads STORED in OneDrive/SharePoint; label "Microsoft 365" | none | NOT RUN |

## 4. Sync, security and other tabs

| # | Check | Features | Steps | Expected | Automated by | Result |
|---|---|---|---|---|---|---|
| 45 | Offline attendance | N3, N4, N5, N6, N9 | Disconnect; clock in, break, clock out; reconnect | Offline banner; projection shown; events sync in order; nothing duplicated | none on this build | NOT RUN |
| 46 | Session expiry | N2 | Revoke the session on the server (or disable the account) | App signs out with the "session has ended" message; unsynced events kept | none | NOT RUN |
| 47 | Device revoked | N10 | Admin revokes the device while clocked in | Sync blocked, notification, "device was revoked" card; monitoring and screenshots stop | none | NOT RUN |
| 48 | OS notifications | U11 | Trigger sync blocked (row 47) | One macOS notification (record whether macOS asked for notification permission) | none | NOT RUN |
| 49 | Clock skew warning | N12 | Set the Mac clock 5 min off | Warning shown; server times correct | none | NOT RUN |
| 50 | History / export | U12, X9 | Download CSV and XLSX | Files only in Downloads, `(1)` on repeat | verify-export-packaged | NOT RUN |
| 51 | Leave, Tasks, Websites, My screenshots tabs in the packaged app | U14-U17 | Use each tab once in the installed app | Work as in the browser runs | verify-tasks-packaged, verify-websites-packaged (Leave and My screenshots: none) | NOT RUN |
| 52 | CSP against the real API | X5, X6 | Release build for the test API URL | All calls succeed; no CSP errors in Web Inspector | none | NOT RUN |
| 53 | Remote desktop | A1 | Use the Mac only through a remote-desktop tool for > threshold | Record whether it shows IDLE (expected with the HID source; owner decision) | none | NOT RUN |

## 5. What each verify script does to the machine

Common to all: needs the API built (`apps/api/dist`), starts a throwaway API on port 4000 with a temporary SQLite database (fails if 4000 is busy), creates synthetic admin and employee accounts there, and never contacts production or other external services.

| Script | Launches the app? | Builds? | Posts input? | Locks / sleeps the Mac? | Captures the screen? | Keychain / app data | Other |
|---|---|---|---|---|---|---|---|
| `verify-native.mjs` | Yes: debug binary `target/debug/insight-workfolio-desktop` with `WF_E2E_SCRIPT` | Yes: `cargo build` (debug) | No. `--only=autoswitch` runs `open -a Calculator` (app activation, no input events) | Asks the person to lock and to sleep; the script does neither itself | No (screenshots stay off) | Writes the test sign-in into the production keychain service (`com.insightworkfolio.desktop`) and leaves it there; reuses the existing installation ID; uses the same app-data dir and queue as the installed app; exits at once if the installed app is running | Records real foreground app names and idle times of this Mac into the temporary DB (temp dir not deleted). Also starts Vite on 1420 if free. Its "Screen lock" check is stale (expects no IDLE while locked) |
| `verify-screenshots.mjs` | Yes: same debug binary | Yes: `cargo build` | No | Asks the person to lock and to sleep | **Yes**: the real main display every 60 s for about 6+ minutes; files in the temp dir and in `~/Library/Application Support/com.insightworkfolio.desktop/screenshots`, deleted at the end unless `--keep`; decoded with `sips` | Same Keychain and app-data sharing as above | May show the Screen Recording prompt if the person clicks "Allow…" |
| `verify-my-screenshots.mjs` | No (headless Google Chrome + Vite front end) | No | No | No | No (synthetic canvases) | None (tokens in memory) | Needs Google Chrome; downloads go to its run dir |
| `verify-leave.mjs`, `verify-tasks.mjs` | No (headless Chrome) | No (needs a prior dashboard build) | No | No | No | None | Also starts the dashboard on 3102 |
| `verify-websites.mjs` | No (headless Chrome/Brave with the real extension) | No | No | No | No | None | Test sites on `*.test` mapped to 127.0.0.1 |
| `verify-export-packaged.mjs` | Yes: debug `.app` bundle (must be built first) | No | No | No | No | Replaces then clears the saved sign-in (production keychain service); may show a Keychain prompt | Downloads into the real `~/Downloads`, then moves the files to its output dir |
| `verify-tasks-packaged.mjs` | Yes: debug bundle, two launches | No | No | `--sleep` only: runs `pmset sleepnow` (**puts the Mac to sleep**) | No | Replaces then clears the saved sign-in | Stops and restarts its API; activity notice not acknowledged, so no activity recorded |
| `verify-websites-packaged.mjs` | Yes: debug bundle, two launches | No | No | `--sleep` only: `pmset sleepnow` | No | Replaces then clears the saved sign-in | Chrome with the extension; stops and restarts its API |

Before running any app-launching script on the owner's Mac: quit the installed Insight Workfolio, expect its saved sign-in to be replaced (sign in again afterwards), and do not run it while Agent 4 (or anyone) is running cargo in `apps/desktop/src-tauri/target`. `cargo test -- --ignored` would run `screenshot.rs tests::native_capture_benchmark`, which captures the real screen if the permission is granted.
