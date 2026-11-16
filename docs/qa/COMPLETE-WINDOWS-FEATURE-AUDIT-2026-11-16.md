# Complete Windows feature audit (2026-11-16)

**Executive verdict: NOT READY.** Windows is not shown to be fully working. The 0.2.0 code (break and screenshot
privacy) has **never run on Windows**. The only physical Windows evidence is for build `4d66269`, with injected
(not hardware) input, against a throwaway local API.

## How this audit was run (and its limit)

| Item | Value |
|---|---|
| Auditing session | Claude Code on the **Mac** (macOS, Apple Silicon), repo `deploy/hostinger-vps` at `4d66269` + uncommitted work |
| Windows PC access | **None from this session.** No SSH host, remote session or agent for the PC. Physical Windows evidence below comes only from the earlier on-PC session's reports (`~/Desktop/WINDOWS-LIVE-ACTIVITY-{ROOT-CAUSE,TEST-RESULTS}-2026-11-16 1.md`) and is cited as such |
| `WINDOWS-VS-MACOS-LIVE-ACTIVITY-COMPARISON-2026-11-16.md` | Not found anywhere on this Mac |
| Repo changes by this audit | None to code. Five reports added under `docs/qa/` |
| Uncommitted work | Preserved. Invitation email (`apps/api/src/employees/invitations.ts`, `employees.*`, migration 0030 in `packages/database/src/migrations.ts`, dashboard employee pages) **untouched** |
| Handoff | The 0.2.0 break/privacy changes (15 code files, no invitation-email or migration code) were committed to `deploy/hostinger-vps` as "feat(desktop): prepare 0.2.0 Windows QA build" for Windows QA. The earlier patch file `workfolio-0.2.0-break-privacy.patch` (SHA-256 `180e5ed7…a3bf`) holds the same changes and is superseded |

## Builds involved

| Build | Where | Exe / installer SHA-256 | Live state | 0.2.0 break/idle privacy |
|---|---|---|---|---|
| Production download 0.1.0 (`02cbfd1`) | `apps/dashboard/public/downloads/Insight-Workfolio_0.1.0_x64-setup.exe` | installer `9a496e36…0fce4d` (recomputed today on the Mac); exe `550f9abb…c18451` (on-PC report) | No | No |
| Installed on the Windows PC (`4d66269`, labelled 0.1.0) | `%LOCALAPPDATA%\Insight Workfolio`, production URL `https://189.72.144.117` (CSP) | exe `1fd4e1d7…b491ad`; NSIS `ddcd05a3…637f04` (on-PC report) | Yes | **No** |
| 0.2.0 (local, uncommitted) | This Mac only | Not built | Yes | Yes |

Windows edition, version, CPU architecture and WebView2 runtime of the PC: **NOT RECORDED** in the on-PC reports
and not observable from here (BLOCKED).

## Feature matrix

Statuses: PASS = physically observed on Windows. Evidence column says which build and how.

### A. Installation and lifecycle
| Feature | Status | Evidence |
|---|---|---|
| Installer works | PARTIAL | `4d66269` NSIS installed per-user and running (on-PC report). 0.2.0: not built |
| App launches | PARTIAL | `4d66269` running (PID 3052). 0.2.0: NOT RUN |
| Single instance, tray, close-to-tray, quit | BLOCKED | Not tested on the PC |
| Restart recovery | BLOCKED | |
| Start at sign-in | BLOCKED | |
| Uninstall; app data and credentials after uninstall | BLOCKED | |

### B. Authentication and device
| Feature | Status | Evidence |
|---|---|---|
| Login, device registration (throwaway local API, QA identity) | PARTIAL | On-PC harness signed in and registered through the app UI; production URL not exercised |
| Production login with a QA account | BLOCKED | No dedicated QA account confirmed; the account already signed in on the PC is unknown |
| Device ID stability, session persistence, token refresh, logout/re-login | BLOCKED | |
| Refresh token in Credential Manager | NOT RUN at runtime | Source: `keyring` credential store (inspection only) |
| Cross-employee isolation | NOT RUN on Windows | API e2e suites pass (platform-independent, Mac) |

### C. Activity detection (build `4d66269`, local API)
| Feature | Status | Evidence |
|---|---|---|
| Native idle (`GetLastInputInfo`) | PARTIAL | Runtime on the PC with `SendInput` injected input: idle 175 s → 1 s → 33 s → 0 s |
| ACTIVE / IDLE reported to API, persisted, shown on overview | PARTIAL | ACTIVE → IDLE → ACTIVE, dashboard within ≤ 7 s, idle `since` = last input (± 25 ms) |
| Network interruption and recovery | PARTIAL | 79 s API outage: backoff 2→30 s, queued intervals + live state delivered on recovery |
| Hardware mouse move, click, scroll, Notepad typing | BLOCKED | Owner not at the PC |
| Foreground app detection / switching | BLOCKED | |
| Repeated cycles, held key | BLOCKED / NOT RUN | One cycle only |
| Lock/unlock, sleep/wake, display off/on | BLOCKED | |
| Fast user switching, RDP disconnect | BLOCKED | Static review: disconnected RDP → UNOBSERVED |
| Tray-hidden reporting | BLOCKED | Remediation item 6 (timers in a hidden WebView2) unmeasured |

### D. Attendance and breaks
| Feature | Status | Evidence |
|---|---|---|
| Clock-in / session creation | PARTIAL | Harness clocked in via app UI (local API) |
| Break start/end, duration, multiple cycles, input during break, ON_BREAK held, recalculation after break | BLOCKED | Never run on Windows. Logic is shared TypeScript + API, covered by Mac-run tests (not runtime) |
| Clock-out, restart during session, offline queue, duplicates, timeline | BLOCKED | |

### E. Screenshots and privacy — see `WINDOWS-SCREENSHOT-PRIVACY-VERIFICATION-2026-11-16.md`
All runtime rows BLOCKED. **One production screenshot was captured and stored from this PC today (17:09 IST)**
before the investigation, under an unknown account (on-PC report §5).

### F. OneDrive and offline sync
| Feature | Status | Evidence |
|---|---|---|
| Generic synthetic file upload/download + SHA-256 | NOT RUN on Windows | API-side OneDrive verified earlier from the server (`docs/status/ONEDRIVE-INTEGRATION-REPORT.md`); not a Windows test |
| Screenshot upload to OneDrive from Windows | BLOCKED | Needs an isolated QA screenshot environment |
| Offline queue persistence, reconnection, retry, acknowledgement | PARTIAL | Activity intervals only (outage test above) |
| Duplicate prevention, local cleanup after confirmed upload | NOT RUN on Windows | Unit-tested in Rust (Mac) |

### G. Security and privacy
| Feature | Status | Evidence |
|---|---|---|
| No keyboard hooks, clipboard, window titles | NOT RUN at runtime | Static guard `privacy-apis.test.ts` passes on macOS; on Windows it **failed in CI** for `4d66269` (path separators); fixed in 0.2.0, not yet re-run on Windows |
| Credential Manager, no plaintext tokens, ACLs | BLOCKED | |
| Log files and rotation | NOT IMPLEMENTED | Release builds write no log file (on-PC report §4); failed live reports are swallowed |
| Injected input counts as activity | Known limitation | Confirmed at runtime on the PC (`SendInput` resets `GetLastInputInfo`) |
| RBAC / API / screenshot authorization | NOT RUN on Windows | API suites pass on the Mac (platform-independent) |

### H. Dashboard integration
| Feature | Status | Evidence |
|---|---|---|
| ACTIVE / IDLE from a Windows device on the overview endpoint | PARTIAL | Local API, `GET /attendance/overview` |
| ON_BREAK, NOT_CLOCKED_IN, UNKNOWN from Windows; per-role views; timeline | BLOCKED | |

### I. Release and installer
See `WINDOWS-RELEASE-READINESS-2026-11-16.md`: no 0.2.0 Windows installer exists.
