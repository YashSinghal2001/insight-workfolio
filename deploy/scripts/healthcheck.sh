#!/usr/bin/env bash
# Local health check, always against the loopback listeners (never the public hostnames):
#   API      GET http://127.0.0.1:4000/api/v1/health  (liveness: must be 200)
#            GET http://127.0.0.1:4000/api/v1/ready   (readiness: database + storage; 503 when OneDrive is not
#                                                      connected yet; skipped with --no-ready)
#   Dashboard GET http://127.0.0.1:3000/              (200 or a redirect)
#   Services  systemctl is-active (when systemd is present)
#   Disk      warns at DISK_WARN_PERCENT (default 80 %), fails at DISK_FAIL_PERCENT (default 95 %) for the data filesystem.
# Exit 0 = healthy, 1 = something is down, 2 = healthy with warnings. Used by deploy.sh and restore-db.sh;
# wire it to an external uptime monitor or cron for alerts.
. "$(dirname "$(readlink -f "$0")")/lib.sh"

check_ready=1
check_dashboard=1
for arg in "$@"; do
  case "$arg" in
    --no-ready) check_ready=0 ;;
    --no-dashboard) check_dashboard=0 ;;
    *) die "unknown option $arg" ;;
  esac
done
need curl
: "${DISK_WARN_PERCENT:=80}"
: "${DISK_FAIL_PERCENT:=95}"
rc=0
fail() { log "FAIL: $*" >&2; rc=1; }
soft() { warn "$*"; if [ "$rc" = 0 ]; then rc=2; fi; }

code() { curl -sS --max-time "${2:-5}" -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || true; }

c=$(code "$WORKFOLIO_API_URL/api/v1/health")
[ "$c" = 200 ] && log "api health: 200" || fail "api health: HTTP $c ($WORKFOLIO_API_URL)"

if [ "$check_ready" = 1 ]; then
  c=$(code "$WORKFOLIO_API_URL/api/v1/ready" 10)
  case "$c" in
    200) log "api ready: 200" ;;
    503) soft "api ready: 503 (database or storage check failing; OneDrive not connected yet?)" ;;
    *) fail "api ready: HTTP $c" ;;
  esac
fi

if [ "$check_dashboard" = 1 ]; then
  c=$(code "$WORKFOLIO_DASHBOARD_URL/" 10)
  case "$c" in
    2??|3??) log "dashboard: $c" ;;
    *) fail "dashboard: HTTP $c ($WORKFOLIO_DASHBOARD_URL)" ;;
  esac
fi

if [ "$SYSTEMCTL" != ":" ] && command -v "$SYSTEMCTL" >/dev/null 2>&1; then
  units="$API_SERVICE"
  # --no-dashboard also skips the dashboard unit: deploy.sh checks the API first, before the dashboard is (re)started.
  if [ "$check_dashboard" = 1 ]; then units="$units $DASHBOARD_SERVICE"; fi
  for unit in $units; do
    state=$("$SYSTEMCTL" is-active "$unit" 2>/dev/null || true)
    [ "$state" = active ] && log "$unit: active" || fail "$unit: $state"
  done
fi

if [ -d "$WORKFOLIO_DATA" ]; then
  used=$(disk_used_percent "$WORKFOLIO_DATA")
  if [ "$used" -ge "$DISK_FAIL_PERCENT" ]; then fail "data filesystem ${used}% full"
  elif [ "$used" -ge "$DISK_WARN_PERCENT" ]; then soft "data filesystem ${used}% full"
  else log "data filesystem ${used}% used"; fi
fi
exit "$rc"
