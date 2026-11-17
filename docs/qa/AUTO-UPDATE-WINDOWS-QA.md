# Auto-update: Windows QA

**Status: NOT EXECUTED.** No physical Windows machine was used in this change. On a Mac the Windows code is
only compiled (`cargo test` and clippy run on `windows-latest` in CI). Nothing below is marked PASS until it
has been run on real Windows 10 and Windows 11 machines.

## Preconditions

- A QA (staging) API reachable over **https**, with migration 0032 applied and `DESKTOP_UPDATER_PUBKEY` set to the **staging** updater public key. A debug build can't reach a QA API on another machine, because it accepts plain http only on its own loopback address.
- Two staging builds from the **Desktop release candidate** workflow (`environment: staging`): version **N**, installed manually first, and version **N+1**, referenced in the dashboard and set to Testing or Published. Use a synthetic QA employee and the QA admin, never real employee accounts.
- An Authenticode-signed installer if available. If unsigned, note the SmartScreen behaviour.

## Record before updating (PowerShell)

```powershell
# Installation ID and refresh-token entries (do NOT print the token):
cmdkey /list | Select-String "com.insightworkfolio.desktop.staging"
# App data (queue DB, prefs), which must survive:
Get-ChildItem "$env:LOCALAPPDATA\com.insightworkfolio.desktop.staging" | Select Name, LastWriteTime
Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" | ? DisplayName -like "Insight Workfolio*" | Select DisplayName, DisplayVersion, InstallLocation
```

In the dashboard (Devices), record the device ID, registration date and status for the QA employee's PC.

## Cases

| # | Case | Steps | Expected |
| --- | --- | --- | --- |
| W1 | Startup check | Launch N, signed in. | Within about 5 s the update card shows N+1 with notes and size. The dashboard device row says *Update available*. |
| W2 | Manual check | Settings → Check for updates. | The same card, or "You have the latest version". |
| W3 | Optional: Later | Click Later. | Card hidden. State *Postponed*. Not shown again by background checks for 24 h; a manual check shows it. |
| W4 | Update now | Click Update now. | Progress bar to 100%, then "Downloaded and verified". |
| W5 | Restart while clocked in | Clock in, click Restart to update. | Warning that you're clocked in and should save work. The second click starts the passive NSIS installer; the app closes and reopens on N+1. |
| W6 | Identity preserved | Repeat the "Record before" commands. | Same Credential Manager entries, same app data files, the same **device ID** in the dashboard, **no new device**, still signed in, still clocked in. Device row: installed N+1, *Up to date*, last update "from N". |
| W7 | Mandatory | Set N+1 Mandatory, or set the minimum version to N+1. Launch N. | Title "Update required". No Later. **Clock in disabled**; Clock out still works. |
| W8 | Invalid signature | Publish, then replace the file at the package URL with different bytes (same name). | Download ends with "failed its security check". Nothing is installed; N keeps running. Device row *Failed*. |
| W9 | Interrupted download | Disconnect the network at about 50%. | An error with Try again. N is untouched. Reconnect, Try again, and it succeeds. |
| W10 | Network failure | Offline, then click Check for updates. | A connection message. No crash. The background check stays silent. |
| W11 | Insufficient disk | Fill the disk to under about 2× the package size. | The "not enough free disk space" wording (or the installer's own error). N still works. |
| W12 | Installer failure | Make the install folder read-only, or kill the installer. | An error is shown, or N still launches. Recover by running the signed installer manually. |
| W13 | Older supported version | Update from N-1 (also updater-enabled) straight to N+1. | It goes directly to the highest eligible version. |
| W14 | Windows 10 and 11 | Run W1–W6 on both. | Same results. |
| W15 | SmartScreen / AV | Signed vs unsigned installer. | Record any prompt. A passive update must not need admin rights (installMode currentUser). |

## Results

| # | Windows 10 | Windows 11 | Notes |
| --- | --- | --- | --- |
| W1–W15 | NOT RUN | NOT RUN | Needs physical machines and an https staging API |
