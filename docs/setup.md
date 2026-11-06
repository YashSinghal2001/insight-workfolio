# Local setup

## Prerequisites

| Tool | Version used on Day 1 | Notes |
| --- | --- | --- |
| Node.js | 26.7.0 (≥ 24.7 required) | Argon2id comes from `node:crypto` (added in 24.7) |
| pnpm | 11.9.0 (≥ 10) | `corepack enable` or `npm i -g pnpm` |
| Rust / Cargo | 1.98.1 stable | via `rustup` |
| macOS | Xcode Command Line Tools | `xcode-select --install` |
| Windows | Microsoft C++ Build Tools + WebView2 | WebView2 ships with Windows 10 (1803+) / 11 |
| FFmpeg (optional) | 8.1.2 (Homebrew) | Only for screenshot timelapse videos: needs libx264 (`brew install ffmpeg`). Without it the feature shows "unavailable"; see docs/timelapse.md |

Tauri prerequisites reference: https://v2.tauri.app/start/prerequisites/

## Install

```bash
pnpm install
```

pnpm 11 enforces a minimum release age for dependencies; do not add
`minimumReleaseAgeExclude` entries without review.

## Environment files

| File | Purpose |
| --- | --- |
| `apps/api/.env` | Server secrets and config (copy from `.env.example`). Never committed. |
| `apps/dashboard/.env.local` | `NEXT_PUBLIC_API_URL` only. |
| `apps/desktop/.env` | `VITE_API_URL` only (dev; default `http://localhost:4000`). Release builds: `WORKFOLIO_API_URL`, see docs/deployment.md "Desktop API URL". |

Without an `.env`, the API uses safe local defaults: port 4000, a local SQLite file at
`apps/api/data/dev.db`, CORS for the local dashboard and Tauri origins, and an ephemeral
access-token key. **No Turso credentials are needed for local development.** Migrations run
automatically when the API starts (they are additive and idempotent).

| API variable | Local default | Production |
| --- | --- | --- |
| `DATABASE_URL` | `file:./data/dev.db` | **Required**: `file:/absolute/path.db` (VPS, selected; docs/deployment.md) or `libsql://…` (Turso, previous plan). A relative `file:` is rejected at boot. |
| `DATABASE_AUTH_TOKEN` | empty | **Required** for `libsql://` |
| `JWT_SECRET` | ephemeral random key (warning logged) | **Required**, ≥ 32 chars, e.g. `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `CORS_ORIGINS` | local dashboard + Tauri origins | Exact dashboard origin + `tauri://localhost,http://tauri.localhost` |
| `DASHBOARD_URL` | `http://localhost:3000` | Public dashboard URL (used in setup links printed by the CLI) |
| `NODE_ENV` | `development` | `production` (enables `Secure` cookies) |
| `WORKWEEK_START_DAY` | `1` (Monday) | 1–7, ISO weekday |
| `SCHEDULED_HOURS_PER_DAY` | `8` | Overtime threshold per worked day (reported only) |
| `OFFLINE_MAX_AGE_DAYS` | `7` | Older offline events need a correction |
| `ACTIVITY_SAMPLE_SECONDS` | `15` | Foreground-app sampling interval (5–300) |
| `IDLE_THRESHOLD_SECONDS` | `300` | No input for this long = idle (30–3600) |

To point at Turso:

```bash
DATABASE_URL=libsql://<database>-<org>.turso.io
DATABASE_AUTH_TOKEN=<token from `turso db tokens create`>
```

In `NODE_ENV=production` the API refuses to start with a local SQLite database, without a
Turso token, or without `JWT_SECRET`. It never falls back to SQLite silently.

## First admin

The first admin is created with an explicit command. Nothing is seeded automatically, and
there is no default password.

```bash
pnpm build:packages && pnpm --filter @workfolio/api build
pnpm --filter @workfolio/api admin:create --email you@company.com
```

- The command runs migrations, creates the admin **without a password**, and prints a
  one-time setup link (valid 72 h) to the terminal. Open it and choose a password
  (12–128 characters). The link is not written to any log.
- Idempotent: re-running for an admin who already set a password does nothing; re-running
  for one who hasn't issues a fresh link (the old one stops working).
- If a different admin already exists, it refuses unless you pass `--additional`.
- `--super-admin` creates the Super Admin (CEO) identity instead of Admin; see [roles.md](roles.md).
- In production, run it once on the VPS as `workfolio` (`node --env-file=/etc/workfolio/api.env dist/cli/create-admin.js …` in `/opt/workfolio/current/apps/api`) and open
  the link yourself. Never paste the link into chat, email or tickets.

## Adding employees

Dashboard → Employees → Add employee. The API creates the account without a password and
returns a one-time setup link (72 h), shown once. Deliver it in person or over a trusted
company channel. The employee sets their password, then signs in to the desktop app. If a
link is lost or a password must be reset, use **New setup link** on the employee page;
earlier links stop working.

## Desktop attendance

After signing in, the employee registers the device once (Register this device), then uses
Clock in / Start break / End break / Clock out. Offline presses are queued and sync
automatically. Local data (macOS): `~/Library/Application Support/com.insightworkfolio.desktop/attendance-queue.db`;
Keychain service `com.insightworkfolio.desktop` (accounts `refresh-token`, `installation-id`).
Admins revoke a device on the employee page and see live status under **Attendance**.
The desktop **History** tab shows daily/weekly hours and shifts; **Corrections** sends
requests (times in the employee's time zone). Admins review them under **Corrections** and
see per-employee hours under **Timesheets**.

**Menu bar (macOS):** the app keeps a menu-bar item (clock icon) showing the elapsed time of the
current shift or break, the status and what is being recorded, **Open Insight Workfolio** and
**Quit Insight Workfolio**. Closing the window only hides it; the app keeps running in the menu
bar. Quitting (menu bar or Cmd+Q) while clocked in asks first, because it stops activity and
screenshot recording until the app is opened again. Preferences (`prefs.json`, owner-only, in the
same Application Support folder): show seconds in the menu bar, hide the Dock icon (the app is then
only in the menu bar), launch at login (off by default; registered with macOS as a login item,
visible and removable in System Settings > General > Login Items; works only for the installed
`.app`, and macOS may ask the employee to approve it there). Opening the app while it runs brings
up the existing window (macOS reuses the running copy; a second copy started another way exits at
once, see the single-instance lock).

## Activity monitoring (macOS)

After the employee acknowledges the monitoring notice in the desktop app, clocking in starts
monitoring (shown as **On**); breaks pause it and clocking out stops it. No macOS permission
prompt is involved. Admins view it under **Activity**. On Windows the app states that activity
collection is not available yet.

## Screenshots (macOS, off by default)

1. Dashboard › Settings › **Screenshots**: tick "Screenshots enabled", keep or change the
   interval (default 300 s), quality (70), maximum resolution (1920 px) and retention (30 days,
   not approved), give a reason and save. The required notice defaults to the seeded draft
   `2026-10-screenshots-draft-1` (publish a reviewed version under Monitoring notices first).
2. In the desktop app the employee sees a separate **screenshot notice** and acknowledges it.
3. macOS must allow screen recording for the app: the employee clicks **Allow screen
   recording…** (system prompt the first time), or turns the app on in System Settings › Privacy &
   Security › Screen & System Audio Recording, then quits and reopens the app. Development builds
   launched from a terminal inherit the terminal app's permission instead.
4. Clock in: the first screenshot is taken one interval later. The app shows the next capture,
   the last local capture and the last capture confirmed by storage.

Admins view screenshots under **Screenshots** in the dashboard (filter by employee and dates;
click a thumbnail for the full-size viewer and its access log). Every thumbnail and view is logged.

Storage in development is the `LOCAL_DEV` adapter: files under `apps/api/data/screenshots/`
(`SCREENSHOT_LOCAL_DIR`). Microsoft Graph setup: [onedrive.md](onedrive.md). Local copies on
the Mac: `~/Library/Application Support/com.insightworkfolio.desktop/screenshots/` (removed 24 h
after the upload is confirmed).

## Run

```bash
pnpm dev:api         # API          → http://localhost:4000/api/v1/health
pnpm dev:dashboard   # Dashboard    → http://localhost:3000
pnpm dev:desktop     # Desktop app  → native window
pnpm dev             # all three
```

Check the API:

```bash
curl http://localhost:4000/api/v1/health
curl -i http://localhost:4000/api/v1/ready
```

## Verify

```bash
pnpm lint && pnpm typecheck && pnpm build && pnpm test
WORKFOLIO_API_URL=https://api.example.com pnpm --filter @workfolio/desktop package  # release .app/.dmg (macOS) or .msi/.exe (Windows); https API only
pnpm --filter @workfolio/desktop tauri build --debug --bundles app              # local debug bundle against http://localhost:4000
```

The first Rust build takes 2–3 minutes. Desktop tests: `node --test` (TypeScript sync/session
logic, run with Node's built-in type stripping) and `cargo test` (SQLite queue).

Driving the real desktop app (debug builds only): run `pnpm --filter @workfolio/desktop dev:web`
and then `WF_E2E_SCRIPT=path/to/script.js apps/desktop/src-tauri/target/debug/insight-workfolio-desktop`.
The script is evaluated in the window after each page load. It can call `e2e_log` and
`e2e_exit` through `window.__TAURI_INTERNALS__.invoke`.

### Native activity verification (macOS, real OS events)

```bash
pnpm build && pnpm --filter @workfolio/desktop verify:native
```

Starts a throwaway API (temporary database, dev-only 5 s sampling / 30 s idle threshold, set
through env; production defaults are unaffected), opens the real debug app and shows step-by-step
instructions at the top of its window: switch apps, stay idle until told to move, lock the screen
(Control-Command-Q) and unlock, sleep the Mac for at least a minute and wake it. Each step is
detected from the native collector; afterwards the activity the server recorded is checked and a
PASS / FAIL / SKIPPED table is printed. Press **Skip this step** for anything you can't do;
`--skip=lock,sleep` skips steps for an unattended run, `--sample=` / `--idle=` change the
thresholds. Needs port 4000 free; replaces the app's saved dev sign-in in the Keychain.

### Dashboard gallery verification (headless Chrome)

```bash
pnpm build && pnpm --filter @workfolio/dashboard verify:gallery
```

Throwaway API (temporary database and `LOCAL_DEV` storage) on port 4000 and the dashboard
production build on port 3100, driven by headless Google Chrome. Uploads 30 real WebP images that
Chrome encodes from a canvas labelled "SYNTHETIC TEST" (never your screen) through the real
register/upload endpoints, then checks thumbnails, filters, pagination, empty and error states, the
full-size viewer, no-cache headers and the access log. Prints PASS / FAIL and the folder with page
captures; everything else is deleted.

### Dashboard timelapse verification (headless Chrome, real FFmpeg)

```bash
pnpm build && pnpm --filter @workfolio/dashboard verify:timelapse
```

Same setup as the gallery check (API on port 4000, dashboard on port 3101, temporary database,
storage and video folder). It uploads 17 WebP frames that Chrome encodes from synthetic canvases.
Then it creates, previews, downloads (checked with `ffprobe`), deletes, retries and cancels a
timelapse, and exercises the large-video confirmation on a 601-frame session (one real upload,
then stored-row copies of that file, because the register endpoint allows 120 requests per
employee per 10 minutes). It also checks the insufficient, unavailable and error states, the
390 px layout and the access log. It needs FFmpeg with libx264 on `PATH`.

### Employee History and "My screenshots" verification (desktop front end in headless Chrome)

```bash
pnpm build && pnpm --filter @workfolio/desktop verify:my-screenshots
```

Starts a throwaway API on port 4000 and the desktop front end with Vite on port 1420, and drives it
in headless Chrome without the Tauri shell (tokens in memory). Employees sign in and open the tabs.
History: the draft timesheet CSV and Excel downloads (file name, contents, the workbook read back with openpyxl, cancel, own data only, reversed,
oversized, empty and offline states), the open shift, weekly activity totals and per-app totals (own data only), the recorded
vs calculated labels, a row per day, week navigation and the empty week, 390 px, the link to My
screenshots and the offline error. My screenshots: own screenshots only, pagination, deleted state, mask count and labels, black masked
pixels in the viewer, access-log rows, Escape and focus, 390 px, self-view off (server refusal
shown), the empty state and the network-error state. Frames are synthetic.

### Timesheet export in the packaged app (real Tauri bundle)

```bash
pnpm build && pnpm --filter @workfolio/desktop tauri build --debug --bundles app
pnpm --filter @workfolio/desktop verify:export-packaged
```

Builds the app bundle (debug profile, so the test hook works; front end embedded, served from
`tauri://localhost` with the app's CSP), starts a throwaway API on port 4000 with a synthetic
employee, launches the bundle, signs in and downloads CSV, Excel and CSV again into the real
`~/Downloads`, plus a non-export file the native handler must refuse. Checks the files (including
the ` (1)` copy instead of an overwrite), then moves the files it created out of Downloads into the
output folder. Quit the desktop app first. The app's saved dev sign-in is replaced and cleared;
macOS may ask once to allow Keychain access. Needs `unzip`; Python `openpyxl` for the workbook check.

### Tasks in the packaged app (real Tauri bundle, attended)

```bash
pnpm build && pnpm --filter @workfolio/desktop tauri build --debug --bundles app
pnpm --filter @workfolio/desktop verify:tasks-packaged [--sleep]
```

Two real launches of the bundle with a quit in between, against a throwaway API on port 4000 that is
stopped and restarted mid-run (server unreachable, then back). Signs in, registers, clocks in (the
monitoring notice is not acknowledged, so no activity is recorded), runs, stops and breaks timers,
recovers the running timer after the relaunch and after the outage, and clocks out. `--sleep` puts the
Mac to sleep (`pmset sleepnow`) with a timer running; wake it after about a minute. Choose "Always
Allow" when macOS asks about the app's Keychain items. Quit the desktop app first.

### Website usage with the real browser extension (headless Chrome)

```bash
pnpm build && pnpm --filter @workfolio/desktop verify:websites
```

Loads `apps/browser-extension` unpacked into Google Chrome over the DevTools pipe
(`Extensions.loadUnpacked`, needed since branded Chrome ignores `--load-extension`), and drives the
dashboard (admin turns tracking on, adds category rules), the desktop front end (employee acknowledges
the notice, gets a connection code), the extension popup (connects) and real browsing of local test
sites under mapped hostnames. Checks that only domains are stored, an off-the-record window is not
recorded, breaks and the policy switch stop recording, disconnecting works, and reports and
categories are correct. To try the extension by hand: chrome://extensions → Developer mode → Load
unpacked → `apps/browser-extension`. `BROWSER=brave` runs the same checks in Brave Browser.

```bash
pnpm build && (cd apps/desktop && pnpm tauri build --debug --bundles app)
pnpm --filter @workfolio/desktop verify:websites-packaged [--sleep]
```

Drives the **packaged** desktop app (signs in as a seeded employee, acknowledges the website notice,
shows a connection code) while the harness pairs the extension in Chrome and browses. Then quits and
relaunches the app (session restored), stops and restarts the API (outage and recovery), and
disconnects the browser from the app. `--sleep` puts the Mac to sleep with a site in front; wake it
after about two minutes. The gap rule must keep the time asleep out. Attended: choose "Always Allow"
on Keychain prompts. Quit the desktop app first.

### Employee web panel (P2)

```bash
pnpm build && pnpm --filter @workfolio/dashboard verify:my-panel
```

Every `/my/*` page in the production build with real data from a throwaway API (two employees, a
Super Admin, an IT Admin): isolation, admin redirects, self-view off, leave create/cancel, export,
phone width, sign-out. See [employee-panel.md](employee-panel.md).

### Leave requests verification (desktop front end and dashboard in headless Chrome)

```bash
pnpm build && pnpm --filter @workfolio/desktop verify:leave
```

Starts a throwaway API on port 4000, the desktop front end with Vite on port 1420 and the dashboard
production build on port 3102. An employee requests full-day, short and half-day leave (loading,
empty, invalid, overlap, success, cancel and offline states, own requests only). An admin approves
with a note, rejects without one, sees the history and the empty state; then the employee sees the
decision; finally the dashboard error state with the API stopped. Synthetic people only.

### Project and task time verification (desktop front end and dashboard in headless Chrome)

```bash
pnpm build && pnpm --filter @workfolio/desktop verify:tasks
```

Starts a throwaway API on port 4000, the desktop front end with Vite on port 1420 and the dashboard
production build on port 3102. An admin creates, renames and archives projects, adds tasks and
assigns an employee; the employee sees only assigned active tasks, starts, pauses, resumes and stops
a timer, sees it again after a fresh sign-in, sees a break end it, and gets a clear offline error;
the admin summary is checked against the stored entries and the attendance worked time. Synthetic
people only; attendance actions go through the API.

### Email reports verification (dashboard in headless Chrome, mock provider)

```bash
pnpm build && pnpm --filter @workfolio/dashboard verify:reports
```

Starts a throwaway API on port 4000 with `REPORT_MAIL_PROVIDER=mock` (messages stay in that
process's memory; nothing is emailed) and the dashboard production build on port 3102. An admin
creates reports, sees only eligible recipients, previews (attendance figures, no leave reason or
addresses), runs one (shown as "Mock only: not emailed"), re-runs (no second message), sees a
provider failure and pauses a report; then the error state with the API stopped.

### Dashboard privacy-mask verification (headless Chrome, real FFmpeg)

```bash
pnpm build && pnpm --filter @workfolio/dashboard verify:masks
```

Same setup as the timelapse check, with the dashboard on port 3102. It enters two masks in the
screenshot settings and saves them. It then checks that a mask outside the screen is refused, and
that the page fits 390 px. Next it uploads synthetic WebP frames with the masks blacked out, the
way the agent does it, and checks that a frame without masks is refused. Finally it checks the
gallery count, the viewer pixels and a real H.264 timelapse (black inside both masks). The agent's
own masking is covered by `cargo test`, not by this script.

### Automatic foreground switch while idle (macOS)

```bash
pnpm build && pnpm --filter @workfolio/desktop verify:native -- --only=autoswitch
```

Checks the Day 5 idle-overcount fix on the real Mac (~2 minutes). Click once in the Workfolio window
and take your hands off; about 12 s later the harness asks macOS to open Calculator (`open -a
Calculator`, or `--app=<name>`), a normal app activation with no keyboard or mouse events. Stay
hands-off until told (idle threshold 30 s), then move the mouse. The harness reads the system idle
counter through a debug-only command (`e2e_idle_ms`, absent from release builds) to prove nobody
touched the Mac, prints the server's recorded timeline, and reports PASS, FAIL or INCONCLUSIVE
(input during the hands-off part, no input after clock-in, or the other app never came to the
front). The click must come after clock-in: idle carried over from before monitoring started is
never accepted as the starting point. Exit code 2 = inconclusive.

### Native screenshot verification (macOS, real captures)

```bash
pnpm build && pnpm --filter @workfolio/desktop verify:screenshots
```

Throwaway API with temporary `LOCAL_DEV` storage, screenshots on at the minimum 60 s interval.
Drives the real debug app: permission check, clock in, first capture and its confirmed upload, a
75 s break (no capture), a capture after the break, a lock step (stay locked ~80 s) and a sleep step
for the person at the Mac, clock out (no capture). Then checks the stored files (WebP header, size,
dimensions) through the admin retrieval endpoint and prints PASS / FAIL / SKIPPED with capture and
encode timings. **It captures your real main screen**: hide anything sensitive. Images are never
displayed; all test screenshots (server storage and this run's local copies) are deleted at the end
unless `--keep`. `--skip=lock,sleep` for an unattended run.

## Troubleshooting

- **Port already in use:** `lsof -iTCP:<port> -sTCP:LISTEN` and stop the process. Vite uses
  `strictPort`, so the desktop app fails instead of silently moving ports.
- **`next build` stops with `SecurityFatalError: Your version of Next.js is affected by a known
  security vulnerability`** (so `pnpm build` / `pnpm test` fail once): Next.js 16.4.0 stops the
  first build to show an upgrade recommendation and says to retry; the retry builds normally
  (seen 2026-10-29). Treat it as an advisory to review and upgrade Next.js in its own change
  (`pnpm --filter @workfolio/dashboard outdated next`); do not script around it in CI.
- **Desktop shows "API unreachable":** the API must be running and its `CORS_ORIGINS` must
  include the Tauri origin. Dev and debug builds allow `http://localhost:4000` in `connect-src`
  (`apps/desktop/src-tauri/tauri.conf.json`); release builds made with `pnpm package` get the
  `WORKFOLIO_API_URL` origin instead (docs/deployment.md "Desktop API URL").
- **Desktop sign-in says "This build of the app is misconfigured":** the compiled-in API URL was
  rejected (e.g. plain http to a remote host, or http in a release build). Rebuild with a valid URL.
- **Dashboard "API up, dependencies not ready":** `GET /api/v1/ready` is failing; check the API
  logs for the database error.
- **Dashboard sign-in loops back to the login page:** the dashboard and API must be on the
  same site (`localhost` and `localhost`, or `app.example.com` and `api.example.com`) because
  session cookies are `SameSite=Strict`. Mixing `127.0.0.1` and `localhost` breaks this.
- **`403 Request origin not allowed`:** state-changing requests without a bearer token must
  send an `Origin` listed in `CORS_ORIGINS`. Add `-H "Origin: http://localhost:3000"` to curl.
- **Desktop says "Another device is already registered":** an admin must revoke the old
  device on the employee page first (one active device per employee).
- **Desktop "Sync failed" with a reason:** the server rejected that event (e.g. an invalid
  transition or a time earlier than an existing record). Nothing was overwritten; dismiss it
  and, if needed, ask an admin for a correction.
- **Desktop stuck on "Waiting for access to your saved sign-in…":** macOS is asking whether
  the rebuilt (unsigned) app may read its Keychain items. Answer the dialog, or delete the items
  with `security delete-generic-password -s com.insightworkfolio.desktop -a refresh-token`
  (and `-a installation-id`; the device must then be registered again after an admin revokes
  the old one).
- **Desktop says the local queue was damaged:** the old file is kept next to the new one as
  `attendance-queue.damaged-<time>`; events in it were not uploaded. Request corrections.
- **Desktop shows monitoring "Off" while clocked in:** read the reason under the status: the
  notice must be acknowledged, the device must be active, and on Windows collection is not
  available yet.
- **Login returns 429:** 10 attempts per email or 100 per IP in 15 minutes. Restarting the
  API clears the counters in development.
