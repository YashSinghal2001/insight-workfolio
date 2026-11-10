#!/usr/bin/env bash
# Periodic monitor (workfolio-monitor.timer, every 5 minutes, as workfolio). One run = one verdict:
#   OK, WARN or FAIL, from these checks, all local (loopback, journal, files):
#   - healthcheck.sh: API /health (FAIL), /ready (WARN on 503: database or OneDrive storage down),
#     dashboard, both units active, data filesystem (WARN at DISK_WARN_PERCENT, FAIL at 95 %)
#   - backups: newest local backup younger than BACKUP_MAX_AGE_HOURS (FAIL), last workfolio-backup run
#     succeeded (FAIL: covers a failed off-site upload too), backup directory readable
#   - OneDrive: storage failures logged by the API in the last LOG_WINDOW_MINUTES (WARN; "Screenshot storage
#     failed", "Timelapse upload/delete ... failed", "reconnect OneDrive"); needs the workfolio user in the
#     systemd-journal group (install-vps.sh). While OneDrive is intentionally not connected, set
#     STORAGE_EXPECTED_DOWN=1 in monitor.env so the /ready 503 does not pin the verdict at WARN
#   - timelapse scratch: size of TIMELAPSE_DIR over TIMELAPSE_SCRATCH_WARN_MB (WARN), low-disk refusals
#     logged by the API (WARN)
# Alerts (monitor.env: ALERT_WEBHOOK_URL and/or ALERT_CMD) go out when the verdict CHANGES, and again every
# ALERT_REPEAT_MINUTES while it stays FAIL. State lives in $WORKFOLIO_DATA/monitor/. Exit code = 0 OK,
# 2 WARN, 1 FAIL (the unit is a oneshot; its own exit status is 0 so the timer keeps firing).
# This monitor runs ON the VPS: when the VPS itself is down nothing fires. Pair it with an external uptime
# monitor on https://api.<domain>/api/v1/health (deploy/README.md "Monitoring"). Arguments are passed to
# healthcheck.sh (e.g. --no-dashboard on a host without the dashboard).
. "$(dirname "$(readlink -f "$0")")/lib.sh"

: "${ALERT_WEBHOOK_URL:=}"
: "${ALERT_CMD:=}"
: "${ALERT_REPEAT_MINUTES:=360}"
: "${BACKUP_MAX_AGE_HOURS:=30}"
: "${TIMELAPSE_SCRATCH_WARN_MB:=1024}"
: "${LOG_WINDOW_MINUTES:=6}"
: "${TIMELAPSE_DIR:=$WORKFOLIO_DATA/tmp/timelapses}"
: "${BACKUP_SERVICE:=workfolio-backup}"
: "${MONITOR_STATE_DIR:=$WORKFOLIO_DATA/monitor}"
: "${JOURNALCTL:=journalctl}"
scripts="$(dirname "$(readlink -f "$0")")"

verdict=OK
report=""
note() { report="$report$1"$'\n'; }
fail() { note "FAIL: $*"; verdict=FAIL; }
warn_() { note "WARN: $*"; if [ "$verdict" = OK ]; then verdict=WARN; fi; }

# 1. health (API, dashboard, units, disk) ----------------------------------------------------------
set +e
health=$("$scripts/healthcheck.sh" "$@" 2>&1)   # flags (--no-ready, --no-dashboard) pass through
rc=$?
set -e
case "$rc" in
  0) note "health: ok" ;;
  2) warn_ "health: $(printf '%s\n' "$health" | grep -E 'WARNING' | sed 's/.*WARNING: //' | tr '\n' ';')" ;;
  *) fail "health: $(printf '%s\n' "$health" | grep -E 'FAIL' | sed 's/.*FAIL: //' | tr '\n' ';')" ;;
esac

# 2. backups --------------------------------------------------------------------------------------
if [ -d "$WORKFOLIO_BACKUP_DIR" ]; then
  newest=$(find "$WORKFOLIO_BACKUP_DIR" -maxdepth 1 -type f -name 'workfolio-*.db.gz*' -mmin "-$((BACKUP_MAX_AGE_HOURS * 60))" 2>/dev/null | head -1 || true)
  if [ -n "$newest" ]; then note "backup: a backup younger than ${BACKUP_MAX_AGE_HOURS}h exists"
  else fail "backup: no backup younger than ${BACKUP_MAX_AGE_HOURS}h in $WORKFOLIO_BACKUP_DIR"; fi
else
  fail "backup: $WORKFOLIO_BACKUP_DIR missing or unreadable"
fi
if [ "$SYSTEMCTL" != ":" ] && command -v "$SYSTEMCTL" >/dev/null 2>&1; then
  result=$("$SYSTEMCTL" show "$BACKUP_SERVICE.service" -p Result --value 2>/dev/null || echo unknown)
  case "$result" in
    success|"") note "backup unit: last run ok" ;;
    *) fail "backup unit: last run ended with '$result' (journalctl -u $BACKUP_SERVICE; an off-site upload failure ends here too)" ;;
  esac
fi

# 3. OneDrive / storage failures and low-disk refusals in the API log --------------------------------
if [ "$SYSTEMCTL" != ":" ] && command -v "$JOURNALCTL" >/dev/null 2>&1; then
  if lines=$("$JOURNALCTL" -u "$API_SERVICE" --since "-${LOG_WINDOW_MINUTES}min" -o cat --no-pager 2>/dev/null); then
    # Not counted: "Readiness check failed: storage" (written by this monitor's own /ready probe; the health
    # check above already reports readiness).
    storage=$(printf '%s\n' "$lines" | grep -c -E 'Screenshot storage failed|Timelapse upload to storage failed|Timelapse delete from storage failed|reconnect OneDrive' || true)
    [ "$storage" = 0 ] && note "onedrive: no storage failures in the last ${LOG_WINDOW_MINUTES} min" || warn_ "onedrive: $storage storage failure line(s) in the last ${LOG_WINDOW_MINUTES} min (journalctl -u $API_SERVICE | grep -i storage)"
    lowdisk=$(printf '%s\n' "$lines" | grep -c 'Timelapse refused: low disk space' || true)
    [ "$lowdisk" = 0 ] || warn_ "timelapse: $lowdisk video(s) refused for low disk space"
  else
    warn_ "onedrive: cannot read the API journal (is $WORKFOLIO_USER in the systemd-journal group?)"
  fi
fi

# 4. timelapse scratch directory --------------------------------------------------------------------
if [ -d "$TIMELAPSE_DIR" ]; then
  mb=$(du -sm "$TIMELAPSE_DIR" 2>/dev/null | cut -f1 || echo 0)
  if [ "${mb:-0}" -gt "$TIMELAPSE_SCRATCH_WARN_MB" ]; then warn_ "timelapse scratch: ${mb} MB in $TIMELAPSE_DIR (encodes not cleaned up? tmpfiles removes files older than 2 days)"
  else note "timelapse scratch: ${mb:-0} MB"; fi
fi

# 5. verdict, state, alerts --------------------------------------------------------------------------
mkdir -p "$MONITOR_STATE_DIR"
chmod 700 "$MONITOR_STATE_DIR"
state="$MONITOR_STATE_DIR/state"
previous=$(cat "$state" 2>/dev/null || echo "OK 0")
prev_verdict=${previous%% *}
prev_at=${previous##* }
now=$(date +%s)
subject="workfolio $(hostname -s 2>/dev/null || hostname): $verdict"
printf '%s\n%s' "$subject" "$report"
alert=0
if [ "$verdict" != "$prev_verdict" ]; then alert=1
elif [ "$verdict" = FAIL ] && [ $((now - prev_at)) -ge $((ALERT_REPEAT_MINUTES * 60)) ]; then alert=1
fi
if [ "$alert" = 1 ]; then
  body="$subject (was $prev_verdict)"$'\n'"$report"
  if [ -n "$ALERT_WEBHOOK_URL" ]; then
    # JSON-escape through node (always present on the VPS); the URL is never logged.
    payload=$(printf '%s' "$body" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify({text:s})))')
    curl -sS --max-time 15 -o /dev/null -H 'content-type: application/json' --data "$payload" "$ALERT_WEBHOOK_URL" && note "alert: webhook sent" || warn "alert: webhook failed"
  fi
  if [ -n "$ALERT_CMD" ]; then
    bodyfile=$(mktemp "$MONITOR_STATE_DIR/alert.XXXXXX")
    printf '%s\n' "$body" > "$bodyfile"
    bash -c "$ALERT_CMD" alert "$subject" "$bodyfile" && note "alert: command sent" || warn "alert: command failed"
    rm -f "$bodyfile"
  fi
  printf '%s %s\n' "$verdict" "$now" > "$state"
elif [ ! -f "$state" ]; then
  printf '%s %s\n' "$verdict" "$now" > "$state"
fi
case "$verdict" in OK) exit 0 ;; WARN) exit 2 ;; *) exit 1 ;; esac
