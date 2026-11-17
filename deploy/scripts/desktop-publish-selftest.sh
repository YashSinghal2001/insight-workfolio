#!/usr/bin/env bash
# Developer-machine self-test of the desktop publish pipeline (never touches the VPS). Needs python3, jq, curl,
# caddy. Runs the REAL receiver (behind a fake `ssh` that sets SSH_ORIGINAL_COMMAND like a forced command),
# the REAL client script, and Caddy serving the /desktop-downloads route copied from deploy/caddy/Caddyfile.ip
# over https (internal CA) from a temporary folder.
set -euo pipefail
here="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
for t in python3 jq curl caddy; do command -v "$t" >/dev/null || { echo "$t missing" >&2; exit 1; }; done

tmp=$(mktemp -d "${TMPDIR:-/tmp}/desktop-publish-selftest.XXXXXX")
caddy_pid=""
cleanup() { [ -z "$caddy_pid" ] || kill "$caddy_pid" 2>/dev/null || true; if [ -n "${KEEP:-}" ]; then echo "kept $tmp"; else rm -rf "$tmp"; fi; }
trap cleanup EXIT
pass=0; fail=0
ok() { echo "  PASS: $*"; pass=$((pass + 1)); }
bad() { echo "  FAIL: $*" >&2; fail=$((fail + 1)); }
check() { local msg=$1; shift; if "$@" >/dev/null 2>&1; then ok "$msg"; else bad "$msg"; fi; }
refused() { local msg=$1; shift; if "$@" >/dev/null 2>&1; then bad "$msg (was accepted)"; else ok "$msg"; fi; }
sha() { (sha256sum "$1" 2>/dev/null || shasum -a 256 "$1") | cut -d' ' -f1; }

dl="$tmp/downloads"; mkdir -p "$dl" "$tmp/bin" "$tmp/in"
cp "$repo/apps/dashboard/src/lib/desktop-releases.json" "$dl/desktop-releases.json"
legacy=$(jq -r .windows.file "$dl/desktop-releases.json")
echo "legacy installer stand-in" > "$dl/$legacy"
receiver="$here/desktop-downloads-receiver.py"

# Fake ssh: drop options and the target, hand the rest to the receiver exactly as sshd's forced command would.
cat > "$tmp/bin/ssh" <<EOF
#!/usr/bin/env bash
while [[ \$1 == -* ]]; do shift 2; done; shift
SSH_ORIGINAL_COMMAND="\$*" exec python3 "$receiver" --dir "$dl"
EOF
chmod +x "$tmp/bin/ssh"
rx() { SSH_ORIGINAL_COMMAND="$*" python3 "$receiver" --dir "$dl"; }

# ---- Caddy with the production route block -------------------------------------------------------------
port=$((20000 + RANDOM % 20000))
block=$(awk '/handle_path \/desktop-downloads\/\*/{d=1} d{print; n+=gsub(/{/,"{"); n-=gsub(/}/,"}"); if(n==0) exit}' "$repo/deploy/caddy/Caddyfile.ip")
cat > "$tmp/Caddyfile" <<EOF
{
	admin off
	skip_install_trust
	storage file_system {
		root $tmp/caddy
	}
	auto_https disable_redirects
}
https://localhost:$port {
	tls internal
${block//\/srv\/workfolio-downloads/$dl}
	handle {
		respond 404
	}
}
EOF
caddy run --config "$tmp/Caddyfile" --adapter caddyfile >"$tmp/caddy.log" 2>&1 &
caddy_pid=$!
for _ in $(seq 50); do [ -f "$tmp/caddy/pki/authorities/local/root.crt" ] && curl -s --cacert "$tmp/caddy/pki/authorities/local/root.crt" -o /dev/null "https://localhost:$port/" && break; sleep 0.2; done
export CURL_CA_BUNDLE="$tmp/caddy/pki/authorities/local/root.crt"
origin="https://localhost:$port"

export SSH="$tmp/bin/ssh" DESKTOP_DOWNLOADS_ORIGIN="$origin" DESKTOP_PUBLISH_SSH_TARGET=workfolio-publisher@test \
  DESKTOP_PUBLISH_SSH_KEY_FILE=/dev/null DESKTOP_PUBLISH_KNOWN_HOSTS_FILE=/dev/null
commit=0123456789abcdef0123456789abcdef01234567

# make_installer <platform> <version> <file> <content>: installer + installer.json the way desktop-build.yml writes them
make_installer() {
  local d="$tmp/in/$1-$2-$RANDOM"; mkdir -p "$d"
  printf '%s' "$4" > "$d/$3"
  jq -n --arg p "$1" --arg f "$3" --arg v "$2" --arg s "$(sha "$d/$3")" --argjson n "$(wc -c < "$d/$3" | tr -d ' ')" --arg c "$commit" \
    '{platform:$p, file:$f, version:$v, arch:"x", sizeBytes:$n, sha256:$s, commit:$c}' > "$d/installer.json"
  echo "$d"
}
publish() { EXPECTED_PLATFORM=$1 EXPECTED_VERSION=$2 COMMIT=$commit bash "$here/desktop-publish.sh" "$3/installer.json" "$3/$4" "$3/result.json"; }
man() { jq -r "$1" "$dl/desktop-releases.json"; }

echo "receiver over SSH: only upload/activate/status, only valid names"
refused "shell command refused" rx bash -c id
refused "rollback not reachable over SSH" rx rollback windows
refused "path traversal name refused" rx upload ../evil.exe 1 "$(printf 'a%.0s' {1..64})"
check "quoted name with trailing newline refused as invalid name" bash -c "SSH_ORIGINAL_COMMAND=\$'upload \\'insight-workfolio_9.9.9_windows-x86_64-setup.exe\\n\\' 1 $(printf 'a%.0s' {1..64})' python3 '$receiver' --dir '$dl' </dev/null 2>&1 | grep -q 'invalid installer name'"
refused "unparsable quoting refused" rx "upload 'x"
refused "foreign name refused" rx upload Insight-Workfolio_9.9.9_x64-setup.exe 1 "$(printf 'a%.0s' {1..64})"
refused "size over limit refused" rx upload insight-workfolio_9.9.9_windows-x86_64-setup.exe 999999999999 "$(printf 'a%.0s' {1..64})"
check "status prints the manifest" rx status
w=insight-workfolio_0.2.2_windows-x86_64-setup.exe
refused "short body refused" bash -c "printf abc | SSH_ORIGINAL_COMMAND='upload $w 10 $(printf 'a%.0s' {1..64})' python3 '$receiver' --dir '$dl'"
refused "wrong sha256 refused" bash -c "printf abc | SSH_ORIGINAL_COMMAND='upload $w 3 $(printf 'a%.0s' {1..64})' python3 '$receiver' --dir '$dl'"
check "nothing left behind by refused uploads" test -z "$(ls -A "$dl/.incoming")" -a ! -e "$dl/$w"
refused "activate of a file never uploaded refused" rx activate "$w" "$(printf 'a%.0s' {1..64})" "$commit"

echo "publish windows 0.2.2"
before_mac=$(man .macos)
d=$(make_installer windows 0.2.2 "$w" "windows 0.2.2 bytes")
check "client publishes" publish windows 0.2.2 "$d" "$w"
check "result says published" test "$(jq -r .status "$d/result.json")" = published
check "manifest lists 0.2.2 with its checksum and href" test "$(man '.windows.version + " " + .windows.sha256 + " " + .windows.href')" = "0.2.2 $(sha "$d/$w") /desktop-downloads/$w"
check "previous entry kept for rollback" test "$(man .windows.previous.version)" = 0.2.1
check "macOS entry untouched" test "$(man .macos)" = "$before_mac"
check "installer served over https with attachment" bash -c "curl -fsSI '$origin/desktop-downloads/$w' | grep -qi '^content-disposition: attachment'"
check "manifest served over https, no-cache" bash -c "curl -fsSI '$origin/desktop-downloads/desktop-releases.json' | grep -qi '^cache-control: no-cache'"
check "staging folder not served" test "$(curl -s -o /dev/null -w '%{http_code}' "$origin/desktop-downloads/.incoming/")" = 404
check "lock file not served" test "$(curl -s -o /dev/null -w '%{http_code}' "$origin/desktop-downloads/.publish.lock")" = 404

echo "duplicates, tampering, downgrades"
check "re-running the same publish is a no-op" publish windows 0.2.2 "$d" "$w"
d2=$(make_installer windows 0.2.2 "$w" "DIFFERENT bytes")
refused "same version, different bytes refused" publish windows 0.2.2 "$d2" "$w"
check "result records the failing stage" test "$(jq -r .status "$d2/result.json")" = "failed: upload"
check "published installer not overwritten" test "$(sha "$dl/$w")" = "$(sha "$d/$w")"
d3=$(make_installer windows 0.2.3 insight-workfolio_0.2.3_windows-x86_64-setup.exe "windows 0.2.3")
jq '.sha256 = "'"$(printf 'b%.0s' {1..64})"'"' "$d3/installer.json" > "$d3/i" && mv "$d3/i" "$d3/installer.json"
refused "artifact whose checksum differs from installer.json refused" publish windows 0.2.3 "$d3" insight-workfolio_0.2.3_windows-x86_64-setup.exe
check "and nothing was uploaded" test ! -e "$dl/insight-workfolio_0.2.3_windows-x86_64-setup.exe"
d4=$(make_installer windows 0.2.0 insight-workfolio_0.2.0_windows-x86_64-setup.exe "old")
refused "downgrade refused" publish windows 0.2.0 "$d4" insight-workfolio_0.2.0_windows-x86_64-setup.exe
check "and nothing was uploaded" test ! -e "$dl/insight-workfolio_0.2.0_windows-x86_64-setup.exe"
refused "platform mismatch refused" publish macos 0.2.2 "$d" "$w"
check "manifest still 0.2.2" test "$(man .windows.version)" = 0.2.2

echo "macOS publishes independently"
m=insight-workfolio_0.2.2_macos-universal.dmg
dm=$(make_installer macos 0.2.2 "$m" "mac bytes")
check "client publishes macOS" publish macos 0.2.2 "$dm" "$m"
check "macOS 0.2.2 universal listed" test "$(man '.macos.version + " " + .macos.arch')" = "0.2.2 Universal (Apple Silicon and Intel)"
check "windows unchanged by macOS publish" test "$(man .windows.version)" = 0.2.2

echo "public URL verification gates activation"
w5=insight-workfolio_0.2.5_windows-x86_64-setup.exe
d5=$(make_installer windows 0.2.5 "$w5" "windows 0.2.5")
refused "unreachable public origin stops before activate" env DESKTOP_DOWNLOADS_ORIGIN="https://localhost:1" bash -c "EXPECTED_PLATFORM=windows EXPECTED_VERSION=0.2.5 COMMIT=$commit bash '$here/desktop-publish.sh' '$d5/installer.json' '$d5/$w5' '$d5/result.json'"
check "result records verify-public-url" test "$(jq -r .status "$d5/result.json")" = "failed: verify-public-url"
check "manifest not switched" test "$(man .windows.version)" = 0.2.2

echo "rollback (local, root-run)"
check "rollback windows" python3 "$receiver" --dir "$dl" rollback windows
check "windows back on 0.2.1" test "$(man .windows.version)" = 0.2.1
check "0.2.2 installer still on disk" test -f "$dl/$w"
check "rolling forward again works" python3 "$receiver" --dir "$dl" rollback windows
check "windows on 0.2.2" test "$(man .windows.version)" = 0.2.2
check "manifest is valid JSON with both platforms" jq -e '.windows and .macos' "$dl/desktop-releases.json"

echo "desktop publish selftest: $pass passed, $fail failed"
[ "$fail" = 0 ]
