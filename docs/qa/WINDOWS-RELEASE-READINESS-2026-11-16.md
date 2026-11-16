# Windows release readiness (2026-11-16)

**Overall verdict: NOT READY.**

| Check | Status | Evidence |
|---|---|---|
| Windows x64 installer builds (0.2.0) | NOT RUN | 0.2.0 exists only on the Mac; Windows builds need the PC or CI (push not allowed) |
| Installer builds (`4d66269`) | PARTIAL | NSIS `ddcd05a3…637f04`, production URL, unpublished (on-PC report) |
| Installed app starts (0.2.0) | NOT RUN | |
| Production URL, no localhost/placeholder | PARTIAL | `4d66269` exe CSP allows only `https://189.72.144.117`; 0.2.0 not built |
| Version 0.2.0 | PARTIAL | Set in source (package.json, tauri.conf.json, Cargo.toml); no binary |
| Architecture x64, SHA-256 recorded | NOT RUN | |
| Signature | Unsigned | No Windows signing configured; SmartScreen will show "Windows protected your PC" → More info → Run anyway; company AV may block |
| Upgrade over 0.1.0 | NOT RUN | Same identity, higher version: NSIS should upgrade in place; verify app data and credentials survive |
| Published | No | |

## Answers

1. **Windows fully functional?** No — not demonstrated.
2. **Active detection?** Works at runtime on Windows for `4d66269` with injected input and a local API (PARTIAL). Hardware input not tested.
3. **Idle detection?** Same: PARTIAL (idle at 33 s for a 30 s threshold, idle start = last input).
4. **Break detection?** Not tested on Windows (BLOCKED).
5. **Screenshots impossible during break, by runtime evidence?** **No runtime evidence.** Code and Mac-run tests only.
6. **OneDrive end to end from Windows?** Not tested (BLOCKED).
7. **Offline sync?** Activity intervals recovered after a 79 s outage (PARTIAL); attendance offline queue not tested.
8. **Installer and dashboard integration ready?** No: no 0.2.0 installer; dashboard per-role views untested with Windows.
9. **What failed?** Windows CI for `4d66269` (W-02); the served installer lacks live reporting (W-01); a production screenshot was taken from the PC under an unidentified account (W-03).
10. **Blocked:** all hardware-input, lock/sleep/RDP/tray, break, screenshot, OneDrive-from-Windows, Credential Manager, uninstall and role-view tests; Windows machine details (edition, CPU, WebView2).
11. **Before production release:**
    1. Resolve W-03 (screenshot settings, signed-in account).
    2. On the PC: apply the patch, run `node --test`, `cargo test`, `clippy`; build the 0.2.0 NSIS installer with the production URL; record SHA-256.
    3. Run the physical matrix (runtime results report) with the owner present, including the 9-step break proof, on a throwaway API.
    4. Deploy the API part of 0.2.0 before shipping clients; then replace downloads and `desktop-releases.json`; dashboard smoke test.
    5. Decide signing (or accept SmartScreen warnings for a supervised pilot).
