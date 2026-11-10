# shellcheck shell=bash
# Shared defaults and helpers for deploy/scripts/*.sh. Every path can be overridden through the environment
# (selftest.sh does that to run the scripts against a temporary database on a developer machine).
set -euo pipefail

: "${WORKFOLIO_USER:=workfolio}"
: "${WORKFOLIO_ROOT:=/opt/workfolio}"
: "${WORKFOLIO_ENV_DIR:=/etc/workfolio}"
: "${WORKFOLIO_DATA:=/var/lib/workfolio}"
: "${WORKFOLIO_DB:=$WORKFOLIO_DATA/db/workfolio.db}"
: "${WORKFOLIO_BACKUP_DIR:=/var/backups/workfolio}"
# The release currently serving (deploy.sh switches this symlink); the API's build lives under it.
: "${WORKFOLIO_API_DIR:=$WORKFOLIO_ROOT/current/apps/api}"
: "${WORKFOLIO_API_ENV:=$WORKFOLIO_ENV_DIR/api.env}"
# Loopback only, everywhere (systemd units, Caddyfile, health checks): never a public address.
: "${WORKFOLIO_API_URL:=http://127.0.0.1:4000}"
: "${WORKFOLIO_DASHBOARD_URL:=http://127.0.0.1:3000}"
: "${API_SERVICE:=workfolio-api}"
: "${DASHBOARD_SERVICE:=workfolio-dashboard}"
# Tools (overridable for tests: SYSTEMCTL=: skips service control).
: "${SYSTEMCTL:=systemctl}"
: "${SQLITE3:=sqlite3}"
: "${NODE:=node}"

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
warn() { log "WARNING: $*" >&2; }
die() { log "ERROR: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed"; }

# `systemctl <verb> <unit>`; with SYSTEMCTL=: (tests) it is a no-op. Needs root or the sudoers rule from install-vps.sh.
svc() {
  if [ "$SYSTEMCTL" = ":" ]; then return 0; fi
  if [ "$(id -u)" = 0 ]; then "$SYSTEMCTL" "$@"; else sudo -n "$SYSTEMCTL" "$@"; fi
}

# PRAGMA integrity_check must answer exactly "ok"; anything else is a corrupt or truncated file.
integrity_check() {
  local result
  result=$("$SQLITE3" "$1" "PRAGMA integrity_check;") || die "integrity_check could not run on $1"
  [ "$result" = "ok" ] || die "integrity_check FAILED on $1: $result"
}

journal_mode() { "$SQLITE3" "$1" "PRAGMA journal_mode;"; }
schema_version() { "$SQLITE3" "$1" "SELECT coalesce(max(id), 'none') FROM schema_migrations;" 2>/dev/null || echo "no schema_migrations table"; }

# Percent used of the filesystem holding $1.
disk_used_percent() { df -P "$1" | awk 'NR==2 {gsub("%", "", $5); print $5}'; }

# The migrate CLI of the current release against the production env file; prints its output, returns its exit code.
migrate_cli() {
  [ -f "$WORKFOLIO_API_DIR/dist/cli/migrate.js" ] || die "no API build at $WORKFOLIO_API_DIR (run deploy.sh first)"
  [ -r "$WORKFOLIO_API_ENV" ] || die "cannot read $WORKFOLIO_API_ENV"
  # umask 077: the first run creates the database file; it must be 0600 whatever the caller's umask is.
  (umask 077; cd "$WORKFOLIO_API_DIR" && "$NODE" --env-file="$WORKFOLIO_API_ENV" dist/cli/migrate.js "$@")
}
# Note: helpers open files read-write on purpose. A read-only open (-readonly) of a WAL database fails with
# "unable to open database file" when its -shm sidecar is absent (after a clean close), and these PRAGMAs do
# not modify the database anyway; the transient sidecars are removed again when the connection closes.
