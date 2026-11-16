# Activity, break and screenshot: root cause and changes

Date: 2026-11-16. Branch `deploy/hostinger-vps`, baseline `4d66269b776bc4cb092eea9932d94c90124467da`.
All changes below are **local and uncommitted**. Nothing was committed, pushed, deployed or changed in production.

## Baseline (before any edit)

| Item | Finding |
|---|---|
| Branch / SHA | `deploy/hostinger-vps` at `4d66269` |
| Working tree | 21 modified, 13 untracked files: the invitation-email work (`apps/api/src/employees/invitations.ts`, migration 0030 in `packages/database/src/migrations.ts`, dashboard employee pages, `docs/invitations.md`) and status/QA docs. **All preserved; none of those files were edited.** |
| Server | Runs `4d66269` (per `docs/status/PROJECT-STATUS-AUDIT-2026-11-16.md`): accepts and derives live state |
| Served installers | `Insight-Workfolio_0.1.0_x64-setup.exe` and the macOS 0.1.0 build, committed in `02cbfd1` (11 Nov), **before** `4d66269` |
| Windows CI for `4d66269` | Run 43388023773 failed: 3 desktop TS failures in `test/privacy-apis.test.ts` (Windows `\` paths); installer build step skipped |

## Confirmed Windows root cause

Windows never showed Active/Idle because **no Windows build containing the live-state code exists**:

1. The live-state reporter (`apps/desktop/src/live-state.ts`, `activity-ui.ts`) was added in `4d66269`.
2. The Windows CI job for `4d66269` failed in `test/privacy-apis.test.ts` before the installer step:
   `relative()` returns `src-tauri\src\…` on Windows while the allow-list compares `src/…`, and CRLF checkouts
   left `\r` in lines. The NSIS build/upload steps are skipped after a test failure.
3. The installer served to employees is 0.1.0 from `02cbfd1`, which has no live-state reporting at all. With no report,
   the server correctly shows **UNKNOWN** (`deriveLiveStatus` never guesses).

The Windows reporting code itself is shared TypeScript (same as macOS) on top of the Windows native idle source
(`GetLastInputInfo`, `win/activity.rs`). No Windows-specific defect in that path was found by reading or by tests;
it has **never run on a physical Windows PC**, so this is not yet proven at runtime (see the test results report).

**Fix:** `privacy-apis.test.ts` now normalises CRLF and reports paths with `/` on every OS (same assertions, no
allow-list change). A CI re-run is needed to produce an installer; that requires a push, which was out of scope.

## State model (unchanged; traced and confirmed)

There is one canonical calculation: `deriveLiveStatus` in `packages/shared/src/attendance.ts`, used by the API for
every role's view (admin overview, team, employee self-view). The dashboard only maps its output to labels.

| State | Rule | Source of truth |
|---|---|---|
| NOT_CLOCKED_IN | No session, or the latest is clocked out | Attendance records |
| ON_BREAK | Open session with an open break. **Wins over any device report** | Attendance records |
| ACTIVE / IDLE | Open session, no open break, a device report received during the current working stretch (after clock-in or the last break end) and less than 3 min old | Desktop report (`POST /activity/sync` `current`) |
| UNKNOWN | Clocked in, no open break, and no report, a stale report, an `UNOBSERVED` report, or one from before the last break ended | — never guessed |

Desktop side (`live-state.ts`): nothing is reported unless monitoring is ACTIVE (so never during a break or clocked out),
the device is online and attendance is synced. A locked screen reports IDLE, sleep or another user's session UNOBSERVED.
Reports go out on change and every 60 s.

Timestamp semantics: attendance times are the device time when the button was pressed, skew-corrected by the server
(`receivedAt - sentAt`) and never later than receipt; events earlier than the last recorded change are rejected.
`liveSince` is the break start, clock-out, or the later of the stretch start and the device's reported state start.

Break rules (existing, documented, not changed): a break needs an open session; one break at a time; clock-out while
on a break is refused ("End your break before clocking out") – the desktop disables Clock out during a break.
Duplicate start/end requests are idempotent by the client event id; a second BREAK_START while on break is rejected
by the shared state machine.

## Screenshot gaps found and fixed

| # | Gap (before) | Layer | Fix |
|---|---|---|---|
| 1 | Between pressing **Start break / Clock out** and the native worker being reconfigured (queue write, reload, render), a scheduled capture could be **taken and kept locally** with a time inside the break. The server would reject it later, but the image existed on disk. | Desktop UI | `main.ts`: the native worker is set to `PAUSED_BREAK` **before** the break/clock-out time is taken (`screenshots.halt()`), and re-apply is held until the event is queued (`release()`). A capture already in flight is dropped by the existing generation check. |
| 2 | Screenshots were captured while the employee was **idle** (no input, screen not locked). | Native worker | `screenshot.rs`: due captures are skipped while `Collector::input_idle()` is true (tracker idle/locked when collecting; otherwise raw input idle ≥ threshold; unreadable idle time = idle). No setting enables idle capture. |
| 3 | The upload queue did not re-check attendance; it only waited while attendance events were unsynced. | Desktop upload | `screenshot-sync.ts`: no upload at all while on a break; every row is re-checked (`shotEligible`) against the session the device knows just before register/upload. An ineligible row is never sent and is marked locally `REJECTED` with a fixed, non-personal reason. |
| 4 | `PUT /screenshots/:id/content` did **not** re-check attendance. A screenshot registered before a break was recorded could be stored after the break was persisted. | API | `upload()` re-checks the capture time against clocked-in, non-break time under the per-employee lock shared with attendance writes. Outside → row marked `DELETED` (`deleted_reason` fixed text), **410**, no file written. |
| 5 | A break or clock-out synced with a time **earlier** than an already stored screenshot left that screenshot stored inside the break. | API | After an accepted `BREAK_START`/`CLOCK_OUT` (same lock), `ScreenshotsService.discardOutsideWork` removes the file from storage and marks the row `DELETED` for any screenshot no longer inside work time. A storage failure is logged as an error and leaves the row STORED (limitation). |

Ordering guarantee (API): attendance writes, screenshot register and upload for one employee run under one
in-process lock (`EmployeeLocks`). Whichever arrives first, a screenshot whose capture time lies in a recorded break
or after clock-out ends `DELETED` with no file in storage. Multi-instance deployment would need a DB/Redis lock
(existing `ponytail` note in `employee-locks.ts`); production runs one API process.

## Not changed (decisions for the owner)

- **Admin attendance corrections** that add a break over time already captured do not delete those screenshots.
  A correction fixes a record after the fact; whether that should purge screenshots is a policy decision.
- **"API confirms the break before the desktop treats it as active"** was not adopted as written: the desktop is
  offline-first, and waiting for the server would keep capture running until confirmation. Capture and uploads stop
  on the local press; the UI already shows unsynced events as pending. This is the more private behaviour.
- **Clock-out during a break** stays refused (existing rule), rather than auto-closing the break.
- Uploads of screenshots legitimately captured before a clock-out still proceed after clock-out (they are judged by
  capture time; holding them would leave them on the PC indefinitely). Uploads are held only during a break.
