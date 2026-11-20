# Deployment

**Selected architecture (2026-11-05): one Hostinger VPS + a local persistent SQLite database + the company
OneDrive.** Everything the product needs runs on the VPS (`srv2130302`, Ubuntu 26.04, 2 vCPU / 8 GB / 100 GB,
audited read-only in `status/HOSTINGER-VPS-PHASE1-AUDIT.md`): the NestJS API and the Next.js dashboard as
systemd services under an unprivileged user, both bound to loopback, behind Caddy with Let's Encrypt; the
database is one SQLite file on the VPS disk in WAL mode; screenshots and timelapse videos go to the IT storage
account's OneDrive through Microsoft Graph (delegated) and are never kept on the VPS; nightly database backups
are encrypted and copied to a dedicated OneDrive folder. No Render, Vercel or Turso account is needed.

**Status: implemented in the repository and tested on a developer machine; nothing is installed on the VPS
yet.** Code changes (Phase A), the deploy assets under `deploy/` (Phase B), backups/monitoring (Phase C) and
these docs (Phase D) are done; the VPS install (Phase F) waits for approval, the domain and the Entra app
registration (see "Before the VPS install" at the end). The earlier **Render + Vercel + Turso** plan is
superseded; its configuration stays in the repository for reference, clearly marked, in the section "Previous
plan" below.

Reference for every file, path, port, script and runbook: [`deploy/README.md`](../deploy/README.md).
Database procedures: docs/database-operations.md. Storage: docs/onedrive.md. Videos: docs/timelapse.md.

## What runs where (Hostinger VPS)

| Component | Runtime | Notes |
| --- | --- | --- |
| API (`apps/api`) | `workfolio-api.service`: `node dist/main.js` as user `workfolio`, **one process**, `127.0.0.1:4000`, systemd sandbox (`ProtectSystem=strict`, `NoNewPrivileges`, memory cap) | Node 24 (`.node-version`): password hashing uses `argon2` from `node:crypto`. Long-lived: in-process timers run retention, report and timelapse jobs. `NODE_ENV=production` ⇒ verify-only schema check at boot, never a migration |
| Dashboard (`apps/dashboard`) | `workfolio-dashboard.service`: `next start --hostname 127.0.0.1 --port 3000` | `NEXT_PUBLIC_API_URL` (`https://api.<domain>`) is baked in at build time by `deploy.sh` from `/etc/workfolio/dashboard.env`; `next build` fails when it is unset or not `https://` |
| Reverse proxy / TLS | Caddy (apt), `app.<domain>` → 3000, `api.<domain>` → 4000, Let's Encrypt, HTTP→HTTPS | The two hosts share one registrable domain (`SameSite=Strict` cookies). UFW allows 22, 80, 443 only. `TRUST_PROXY=loopback` |
| Database | SQLite file `/var/lib/workfolio/db/workfolio.db` (libSQL driver, WAL, 0600, `workfolio`) | `DATABASE_URL=file:/var/lib/workfolio/db/workfolio.db`; no token. Migrations only through `deploy.sh --migrate` (backup first). Nightly encrypted backups, off-site in OneDrive |
| Screenshot + timelapse storage | OneDrive of the IT storage account (`SCREENSHOT_STORAGE=onedrive`, delegated `Files.ReadWrite`, docs/onedrive.md) | Folder `InsightWorkfolio/` with `screenshots/…` and `timelapses/…`; backups in `InsightWorkfolio/db-backups/`. **Not connected yet** (needs the Entra app registration and the domain for the redirect URI) |
| Timelapse encoder | Ubuntu's `ffmpeg` package (libx264 + `webp_pipe`), separate process, `TIMELAPSE_DIR=/var/lib/workfolio/tmp/timelapses` scratch only | Videos are uploaded to OneDrive and deleted locally; disk guard `TIMELAPSE_MIN_FREE_MB`; licensing note in `deploy/README.md` "FFmpeg" |
| Backups | `workfolio-backup.timer` 02:30 UTC → `backup-db.sh` (sqlite3 online backup, integrity check, gzip, gpg) → `dist/cli/backup-upload.js` into OneDrive `db-backups/` | 30 days local; off-site retention opt-in; `verify-backup.sh` rehearsals |
| Monitoring | `workfolio-monitor.timer` every 5 min → `monitor.sh` (health, readiness, units, disk, backup freshness and result, OneDrive failures in the log, scratch size) → webhook / command alerts on change; plus an external uptime monitor on `https://api.<domain>/api/v1/health` | journald only (1 GB / 30 days) |
| Desktop app | Signed macOS app; signed Windows NSIS installer (Windows code complete, cross-built only; never run on Windows yet) | Built with `WORKFOLIO_API_URL=https://api.<domain>`; see "Desktop distribution" |

## Previous plan: what would have run where (Render + Vercel + Turso, superseded)

| Component | Runtime | Notes |
| --- | --- | --- |
| API (`apps/api`) | **Render web service**, Node runtime, **exactly one always-on instance** (`node dist/main.js`) | Node ≥ 24.7 (`NODE_VERSION=24`, `.node-version`): password hashing uses `argon2` from `node:crypto`. Long-lived: in-process timers run retention and report jobs, so a sleeping free instance does not work |
| Dashboard (`apps/dashboard`) | **Vercel** (Next.js) | Uses partial prerendering (`cacheComponents`), so it is **not** a static export. `NEXT_PUBLIC_API_URL` is baked in at build time. `next build` **fails** when it is unset/empty, or not `https://` (plain `http://` only for `localhost`/`127.0.0.1`/`[::1]`, i.e. local builds: `NEXT_PUBLIC_API_URL=http://localhost:4000`). `next dev`/`next start` keep the localhost fallback |
| Database | Turso (libSQL) | Required in production (`DATABASE_URL=libsql://…` + `DATABASE_AUTH_TOKEN`); local SQLite is refused |
| Screenshot storage | Microsoft Graph (dedicated SharePoint site, `Sites.Selected`) | Required in production; see docs/onedrive.md. The OneDrive-folder option was rejected; the provider decision awaits the user's final approval. **BLOCKED: the site does not exist yet** |
| Timelapse encoder | **FFmpeg with libx264** on the API host (separate process, not bundled) | Optional: without it timelapse creation is refused with a clear reason. Videos are a short-lived cache in `TIMELAPSE_DIR` (persistent local disk, owner-only; 24 h). Sizing, licensing (GPL libx264, H.264 patents) and limits: docs/timelapse.md. **Not installed anywhere yet** |
| Desktop app | Signed macOS app; signed Windows NSIS installer (Windows code complete, cross-built only; never run on Windows yet) | See "Desktop distribution" |

(Previous plan.) Render and Vercel would supervise the processes and terminate TLS; behind Render's proxy
`TRUST_PROXY=1`. On the VPS Caddy is on the same host, so the default `TRUST_PROXY=loopback` is right.

## Database startup safeguards (shared data layer, 2026-10-30; VPS rule 2026-11-05)

What the API does with migrations at boot depends on `DATABASE_URL` and `NODE_ENV` (details in
docs/database-operations.md "Migrations: local vs hosted vs production file"):

- **Development** (`file:` or `:memory:`, `NODE_ENV` ≠ `production`): applies pending migrations at boot, as before.
- **Production on the VPS** (absolute `file:`, `NODE_ENV=production`) and **hosted** (`libsql://` or
  `https://`, Turso, previous plan): **never migrates at boot.** A read-only migration-status check; the API
  refuses to start when any migration is pending, and warns if a local file is not in WAL mode (it never
  changes the file). Migrations run only through `db:migrate`, on the VPS via `deploy.sh --migrate`
  (backup first) or `deploy.sh --migrate-only`. **Deploy order: backup → migrate → deploy.**

In both cases the API refuses to start (non-zero exit, clear log line naming the ids, no secrets) when:
- a migration is pending (hosted only) or fails (local; each migration is one transaction with its
  bookkeeping row; nothing partial);
- an applied migration was edited afterwards (sha256 checksum per migration in `schema_migrations`);
- the database lists a migration this build does not know (it was migrated by a newer build);
- the connection does not enforce foreign keys (`PRAGMA foreign_keys`). On Turso staging this was
  verified ON in the read-only audit of 2026-11-03.
It logs the schema version it runs on. Two `db:migrate` runs (or two local processes) starting together
do not fail: the second sees the migration already applied. Local `file:` databases get a 5 s busy timeout on every pooled
connection. Rollback = redeploy the previous build (`deploy.sh --rollback`) only if it knows every applied
migration (otherwise it refuses to start by design); data rollback = `restore-db.sh` from a nightly backup
(previous plan: Turso point-in-time restore).

## Single instance only

Run **exactly one API process** (API-13). On the VPS that is one `workfolio-api.service` (systemd never
starts a second instance; `deploy.sh` restarts it in place, so there is never a moment with two). Previous
plan: Render `numInstances: 1` with no autoscaling. These are kept in memory and are not shared between
processes:

- rate limiters (login attempts, screenshot uploads, per-session API limit), so limits would multiply per instance;
- OAuth `state` of the Google Drive connect flow (testing POC), so a callback that lands on another
  instance fails;
- in-process caches (e.g. the Microsoft Graph token);
- per-employee locks that serialize attendance and screenshot writes, so two instances could race
  (e.g. two screenshots closer than the policy spacing);
- scheduled activity and screenshot retention timers, which would run once per instance;
- schema checks at boot (hosted databases are never migrated at boot; `db:migrate` runs separately,
  and two concurrent runners are handled: the second sees the migration already applied).

Scaling out needs a shared store for locks, limits and OAuth state and a single scheduler. Not
needed for the pilot size. A deploy restarts the API once (seconds; the desktop app retries).

## Production configuration (checked at boot)

The API validates its environment at start and refuses to run in production with (2026-10-19
tests in `apps/api/test/env.test.ts`):

- a `DATABASE_URL` that is not an absolute `file:` path (the VPS) or `libsql://`/`https://` (Turso);
  relative `file:`, `:memory:` and `wss://` are refused;
- missing or short `JWT_SECRET` (at least 32 characters);
- `SCREENSHOT_STORAGE` without its provider's full configuration (`onedrive`: all seven `ONEDRIVE_*` values,
  an `https://` redirect URI ending in the callback path; `graph`: IDs plus exactly one credential);
  `local` is never accepted in production;
- `ONEDRIVE_BACKUP_FOLDER` equal to `screenshots` or `timelapses`;
- **`CORS_ORIGINS` unset (the localhost default) or containing anything other than `https://`
  origins and the desktop app origins `tauri://localhost` / `http://tauri.localhost`;**
- **`DASHBOARD_URL` that is not `https://`.**
- `REPORT_MAIL_PROVIDER=mock` (email reports; development only). The default `none` emails nothing.

Website tracking (F04) stays blocked in production unless `WEBSITE_TRACKING_APPROVED=true`. Set it
only after HR/Legal approved the website notice and the texts that still say websites are never
recorded were revised (docs/website-usage.md).

Errors name the variable, never its value. `HOST` defaults to `127.0.0.1` (the API never listens on a
public address). Cookies are `Secure` in production. Every API response carries `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `X-Frame-Options: DENY`; HSTS on the
API domain is Caddy's default behaviour for HTTPS sites (verify after the first certificate). The dashboard
sends its own security headers including HSTS (`apps/dashboard/next.config.ts`).

Secrets (`JWT_SECRET`, `ONEDRIVE_CLIENT_SECRET`, `ONEDRIVE_TOKEN_KEY`, the backup passphrase, the alert
webhook URL) live only in `/etc/workfolio/*.env` (root:workfolio 0640) and `/var/lib/workfolio/secrets/`
(0700) on the VPS. Never in the repository (`.gitignore` excludes `.env*`, keys and certificates; the
`deploy/env/*.example` templates carry placeholders) or on desktops.

## Backup and restore

- **Production data is the SQLite file on the VPS.** `backup-db.sh` (nightly 02:30 UTC, and before every
  migration by `deploy.sh --migrate`) takes a consistent online copy, checks its integrity, gzips and
  gpg-encrypts it (AES-256, passphrase in `/var/lib/workfolio/secrets/backup-passphrase`, a copy in the
  company password manager) into `/var/backups/workfolio/` (30 days), then uploads it into the OneDrive folder
  `InsightWorkfolio/db-backups/` with the API's own connection. Unencrypted backups never leave the VPS: both
  the script and the uploader refuse. Hostinger's weekly VPS snapshot is the third copy.
- **Restore:** `restore-db.sh <file>` (stop API, move live file + WAL sidecars aside, install, WAL, integrity,
  migration dry-run, start): the exact sequence is in `deploy/README.md` "Restore". **Rehearsal:**
  `verify-backup.sh` monthly on the newest local file and quarterly on a copy fetched back from OneDrive
  (`deploy/README.md` "Restore rehearsal"). Tested end to end on a developer machine (`selftest.sh`), not yet
  on the VPS.
- Retention purges are permanent in the database; restoring a backup would also restore purged
  rows (docs/security.md).
- Screenshots and videos live in OneDrive: covered by Microsoft 365 retention and the OneDrive recycle bin,
  not by the database backup. A database restored from before a deletion references files that are gone;
  the API treats them as missing.
- The local development database (`apps/api/data/dev.db`) is not backed up and is not production data.
- Previous plan (reference): Turso point-in-time restore, `db:dump` before each migration (DB-13/14/15/17 in
  the status reports).

## Hosting: Hostinger VPS (selected 2026-11-05, NOT INSTALLED YET)

Everything below is in `deploy/` and described file by file in [`deploy/README.md`](../deploy/README.md).
This section is the walkthrough.

### Topology and DNS

```
internet ──443──▶ Caddy (0.0.0.0:80/443, Let's Encrypt)
                   ├─ app.<domain> ──▶ 127.0.0.1:3000  workfolio-dashboard.service (next start)
                   └─ api.<domain> ──▶ 127.0.0.1:4000  workfolio-api.service (node dist/main.js)
                                                          ├─ /var/lib/workfolio/db/workfolio.db (SQLite, WAL)
                                                          ├─ ffmpeg (child process, scratch /var/lib/workfolio/tmp/timelapses)
                                                          └─ Microsoft Graph ──▶ IT account's OneDrive
                                                                                  InsightWorkfolio/screenshots, timelapses, db-backups
workfolio-backup.timer (02:30 UTC) ──▶ backup-db.sh ──▶ /var/backups/workfolio/*.db.gz.gpg ──▶ OneDrive db-backups/
workfolio-monitor.timer (5 min)    ──▶ monitor.sh   ──▶ webhook / command alerts
```

- **First launch without a domain (decided 2026-11-06):** the single origin `https://189.72.144.117` with
  `deploy/caddy/Caddyfile.ip` (`/api/*` → API, rest → dashboard) and a Let's Encrypt short-lived IP certificate;
  details and limitations in `deploy/README.md` "Temporary launch on the public IP". No DNS needed. OneDrive,
  screenshots and timelapses stay disabled until OneDrive is configured.
- Later, with a domain: `A app.<domain>` and `A api.<domain>` → `189.72.144.117` (plus `AAAA` if the VPS gets
  IPv6), both under one registrable domain; `install-vps.sh` switches to the two-hostname Caddyfile. Caddy issues
  certificates on first request once the records resolve; `ACME_EMAIL` in `/etc/caddy/workfolio.env`.
- The OneDrive redirect URI `https://api.<domain>/api/v1/storage/onedrive/oauth/callback` needs the domain
  first, so the Entra app registration (docs/onedrive.md) comes after DNS.

### Install and first deploy (Phase F, with approval, after a Hostinger snapshot)

1. As root: clone the repository to `/opt/workfolio/repo`, run `deploy/scripts/install-vps.sh` (packages:
   ffmpeg, sqlite3, gnupg, Node 24, pnpm, Caddy, ufw, fail2ban; user `workfolio`; directories; units; journald
   limits; sudoers rule; 2 GB swap; firewall 22/80/443). Idempotent, writes no secrets, starts no app.
2. Fill `/etc/workfolio/api.env`, `dashboard.env`, `backup.env`, `monitor.env` and `/etc/caddy/workfolio.env`
   from the templates (generate `JWT_SECRET`, `ONEDRIVE_TOKEN_KEY`, the backup passphrase on the VPS; never paste
   them anywhere else). Re-run `install-vps.sh` so Caddy validates and loads the Caddyfile.
3. As `workfolio`: `WORKFOLIO_REPO_URL=… deploy/scripts/deploy.sh <ref> --migrate` (clone → build → first
   migration on the empty file, which sets WAL → activate → restart → health check). `/ready` is 503 until
   OneDrive is connected; `/health` is 200.
4. `node dist/cli/create-admin.js` for the first Super Admin (docs/setup.md "First admin").
5. Dashboard › Settings › Microsoft OneDrive › Connect with the IT storage account (explicit approval; the
   normal Chrome profile for Microsoft, per the browser rules). Then `backup-upload.js check`, start the timers,
   `systemctl start workfolio-backup`, `verify-backup.sh` on the first `.gpg` file.
6. Point the external uptime monitor at `https://api.<domain>/api/v1/health`; set the alert webhook in
   `monitor.env`; `install-vps.sh --harden-ssh` once an admin key login works.

### Updates and rollback

`deploy.sh [ref]` builds into a new release directory and refuses to activate while migrations are pending;
`deploy.sh <ref> --migrate` backs up and migrates first; `deploy.sh --rollback` switches `current` back to the
previous release (schema stays; restore a backup for a data rollback). Three releases are kept.

### Which commit is deployed

- `curl -s https://api.<domain>/api/v1/health` → `{"status":"ok",…,"version":"0.1.0","commit":"<sha>"}`. The dashboard
  shows the same on **My account** ("API v0.1.0 (abc1234)"). `commit` is `WORKFOLIO_BUILD_COMMIT`, which
  `deploy.sh` writes to `<release>/release.env`; `workfolio-api.service` loads it with
  `EnvironmentFile=-/opt/workfolio/current/release.env`, so a rollback reports the older commit. It is `null` for
  releases built before this change, and until `install-vps.sh` has been re-run once to install the updated unit.
  Only a 7–40 character lowercase hex id is echoed; anything else is reported as `null`.
- Deploy record on the VPS: `deploy.sh` appends one line per activation to `/opt/workfolio/deploys.log`:
  `2026-11-20T10:00:00Z deploy <sha> ref=origin/main migrate=1 by=workfolio` (rollback:
  `… rollback <sha> ref=<release dir> migrate=0 …`). Copy that line into `docs/releases/` with the migrations applied
  (`deploy.sh` prints them) and tag `prod-YYYY-MM-DD[-n]` at `<sha>`.

### What is monitored and how alerts reach people

See `deploy/README.md` "Monitoring and alerts": the external `/health` poller is the outage alarm; the on-VPS
`monitor.sh` reports readiness (database/OneDrive), unit state, disk, backup freshness and result, OneDrive
upload failures from the API log and the timelapse scratch size, and alerts once per change of state through a
webhook (Teams/Slack/ntfy) and/or any command.

## Previous plan: Render + Vercel + Turso (SUPERSEDED 2026-11-05, never deployed)

> Kept for reference only. The configuration files (`render.yaml`, `.github/workflows/deploy-staging.yml`)
> carry a superseded note and must not be enabled. The Turso staging database `workfolio` is not used by the
> VPS. Reasons for the change: one server is simpler to operate and cheaper for the pilot size, the data stays
> on company-controlled infrastructure, no third hosted database, and FFmpeg can be installed (Render's Node
> runtime had none).

No account existed (DEP-01, DEP-04). Nothing below was ever run; every value was checked
against the code only.

### Render: API (`render.yaml`)

| Setting | Value |
| --- | --- |
| Service | Web service, Node runtime, `plan: starter` (paid, always on; free instances sleep and have no disk) |
| Instances | `numInstances: 1`, no autoscaling (see "Single instance only") |
| Root directory | `apps/api` |
| Build | `cd ../.. && corepack enable pnpm && pnpm install --frozen-lockfile --prod=false && pnpm build:packages && pnpm --filter @workfolio/api build` (`--prod=false`: with `NODE_ENV=production` pnpm would skip `@nestjs/cli`) |
| Start | `node dist/main.js`: verifies the schema read-only at boot and refuses to start on a pending, edited or unknown migration. It never migrates Turso; `db:migrate` must run first |
| Health check | `/api/v1/health` (liveness only, no dependencies). **Not** `/api/v1/ready`: it probes the database and the storage provider on every call, and a Turso or Graph blip must not make Render restart the API |
| Persistent disk | `/var/data`, `TIMELAPSE_DIR=/var/data/timelapses` (24 h timelapse cache, docs/timelapse.md). FFmpeg with libx264 is not part of Render's Node runtime: without it timelapse creation is refused (API-12, unverified) |
| Node | `NODE_VERSION=24` and `.node-version` (`24`) |
| Auto-deploy | Off; deploys come from the deploy workflow (below) |
| Custom domain | `api-staging.<domain>` (Render issues TLS) |

Environment (names only; values only in Render):
- fixed in `render.yaml`: `NODE_VERSION`, `NODE_ENV=production`, `TRUST_PROXY=1`, `LOG_LEVEL`,
  `TIMELAPSE_DIR`, `SCREENSHOT_STORAGE=graph`, `GRAPH_PERMANENT_DELETE=false`, `REPORT_MAIL_PROVIDER=none`,
  `WEBSITE_TRACKING_APPROVED=false`, `WEBSITE_RETENTION_APPROVED=false`;
- entered in the dashboard (`sync: false`): `CORS_ORIGINS`, `DASHBOARD_URL`, `GRAPH_FOLDER`,
  `DATABASE_URL`, `DATABASE_AUTH_TOKEN`, `JWT_SECRET`, `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`,
  `GRAPH_SITE_ID`, `GRAPH_DRIVE_ID`, `GRAPH_FOLDER_ID`, and exactly one of `GRAPH_CLIENT_SECRET` or
  `GRAPH_CERT_KEY_PATH` + `GRAPH_CERT_THUMBPRINT` (key as a Render Secret File under `/etc/secrets/`).
- The `GOOGLE_*` variables are not set: Google Drive is a testing POC only.

### Vercel: dashboard

Root directory `apps/dashboard`, framework Next.js, Node 24.x, build `pnpm --filter @workfolio/shared build && next build`.
Variables: `NEXT_PUBLIC_API_URL` (`https://api-staging.<domain>`, public by design), and
`ENABLE_EXPERIMENTAL_COREPACK=1` so the `packageManager` pnpm is used. Custom domain `app-staging.<domain>`
under the **same registrable domain** as the API (`SameSite=Strict` cookies; `*.vercel.app` and
`*.onrender.com` are public suffixes). Preview deployments cannot sign in and must never be added to `CORS_ORIGINS`.

### Turso: database

One database per environment (staging `workfolio`, aws-ap-south-1; production is a separate database,
DB-17), database-scoped tokens per environment, region close to the Render region. Never share env files
or tokens between environments. Run `verify:turso` before the API first connects, and confirm foreign
keys are enforced (see above).

State (read-only audit 2026-11-03, `docs/status/TURSO-DATABASE-READINESS-AUDIT.md`): staging is at
`0016`, **10 migrations pending** (`0017`, `0019`, `0021`–`0028`; `0018` and `0020` reserved, not
written), no Turso dump taken yet, no users (no Super Admin). A hosted API built from the current code
will refuse to start against it until the first migration is applied with the runbook in
docs/database-operations.md ("First staging migration runbook"), which needs approval (D3).

### Deploy pipeline (`.github/workflows/deploy-staging.yml`, never run)

On a push to `main`, after the CI workflow succeeds: one job in the GitHub environment **`staging`**
(configure required reviewers there, so a person approves every run) builds the API, checks that the
secret database URL's host equals the variable `STAGING_DATABASE_HOST` (wrong-database guard; fails if
unset or different), runs `pnpm --filter @workfolio/api db:migrate --dry-run`, then `db:migrate`, then
the read-only `verify:turso` (from an owner-only temp env file in `$RUNNER_TEMP`, deleted afterwards),
then calls the Render and Vercel deploy hooks. Migrate comes before deploy because a hosted API refuses
to boot while a migration is pending. Secrets by name only, on that environment:
`STAGING_DATABASE_URL`, `STAGING_DATABASE_AUTH_TOKEN`, `RENDER_DEPLOY_HOOK_URL`,
`VERCEL_DEPLOY_HOOK_URL`; non-secret variable `STAGING_DATABASE_HOST`. Take the `db:dump` (above)
before approving a run that carries a migration. The hooks build the branch head, not the exact
commit CI checked.

Missing before this workflow can run (none exist yet): a Git remote; the GitHub `staging` environment
with required reviewers, its secrets and the `STAGING_DATABASE_HOST` variable; the Render service and
its deploy hook; the Vercel project and its deploy hook; the Turso CLI for the account owner; the
recorded PITR window (DB-13) and rehearsal (DB-14).

### Monitoring (previous plan, DEP-11 / DEP-12; superseded by `monitor.sh` + an external `/health` poller)

- **Uptime and alerting:** an external monitor polls **`/api/v1/ready`** (database + storage; 503 when
  either fails) every 1–5 min and alerts by email/chat. Render's own health check uses `/api/v1/health`.
- **Errors and logs:** Render keeps service logs for a limited, plan-dependent time; forward them to a
  log service with alerting on `error`-level lines (pino JSON), and watch Vercel's function logs for
  the dashboard. Logs never contain secrets (docs/security.md "Secret-safe logging").
- **Deploys:** a failed boot (migration refusal, env validation) shows as a failed Render deploy.
  With a disk, Render stops the old instance first, so the API is down until a fix or a rollback
  (unverified); check every deploy result.
- None of this exists yet.

### Staging integration suite (DEP-13)

`apps/api/scripts/staging-suite.mjs`: 12 black-box checks over HTTP(S), no dependencies (Node `fetch`).
Run it from a trusted machine after each staging deploy; the criterion for DEP-13 is **12/12 PASS on staging**.

```bash
BASE_API_URL=https://api-staging.<domain> DASHBOARD_URL=https://app-staging.<domain> \
STAGING_ADMIN_EMAIL=… STAGING_ADMIN_PASSWORD=… STAGING_EMPLOYEE_EMAIL=… STAGING_EMPLOYEE_PASSWORD=… \
  pnpm --filter @workfolio/api staging:suite
```

- Checks: 1 health/ready, 2 API security headers, 3 HTTPS (HSTS on API and dashboard, `Secure` cookies,
  dashboard framing protection), 4 CORS for the dashboard origin + foreign-origin 403 (CSRF), 5 auth
  (cookie flags, wrong password, logout revokes), 6 RBAC/isolation, 7 attendance (device, clock in, break,
  clock out), 8 activity (notice consent, upload, summary), 9 screenshots (register, upload, sandboxed admin
  view), 10 timelapse (queued → READY → served → deleted; needs FFmpeg on the API host), 11 retention
  (dry-run previews only, admin-only), 12 login rate limit (429 for a never-existing address; a missing `Retry-After` is printed as a note).
- Accounts: an admin able to manage settings, employees, devices and screenshots, and a **dedicated synthetic
  employee** with no other active device (one active device per employee; the suite registers its own and
  revokes it at the end). Credentials come only from the environment and are never printed.
- Shared database: records are tagged with a run id (`suite-<timestamp>-<id>`). The suite deletes its
  screenshots and timelapse, clocks out, revokes its device, logs out both sessions, and restores the screenshot
  policy if it had to enable it (temporarily at a 60 s interval: the two frames are taken 31 s apart, so a run
  takes about 45 s). Append-only records stay: attendance sessions, one activity interval, consents, audit
  rows, DELETED screenshot rows. No retention purge is ever run.
- Rate limits: each run makes 11 failed logins for a throwaway address plus ~4 real logins; the per-IP login
  limit is 100 per 15 min, so do not loop the suite.
- Exit codes: 0 = 12/12, 1 = a check failed, 2 = configuration missing (nothing contacted), 3 = no failure
  but something skipped (e.g. check 3 on `http://`, check 10 without FFmpeg). Only exit 0 meets DEP-13.

## Desktop distribution

- **macOS:** an Apple Developer ID Application certificate and notarization credentials are needed
  so the app opens without Gatekeeper warnings. **Not available**; no build has been signed.
  Screen Recording permission is granted per signed app identity, so it must be granted again for
  the signed build. See "macOS signing and notarization" below.
- **Windows: implemented, not yet run on Windows.** Cross-compiled and linted on macOS
  (`x86_64-pc-windows-gnu`); tray, single instance, startup and installer config in
  docs/windows.md. Needs a Windows runtime pass, Credential Manager testing, and an Authenticode
  certificate or Azure Trusted Signing ("Windows signing and SmartScreen" below).
- Auto-update: not decided.

### Desktop API URL (build time)

The API URL is compiled into the desktop app; it is public configuration, not a secret, and no
secret is ever embedded in the app. Build a release bundle for a production API with:

```bash
WORKFOLIO_API_URL=https://api.example.com WORKFOLIO_DASHBOARD_URL=https://app.example.com \
  pnpm --filter @workfolio/desktop package   # extra args go to `tauri build`
WORKFOLIO_API_URL=https://api.example.com WORKFOLIO_DASHBOARD_URL=https://app.example.com \
  node apps/desktop/scripts/desktop-config.mjs --print   # dry run
```

- `WORKFOLIO_DASHBOARD_URL` (**required** for release builds, `https://`): the web dashboard URL shown
  to administrators. Only a placeholder API on the reserved `.invalid` TLD (CI test installer) may
  omit it; CI sets `https://app.example.invalid` explicitly anyway.
- `WORKFOLIO_ENV=staging|production` (unset = `production`, exactly `tauri.conf.json`).
  `staging` builds bundle id `com.insightworkfolio.desktop.staging`, product name
  "Insight Workfolio Staging", and a separate keychain / Credential Manager service (the bundle id), so a
  staging and a production install on one machine never share tokens, data directory or installation id.
  A staging build must go through `pnpm package` (the script applies the identity override); a bare
  `tauri build` produces the production identity.
- A placeholder API on the reserved `.invalid` TLD (CI's test installers) always builds a third identity,
  `test`: bundle id `com.insightworkfolio.desktop.test`, product name and window title "Insight Workfolio
  Test", its own keychain / Credential Manager service, data directories, single-instance lock, Windows
  install folder (`%LOCALAPPDATA%\Insight Workfolio Test`), uninstall entry and sign-in Run value. It is not
  a choice: `WORKFOLIO_ENV=production|staging` with a placeholder API is refused, and `test` with a real
  API is refused, so a test build can never install over, update or share data with a real one.

`scripts/desktop-config.mjs` validates the URL, writes a temporary `tauri build --config` override
whose CSP `connect-src` is `'self' ipc: http://ipc.localhost <API origin>` (the dev
`http://localhost:4000` is replaced; nothing broader is added), and passes the normalized URL to
the front end as `VITE_API_URL`. `tauri.conf.json` itself is unchanged.

URL rules (`apps/desktop/src/api-url.ts`): `https://` with any host and an optional path (trailing
`/` removed); no user name/password, query or fragment. Plain `http://` only to `localhost`,
`127.0.0.1` or `[::1]`, and only in **development builds**: `tauri dev` / `vite` and
`tauri build --debug` (the Tauri CLI sets `TAURI_ENV_DEBUG=true`; debug bundles are the ones the
`verify:*-packaged` checks run against `http://localhost:4000`, and they also contain the test
hook, so they are never distributed). **Release builds are https only**: a release
`tauri build` refuses to build without a valid https `VITE_API_URL`, or when it was not started
through `pnpm package` (the CSP would not match). If a bundle is misconfigured anyway, the app
shows the error on the sign-in screen and never contacts any server. The API's `CORS_ORIGINS`
must include the desktop origins (see above).

### CI installers (unsigned, every push)

`.github/workflows/ci.yml` builds both desktop installers on every push to any branch and on a manual
run, never on a tag. Pull requests get the same checks and tests but no installers (validation only).
There is no path filter: a documentation-only push builds both installers too. A push runs the `ci.yml`
of the pushed branch, so a branch gets this only once it contains this `ci.yml` (merge or rebase it in).

| Platform | Job | Output |
|---|---|---|
| Windows x64 | `windows-desktop` | NSIS `Insight Workfolio Test_<version>_x64-setup_UNSIGNED-TEST.exe` |
| macOS universal (Apple Silicon + Intel in one app) | `macos-desktop` | `Insight Workfolio Test_<version>_universal_UNSIGNED-TEST.dmg` |

(A manual QA run for a real API: `Insight Workfolio_<version>_…_UNSIGNED-QA.<ext>`.)

Each installer is its own artifact on the run page (Actions > the run > Artifacts), kept 14 days:
`insight-workfolio_<version>_<platform>-<arch>_UNSIGNED-<TEST|QA>_run<run id>-<attempt>`. It holds the
installer, `<installer>.sha256` and `build-metadata.json` (platform, arch, version, size, SHA-256, build
type, identity, product name, bundle id, API URL, commit, branch, run). Builds are not byte-reproducible: the same commit built twice gives
two SHA-256 values, so always quote the run id with a checksum.

- **TEST** (every push): packaged for the placeholder `https://api.example.invalid`, which can never
  resolve. Use it to test installing, the tray and uninstalling. It cannot sign in anywhere. It is the
  separate app "Insight Workfolio Test" (`com.insightworkfolio.desktop.test`, see "Desktop API URL"
  above): it installs beside a production or staging app and shares nothing with it. The job checks
  that identity from the built bytes and fails if a TEST build carries the production one.
- **QA** (manual run with `desktop_api_url` and `desktop_dashboard_url`): packaged for that server, with
  the **production** identity (`com.insightworkfolio.desktop`), exactly as manual QA builds were before:
  installing one replaces an installed production app on that machine.
- Both are **unsigned**, not notarized and have no in-app updater: SmartScreen warns on Windows, and
  Gatekeeper blocks the app on another Mac. The repository is public: anyone signed in to GitHub can
  download these artifacts, so a QA build publishes the API URL it was built for. Never distribute them;
  signed builds come from `desktop-build.yml` (`desktop-release.yml`, `desktop-publish.yml`).
- The Intel half of the universal app is built and its architecture and packaged API origin are read
  from the built bytes (`lipo`); CI does not launch it, and it has not been run on Intel hardware.

The last job, `installers`, downloads both artifacts and fails the run unless there is one Windows and
one macOS installer built from that commit whose size and SHA-256 match (`deploy/scripts/ci-desktop-installer.sh`;
its header shows how to run the macOS check on a Mac). A failed or skipped platform job therefore never
leaves a green run. Push and manual runs are never cancelled by another run; only a superseded
pull-request run is. A plain manual run also runs the browser suites, so it can be red from those
while both installers are fine; a manual run with `desktop_api_url` skips them.

### macOS bundle, signing and notarization

Bundle settings (`apps/desktop/src-tauri/tauri.conf.json` → `bundle.macOS`): minimum macOS
**14.0** (ScreenCaptureKit screenshot API), **hardened runtime** on, entitlements
`src-tauri/Entitlements.plist` (empty on purpose: no runtime exceptions, **no App Sandbox**, which
Developer ID distribution does not require and which would move the app's data into a container),
category Business. `LSUIElement` is **not** set: the Dock icon is an employee preference applied
at runtime (activation policy). No Info.plist usage-description key is added: the Screen
Recording prompt text is fixed by macOS (no app-supplied text), and Keychain needs none.
`signingIdentity` is `null`, so a build without credentials is unsigned (only the linker's
ad-hoc signature): fine for testing on the build Mac, blocked by Gatekeeper elsewhere.

Needed for a distributable build (none available yet):

1. Apple Developer Program membership (organization) and a **Developer ID Application**
   certificate with its private key in the build Mac's login keychain (or as a base64 `.p12`).
2. Notarization credentials: an **App Store Connect API key** (`.p8`, key ID, issuer ID;
   preferred) or an Apple ID with an app-specific password and the team ID.
3. Build with the Tauri CLI's variables (the script checks they are complete and never prints them):

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: <Company> (<TEAMID>)"
# CI only, certificate not in the keychain:  APPLE_CERTIFICATE=<base64 .p12>  APPLE_CERTIFICATE_PASSWORD=...
export APPLE_API_KEY=<key id> APPLE_API_ISSUER=<issuer uuid> APPLE_API_KEY_PATH=/secure/AuthKey_<id>.p8
#   or: APPLE_ID=<apple id> APPLE_PASSWORD=<app-specific password> APPLE_TEAM_ID=<TEAMID>
WORKFOLIO_API_URL=https://api.example.com pnpm --filter @workfolio/desktop package --bundles app,dmg
```

The Tauri CLI signs with the hardened runtime and entitlements, notarizes the `.app` and staples
it. Then notarize and staple the DMG too (one-time `xcrun notarytool store-credentials
workfolio-notary --key <p8> --key-id <id> --issuer <issuer>` creates a keychain profile):

```bash
DMG=apps/desktop/src-tauri/target/release/bundle/dmg/*.dmg
codesign --sign "$APPLE_SIGNING_IDENTITY" --timestamp $DMG
xcrun notarytool submit $DMG --keychain-profile workfolio-notary --wait
xcrun stapler staple $DMG
spctl -a -vv -t install $DMG          # "accepted, source=Notarized Developer ID"
spctl -a -vv apps/desktop/src-tauri/target/release/bundle/macos/Insight\ Workfolio.app
codesign -dv --verbose=4 apps/desktop/src-tauri/target/release/bundle/macos/Insight\ Workfolio.app   # flags=0x10000(runtime)
```

Universal binary (Apple silicon + Intel): `rustup target add x86_64-apple-darwin`, then add
`--target universal-apple-darwin` to the `package` command. Built this way on the build Mac
(0.2.1, 2026-11-18: `lipo` shows arm64 and x86_64), and the CI `macos-desktop` job builds the same
target. The Intel half has not been launched on Intel hardware.

Launch at login uses `SMAppService.mainApp` (macOS 13+), which registers the signed `.app` itself;
it appears in System Settings > General > Login Items. An unsigned or moved copy may fail to
register or need approval there; the app shows the error.

### Windows signing and SmartScreen

Installer: NSIS, per user, no admin (`bundle.windows` in `tauri.conf.json`; details in
docs/windows.md "App shell"). Built on Windows (CI `windows-latest`), not on the Mac.
The CI job `windows-desktop` (.github/workflows/ci.yml) runs clippy and `cargo test` on Windows,
including the native smoke tests. It also builds an **unsigned NSIS test installer** against the
placeholder `https://api.example.invalid`, kept as a workflow artifact for 14 days ("CI installers"
above). That installer can't reach any server; use it to test installing, the tray and uninstalling,
never to distribute.
For a real build, run `pnpm package` with the production URL (and signing) on a Windows machine.

**Unsigned (today).** `certificateThumbprint` is `null`, so the installer and exe are unsigned.
Microsoft Defender SmartScreen then shows "Windows protected your PC … unrecognized app" (*More
info › Run anyway*), and some company policies block unsigned installers outright. For testing only.

**Signing options** (`scripts/desktop-config.mjs` `windowsSigningPlan`; a half-configured set is
refused, and the override is merged into the build config):
1. **OV or EV Authenticode certificate** in the Windows certificate store of the build machine
   (since 2023 the private key must be on a hardware token / cloud HSM):
   `WINDOWS_CERTIFICATE_THUMBPRINT=<40-hex SHA-1>` and `WINDOWS_TIMESTAMP_URL=<CA timestamp server>`
   (e.g. `http://timestamp.digicert.com` for DigiCert; add `WINDOWS_TIMESTAMP_TSP=1` if the CA needs
   RFC 3161 TSP, e.g. SSL.com). Tauri runs `signtool` with SHA-256 on the exe and the installer. The
   timestamp is required so signatures stay valid after the certificate expires; `timestampUrl` in
   `tauri.conf.json` stays `""` until a certificate exists.
2. **Azure Trusted Signing** (Microsoft-managed certificate, no token):
   `AZURE_TRUSTED_SIGNING_ENDPOINT`, `_ACCOUNT`, `_PROFILE` and a service principal
   `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`; needs `trusted-signing-cli`
   (`cargo install trusted-signing-cli`) on the build machine. The secret is read from the
   environment, never written to the config. Requires an organization with 3+ years of verifiable
   history (or individual validation) in Azure.

**Reputation.** Since 2024 EV certificates no longer skip SmartScreen: OV, EV and Trusted Signing
all build reputation per certificate/publisher over downloads, so the first releases may still
warn. Keep one signing identity across releases, and for managed rollouts deploy through Intune /
company software distribution (no Mark-of-the-Web, no SmartScreen prompt). Verify a signed build
with `signtool verify /pa /v <file>` and the file's Properties › Digital Signatures tab.

**Status:** BLOCKED on a certificate or an Azure Trusted Signing account (not available).

## Before the VPS install (approval needed)

1. **Domain and DNS** for `app.<domain>` / `api.<domain>` → the VPS IP (owner).
2. **Entra app registration** for the OneDrive connection (tenant admin; redirect URI needs the domain;
   docs/onedrive.md), and the IT storage account's sign-in at connect time (explicit approval, normal Chrome).
3. **Approval of VPS Phase 1B/F**: Hostinger snapshot, `install-vps.sh`, env files, first `deploy.sh --migrate`
   (creates the production database), first admin, first backup and OneDrive upload (explicit approvals for
   the migration and the OneDrive connect).
4. **Off-site retention decision**: leave `ONEDRIVE_BACKUP_KEEP_DAYS` unset (never delete) or set a period.
5. **Alert destination** (Teams/Slack webhook or mail) and the external uptime monitor account.
6. HR/Legal: notice wording (including whether the screenshot notice should mention timelapse videos),
   retention periods, screenshot viewers, app exclusions; acceptance of FFmpeg/libx264 licensing for videos.
7. Signing certificates for the desktop builds.
8. A Git remote (the repository is local only; `deploy.sh` clones from `WORKFOLIO_REPO_URL`).
