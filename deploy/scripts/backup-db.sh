#!/usr/bin/env bash
# Online, consistent backup of the live SQLite database (WAL mode), run nightly by workfolio-backup.timer
# as the workfolio user, or by hand before a migration (deploy.sh --migrate calls it).
#
# - Uses sqlite3's online backup API (`.backup`): a consistent snapshot read through the WAL while the API
#   keeps writing. NEVER `cp` the .db file: without its -wal sidecar the copy can be inconsistent.
# - The copy is one self-contained file (no -wal/-shm), integrity-checked, gzip'd, optionally gpg-encrypted,
#   mode 600, then handed to BACKUP_UPLOAD_CMD for the off-site copy (deploy/env/backup.env.example).
# - Exit code != 0 on any failure; the partial file is removed. Settings: BACKUP_KEEP_DAYS,
#   BACKUP_GPG_PASSPHRASE_FILE, BACKUP_UPLOAD_CMD, DISK_WARN_PERCENT (all optional).
. "$(dirname "$(readlink -f "$0")")/lib.sh"

need "$SQLITE3"
need gzip
[ -f "$WORKFOLIO_DB" ] || die "no database at $WORKFOLIO_DB"
: "${BACKUP_KEEP_DAYS:=30}"
: "${DISK_WARN_PERCENT:=80}"

ts=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$WORKFOLIO_BACKUP_DIR"
chmod 700 "$WORKFOLIO_BACKUP_DIR"
work="$WORKFOLIO_BACKUP_DIR/.tmp-$ts"
mkdir -m 700 "$work"
trap 'rm -rf "$work"' EXIT

copy="$work/workfolio-$ts.db"
log "backing up $WORKFOLIO_DB (journal mode $(journal_mode "$WORKFOLIO_DB"), schema $(schema_version "$WORKFOLIO_DB"))"
"$SQLITE3" "$WORKFOLIO_DB" ".backup '$copy'"
integrity_check "$copy"
version=$(schema_version "$copy")

gzip -9 "$copy"
file="$copy.gz"
if [ -n "${BACKUP_GPG_PASSPHRASE_FILE:-}" ]; then
  need gpg
  [ -r "$BACKUP_GPG_PASSPHRASE_FILE" ] || die "BACKUP_GPG_PASSPHRASE_FILE is not readable"
  # Private gpg home inside the work directory: the unit runs with ProtectHome (no ~/.gnupg), and symmetric
  # encryption needs no keyring. gpg >= 2.1 only reads --passphrase-file with --pinentry-mode loopback.
  export GNUPGHOME="$work/gnupg"
  mkdir -m 700 "$GNUPGHOME"
  gpg --batch --yes --quiet --pinentry-mode loopback --symmetric --cipher-algo AES256 --passphrase-file "$BACKUP_GPG_PASSPHRASE_FILE" --output "$file.gpg" "$file"
  gpgconf --kill gpg-agent >/dev/null 2>&1 || true
  rm -f "$file"
  file="$file.gpg"
fi
chmod 600 "$file"
final="$WORKFOLIO_BACKUP_DIR/$(basename "$file")"
mv "$file" "$final"
log "backup written: $final ($(du -h "$final" | cut -f1), schema $version, integrity ok)"

if [ -n "${BACKUP_UPLOAD_CMD:-}" ]; then
  # Only encrypted backups leave the VPS (personal data). The OneDrive uploader checks the file too.
  case "$final" in *.gpg) ;; *) die "BACKUP_UPLOAD_CMD is set but the backup is not encrypted (set BACKUP_GPG_PASSPHRASE_FILE); not uploading. The local backup is kept" ;; esac
  log "off-site upload: $BACKUP_UPLOAD_CMD"
  bash -c "$BACKUP_UPLOAD_CMD" upload "$final" || die "off-site upload failed (the local backup is kept)"
  log "off-site upload done"
elif [ -z "${BACKUP_GPG_PASSPHRASE_FILE:-}" ]; then
  warn "no BACKUP_UPLOAD_CMD: this backup exists only on this VPS (and in Hostinger's weekly snapshot)"
fi

# Retention: nightly files older than BACKUP_KEEP_DAYS go; pre-restore copies (restore-db.sh) are never touched here.
find "$WORKFOLIO_BACKUP_DIR" -maxdepth 1 -type f -name 'workfolio-*.db.gz*' -mtime +"$BACKUP_KEEP_DAYS" -print -delete | sed 's/^/removed old backup: /' || true

for path in "$WORKFOLIO_BACKUP_DIR" "$(dirname "$WORKFOLIO_DB")"; do
  used=$(disk_used_percent "$path")
  [ "$used" -ge "$DISK_WARN_PERCENT" ] && warn "filesystem of $path is ${used}% full"
done
exit 0
