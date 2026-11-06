#!/usr/bin/env bash
# Restores a backup made by backup-db.sh into the live database path. Run as root on the VPS:
#
#   deploy/scripts/restore-db.sh /var/backups/workfolio/workfolio-<ts>.db.gz[.gpg] [--yes]
#
# Exact sequence (also in deploy/README.md "Restore"):
#   1. Unpack the backup into a private scratch directory and run PRAGMA integrity_check on it. Nothing live
#      is touched if this fails.
#   2. Stop the API (the dashboard may keep running; it only shows errors meanwhile).
#   3. Move the live database AND its -wal / -shm sidecars aside, together, into
#      $WORKFOLIO_BACKUP_DIR/pre-restore-<ts>/ (never deleted by this script or by retention).
#   4. Put the restored file in place: owner workfolio, mode 0600, then switch it to WAL mode EXPLICITLY here
#      (PRAGMA journal_mode=WAL) and check integrity again. The API never changes the journal mode itself: a
#      production boot is verify-only and would just warn.
#   5. db:migrate --dry-run against the restored file. If migrations are pending (a backup from an older
#      build), STOP: the API would refuse to start; the operator reviews and runs deploy.sh --migrate.
#   6. Start the API and run the health check.
. "$(dirname "$(readlink -f "$0")")/lib.sh"

backup=""
yes=0
for arg in "$@"; do
  case "$arg" in
    --yes) yes=1 ;;
    -*) die "unknown option $arg" ;;
    *) backup="$arg" ;;
  esac
done
[ -n "$backup" ] || die "usage: restore-db.sh <backup file> [--yes]"
[ -f "$backup" ] || die "no such file: $backup"
need "$SQLITE3"
need gzip
if [ "$SYSTEMCTL" != ":" ] && [ "$(id -u)" != 0 ]; then die "run as root (stops/starts the service and sets file ownership)"; fi

ts=$(date -u +%Y%m%dT%H%M%SZ)
work=$(mktemp -d "${TMPDIR:-/tmp}/workfolio-restore.XXXXXX")
chmod 700 "$work"
trap 'rm -rf "$work"' EXIT

# 1. unpack + verify
restored="$work/restored.db"
case "$backup" in
  *.gpg)
    need gpg
    [ -n "${BACKUP_GPG_PASSPHRASE_FILE:-}" ] || die "set BACKUP_GPG_PASSPHRASE_FILE to decrypt $backup"
    gpg --batch --quiet --passphrase-file "$BACKUP_GPG_PASSPHRASE_FILE" --decrypt "$backup" | gzip -dc > "$restored" ;;
  *.gz) gzip -dc "$backup" > "$restored" ;;
  *.db) cp "$backup" "$restored" ;;
  *) die "unsupported backup name (expected .db, .db.gz or .db.gz.gpg): $backup" ;;
esac
integrity_check "$restored"
log "backup verified: schema $(schema_version "$restored"), $(du -h "$restored" | cut -f1)"
if [ -f "$WORKFOLIO_DB" ]; then
  log "live database: schema $(schema_version "$WORKFOLIO_DB"), journal mode $(journal_mode "$WORKFOLIO_DB")"
fi
if [ "$yes" != 1 ]; then
  printf 'Replace %s with this backup? The current file is kept aside, not deleted. [y/N] ' "$WORKFOLIO_DB"
  read -r answer
  [ "$answer" = y ] || [ "$answer" = Y ] || die "aborted; nothing changed"
fi

# 2. stop the API
log "stopping $API_SERVICE"
svc stop "$API_SERVICE"

# 3. move the live file and its sidecars aside, together
aside="$WORKFOLIO_BACKUP_DIR/pre-restore-$ts"
mkdir -p "$aside"
chmod 700 "$aside"
for f in "$WORKFOLIO_DB" "$WORKFOLIO_DB-wal" "$WORKFOLIO_DB-shm" "$WORKFOLIO_DB-journal"; do
  [ -e "$f" ] && mv "$f" "$aside/"
done
log "previous database (with sidecars) kept at $aside"

# 4. install the restored file, WAL on, verify
mkdir -p "$(dirname "$WORKFOLIO_DB")"
cp "$restored" "$WORKFOLIO_DB"
chmod 600 "$WORKFOLIO_DB"
if [ "$(id -u)" = 0 ]; then chown "$WORKFOLIO_USER:$WORKFOLIO_USER" "$WORKFOLIO_DB"; fi
mode=$("$SQLITE3" "$WORKFOLIO_DB" "PRAGMA journal_mode=WAL;")
[ "$mode" = "wal" ] || die "could not switch the restored database to WAL (got '$mode')"
integrity_check "$WORKFOLIO_DB"
log "restored to $WORKFOLIO_DB: journal mode wal, integrity ok"

# 5. migration status of the restored schema
log "checking migrations (dry run, nothing written)"
if ! out=$(migrate_cli --dry-run 2>&1); then
  printf '%s\n' "$out"
  die "db:migrate --dry-run failed; the API is left STOPPED. Fix the cause, then: systemctl start $API_SERVICE"
fi
printf '%s\n' "$out"
if printf '%s\n' "$out" | grep -q '^PENDING'; then
  if [ "$(id -u)" = 0 ]; then chown "$WORKFOLIO_USER:$WORKFOLIO_USER" "$WORKFOLIO_DB" "$WORKFOLIO_DB"-* 2>/dev/null || true; fi
  warn "the restored database is behind this build: migrations are pending and the API is left STOPPED."
  warn "Review the list above, then apply with: $(dirname "$0")/deploy.sh --migrate-only   (it backs up first)"
  exit 3
fi

# 6. start + health. Root ran the checks above: any sidecar it left must belong to the service user.
if [ "$(id -u)" = 0 ]; then chown "$WORKFOLIO_USER:$WORKFOLIO_USER" "$WORKFOLIO_DB" "$WORKFOLIO_DB"-* 2>/dev/null || true; fi
log "starting $API_SERVICE"
svc start "$API_SERVICE"
if [ "$SYSTEMCTL" != ":" ]; then
  sleep 3
  "$(dirname "$0")/healthcheck.sh" --no-ready || die "the API did not come up after the restore; see journalctl -u $API_SERVICE"
fi
log "restore complete"
