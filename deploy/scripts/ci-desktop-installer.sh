#!/usr/bin/env bash
# UNSIGNED desktop installers built by .github/workflows/ci.yml (docs/deployment.md, "CI installers").
#
#   ci-desktop-installer.sh windows|macos   verify the installer just built on this machine from its bytes and
#                                           collect it into $OUT as <name>_UNSIGNED-<TEST|QA>.<ext> (the label
#                                           stays with the file once it leaves the artifact), with its .sha256
#                                           and build-metadata.json
#   ci-desktop-installer.sh gate <dir>      <dir> holds one downloaded artifact folder per platform: fail unless
#                                           there is exactly one Windows and one macOS installer, each built from
#                                           $GITHUB_SHA and matching its SHA-256
#   ci-desktop-installer.sh selftest        the gate against made-up artifacts, including the ones it must reject
#
# The macOS half also runs on a developer Mac, after
# `WORKFOLIO_API_URL=https://api.example.invalid pnpm --filter @workfolio/desktop package -- --bundles app,dmg --target universal-apple-darwin`:
#   API_URL=https://api.example.invalid MAC_TARGET=universal OUT=/tmp/installer deploy/scripts/ci-desktop-installer.sh macos
#
# Collect checks: the installer for the tauri.conf.json version and the expected app name exists; version and
# CPU architecture read from the built app; the app identity is the one desktop-config.mjs gives this API URL
# (macOS: bundle identifier and name from the app inside the DMG; both: the identifier compiled into the binary),
# and a TEST build never carries the production identity; the packaged API origin is the requested one, never
# the dev API, and never the placeholder in a build for a real server.
# Environment: API_URL (required, the WORKFOLIO_API_URL the build was made with), MAC_TARGET=aarch64|universal
# (default aarch64), OUT (default qa). Commit, branch and run come from the GitHub runner variables.
# "Unsigned": ci.yml gives its jobs no secret and no signing variable, and this script stops if one is set.
# On macOS the absence of a certificate is also read from the app (codesign); on Windows it is not read back.
set -euo pipefail
cd "$(dirname "$0")/../.."

die() { echo "::error::$*" >&2; exit 1; }
# count(): occurrences of a fixed string in a binary.
count() { { grep -aoF -- "$1" "$2" || true; } | wc -l | tr -d ' '; }
# built(): the installer exists under its exact expected name; otherwise show what the bundler did write.
built() { [ -f "$1" ] || { ls -l "$(dirname "$1")" >&2 || true; die "no installer $1"; }; }

if [ "${1:-}" = gate ]; then
  dir=${2:?usage: ci-desktop-installer.sh gate <dir>}
  commit=${GITHUB_SHA:?GITHUB_SHA is required}
  summary=${GITHUB_STEP_SUMMARY:-/dev/null}
  {
    echo "## Unsigned desktop installers for \`$commit\`"
    echo "| Platform | Arch | Version | Build type | API | File | Bytes | SHA-256 |"
    echo "|---|---|---|---|---|---|---|---|"
  } >> "$summary"
  seen=
  for meta in "$dir"/*/build-metadata.json; do
    [ -f "$meta" ] || die "no installer artifacts in $dir"
    folder=$(dirname "$meta")
    # shellcheck disable=SC2016 # JavaScript template literals, not shell expansions
    row=$(META=$meta COMMIT=$commit node -e '
      const fs = require("fs"), path = require("path"), crypto = require("crypto"), e = process.env;
      const m = JSON.parse(fs.readFileSync(e.META, "utf8"));
      const bytes = fs.readFileSync(path.join(path.dirname(e.META), m.file));
      const sha = crypto.createHash("sha256").update(bytes).digest("hex");
      const listed = fs.readFileSync(path.join(path.dirname(e.META), m.file + ".sha256"), "utf8").split(/\s+/)[0];
      const fail = (why) => { console.error(`::error::${m.file}: ${why}`); process.exit(1); };
      if (m.commit !== e.COMMIT) fail(`built from ${m.commit}, not ${e.COMMIT}`);
      if (sha !== m.sha256 || sha !== listed) fail(`SHA-256 ${sha} differs from metadata ${m.sha256} / checksum file ${listed}`);
      if (bytes.length !== m.sizeBytes) fail(`${bytes.length} bytes, metadata says ${m.sizeBytes}`);
      if (m.signed !== false) fail("metadata does not say signed: false");
      console.log(`${m.platform}\t| ${m.platform} | ${m.arch} | ${m.version} | ${m.buildType} | ${m.apiUrl} | ${m.file} | ${m.sizeBytes} | \`${m.sha256}\` |`);')
    echo "verified $folder"
    seen="$seen ${row%%$'\t'*}"
    echo "${row#*$'\t'}" >> "$summary"
  done
  got=$(echo "$seen" | tr ' ' '\n' | sort | xargs)
  [ "$got" = "macos windows" ] || die "expected exactly one macOS and one Windows installer for $commit, got: ${got:-none}"
  echo "both installers present and verified for $commit"
  exit 0
fi

if [ "${1:-}" = selftest ]; then
  self=deploy/scripts/ci-desktop-installer.sh
  t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
  export GITHUB_SHA=0123456789abcdef0123456789abcdef01234567; unset GITHUB_STEP_SUMMARY
  mk() { # mk <platform> <file>: one artifact folder as the collect step writes it
    mkdir -p "$t/a/$1"; printf '%s installer bytes' "$1" > "$t/a/$1/$2"
    # shellcheck disable=SC2016 # JavaScript template literals, not shell expansions
    D=$t/a/$1 P=$1 F=$2 node -e '
      const fs = require("fs"), crypto = require("crypto"), e = process.env, bytes = fs.readFileSync(`${e.D}/${e.F}`);
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      fs.writeFileSync(`${e.D}/${e.F}.sha256`, `${sha256}  ${e.F}\n`);
      fs.writeFileSync(`${e.D}/build-metadata.json`, JSON.stringify({ platform: e.P, arch: "x", version: "1.0.0", file: e.F,
        sizeBytes: bytes.length, sha256, buildType: "selftest", signed: false, apiUrl: "https://api.example.invalid", commit: e.GITHUB_SHA }));'
  }
  fresh() { rm -rf "$t/a"; mk windows "App_1.0.0_x64-setup.exe"; mk macos "App Name_1.0.0_universal.dmg"; }
  rejects() { if bash "$self" gate "$t/a" >/dev/null 2>&1; then die "selftest: the gate accepted $1"; fi; echo "rejected as expected: $1"; }
  fresh; bash "$self" gate "$t/a" >/dev/null || die "selftest: the gate rejected a valid pair"
  fresh; rm -rf "$t/a/macos"; rejects "a missing macOS installer"
  fresh; rm -rf "$t/a/windows"; rejects "a missing Windows installer"
  fresh; cp -R "$t/a/windows" "$t/a/windows-again"; rejects "two Windows installers"
  fresh; echo changed >> "$t/a/macos/App Name_1.0.0_universal.dmg"; rejects "installer bytes that differ from the checksum"
  fresh; perl -pi -e 's/"signed":false/"signed":true/' "$t/a/windows/build-metadata.json"; rejects "metadata claiming a signed build"
  fresh; GITHUB_SHA=ffffffffffffffffffffffffffffffffffffffff rejects "installers built from another commit"
  rm -rf "$t/a"; mkdir "$t/a"; rejects "no artifacts at all"
  echo "selftest passed"
  exit 0
fi

platform=${1:?usage: ci-desktop-installer.sh windows|macos|gate <dir>|selftest}
: "${API_URL:?API_URL is required (the WORKFOLIO_API_URL the installer was built with)}"
for k in APPLE_SIGNING_IDENTITY APPLE_CERTIFICATE WINDOWS_CERTIFICATE_THUMBPRINT AZURE_TRUSTED_SIGNING_ENDPOINT WORKFOLIO_UPDATER_PUBKEY; do
  [ -z "${!k:-}" ] || die "$k is set: this script only collects unsigned builds without the updater (signed builds: desktop-build.yml)"
done
out=${OUT:-qa}
tauri=apps/desktop/src-tauri
v=$(node -p 'require("./apps/desktop/src-tauri/tauri.conf.json").version')
prod_id=$(node -p 'require("./apps/desktop/src-tauri/tauri.conf.json").identifier')
prod_name=$(node -p 'require("./apps/desktop/src-tauri/tauri.conf.json").productName')
origin=$(node -p 'new URL(process.env.API_URL).origin')
# The identity this build must carry: the rule the build itself used (desktop-config.mjs environmentIdentity).
# shellcheck disable=SC2016 # JavaScript template literal, not a shell expansion
identity=$(node -e 'import("./apps/desktop/scripts/desktop-config.mjs").then((m) => {
  const i = m.environmentIdentity(process.env.WORKFOLIO_ENV, process.env.API_URL);
  console.log(`${i.env}\t${i.identifier}\t${i.productName}`);
}).catch((e) => { console.error(`::error::build identity: ${e.message}`); process.exit(1); })')
IFS=$'\t' read -r identity_env want_id product <<<"$identity"
if [ -z "$identity_env" ] || [ -z "$want_id" ] || [ -z "$product" ]; then die "could not read the build identity from desktop-config.mjs"; fi
# TEST: the placeholder API on the reserved .invalid TLD (RFC 2606), which can never resolve, built as the separate
# test app. QA: any real API URL (a manual run), built with the identity WORKFOLIO_ENV names (production by default).
if [ "$identity_env" = test ]; then kind=TEST; else kind=QA; fi
# Independent of that rule: a TEST installer must not be the production app.
if [ "$kind" = TEST ] && { [ "$want_id" = "$prod_id" ] || [ "$product" = "$prod_name" ]; }; then
  die "a TEST build would carry the production identity ($want_id, $product)"
fi
echo "expected identity: $identity_env, $want_id, \"$product\" (UNSIGNED-$kind)"

case $platform in
  windows)
    arch=x86_64
    installer="$tauri/target/release/bundle/nsis/${product}_${v}_x64-setup.exe"
    built "$installer"
    binary=$tauri/target/release/insight-workfolio-desktop.exe
    binaries=("$binary")
    built_archs=x86_64
    # Version of the installer and the app, and PE machine x86_64 (same verifier as desktop-build.yml).
    pwsh -NoProfile -File deploy/scripts/verify-windows-installer.ps1 -Installer "$installer" -App "$binary" -Version "$v"
    ;;
  macos)
    arch=${MAC_TARGET:-aarch64}
    case $arch in
      aarch64) dir=$tauri/target/release; want_archs=arm64 ;;
      universal) dir=$tauri/target/universal-apple-darwin/release; want_archs="arm64 x86_64" ;;
      *) die "MAC_TARGET must be aarch64 or universal, not $arch" ;;
    esac
    installer="$dir/bundle/dmg/${product}_${v}_${arch}.dmg"
    built "$installer"
    mnt=$(mktemp -d)
    hdiutil attach -nobrowse -readonly -mountpoint "$mnt" "$installer" >/dev/null
    slices=
    trap 'hdiutil detach "$mnt" -quiet || true; rm -rf "$mnt" "$slices"' EXIT
    apps=("$mnt"/*.app)
    if [ ${#apps[@]} != 1 ] || [ ! -d "${apps[0]}" ]; then die "expected one .app in the DMG"; fi
    plist=${apps[0]}/Contents/Info.plist
    ver=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist")
    bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")
    bundle_name=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$plist")
    binary=${apps[0]}/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$plist")
    archs=$(lipo -archs "$binary" | tr ' ' '\n' | sort | xargs)
    echo "app in DMG: $(basename "${apps[0]}"), name $bundle_name, version $ver, identifier $bundle_id, architectures: $archs"
    built_archs=$archs
    [ "$ver" = "$v" ] || die "app in DMG is $ver, not $v"
    [ "$bundle_id" = "$want_id" ] || die "identifier $bundle_id, expected $want_id"
    [ "$bundle_name" = "$product" ] || die "app name '$bundle_name', expected '$product'"
    [ "$(basename "${apps[0]}")" = "$product.app" ] || die "app folder $(basename "${apps[0]}"), expected $product.app"
    [ "$archs" = "$want_archs" ] || die "architectures '$archs', expected '$want_archs'"
    # Universal: the API origin is checked in each architecture's slice, not just somewhere in the fat file.
    binaries=("$binary")
    if [ "$arch" = universal ]; then
      slices=$(mktemp -d); binaries=()
      for a in $archs; do lipo "$binary" -thin "$a" -output "$slices/$a"; binaries+=("$slices/$a"); done
    fi
    # No Developer ID: the linker's ad-hoc signature only, which Gatekeeper blocks on other Macs.
    sig=$(codesign -dv --verbose=2 "${apps[0]}" 2>&1 || true)
    grep -E '^(Signature|Authority|TeamIdentifier)=' <<<"$sig" || true
    if grep -q '^Authority=' <<<"$sig"; then die "the app is signed with a certificate; this script only collects unsigned builds"; fi
    ;;
  *) die "unknown platform $platform (windows, macos or gate)" ;;
esac

# The packaged front end and the app binary (CSP connect-src) must name the requested origin. The identifier
# compiled into the binary (keychain service, bundle identifier) must be this build's own: in a TEST binary
# every occurrence of the production identifier is the longer test one, and no other binary holds the test one.
# (Counted, not pattern-matched: Rust stores strings back to back, so the next string follows without a gap.)
grep -rqF -- "$origin" apps/desktop/dist/assets || die "the packaged front end does not name $origin"
for b in "${binaries[@]}"; do
  grep -aqF -- "$origin" "$b" || die "the app binary $b does not name $origin"
  n_any=$(count "$prod_id" "$b"); n_own=$(count "$want_id" "$b"); n_test=$(count "$prod_id.test" "$b")
  [ "$n_own" -ge 1 ] || die "the app binary $b does not hold the identifier $want_id"
  if [ "$kind" = TEST ]; then
    [ "$n_any" = "$n_own" ] || die "the TEST binary $b also holds the production identifier ($n_own of $n_any occurrences are the test one)"
  elif [ "$n_test" != 0 ]; then
    die "a build for $origin holds the test identifier ($b)"
  fi
  if grep -aqF localhost:4000 "$b"; then die "the app binary $b contains the dev API localhost:4000"; fi
  if [ "$kind" = QA ] && grep -aqF example.invalid "$b"; then
    die "a build for $origin still contains the example.invalid placeholder ($b)"
  fi
done
echo "packaged API origin: $origin (UNSIGNED-$kind)"
if [ "$kind" = TEST ]; then echo "::notice::$platform installer packages $origin (.invalid can never resolve): a test build that cannot reach any server"; fi

mkdir -p "$out"
base=$(basename "$installer")
file="${base%.*}_UNSIGNED-$kind.${base##*.}"
cp "$installer" "$out/$file"
commit=${GITHUB_SHA:-$(git rev-parse HEAD)$(git diff --quiet HEAD || echo -dirty)}
# shellcheck disable=SC2016 # JavaScript template literals, not shell expansions
PLATFORM=$platform ARCH=$arch ARCHS=$built_archs VERSION=$v FILE=$file OUT_DIR=$out KIND=$kind BUNDLE_ID=$want_id PRODUCT=$product \
  IDENTITY=$identity_env COMMIT=$commit \
  REF=${GITHUB_REF_NAME:-$(git rev-parse --abbrev-ref HEAD)} node -e '
  const fs = require("fs"), path = require("path"), crypto = require("crypto"), e = process.env;
  const bytes = fs.readFileSync(path.join(e.OUT_DIR, e.FILE));
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const meta = { platform: e.PLATFORM, arch: e.ARCH, archs: e.ARCHS, version: e.VERSION, file: e.FILE, sizeBytes: bytes.length, sha256,
    buildType: e.KIND === "TEST" ? "unsigned-test (placeholder API, cannot reach any server)" : "unsigned-qa (real API URL)",
    identity: e.IDENTITY, productName: e.PRODUCT, bundleId: e.BUNDLE_ID,
    signed: false, notarized: false, updater: false, apiUrl: e.API_URL,
    ...(e.ARCH === "universal" && { intelSliceLaunched: false }), // built and read from bytes only, never run on Intel hardware
    commit: e.COMMIT, ref: e.REF, runId: e.GITHUB_RUN_ID ?? "local", runAttempt: e.GITHUB_RUN_ATTEMPT ?? "local" };
  fs.writeFileSync(path.join(e.OUT_DIR, e.FILE + ".sha256"), `${sha256}  ${e.FILE}\n`);
  fs.writeFileSync(path.join(e.OUT_DIR, "build-metadata.json"), JSON.stringify(meta, null, 2) + "\n");'
# Second opinion on the checksum from the system tool.
(cd "$out" && (sha256sum -c -- "$file.sha256" 2>/dev/null || shasum -a 256 -c -- "$file.sha256"))
cat "$out/build-metadata.json"

artifact="insight-workfolio_${v}_${platform}-${arch}_UNSIGNED-${kind}_run${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-local}"
echo "artifact name: $artifact"
if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "artifact=$artifact" >> "$GITHUB_OUTPUT"; fi
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then { echo '```json'; cat "$out/build-metadata.json"; echo '```'; } >> "$GITHUB_STEP_SUMMARY"; fi
