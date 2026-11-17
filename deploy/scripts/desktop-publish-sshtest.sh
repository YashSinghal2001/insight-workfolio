#!/usr/bin/env bash
# Real-sshd test of the desktop publish identity, for a DISPOSABLE Linux machine only (GitHub runner in
# .github/workflows/desktop-publish-test.yml). As root it runs the real install-desktop-publisher.sh (creates
# workfolio-publisher, sshd Match block, /srv/workfolio-downloads 1775), then attacks and uses that identity
# through real ssh, with Caddy serving the production route block over https. Needs: sshd, caddy, jq, curl.
#
#   sudo DESKTOP_PUBLISH_SSHTEST_DISPOSABLE=yes deploy/scripts/desktop-publish-sshtest.sh
set -euo pipefail
[ "${DESKTOP_PUBLISH_SSHTEST_DISPOSABLE:-}" = yes ] || { echo "disposable machines only: set DESKTOP_PUBLISH_SSHTEST_DISPOSABLE=yes" >&2; exit 1; }
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
for p in /opt/workfolio /etc/workfolio /var/lib/workfolio; do [ ! -e "$p" ] || { echo "$p exists: this looks like a real server, refusing" >&2; exit 1; }; done
here="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
tmp=$(mktemp -d); caddy_pid=""
trap '[ -z "$caddy_pid" ] || kill "$caddy_pid" 2>/dev/null || true' EXIT
pass=0; fail=0
ok() { echo "  PASS: $*"; pass=$((pass + 1)); }
bad() { echo "  FAIL: $*" >&2; fail=$((fail + 1)); }
check() { local m=$1; shift; if "$@" >"$tmp/out" 2>&1; then ok "$m"; else bad "$m"; sed 's/^/      | /' "$tmp/out" >&2; fi; }
refused() { local m=$1; shift; if "$@" >"$tmp/out" 2>&1; then bad "$m (was accepted)"; sed 's/^/      | /' "$tmp/out" >&2; else ok "$m"; fi; }
sha() { sha256sum "$1" | cut -d' ' -f1; }
dir=/srv/workfolio-downloads user=workfolio-publisher receiver=/usr/local/lib/workfolio/desktop-downloads-receiver
as_pub() { sudo -u "$user" "$@"; }

echo "VPS-like starting state: root-owned folder with a root-owned rollback installer"
install -d -m 755 -o root -g root "$dir"
legacy=Insight-Workfolio_0.2.1_x64-setup.exe
printf 'legacy rollback installer' > "$dir/$legacy"; chmod 644 "$dir/$legacy"
legacy_sha=$(sha "$dir/$legacy")
cp "$repo/apps/dashboard/src/lib/desktop-releases.json" "$tmp/seed.json"

echo "install"
ssh-keygen -q -t ed25519 -N '' -C test -f "$tmp/key"
systemctl start ssh.socket 2>/dev/null || systemctl start ssh
check "install-desktop-publisher.sh succeeds" bash "$here/install-desktop-publisher.sh" "$tmp/key.pub"
check "folder is root:$user 1775" test "$(stat -c '%U:%G %a' "$dir")" = "root:$user 1775"
check "manifest seeded, owned by $user" test "$(stat -c '%U %a' "$dir/desktop-releases.json")" = "$user 644"
check "authorized_keys root-owned, forced command" bash -c "[ \"\$(stat -c %U /var/lib/workfolio-publisher/.ssh/authorized_keys)\" = root ] && grep -q '^restrict,command=\"$receiver\" ssh-ed25519 ' /var/lib/workfolio-publisher/.ssh/authorized_keys"
check "password locked" bash -c "passwd -S $user | awk '{print \$2}' | grep -qx L"
check "no sudo for $user" bash -c "! sudo -l -U $user | grep -q 'may run'"
eff=$(sshd -T -C "user=$user,host=localhost,addr=127.0.0.1")
for o in "forcecommand $receiver" "permittty no" "allowtcpforwarding no" "allowagentforwarding no" "x11forwarding no" "permittunnel no" "authenticationmethods publickey" "disableforwarding yes"; do
  check "sshd effective for $user: $o" grep -qx "$o" <<<"$eff"
done
check "other users unaffected (forcecommand none for root)" bash -c "sshd -T -C user=root,host=localhost,addr=127.0.0.1 | grep -qx 'forcecommand none'"
check "re-running the installer is safe" bash "$here/install-desktop-publisher.sh" "$tmp/key.pub"

ssh-keyscan -t ed25519 127.0.0.1 > "$tmp/known_hosts" 2>/dev/null
check "host key scanned" test -s "$tmp/known_hosts"
S=(ssh -i "$tmp/key" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$tmp/known_hosts" -o ConnectTimeout=10)
T="$user@127.0.0.1"

echo "what the key can and cannot do over real ssh"
check "status works" bash -c "$(printf '%q ' "${S[@]}") $T status | jq -e .windows"
refused "arbitrary command refused" "${S[@]}" "$T" id
refused "shell (no command) refused" "${S[@]}" -T "$T"
refused "rollback refused over ssh" "${S[@]}" "$T" rollback windows
refused "command injection refused" "${S[@]}" "$T" 'status; id'
refused "sftp refused" bash -c "echo 'put $tmp/key.pub /srv/workfolio-downloads/x.exe' | sftp -b - -i $tmp/key -o IdentitiesOnly=yes -o BatchMode=yes -o UserKnownHostsFile=$tmp/known_hosts $T"
refused "scp refused" scp -i "$tmp/key" -o IdentitiesOnly=yes -o BatchMode=yes -o UserKnownHostsFile="$tmp/known_hosts" "$tmp/key.pub" "$T:/srv/workfolio-downloads/x.exe"
check "nothing written by sftp/scp" test ! -e "$dir/x.exe"
refused "remote port forwarding refused" timeout 20 "${S[@]}" -N -o ExitOnForwardFailure=yes -R 127.0.0.1:47123:127.0.0.1:22 "$T"
timeout 15 "${S[@]}" -N -L 127.0.0.1:47124:127.0.0.1:22 "$T" 2>/dev/null & fwd=$!; sleep 3
refused "local port forwarding carries no data" timeout 5 bash -c 'exec 3<>/dev/tcp/127.0.0.1/47124 && head -c 4 <&3 | grep -q SSH-'
kill "$fwd" 2>/dev/null || true
check "pty request denied" bash -c "$(printf '%q ' "${S[@]}") -tt $T status 2>&1 | grep -qi 'PTY allocation request failed'"

echo "sticky bit: even a shell as $user cannot touch root-owned rollback installers"
refused "rm refused" as_pub rm -f "$dir/$legacy"
refused "mv away refused" as_pub mv "$dir/$legacy" "$dir/moved.exe"
as_pub sh -c "printf evil > /tmp/evil.exe"
refused "replace by rename refused" as_pub mv -f /tmp/evil.exe "$dir/$legacy"
refused "write into it refused" as_pub sh -c "printf evil >> '$dir/$legacy'"
refused "chmod refused" as_pub chmod 666 "$dir/$legacy"
check "rollback installer unchanged" test "$(sha "$dir/$legacy")" = "$legacy_sha"
refused "cannot change folder permissions" as_pub chmod 777 "$dir"

echo "Caddy (official build) with the production route block"
port=8443
block=$(awk '/handle_path \/desktop-downloads\/\*/{d=1} d{print; n+=gsub(/{/,"{"); n-=gsub(/}/,"}"); if(n==0) exit}' "$repo/deploy/caddy/Caddyfile.ip")
cat > "$tmp/Caddyfile" <<EOF
{
	admin off
	skip_install_trust
	auto_https disable_redirects
	storage file_system {
		root $tmp/caddy
	}
}
https://localhost:$port {
	tls internal
$block
	handle {
		respond 404
	}
}
EOF
caddy run --config "$tmp/Caddyfile" --adapter caddyfile >"$tmp/caddy.log" 2>&1 & caddy_pid=$!
for _ in $(seq 50); do [ -f "$tmp/caddy/pki/authorities/local/root.crt" ] && curl -s --cacert "$tmp/caddy/pki/authorities/local/root.crt" -o /dev/null "https://localhost:$port/" && break; sleep 0.2; done
export CURL_CA_BUNDLE="$tmp/caddy/pki/authorities/local/root.crt"
check "legacy installer served" curl -fsS -o /dev/null "https://localhost:$port/desktop-downloads/$legacy"

echo "publishing through real ssh with the CI client"
export DESKTOP_DOWNLOADS_ORIGIN="https://localhost:$port" DESKTOP_PUBLISH_SSH_TARGET="$T" \
  DESKTOP_PUBLISH_SSH_KEY_FILE="$tmp/key" DESKTOP_PUBLISH_KNOWN_HOSTS_FILE="$tmp/known_hosts" \
  COMMIT=0123456789abcdef0123456789abcdef01234567
mk() { # platform version file content
  local d="$tmp/in/$1-$2-$RANDOM"; mkdir -p "$d"; printf '%s' "$4" > "$d/$3"
  jq -n --arg p "$1" --arg f "$3" --arg v "$2" --arg s "$(sha "$d/$3")" --argjson n "$(stat -c %s "$d/$3")" --arg c "$COMMIT" \
    '{platform:$p, file:$f, version:$v, arch:"x", sizeBytes:$n, sha256:$s, commit:$c}' > "$d/installer.json"; echo "$d"
}
pub() { EXPECTED_PLATFORM=$1 EXPECTED_VERSION=$2 bash "$here/desktop-publish.sh" "$3/installer.json" "$3/$4" "$3/result.json"; }
w=insight-workfolio_0.2.2_windows-x86_64-setup.exe m=insight-workfolio_0.2.2_macos-universal.dmg
dw=$(mk windows 0.2.2 "$w" "windows 0.2.2 $RANDOM") dm=$(mk macos 0.2.2 "$m" "mac 0.2.2 $RANDOM")
# Both platforms at once: the manifest lock must keep both updates.
pub windows 0.2.2 "$dw" "$w" >"$tmp/pw.log" 2>&1 & p1=$!
pub macos 0.2.2 "$dm" "$m" >"$tmp/pm.log" 2>&1 & p2=$!
r1=0; r2=0; wait $p1 || r1=$?; wait $p2 || r2=$?
check "concurrent windows publish ok" test "$r1" = 0
check "concurrent macos publish ok" test "$r2" = 0
man() { jq -r "$1" "$dir/desktop-releases.json"; }
check "manifest has both 0.2.2 entries" test "$(man '.windows.version + " " + .macos.version')" = "0.2.2 0.2.2"
check "windows previous = 0.2.1 (rollback)" test "$(man .windows.previous.version)" = 0.2.1
check "public manifest matches" bash -c "curl -fsS https://localhost:$port/desktop-downloads/desktop-releases.json | jq -e '.windows.sha256 == \"$(sha "$dw/$w")\"'"
check "published installer is $user-owned, 644" test "$(stat -c '%U %a' "$dir/$w")" = "$user 644"
check "client logs contain no private key material" bash -c "! grep -qF \"$(sed -n 2p "$tmp/key")\" $tmp/pw.log $tmp/pm.log"
check "re-run is a no-op" pub windows 0.2.2 "$dw" "$w"
d2=$(mk windows 0.2.2 "$w" "different bytes")
refused "same version, other bytes refused" pub windows 0.2.2 "$d2" "$w"
d3=$(mk windows 0.2.0 insight-workfolio_0.2.0_windows-x86_64-setup.exe old)
refused "downgrade refused" pub windows 0.2.0 "$d3" insight-workfolio_0.2.0_windows-x86_64-setup.exe
check "published bytes unchanged" test "$(sha "$dir/$w")" = "$(sha "$dw/$w")"

echo "rollback (root on the server)"
check "rollback windows" as_pub "$receiver" rollback windows
check "windows back on 0.2.1, served from the root-owned file" bash -c "[ \"\$(jq -r .windows.href $dir/desktop-releases.json)\" = /desktop-downloads/$legacy ] && curl -fsS https://localhost:$port/desktop-downloads/$legacy | sha256sum | grep -q $legacy_sha"
check "roll forward" as_pub "$receiver" rollback windows
check "rollback installer still intact" test "$(sha "$dir/$legacy")" = "$legacy_sha"

echo "desktop publish ssh test: $pass passed, $fail failed"
[ "$fail" = 0 ]
