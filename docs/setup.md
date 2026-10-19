# Local setup

## Prerequisites

| Tool | Version used on Day 1 | Notes |
| --- | --- | --- |
| Node.js | 26.7.0 (≥ 24.7 required) | Argon2id comes from `node:crypto` (added in 24.7) |
| pnpm | 11.9.0 (≥ 10) | `corepack enable` or `npm i -g pnpm` |
| Rust / Cargo | 1.98.1 stable | via `rustup` |
| macOS | Xcode Command Line Tools | `xcode-select --install` |
| Windows | Microsoft C++ Build Tools + WebView2 | WebView2 ships with Windows 10 (1803+) / 11 |

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
| `apps/desktop/.env` | `VITE_API_URL` only. |

Without an `.env`, the API uses safe local defaults: port 4000, a local SQLite file at
`apps/api/data/dev.db`, CORS for the local dashboard and Tauri origins, and an ephemeral
access-token key. **No Turso credentials are needed for local development.** Migrations run
automatically when the API starts (they are additive and idempotent).

| API variable | Local default | Production |
| --- | --- | --- |
| `DATABASE_URL` | `file:./data/dev.db` | **Required**: `libsql://…` (Turso). `file:` is rejected at boot. |
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
- In production, run it once from the server against Turso (same env as the API) and open
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
pnpm --filter @workfolio/desktop package     # native .app/.dmg (macOS) or .msi/.exe (Windows)
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
- **Desktop shows "API unreachable":** the API must be running, its `CORS_ORIGINS` must include
  the Tauri origin, and the API origin must be in `connect-src` in
  `apps/desktop/src-tauri/tauri.conf.json`.
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
