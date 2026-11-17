# Insight Workfolio desktop 0.2.1 — release notes (2026-11-17)

**Status: RELEASE CANDIDATE, published for live testing only (owner-approved 2026-11-17).** Not production-ready until the physical Windows QA in
`docs/qa/WINDOWS-DESKTOP-0.2.1-QA-2026-11-17.md` passes. The installer is available from the employee dashboard for testing; that does not make it QA-approved.

| Item | Value |
|---|---|
| Version | 0.2.1 (`apps/desktop/package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.lock`) |
| Source | `deploy/hostinger-vps` at `3a28114` + the version bump and these docs. Build commit `3a315bb` (branch `release/desktop-0.2.1`) |
| Installer | `Insight Workfolio_0.2.1_x64-setup.exe`, 3,519,222 bytes, SHA-256 `241663ad540d02ce5da03efa658263540de80e2bc6ff5fd5c7cde6ee6febc273` |
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

## Distribution (VPS-hosted, not in git)

The Windows installer is **not** committed to the public repository. Caddy serves it from
`/srv/workfolio-downloads` at `https://189.72.144.117/desktop-downloads/Insight-Workfolio_0.2.1_x64-setup.exe`
(route in `deploy/caddy/Caddyfile.ip`: only top-level `*.exe`/`*.dmg` names starting with a letter or digit;
no listing, no dotfiles, no subfolders; `Content-Disposition: attachment`). The dashboard entry in
`apps/dashboard/src/lib/desktop-releases.json` carries `href` for it. macOS 0.1.0 stays in `public/downloads`.
The Windows 0.1.0 binary left `public/downloads` (still in git history) and is kept in the VPS folder for rollback.

### Publish runbook (root, hPanel web console). `<SHA>` = the publish commit.

1. Fetch the release into the server's clone and check the live Caddyfile has no local edits:
   `sudo -u workfolio git -C /opt/workfolio/repo fetch --quiet origin`
   `diff <(git -C /opt/workfolio/repo show 3a28114:deploy/caddy/Caddyfile.ip) /etc/caddy/Caddyfile && echo SAME`
   Stop if it is not `SAME`.
2. Download folder, rollback copy, installer (token: GitHub fine-grained, this repo, Actions read-only,
   1-day expiry, typed into the hidden prompt, revoked afterwards):
   ```
   ( set -euo pipefail
     install -d -m 755 -o root -g root /srv/workfolio-downloads
     old=/opt/workfolio/current/apps/dashboard/public/downloads/Insight-Workfolio_0.1.0_x64-setup.exe
     echo "9a496e363b7bc120e9294b916c5729f14a47fd646f690c7edf042353890fce4d  $old" | sha256sum -c -
     install -m 644 -o root -g root "$old" /srv/workfolio-downloads/
     cd "$(mktemp -d)"
     read -rs -p "GitHub token: " GH; echo
     curl -fsSL -H "Authorization: Bearer $GH" -o a.zip https://api.github.com/repos/YashSinghal2001/insight-workfolio/actions/artifacts/14309923103/zip
     unset GH
     python3 -c 'import zipfile; zipfile.ZipFile("a.zip").extractall(".")'
     f="Insight Workfolio_0.2.1_x64-setup.exe"
     test "$(stat -c %s "$f")" = 3519222
     echo "241663ad540d02ce5da03efa658263540de80e2bc6ff5fd5c7cde6ee6febc273  $f" | sha256sum -c -
     install -m 644 -o root -g root "$f" /srv/workfolio-downloads/Insight-Workfolio_0.2.1_x64-setup.exe
     ls -l /srv/workfolio-downloads; sha256sum /srv/workfolio-downloads/* )
   ```
3. Caddy route (restart, not reload: `admin off`; HTTPS pauses for a few seconds):
   ```
   ( set -euo pipefail
     cp -p /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-2026-11-17
     git -C /opt/workfolio/repo show <SHA>:deploy/caddy/Caddyfile.ip > /tmp/Caddyfile.new
     install -m 644 -o root -g caddy /tmp/Caddyfile.new /etc/caddy/Caddyfile
     chown -R caddy:caddy /var/log/caddy
     (set -a; . /etc/caddy/workfolio.env; set +a; runuser -u caddy -- caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile)
     systemctl restart caddy; systemctl is-active caddy )
   ```
   If validation fails: `cp -p /etc/caddy/Caddyfile.bak-2026-11-17 /etc/caddy/Caddyfile` (Caddy was not restarted).
   Check: `curl -sI https://189.72.144.117/desktop-downloads/Insight-Workfolio_0.2.1_x64-setup.exe` → 200, 3519222.
4. Dashboard (no `--migrate`; rebuilds and restarts **both** API and dashboard, about a minute of build then a
   few seconds of restart; no schema change):
   `sudo -u workfolio -H bash -lc '/opt/workfolio/current/deploy/scripts/deploy.sh <SHA>'`
   If the build stops with Next.js `SecurityFatalError` (a one-time upgrade notice), nothing was activated:
   run the same command again.

### Rollback

- Dashboard: `sudo -u workfolio -H bash -lc '/opt/workfolio/current/deploy/scripts/deploy.sh --rollback'`
  (previous release lists Windows 0.1.0 from its own `public/downloads`).
- Or keep this release and point the Windows entry at `/desktop-downloads/Insight-Workfolio_0.1.0_x64-setup.exe`
  (size 2674954, SHA-256 `9a496e36…0fce4d`), already in the VPS folder.
- Caddy: `cp -p /etc/caddy/Caddyfile.bak-2026-11-17 /etc/caddy/Caddyfile && systemctl restart caddy`.
