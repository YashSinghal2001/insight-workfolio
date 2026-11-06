# Hostinger VPS + OneDrive deployment: codebase inspection (Phase 0, before any code change)

**Date:** 2026-11-05 · **Branch:** `deploy/hostinger-vps` (from `main` @ `ad869af`) · **Changes made:** none yet (this report only).
**Update 2026-11-06:** phases A–D of §10 are implemented and tested on a developer machine; see
`HOSTINGER-VPS-IMPLEMENTATION-STATUS.md` for the consolidated report. Phase C was widened to backups, off-site
OneDrive copies and monitoring (the separate `db:integrity` CLI was dropped: `backup-db.sh`, `restore-db.sh` and
`verify-backup.sh` run `integrity_check` through sqlite3); Phase D documents in `docs/deployment.md` instead of
a new `docs/hostinger-vps.md`. Phase F (the VPS) has not started.
**Target:** everything on the Hostinger VPS (`srv2130302`, Ubuntu 26.04.1, 2 vCPU / 8 GB / 100 GB; audit in the Phase 1 VPS report), OneDrive of the IT storage account for screenshots and timelapse videos only.

Status key: ✅ VERIFIED (read in code / run) · ❓ NOT VERIFIED · ⚠️ WARNING · ⛔ BLOCKED

---

## 1. Database: can the existing implementation run persistently on the VPS?

**Verdict: yes, with two small changes. Keep SQLite/libSQL; do not move to PostgreSQL.**

| Aspect | Finding | Status |
|---|---|---|
| Driver | `@libsql/client` 0.18.0 (`packages/database/src/index.ts`). A `file:` URL opens an embedded SQLite file in-process; no server, no network, no token. The same code path the dev workflow and every e2e test already use | ✅ |
| Production refuses `file:` | `apps/api/src/config/env.ts:191` — `NODE_ENV=production` requires `libsql://` or `https://` (Turso). **This is the one hard blocker**: the API will not boot on the VPS with a local database until this refine is changed | ⛔ |
| Migrate-at-boot policy | `prepare.ts`: `file:` = migrate at boot (dev workflow); hosted = verify only, refuse if pending. On the VPS a `file:` database would silently migrate at every restart — the opposite of "no automatic destructive migrations" and of the current staging policy | ⚠️ |
| Foreign keys | libsql file connections enforce FKs by default (probed: `PRAGMA foreign_keys = 1`); `prepareDatabase` refuses to start otherwise | ✅ |
| Journal mode | **`journal_mode = delete`** by default (probed). With DELETE, every write briefly blocks readers and vice versa; the 5 s `timeout` in `createDatabase` papers over it. WAL (`PRAGMA journal_mode=WAL`, persistent once set on the file) lets the API's pooled readers run during writes and is what a long-running single-process server should use. One pragma at boot for `file:` URLs | ⚠️ |
| Transactions / concurrency | Migrations are one `batch(..., "write")` each (atomic). Writes go through `db.batch`/`db.execute`; per-employee in-process locks serialize attendance/screenshot writes. Single API process (documented API-13) — exactly the VPS plan | ✅ |
| Checksums | sha256 of each migration's statements recorded in `schema_migrations`; edited/unknown migrations refuse boot (`migrations.ts`, `migrationStatus`) | ✅ |
| CLI | `db:migrate [--dry-run]` works on `file:` URLs today (`cli/migrate.ts`); `db:dump` (`scripts/db-dump.mjs`) takes `file:/abs/path.db`, refuses to write inside the repo, output mode 600 | ✅ |
| Backup of a *live* file | `db-dump.mjs` opens the live file read-only in a read transaction — safe under WAL. For a byte-identical copy use `sqlite3 live.db ".backup out.db"` or `VACUUM INTO` — **`sqlite3` CLI is not installed on the VPS** (and not in this repo's deps) | ⚠️ |
| Integrity check | nothing runs `PRAGMA integrity_check`/`quick_check` today; `verify:turso` does schema/FK checks against any URL (it accepts `file:` per docs) | ⚠️ |
| Location | `DATABASE_URL=file:/var/lib/workfolio/db/workfolio.db` (absolute, outside the repo, owned by `workfolio`, 0700 dir). `createDatabase` already `mkdir -p`s the parent | ✅ |
| Credentials | none for a file database; `DATABASE_AUTH_TOKEN` stays unset | ✅ |

### Required database changes (code)

1. **`env.ts`**: in production, accept `DATABASE_URL=file:<absolute path>` (absolute only, never `./data/...` or `:memory:`) in addition to `libsql://`/`https://`. Turso stays accepted (historical/reference).
2. **`prepare.ts` / `database.module.ts`**: decide migrate-at-boot by **environment, not URL**: `NODE_ENV=production` → verify-only (refuse to start while pending; operator runs `db:migrate` after a dump), any other env → migrate at boot as now. Hosted URLs keep verify-only everywhere. This keeps "no automatic migrations" on the VPS and leaves the dev workflow untouched.
3. **`createDatabase` (packages/database)**: for `file:` URLs run `PRAGMA journal_mode=WAL` once after open (idempotent; readers still work if it fails on an exotic FS). Tests: one assertion in `database.test.ts`.
4. **`env.test.ts`**: production accepts absolute `file:`, refuses relative `file:` and `:memory:`; **`database-startup.e2e.test.ts`**: production + `file:` verifies only.

Consequence to be aware of: the first boot on the VPS needs `db:migrate` run first (same as Turso today). Rollback of a schema = restore a backup file (no down migrations, unchanged).

## 2. OneDrive implementation: suitable for screenshots and timelapses?

**Verdict: yes. It is already the implemented, tested (mocked) production path; no new adapter is needed.**

| Aspect | Finding | Status |
|---|---|---|
| Mode | `SCREENSHOT_STORAGE=onedrive` → `GraphStorage` in **delegated** mode with `OneDriveService` as `GraphAuth` (`storage.ts:534-545`). Rows record provider `MICROSOFT_GRAPH` | ✅ |
| Auth | Authorization-code + PKCE, confidential client, scopes `Files.ReadWrite offline_access openid profile` only; any wider scope refused (`scopesAcceptable`); only `ONEDRIVE_ACCOUNT_EMAIL` in `ONEDRIVE_TENANT_ID` accepted (`onedrive.ts:334`) | ✅ |
| Refresh token at rest | AES-256-GCM in `ONEDRIVE_TOKEN_FILE` with `ONEDRIVE_TOKEN_KEY` (32 B base64), file 0600 / dir 0700, atomic rename, rotated token written back; never in a response/URL/log | ✅ |
| Env validation | all seven `ONEDRIVE_*` required together; `ONEDRIVE_REDIRECT_URI` must be `https://<api host>/api/v1/storage/onedrive/oauth/callback` in production; token file path must be absolute | ✅ |
| Screenshots | desktop → `PUT /screenshots/:id/content` (raw WebP ≤ 10 MB) → API `storage.put` (simple upload, `conflictBehavior=replace`) → `stat` to confirm → row `STORED` with `storage_item_id`. Bytes are never public; reads go through `storage.get` behind RBAC + `screenshot_access_log` | ✅ |
| Timelapses | `putFile` = Graph **resumable upload session**, 10 MiB chunks, transient retry per chunk, session cancelled on failure; `getStream` bounded, never buffers the video (`storage.ts:361-416`) | ✅ |
| Retries / throttling | 429/502/503/504 retried ≤2× with `Retry-After` (≤5 s); 401 retried once with a fresh token; 30 s per request timeout, 15 min per streamed download | ✅ |
| Quota | `OneDriveService.check()` reads drive quota; shown in Settings › Storage status; no automatic back-pressure on low quota | ⚠️ |
| Interrupted screenshot uploads | desktop keeps retrying (row stays `REGISTERED`; "stalled" counter in admin stats); API-side upload is atomic per request | ✅ |
| Interrupted timelapse uploads | job fails → `.part` deleted → status `FAILED` ("Create it again"); partial Graph session cancelled; on restart `RUNNING` jobs are failed and local files swept | ✅ |
| Local temp files | screenshots: none (bytes pass through memory). Timelapses: `TIMELAPSE_DIR/<id>.mp4.part` only during encoding, removed right after a successful upload (`timelapse.service.ts:426`) and swept every 5 min. No local permanent copy exists | ✅ |
| "24-hour local-copy cleanup" | there is no 24 h local copy any more: `TIMELAPSE_TTL_HOURS` (24) is the lifetime of the video **in OneDrive**; local files are scratch only. Policy preserved | ✅ |
| Retention / deletion | screenshot delete = provider delete first, then row `DELETED`; sweep deletes videos containing deleted screenshots; `GRAPH_PERMANENT_DELETE=false` keeps OneDrive recycle-bin recovery | ✅ |
| RBAC / audit / privacy | untouched: `screenshot_access_log`, `timelapse_access_log`, team-head scope, masks/blur, employee self-view | ✅ |
| Multi-instance | pending OAuth states and token cache are per process — matches one API process on the VPS | ✅ |
| Real tenant | **never exercised against a real tenant** (tests use a fake Graph; `verify:onedrive` script exists). No Entra app registration exists yet (ONEDRIVE-INTEGRATION-REPORT §5) | ⛔ |

### Required OneDrive changes (code)

None to the adapter or service. Only configuration and docs (`.env.example` comment already correct). Optional, small: a disk-space guard before encoding (see §4).

## 3. Graph implementation and its relationship to OneDrive

- One adapter, `GraphStorage` (`screenshots/storage.ts`), two auth modes:
  - **app-only** (`SCREENSHOT_STORAGE=graph`): client credentials (secret or certificate), `Sites.Selected` on a SharePoint library, `GRAPH_*` env. Never verified against a real tenant; the site was never created (deployment.md).
  - **delegated** (`SCREENSHOT_STORAGE=onedrive`): tokens from `OneDriveService`, drive/folder from the encrypted connection. Same upload/download/delete code.
- `onedrive` mode reuses `GRAPH_PERMANENT_DELETE` (only shared setting). Everything else `GRAPH_*` is unused in `onedrive` mode.
- `google-drive` is a testing POC (refuses to start unless a migration adds `GOOGLE_DRIVE` to the provider CHECK; that migration does not exist).
- **Decision for the VPS:** `onedrive` is the selected production mode; `graph` (SharePoint) stays in the code as the optional alternative, documented as such. Nothing is removed.

## 4. Timelapse / FFmpeg

| Aspect | Finding | Status |
|---|---|---|
| Encoder | system `ffmpeg` (`FFMPEG_PATH`), `libx264`, `webp_pipe` demuxer; probed at boot, feature reports itself unavailable if missing | ✅ |
| Memory | frames streamed one at a time to FFmpeg stdin; `-threads 2`; output capped at 150 MB (`-fs`), 15 min per job, 1 job at a time, queue ≤ 4, ≤ 2000 frames | ✅ |
| Disk | only `.part` files under `TIMELAPSE_DIR` (0700); swept on boot and every 5 min; at most one encoding file + nothing else → bounded (≤150 MB + headroom). No free-space check before starting a job | ⚠️ (optional guard) |
| VPS | `ffmpeg` not installed (Phase 1 audit). Ubuntu 26.04 `apt install ffmpeg` ships libx264 (GPL build). Licensing: libx264 is GPL-2+, H.264 patents — FFmpeg runs as a separate OS process, not linked into or distributed with Workfolio; already documented in docs/timelapse.md | ✅ |
| Lifecycle | QUEUED → RUNNING → READY/FAILED/CANCELLED, EXPIRED/DELETED, automatic daily videos (F01) — unchanged | ✅ |

### Required timelapse changes (code)

None required. Optional: refuse to start a job when `TIMELAPSE_DIR` has < 2×`maxOutputBytes` free (`statfs`), returning the existing 503 path.

## 5. Production environment validation (`env.ts`) — what changes

| Variable | Today | VPS |
|---|---|---|
| `DATABASE_URL` | must be `libsql://`/`https://` | **`file:/var/lib/workfolio/db/workfolio.db`** also accepted (absolute only) |
| `DATABASE_AUTH_TOKEN` | required with Turso | unset |
| `SCREENSHOT_STORAGE` | `graph` in render.yaml | **`onedrive`** |
| `ONEDRIVE_TENANT_ID/CLIENT_ID/CLIENT_SECRET/ACCOUNT_EMAIL` | — | set (secrets in `/etc/workfolio/api.env`, 0600 root:workfolio) |
| `ONEDRIVE_REDIRECT_URI` | — | `https://api.<domain>/api/v1/storage/onedrive/oauth/callback` |
| `ONEDRIVE_TOKEN_FILE` | — | `/var/lib/workfolio/secrets/onedrive.json` |
| `ONEDRIVE_TOKEN_KEY` | — | `openssl rand -base64 32` |
| `ONEDRIVE_ROOT_FOLDER` | default `InsightWorkfolio` | keep |
| `GRAPH_PERMANENT_DELETE` | `false` | `false` (recycle bin) |
| `TIMELAPSE_DIR` | `/var/data/timelapses` (Render disk) | `/var/lib/workfolio/tmp/timelapses` |
| `FFMPEG_PATH` | `ffmpeg` | `/usr/bin/ffmpeg` |
| `TRUST_PROXY` | `1` (Render) | **`loopback`** (Caddy on the same host; default) |
| `CORS_ORIGINS` | — | `https://app.<domain>,tauri://localhost,http://tauri.localhost` |
| `DASHBOARD_URL` | — | `https://app.<domain>` |
| `JWT_SECRET` | — | 48 random bytes base64url, in env file only |
| `PORT` | 4000 | 4000, bound to `127.0.0.1` (**code**: `main.ts` must `listen(port, "127.0.0.1")` or a `BIND_HOST` env; today it listens on all interfaces) |
| `NEXT_PUBLIC_API_URL` (dashboard build) | — | `https://api.<domain>` (baked at build) |
| `NODE_ENV` | production | production |

Unchanged and still enforced: HTTPS-only CORS/dashboard URL, JWT length, `SCREENSHOT_STORAGE≠local`, `REPORT_MAIL_PROVIDER≠mock`, website-tracking approvals. No check is weakened.

## 6. Security implications

- **Cookies**: `httpOnly; Secure; SameSite=Strict; Path=/api` (`auth.guard.ts:61`). `app.<domain>` → `api.<domain>` is *same-site* (same registrable domain), so Strict cookies flow and the Origin-based CSRF check in `AuthGuard` keeps working. **Requires both hosts under one parent domain** — matches the plan; nothing to relax.
- **Trusted proxy**: Caddy on `127.0.0.1` → `TRUST_PROXY=loopback` (default) gives the real client IP for rate limits. HSTS is already set by both apps in production.
- **Bind address**: API `:4000` and dashboard `:3000` must listen on loopback only; UFW allows 22/80/443 only (belt and braces).
- **Secrets on disk**: `/etc/workfolio/api.env` and `dashboard.env` 0640 root:workfolio, loaded by systemd `EnvironmentFile=`; `/var/lib/workfolio/secrets` 0700 workfolio. Nothing in the repo; `.gitignore` already excludes `.env*`, `*.db`, `*.mp4`.
- **systemd hardening**: `User=workfolio`, `NoNewPrivileges`, `ProtectSystem=strict`, `ReadWritePaths=/var/lib/workfolio`, `PrivateTmp`, `ProtectHome`. FFmpeg runs under the same unit (child process), so it inherits the sandbox.
- **OneDrive**: delegated `Files.ReadWrite` on one account only; refresh token encrypted at rest; key separate from the file. If `ONEDRIVE_TOKEN_KEY` is lost → reconnect (no data loss: files stay in OneDrive, rows keep `storage_key`).
- **Database file**: contains personal data; 0600 `workfolio`; backups encrypted before leaving the host (see §7).
- **Root/password SSH** on the VPS is still open (Phase 1B pending) — must land before any secret is placed on the server.

## 7. Migration and backup implications

- **First deploy**: `db:migrate --dry-run` → approval → `db:migrate` (creates the file, 28 migrations) → `admin:create` → start services. Same runbook shape as docs/database-operations.md, local file instead of Turso.
- **Existing data**: Turso staging holds 0 users/0 screenshots (ONEDRIVE report). Nothing to migrate from Turso. Local `dev.db` is a developer database — not copied.
- **Automated backups** (to add, scripts + systemd timer, all outside the repo path):
  1. nightly `sqlite3 live.db ".backup /var/backups/workfolio/workfolio-<ts>.db"` (consistent under WAL) + `db:dump` SQL (restorable without sqlite3 version concerns);
  2. `PRAGMA integrity_check` on the copy; fail the job if not `ok`;
  3. encrypt (`age` or `gpg --symmetric`) and upload **off-site** — the natural destination is the same OneDrive account, a sibling folder `InsightWorkfolio-Backups` (the connection already exists; a tiny script with its own delegated token, or `rclone` with its own app registration). Hostinger weekly snapshot = second copy, not the only one;
  4. retention 30 daily + 12 monthly, local 7 days; disk-usage alert at 80 %.
- **Restore rehearsal**: restore into a new file, point a throwaway API at it with `NODE_ENV=production` verify-only boot, run `verify:turso`-style checks; record in docs.
- **Config backup**: `/etc/workfolio/*.env` listed by key names only (values are secrets, never backed up in clear); the Caddyfile and unit files are in the repo under `deploy/`.
- **OneDrive files**: Microsoft keeps deleted items in the recycle bin (93 days) — document; retention policy runs in the app only.

## 8. Documentation that currently claims Render/Vercel/Turso as selected

`README.md`, `docs/deployment.md` (whole page), `docs/setup.md`, `docs/architecture.md`, `docs/security.md`, `docs/database-operations.md`, `docs/master-checklist.md`, `docs/development-plan.md`, `docs/status/*` (historical), `render.yaml`, `.github/workflows/deploy-staging.yml`, `apps/api/.env.example`, `.env.example` comments in `env.ts`. Plan: add `docs/hostinger-vps.md` (the full guide), mark Hostinger as **selected** in `deployment.md`/README, mark Render/Vercel/Turso sections as *reference, not selected*, keep `render.yaml` and the workflow with a header note.

## 9. Remaining blockers (cannot be done from this machine)

| # | Blocker | Owner |
|---|---|---|
| 1 | Domain not purchased; DNS `app.`/`api.` A records | you |
| 2 | Entra app registration for OneDrive (tenant admin), client secret, redirect URI needs the domain | you / IT admin |
| 3 | VPS Phase 1B (snapshot, updates, `workfolio` user, SSH hardening, UFW, swap, Node, Caddy, **ffmpeg**, **sqlite3**) — awaiting your approval from the Phase 1 report | you → me |
| 4 | Decide the off-site backup destination (OneDrive sibling folder vs other) | you |
| 5 | First `db:migrate` on the VPS and first OneDrive connect are explicit-approval steps | you |

## 10. Proposed implementation phases (nothing started)

| Phase | Scope | Files |
|---|---|---|
| A | Database on the VPS: env accepts absolute `file:` in production; verify-only boot in production; WAL for `file:`; bind host; tests | `env.ts`, `prepare.ts`, `database.module.ts`, `main.ts`, `packages/database/src/index.ts`, 3 test files |
| B | Deploy assets in repo: `deploy/systemd/workfolio-api.service`, `workfolio-dashboard.service`, `deploy/caddy/Caddyfile`, `deploy/env/api.env.example`, `dashboard.env.example`, `deploy/scripts/{deploy.sh,backup-db.sh,restore-db.sh,healthcheck.sh}`, `workfolio-backup.timer` | new `deploy/` |
| C | Optional disk guard for timelapse jobs; `db:integrity` CLI (quick_check + FK check) | `timelapse.service.ts`, `cli/` |
| D | Docs: `docs/hostinger-vps.md` (full guide §10 of the brief), update README/deployment/setup/architecture/security/database-operations/onedrive/timelapse; header notes on `render.yaml` + deploy workflow | docs |
| E | Tests + builds: `pnpm test` (api, database), `next build` with `NEXT_PUBLIC_API_URL=https://api.example.com`, API build; report results verbatim | — |
| F | VPS Phase 1B + install (ffmpeg, sqlite3, Node 24, Caddy), deploy user, first migrate (approval), OneDrive connect (approval) | VPS via Brave terminal |

Phase A is the only one that changes application behaviour; it is small (≈60 lines) and fully covered by existing test patterns. Phases B–D are new files and docs. I will not start any of them without your go-ahead.
