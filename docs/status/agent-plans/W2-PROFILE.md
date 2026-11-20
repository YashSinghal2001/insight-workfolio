# W2-PROFILE — Employee profile analytics (plan)

Branch `agent/w2-profile`. Contracts: `docs/IMPLEMENTATION-CONTRACTS.md` §4, §6, §7, §11.

## API
- `GET /api/v1/employees/:id/analytics?from=&to=` — `@RequirePermission("attendance:read-all")` + `@TeamScoped()`.
  - Target via `EmployeesService.attendanceTarget(caller, id)` (admin any; head own-team members; else 404; employees 403 at the guard).
  - Range: both or neither; ≤ 92 days (`MAX_RANGE_DAYS`); default = last 14 local days ending today in the employee's zone.
  - Sessions read once (`SESSION_COLUMNS` + `withBreaks`, same window as `TimesheetService.forEmployee`); totals per day via the
    shared `buildTimesheet` (no reimplemented rules).
  - Activity (active/idle, productive %, top apps) via `ActivityService.summary` only when the caller may read the employee under
    `activity:read-all`; otherwise `null`.
  - Corrections: counts by status of requests created in the range (local dates). Leave: `tallyLeave` per status when the caller may
    read under `leave:read-all`; otherwise `null`.
  - Audit: `EMPLOYEE_ATTENDANCE_VIEWED` `{view: "analytics", from, to}` (+ `EMPLOYEE_ACTIVITY_SUMMARY_VIEWED` when activity is served),
    after the data is produced; nothing for the caller's own record. No new audit action, no migration.
- Files: `apps/api/src/employees/analytics.{service,controller}.ts`, `packages/shared/src/employee-analytics.ts` (query schema,
  response types, pure `buildEmployeeAnalytics`), one-line registrations in `app.module.ts` / `shared/index.ts`.

## Dashboard `/employees/[id]`
- Header (name, code, email, team(s), status badge) + `Tabs`: **Overview** (default) and **Edit** (`?tab=edit` deep link).
- Overview: `RangePicker` (92 days, employee zone) → KPI `StatGrid`, worked/break `BarChart`, apps `DonutChart`, clock-in/out
  `DataTable`, corrections + leave summaries, devices summary. Each widget: own loading / empty / error.
- Edit: existing details form, account access, devices, blur, tracking overrides — moved unchanged.
- Browser suites expecting the edit controls on `/employees/:id` (verify-labels, verify-invitations, verify-wave2) visit
  `/employees/:id?tab=edit` instead (precise one-line edits).

## Tests
- `packages/shared/src/employee-analytics.test.ts`: aggregation (empty, open shift, DST day, median times, range default/validation).
- `apps/api/test/employee-analytics.e2e.test.ts`: admin 200; head in-team 200 / out-of-team 404; employee 403; unknown id 404;
  bad range 400; empty range; America/New_York DST employee; audit row written (and none on refusal); activity null without permission n/a (all roles with attendance:read-all also hold activity:read-all today — covered by the code path, asserted present for admin).

## Out of scope
No schema change, no new deps, no nav entry (page exists), no new browser suite (checks described in the report).
