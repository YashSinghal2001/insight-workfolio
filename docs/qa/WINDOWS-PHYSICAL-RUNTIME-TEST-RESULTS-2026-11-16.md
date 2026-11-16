# Windows physical runtime test results (2026-11-16)

**No physical Windows test was executed by this audit session**: it runs on the Mac and has no access to the
Windows PC. Rows marked PARTIAL cite the earlier on-PC session (`~/Desktop/WINDOWS-LIVE-ACTIVITY-TEST-RESULTS-2026-11-16 1.md`):
build `4d66269` (not 0.2.0), `SendInput` injected input, throwaway local API (sample 5 s, idle threshold 30 s),
times UTC.

| # | Test | Status | Evidence / reason |
|---|---|---|---|
| 1 | Hardware mouse movement | BLOCKED | Owner at the PC required |
| 2 | Mouse click | BLOCKED | |
| 3 | Scroll | BLOCKED | |
| 4 | Typing in Notepad | BLOCKED | |
| 5 | Foreground app detection / switching | BLOCKED | |
| 6 | ACTIVE with input | PARTIAL | 12:04:42 report ACTIVE, HTTP 200, persisted, overview ACTIVE ≈ 6 s after input |
| 7 | IDLE after threshold, idle start = last input | PARTIAL | 12:05:17 IDLE since 12:04:42.097 (last input) |
| 8 | IDLE → ACTIVE | PARTIAL | 12:05:21 ACTIVE |
| 9 | Repeated cycles (≥ 3) | NOT RUN | One cycle only |
| 10 | Held key | NOT RUN | |
| 11 | Lock / unlock (expect IDLE from the lock) | BLOCKED | |
| 12 | Sleep / wake (expect gap, UNKNOWN during sleep) | BLOCKED | |
| 13 | Display off / on | BLOCKED | |
| 14 | Fast user switching | BLOCKED | |
| 15 | RDP disconnect / reconnect | BLOCKED | |
| 16 | Window hidden to tray ≥ 10 min | BLOCKED | |
| 17 | API outage and recovery | PARTIAL | 79 s outage, 9 failed attempts with backoff, recovery at 12:06:57 delivered 3 intervals + `current` |
| 18 | Wi-Fi off / on | BLOCKED | |
| 19 | Clock in | PARTIAL | Via app UI, local API |
| 20 | Break start → input during break → stays ON_BREAK | BLOCKED | Never run on Windows |
| 21 | Break end → ACTIVE/IDLE recalculated from fresh input | BLOCKED | |
| 22 | Multiple break cycles, durations, timeline | BLOCKED | |
| 23 | Clock out (open-break rule) | BLOCKED | |
| 24 | App restart during open session | BLOCKED | |
| 25 | Offline attendance queue, duplicate prevention | BLOCKED | |
| 26 | Dashboard per role (Employee / IT Admin / Super Admin) | BLOCKED | |
| 27 | Production API acceptance of live state from Windows | BLOCKED | No QA account; no production traffic allowed without one |

Evidence fields not available for any row run by this session: Windows version, app exe hash of 0.2.0, test
identity, logs. The 0.2.0 build does not exist on Windows.

## To execute (Claude Code on the Windows PC, owner present)

1. In the PC worktree (`C:\Users\user\Desktop\workfolio-win`), `git fetch origin` and check out the
   `deploy/hostinger-vps` commit titled "feat(desktop): prepare 0.2.0 Windows QA build" (it contains the same
   changes as the earlier `workfolio-0.2.0-break-privacy.patch`; do not apply the patch as well).
2. `pnpm install`, `pnpm build:packages`, then in `apps/desktop`: `node --test`, `cargo test`, `cargo clippy -- -D warnings`
   (this re-runs the `privacy-apis` Windows fix).
3. Confirm the installed production-URL app is **clocked out** before any harness run (injected input is system-wide).
4. Build the QA debug app (identity `com.insightworkfolio.desktop.qa`) and run the earlier throwaway-API harness with
   the owner at the PC, then rows 1–26 above, recording native idle, desktop state, request/response, DB and overview.
5. Screenshots: only in that throwaway API (LOCAL_DEV storage), with a synthetic full-screen test pattern. See the
   screenshot verification report.
