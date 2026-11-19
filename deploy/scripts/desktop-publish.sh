#!/usr/bin/env bash
# Publish ONE desktop release to the VPS downloads folder: every platform together, or nothing (run by
# .github/workflows/desktop-publish.yml; never run as root, never needs root on the VPS).
#
#   desktop-publish.sh <result.json> <artifact-dir>...
#
# Each <artifact-dir> is one platform's build artifact (desktop-build.yml): installer.json plus the installer and
# its updater packages/signatures, all checked there for version and architecture. Order, each step gating the next:
#   1. re-check name, version, commit, size and SHA-256 of every file against installer.json, and that there is
#      exactly one installer per expected platform (a missing platform stops here: nothing is uploaded)
#   2. upload every file over SSH to the restricted receiver (forced command; it re-checks size and SHA-256
#      and never overwrites). Uploaded files are not offered to anyone yet.
#   3. download every file again from its PUBLIC https URL and compare the SHA-256
#   4. only then `activate`: the receiver points the manifest at all installers in one atomic write, keeping
#      the previous entries
#   5. read the public manifest back, then download each installer through the link it publishes and compare
# result.json always records how far it got (the release report is built from it).
#
# Environment: CHANNEL (production|test), DESKTOP_DOWNLOADS_ORIGIN (https://<host>), DESKTOP_PUBLISH_SSH_TARGET
# (user@host), DESKTOP_PUBLISH_SSH_KEY_FILE, DESKTOP_PUBLISH_KNOWN_HOSTS_FILE, EXPECTED_VERSION, COMMIT.
# Optional: NOTES_FILE (plain-text release notes), EXPECTED_PLATFORMS (default "macos windows").
# SSH= overrides the ssh binary (selftest only).
set -euo pipefail
result=${1:?usage: desktop-publish.sh <result.json> <artifact-dir>...}; shift
: "${SSH:=ssh}"
stage=verify-artifacts
files='[]' # {platform, kind: installer|updater, file, path, sizeBytes, sha256, url}

write_result() {
  jq -n --arg channel "${CHANNEL:-}" --arg version "${EXPECTED_VERSION:-}" --arg commit "${COMMIT:-}" --arg status "$1" \
    --argjson files "$files" '{channel:$channel, version:$version, commit:$commit, status:$status, files:($files | map(del(.path)))}' > "$result"
}
trap 'rc=$?; [ $rc = 0 ] || write_result "failed: $stage"; exit $rc' EXIT
die() { echo "::error::$*" >&2; exit 1; }
sha_of() { (sha256sum "$1" 2>/dev/null || shasum -a 256 "$1") | cut -d' ' -f1; }
fetch_sha() { curl -fsS --proto =https --retry 3 --retry-delay 5 --max-time 600 "$1" | (sha256sum 2>/dev/null || shasum -a 256) | cut -d' ' -f1; }

for v in CHANNEL DESKTOP_DOWNLOADS_ORIGIN DESKTOP_PUBLISH_SSH_TARGET DESKTOP_PUBLISH_SSH_KEY_FILE DESKTOP_PUBLISH_KNOWN_HOSTS_FILE EXPECTED_VERSION COMMIT; do
  [ -n "${!v:-}" ] || die "$v is not set"
done
case "$DESKTOP_DOWNLOADS_ORIGIN" in https://*) ;; *) die "DESKTOP_DOWNLOADS_ORIGIN must be https://" ;; esac
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "COMMIT must be a full SHA"
# The receiver is the authority on names; this only keeps a build of one channel away from the other's key.
case "$CHANNEL" in
  production) prefix=insight-workfolio_ base=$DESKTOP_DOWNLOADS_ORIGIN/desktop-downloads ;;
  test) prefix=insight-workfolio-test_ base=$DESKTOP_DOWNLOADS_ORIGIN/desktop-downloads/test ;;
  *) die "CHANNEL must be production or test" ;;
esac

# ---- 1. artifacts --------------------------------------------------------------------------------------
[ $# -ge 1 ] || die "no artifact directories given"
for dir in "$@"; do
  meta=$dir/installer.json
  [ -f "$meta" ] || die "$meta is missing: that platform did not build"
  [ "$(jq -er .version "$meta")" = "$EXPECTED_VERSION" ] || die "$meta version differs from $EXPECTED_VERSION"
  [ "$(jq -er .commit "$meta")" = "$COMMIT" ] || die "$meta was built from another commit"
  platform=$(jq -er .platform "$meta")
  while IFS=$'\t' read -r kind name size sha <&3; do
    [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] && [[ "$name" == "$prefix"* ]] || die "unexpected file name '$name' for the $CHANNEL channel"
    [[ "$sha" =~ ^[0-9a-f]{64}$ ]] && [[ "$size" =~ ^[1-9][0-9]*$ ]] || die "bad sha256/size for $name in $meta"
    [ -f "$dir/$name" ] || die "$dir/$name is missing"
    [ "$(wc -c < "$dir/$name" | tr -d ' ')" = "$size" ] || die "size of $name differs from installer.json"
    actual=$(sha_of "$dir/$name")
    [ "$actual" = "$sha" ] || die "sha256 of $name is $actual, installer.json says $sha"
    files=$(jq -c --arg platform "$platform" --arg kind "$kind" --arg file "$name" --arg path "$dir/$name" --argjson size "$size" \
      --arg sha "$sha" --arg url "$base/$name" '. + [{platform:$platform, kind:$kind, file:$file, path:$path, sizeBytes:$size, sha256:$sha, url:$url}]' <<<"$files")
  done 3< <(jq -r '[["installer", .file, .sizeBytes, .sha256]] + [(.extra // [])[] | ["updater", .file, .sizeBytes, .sha256]] | .[] | @tsv' "$meta")
done
got=$(jq -r '[.[] | select(.kind == "installer") | .platform] | sort | join(" ")' <<<"$files")
want=${EXPECTED_PLATFORMS:-macos windows}
[ "$got" = "$want" ] || die "a release needs exactly one installer for each of: $want (got: ${got:-none}); nothing was uploaded"

remote() {
  "$SSH" -i "$DESKTOP_PUBLISH_SSH_KEY_FILE" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile="$DESKTOP_PUBLISH_KNOWN_HOSTS_FILE" -o ConnectTimeout=20 -o ServerAliveInterval=15 \
    "$DESKTOP_PUBLISH_SSH_TARGET" "$@"
}
each_file() { jq -r "$1"' | [.path, .file, (.sizeBytes | tostring), .sha256, .url, .platform] | @tsv' <<<"$files"; }

# ---- 2. upload ------------------------------------------------------------------------------------------
stage=upload
while IFS=$'\t' read -r path name size sha _ <&3; do
  remote upload "$name" "$size" "$sha" < "$path"
done 3< <(each_file '.[]')

# ---- 3. public https download ---------------------------------------------------------------------------
stage=verify-public-url
while IFS=$'\t' read -r _ name _ sha url _ <&3; do
  got=$(fetch_sha "$url")
  [ "$got" = "$sha" ] || die "public $url serves sha256 $got, expected $sha"
  echo "public download verified: $name"
done 3< <(each_file '.[]')

# ---- 4. metadata: all installers in one atomic manifest write ----------------------------------------------
stage=activate
pairs=()
while IFS=$'\t' read -r _ name _ sha _ <&3; do pairs+=("$name" "$sha"); done 3< <(each_file '.[] | select(.kind == "installer")')
remote activate "$COMMIT" "${pairs[@]}" < "${NOTES_FILE:-/dev/null}"

# ---- 5. public manifest, then each installer through the link it publishes ----------------------------------
stage=verify-manifest
live=$(curl -fsS --proto =https --retry 3 --retry-delay 5 "$base/desktop-releases.json")
while IFS=$'\t' read -r _ name _ sha _ platform <&3; do
  [ "$(jq -r --arg p "$platform" '.[$p].file + " " + .[$p].sha256' <<<"$live")" = "$name $sha" ] \
    || die "public manifest does not list $name with sha256 $sha"
  href=$(jq -er --arg p "$platform" '.[$p].href' <<<"$live")
  got=$(fetch_sha "$DESKTOP_DOWNLOADS_ORIGIN$href")
  [ "$got" = "$sha" ] || die "published link $href serves sha256 $got, expected $sha"
  echo "published $platform $EXPECTED_VERSION: $DESKTOP_DOWNLOADS_ORIGIN$href"
done 3< <(each_file '.[] | select(.kind == "installer")')

stage=done
write_result published
