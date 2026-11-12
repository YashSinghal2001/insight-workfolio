# Attendance: clock-in, clock-out, breaks, timeline

Statuses used: PASS, FAIL, PARTIAL, BLOCKED, NOT IMPLEMENTED, NOT RUN. A build or compile result is never counted as a runtime PASS. Date of the runs: 2026-11-12, host macOS (Apple Silicon). No Windows machine was available. Nothing was committed, pushed, merged or deployed.

## Features

| Feature | Implementation | Files changed | Tests executed | Actual result | Remaining limitations | Physical runtime test passed? | Production activation |
|---|---|---|---|---|---|---|---|
| Clock-in / clock-out / breaks from the desktop app (state machine, offline sync) | PARTIAL (core unchanged) | `apps/api/src/attendance/attendance.service.ts` (clock-out now clears the live report) | `attendance.e2e`, `device-sessions.e2e`, `role-separation-live-status` | PASS | Not exercised from a real desktop app in this engagement | No: NOT RUN (macOS), BLOCKED (Windows) | Pending |
| Device-bound writes only from a desktop sign-in | PASS | `apps/api/src/devices/devices.service.ts`, `auth/auth.service.ts` | `security-hardening.e2e`, `qa-round2-security` | PASS: a browser session gets 403 | The client type is declared at login; sessions with no recorded client must sign in again | Not applicable (server / browser check) | Pending |
| Web clock-in | NOT IMPLEMENTED | none | none | not applicable | By decision (desktop only); awaiting the owner | Not applicable (server / browser check) | Not planned |
| Live status: not clocked in / on break / active / idle / unknown | PARTIAL | `packages/shared/src/attendance.ts`, `apps/api/src/activity`, `attendance` | `live-status.test.ts` (shared), `role-separation-live-status`, `qa-round2-security`, `qa-round3-fixes` | PASS: attendance wins; a report is believed for 3 minutes; unknown otherwise; cleared at clock-out; ignored for a revoked device | ACTIVE / IDLE is what the device says; never fed by a real device here | No: NOT RUN (macOS), BLOCKED (Windows) | Pending |
| Day timeline `GET /attendance/timeline` | PASS (API) | `apps/api/src/attendance`, `packages/shared/src/attendance.ts` | `role-separation-live-status`, `qa-round2-security`, `qa-round3-fixes` | PASS: employee-zone day bounds on the 23 h and 25 h New York days; clock-out before the next clock-in at a shared instant; stable pagination; self, team head and both admins allowed, 404 otherwise | Stored rows only; gaps are not computed | Not applicable (server / browser check) | Pending |
| Forgotten clock-out flag (`missingClockOut`) | PASS (API) | `packages/shared/src/timesheet.ts`, attendance and timesheet services | `role-separation-live-status` | PASS: flagged for the employee and the admins; nothing is closed | No automatic close (by decision); the employee requests a correction | Not applicable (server / browser check) | Pending |
| Dashboard: live attendance, day timeline, `/my` status line | PARTIAL | `apps/dashboard/src/app/(admin)/attendance`, `timesheets`, `my/*` | build, smoke, `verify-web-app` 91/91, `verify-my-panel` 45/46, `verify-schedule` 20/20 | PASS except one my-panel check (see FINAL-REGRESSION-REPORT.md) | Never fed by a real desktop app | No: NOT RUN (macOS), BLOCKED (Windows) | Pending |
| Audit of reads of another employee's attendance | PASS | controllers and `employees.service.ts` (`auditRead`) | `qa-round3-fixes` | PASS | Organisation overviews are not audited | Not applicable (server / browser check) | Pending |

## Rules as tested (API)

| Rule | Status |
|---|---|
| A report while not clocked in is ignored | PASS |
| On a break the status is "On a break" whatever the device says; a report sent during the break is not carried over | PASS |
| After clock-out the report is cleared and not accepted again | PASS |
| One employee's report cannot touch another employee | PASS |
| A browser session cannot post a report or clock in | PASS |
| `since` is never before the working stretch nor in the future | PASS |
| Monitoring off or notice not acknowledged: Unknown | PASS |
| Clock-in and clock-out on a real Windows device | BLOCKED |
| Clock-in and clock-out on a real Mac | NOT RUN |
