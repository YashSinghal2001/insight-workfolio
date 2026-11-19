#!/usr/bin/env bash
# Real-sshd test of the desktop publish identities, for a DISPOSABLE Linux machine only (GitHub runner in
# .github/workflows/desktop-publish-test.yml). As root it runs the real install-desktop-publisher.sh for both
# channels (workfolio-publisher on /srv/workfolio-downloads, workfolio-publisher-test on its test/ folder, sshd
# Match blocks, 1775 folders), then attacks and uses those identities through real ssh, with Caddy serving the
# production route block over https. Needs: sshd, caddy, jq, curl.
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
tuser=workfolio-publisher-test tdir=$dir/test tforced="$receiver --dir $dir/test --test"
as_pub() { sudo -u "$user" "$@"; }
as_test() { sudo -u "$tuser" "$@"; }

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

echo "install the TEST channel (its own key and user)"
ssh-keygen -q -t ed25519 -N '' -C test-channel -f "$tmp/tkey"
check "install-desktop-publisher.sh test succeeds" bash "$here/install-desktop-publisher.sh" "$tmp/tkey.pub" test
check "test folder is root:$tuser 1775" test "$(stat -c '%U:%G %a' "$tdir")" = "root:$tuser 1775"
check "production folder still root:$user 1775" test "$(stat -c '%U:%G %a' "$dir")" = "root:$user 1775"
check "test manifest seeded empty, owned by $tuser" bash -c "[ \"\$(stat -c '%U %a' $tdir/desktop-releases.json)\" = '$tuser 644' ] && jq -e '. == {}' $tdir/desktop-releases.json"
check "test authorized_keys forces the receiver with the test options" grep -q "^restrict,command=\"$tforced\" ssh-ed25519 " "/var/lib/$tuser/.ssh/authorized_keys"
check "sshd effective for $tuser: forcecommand with the test options" bash -c "sshd -T -C user=$tuser,host=localhost,addr=127.0.0.1 | grep -qx 'forcecommand $tforced'"
check "production forced command unchanged" bash -c "sshd -T -C user=$user,host=localhost,addr=127.0.0.1 | grep -qx 'forcecommand $receiver'"

ssh-keyscan -t ed25519 127.0.0.1 > "$tmp/known_hosts" 2>/dev/null
check "host key scanned" test -s "$tmp/known_hosts"
S=(ssh -i "$tmp/key" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$tmp/known_hosts" -o ConnectTimeout=10)
T="$user@127.0.0.1"
ST=(ssh -i "$tmp/tkey" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$tmp/known_hosts" -o ConnectTimeout=10)
TT="$tuser@127.0.0.1"

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

echo "the two keys are separate identities"
check "test key: status of the test channel" bash -c "$(printf '%q ' "${ST[@]}") $TT status | jq -e '. == {}'"
refused "test key cannot log in as the production publisher" "${ST[@]}" "$T" status
refused "production key cannot log in as the test publisher" "${S[@]}" "$TT" status
refused "test key: arbitrary command refused" "${ST[@]}" "$TT" id
refused "test key: a production file name is refused" bash -c "printf x | $(printf '%q ' "${ST[@]}") $TT upload insight-workfolio_9.9.9_windows-x86_64-setup.exe 1 2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881"
refused "production key: a TEST file name is refused" bash -c "printf x | $(printf '%q ' "${S[@]}") $T upload insight-workfolio-test_9.9.9_r1-1_windows-x86_64-setup.exe 1 2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881"

echo "sticky bit: even a shell as $user cannot touch root-owned rollback installers"
refused "rm refused" as_pub rm -f "$dir/$legacy"
refused "mv away refused" as_pub mv "$dir/$legacy" "$dir/moved.exe"
as_pub sh -c "printf evil > /tmp/evil.exe"
refused "replace by rename refused" as_pub mv -f /tmp/evil.exe "$dir/$legacy"
refused "write into it refused" as_pub sh -c "printf evil >> '$dir/$legacy'"
refused "chmod refused" as_pub chmod 666 "$dir/$legacy"
check "rollback installer unchanged" test "$(sha "$dir/$legacy")" = "$legacy_sha"
refused "cannot change folder permissions" as_pub chmod 777 "$dir"
refused "production publisher cannot remove the test folder" as_pub rmdir "$tdir"
refused "production publisher cannot rename the test folder" as_pub mv "$tdir" "$dir/gone"
refused "test publisher cannot write into the production folder" as_test sh -c "printf evil > '$dir/x.exe'"
refused "test publisher cannot replace the production manifest" as_test sh -c "printf '{}' > '$dir/desktop-releases.json'"
refused "test publisher cannot remove the production manifest" as_test rm -f "$dir/desktop-releases.json"
check "production manifest intact" jq -e .windows "$dir/desktop-releases.json"

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
export DESKTOP_DOWNLOADS_ORIGIN="https://localhost:$port" DESKTOP_PUBLISH_KNOWN_HOSTS_FILE="$tmp/known_hosts" \
  COMMIT=0123456789abcdef0123456789abcdef01234567
# artifact <dir> <platform> <version> <installer> <content> [updater-file...]: as desktop-build.yml writes it
artifact() {
  local d=$1 platform=$2 version=$3 name=$4 content=$5 extra='[]' e; shift 5
  mkdir -p "$d"; printf '%s' "$content" > "$d/$name"
  for e in "$@"; do
    printf 'updater file %s %s' "$e" "$content" > "$d/$e"
    extra=$(jq -c --arg f "$e" --arg s "$(sha "$d/$e")" --argjson n "$(stat -c %s "$d/$e")" '. + [{file:$f, sizeBytes:$n, sha256:$s}]' <<<"$extra")
  done
  jq -n --arg p "$platform" --arg f "$name" --arg v "$version" --arg s "$(sha "$d/$name")" --argjson n "$(stat -c %s "$d/$name")" --arg c "$COMMIT" \
    --argjson extra "$extra" '{platform:$p, file:$f, version:$v, arch:"x", sizeBytes:$n, sha256:$s, commit:$c, extra:$extra}' > "$d/installer.json"
}
release() { # <stem> <version> <tag>
  local st=$1 v=$2 r="$tmp/in/$3"
  artifact "$r/windows" windows "$v" "${st}_windows-x86_64-setup.exe" "windows $3 $RANDOM" "${st}_windows-x86_64-setup.exe.sig"
  artifact "$r/macos" macos "$v" "${st}_macos-universal.dmg" "macos $3 $RANDOM" "${st}_darwin-universal.app.tar.gz" "${st}_darwin-universal.app.tar.gz.sig"
  echo "$r"
}
pub() { # <channel> <version> <release-dir>
  local key=$tmp/key target=$T
  [ "$1" = production ] || { key=$tmp/tkey; target=$TT; }
  CHANNEL=$1 EXPECTED_VERSION=$2 DESKTOP_PUBLISH_SSH_KEY_FILE=$key DESKTOP_PUBLISH_SSH_TARGET=$target \
    bash "$here/desktop-publish.sh" "$3/result.json" "$3/windows" "$3/macos"
}
w=insight-workfolio_0.2.2_windows-x86_64-setup.exe
tw=insight-workfolio-test_0.2.1_r100-1_windows-x86_64-setup.exe
r=$(release insight-workfolio_0.2.2 0.2.2 r022) t=$(release insight-workfolio-test_0.2.1_r100-1 0.2.1 t100)
# A production release and a TEST release at the same time: separate folders, locks and manifests.
pub production 0.2.2 "$r" >"$tmp/pp.log" 2>&1 & p1=$!
pub test 0.2.1 "$t" >"$tmp/pt.log" 2>&1 & p2=$!
r1=0; r2=0; wait $p1 || r1=$?; wait $p2 || r2=$?
check "production release ok" bash -c "cat $tmp/pp.log; test $r1 = 0"
check "concurrent TEST release ok" bash -c "cat $tmp/pt.log; test $r2 = 0"
man() { jq -r "$1" "$dir/desktop-releases.json"; }
check "manifest has both 0.2.2 entries" test "$(man '.windows.version + " " + .macos.version')" = "0.2.2 0.2.2"
check "windows previous = 0.2.1 (rollback)" test "$(man .windows.previous.version)" = 0.2.1
check "production manifest holds no TEST entry" bash -c "! grep -q insight-workfolio-test $dir/desktop-releases.json"
check "public manifest matches" bash -c "curl -fsS https://localhost:$port/desktop-downloads/desktop-releases.json | jq -e '.windows.sha256 == \"$(sha "$r/windows/$w")\"'"
check "published installer is $user-owned, 644" test "$(stat -c '%U %a' "$dir/$w")" = "$user 644"
check "updater package and signatures stored, 644" test "$(stat -c '%a' "$dir/$w.sig" "$dir/insight-workfolio_0.2.2_darwin-universal.app.tar.gz" | xargs)" = "644 644"
check "updater signature served over https" curl -fsS -o /dev/null "https://localhost:$port/desktop-downloads/$w.sig"
check "TEST installer is $tuser-owned, in the test folder" test "$(stat -c '%U %a' "$tdir/$tw")" = "$tuser 644"
check "TEST manifest served, lists the TEST installer" bash -c "curl -fsS https://localhost:$port/desktop-downloads/test/desktop-releases.json | jq -e '.windows.href == \"/desktop-downloads/test/$tw\"'"
check "TEST installer served with the uploaded bytes" bash -c "curl -fsS https://localhost:$port/desktop-downloads/test/$tw | sha256sum | grep -q $(sha "$t/windows/$tw")"
check "audit log written, not served" bash -c "[ -s $dir/desktop-release-history.jsonl ] && [ \"\$(curl -s -o /dev/null -w '%{http_code}' https://localhost:$port/desktop-downloads/desktop-release-history.jsonl)\" = 404 ]"
check "history over ssh lists the activations" bash -c "$(printf '%q ' "${S[@]}") $T history | jq -s -e '[.[] | select(.action == \"activate\")] | length == 2'"
check "client logs contain no private key material" bash -c "! grep -qF \"$(sed -n 2p "$tmp/key")\" $tmp/pp.log $tmp/pt.log && ! grep -qF \"$(sed -n 2p "$tmp/tkey")\" $tmp/pp.log $tmp/pt.log"
check "re-run is a no-op" pub production 0.2.2 "$r"
r2d=$(release insight-workfolio_0.2.2 0.2.2 r022-other)
refused "same version, other bytes refused" pub production 0.2.2 "$r2d"
r0=$(release insight-workfolio_0.2.0 0.2.0 r020)
refused "downgrade refused" pub production 0.2.0 "$r0"
check "published bytes unchanged" test "$(sha "$dir/$w")" = "$(sha "$r/windows/$w")"
t2=$(release insight-workfolio-test_0.2.1_r101-1 0.2.1 t101)
check "a second TEST run publishes" pub test 0.2.1 "$t2"
check "the previous TEST installer stays downloadable" bash -c "curl -fsS https://localhost:$port/desktop-downloads/test/$tw | sha256sum | grep -q $(sha "$t/windows/$tw")"

echo "rollback (root on the server)"
check "rollback windows" as_pub "$receiver" rollback windows
check "windows back on 0.2.1, served from the root-owned file" bash -c "[ \"\$(jq -r .windows.href $dir/desktop-releases.json)\" = /desktop-downloads/$legacy ] && curl -fsS https://localhost:$port/desktop-downloads/$legacy | sha256sum | grep -q $legacy_sha"
check "roll forward" as_pub "$receiver" rollback windows
check "rollback installer still intact" test "$(sha "$dir/$legacy")" = "$legacy_sha"
r3=$(release insight-workfolio_0.2.3 0.2.3 r023)
check "release 0.2.3" pub production 0.2.3 "$r3"
check "restore 0.2.2 by version from the audit log" as_pub "$receiver" rollback windows 0.2.2
check "windows on 0.2.2, 0.2.3 kept as previous and on disk" bash -c "[ \"\$(jq -r '.windows.version + \" \" + .windows.previous.version' $dir/desktop-releases.json)\" = '0.2.2 0.2.3' ] && [ -f $dir/insight-workfolio_0.2.3_windows-x86_64-setup.exe ]"
check "TEST rollback (its own receiver options)" as_test "$receiver" --dir "$tdir" --test rollback windows
check "TEST manifest back on run 100" test "$(jq -r .windows.file "$tdir/desktop-releases.json")" = "$tw"

echo "desktop publish ssh test: $pass passed, $fail failed"
[ "$fail" = 0 ]
