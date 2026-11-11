# Hostinger VPS deployment: implementation status (Phases A–D)

**Date:** 2026-11-06 · **Branch:** `deploy/hostinger-vps` (from `main` @ `ad869af`), **nothing committed, nothing
merged** · **VPS:** untouched since the read-only Phase 1 audit (`HOSTINGER-VPS-PHASE1-AUDIT.md`) · **OneDrive:**
not connected, nothing uploaded · **Staging Turso database:** untouched.

Selected architecture (brief of 2026-11-05, inspection in `HOSTINGER-VPS-ARCHITECTURE-INSPECTION.md`): the whole
application on one Hostinger VPS (API + dashboard as systemd services on loopback, Caddy + Let's Encrypt, one
persistent SQLite file in WAL mode), screenshots and timelapse videos only in the company OneDrive, encrypted
database backups in a dedicated OneDrive folder. Render + Vercel + Turso is the superseded previous plan.

Status key: ✅ done and tested here · ❓ done, only testable on the VPS / tenant · ⛔ blocked on an owner decision.

## 1. What was implemented

### Phase A: application changes (production on a local file)

| Change | File | Status |
|---|---|---|
| Production accepts `DATABASE_URL=file:/absolute/path` (relative `file:`, `:memory:`, `wss://` refused); `HOST` (default `127.0.0.1`) | `apps/api/src/config/env.ts` | ✅ |
| `NODE_ENV=production` ⇒ verify-only boot on any database (read-only migration status, refuse on pending/unknown/edited, warn if a file is not WAL, never writes); development migrates at boot as before | `apps/api/src/database/prepare.ts`, `database.module.ts` | ✅ |
| `db:migrate` switches a file to WAL before migrating (the only place besides `restore-db.sh`) | `apps/api/src/cli/migrate.ts`, `packages/database/src/index.ts` (`enableWal`, `journalMode`) | ✅ |
| API listens on `HOST`:`PORT` | `apps/api/src/main.ts` | ✅ |

### Phase B: deploy assets (`deploy/`)

systemd units (`workfolio-api`, `workfolio-dashboard`, hardened, loopback), Caddyfile (`app.`/`api.` →
127.0.0.1), tmpfiles layout, journald caps, env templates with placeholders only, `install-vps.sh`
(idempotent, root), `deploy.sh` (releases + migration gate + rollback), `backup-db.sh`, `restore-db.sh`,
`healthcheck.sh`, `selftest.sh`. Reference: `deploy/README.md`.

### Phase C: backups and monitoring

| # | Requirement | Implementation | Status |
|---|---|---|---|
| 1 | Automated database backups | `workfolio-backup.timer` (02:30 UTC, persistent) → `backup-db.sh`: sqlite3 online backup API, one self-contained file; also before every migration (`deploy.sh --migrate`) | ✅ |
| 2 | SQLite integrity verification | `PRAGMA integrity_check` on every backup copy, on the restored file (before and after install), in every rehearsal; the API's verify-only boot checks schema/checksums/foreign keys | ✅ |
| 3 | GPG encryption | `gpg --symmetric --cipher-algo AES256` with `BACKUP_GPG_PASSPHRASE_FILE` (0600, `/var/lib/workfolio/secrets/backup-passphrase`); decrypt path in `restore-db.sh` and `verify-backup.sh` | ❓ gpg is not installed on this Mac: command lines reviewed, not executed; `install-vps.sh` installs `gnupg` |
| 4 | Off-site upload | **Company OneDrive, dedicated folder** `InsightWorkfolio/db-backups` (sibling of `screenshots/` and `timelapses/`, never inside them), through the API's own connection: new CLI `apps/api/src/cli/backup-upload.ts` (`upload`, `check`, `list`), wired as `BACKUP_UPLOAD_CMD`. Refuses any file that is not `workfolio-<ts>.db.gz.gpg` with an OpenPGP packet first; `backup-db.sh` refuses to run any upload command without the passphrase file. Size confirmed by Graph must match or the remote item is removed. Evaluation and required configuration (no secrets): `deploy/README.md` "Off-site copy" | ✅ against the fake Graph; ❓ never run against the real OneDrive |
| 5 | Retention and rotation | Local: `BACKUP_KEEP_DAYS` (30) nightly files, `pre-restore-*` never auto-deleted. Off-site: `ONEDRIVE_BACKUP_KEEP_DAYS`, **unset by default = the uploader never deletes anything**; when set, older backups go to the OneDrive recycle bin after a successful upload | ✅ |
| 6 | Restore verification and rehearsal | `verify-backup.sh [file]`: decrypt + unpack to a temporary copy, integrity, schema, row counts, `db:migrate --dry-run` of the current release; live file never opened. Schedule (nightly auto / monthly local / quarterly from OneDrive / yearly full `restore-db.sh` on a scratch path) in `deploy/README.md` "Restore rehearsal" | ✅ |
| 7 | Disk-space monitoring and alerts | `healthcheck.sh` (warn ≥ 80 %, fail ≥ 95 %), `backup-db.sh` warning, `monitor.sh` alerts | ✅ |
| 8 | API and dashboard health monitoring | `workfolio-monitor.timer` (5 min) → `monitor.sh`: `/health`, `/ready`, dashboard, `systemctl is-active`, disk, newest backup age (`BACKUP_MAX_AGE_HOURS`), last backup run `Result`; alerts on change of verdict via `ALERT_WEBHOOK_URL` (JSON `{"text"}`) and/or `ALERT_CMD`, repeat every `ALERT_REPEAT_MINUTES` while FAIL; state in `/var/lib/workfolio/monitor/`. Plus the documented external uptime monitor on `https://api.<domain>/api/v1/health` (the only alarm for a dead VPS) | ✅ local; ❓ webhook delivery and journal access on the VPS |
| 9 | OneDrive storage/upload failure monitoring | `/ready` 503 (storage probe) → WARN; API journal scan each run for `Screenshot storage failed`, `Timelapse upload to storage failed`, `Timelapse delete from storage failed`, `Readiness check failed: storage`, `reconnect OneDrive` → WARN; failed off-site backup upload → backup unit `Result` ≠ success → FAIL; dashboard Settings › OneDrive shows connection/last error/quota. `workfolio` user added to `systemd-journal` by `install-vps.sh` | ✅ local (journal path ❓ on the VPS) |
| 10 | FFmpeg temp cleanup and disk-capacity protection | Existing: API deletes the `.part` after upload, sweeps orphans every 5 min and at boot; tmpfiles.d age 2 days. New: **disk guard** `TIMELAPSE_MIN_FREE_MB` (code default 1024, template 2048): while the scratch filesystem has less than that + one maximum video free, `POST /timelapses` answers 503 "low on disk space", automatic jobs fail with the same reason, a warning is logged; `monitor.sh` warns on those log lines and when the scratch directory exceeds `TIMELAPSE_SCRATCH_WARN_MB` | ✅ |

Supporting change: `OneDriveService.refresh()` now re-reads the encrypted token file before every refresh, so
the API and the backup uploader (two processes sharing one connection) follow whichever rotated the refresh
token last. `ensureSubfolder()` added for the backup folder. No other change to the OneDrive integration.

Dropped from the original Phase C sketch: a separate `db:integrity` Node CLI, redundant with the sqlite3
`integrity_check` that every backup, restore and rehearsal already runs.

### Phase D: documentation

| File | Change |
|---|---|
| `docs/deployment.md` | Rewritten head: Hostinger VPS + local SQLite + OneDrive **selected**; "What runs where" for the VPS; safeguards, configuration, backup/restore updated; new "Hosting: Hostinger VPS" walkthrough (topology, DNS, install, first deploy, updates, monitoring); Render/Vercel/Turso kept as "Previous plan (superseded)"; new "Before the VPS install" list |
| `docs/database-operations.md` | New "Production on the VPS: local SQLite file" table (location, WAL, verify-only, migrate, backups, off-site, integrity, restore, rehearsal, monitoring); migration policy table by URL **and** `NODE_ENV`; Turso runbooks marked "Previous plan" |
| `deploy/README.md` | Table rows for the new units/scripts/CLI; "Off-site copy" evaluation + configuration; "Restore rehearsal" schedule; "Monitoring and alerts" (two layers, check table, alert semantics); disk guard; test coverage |
| `README.md`, `docs/architecture.md`, `docs/setup.md`, `docs/security.md`, `docs/onedrive.md`, `docs/timelapse.md`, `docs/master-checklist.md` (rows 24, 33) | Hostinger selected, Turso/Render as previous plan; backup folder; disk guard; VPS secret locations |
| `render.yaml`, `.github/workflows/deploy-staging.yml` | "SUPERSEDED" header: previous plan, not to be enabled |
| `HOSTINGER-VPS-ARCHITECTURE-INSPECTION.md` | Update note pointing here |

## 2. Verification run on this machine (2026-11-06)

| Check | Result |
|---|---|
| `pnpm --filter @workfolio/database test` | 49 / 49 pass |
| `pnpm --filter @workfolio/api test` (nest build + all suites) | 423 tests: 420 pass; the 3 failures were in `screenshots-gallery.e2e.test.ts`, a **pre-existing flake** (a random screenshot UUID containing `401` matched the assertion's `/401|token|identity/` against the whole response body, and the two following tests cascade); that file passes 3 / 3 on rerun, unrelated to this work |
| `apps/api/test/onedrive.e2e.test.ts` (fake Microsoft; includes the new backup-upload test) | 10 / 10 pass |
| `apps/api/test/timelapse.e2e.test.ts` (includes the disk guard test) | 14 / 14 pass |
| `apps/api/test/env.test.ts` (new keys) | pass |
| `pnpm --filter @workfolio/api build`, `typecheck`, `lint` | pass |
| `NEXT_PUBLIC_API_URL=https://api.example.com pnpm --filter @workfolio/dashboard build` | pass (43 static pages) |
| `deploy/scripts/selftest.sh` | 42 / 42 pass (migrate → backup → restore with open connection and sidecars → older-schema exit 3 → production boot on loopback → healthcheck 2 → monitor WARN/alert-once/FAIL → verify-backup restorable/pending/truncated with the live file hash unchanged → upload refusals → `bash -n`) |
| `bash -n` on every script | pass |
| Developer machine note | the Mac's data volume is at 95 % (10 GB free), which first showed up as a real `healthcheck.sh` disk FAIL inside the selftest; the selftest now pins `DISK_WARN_PERCENT`/`DISK_FAIL_PERCENT` to 101 so the host's disk does not decide its result |
| `git diff --check` | clean |
| shellcheck | not installed here (not run) |

Bugs found by these runs and fixed before this report: 32-bit shift overflow in the disk-guard message; a test
that left the guard tripped; the selftest's reliance on sidecar files that the sqlite3 CLI removes on close.

## 3. Security review (scripts and secret handling)

- **No secret in the repository**: templates carry `REPLACE_…` placeholders; `.gitignore` excludes `.env*`,
  `*.db`, keys. `backup-upload.js` prints the account email and folder only; the token key, client secret and
  tokens never reach stdout (asserted in the test). `monitor.sh` never prints the webhook URL.
- **Trust boundary of the operator env files**: `BACKUP_UPLOAD_CMD` and `ALERT_CMD` are executed with
  `bash -c` by design (operator-chosen commands). They come from `/etc/workfolio/*.env`, root-owned 0640, so
  only root can change them; the `workfolio` user cannot escalate through them (`NoNewPrivileges`, sudoers
  limited to four `systemctl` verbs). Documented in the templates.
- **No remote script execution**: the NodeSource `curl | bash` installer was replaced by the keyring + sources
  entry; Caddy's repo is added the same way; the nodejs.org tarball fallback checks `SHASUMS256.txt` (not GPG-
  signed verification: accepted for a fallback path, noted here).
- **`rm -rf` targets** are only the scripts' own `mktemp` directories and `deploy.sh`'s pruned release
  directories (never `current`/`previous`).
- **Encryption before export**: two independent refusals (script and uploader) keep plaintext backups on the
  VPS; the passphrase file is 0600 under a 0700 directory and must also be in the password manager.
- **Sandboxing**: backup and monitor units run as `workfolio` with `ProtectSystem=strict`, `ProtectHome`,
  `PrivateTmp`, `NoNewPrivileges`, write access only to their own directories (backup: backups, db sidecars,
  secrets for token rotation; monitor: its state dir).
- **Journal access**: `workfolio` joins `systemd-journal` (read-only access to all system logs on that host).
  Acceptable for a single-purpose server; the alternative (a root-run monitor) is worse.
- **Residual risks** (unchanged from Phase B, plus): `SystemCallFilter=@system-service` unverified with
  Node 24/FFmpeg on Ubuntu 26.04; concurrent refresh by API and uploader in the same second fails once
  (benign); OneDrive holds ciphertext only, but the account's OneDrive quota and Microsoft 365 retention policy
  apply to the backup folder too (owner to confirm).

## 4. What cannot be tested without the VPS, Caddy or the Microsoft tenant

| Item | Why | Where it gets verified |
|---|---|---|
| `systemd-analyze verify` of all six units, the sandbox options in practice | no systemd here | `install-vps.sh` runs it; first start of each unit |
| `caddy validate`, certificate issuance, HSTS | no Caddy, no domain | `install-vps.sh`, first HTTPS request |
| `visudo -c`, `usermod -aG systemd-journal`, `journalctl` access as `workfolio` | no sudo/journald here | `install-vps.sh`; `monitor.sh` reports "cannot read the API journal" if not |
| gpg encryption and decryption of a real backup | gpg not installed here | first `systemctl start workfolio-backup`, then `verify-backup.sh` on the `.gpg` file |
| OneDrive: folder creation, upload, token rotation across the two processes, `list`, retention | no tenant; fake Graph only | after the connect: `backup-upload.js check`, first backup run, `list`; `verify:onedrive` |
| Alert delivery (Teams/Slack webhook, mail) | no destination | after `monitor.env` is filled: force a verdict change (stop the API for a minute) |
| NodeSource packages for Ubuntu 26.04 | unknown until tried | `install-vps.sh` falls back to the checksummed tarball |
| Memory/CPU of the FFmpeg encode under the unit's `MemoryMax` | no VPS | first timelapse on the VPS |

## 5. Blockers (owner decisions and external prerequisites)

1. ⛔ **Domain + DNS** (`app.`/`api.` → `189.72.144.117`); Caddy and the OneDrive redirect URI depend on it.
2. ⛔ **Entra app registration** for OneDrive (tenant admin), then the IT storage account's one-time sign-in
   (explicit approval; normal Chrome profile for Microsoft, Brave for the VPS, per the browser rules).
3. ⛔ **Approval for VPS Phase 1B/F**: Hostinger snapshot → `install-vps.sh` → env files → `deploy.sh --migrate`
   (creates the production database; explicit approval for this first migration) → first admin → OneDrive
   connect → first backup + upload → monitor + external uptime monitor → `--harden-ssh`.
4. ⛔ **Off-site retention**: keep `ONEDRIVE_BACKUP_KEEP_DAYS` unset (never delete) or choose a period.
5. ⛔ **Alert destination** (Teams/Slack webhook or mail) and the external uptime monitor account.
6. ⛔ **Git remote**: `deploy.sh` clones from `WORKFOLIO_REPO_URL`; the repository is local only today, and the
   Phase A–D work is uncommitted on `deploy/hostinger-vps`.
7. HR/Legal items unchanged (notice wording, retention periods, FFmpeg/libx264 licensing acceptance).

## 6. Deployment record: first production launch, 2026-11-10

**Live at `https://189.72.144.117`** (single origin on the VPS public IP, no domain). Deployed commit `2cceaa1`
from `origin/deploy/hostinger-vps`; release `/opt/workfolio/releases/20261110T071831Z-2cceaa1bb073`. Not merged
into `main`. hPanel snapshot taken 2026-11-10 before the first change.

| Step | Result |
|---|---|
| Root pre-checks | `sshd -T`: root login no, password auth no, pubkey yes; UFW active (22 → now 22/80/443); fail2ban sshd jail active; Docker active with 0 containers; kernel 7.0.0-42, no reboot pending |
| `install-vps.sh` | Caddy 2.11.9, sqlite3, ffmpeg 8.0.1 (libx264 + webp_pipe), directories, six units verified and enabled, sudoers `parsed OK`, journald limits, `workfolio` in `systemd-journal` |
| Certificate | Let's Encrypt, ACME profile `shortlived`, subject IP `189.72.144.117`, issuer YE2, valid 2026-11-10 → 2026-11-16, HTTP-01; trusted by curl/openssl from outside |
| Env files | `/etc/workfolio/*.env` 0640 root:workfolio; `JWT_SECRET`, `ONEDRIVE_TOKEN_KEY`, backup passphrase generated on the VPS and never displayed; OneDrive values are placeholders; `WEBSITE_*_APPROVED=false` |
| Migration (owner-approved gate) | dry run: applied 0, pending 26; then 26 applied, journal mode WAL, foreign keys enforced, schema `0028_auto_timelapse`; no prior database existed, so no pre-migration file backup (snapshot is the rollback) |
| Services | `workfolio-api` 127.0.0.1:4000, `workfolio-dashboard` 127.0.0.1:3000, Caddy 80/443; ports 3000/4000 closed from outside |
| Admin | `IT@TFFDigital.com`, role ADMIN / `SUPER_ADMIN`, password set by the owner through the one-time link (link never read by the operator); audit rows `ACCOUNT_CREATED`, `SETUP_LINK_ISSUED`, `PASSWORD_SET` |
| Cookies / headers | `wf_access` (Path=/api) and `wf_refresh` (Path=/api/v1/auth): `HttpOnly; Secure; SameSite=Strict`; HSTS, nosniff, frame deny, no-referrer, `no-store` on the API; unauthenticated API 401; foreign-origin preflight gets no allow-origin |
| Backup | `workfolio-backup` → `workfolio-20261110T071940Z.db.gz.gpg` (0600); `verify-backup.sh`: decrypts, integrity ok, RESTORABLE, applied 26 / pending 0. Local only: no off-site upload until OneDrive is connected |
| Monitoring | `workfolio-monitor.timer` every 5 min, verdict WARN (readiness 503: OneDrive not connected, expected); no alert destination configured yet (journal only) |
| Reboot test | site back ~20 s after going down; all units, both timers, UFW, fail2ban, swap active; 0 failed units; database WAL, `integrity_check` ok, files 0600; no sandbox errors in the API journal |
| Logs | no password, token or JWT patterns in the API/dashboard journal |
| Disabled by design | OneDrive (not connected), screenshots (no policy row), timelapses, website tracking |

Script bugs found on the real server and fixed during the rollout (commits `33c3bf8` … `2cceaa1`): `StartLimit*` in
the wrong unit section; `ffmpeg | grep -q` under `pipefail`; unit verification before the first release exists;
`caddy validate` as root creating a root-owned access log, and `reload` with `admin off`; API-only health check
testing the dashboard unit; gpg needing a private `GNUPGHOME` and `--pinentry-mode loopback` under `ProtectHome`;
database file created 0644 (now 0600, `umask 077` in `migrate_cli`).

Open after launch: store the backup passphrase in the password manager (`sudo cat
/var/lib/workfolio/secrets/backup-passphrase` on the VPS); alert destination in `monitor.env` and an external
uptime monitor on `https://189.72.144.117/api/v1/health`; new Entra registration and OneDrive connect (then off-site
backups, screenshots, timelapses); a domain (IP certificates renew every ~2 days and depend on Let's Encrypt and
port 80 staying reachable); `/home/workfolio/app` is now only the operator checkout (deploys build from
`/opt/workfolio/repo`); Docker keep/disable; merge into `main` on the owner's decision.

## 7. Post-launch audit, 2026-11-10 (read-only) and remaining work

Verified on the VPS and from outside, after the reboot test:

| Area | Finding | Status |
|---|---|---|
| Services / timers | Caddy, API, dashboard, backup timer, monitor timer, UFW, fail2ban, unattended-upgrades active; 0 failed units | VERIFIED |
| Exposure | UFW: OpenSSH, 80, 443 only; ports 3000, 4000 and Caddy's admin port closed from outside; unauthenticated API 401 | VERIFIED |
| Resources | disk 6.6 G of 96 G (7 %), RAM 680 MB used, swap unused, clock synchronized | VERIFIED |
| Updates | 14 packages upgradable (4 security); unattended-upgrades applies security updates; no reboot pending | VERIFIED (watch) |
| Backup files | passphrase file 0600 `workfolio`, secrets dir 0700, backup dir 0700, backup 0600, "PGP symmetric key encrypted data - AES with 256-bit key"; rehearsal RESTORABLE | VERIFIED |
| Backup automation | timer active, next run 2026-11-11 02:39 UTC; only a manual run has happened so far | NOT YET VERIFIED (first scheduled run) |
| Off-site copy | none: `BACKUP_UPLOAD_CMD` unset by design until OneDrive is connected. Hostinger snapshot of 2026-11-10 expires 2026-11-11; weekly Hostinger backups start on or after 2026-11-12 | OPEN RISK |
| Passphrase escrow | exists only on the VPS until the owner stores it in the password manager | PENDING (owner) |
| Certificate renewal | Let's Encrypt short-lived certificate valid to 2026-11-16 22:07 UTC; ARI renewal window 2026-11-13 13:01–16:12 UTC, Caddy selected 14:07 UTC | SCHEDULED, NOT YET VERIFIED |
| Logs | Caddy: 3 "connection refused" lines during the reboot only; API: only "Readiness check failed: storage" warnings (OneDrive off); no secrets in journals, shell history or deploy logs | VERIFIED |
| Monitor verdict | permanently WARN while OneDrive is disconnected (its own `/ready` probes produce the storage warnings), so new WARN-level problems would not change the verdict; FAIL conditions still do. No alert destination configured | OPEN (fix with the alert setup) |
| Unit sandboxing | API and dashboard exposure 1.7 (OK); backup and monitor units 8.3 (unprivileged user, `ProtectSystem=strict`, but fewer restrictions) | IMPROVE (low priority) |
| SSH | effective: root login no, password auth no; `MaxAuthTries` default 6; stale `PermitRootLogin yes` line in the main file overridden by the drop-in | VERIFIED (cosmetic cleanup open) |

Remaining work, in priority order:

1. Backup passphrase into the company password manager (owner; the only copy is on the VPS).
2. Alerts: ntfy topic (simplest; no account, phone push) through `ALERT_CMD`; make the monitor treat "OneDrive not
   connected" as expected while it is intentionally off; external uptime monitor on `/api/v1/health` (owner creates
   the account).
3. OneDrive: new Entra app registration (delegated `Files.ReadWrite`, Web redirect URI
   `https://189.72.144.117/api/v1/storage/onedrive/oauth/callback`; never the old app-only registration, SEC-11),
   real values into `api.env` by the owner, connect, `verify-onedrive`, then off-site backups; screenshots and
   timelapses stay off until separately approved. Whether Entra accepts an IP-literal redirect URI is unverified.
4. Observe the first scheduled backup (2026-11-11) and the first automatic certificate renewal (2026-11-13).
5. Hardening: backup/monitor unit sandbox, `MaxAuthTries`, Docker keep/disable.
6. Later: domain, merge into `main`, desktop release build for `https://189.72.144.117`, HR/Legal items.

## 8. Post-launch work completed, 2026-11-10 (later the same day)

Production release `565ba80` (script and documentation changes only; no application code changed).

| Item | Result | Status |
|---|---|---|
| Backup passphrase escrow | displayed once in the root console for the owner (never read by the operator), stored by the owner in the company password manager; screen, scrollback and shell history wiped | DONE (owner-confirmed) |
| Monitor verdict | `STORAGE_EXPECTED_DOWN=1` in `monitor.env` while OneDrive is intentionally off: verdict is now OK, so any new warning changes it and alerts. **Remove the flag when OneDrive is connected** | DONE |
| Alert channel: Microsoft Teams (primary) | Workflows flow "Post to a channel when a webhook request is received"; URL pasted by the owner into a hidden prompt on the VPS (`ALERT_TEAMS_WEBHOOK_URL`, never shown in chat, logs or Git); Adaptive Card; receives every event | DONE: test card confirmed visible by the owner |
| Alert channel: ntfy (secondary, phone) | random topic generated on the VPS (`ALERT_NTFY_URL`), owner subscribed in the ntfy app and stored the topic in the password manager; receives critical events only (FAIL, its repeats, recovery from FAIL) | DONE: test push confirmed by the owner |
| Independence and content | each channel is tried separately, failures are logged and do not stop the other; alerts carry severity, UTC time, server, affected services, failing checks, next-step commands; no secrets or personal data; URLs go to curl on stdin and are not logged (journal checked: 0 matches) | VERIFIED (selftest 49/49 with a fake endpoint; delivery by `--test-alert` per channel) |
| Schedules | monitor every 5 min, backup 02:30 UTC, certificate renewal by Caddy: unchanged | VERIFIED |

Not done on production on purpose: a real FAIL drill (stopping the API to trigger a critical alert) was not run;
the routing and failure independence are covered by the selftest, the delivery by the per-channel test messages.

Still open, in order: external uptime monitor on `https://189.72.144.117/api/v1/health` (owner creates the account);
OneDrive (new Entra registration, connect, then off-site backups; screenshots and timelapses only after separate
approval); first scheduled backup (2026-11-11 02:39 UTC) and first certificate renewal (2026-11-13 ~14:07 UTC) to be
observed; unit sandbox hardening for the backup and monitor units; domain; merge into `main`.

## 9. Uptime monitor and OneDrive / Entra audit, 2026-11-11 (read-only)

Nothing was changed on the VPS, in Microsoft 365 or in the application. Release still `565ba80`.

| Check | Evidence | Result |
|---|---|---|
| External uptime monitor (UptimeRobot) | Caddy access log: user agent `UptimeRobot/2.0`, `GET /api/v1/health`, first request 2026-11-10 09:58 UTC, one request every 5 minutes, 236 requests, 235 × 200 | POLLING VERIFIED. Alert contact not verified (the UptimeRobot dashboard was not visible to the operator) |
| The one non-200 | 502 at 05:43:51 UTC during an unclean guest restart of the VPS at about 05:43 UTC (journal of the previous boot ends without shutdown messages; hypervisor uptime unchanged; unattended-upgrades auto-reboot is off). UptimeRobot re-checked 15 s later: 200 | Cause of the restart not established (not issued from inside the OS). Recovery: API, dashboard and Caddy active within a few seconds, `PRAGMA quick_check` ok, monitor verdict OK, no failed units |
| First scheduled backup | `workfolio-20261111T023808Z.db.gz.gpg`, 02:38 UTC, encrypted, integrity ok, mode 0600; the 2026-11-10 file is still there | DONE (observed) |
| Production OneDrive configuration | `SCREENSHOT_STORAGE=onedrive`; redirect URI, account (`IT@TFFDigital.com`), root folder `InsightWorkfolio`, backup folder `db-backups`, token file path set; token key set (32 bytes); tenant ID, client ID and client secret still placeholders; no token file; `api.env` 0640 root:workfolio, secrets directory 0700; no `BACKUP_UPLOAD_CMD`; `STORAGE_EXPECTED_DOWN=1`; `/ready` 503 by design | NOT CONNECTED, as intended |
| Screenshots | `screenshot_policies`: 0 rows (the policy defaults to off), `screenshots`: 0 rows. Connecting OneDrive does not enable capture; that takes an admin policy change | OFF |
| Entra app registrations (portal, signed in as the IT account, view only) | Two live registrations: "TFF Website Mail" (unrelated) and "Insight Workfolio", created 2026-11-03: single tenant, Microsoft Graph **delegated** `Files.ReadWrite`, `offline_access`, `openid`, `profile` only, all granted for the tenant, no application permission, one client secret, **no redirect URI**. Deleted registrations: one older "Insight Workfolio" with a different client ID, deleted 2026-11-03 | The app-only `Sites.Selected` registration that SEC-11 is about no longer exists. The live one is already the delegated registration this mode needs: **use it, do not create a third**. It still needs the Web redirect URI and a client secret known to the VPS |

Corrections to earlier sections: §5, §7 and the readiness report say "a new Entra registration is required". That was
written from the repository documents; the portal shows the new delegated registration was already created on
2026-11-03 and the old app deleted the same day. Never restore the deleted registration (SEC-11).

Still unverified: whether Entra accepts the IP-literal redirect URI `https://189.72.144.117/api/v1/storage/onedrive/oauth/callback`
(Microsoft's redirect-URI page requires https and does not mention public IP addresses); that the IT account has a
provisioned OneDrive for Business (the adapter refuses anything else); the UptimeRobot alert contact.

Operational note from hPanel: the VPS plan expires 2026-12-05 and auto-renewal is off.

## 10. OneDrive connection, step 1: redirect URI and identifiers, 2026-11-11

Approved by the owner; limited to the existing delegated Entra registration "Insight Workfolio" (created 2026-11-03).

| Step | What was done | Verification |
|---|---|---|
| Redirect URI | Entra › App registrations › Insight Workfolio › Authentication: platform **Web**, `https://189.72.144.117/api/v1/storage/onedrive/oauth/callback`; implicit grant and hybrid flows left off; no logout URL | the portal accepted the IP-literal https URI (the open question of §9 is closed); the app overview shows "1 web, 0 spa, 0 public client"; permissions and the existing client secret untouched |
| Backup of the configuration | `/etc/workfolio/api.env.bak-20261111-pre-onedrive`, 0600 root:root, byte-identical to the file before the change | `cmp` |
| Identifiers | `ONEDRIVE_TENANT_ID` and `ONEDRIVE_CLIENT_ID` set to the values read from the app overview; nothing else changed | key-name diff against the backup: exactly these two keys, same line count; file still 0640 root:workfolio; `validateEnv` of the current release accepts the file; `ONEDRIVE_CLIENT_SECRET` still the placeholder |
| API | **not restarted** (start time unchanged, health 200): the running process still has the old values | `systemctl show`, `/api/v1/health` |

Next: the owner enters the existing client secret into a hidden prompt on the VPS (never in chat), then an API restart
(needs approval), Connect in the dashboard as the IT account, `verify-onedrive`. Off-site backups only after that.

### The restart of 2026-11-11 05:43 UTC, explained

hPanel › Latest Actions lists **"Restart VPS", Success, 2026-11-11 11:13:27 IST** (05:43:27 UTC): the restart was issued
with the Reboot button of the hPanel account. The guest-agent log shows two web-console launches from hPanel at
05:42:08 and 05:42:31 UTC just before it and one at 05:44:15 right after. Nothing inside the VPS caused it: no shutdown
sequence in the journal, no OOM, panic, watchdog or I/O error, no package activity, unattended-upgrades auto-reboot
off. The hPanel Reboot is a hard reset (the root filesystem journal was recovered at boot), not a clean shutdown; the
SQLite database passed `quick_check` and both backups are intact. For a planned restart use `systemctl reboot` in the
console instead. The single UptimeRobot 502 (05:43:51 UTC) was its check arriving two seconds after the API unit
started and before it listened; its re-check at 05:44:06 got 200.

## 11. OneDrive connected and verified, 2026-11-11

Client secret entered by the owner into a hidden prompt on the VPS (length only was displayed); Microsoft's token
endpoint accepted it before the restart. API restarted with the owner's approval at 06:35:58 UTC (API only). The owner
connected OneDrive in the dashboard as `IT@TFFDigital.com` at 06:39 UTC. No data was uploaded; Phase 4 not started.

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Connected account and drive | PASS | verifier: account `it@tffdigital.com`, the account's own OneDrive for Business, 0.00 GB of 1024 GB used, app folder `InsightWorkfolio` exists; API log "OneDrive connected" once |
| 2 | Token file | PASS | `/var/lib/workfolio/secrets/onedrive.json`, 0600 workfolio:workfolio, 1932 bytes, directory 0700 |
| 3 | Encrypted at rest | PASS | `file`: data; 0 matches for token, tenant, account or JWT markers; 0 printable runs of 16+ characters; 0 token or secret patterns in the API journal. Only the refresh token is stored; access tokens exist in memory only |
| 4 | Controlled refresh and persistence | PASS (API-side pickup NOT TESTED live) | three refreshes from separate processes: Microsoft rotated the refresh token each time, the file was rewritten atomically (hash and mtime changed, mode unchanged), and each later run succeeded with the token written by the previous one. The running API re-reads the file at its next refresh (about one hour after connect); to be re-checked at the start of Phase 4 |
| 5 | Verifier isolation probes | PARTIAL | `/sites/root` 403, `/sites?search=*` 403, `/users` 403, `/me/drive/sharedWithMe` 403; **`/me/insights/shared` 200**, so the script stopped with "boundary breach" (exit 4). Follow-up, status and counts only: that response is an empty list (0 items); the access token carries exactly `Files.ReadWrite openid profile email`; `/me/insights/trending` 401 |
| 6 | Readiness | PASS | `/api/v1/ready` 200: database up, storage up, provider `MICROSOFT_GRAPH` |
| 7 | Monitoring flag | ACTION NEEDED (not changed) | `STORAGE_EXPECTED_DOWN=1` is still set; verdict OK. With the flag set a lost OneDrive connection (`/ready` 503, database up) is logged as expected and does not warn. It must be removed now that OneDrive is connected; removal has no effect while `/ready` is 200 |
| 8 | Screenshots, timelapses, website tracking | PASS (all off) | `screenshot_policies` 0 rows, `screenshots` 0, `timelapses` 0, `website_policies` 0 rows; `WEBSITE_TRACKING_APPROVED=false`, `WEBSITE_RETENTION_APPROVED=false`; no upload lines in the API log |
| 9 | No backup or production data uploaded | PASS | no `BACKUP_UPLOAD_CMD`; `db-backups` folder not created; drive usage 0.00 GB |

About check 5: Microsoft Graph answers `/me/insights/shared` for a token that has only `Files.ReadWrite`; the list was
empty. The application never calls that endpoint. Residual exposure: if someone shares a file with the IT account, this
token could list that item's insight metadata (title, link, who shared it). Keep the IT account a storage-only account
that nothing is shared with. The verifier was not changed; whether to treat an empty answer as a pass is the owner's
decision.
