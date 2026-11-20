# W1-ATT-DATA plan — team filter, monthly / late data, overtime, export, live-status freshness

Branch `agent/w1-att-data`. Contracts: `docs/IMPLEMENTATION-CONTRACTS.md` §4–§5, §7.

## Scope

1. Optional `teamId` (uuid) on `GET /attendance/{overview,daily,summary,timesheets,timesheets/export}`:
   `assertTeamReadable` first (404 for unknown / foreign team), then `teamFilterSql` next to `scopeSql`.
   Without `teamId` nothing changes.
2. `GET /attendance/monthly?month=YYYY-MM&teamId&q&page&pageSize` → `MonthlyAttendanceResponse`.
3. `GET /attendance/monthly/export?month&teamId&format=csv|xlsx` → `attendance-YYYY-MM.(csv|xlsx)`.
4. `GET /attendance/late?from&to&teamId&page&pageSize` → `LateArrivalsResponse` (≤ 92 days, date desc, then employee).
5. Live-status freshness on `/attendance/overview` rows: `lastSeenAt` + `online` (seen ≤ 5 min,
   `DEVICE_ONLINE_WINDOW_MS` in shared). Attendance state untouched.
6. Overtime per day + totals in monthly rows (existing `buildTimesheet` rule: net completed time above
   `scheduledDailyMinutes`).

## Files

| File | Change |
|---|---|
| `packages/shared/src/attendance-reports.ts` (new) | contract types; query schemas (`teamFilterSchema`, monthly, monthly export, late); pure `attendanceDays()` (per-day status + minutes, built on `buildTimesheet` + `dailyAttendanceStatus`), `monthlyTotals`, export rows/codes, filename |
| `packages/shared/src/attendance-reports.test.ts` (new) | unit tests of the pure aggregation |
| `packages/shared/src/attendance.ts` | `teamId` on the summary query; `DEVICE_ONLINE_WINDOW_MS`, `deviceOnline()`, `OverviewFreshness` |
| `packages/shared/src/schedule.ts` | `teamId` on the daily query; `scheduleInForce()` (moved from schedule.service so monthly reuses it) |
| `packages/shared/src/index.ts` | one export line |
| `apps/api/src/attendance/monthly.service.ts` (new) | monthly, export, late: bulk queries only |
| `apps/api/src/attendance/{attendance.service,attendance.controller,timesheet.service,timesheet-xlsx,sessions}.ts` | team filter, routes, freshness, xlsx writer, `scopedEmployees()` page helper |
| `apps/api/src/schedule/schedule.service.ts` | team filter on daily; uses shared `scheduleInForce` |
| `apps/api/src/app.module.ts` | one provider line (`MonthlyService`) |
| `apps/api/test/attendance-{monthly,late,team-filter}.e2e.test.ts` (new) | API tests |

No schema change, no new dependency.

## DB / API dependencies

Reads only: `employee_profiles`, `users`, `teams`/`team_members` (via helpers), `attendance_sessions`, `break_sessions`,
`leave_requests` (APPROVED), `holidays`, `work_schedule_policies`, `employee_tracking_overrides`, `devices`.
`EmployeesService.list` (not mine) has no team filter, so overview / timesheets page employees through a
small `scopedEmployees()` helper in `sessions.ts` with the same WHERE / ORDER BY plus `teamFilterSql`.

## Rules (same as `/daily`, `/timesheet`)

- Each day is a local date in the employee's own zone; policy + override in force at the start of that local day.
- Status precedence = `dailyAttendanceStatus`; displayed `OPEN` when the day has a still-open shift (totals keep
  the underlying status). Days before the profile existed: `NOT_SCHEDULED`. Listed: active account + employment.
- Minutes = `buildTimesheet` day values floored; row totals = timesheet totals floored (equal to `/timesheet`).
- firstIn = earliest clock-in that local day; lastOut = latest completed clock-out of that day's shifts (HH:MM local).
- Late = underlying status LATE (incl. still-open shifts); `dueLocal` = expected start + grace (HH:MM local).

## Permissions

`attendance:read-all` + `@TeamScoped()`; heads see only their teams; employees 403; foreign/unknown team 404.

## Performance

Monthly: one page query (+count), one batch (sessions, leave, holidays, policies, overrides), one breaks query;
pure aggregation in memory. Late / export: same, all scoped employees. Intl formatters cached per zone if timing
needs it. Target < 1 s for 100 employees × 31 days (timed in the e2e test with synthetic rows).

## Tests

Shared unit: day list for 28/29/30/31-day months, status precedence incl. OPEN, minutes = timesheet, totals,
DST, export codes. E2E: leap Feb, 30/31-day months, DST March (America/New_York) and IST, cross-midnight shift,
open session, holiday, full + half-day leave, NO_POLICY, mid-month schedule change, team filter matrix
(admin any / unknown 404 / head own / head other 404 / employee 403), validation 400, export content + no
forbidden fields + filename, monthly totals = timesheet totals, late ordering/paging/range cap, overview
freshness (stale device → online false; regression for the 6 h "Online" case), unchanged output without teamId.

## Acceptance

All gates green (build:packages, typecheck + lint shared/api, shared tests, full API suite with only the
known time-of-day failures), no change to existing responses except added fields.
