# Desktop auto-update: security

## Threats and controls

| Threat | Control | Where |
| --- | --- | --- |
| Modified or replaced package | The app installs only a package whose minisign signature verifies against the **public key compiled into the build**. The API checks the same signature before a release can be tested or published. | Updater plugin `verify_signature`; `apps/api/src/desktop-updates/minisign.ts` |
| Modified manifest pairing a new version number with an old signed package (downgrade) | `requireSignedVersion: true`. The Tauri CLI writes `version:x.y.z` into the signature's *trusted comment*, which the signature itself covers. The app refuses a package whose signed version differs from the announced one. The API also refuses to publish a package signed for a different version. | `scripts/desktop-config.mjs` (`updaterPlan`); `DesktopUpdatesService.verifyArtifacts` |
| Downgrade by announcing a lower version | The updater installs only versions **greater** than the running one; `allowDowngrades` is never set. The API never publishes a version at or below another published one, and the manifest only offers versions above the caller's. | Plugin default comparator; `checkNewest`; `manifest()` |
| Plain-text transport | Release builds take only an `https://` API URL (`resolveApiUrl`). The plugin refuses non-https endpoints in release builds. Package URLs must be `https://` (the API refuses others, and refuses non-https redirects while verifying). The `dangerous*` updater options are never written by the release script. | `api-url.ts`, `desktop-config.mjs`, `DesktopUpdatesService.checkUrl` |
| A QA build installing production packages, or the reverse | Separate key pairs per environment: the key id is printed by the build and checked by the API (a "Signed with key X, but this server expects key Y" refusal). Each build has a separate API URL and bundle identifier. | Release guide; `minisign.ts` |
| Interrupted or corrupted download | The package is held in memory and verified before anything is written. An interrupted download fails verification or the HTTP read, leaves the installed app untouched, and shows **Try again**. | Updater plugin `download()`; `updates-ui.ts` |
| Failed installation | macOS: the plugin moves the old bundle aside and puts it back if extraction fails. Windows: the NSIS installer either completes or leaves the old version. Before installing, the app stops recording; if the install throws, it resumes recording and shows the reason. | Plugin `install_inner`; `updates-ui.ts` |
| An unsigned production update | A build with `WORKFOLIO_UPDATER_PUBKEY` refuses to start without `TAURI_SIGNING_PRIVATE_KEY`. A release without verified packages can't be tested or published, and without `DESKTOP_UPDATER_PUBKEY` nothing can be verified. | `updaterPlan`; `setStatus` |
| Employees altering releases | Only administrators hold `updates:manage`. Publishing, and changing a published release, needs `updates:publish`, which is Super Admin only (`SUPER_ADMIN_ONLY`). Employees hold only `updates:report`, and only for their own registered device. | `packages/shared/src/roles.ts` |
| Leaking data through status reports | Reports carry only versions, the update state and a short reason that is reworded and stripped of paths and URLs (`updateErrorReason`). | `update-policy.ts`, schema `reportUpdateStatusSchema` |

## Key management

The updater key is a minisign Ed25519 key pair made with `pnpm --filter @workfolio/desktop tauri signer generate`. It is separate from Apple and Windows code signing.

**Never** put the **private key** or its password in the repository, the app, the dashboard, the API server, an `.env` file in the repo, a ticket or a chat. In particular:
- It is stored only as GitHub **Environment** secrets (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) in the `staging` and `production` environments, plus an offline backup (a password manager vault held by the owner and one other named person).
- Restrict the `production` GitHub Environment to required reviewers, so a release build needs approval.
- Use one key pair for staging/QA and a **different** key pair for production. Development builds have no updater.

The **public key** is not secret. It goes into:
- the build: the GitHub Environment *variable* `WORKFOLIO_UPDATER_PUBKEY`, which the release script writes into `plugins.updater.pubkey`;
- the API: `DESKTOP_UPDATER_PUBKEY` in `/etc/workfolio/api.env`, with the same value for that environment.

### Generating a key pair (owner, once per environment)

```bash
# On a trusted machine, outside the repository:
pnpm --filter @workfolio/desktop tauri signer generate -w ~/secure/workfolio-production-updater.key
# Prompts for a password. Store the .key file and the password in the vault; delete the local file afterwards.
cat ~/secure/workfolio-production-updater.key            # value for the TAURI_SIGNING_PRIVATE_KEY secret (already base64)
cat ~/secure/workfolio-production-updater.key.pub        # value for WORKFOLIO_UPDATER_PUBKEY and DESKTOP_UPDATER_PUBKEY
```

### Losing or leaking the private key

- **Leaked:** disable every release in the dashboard straight away. Generate a new pair, build a version with the new public key, and distribute that version **manually**: installed apps trust only the old key, so they can't receive it automatically. Then remove the old secrets.
- **Lost:** same as leaked, except no release needs disabling. Without the private key nothing can be signed for installed apps, so the next version must be installed manually.

That's why the backup matters: losing the key costs a manual reinstall on every machine.

## Code signing (separate from the updater key)

- **macOS:** Developer ID signing plus notarization, using the existing `APPLE_*` variables (docs/deployment.md, "macOS bundle, signing and notarization"). Keep the same Team ID across versions. Keychain access for the installation ID and refresh token is bound to the code signature, so changing it causes a Keychain prompt after the update. The items are kept, and the installation ID is never regenerated.
- **Windows:** Authenticode through a certificate thumbprint or Azure Trusted Signing (`windowsSigningPlan`). An unsigned update installer still installs, because the updater's minisign check is what protects it, but SmartScreen and antivirus may interfere. Sign production releases.

## Recovery when an update fails

1. **In the app:** the error says why. **Try again** downloads again. Nothing is installed unless verification passes. The running version keeps working and stays registered.
2. **Release problem** (a crash after updating): an administrator **disables** the release. Admin (IT) can do this, and it takes effect on the next check. Publish a fixed higher version. Installed apps never move to a lower version automatically. Rolling back means publishing a *higher* version built from the previous code.
3. **A machine that can't update** (disk full, permissions): fix the cause and click **Try again**, or install the signed installer or DMG manually over the old version. Manual install keeps app data, the installation ID and the sign-in, because the identifier is the same.
4. **Never** install an unsigned or unverified build to "fix" a machine. Never delete the app's Keychain or Credential Manager entries: that creates a new installation ID, which means a new device needing approval.
