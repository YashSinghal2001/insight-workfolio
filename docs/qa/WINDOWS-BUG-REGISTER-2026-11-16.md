# Windows bug register (2026-11-16)

Confirmed = reproduced at runtime or verified in code/CI. No application behaviour was changed by this audit.

| ID | Severity | Status | Bug | Evidence | Recommended fix |
|---|---|---|---|---|---|
| W-01 | High | Confirmed (runtime, on-PC) | Served Windows (and macOS) installer predates live reporting: dashboard shows UNKNOWN for every employee using the download | Installer `9a496e36…` (recomputed today) = `02cbfd1`; runtime repro on the PC: 0 live reports in 8 min | Rebuild from current code, replace downloads and `desktop-releases.json` |
| W-02 | High | Confirmed (CI) | Windows CI red for `4d66269`: `privacy-apis.test.ts` path separators / CRLF; no installer built | CI run 43388023773 | Fixed in the 0.2.0 patch; **re-run on Windows needed** |
| W-03 | High (privacy) | Observed, cause unconfirmed | A production screenshot was captured and stored from the Windows PC today under an unidentified account | On-PC report §5 | Owner: check org and per-employee screenshot settings and the signed-in account |
| W-04 | High (privacy) | Fixed in 0.2.0, unverified on Windows | Capture possible between pressing Start break and the worker being paused; capture while idle; upload not re-checked against breaks (client and API) | `ACTIVITY-BREAK-SCREENSHOT-ROOT-CAUSE.md` | Apply patch, run break proof on the PC |
| W-05 | Medium | Confirmed (code) | Release builds have no log file; `reportLive()` swallows failures | `activity-ui.ts` empty catch | Rotating local log without personal data |
| W-06 | Medium | Confirmed (code) | Server cannot tell client version; old and new builds both said 0.1.0 | — | 0.2.0 bump done; send app version with device/activity sync |
| W-07 | Low | Known limitation (runtime) | Injected input (`SendInput`) counts as activity | On-PC runtime | Document; detection of injected input is out of scope |
| W-08 | Medium | Risk, unmeasured | Timers in a hidden WebView2 window may throttle keepalive/uploads | Remediation item 6 | Measure (row 16) before changing |
| W-09 | Low | Confirmed (code) | `verify-native.mjs` still expects UNOBSERVED on lock | Remediation item 2 | Update harness |

Not bugs, decisions pending (from the 0.2.0 work): admin corrections adding a break do not purge screenshots;
clock-out during a break is refused rather than closing the break.
