# Insight Workfolio desktop 0.2.1 — release notes (2026-11-17)

**Status: RELEASE CANDIDATE, NOT PUBLISHED.** Not production-ready until the physical Windows QA in
`docs/qa/WINDOWS-DESKTOP-0.2.1-QA-2026-11-17.md` passes and the owner approves publishing.

| Item | Value |
|---|---|
| Version | 0.2.1 (`apps/desktop/package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.lock`) |
| Source | `deploy/hostinger-vps` at `3a28114` + the version bump and these docs. Build commit: **PENDING** (recorded in the QA doc once built) |
| Platform | Windows x64, NSIS per-user installer, **unsigned** (SmartScreen will warn) |
| API | `https://189.72.144.117` (CSP `connect-src` allows only this origin; http and localhost are refused by the packager) |
| Identity | Production: `com.insightworkfolio.desktop`. Same Credential Manager service, installation ID, app data folder and install folder as the builds already installed |
| In-app updates | **Off in this build** (no updater public key configured). 0.2.1 is installed manually over the existing app |

## Why 0.2.1

Every Windows installer built so far for the production API predates the current code, and they all report
`0.1.0` or `0.2.0`, so support cannot tell builds apart. 0.2.1 is the first Windows build of the current code
with the production URL and a version number of its own.

## What changes for employees, compared with the 0.1.0 download

- **Live Active/Idle status** on the dashboards (from `4d66269`): the app reports "active / idle right now"
  about once a minute while clocked in and monitored. 0.1.0 never reported it, so dashboards showed *Unknown*.
- **Screenshots respect idle time and breaks** (`03421f8`, `4d66269`): none is taken while there has been no
  keyboard/mouse input for the idle threshold; none can be kept from the moment *Start break* or *Clock out* is
  pressed; queued screenshots are re-checked against attendance before upload.
- **Several registered computers, one active sign-in** (`a097b63`): signing in where another computer is
  active offers **Switch to this device**; a computer revoked by an administrator can be registered again only
  after an administrator approves it and the employee signs in with their password.
- Updater code is included (`6940607`) but inactive in this build.

Breaks are unchanged: **manual** *Start break* / *End break*. There is no automatic work/break (Pomodoro) timer.

## Upgrade behaviour

Install the 0.2.1 installer over the existing app (no uninstall). Kept: installation ID and refresh token in
Credential Manager, the device registration, the sign-in, and the local queue
(`%LOCALAPPDATA%\com.insightworkfolio.desktop\attendance-queue.db`, schema unchanged since 0.1.0) with any
unsynced attendance, activity and screenshots. Quit the app (tray → Exit) before installing.

## Known limitations

1. **Unsigned installer**: SmartScreen "Unknown publisher" warning.
2. **Hidden-window throttling on Windows (not verified)**: `backgroundThrottling: "disabled"` has no effect on
   Windows (wry documents it as unsupported). While the window is hidden in the tray, uploads and live-status
   reports run on webview timers that Windows/Chromium may slow down. Native sampling, capture and the tray timer
   are unaffected. No workaround is included until the QA test reproduces it.
3. **Injected input counts as activity**: Windows' `GetLastInputInfo` cannot tell software-generated input
   from real input. Detecting it would need input hooks, which this app deliberately does not install.
4. **Default idle threshold is 300 s**: an inactivity test shorter than 5 minutes stays *Active* by design.
5. **Dashboard live status with two authorized devices** (server, not this build): the attendance overview picks
   one non-revoked device per employee without ordering, so with two authorized computers it may show the
   other computer's state. Fix belongs in the API (`attendance.service.ts` overview).
