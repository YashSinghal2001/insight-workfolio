# Desktop auto-update: release guide

A GitHub push never ships an update. A release reaches employees only after these steps, the last of which is
a **Super Admin publishing it in the dashboard**.

## One-time setup (per environment: `staging` for QA, then `production`)

1. Generate the updater key pair (docs/desktop/AUTO-UPDATE-SECURITY.md, "Key management").
2. In GitHub, go to Settings → Environments and create the environment (`staging` / `production`; add required reviewers to `production`).
   - **Secrets:** `TAURI_SIGNING_PRIVATE_KEY` (content of the `.key` file) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Optional: the Apple signing and notarization secrets (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_P8`) and the Windows Azure Trusted Signing secrets (`AZURE_*`).
   - **Variables:** `WORKFOLIO_UPDATER_PUBKEY` (content of the `.pub` file), `WORKFOLIO_API_URL` (`https://api.<domain>`), `WORKFOLIO_DASHBOARD_URL`.
3. On that environment's API server, set `DESKTOP_UPDATER_PUBKEY=<same .pub content>` in `/etc/workfolio/api.env`, then deploy the API with migration `0032_desktop_updates`. On the VPS that is `deploy.sh --migrate`, which takes a backup first. **This needs approval.**
4. **Bootstrap:** build the first version that contains the updater, then install it **manually** on every machine (signed DMG / NSIS installer over the old version). Installed 0.2.0 apps cannot update themselves. A manual install over the old version keeps the installation ID, the device registration and the sign-in.

## Each release

| Step | Who | How |
| --- | --- | --- |
| 1. Release candidate | Developer | Bump the version in **all three** files: `apps/desktop/package.json`, `apps/desktop/src-tauri/Cargo.toml` and `apps/desktop/src-tauri/tauri.conf.json` (plain `MAJOR.MINOR.PATCH`, higher than every published version). Run `cargo update -p insight-workfolio-desktop` so `Cargo.lock` matches, then merge. |
| 2. Build + tests + signing | Developer | GitHub → Actions → **Desktop release candidate** → Run workflow (`environment`, `version`, optionally `macos_universal`). It checks the version in all three files, runs the desktop tests, builds the macOS and Windows packages, signs them with the updater key (and code-signs or notarizes them when configured), then attaches them to a GitHub **pre-release** `desktop-<env>-v<version>`. The job summary lists each package URL with its `.sig` content. |
| 3. Upload / reference | Admin (IT) | Dashboard → Administration → **Desktop app updates** → **New release**. Enter the version and release notes, then the URL and signature for each platform: Windows `…windows-x86_64-setup.exe`, macOS `…darwin-aarch64.app.tar.gz`. For a universal build, use the same URL and signature for both macOS targets. This creates a **Draft**. Choose the policy now (it can still be changed later): Optional, Recommended (with a postpone period) or Mandatory, plus the rollout % and the minimum supported version. |
| 4. Verify + test | Admin (IT) | **Test**. The API downloads every package, checks its signature against `DESKTOP_UPDATER_PUBKEY` and the version it is signed for, and records the size and SHA-256. Any mismatch is refused with the reason. The release now goes **only to devices registered by administrators**. Update your own machine from the app (Settings → **Check for updates**) and run the checks in `docs/qa/AUTO-UPDATE-*-QA.md`. |
| 5. Review | Super Admin | Read the notes, version, policy and rollout. The release **History** shows who did what. |
| 6. Publish | Super Admin | **Publish**. The packages are verified again and the release is offered to the chosen rollout share. Start at 10–25% and raise the percentage after a day without failures. The same devices stay included as it grows. |
| 7–9. Employees | — | Apps check at start and every 4 hours. The employee sees the version, notes and size, then chooses **Update now**, and later **Restart to update**. |
| 10. Monitor | Admin (IT) | **Employee devices** table: installed version, state, last check, last update, failure reason. The card at the top counts devices on the current version. |

## Policies

- **Optional:** the employee can choose **Later**, which hides the prompt for 24 hours. **Check for updates** always shows it.
- **Recommended:** labelled as recommended. **Later** hides it for the configured postpone period (1–720 h).
- **Mandatory, or a minimum supported version:** below the minimum, **Later** is not offered and **Clock in** is disabled until the app is updated. Clock-out, breaks and sync keep working, so nobody is cut off mid-shift. The app never restarts on its own: the employee confirms the restart after a "save your work" warning.

## Stopping or rolling back

- **Stop a bad release:** **Disable** it. Admin (IT) may do this without a Super Admin, and a reason is required. Apps stop being offered it at their next check. Apps that already installed it keep it.
- **Roll back:** publish a **higher** version built from the previous good code. Installed apps never move to a lower version, by design.
- **Halt a rollout:** set the rollout to 0% (Super Admin). That stops new devices from receiving it. Installations below a minimum supported version still receive it, so also clear the minimum if that's the intent.

## Commands (local, for reference)

```bash
# Build a signed updater-enabled release locally (secrets from your vault, never committed):
WORKFOLIO_ENV=staging WORKFOLIO_API_URL=https://api.staging.example.com WORKFOLIO_DASHBOARD_URL=https://app.staging.example.com \
WORKFOLIO_UPDATER_PUBKEY="$(cat staging-updater.key.pub)" TAURI_SIGNING_PRIVATE_KEY=/secure/staging-updater.key \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=… pnpm --filter @workfolio/desktop package -- --bundles app,dmg
# Output: src-tauri/target/release/bundle/macos/*.app.tar.gz and *.app.tar.gz.sig (Windows: bundle/nsis/*-setup.exe and .sig)
```

`--print` shows the generated configuration, including the manifest URL and the updater key id, without building.
