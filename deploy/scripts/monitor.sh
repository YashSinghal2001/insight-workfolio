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
# Alerts go out when the verdict CHANGES, and again every ALERT_REPEAT_MINUTES while it stays FAIL. Channels
# (monitor.env; each is optional and independent: one failing never stops another):
#   ALERT_TEAMS_WEBHOOK_URL  Microsoft Teams "Workflows" webhook (Adaptive Card). Primary: every event
#                            (ALERT_TEAMS_MIN_LEVEL=WARN, the default; FAIL = critical events only)
#   ALERT_NTFY_URL           ntfy topic URL (phone push). Secondary: critical events only by default
#                            (ALERT_NTFY_MIN_LEVEL=FAIL: a FAIL verdict, its repeats and the recovery from it)
#   ALERT_WEBHOOK_URL / ALERT_CMD   generic JSON {"text"} webhook / any command: every event
# Each alert carries severity, UTC time, server, affected services, the failing checks and a next step. It
# never contains secrets or personal data (only check names, unit names, paths and counts).
#   monitor.sh --test-alert [teams|ntfy|all]   sends a TEST message through the chosen channel(s) only: no
#                                              checks run, the state file is untouched; exit 1 if one fails
# State lives in $WORKFOLIO_DATA/monitor/. Exit code = 0 OK, 2 WARN, 1 FAIL (the unit is a oneshot; its own
# exit status is 0 so the timer keeps firing).
# This monitor runs ON the VPS: when the VPS itself is down nothing fires. Pair it with an external uptime
# monitor on https://api.<domain>/api/v1/health (deploy/README.md "Monitoring"). Arguments are passed to
# healthcheck.sh (e.g. --no-dashboard on a host without the dashboard).
. "$(dirname "$(readlink -f "$0")")/lib.sh"

: "${ALERT_WEBHOOK_URL:=}"
: "${ALERT_CMD:=}"
: "${ALERT_TEAMS_WEBHOOK_URL:=}"
: "${ALERT_TEAMS_MIN_LEVEL:=WARN}"
: "${ALERT_NTFY_URL:=}"
: "${ALERT_NTFY_MIN_LEVEL:=FAIL}"
: "${ALERT_REPEAT_MINUTES:=360}"
: "${BACKUP_MAX_AGE_HOURS:=30}"
: "${TIMELAPSE_SCRATCH_WARN_MB:=1024}"
: "${LOG_WINDOW_MINUTES:=6}"
: "${TIMELAPSE_DIR:=$WORKFOLIO_DATA/tmp/timelapses}"
: "${BACKUP_SERVICE:=workfolio-backup}"
: "${MONITOR_STATE_DIR:=$WORKFOLIO_DATA/monitor}"
: "${JOURNALCTL:=journalctl}"
scripts="$(dirname "$(readlink -f "$0")")"

host=$(hostname -s 2>/dev/null || hostname)

# ---- alert channels -------------------------------------------------------------------------------
# URLs are handed to curl through a config on stdin (-K -), never as an argument: they are secrets and
# must not show up in the process list or in any log line.

# Microsoft Teams (Workflows "post to a channel when a webhook request is received"): the flow posts each
# attachment's Adaptive Card. $1 title, $2 body text (one TextBlock per line), $3 level.
send_teams() {
  local payload
  payload=$(TITLE="$1" BODY="$2" LEVEL="$3" "$NODE" -e '
    const { TITLE, BODY, LEVEL } = process.env;
    const color = { CRITICAL: "Attention", WARNING: "Warning", RECOVERED: "Good", TEST: "Accent" }[LEVEL] || "Default";
    const card = { type: "AdaptiveCard", $schema: "http://adaptivecards.io/schemas/adaptive-card.json", version: "1.4", msteams: { width: "Full" },
      body: [{ type: "TextBlock", text: TITLE, weight: "Bolder", size: "Medium", color, wrap: true },
        ...BODY.split("\n").filter(Boolean).map((text) => ({ type: "TextBlock", text, wrap: true, spacing: "Small" }))] };
    process.stdout.write(JSON.stringify({ type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null, content: card }] }));
  ') || return 1
  printf 'url = "%s"\n' "$ALERT_TEAMS_WEBHOOK_URL" | curl -fsS --max-time 20 -o /dev/null -H 'content-type: application/json' --data-binary "$payload" -K -
}

# ntfy topic (phone push). $1 title (ASCII), $2 body text, $3 level.
send_ntfy() {
  local priority=default tags=information_source
  case "$3" in
    CRITICAL) priority=urgent; tags=rotating_light ;;
    WARNING) priority=default; tags=warning ;;
    RECOVERED) priority=default; tags=white_check_mark ;;
    TEST) priority=low; tags=test_tube ;;
  esac
  printf 'url = "%s"\n' "$ALERT_NTFY_URL" | curl -fsS --max-time 15 -o /dev/null -H "Title: $1" -H "Priority: $priority" -H "Tags: $tags" --data-binary "$2" -K -
}

# Which channels take an event: $1 channel minimum level (WARN = everything, FAIL = critical events only),
# $2 = 1 when the event is critical (FAIL now, or recovering from FAIL).
wants() { [ "$1" != FAIL ] || [ "$2" = 1 ]; }

if [ "${1:-}" = "--test-alert" ]; then
  which=${2:-all}
  title="[TEST] Insight Workfolio monitoring on $host"
  text="Severity: TEST (no action needed)"$'\n'"Time: $(date -u '+%Y-%m-%d %H:%M UTC')"$'\n'"Server: $host"$'\n'"This is a delivery test of this alert channel. Real alerts name the affected service and the next step."
  rc=0
  for channel in teams ntfy; do
    [ "$which" = all ] || [ "$which" = "$channel" ] || continue
    case "$channel" in teams) url=$ALERT_TEAMS_WEBHOOK_URL ;; ntfy) url=$ALERT_NTFY_URL ;; esac
    if [ -z "$url" ]; then echo "$channel: not configured"; [ "$which" = all ] || rc=1; continue; fi
    if "send_$channel" "$title" "$text" TEST; then echo "$channel: sent"; else echo "$channel: FAILED"; rc=1; fi
  done
  exit "$rc"
fi

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
subject="workfolio $host: $verdict"
printf '%s\n%s' "$subject" "$report"
alert=0
if [ "$verdict" != "$prev_verdict" ]; then alert=1
elif [ "$verdict" = FAIL ] && [ $((now - prev_at)) -ge $((ALERT_REPEAT_MINUTES * 60)) ]; then alert=1
fi
if [ "$alert" = 1 ]; then
  case "$verdict" in FAIL) level=CRITICAL ;; WARN) level=WARNING ;; *) level=RECOVERED ;; esac
  critical=0
  if [ "$verdict" = FAIL ] || [ "$prev_verdict" = FAIL ]; then critical=1; fi
  problems=$(printf '%s' "$report" | grep -E '^(FAIL|WARN): ' || true)
  # Affected services and a next step, derived from the failing checks (names and commands only).
  affected=""; actions=""
  add() { case ", $affected, " in *", $1, "*) ;; *) affected="${affected:+$affected, }$1"; actions="$actions"$'\n'"Next step ($1): $2" ;; esac; }
  if grep -q -E 'api health|api ready|workfolio-api' <<<"$problems"; then add "API" "systemctl status $API_SERVICE; journalctl -u $API_SERVICE -n 50"; fi
  if grep -q -E 'dashboard' <<<"$problems"; then add "Dashboard" "systemctl status $DASHBOARD_SERVICE; journalctl -u $DASHBOARD_SERVICE -n 50"; fi
  if grep -q -E 'filesystem' <<<"$problems"; then add "Disk" "df -h; du -sh /opt/workfolio/releases /var/backups/workfolio /var/log"; fi
  if grep -q -E '^(FAIL|WARN): backup' <<<"$problems"; then add "Backups" "journalctl -u $BACKUP_SERVICE -n 30; systemctl start $BACKUP_SERVICE"; fi
  if grep -q -E 'onedrive|storage check' <<<"$problems"; then add "OneDrive storage" "dashboard Settings > Microsoft OneDrive (reconnect if needed); journalctl -u $API_SERVICE | grep -i storage"; fi
  if grep -q -E 'timelapse' <<<"$problems"; then add "Timelapse scratch" "ls -la $TIMELAPSE_DIR; df -h"; fi
  title="[$level] Insight Workfolio on $host"
  body="Severity: $level (now $verdict, was $prev_verdict)"$'\n'"Time: $(date -u '+%Y-%m-%d %H:%M UTC')"$'\n'"Server: $host"
  if [ -n "$problems" ]; then
    body="$body"$'\n'"Affected: ${affected:-see checks}"$'\n'"$problems$actions"
  else
    body="$body"$'\n'"All checks pass again: API, dashboard, services, disk, backups."
  fi
  # Every channel is tried; a failure is logged (to the journal) and never stops the others.
  if [ -n "$ALERT_TEAMS_WEBHOOK_URL" ] && wants "$ALERT_TEAMS_MIN_LEVEL" "$critical"; then
    if send_teams "$title" "$body" "$level"; then log "alert: teams sent"; else warn "alert: teams FAILED"; fi
  fi
  if [ -n "$ALERT_NTFY_URL" ] && wants "$ALERT_NTFY_MIN_LEVEL" "$critical"; then
    if send_ntfy "$title" "$body" "$level"; then log "alert: ntfy sent"; else warn "alert: ntfy FAILED"; fi
  fi
  if [ -n "$ALERT_WEBHOOK_URL" ]; then
    # Generic JSON {"text"} webhook; JSON-escaped through node (always present on the VPS).
    payload=$(printf '%s\n%s' "$title" "$body" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify({text:s})))')
    if printf 'url = "%s"\n' "$ALERT_WEBHOOK_URL" | curl -fsS --max-time 15 -o /dev/null -H 'content-type: application/json' --data-binary "$payload" -K -; then log "alert: webhook sent"; else warn "alert: webhook FAILED"; fi
  fi
  if [ -n "$ALERT_CMD" ]; then
    bodyfile=$(mktemp "$MONITOR_STATE_DIR/alert.XXXXXX")
    printf '%s\n' "$body" > "$bodyfile"
    if bash -c "$ALERT_CMD" alert "$title" "$bodyfile"; then log "alert: command sent"; else warn "alert: command FAILED"; fi
    rm -f "$bodyfile"
  fi
  printf '%s %s\n' "$verdict" "$now" > "$state"
elif [ ! -f "$state" ]; then
  printf '%s %s\n' "$verdict" "$now" > "$state"
fi
case "$verdict" in OK) exit 0 ;; WARN) exit 2 ;; *) exit 1 ;; esac
