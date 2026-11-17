#!/usr/bin/env bash
# Publish ONE verified desktop installer to the VPS downloads folder (run by .github/workflows/desktop-publish.yml
# after manual approval; never run as root, never needs root on the VPS).
#
#   desktop-publish.sh <installer.json> <installer-file> <result.json>
#
# installer.json is written by the build job (desktop-build.yml) after it checked version and architecture.
# Order, each step gating the next:
#   1. re-check name, version, size and SHA-256 of the artifact against installer.json
#   2. upload over SSH to the restricted receiver (forced command; it re-checks size and SHA-256 and never
#      overwrites an existing installer)
#   3. download it again from the PUBLIC https URL and compare the SHA-256
#   4. only then `activate`: the receiver swaps the dashboard manifest atomically, keeping the previous entry
#   5. read the public manifest back and check it lists this file and checksum
# result.json always records how far it got (the release report is built from it).
#
# Environment: DESKTOP_DOWNLOADS_ORIGIN (https://<host>), DESKTOP_PUBLISH_SSH_TARGET (user@host),
# DESKTOP_PUBLISH_SSH_KEY_FILE, DESKTOP_PUBLISH_KNOWN_HOSTS_FILE, EXPECTED_PLATFORM, EXPECTED_VERSION, COMMIT.
# SSH= overrides the ssh binary (selftest only).
set -euo pipefail
meta=$1 file=$2 result=$3
: "${SSH:=ssh}"
stage=verify-artifact
platform=${EXPECTED_PLATFORM:-} version=${EXPECTED_VERSION:-} name="" sha="" size="" url=""

write_result() {
  local status=$1
  jq -n --arg platform "$platform" --arg version "$version" --arg commit "${COMMIT:-}" --arg file "$name" \
    --arg sha256 "$sha" --arg size "$size" --arg url "$url" --arg status "$status" \
    '{platform:$platform, version:$version, commit:$commit, file:$file, sha256:$sha256,
      sizeBytes:($size|tonumber? // null), url:$url, status:$status}' > "$result"
}
trap 'rc=$?; [ $rc = 0 ] || write_result "failed: $stage"; exit $rc' EXIT
die() { echo "::error::$*" >&2; exit 1; }

for v in DESKTOP_DOWNLOADS_ORIGIN DESKTOP_PUBLISH_SSH_TARGET DESKTOP_PUBLISH_SSH_KEY_FILE DESKTOP_PUBLISH_KNOWN_HOSTS_FILE EXPECTED_PLATFORM EXPECTED_VERSION COMMIT; do
  [ -n "${!v:-}" ] || die "$v is not set"
done
case "$DESKTOP_DOWNLOADS_ORIGIN" in https://*) ;; *) die "DESKTOP_DOWNLOADS_ORIGIN must be https://" ;; esac
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "COMMIT must be a full SHA"

# ---- 1. artifact ---------------------------------------------------------------------------------------
name=$(jq -er .file "$meta"); sha=$(jq -er .sha256 "$meta"); size=$(jq -er .sizeBytes "$meta")
[ "$(jq -er .platform "$meta")" = "$platform" ] || die "installer.json platform differs from $platform"
[ "$(jq -er .version "$meta")" = "$version" ] || die "installer.json version differs from $version"
[ "$(jq -er .commit "$meta")" = "$COMMIT" ] || die "installer.json was built from another commit"
case "$platform" in
  windows) re="^insight-workfolio_${version//./\\.}_windows-x86_64-setup\\.exe$" ;;
  macos) re="^insight-workfolio_${version//./\\.}_macos-(universal|aarch64)\\.dmg$" ;;
  *) die "unknown platform $platform" ;;
esac
[[ "$name" =~ $re ]] || die "unexpected installer name $name"
[ "$(basename "$file")" = "$name" ] || die "file $file is not $name"
[[ "$sha" =~ ^[0-9a-f]{64}$ ]] && [[ "$size" =~ ^[1-9][0-9]*$ ]] || die "bad sha256/size in installer.json"
[ "$(wc -c < "$file" | tr -d ' ')" = "$size" ] || die "size of $file differs from installer.json"
actual=$( (sha256sum "$file" 2>/dev/null || shasum -a 256 "$file") | cut -d' ' -f1)
[ "$actual" = "$sha" ] || die "sha256 of $file is $actual, installer.json says $sha"
url="$DESKTOP_DOWNLOADS_ORIGIN/desktop-downloads/$name"

remote() {
  "$SSH" -i "$DESKTOP_PUBLISH_SSH_KEY_FILE" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile="$DESKTOP_PUBLISH_KNOWN_HOSTS_FILE" -o ConnectTimeout=20 -o ServerAliveInterval=15 \
    "$DESKTOP_PUBLISH_SSH_TARGET" "$@"
}

# ---- 2. upload ------------------------------------------------------------------------------------------
stage=upload
remote upload "$name" "$size" "$sha" < "$file"

# ---- 3. public https download ---------------------------------------------------------------------------
stage=verify-public-url
got=$(curl -fsS --proto =https --retry 3 --retry-delay 5 --max-time 600 "$url" | (sha256sum 2>/dev/null || shasum -a 256) | cut -d' ' -f1)
[ "$got" = "$sha" ] || die "public $url serves sha256 $got, expected $sha"

# ---- 4. metadata ----------------------------------------------------------------------------------------
stage=activate
remote activate "$name" "$sha" "$COMMIT"

# ---- 5. public manifest ---------------------------------------------------------------------------------
stage=verify-manifest
live=$(curl -fsS --proto =https --retry 3 --retry-delay 5 "$DESKTOP_DOWNLOADS_ORIGIN/desktop-downloads/desktop-releases.json")
[ "$(jq -r --arg p "$platform" '.[$p].file + " " + .[$p].sha256' <<<"$live")" = "$name $sha" ] \
  || die "public manifest does not list $name with sha256 $sha"

stage=done
write_result published
echo "published $platform $version: $url"
