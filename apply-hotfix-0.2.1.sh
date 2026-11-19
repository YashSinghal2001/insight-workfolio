#!/usr/bin/env bash
# Workfolio 0.2.1 Windows installer + /desktop-downloads/* Caddy route hotfix. Run as root on the VPS:
#   bash apply-hotfix-0.2.1.sh /path/to/staged/Insight-Workfolio_0.2.1_x64-setup.exe [--apply]
# Without --apply it only runs Phase A checks and prints the Caddy diff (no production change).
# Every unexpected state exits non-zero BEFORE the affected mutation. Touches only:
#   /srv/workfolio-downloads/Insight-Workfolio_0.2.1_x64-setup.exe, /etc/caddy/Caddyfile (+ backup), caddy restart.
set -euo pipefail
umask 022

STAGED=${1:?usage: $0 <staged-exe> [--apply]}
APPLY=${2:-}
SIZE=3519222
SHA=241663ad540d02ce5da03efa658263540de80e2bc6ff5fd5c7cde6ee6febc273
CADDY_BASE_SHA=7001e3dde042e4b8323afad41cba852a61b02b7f7a4dba66729103764ce18d5f
DL=/srv/workfolio-downloads
DEST=$DL/Insight-Workfolio_0.2.1_x64-setup.exe
LIVE=/etc/caddy/Caddyfile
TEMPLATE=${TEMPLATE:-/opt/workfolio/installer-pipeline-audit/deploy/caddy/Caddyfile.ip}
NARROW_BLOCK_SHA=bdd3fd01a8ef93b739643ac95dd95acc33128fbe2612a3e007c14b75bd131b2f  # reviewed narrow route (top-level .exe/.dmg + manifest only)
TS=$(date -u +%Y%m%dT%H%M%SZ)
CAND=/etc/caddy/Caddyfile.candidate-$TS
BACKUP=/etc/caddy/Caddyfile.bak-hotfix-0.2.1-$TS
trap 'rm -f "$CAND"' EXIT   # no-op after the swap (file already moved)

stop() { echo "STOP: $*" >&2; exit 1; }
say()  { echo; echo "### $*"; }
sha()  { sha256sum "$1" | cut -d' ' -f1; }
check_file() { # path label
  [ -f "$1" ] || stop "$2 missing: $1"
  [ "$(stat -c %s "$1")" = "$SIZE" ] || stop "$2 size $(stat -c %s "$1") != $SIZE"
  [ "$(sha "$1")" = "$SHA" ] || stop "$2 SHA-256 mismatch: $(sha "$1")"
  [ "$(head -c2 "$1" | od -An -tx1 | tr -d ' \n')" = "4d5a" ] || stop "$2 does not start with MZ"
  echo "OK $2: $SIZE bytes, sha256 $SHA, MZ"
}

[ "$(id -u)" = 0 ] || stop "run as root"

say "Phase A - pre-deployment checks"
hostname; uptime
for s in caddy workfolio-api workfolio-dashboard; do
  systemctl is-active --quiet "$s" || stop "$s is not active"
  echo "OK $s active since $(systemctl show -p ActiveEnterTimestamp --value "$s") NRestarts=$(systemctl show -p NRestarts --value "$s")"
done
[ "$(sha "$LIVE")" = "$CADDY_BASE_SHA" ] || stop "live Caddyfile drifted from audited baseline (now $(sha "$LIVE")). Not touching it."
echo "OK live Caddyfile matches audited baseline"
[ -d "$DL" ] || stop "$DL missing"
ls -la --time-style=+%F_%T "$DL"
df -h "$DL" /etc/caddy
[ "$(df --output=avail -B1 "$DL" | tail -1)" -gt $((SIZE * 4)) ] || stop "not enough free space in $DL"
check_file "$STAGED" "staged installer"
DEST_STATE=absent
if [ -e "$DEST" ]; then
  [ "$(sha "$DEST")" = "$SHA" ] || stop "a DIFFERENT file already exists at $DEST (sha $(sha "$DEST")). Not overwriting."
  DEST_STATE=present-identical; echo "OK destination already present with the expected hash; install step will be skipped"
fi
# Another deployment in flight? (install-vps.sh, publisher receiver, apt/dpkg, someone editing the Caddyfile)
others=$(pgrep -af 'install-vps|workfolio-publish|publish-release|apt-get|dpkg|/usr/bin/unattended-upgrade( |$)|caddy (reload|adapt)' | awk -v me=$$ '$1 != me' || true)
[ -z "$others" ] || stop "possible concurrent deployment: $others"
for f in /etc/caddy/Caddyfile.candidate-* /etc/caddy/*.swp /etc/caddy/.*.swp; do if [ -e "$f" ]; then stop "leftover candidate/swap file $f - someone else may be mid-change"; fi; done
echo "OK no concurrent deployment detected"

say "Phase C prep - candidate Caddyfile (live + route block from $TEMPLATE, nothing else)"
[ -f "$TEMPLATE" ] || stop "template missing: $TEMPLATE"
grep -q 'desktop-downloads' "$LIVE" && stop "live Caddyfile already mentions desktop-downloads - unexpected"
[ "$(grep -c $'^\thandle {$' "$LIVE")" = 1 ] || stop "live Caddyfile has no single catch-all '\\thandle {' anchor"
# Route block: from the comment lines directly above 'handle_path /desktop-downloads/*' to its closing '\t}'.
block=$(awk '
  /^\t#/ { cmt = cmt $0 "\n"; next }
  /^\thandle_path \/desktop-downloads\/\* \{$/ { inb = 1; printf "%s", cmt }
  inb { print; if ($0 == "\t}") exit; next }
  { cmt = "" }' "$TEMPLATE")
[ -n "$block" ] || stop "route block not found in template"
[ "$(printf '%s' "$block" | sha256sum | cut -d' ' -f1)" = "$NARROW_BLOCK_SHA" ] || { printf '%s\n' "$block"; stop "route block in $TEMPLATE is not the reviewed narrow block (see above). Upload the narrow Caddyfile.ip and re-run with TEMPLATE=<path>"; }
grep -q $'^\t}$' <<<"$block" || stop "route block in template is not closed"
grep -qE 'browse|reverse_proxy|import|tls|admin' <<<"$block" && stop "route block contains unexpected directives"
grep -q 'root \* /srv/workfolio-downloads$' <<<"$block" || stop "route block root is not /srv/workfolio-downloads"
BLK="$block" awk '$0 == "\thandle {" && !done { print ENVIRON["BLK"]; print ""; done = 1 } { print }' "$LIVE" > "$CAND"
chmod --reference="$LIVE" "$CAND"; chown --reference="$LIVE" "$CAND"
echo "--- diff live -> candidate:"
diff -u "$LIVE" "$CAND" || true
[ "$(diff "$LIVE" "$CAND" | grep -c '^<' || true)" = 0 ] || stop "candidate removes/changes live lines"
echo "OK diff is additions only"
set -a; . /etc/caddy/workfolio.env; set +a
runuser -u caddy -- caddy validate --adapter caddyfile --config "$CAND" || { rm -f "$CAND"; stop "candidate failed caddy validate"; }
echo "OK candidate validates under the caddy user with the live environment"

if [ "$APPLY" != "--apply" ]; then
  rm -f "$CAND"
  say "DRY RUN complete - no production change. Re-run with --apply to install."
  exit 0
fi

say "Phase B - install installer"
if [ "$DEST_STATE" = absent ]; then
  TMP=$DL/.hotfix-0.2.1-$TS.tmp
  install -o root -g root -m 644 "$STAGED" "$TMP"
  check_file "$TMP" "copied temp file"
  [ -e "$DEST" ] && { rm -f "$TMP"; stop "destination appeared during install"; }
  mv -T --no-clobber "$TMP" "$DEST"
  [ -e "$TMP" ] && { rm -f "$TMP"; stop "atomic rename refused"; }
fi
check_file "$DEST" "installed file"
ls -la --time-style=+%F_%T "$DL"

say "Phase C - install Caddy route"
API_T=$(systemctl show -p ActiveEnterTimestamp --value workfolio-api)
DASH_T=$(systemctl show -p ActiveEnterTimestamp --value workfolio-dashboard)
[ "$(sha "$LIVE")" = "$CADDY_BASE_SHA" ] || stop "live Caddyfile changed during the run"
[ -e "$BACKUP" ] && stop "backup path already exists: $BACKUP"
cp -a --no-clobber "$LIVE" "$BACKUP"
[ "$(sha "$BACKUP")" = "$CADDY_BASE_SHA" ] || stop "backup verification failed"
echo "OK backup: $BACKUP"
mv -T "$CAND" "$LIVE"   # same filesystem: atomic
runuser -u caddy -- caddy validate --adapter caddyfile --config "$LIVE" || {
  cp -a "$BACKUP" "$LIVE"; stop "installed config failed validation; restored backup (caddy not restarted)"; }
echo "NEW Caddyfile sha256: $(sha "$LIVE")"
systemctl restart caddy || true
sleep 3
if ! systemctl is-active --quiet caddy; then
  echo "!!! caddy failed to start - ROLLING BACK" >&2
  journalctl -u caddy -n 40 --no-pager >&2 || true
  cp -a "$BACKUP" "$LIVE"
  runuser -u caddy -- caddy validate --adapter caddyfile --config "$LIVE" || echo "!!! restored backup failed validate" >&2
  systemctl restart caddy || true; sleep 3
  systemctl is-active caddy || true
  curl -fsS -o /dev/null -w 'rollback: / -> %{http_code}\n' "https://$WORKFOLIO_PUBLIC_IP/" || true
  curl -fsS -o /dev/null -w 'rollback: /api/v1/health -> %{http_code}\n' "https://$WORKFOLIO_PUBLIC_IP/api/v1/health" || true
  stop "FAILED - ROLLBACK COMPLETED (backup $BACKUP restored)"
fi
echo "OK caddy: $(systemctl is-active caddy)"

say "Phase D (server side)"
for s in caddy workfolio-api workfolio-dashboard; do echo "$s: $(systemctl is-active "$s")"; done
[ "$(systemctl show -p ActiveEnterTimestamp --value workfolio-api)" = "$API_T" ] && echo "OK api not restarted" || echo "WARN api restarted"
[ "$(systemctl show -p ActiveEnterTimestamp --value workfolio-dashboard)" = "$DASH_T" ] && echo "OK dashboard not restarted" || echo "WARN dashboard restarted"
sleep 5   # ACME cert is cached in caddy storage; give TLS a moment
curl -sS -I "https://$WORKFOLIO_PUBLIC_IP/desktop-downloads/Insight-Workfolio_0.2.1_x64-setup.exe"
curl -sS -o /tmp/hotfix-dl-$TS.exe "https://$WORKFOLIO_PUBLIC_IP/desktop-downloads/Insight-Workfolio_0.2.1_x64-setup.exe"
check_file /tmp/hotfix-dl-$TS.exe "downloaded-over-HTTPS file (backup $BACKUP)"; rm -f /tmp/hotfix-dl-$TS.exe
echo; echo "DONE. Backup: $BACKUP"
