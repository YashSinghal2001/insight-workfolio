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
