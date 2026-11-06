#!/usr/bin/env bash
# Developer-machine self-test of the deploy scripts against a TEMPORARY database (never the VPS, never
# apps/api/data/dev.db). Needs: node >= 24, sqlite3, curl, and a built API (pnpm build:packages &&
# pnpm --filter @workfolio/api build). Run from anywhere: deploy/scripts/selftest.sh
#
# Checks, in order: db:migrate on a fresh production file (WAL on, migrations applied) -> backup-db.sh
# (consistent copy, integrity ok) -> restore-db.sh over a modified live file (sidecars moved aside, WAL set,
# API start skipped with SYSTEMCTL=:) -> restore of an older-schema backup stops with PENDING (exit 3) ->
# the API boots in production mode on the restored file, listens on 127.0.0.1 only, /health 200, /ready 503
# (OneDrive not connected) -> healthcheck.sh reports that as exit 2 -> monitor.sh (WARN, alert once, FAIL
# after the API stops) -> verify-backup.sh (restorable / pending / corrupt) -> backup-db.sh refuses to run an
# upload command for an unencrypted backup -> backup-upload CLI refuses an unencrypted file before any network.
# gpg encryption and a real OneDrive upload are not exercised here (no gpg on every developer machine, no tenant).
set -euo pipefail
here="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
api="$repo/apps/api"
[ -f "$api/dist/main.js" ] || { echo "build the API first: pnpm build:packages && pnpm --filter @workfolio/api build" >&2; exit 1; }
for t in node sqlite3 curl gzip; do command -v "$t" >/dev/null || { echo "$t missing" >&2; exit 1; }; done

tmp=$(mktemp -d "${TMPDIR:-/tmp}/workfolio-selftest.XXXXXX")
api_pid=""
holder=""
# `|| true`: under set -e a kill of an already-exited process inside the trap would turn a clean run into exit 1.
cleanup() { [ -z "$api_pid" ] || kill "$api_pid" 2>/dev/null || true; [ -z "$holder" ] || kill "$holder" 2>/dev/null || true; rm -rf "$tmp"; }
trap cleanup EXIT
port=$((20000 + RANDOM % 20000))
pass=0; fail=0
ok() { echo "  PASS: $*"; pass=$((pass + 1)); }
bad() { echo "  FAIL: $*" >&2; fail=$((fail + 1)); [ -n "${SELFTEST_DEBUG:-}" ] && [ -n "${debug_file:-}" ] && [ -f "$debug_file" ] && sed 's/^/      | /' "$debug_file" >&2; return 0; }
debug_file=""
check() { local msg=$1; shift; if "$@"; then ok "$msg"; else bad "$msg"; fi; }

# Production-shaped environment with placeholder (non-secret, non-working) OneDrive values: the API must
# boot with it; it just reports storage as not connected.
export WORKFOLIO_DATA="$tmp/data"
export WORKFOLIO_DB="$tmp/data/db/workfolio.db"
export WORKFOLIO_BACKUP_DIR="$tmp/backups"
export WORKFOLIO_API_DIR="$api"
export WORKFOLIO_API_ENV="$tmp/api.env"
export WORKFOLIO_API_URL="http://127.0.0.1:$port"
export SYSTEMCTL=:
# The developer machine's disk usage must not decide these checks (this Mac sits at 95 %).
export DISK_WARN_PERCENT=101 DISK_FAIL_PERCENT=101
mkdir -p "$tmp/data/db" "$tmp/data/secrets" "$tmp/data/tmp/timelapses" "$tmp/backups"
sed -e "s#^PORT=.*#PORT=$port#" \
    -e "s#^DATABASE_URL=.*#DATABASE_URL=file:$WORKFOLIO_DB#" \
    -e "s#^JWT_SECRET=.*#JWT_SECRET=selftest-only-$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')#" \
    -e "s#^ONEDRIVE_TOKEN_FILE=.*#ONEDRIVE_TOKEN_FILE=$tmp/data/secrets/onedrive.json#" \
    -e "s#^ONEDRIVE_TOKEN_KEY=.*#ONEDRIVE_TOKEN_KEY=$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')#" \
    -e "s#^TIMELAPSE_DIR=.*#TIMELAPSE_DIR=$tmp/data/tmp/timelapses#" \
    -e "s#^FFMPEG_PATH=.*#FFMPEG_PATH=ffmpeg#" \
    "$here/../env/api.env.example" > "$WORKFOLIO_API_ENV"
chmod 600 "$WORKFOLIO_API_ENV"
echo "temp dir $tmp, API port $port"

echo "1. db:migrate on a fresh production file"
out=$(cd "$api" && node --env-file="$WORKFOLIO_API_ENV" dist/cli/migrate.js --dry-run)
check "dry run lists pending migrations and writes nothing" bash -c "grep -q '^PENDING' <<<'$out' && [ ! -e '$WORKFOLIO_DB' ]"
out=$(cd "$api" && node --env-file="$WORKFOLIO_API_ENV" dist/cli/migrate.js)
check "real run applied migrations and switched to WAL" bash -c "grep -q '^APPLIED' <<<'$out' && grep -q '^Journal mode wal' <<<'$out' && grep -q '^Foreign keys enforced' <<<'$out'"
check "file is in WAL mode" test "$(sqlite3 "$WORKFOLIO_DB" 'PRAGMA journal_mode;')" = wal
schema=$(sqlite3 "$WORKFOLIO_DB" 'SELECT max(id) FROM schema_migrations;')

echo "2. backup-db.sh"
check "backup runs" "$here/backup-db.sh"
backup=$(ls -1 "$WORKFOLIO_BACKUP_DIR"/workfolio-*.db.gz | head -1)
check "backup file exists, mode 600" bash -c "[ -f '$backup' ] && [ \"\$(stat -f %Lp '$backup' 2>/dev/null || stat -c %a '$backup')\" = 600 ]"
check "backup is a valid gzip" gzip -t "$backup"
gzip -dc "$backup" > "$tmp/check.db"
check "backup copy passes integrity_check and carries the schema" bash -c "[ \"\$(sqlite3 '$tmp/check.db' 'PRAGMA integrity_check;')\" = ok ] && [ \"\$(sqlite3 '$tmp/check.db' 'SELECT max(id) FROM schema_migrations;')\" = '$schema' ]"
check "no stray temp dir left in the backup dir" bash -c "! ls -d '$WORKFOLIO_BACKUP_DIR'/.tmp-* 2>/dev/null"

echo "3. restore-db.sh over a modified live database (sidecars present)"
# A connection that stays open (like the running API on the VPS) so the -wal/-shm sidecars exist throughout:
# the last connection to close removes them, and restore-db.sh itself opens the live file for its log line.
node --input-type=module -e "
  import { createDatabase } from '$repo/packages/database/dist/index.js';
  const db = createDatabase({ url: 'file:$WORKFOLIO_DB' });
  await db.execute('CREATE TABLE selftest_marker (x INTEGER) STRICT');
  await db.execute('INSERT INTO selftest_marker VALUES (1)');
  setInterval(() => {}, 1000);
" &
holder=$!
for _ in $(seq 1 50); do [ -e "$WORKFOLIO_DB-wal" ] && [ -e "$WORKFOLIO_DB-shm" ] && break; sleep 0.1; done
check "live file has -wal/-shm sidecars before the restore (a connection is open)" test -e "$WORKFOLIO_DB-wal" -a -e "$WORKFOLIO_DB-shm"
check "restore completes (API start skipped: SYSTEMCTL=:)" "$here/restore-db.sh" "$backup" --yes
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null || true; holder=""
aside=$(ls -1d "$WORKFOLIO_BACKUP_DIR"/pre-restore-* | head -1)
ls -la "$aside" > "$tmp/aside.log" 2>&1; debug_file="$tmp/aside.log"
check "previous database moved aside with its sidecars" bash -c "[ -f '$aside/workfolio.db' ] && ls '$aside' | grep -qE 'workfolio.db-(wal|shm)'"
check "restored file is WAL, integrity ok, marker table gone (it is the backup, not the old file)" bash -c "[ \"\$(sqlite3 '$WORKFOLIO_DB' 'PRAGMA journal_mode;')\" = wal ] && [ \"\$(sqlite3 '$WORKFOLIO_DB' 'PRAGMA integrity_check;')\" = ok ] && [ \"\$(sqlite3 '$WORKFOLIO_DB' \"SELECT count(*) FROM sqlite_master WHERE name='selftest_marker';\")\" = 0 ]"
check "restored file mode 600" test "$(stat -f %Lp "$WORKFOLIO_DB" 2>/dev/null || stat -c %a "$WORKFOLIO_DB")" = 600

echo "4. restore of an older-schema backup stops before starting the API"
node --input-type=module -e "
  import { createDatabase, MIGRATIONS } from '$repo/packages/database/dist/index.js';
  import { createHash } from 'node:crypto';
  const db = createDatabase({ url: 'file:$tmp/older.db' });
  await db.execute(\"CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT 'x', checksum TEXT) STRICT\");
  for (const m of MIGRATIONS.slice(0, 3)) await db.batch([...m.statements, { sql: 'INSERT INTO schema_migrations (id, checksum) VALUES (?, ?)', args: [m.id, createHash('sha256').update(JSON.stringify(m.statements)).digest('hex')] }], 'write');
  db.close();
"
set +e
"$here/restore-db.sh" "$tmp/older.db" --yes > "$tmp/older.log" 2>&1
rc=$?
set -e
check "exit 3 with PENDING migrations listed" bash -c "[ $rc = 3 ] && grep -q '^PENDING' '$tmp/older.log' && grep -q 'left STOPPED' '$tmp/older.log'"
check "the older file was installed in WAL mode nonetheless (ready for db:migrate)" test "$(sqlite3 "$WORKFOLIO_DB" 'PRAGMA journal_mode;')" = wal
# put the full backup back for the boot test
"$here/restore-db.sh" "$backup" --yes > /dev/null

echo "5. API boots in production mode on the restored file, loopback only"
(cd "$api" && exec env NODE_ENV=production node --env-file="$WORKFOLIO_API_ENV" dist/main.js > "$tmp/api.log" 2>&1) &
api_pid=$!
for _ in $(seq 1 40); do
  curl -sf -o /dev/null "$WORKFOLIO_API_URL/api/v1/health" 2>/dev/null && break
  kill -0 "$api_pid" 2>/dev/null || break
  sleep 0.5
done
check "API process is up" kill -0 "$api_pid"
check "/api/v1/health is 200" test "$(curl -s -o /dev/null -w '%{http_code}' "$WORKFOLIO_API_URL/api/v1/health")" = 200
check "/api/v1/ready is 503 (OneDrive not connected: storage check down, database up)" bash -c "r=\$(curl -s -w ' %{http_code}' '$WORKFOLIO_API_URL/api/v1/ready'); [[ \$r == *'\"database\":{\"status\":\"up\"'* ]] && [[ \$r == *' 503' ]]"
check "startup log shows verify-only boot (no 'Applied migrations') and the schema version" bash -c "! grep -q 'Applied migrations' '$tmp/api.log' && grep -q 'Schema version $schema' '$tmp/api.log'"
if command -v lsof >/dev/null; then
  listen=$(lsof -nP -a -p "$api_pid" -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $9}' | tr '\n' ' ' || true)
  check "listening on 127.0.0.1:$port only (lsof: ${listen:-none})" bash -c "[[ '$listen' == *'127.0.0.1:$port'* ]] && [[ '$listen' != *'*:$port'* ]] && [[ '$listen' != *'[::]:$port'* ]]"
elif command -v ss >/dev/null; then
  listen=$(ss -ltnp 2>/dev/null | grep "pid=$api_pid," | awk '{print $4}' | tr '\n' ' ' || true)
  check "listening on 127.0.0.1:$port only (ss: ${listen:-none})" bash -c "[[ '$listen' == *'127.0.0.1:$port'* ]] && [[ '$listen' != *'*:$port'* ]]"
fi
set +e
"$here/healthcheck.sh" --no-dashboard > "$tmp/health.log" 2>&1
rc=$?
set -e
check "healthcheck.sh: exit 2 (healthy with the ready warning)" bash -c "[ $rc = 2 ] && grep -q 'api health: 200' '$tmp/health.log' && grep -q 'ready: 503' '$tmp/health.log'"

echo "6. monitor.sh: verdict, state, alert on change only"
export MONITOR_STATE_DIR="$tmp/monitor" ALERT_CMD="cat \"\$2\" >> '$tmp/alerts.log'" TIMELAPSE_DIR="$tmp/data/tmp/timelapses"
run_monitor() { set +e; "$here/monitor.sh" --no-dashboard > "$tmp/monitor.log" 2>&1; rc=$?; set -e; debug_file="$tmp/monitor.log"; }
run_monitor
check "API up but not ready: WARN (exit 2), alert sent once (state changed from the initial OK)" bash -c "[ $rc = 2 ] && grep -q '^WARN: health' '$tmp/monitor.log' && grep -q 'backup: a backup younger' '$tmp/monitor.log' && [ \"\$(grep -c 'workfolio .*: WARN' '$tmp/alerts.log')\" = 1 ]"
run_monitor
check "same verdict again: no second alert" test "$(grep -c '^workfolio .*: WARN' "$tmp/alerts.log")" = 1
BACKUP_MAX_AGE_HOURS=0 run_monitor
check "stale backup: FAIL (exit 1) and an alert" bash -c "[ $rc = 1 ] && grep -q 'FAIL: backup: no backup younger' '$tmp/monitor.log' && grep -q ': FAIL (was WARN)' '$tmp/alerts.log'"
kill "$api_pid" 2>/dev/null; wait "$api_pid" 2>/dev/null || true; api_pid=""
run_monitor
check "API down: FAIL with the health failure named" bash -c "[ $rc = 1 ] && grep -q 'FAIL: health: api health' '$tmp/monitor.log'"
unset MONITOR_STATE_DIR ALERT_CMD TIMELAPSE_DIR
debug_file=""

echo "7. verify-backup.sh (restore rehearsal on a copy; the live file is untouched)"
live_hash=$(shasum -a 256 "$WORKFOLIO_DB" 2>/dev/null | cut -d' ' -f1 || sha256sum "$WORKFOLIO_DB" | cut -d' ' -f1)
check "newest backup is restorable (exit 0, migration check clean)" bash -c "'$here/verify-backup.sh' > '$tmp/verify.log' 2>&1 && grep -q 'RESTORABLE' '$tmp/verify.log' && grep -q 'integrity ok' '$tmp/verify.log' && grep -q 'users: ' '$tmp/verify.log' && ! grep -q '^PENDING' '$tmp/verify.log'"
check "older-schema file: restorable but PENDING migrations are reported" bash -c "'$here/verify-backup.sh' '$tmp/older.db' > '$tmp/verify2.log' 2>&1 && grep -q 'PENDING' '$tmp/verify2.log' && grep -q 'would leave migrations pending' '$tmp/verify2.log'"
head -c 3000 "$WORKFOLIO_DB" > "$tmp/corrupt.db"
check "truncated file: exit 1" bash -c "! '$here/verify-backup.sh' '$tmp/corrupt.db' > '$tmp/verify3.log' 2>&1 && grep -q 'integrity_check' '$tmp/verify3.log'"
check "live database untouched by the rehearsals" test "$(shasum -a 256 "$WORKFOLIO_DB" 2>/dev/null | cut -d' ' -f1 || sha256sum "$WORKFOLIO_DB" | cut -d' ' -f1)" = "$live_hash"

debug_file="$tmp/verify2.log"
echo "8. off-site upload safety"
check "backup-db.sh refuses to run BACKUP_UPLOAD_CMD for an unencrypted backup (local file kept)" bash -c "! BACKUP_UPLOAD_CMD='touch $tmp/uploaded' '$here/backup-db.sh' > '$tmp/bk.log' 2>&1 && grep -q 'not encrypted' '$tmp/bk.log' && [ ! -e '$tmp/uploaded' ] && [ \"\$(ls -1 '$WORKFOLIO_BACKUP_DIR'/workfolio-*.db.gz | wc -l | tr -d ' ')\" = 2 ]"
set +e
out=$(cd "$api" && node --env-file="$WORKFOLIO_API_ENV" dist/cli/backup-upload.js upload "$backup" 2>&1); rc=$?
set -e
check "backup-upload CLI refuses an unencrypted file (exit 2) before touching OneDrive" bash -c "[ $rc = 2 ] && grep -q 'REFUSED' <<<'$out'"
set +e
out=$(cd "$api" && node --env-file="$WORKFOLIO_API_ENV" dist/cli/backup-upload.js check 2>&1); rc=$?
set -e
check "backup-upload CLI 'check' without a connection fails cleanly (exit 1, 'not connected', no secret echoed)" bash -c "[ $rc = 1 ] && grep -q 'not connected' <<<'$out' && ! grep -q 'REPLACE_CLIENT_SECRET' <<<'$out'"

echo "9. syntax of every script"
for s in "$here"/*.sh; do check "bash -n $(basename "$s")" bash -n "$s"; done

echo
echo "selftest: $pass passed, $fail failed"
[ "$fail" = 0 ]
