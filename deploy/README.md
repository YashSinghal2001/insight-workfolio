# Hostinger VPS deployment assets

Everything the VPS runs is in this directory: systemd units, the Caddy reverse proxy, directory layout,
environment templates and the operator scripts. The narrative guide (why this architecture, DNS, OneDrive
setup, first deploy walkthrough, what is still blocked) is `docs/deployment.md`; this file is the reference
for what is here and how the pieces fit. Nothing in this directory contains a secret; the `*.example` files
are templates. Status: written and tested on a developer machine; **nothing has been installed on the VPS yet.**

| Path | Installed at | Purpose |
| --- | --- | --- |
| `systemd/workfolio-api.service` | `/etc/systemd/system/` | NestJS API, one process, `User=workfolio`, loopback `127.0.0.1:4000`, sandboxed |
| `systemd/workfolio-dashboard.service` | `/etc/systemd/system/` | Next.js `next start --hostname 127.0.0.1 --port 3000` |
| `systemd/workfolio-backup.service` + `.timer` | `/etc/systemd/system/` | nightly database backup (02:30 UTC), encrypted off-site copy |
| `systemd/workfolio-monitor.service` + `.timer` | `/etc/systemd/system/` | local monitor every 5 min: health, backups, OneDrive failures, disk, alerts |
| `tmpfiles/workfolio.conf` | `/etc/tmpfiles.d/` | directory layout, ownership, modes; 2-day age on the timelapse scratch dir |
| `journald/workfolio.conf` | `/etc/systemd/journald.conf.d/` | journal capped at 1 GB / 30 days |
| `caddy/Caddyfile` | `/etc/caddy/Caddyfile` | `app.<domain>` → `127.0.0.1:3000`, `api.<domain>` → `127.0.0.1:4000`, Let's Encrypt |
| `caddy/caddy-override.conf` | `/etc/systemd/system/caddy.service.d/override.conf` | lets Caddy read `WORKFOLIO_DOMAIN` / `ACME_EMAIL` |
| `caddy/workfolio.env.example` | `/etc/caddy/workfolio.env` | domain and ACME e-mail (not secret) |
| `env/api.env.example` | `/etc/workfolio/api.env` (root:workfolio 0640) | every API variable; secrets go here only |
| `env/dashboard.env.example` | `/etc/workfolio/dashboard.env` | `NEXT_PUBLIC_API_URL` (build-time) |
| `env/backup.env.example` | `/etc/workfolio/backup.env` | retention, encryption passphrase file, off-site upload command |
| `env/monitor.env.example` | `/etc/workfolio/monitor.env` | alert webhook / command, thresholds |
| `scripts/install-vps.sh` | run once as root | packages (ffmpeg, sqlite3, Node 24, Caddy, ufw, fail2ban), user, dirs, units, swap, firewall |
| `scripts/deploy.sh` | run as `workfolio` | build a git ref into a release, migration gate, switch `current`, restart, health check, rollback |
| `scripts/backup-db.sh` | timer / `deploy.sh --migrate` | online consistent backup, integrity check, gzip, gpg, off-site upload (encrypted only), retention |
| `scripts/restore-db.sh` | run as root | the restore sequence below |
| `scripts/verify-backup.sh` | monthly / quarterly rehearsal | proves a backup file is restorable on a copy; live database untouched |
| `scripts/healthcheck.sh` | deploy, restore, monitor | loopback health/ready/dashboard, service state, disk |
| `scripts/monitor.sh` | `workfolio-monitor.timer` | health + backup freshness + last backup result + OneDrive failures in the log + scratch size; alerts on change |
| `apps/api/src/cli/backup-upload.ts` (`dist/cli/backup-upload.js`) | `BACKUP_UPLOAD_CMD` | uploads an encrypted backup into the OneDrive `db-backups` folder using the API's own connection |
| `scripts/selftest.sh` | developer machine | migrate → backup → restore → production boot → health check → monitor → rehearsal → upload refusals, on a temporary database |
| `scripts/vps-audit.sh` | read-only | the Phase 1 server audit |
| `scripts/lib.sh` | sourced | shared paths and helpers; every path is overridable through the environment |

## Directory layout on the VPS

```
/opt/workfolio/                 workfolio   application code
  repo/                                     git clone (deploy.sh fetches here)
  releases/<ts>-<sha>/                      git archive + node_modules + builds (3 newest kept)
  current -> releases/...                   the release both units run from
  current.previous -> releases/...          rollback target
/etc/workfolio/                 root:workfolio 0750
  api.env  dashboard.env  backup.env  monitor.env   0640; the only place secrets live
/var/lib/workfolio/             workfolio 0750
  db/workfolio.db (+ -wal, -shm)            0700 dir, 0600 file: the production database (WAL mode)
  secrets/onedrive.json                     0700 dir: AES-256-GCM encrypted OneDrive refresh token
  secrets/backup-passphrase                 0600: gpg passphrase for backups (also kept in the password manager)
  tmp/timelapses/                           0700: FFmpeg scratch (<id>.mp4.part) only; emptied after each upload
  monitor/state                             monitor.sh's last verdict (for "alert on change")
/var/backups/workfolio/         workfolio 0700
  workfolio-<ts>.db.gz[.gpg]                nightly backups (BACKUP_KEEP_DAYS)
  pre-restore-<ts>/                         the database restore-db.sh replaced, with sidecars (never auto-deleted)
/var/log/caddy/                 caddy       access logs (50 MiB × 5)
journald                                    API and dashboard logs: journalctl -u workfolio-api / workfolio-dashboard
```

Screenshots and timelapse videos are **never** stored under any of these paths: the API uploads them to the
IT account's OneDrive and keeps only the encoder's temporary `.part` file while a video is being made.

## Network binding (what listens where)

| Listener | Address | Set by | Reached by |
| --- | --- | --- | --- |
| Caddy | `0.0.0.0:80`, `0.0.0.0:443` (+ IPv6) | Caddy defaults | the internet (UFW allows 22, 80, 443 only) |
| API | `127.0.0.1:4000` | `HOST`/`PORT` in `api.env` (`HOST` defaults to `127.0.0.1` in code too) | Caddy (`reverse_proxy 127.0.0.1:4000`), `healthcheck.sh`, `deploy.sh` |
| Dashboard | `127.0.0.1:3000` | `--hostname 127.0.0.1 --port 3000` in the unit (Next's own default would be `0.0.0.0`) | Caddy (`reverse_proxy 127.0.0.1:3000`), `healthcheck.sh` |
| SSH | `0.0.0.0:22` | sshd | admins |

`healthcheck.sh` and `lib.sh` use `http://127.0.0.1:4000` / `http://127.0.0.1:3000` and never a public
hostname. `TRUST_PROXY=loopback` makes the API accept `X-Forwarded-For` from Caddy only. `selftest.sh`
verifies with `lsof` that the API process has no listener on `*:<port>`.

## Install (once, as root, after the Phase 1B snapshot)

```bash
git clone git@github.com:YashSinghal2001/insight-workfolio.git /opt/workfolio/repo   # or as workfolio after useradd
/opt/workfolio/repo/deploy/scripts/install-vps.sh            # packages, user, dirs, units, swap, ufw, fail2ban
# fill in: /etc/workfolio/api.env, /etc/workfolio/dashboard.env, /etc/caddy/workfolio.env (domain first)
/opt/workfolio/repo/deploy/scripts/install-vps.sh --harden-ssh   # only after your key works for the admin user
```

`install-vps.sh` is idempotent, writes no secrets, never migrates or deploys, and validates the units
(`systemd-analyze verify`) and the Caddyfile (`caddy validate`) on the server, since neither tool exists on
a developer machine.

### FFmpeg

`apt install ffmpeg` on Ubuntu 24.04/26.04 provides FFmpeg built with **libx264** (H.264) and the
`webp_pipe` demuxer; `install-vps.sh` refuses to continue without both (`ffmpeg -encoders | grep libx264`).
`FFMPEG_PATH=/usr/bin/ffmpeg` in `api.env`; the API probes it at boot and, if it is unusable, keeps running
with the timelapse feature reporting itself unavailable (503 on create, warning in the dashboard).
Licensing: libx264 is GPL-2.0+ and H.264 is patent-encumbered. FFmpeg runs as a separate OS process
started by the API; it is neither linked into nor distributed with Workfolio, which is the arrangement
docs/timelapse.md describes. Resource bounds come from the app (`TIMELAPSE_LIMITS`: one job at a time, two
encoder threads, 150 MB output cap, 15 min per job) and from the unit's `MemoryMax`.

## Deploy, update, rollback (as `workfolio`)

```bash
deploy/scripts/deploy.sh                 # build origin/main; refuses to activate while migrations are pending
deploy/scripts/deploy.sh v1.2.0 --migrate   # back up, apply migrations, then activate
deploy/scripts/deploy.sh --rollback      # previous release; the schema is not rolled back (restore a backup for that)
deploy/scripts/deploy.sh --migrate-only  # after a restore of an older-schema backup
```

Order inside `deploy.sh`: clone/fetch → `git archive` the commit into `releases/<ts>-<sha>` → `pnpm install
--frozen-lockfile` → build packages, API, dashboard (`NEXT_PUBLIC_API_URL` read from `dashboard.env`) →
`db:migrate --dry-run` with the **new** build → (with `--migrate`: `backup-db.sh`, then `db:migrate`) →
switch `current` → restart API → `healthcheck.sh` → restart dashboard → `healthcheck.sh` → prune old
releases. A failed health check stops the script with the journal command to run; `--rollback` puts the
previous release back. The API itself never migrates at boot in production (`NODE_ENV=production` →
verify-only, see `apps/api/src/database/prepare.ts`): a release whose migrations were not applied refuses
to start and says so, it does not alter the database.

Each deploy restarts the API once (seconds of downtime; the desktop app retries). There is never a moment
with two API processes.

## Backups

`workfolio-backup.timer` runs `backup-db.sh` nightly at 02:30 UTC; `deploy.sh --migrate` runs it before
every migration. It uses sqlite3's **online backup API** (`.backup`), which reads a consistent snapshot
through the WAL while the API keeps writing, and produces one self-contained `.db` file (no `-wal`/`-shm`
sidecars), checked with `PRAGMA integrity_check`, gzip'd, gpg-encrypted (AES-256, symmetric, passphrase in
`BACKUP_GPG_PASSPHRASE_FILE`), `0600`, then handed to `BACKUP_UPLOAD_CMD`. Local retention: `BACKUP_KEEP_DAYS`
(30) nightly files; `pre-restore-*` directories are never auto-deleted. Every run is one `systemctl status
workfolio-backup` result; `monitor.sh` fails when the newest file is older than `BACKUP_MAX_AGE_HOURS` or the
last run did not succeed.

**Never copy `workfolio.db` with `cp`/`rsync` while the API runs**: in WAL mode the newest committed
pages may still be in `workfolio.db-wal`, so the `.db` file alone can be inconsistent. If you must copy the
raw files (e.g. moving the VPS), stop the API first and copy `.db`, `-wal` and `-shm` together, or use
`backup-db.sh`.

### Off-site copy: the company OneDrive, dedicated folder (selected)

Destination: the IT storage account's OneDrive that already holds screenshots, in its **own folder**
`<ONEDRIVE_ROOT_FOLDER>/<ONEDRIVE_BACKUP_FOLDER>` (default `InsightWorkfolio/db-backups`), a sibling of
`screenshots/` and `timelapses/`, never inside them. The uploader is the API's own CLI
(`dist/cli/backup-upload.js upload <file>`, `check`, `list`), which **reuses the API's OneDrive connection**:
the same app registration, the same delegated `Files.ReadWrite` scope, the same encrypted token file.
Evaluation against the alternatives:

- **No new credential.** `rclone` or a second app registration would mean a second refresh token for the same
  account to store, rotate and revoke. Reusing the connection keeps one secret (`onedrive.json`) and one
  permission to review in Entra.
- **Same containment.** The account's own OneDrive only; nothing tenant-wide. The backup folder is addressed by
  item ID under the app folder, so screenshots and timelapses are never listed or touched by the uploader.
- **Encrypted before it leaves.** The uploader refuses any file that is not `workfolio-<ts>.db.gz.gpg` with an
  OpenPGP packet as its first byte, and `backup-db.sh` refuses to run `BACKUP_UPLOAD_CMD` at all without
  `BACKUP_GPG_PASSPHRASE_FILE`. OneDrive therefore only ever holds ciphertext; the passphrase never goes there.
- **Shared token, two processes.** Microsoft rotates the refresh token on every use. Both the API and the
  uploader re-read the token file before each refresh and write the rotated token back atomically, so whichever
  process refreshed last is followed by the other (`apps/api/test/onedrive.e2e.test.ts` "off-site backups"
  proves the API keeps working after the CLI rotated the token). A refresh by both in the same second is the
  only race (nightly 02:30 vs the API's hourly refresh); the loser fails once and succeeds on its next try.
- **Retention off-site is opt-in.** `ONEDRIVE_BACKUP_KEEP_DAYS` unset (the default) means the uploader never
  deletes anything in OneDrive. When set, older `workfolio-*.db.gz.gpg` items in that folder go to the OneDrive
  recycle bin after each successful upload (recoverable there for the tenant's retention period).
- **Not a substitute for the VPS snapshot.** Hostinger's weekly snapshot (first one 2026-11-12) restores the
  whole server; the OneDrive copy restores the database alone, onto any host, with the passphrase.

Required configuration (no secrets in this repository):

| Where | Key | Value |
| --- | --- | --- |
| `api.env` | `ONEDRIVE_*` | the existing OneDrive connection values (docs/onedrive.md); nothing extra |
| `api.env` | `ONEDRIVE_BACKUP_FOLDER` | `db-backups` (must not be `screenshots` or `timelapses`; validated) |
| `api.env` | `ONEDRIVE_BACKUP_KEEP_DAYS` | unset, or e.g. `90` once off-site retention is approved |
| `backup.env` | `BACKUP_GPG_PASSPHRASE_FILE` | `/var/lib/workfolio/secrets/backup-passphrase` (0600 workfolio; generate with `openssl rand -base64 32 > …`, store a copy in the company password manager: **without it every backup is unreadable**) |
| `backup.env` | `BACKUP_UPLOAD_CMD` | the `backup-upload.js upload "$1"` line from `env/backup.env.example` |

First use (Phase F, after OneDrive is connected from the dashboard): `sudo -u workfolio bash -c 'cd
/opt/workfolio/current/apps/api && node --env-file=/etc/workfolio/api.env dist/cli/backup-upload.js check'`
creates the folder and proves the connection; then `sudo systemctl start workfolio-backup` and `… list`. Nothing
has been uploaded to the real OneDrive yet; the uploader is tested against the fake Microsoft in the API tests.

## Restore (exact sequence; `restore-db.sh` does this)

```bash
sudo deploy/scripts/restore-db.sh /var/backups/workfolio/workfolio-<ts>.db.gz        # add --yes to skip the prompt
# encrypted: BACKUP_GPG_PASSPHRASE_FILE=/var/lib/workfolio/secrets/backup-passphrase sudo -E deploy/scripts/restore-db.sh <file>.gpg
```

1. Unpack into a private scratch directory; `PRAGMA integrity_check` must be `ok`. Nothing live is touched if not.
2. `systemctl stop workfolio-api` (the dashboard keeps running and shows errors meanwhile).
3. Move `workfolio.db`, `workfolio.db-wal`, `workfolio.db-shm` **together** to `/var/backups/workfolio/pre-restore-<ts>/`. They are never deleted automatically.
4. Copy the restored file to `/var/lib/workfolio/db/workfolio.db`, `chown workfolio`, `chmod 600`, then **explicitly** `PRAGMA journal_mode=WAL` (must answer `wal`) and `integrity_check` again. This is the only place the journal mode is set outside `db:migrate`; a production API boot is verify-only and never changes the file (it only logs a warning if the mode is not WAL).
5. `db:migrate --dry-run` with the current release. If the backup is older than the build and migrations are **pending**, the script stops with exit 3 and leaves the API stopped: review, then `deploy.sh --migrate-only` (backs up the restored file first, migrates), then `systemctl start workfolio-api`.
6. `systemctl start workfolio-api`, `healthcheck.sh --no-ready` (storage readiness may be 503 until OneDrive is reconnected, which is not needed: the token file is separate from the database).

Screenshot and timelapse files are not part of the database backup: they are in OneDrive. A database
restored from before a deletion will reference files that are gone; the API treats a missing file as such
(404/410) and the sweep expires the video record.

## Restore rehearsal (proving the backups work)

`verify-backup.sh [file]` restores a backup **onto a temporary copy** (never the live file, the API keeps
running): decrypt + unpack exactly as `restore-db.sh` would, `PRAGMA integrity_check`, schema version, row
counts of the main tables, and `db:migrate --dry-run` of the current release against the copy (a backup from
an older build reports PENDING ids; an unknown/edited id means this release cannot restore it). Exit 0 =
restorable.

Schedule, recorded in the ops log (who, when, which file, result):

| When | What |
| --- | --- |
| nightly, automatic | `backup-db.sh` integrity-checks every copy before it is kept |
| monthly | `BACKUP_GPG_PASSPHRASE_FILE=… verify-backup.sh` on the newest **local** `.gpg` file (proves the passphrase still decrypts) |
| quarterly | download the newest file from the OneDrive `db-backups` folder to the VPS (or a laptop with sqlite3 + gpg + the passphrase) and run `verify-backup.sh` on **that** copy (proves the off-site path end to end) |
| before every migration-bearing deploy | `deploy.sh --migrate` takes a fresh backup first; keep the previous night's file until the deploy is confirmed |
| yearly, or after changing the restore script | full `restore-db.sh` rehearsal on a scratch path: `WORKFOLIO_DB=/var/lib/workfolio/db/rehearsal.db SYSTEMCTL=: restore-db.sh <file> --yes`, then delete the scratch file and its `pre-restore-*` directory |

`selftest.sh` runs the whole chain (backup → restore → boot → verify-backup) on a developer machine; it is the
rehearsal of the scripts, not of the production data.

## Monitoring and alerts

Two layers, because a monitor that runs on the VPS cannot report that the VPS is down:

1. **External uptime monitor** (Hostinger's, UptimeRobot, or any HTTPS poller; to be set up with the domain):
   `GET https://api.<domain>/api/v1/health` every 1–5 min, alert on non-200 or timeout. This is the only alarm
   for "the server/Caddy/network is down". Do **not** point it at `/ready` (an OneDrive blip must not page as an
   outage; `monitor.sh` covers readiness with context).
2. **`workfolio-monitor.timer`** → `monitor.sh` every 5 min as `workfolio`, one verdict per run:

| Check | WARN | FAIL |
| --- | --- | --- |
| `healthcheck.sh`: API `/health` | | not 200 |
| `/ready` (database ping + OneDrive lookup) | 503: database or storage check failing (OneDrive not connected / token revoked / Graph down) | other codes |
| dashboard `GET /` on 127.0.0.1:3000 | | not 2xx/3xx |
| `systemctl is-active` both units | | inactive/failed |
| data filesystem | ≥ `DISK_WARN_PERCENT` (80) | ≥ 95 % |
| newest local backup | | older than `BACKUP_MAX_AGE_HOURS` (30) |
| `workfolio-backup.service` last `Result` | | not `success` (a failed **off-site upload** ends here) |
| API journal, last `LOG_WINDOW_MINUTES`: `Screenshot storage failed`, `Timelapse upload to storage failed`, `Readiness check failed: storage`, `reconnect OneDrive` | any line | |
| API journal: `Timelapse refused: low disk space` | any line | |
| `TIMELAPSE_DIR` size | > `TIMELAPSE_SCRATCH_WARN_MB` (1024) | |

Alerts go out **on change of verdict** (OK → WARN/FAIL, back to OK) and every `ALERT_REPEAT_MINUTES` (360)
while FAIL persists, never on every run; the last verdict is in `/var/lib/workfolio/monitor/state`.
Destinations in `monitor.env`: `ALERT_WEBHOOK_URL` (JSON `{"text": …}`: Teams incoming webhook/Workflow, Slack,
ntfy, …) and/or `ALERT_CMD` (run as `bash -c "$ALERT_CMD" alert <subject> <body file>`, e.g. local `mail`).
Without either, the verdict is only logged: `journalctl -t workfolio-monitor`. The webhook URL is a secret
(0640 file); it is never printed. Run `deploy/scripts/monitor.sh` by hand for the current verdict.

OneDrive health beyond the log: the dashboard's Settings › Microsoft OneDrive page shows the connection, last
check, last error and quota (`GET /api/v1/storage/onedrive/status`, admin session). Quota is not polled by the
monitor (it would need an admin credential on the VPS).

## Logs, temporary files, disk

- API and dashboard: journald only (`journalctl -u workfolio-api -f`), JSON lines from pino with secrets
  redacted; `journald/workfolio.conf` caps the journal at 1 GB / 30 days.
- Caddy: `/var/log/caddy/*.access.log`, rolled at 50 MiB × 5 by Caddy itself.
- Timelapse scratch: `/var/lib/workfolio/tmp/timelapses` holds at most one `<id>.mp4.part` while a job
  runs (≤ 150 MB, ≤ 15 min); the API deletes it after the OneDrive upload and sweeps the directory every
  5 min and at boot; tmpfiles.d removes anything older than 2 days as a backstop; `monitor.sh` warns when the
  directory grows past `TIMELAPSE_SCRATCH_WARN_MB`.
- Disk-capacity protection for encodes: with `TIMELAPSE_MIN_FREE_MB` (2048 in `api.env.example`; code default
  1024, `0` = off) the API refuses to queue or encode a video while the scratch filesystem has less than that
  plus one maximum video (150 MB) free: 503 "low on disk space" to the admin, the job marked FAILED with the
  same reason, a warning in the log. The database shares that disk; an encode can never fill it.
- Releases: three newest kept by `deploy.sh`; each is ≈ 1 GB with `node_modules`.
- Backups: `BACKUP_KEEP_DAYS` (30) nightly files; `pre-restore-*` directories are manual cleanup.
- `healthcheck.sh` warns at 80 % and fails at 95 % disk use; `backup-db.sh` warns at `DISK_WARN_PERCENT`;
  `monitor.sh` turns both into alerts. Sizing: database ≈ tens of MB for the pilot, backups ≈ 30 × gzip'd
  size, releases 3 × ≈ 1 GB, journal ≤ 1 GB, swap 2 GB: well inside the 100 GB disk.

## Health checks

| Endpoint | Meaning | Who calls it |
| --- | --- | --- |
| `GET /api/v1/health` (loopback) | liveness: process up | `healthcheck.sh`, `deploy.sh`, `restore-db.sh` |
| `GET /api/v1/ready` (loopback) | database ping + storage lookup; 503 until OneDrive is connected | `healthcheck.sh` (warning only with `--no-ready`), `monitor.sh` |
| `GET https://api.<domain>/api/v1/health` | the public liveness URL | the external uptime monitor (see "Monitoring and alerts") |
| `GET /` on `127.0.0.1:3000` | dashboard serves | `healthcheck.sh` |
| `systemctl is-active` both units, disk % | | `healthcheck.sh`, `monitor.sh` |

## What has been tested where

- `selftest.sh` on a developer machine (macOS, sqlite3 3.54, Node 26): 42 checks pass, covering
  `db:migrate` (WAL on, verify-only boot), `backup-db.sh`, `restore-db.sh` (sidecars aside, WAL set, pending
  migrations stop with exit 3), production boot of the API on the restored file with the `api.env.example`
  shape, loopback-only listening (`lsof`), `healthcheck.sh` exit codes, `monitor.sh` (WARN/FAIL verdicts, alert
  on change only, stale-backup and API-down failures), `verify-backup.sh` (restorable, pending, truncated; live
  file hash unchanged), `backup-db.sh` refusing an upload command for an unencrypted file, the upload CLI
  refusing an unencrypted file and failing cleanly without a connection, `bash -n` on every script.
- `backup-upload.js` against the **fake** Microsoft Graph in `apps/api/test/onedrive.e2e.test.ts`: refusals,
  folder creation beside screenshots/timelapses, resumable upload, size check, shared-token rotation, opt-in
  retention, env validation of the folder name. **Never run against the real OneDrive.**
- `gpg` encryption/decryption is not exercised by `selftest.sh` (gpg is not installed on this developer
  machine); the gpg command lines are the standard symmetric form and run on the VPS, where `install-vps.sh`
  installs `gnupg`. The first VPS backup run must be checked by hand (`verify-backup.sh` on the `.gpg` file).
- `deploy.sh` end-to-end (clone → install → build → migrate → activate) against an isolated snapshot
  clone with `SYSTEMCTL=:`; the restart/health step necessarily fails there (no service manager).
- Not testable here, validated by `install-vps.sh` on the server: `systemd-analyze verify` of the units
  (including the monitor and backup sandboxes), `caddy validate` of the Caddyfile, `visudo -c` of the sudoers
  rule, `ffmpeg` capability probe, journal access of the `workfolio` user, the alert webhook.
