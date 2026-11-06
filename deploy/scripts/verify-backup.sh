#!/usr/bin/env bash
# Restore REHEARSAL without touching the live database: proves that a backup file can actually be restored.
#
#   deploy/scripts/verify-backup.sh <backup file>            newest local file when omitted
#   BACKUP_GPG_PASSPHRASE_FILE=... deploy/scripts/verify-backup.sh <file>.gpg
#
# What it does, in a private temporary directory that is deleted afterwards:
#   1. decrypts (gpg) and unpacks (gzip) the file exactly as restore-db.sh would;
#   2. PRAGMA integrity_check must answer "ok"; prints schema version, journal mode, page count;
#   3. row counts of the main tables (users, employees, attendance sessions, screenshots), so an empty or
#      truncated copy is obvious;
#   4. db:migrate --dry-run of the CURRENT release against the copy: the restored schema must be known to
#      this build (no UNKNOWN/EDITED ids); PENDING ids are reported (an older backup would need deploy.sh
#      --migrate-only after a real restore).
# Exit 0 = the file is restorable; 1 = not. Nothing under /var/lib/workfolio is read or written; the API keeps
# running. Run it monthly on the newest backup and, every quarter, on a copy fetched back from the off-site
# folder (deploy/README.md "Restore rehearsal").
. "$(dirname "$(readlink -f "$0")")/lib.sh"

backup="${1:-}"
if [ -z "$backup" ]; then
  backup=$(ls -1t "$WORKFOLIO_BACKUP_DIR"/workfolio-*.db.gz* 2>/dev/null | head -1 || true)
  [ -n "$backup" ] || die "no backup in $WORKFOLIO_BACKUP_DIR; pass a file"
fi
[ -f "$backup" ] || die "no such file: $backup"
need "$SQLITE3"
need gzip

work=$(mktemp -d "${TMPDIR:-/tmp}/workfolio-verify.XXXXXX")
chmod 700 "$work"
trap 'rm -rf "$work"' EXIT
copy="$work/restored.db"

log "verifying $backup ($(du -h "$backup" | cut -f1))"
case "$backup" in
  *.gpg)
    need gpg
    [ -n "${BACKUP_GPG_PASSPHRASE_FILE:-}" ] || die "set BACKUP_GPG_PASSPHRASE_FILE to decrypt $backup"
    gpg --batch --quiet --passphrase-file "$BACKUP_GPG_PASSPHRASE_FILE" --decrypt "$backup" | gzip -dc > "$copy" || die "decrypt/unpack failed"
    log "decrypted with the passphrase file: the off-site copies are readable" ;;
  *.gz) gzip -dc "$backup" > "$copy" || die "unpack failed" ;;
  *.db) cp "$backup" "$copy" ;;
  *) die "unsupported backup name (expected .db, .db.gz or .db.gz.gpg): $backup" ;;
esac
chmod 600 "$copy"
integrity_check "$copy"
log "integrity ok; schema $(schema_version "$copy"); journal mode $(journal_mode "$copy"); $("$SQLITE3" "$copy" 'PRAGMA page_count;') pages"

for t in users employee_profiles attendance_sessions screenshots timelapses; do
  n=$("$SQLITE3" "$copy" "SELECT count(*) FROM $t;" 2>/dev/null || echo "table missing")
  log "  $t: $n"
done

if [ -f "$WORKFOLIO_API_DIR/dist/cli/migrate.js" ] && [ -r "$WORKFOLIO_API_ENV" ]; then
  log "db:migrate --dry-run of the current release against the copy (nothing written)"
  # DATABASE_URL in the environment wins over the --env-file value: the live database is never opened.
  if ! out=$(DATABASE_URL="file:$copy" migrate_cli --dry-run 2>&1); then
    printf '%s\n' "$out"
    die "this build does not accept the backup's schema (unknown or edited migration); it cannot be restored under this release"
  fi
  printf '%s\n' "$out" | grep -E '^(PENDING|UNKNOWN|EDITED|Applied)' || true
  if printf '%s\n' "$out" | grep -q '^PENDING'; then
    warn "restoring this backup would leave migrations pending: after restore-db.sh run deploy.sh --migrate-only"
  fi
else
  warn "no API build at $WORKFOLIO_API_DIR or no $WORKFOLIO_API_ENV: migration check skipped"
fi
log "RESTORABLE: $backup"
