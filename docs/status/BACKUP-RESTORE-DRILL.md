# Backup / restore drill (P7-08)

Date: 2026-11-20 (UTC) · Machine: developer Mac (macOS 27.2, sqlite3 3.54.0) · Branch `agent/w4-e2e` · Owner of the drill: W4-E2E.
**Local temporary database only — production was not touched.** Scripts: `deploy/scripts/{backup-db,verify-backup,restore-db}.sh`
exactly as shipped, pointed at a temporary directory through the overrides in `deploy/scripts/lib.sh`
(`WORKFOLIO_DB`, `WORKFOLIO_BACKUP_DIR`, `WORKFOLIO_API_DIR`, `WORKFOLIO_API_ENV`, `SYSTEMCTL=:` so no service is stopped/started).

## Result

**PASSED.** Backup → rehearsal → corruption (integrity_check fails: `database disk image is malformed`) → live file deleted →
`restore-db.sh` → restored file `PRAGMA integrity_check` = `ok`, `journal_mode` = `wal`, mode `0600`, `db:migrate --dry-run`
"Applied: 33; pending: 0", and per-table row counts identical before and after:

| Table | Before | After |
|---|---|---|
| users | 201 | 201 |
| employee_profiles | 200 | 200 |
| devices | 200 | 200 |
| attendance_sessions | 4283 | 4283 |
| break_sessions | 4142 | 4142 |
| activity_intervals | 99016 | 99016 |
| account_audit | 400 | 400 |
| schema_migrations | 33 | 33 |

Data: the synthetic 200-employee / 30-day database produced by `node apps/api/scripts/perf-parity.mjs --keep <path>` (P7-09),
85 MB uncompressed, 17 MB `.db.gz`. Timings: backup 3 s, rehearsal 1 s, restore 2 s.

Not covered here: the **gpg** leg (`BACKUP_GPG_PASSPHRASE_FILE`) — `gpg` is not installed on this Mac, so the backup was the
unencrypted `.db.gz` form; the encrypted path and the off-site upload refusal are covered by `deploy/scripts/selftest.sh`
and must be rehearsed on the VPS with `verify-backup.sh <newest>.db.gz.gpg` (deploy/README.md "Restore rehearsal").

## Exact commands

```bash
# 0. scratch environment ($DRILL = any empty temp directory outside the repo; $WT = the repository checkout)
mkdir -p $DRILL/run/data/db $DRILL/run/backups
export WORKFOLIO_DATA=$DRILL/run/data WORKFOLIO_DB=$DRILL/run/data/db/workfolio.db WORKFOLIO_BACKUP_DIR=$DRILL/run/backups
export WORKFOLIO_API_DIR=$WT/apps/api WORKFOLIO_API_ENV=$DRILL/run/api.env SYSTEMCTL=: DISK_WARN_PERCENT=101
sed -e "s#^DATABASE_URL=.*#DATABASE_URL=file:$WORKFOLIO_DB#" -e "s#^JWT_SECRET=.*#JWT_SECRET=drill-only-$(openssl rand -hex 24)#" \
    -e "s#^ONEDRIVE_TOKEN_KEY=.*#ONEDRIVE_TOKEN_KEY=$(openssl rand -base64 32)#" $WT/deploy/env/api.env.example > $WORKFOLIO_API_ENV
chmod 600 $WORKFOLIO_API_ENV

# 1. create: seeded database as the "live" file, then the production migrate CLI (sets WAL)
pnpm --filter @workfolio/api build
node $WT/apps/api/scripts/perf-parity.mjs --keep $DRILL/perf.db
cp $DRILL/perf.db $WORKFOLIO_DB
(cd $WORKFOLIO_API_DIR && node --env-file=$WORKFOLIO_API_ENV dist/cli/migrate.js)
counts() { for t in users employee_profiles devices attendance_sessions break_sessions activity_intervals attendance_events account_audit schema_migrations; do
  printf '%s=%s ' $t "$(sqlite3 "$1" "SELECT count(*) FROM $t;")"; done; echo; }
before=$(counts $WORKFOLIO_DB)

# 2. back up (sqlite3 online .backup → integrity_check → gzip, mode 600) and rehearse on a temp copy
$WT/deploy/scripts/backup-db.sh
b=$(ls -1 $WORKFOLIO_BACKUP_DIR/workfolio-*.db.gz | head -1)
$WT/deploy/scripts/verify-backup.sh "$b"

# 3. corrupt, then delete the live file
dd if=/dev/urandom of=$WORKFOLIO_DB bs=65536 seek=16 count=1 conv=notrunc
sqlite3 $WORKFOLIO_DB 'PRAGMA integrity_check;'        # → malformed
rm -f $WORKFOLIO_DB $WORKFOLIO_DB-wal $WORKFOLIO_DB-shm

# 4. restore (verify copy → move live + sidecars aside → install 0600 → WAL → integrity → migrate --dry-run)
$WT/deploy/scripts/restore-db.sh "$b" --yes

# 5. verify
after=$(counts $WORKFOLIO_DB); [ "$before" = "$after" ] && echo identical
sqlite3 $WORKFOLIO_DB 'PRAGMA integrity_check;'        # → ok
sqlite3 $WORKFOLIO_DB 'PRAGMA journal_mode;'           # → wal
```

## Log (paths shortened to `$DRILL`)

```
== 0. create: seeded perf database (200 employees, 30 days) as the live file, then db:migrate (WAL)
Journal mode wal
before: users=201 employee_profiles=200 devices=200 attendance_sessions=4283 break_sessions=4142 activity_intervals=99016 attendance_events=0 account_audit=400 schema_migrations=33 
== 1. backup-db.sh
[2026-11-20T09:39:37Z] backing up $DRILL/run/data/db/workfolio.db (journal mode wal, schema 0035_report_schedule_kinds)
[2026-11-20T09:39:39Z] backup written: $DRILL/run/backups/workfolio-20261120T093937Z.db.gz ( 18M, schema 0035_report_schedule_kinds, integrity ok)
[2026-11-20T09:39:39Z] WARNING: no BACKUP_UPLOAD_CMD: this backup exists only on this VPS (and in Hostinger's weekly snapshot)
-rw-------@ 1 yashsinghal  wheel  17726479 Nov 20 15:09 $DRILL/run/backups/workfolio-20261120T093937Z.db.gz
== 2. verify-backup.sh (rehearsal on a temp copy)
[2026-11-20T09:39:39Z] verifying $DRILL/run/backups/workfolio-20261120T093937Z.db.gz ( 18M)
[2026-11-20T09:39:40Z] integrity ok; schema 0035_report_schedule_kinds; journal mode wal; 21707 pages
[2026-11-20T09:39:40Z]   users: 201
[2026-11-20T09:39:40Z]   employee_profiles: 200
[2026-11-20T09:39:40Z]   attendance_sessions: 4283
[2026-11-20T09:39:40Z]   screenshots: 0
[2026-11-20T09:39:40Z]   timelapses: 0
[2026-11-20T09:39:40Z] db:migrate --dry-run of the current release against the copy (nothing written)
Applied: 33; pending: 0
[2026-11-20T09:39:40Z] RESTORABLE: $DRILL/run/backups/workfolio-20261120T093937Z.db.gz
== 3. corrupt the live file (overwrite 64 KiB at offset 1 MiB), then delete it
integrity after corruption: Error in 2nd command line argument: database disk image is malformed *** in database main *** Tree 143 page 272: btreeInitPage() returns error code 11 
live file deleted: ls: $DRILL/run/data/db/workfolio.db: No such file or directory
== 4. restore-db.sh <backup> --yes
[2026-11-20T09:39:41Z] backup verified: schema 0035_report_schedule_kinds,  85M
[2026-11-20T09:39:41Z] stopping workfolio-api
[2026-11-20T09:39:41Z] previous database (with sidecars) kept at $DRILL/run/backups/pre-restore-20261120T093940Z
[2026-11-20T09:39:42Z] restored to $DRILL/run/data/db/workfolio.db: journal mode wal, integrity ok
[2026-11-20T09:39:42Z] checking migrations (dry run, nothing written)
Target: local SQLite (dry run)
Applied: 33; pending: 0
Dry run: nothing was written.
[2026-11-20T09:39:42Z] starting workfolio-api
[2026-11-20T09:39:42Z] restore complete
== 5. verify
after:  users=201 employee_profiles=200 devices=200 attendance_sessions=4283 break_sessions=4142 activity_intervals=99016 attendance_events=0 account_audit=400 schema_migrations=33 
integrity: ok  journal: wal  mode: 600
RESULT: row counts identical — DRILL PASSED
```
