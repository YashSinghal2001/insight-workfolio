# Auto-update: macOS QA (2026-11-17)

**Result: PARTIAL.** A real in-app update from 0.3.0 to 0.3.1 worked end to end on a physical Mac, and the failure cases behaved safely. Device identity, the sign-in, the open attendance session and the app data all survived. Not covered here: a Developer ID signed and notarized build, Gatekeeper, an Intel Mac, a reboot, and the disk-full case. One open item (the slow first start after an update) needs a signed build to resolve.

## Environment

- MacBook Air M2 (Mac14,2), macOS 27.2 (26B123). Branch `deploy/hostinger-vps`, HEAD `d38cd05`, plus this change (uncommitted).
- **Isolated:** QA API on `127.0.0.1:4000` (`NODE_ENV=development`, its own SQLite file in the session scratchpad, migrations 0001–0032 applied there only). Packages were served from `127.0.0.1:8765`. The synthetic accounts `qa-admin@qa.invalid` (made Super Admin in the QA database) and `qa-employee@qa.invalid` (QA-001) were used. No production API, database, account, Keychain item or update channel was touched.
- **QA builds:** `tauri build --debug --bundles app` with identifier `com.insightworkfolio.desktop.qa`, Keychain service `com.insightworkfolio.desktop.qa`, a **QA-only updater key pair** (key id `96D454812655F997`, generated in the scratchpad, never committed), the `version` overridden to 0.3.0 and 0.3.1, and `dangerousInsecureTransportProtocol` (QA only, for the http loopback API). Both builds are **ad-hoc signed** (no Developer ID).
- The UI was driven through the debug-only e2e harness (`WF_E2E_SCRIPT`): real page, real buttons, real plugin and Keychain, with no human clicks.
- **Production Keychain items** (`com.insightworkfolio.desktop`): `installation-id` mdat `20261012175242Z` and `refresh-token` mdat `20261116144456Z`, the same before and after. They were never read.

## Results

| # | Case | Result | Evidence |
| --- | --- | --- | --- |
| M1 | Updater on in an updater build | PASS | `app_info.updatesEnabled = true`. The committed config has no updater (unit test). |
| M2 | Startup and manual check, nothing published | PASS | "You have the latest version". Manifest returned 204. |
| M3 | Status reported after sign-in | PASS (after a fix) | The first run showed the check ran **before** sign-in, so nothing was reported until the next 4-hour check. Fixed with `reportNow()` after entering the signed-in state; then the device row showed 0.3.0 / Up to date. |
| M4 | API verifies the real Tauri package | PASS | Draft → **Testing** downloaded the 13,623,686-byte `.app.tar.gz`, checked its signature and bound version 0.3.1, and recorded the SHA-256. |
| M5 | Testing is not offered to employees | PASS | The manifest for the employee's installation was **204** while Testing. |
| M6 | Publish (Super Admin), then the prompt | PASS | The card said "Recommended update available · Installed: 0.3.0 · Available: 0.3.1 · 13.0 MB", with the notes and the Update now and Later buttons. The dashboard row said *Update available*. |
| M7 | Tampered package (bytes replaced after publishing) | PASS | "The downloaded update failed its security check and was not installed." Try again was offered and the bundle stayed 0.3.0. The dashboard showed *Failed* with that reason. |
| M8 | Tampered manifest, downgrade attempt (announces 0.3.1, serves the genuine 0.3.0 package and signature) | PASS | The plugin refused: "signed for version 0.3.0 but the update endpoint announced version 0.3.1". Nothing was installed. The wording is now mapped to the security-check message (the QA build showed the raw, path-free text). |
| M9 | Interrupted download (half the bytes, then the connection closed) | PASS | An error with Try again; nothing was installed. The wording is now mapped to the connection message (the QA build said "error decoding response body"). |
| M10 | Package host unreachable | PASS | "The update could not be downloaded. Check your connection and try again." |
| M11 | Mandatory (minimum 0.3.1) | PASS | Title "Update required" with the note. No Later. **Clock in disabled** (it was enabled before). |
| M12 | **Real update while clocked in** | PASS | Clocked in, then Update now: downloaded and verified. The warning read "You are clocked in. Restarting does not clock you out…". Restart now installed it and the app relaunched itself through LaunchServices. The bundle on disk became 0.3.1, and its code signature (CDHash) is identical to the fresh 0.3.1 build. |
| M13 | **Identity after the update** | PASS | Installation ID `f8078f02-…` unchanged; the Keychain `installation-id` item was not modified (same mdat). The same device row `698884c7`, with **no new device**. The same server session `361a555b` (refresh token rotated normally). Still signed in, still **clocked in** (attendance session open). App data (queue DB) kept. Dashboard: installed 0.3.1, *Up to date*, last update "from 0.3.0". |
| M14 | Dashboard page | PASS | `/desktop-updates` as the Super Admin showed the current approved version 0.3.1, the 0.3.1 minimum, devices on the current version 1/1, the release row ("macOS Apple Silicon ✓ verified"), and the device row with "(from 0.3.0)". Screenshot: `/var/folders/sx/psx0lhgj25v6pdtw58_5zw180000gn/T/claude-chrome-screenshots-kMd8Os/screenshot-1794893892045-2.jpg`. |
| M15 | Optional "Later" and postponement | Unit tests only | `test/updates.test.ts`. Not driven on the device. |
| M16 | Insufficient disk space | NOT RUN | Filling the disk on this machine was not safe. Only the wording is unit tested. |
| M17 | Background check failing quietly when offline | Code path only | Not executed on the device. |
| M18 | Signed and notarized build, Gatekeeper, reboot, Intel | NOT RUN | No Developer ID in this session; Apple Silicon only. |

## Findings

1. **Slow first start after the update (open, needs a signed build).** The relaunched 0.3.1 stayed on "Checking sign-in…" for over 2 minutes, polling health but not refreshing its session. Later launches of the same updated bundle signed in after 19–42 s, against 3–13 s for 0.3.0. The stall is before the first Keychain read. The most likely cause is macOS re-checking Keychain access for a new **ad-hoc** signature: the items were created by an earlier build. No dialog was visible and nothing about it appeared in the system log, so this isn't proven. Data was never lost: the same installation ID and session were used. **Verify with two Developer ID signed builds.** With a stable designated requirement the access should stay silent. If it doesn't, this blocks release.
2. **Fixed: the app could vanish after an update.** The macOS restart (`open -n`) starts the new copy while the old one still holds the single-instance lock. The new copy waited for nothing and quit. The lock now waits up to 5 s (`single_instance` in `lib.rs`). In M12 the relaunch came up.
3. **Fixed: install could be entered twice** (the log showed "stopping recording before install" twice when the button was clicked again). `install()` now runs only from the downloaded state.
4. **Fixed: wording** for a signed-version mismatch and a cut-off download (M8, M9). **Fixed: no status before sign-in** (M3).
5. For a **mandatory** update, the restart confirmation is shown straight after the download: one click, after the warning. That's by design.

The QA builds predate fixes 3 and 4 (wording and the re-entry guard). Those are covered by unit tests and the TypeScript build, not by a rebuilt app.

## To reach PASS

- Repeat M6–M13 with two **Developer ID signed and notarized** staging builds (`Desktop release candidate`, `environment: staging`), over **https**, including a reboot between the update and the next start. Confirm that the first start after the update is fast, with no Keychain prompt, and that Gatekeeper accepts the updated app.
- Universal build: if Intel Macs are still in use, check on an Intel Mac.
- Windows: `docs/qa/AUTO-UPDATE-WINDOWS-QA.md`.

## Cleanup

The QA API, the package server and the dashboard were stopped, and no QA app is running. The QA scratch files (database, keys, builds) are in the session scratchpad. The QA Keychain items (`com.insightworkfolio.desktop.qa`: `installation-id`, `refresh-token`) remain. Remove them with `security delete-generic-password -s com.insightworkfolio.desktop.qa -a <account>`. The QA app data folder `~/Library/Application Support/com.insightworkfolio.desktop.qa` also remains.
