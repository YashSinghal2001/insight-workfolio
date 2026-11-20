# W1-ATT-ANOMALY — plan

Missing clock-out / stale device / long break detection (flag only) and admin-initiated corrections.
Contracts: docs/IMPLEMENTATION-CONTRACTS.md §2, §4, §5, §9.

## Scope and files
| File | Change |
|---|---|
| `packages/shared/src/attendance-anomalies.ts` (new) | `MISSING_CLOCK_OUT_REASONS`, `AttendanceAnomaly`, `MissingClockOutsResponse`, `AnomalyThresholds`, `ANOMALY_THRESHOLDS`, `missingClockOutsQuerySchema`, pure `workdayEnd()` + `detectAnomalies(input, now)` |
| `packages/shared/src/attendance-anomalies.test.ts` (new) | unit tests |
| `packages/shared/src/index.ts` | one export line |
| `packages/shared/src/corrections.ts` | optional `employeeId` (uuid) on every create variant (additive) |
| `apps/api/src/attendance/anomalies.service.ts` (new) | `AnomaliesService.missingClockOuts(caller?, teamId?, now?)` — public, used by wave 2 (emails, Overview) |
| `apps/api/src/attendance/anomalies.controller.ts` (new) | `GET /api/v1/attendance/missing-clock-outs?teamId=` |
| `apps/api/src/attendance/corrections.service.ts` | `create` honours `employeeId` |
| `apps/api/src/app.module.ts` | register controller + provider (additive) |
| `apps/api/test/attendance-anomalies.e2e.test.ts` (new) | e2e |

Not touched: attendance.service/controller, schedule/*, scope.ts (W1-ATT-DATA / lead). No migration, no new dependency.

## Rules (thresholds = contracts §9)
Only OPEN sessions (`clock_out_at IS NULL`). Reasons, in this order:
- `PREVIOUS_DAY` — clocked in on an earlier local date than today (employee zone); reuses `missingClockOut()`.
- `WORKDAY_ENDED` — now > workday end + 2 h grace.
  - Schedule applies (enabled policy + per-person override in force at the start of the clock-in's local day, a workday, not a holiday) **and** clock-in before expected start + 8 h: end = expected start + 8 h, so flagged after start + 10 h.
  - Otherwise (no schedule, rest day, holiday, or clock-in after the scheduled end, e.g. an evening shift): end = end of the clock-in's local day (next local midnight, DST-safe via `zonedToUtc`), so flagged after 02:00 next local day.
- `MAX_SHIFT_EXCEEDED` — open > 14 h (UTC instant difference).
- `DEVICE_STALE` — not on a break and no contact for > 30 min; contact = latest `last_seen_at` over the employee's non-revoked devices, or the clock-in if later (two devices: the fresh one wins). Excluded during an open break (laptop closed at lunch is normal; `LONG_BREAK` covers long breaks).
- `LONG_BREAK` — open break > 2 h.
Boundaries are strict (exactly at the threshold = not flagged).

## API
`GET /attendance/missing-clock-outs?teamId=` — `@RequirePermission("attendance:read-all")`, `@TeamScoped()`;
`assertTeamReadable` then `scopeSql` + `teamFilterSql`. Admin: any team, unknown team 404; head: own team ok,
other team 404; employee 403; bad uuid 400. One batched read (open sessions with correlated max device
contact / open break / pending correction; policies; overrides of open-session employees; holidays) — no N+1.
Disabled / terminated employees with an open session are listed with `accountStatus` and `employmentStatus`
(additive fields). Nothing is closed or modified; no email.

`POST /attendance/corrections` + optional `employeeId`: omitted / own → unchanged. Other employee → caller must
hold `attendance:review` (via `attendanceTarget(caller, id, "attendance:review")`), else 404; unknown → 404.
`requested_by` = the admin, so the existing DB rule (reviewer ≠ requester) needs a different admin to approve.
Team heads cannot file for others (404). The employee sees it in their own list.

## Tests
Unit: each reason alone, combinations, none, closed ignored, boundaries, scheduled vs fallback end, evening
shift fallback, DST (America/New_York 2026-03-08 and 2026-11-01), cross-midnight IST.
E2E: each reason, none, closed ignored, pending correction id, team filter (admin any / unknown 404 / head own
ok / head other 404 / employee 403), disabled + terminated listed, admin who is also an employee, two devices,
correction on behalf (visible to employee, same admin approve refused, second admin approve ok, anomaly gone),
team head / employee filing for others 404, validation 400s (bad uuid, missing reason, bad teamId), regression
of the three production cases.

## Acceptance
Gates: `pnpm build:packages`, typecheck + lint shared and api, shared tests, full API suite.
