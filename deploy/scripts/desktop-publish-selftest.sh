#!/usr/bin/env bash
# Developer-machine self-test of the desktop publish pipeline (never touches the VPS). Needs python3, jq, curl,
# caddy. Runs the REAL receiver (behind a fake `ssh` that sets SSH_ORIGINAL_COMMAND like a forced command, with
# the options each channel's forced command carries), the REAL client script, and Caddy serving the
# /desktop-downloads route copied from deploy/caddy/Caddyfile.ip over https (internal CA) from a temporary folder.
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
check() { local msg=$1; shift; if "$@" >"$tmp/out" 2>&1; then ok "$msg"; else bad "$msg"; sed 's/^/      | /' "$tmp/out" >&2; fi; }
refused() { local msg=$1; shift; if "$@" >"$tmp/out" 2>&1; then bad "$msg (was accepted)"; else ok "$msg"; fi; }
sha() { (sha256sum "$1" 2>/dev/null || shasum -a 256 "$1") | cut -d' ' -f1; }
size() { wc -c < "$1" | tr -d ' '; }

dl="$tmp/downloads"; mkdir -p "$dl/test" "$tmp/bin" "$tmp/in"
cp "$repo/apps/dashboard/src/lib/desktop-releases.json" "$dl/desktop-releases.json"
echo '{}' > "$dl/test/desktop-releases.json"
legacy=$(jq -r .windows.file "$dl/desktop-releases.json")
echo "legacy installer stand-in" > "$dl/$legacy"
receiver="$here/desktop-downloads-receiver.py"

# Fake ssh: drop options, then hand the rest to the receiver exactly as sshd's forced command for that user would.
cat > "$tmp/bin/ssh" <<EOF
#!/usr/bin/env bash
while [[ \$1 == -* ]]; do shift 2; done; target=\$1; shift
case \$target in workfolio-publisher-test@*) opts=(--dir "$dl/test" --test) ;; *) opts=(--dir "$dl") ;; esac
SSH_ORIGINAL_COMMAND="\$*" exec python3 "$receiver" "\${opts[@]}"
EOF
chmod +x "$tmp/bin/ssh"
rx() { SSH_ORIGINAL_COMMAND="$*" python3 "$receiver" --dir "$dl" </dev/null; }
rxt() { SSH_ORIGINAL_COMMAND="$*" python3 "$receiver" --dir "$dl/test" --test </dev/null; }
local_rx() { python3 "$receiver" --dir "$dl" "$@" </dev/null; }

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
code() { curl -s -o /dev/null -w '%{http_code}' "$origin$1"; }

export SSH="$tmp/bin/ssh" DESKTOP_DOWNLOADS_ORIGIN="$origin" DESKTOP_PUBLISH_SSH_KEY_FILE=/dev/null DESKTOP_PUBLISH_KNOWN_HOSTS_FILE=/dev/null
commit=0123456789abcdef0123456789abcdef01234567
a64=$(printf 'a%.0s' {1..64})

# artifact <dir> <platform> <version> <installer> <content> [updater-file...]: one platform's build artifact,
# the way desktop-build.yml writes it (installer.json lists the installer and, under extra, the updater files).
artifact() {
  local d=$1 platform=$2 version=$3 name=$4 content=$5 extra='[]' e; shift 5
  mkdir -p "$d"; printf '%s' "$content" > "$d/$name"
  for e in "$@"; do
    printf 'updater file %s %s' "$e" "$content" > "$d/$e"
    extra=$(jq -c --arg f "$e" --arg s "$(sha "$d/$e")" --argjson n "$(size "$d/$e")" '. + [{file:$f, sizeBytes:$n, sha256:$s}]' <<<"$extra")
  done
  jq -n --arg p "$platform" --arg f "$name" --arg v "$version" --arg s "$(sha "$d/$name")" --argjson n "$(size "$d/$name")" --arg c "$commit" \
    --argjson extra "$extra" '{platform:$p, file:$f, version:$v, arch:"x", sizeBytes:$n, sha256:$s, commit:$c, extra:$extra}' > "$d/installer.json"
}
# release <stem> <version> <tag>: both platforms under $tmp/in/<tag>/; stem = file name up to and including the version/build.
release() {
  local s=$1 v=$2 r="$tmp/in/$3"
  artifact "$r/windows" windows "$v" "${s}_windows-x86_64-setup.exe" "windows $3" "${s}_windows-x86_64-setup.exe.sig"
  artifact "$r/macos" macos "$v" "${s}_macos-universal.dmg" "macos $3" "${s}_darwin-universal.app.tar.gz" "${s}_darwin-universal.app.tar.gz.sig"
  echo "$r"
}
# publish <channel> <version> <release-dir> [artifact-dir...] (default: both platforms)
publish() {
  local channel=$1 v=$2 r=$3 target=workfolio-publisher@test; shift 3
  [ $# -gt 0 ] || set -- "$r/windows" "$r/macos"
  [ "$channel" = production ] || target=workfolio-publisher-test@test
  CHANNEL=$channel DESKTOP_PUBLISH_SSH_TARGET=$target EXPECTED_VERSION=$v COMMIT=$commit bash "$here/desktop-publish.sh" "$r/result.json" "$@"
}
man() { jq -r "$1" "$dl/desktop-releases.json"; }
mant() { jq -r "$1" "$dl/test/desktop-releases.json"; }
w() { echo "insight-workfolio_$1_windows-x86_64-setup.exe"; }
m() { echo "insight-workfolio_$1_macos-universal.dmg"; }

echo "receiver over SSH: only upload/activate/status/history, only valid names"
refused "shell command refused" rx bash -c id
refused "rollback not reachable over SSH" rx rollback windows
refused "path traversal name refused" rx upload ../evil.exe 1 "$a64"
check "quoted name with trailing newline refused as invalid name" bash -c "SSH_ORIGINAL_COMMAND=\$'upload \\'insight-workfolio_9.9.9_windows-x86_64-setup.exe\\n\\' 1 $a64' python3 '$receiver' --dir '$dl' </dev/null 2>&1 | grep -q 'invalid file name'"
refused "unparsable quoting refused" rx "upload 'x"
refused "foreign name refused" rx upload Insight-Workfolio_9.9.9_x64-setup.exe 1 "$a64"
refused "TEST name refused on the production channel" rx upload insight-workfolio-test_9.9.9_r1-1_windows-x86_64-setup.exe 1 "$a64"
refused "production name refused on the test channel" rxt upload "$(w 9.9.9)" 1 "$a64"
refused "size over limit refused" rx upload "$(w 9.9.9)" 999999999999 "$a64"
check "status prints the manifest" rx status
check "history is readable" rx history
refused "short body refused" bash -c "printf abc | SSH_ORIGINAL_COMMAND='upload $(w 0.2.2) 10 $a64' python3 '$receiver' --dir '$dl'"
refused "wrong sha256 refused" bash -c "printf abc | SSH_ORIGINAL_COMMAND='upload $(w 0.2.2) 3 $a64' python3 '$receiver' --dir '$dl'"
check "nothing left behind by refused uploads" test -z "$(ls -A "$dl/.incoming")" -a ! -e "$dl/$(w 0.2.2)"
refused "activate of a file never uploaded refused" rx activate "$commit" "$(w 0.2.2)" "$a64"

echo "release 0.2.2: both platforms, updater packages, notes"
r=$(release insight-workfolio_0.2.2 0.2.2 r022)
printf 'Fixes the clock-in button.\nFaster start.\n' > "$tmp/notes.txt"
NOTES_FILE="$tmp/notes.txt" check "client publishes both platforms" publish production 0.2.2 "$r"
check "result says published" test "$(jq -r .status "$r/result.json")" = published
check "result lists 5 files (2 installers, 3 updater files)" test "$(jq -r '[.files[].kind] | sort | join(",")' "$r/result.json")" = installer,installer,updater,updater,updater
check "windows 0.2.2 listed with checksum and href" test "$(man '.windows.version + " " + .windows.sha256 + " " + .windows.href')" = "0.2.2 $(sha "$r/windows/$(w 0.2.2)") /desktop-downloads/$(w 0.2.2)"
check "macOS 0.2.2 universal listed" test "$(man '.macos.version + " " + .macos.arch')" = "0.2.2 Universal (Apple Silicon and Intel)"
check "release notes stored" test "$(man .windows.notes)" = "$(printf 'Fixes the clock-in button.\nFaster start.')"
check "previous entries kept for rollback" test "$(man '.windows.previous.version + " " + .macos.previous.version')" = "0.2.1 0.1.0"
check "installer served over https with attachment" bash -c "curl -fsSI '$origin/desktop-downloads/$(w 0.2.2)' | grep -qi '^content-disposition: attachment'"
check "updater package served with the uploaded bytes" test "$(curl -fsS "$origin/desktop-downloads/insight-workfolio_0.2.2_darwin-universal.app.tar.gz" | (sha256sum 2>/dev/null || shasum -a 256) | cut -d' ' -f1)" = "$(sha "$r/macos/insight-workfolio_0.2.2_darwin-universal.app.tar.gz")"
check "updater signature served" test "$(code "/desktop-downloads/$(w 0.2.2).sig")" = 200
check "manifest served over https, no-cache" bash -c "curl -fsSI '$origin/desktop-downloads/desktop-releases.json' | grep -qi '^cache-control: no-cache'"
check "staging folder not served" test "$(code /desktop-downloads/.incoming/)" = 404
check "lock file not served" test "$(code /desktop-downloads/.publish.lock)" = 404
check "audit log not served" test "$(code /desktop-downloads/desktop-release-history.jsonl)" = 404
check "audit log records both activations" test "$(rx history | jq -r 'select(.action == "activate") | .platform + " " + .entry.version' | sort | xargs)" = "macos 0.2.2 windows 0.2.2"
refused "activate of an updater file refused" rx activate "$commit" "$(w 0.2.2).sig" "$(sha "$r/windows/$(w 0.2.2).sig")"
refused "two installers for one platform refused" rx activate "$commit" "$(w 0.2.2)" "$(sha "$r/windows/$(w 0.2.2)")" "$(w 0.2.2)" "$(sha "$r/windows/$(w 0.2.2)")"

echo "all or nothing"
after_022=$(cat "$dl/desktop-releases.json")
r3=$(release insight-workfolio_0.2.3 0.2.3 r023)
refused "a release with only Windows is refused" publish production 0.2.3 "$r3" "$r3/windows"
check "result records the failing stage" test "$(jq -r .status "$r3/result.json")" = "failed: verify-artifacts"
jq --arg s "$a64" '.sha256 = $s' "$r3/macos/installer.json" > "$r3/i" && mv "$r3/i" "$r3/macos/installer.json"
refused "a release whose macOS checksum is wrong is refused" publish production 0.2.3 "$r3"
check "and no file of it was uploaded, Windows included" bash -c "! ls '$dl' | grep -q 0.2.3"
check "manifest unchanged" test "$(cat "$dl/desktop-releases.json")" = "$after_022"
r5=$(release insight-workfolio_0.2.5 0.2.5 r025)
DESKTOP_DOWNLOADS_ORIGIN="https://localhost:1" refused "unreachable public origin stops before activate" publish production 0.2.5 "$r5"
check "result records verify-public-url" test "$(jq -r .status "$r5/result.json")" = "failed: verify-public-url"
check "manifest unchanged: uploaded files are not offered" test "$(cat "$dl/desktop-releases.json")" = "$after_022"

echo "duplicates, tampering, downgrades"
check "re-running the same publish is a no-op" publish production 0.2.2 "$r"
check "manifest unchanged by the re-run" test "$(cat "$dl/desktop-releases.json")" = "$after_022"
r2=$(release insight-workfolio_0.2.2 0.2.2 r022-other-bytes)
refused "same version, different bytes refused" publish production 0.2.2 "$r2"
check "result records the upload stage" test "$(jq -r .status "$r2/result.json")" = "failed: upload"
check "published installer not overwritten" test "$(sha "$dl/$(w 0.2.2)")" = "$(sha "$r/windows/$(w 0.2.2)")"
r0=$(release insight-workfolio_0.2.0 0.2.0 r020)
refused "downgrade refused" publish production 0.2.0 "$r0"
check "and nothing was uploaded" test ! -e "$dl/$(w 0.2.0)"
refused "release notes with control characters refused" bash -c "printf 'bad\\033[31m' | SSH_ORIGINAL_COMMAND='activate $commit $(w 0.2.2) $(sha "$r/windows/$(w 0.2.2)")' python3 '$receiver' --dir '$dl'"

echo "TEST channel: its own folder, manifest and names; production untouched"
t1=$(release insight-workfolio-test_0.2.1_r100-1 0.2.1 t100)
check "TEST release publishes" publish test 0.2.1 "$t1"
tw1=insight-workfolio-test_0.2.1_r100-1_windows-x86_64-setup.exe
check "TEST manifest lists it under /desktop-downloads/test/" test "$(mant .windows.href)" = "/desktop-downloads/test/$tw1"
check "TEST installer served" test "$(code "/desktop-downloads/test/$tw1")" = 200
check "TEST manifest served" test "$(curl -fsS "$origin/desktop-downloads/test/desktop-releases.json" | jq -r .macos.version)" = 0.2.1
check "production manifest untouched by the TEST release" test "$(cat "$dl/desktop-releases.json")" = "$after_022"
check "no TEST file in the production folder" bash -c "! ls '$dl' | grep -q insight-workfolio-test"
check "TEST audit log and staging folder not served" test "$(code /desktop-downloads/test/desktop-release-history.jsonl) $(code /desktop-downloads/test/.incoming/)" = "404 404"
refused "a TEST build cannot be published with the production channel" publish production 0.2.1 "$t1"
refused "a production build cannot be published with the test channel" publish test 0.2.2 "$r"
t2=$(release insight-workfolio-test_0.2.1_r101-1 0.2.1 t101)
check "a second TEST run of the same version publishes" publish test 0.2.1 "$t2"
check "TEST manifest now on run 101, run 100 kept as previous" test "$(mant '.windows.file + " " + .windows.previous.file')" = "insight-workfolio-test_0.2.1_r101-1_windows-x86_64-setup.exe $tw1"
check "the previous TEST installer is still downloadable, unchanged" test "$(curl -fsS "$origin/desktop-downloads/test/$tw1" | (sha256sum 2>/dev/null || shasum -a 256) | cut -d' ' -f1)" = "$(sha "$t1/windows/$tw1")"
refused "an older TEST run is refused" publish test 0.2.1 "$t1"

echo "history and rollback (local, root-run)"
check "rollback windows" local_rx rollback windows
check "windows back on 0.2.1, macOS untouched" test "$(man '.windows.version + " " + .macos.version')" = "0.2.1 0.2.2"
check "0.2.2 installer still on disk" test -f "$dl/$(w 0.2.2)"
check "rolling forward again works" local_rx rollback windows
r4=$(release insight-workfolio_0.2.4 0.2.4 r024)
check "release 0.2.4 publishes" publish production 0.2.4 "$r4"
check "restore 0.2.2 by version from the audit log" local_rx rollback windows 0.2.2
check "windows on 0.2.2 with 0.2.4 as previous" test "$(man '.windows.version + " " + .windows.sha256 + " " + .windows.previous.version')" = "0.2.2 $(sha "$r/windows/$(w 0.2.2)") 0.2.4"
check "its link serves the 0.2.2 bytes" test "$(curl -fsS "$origin$(man .windows.href)" | (sha256sum 2>/dev/null || shasum -a 256) | cut -d' ' -f1)" = "$(sha "$r/windows/$(w 0.2.2)")"
refused "restoring a version never published is refused" local_rx rollback windows 9.9.9
check "audit log records the rollbacks" test "$(local_rx history | jq -r 'select(.action == "rollback") | .entry.version' | xargs)" = "0.2.1 0.2.2 0.2.2"
check "manifest is valid JSON with both platforms" jq -e '.windows and .macos' "$dl/desktop-releases.json"

echo "desktop publish selftest: $pass passed, $fail failed"
[ "$fail" = 0 ]
