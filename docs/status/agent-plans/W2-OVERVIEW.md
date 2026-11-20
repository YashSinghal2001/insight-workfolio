# W2-OVERVIEW — plan

Scope: one aggregate endpoint `GET /api/v1/overview?date=&teamId=` + the admin Overview page (`/`).

## Files

| File | What |
|---|---|
| `packages/shared/src/overview.ts` (+ `overview.test.ts`, one export line in `index.ts`) | query schema, `OverviewResponse`, `WORKLOAD_THRESHOLDS`, `workloadBucket`, `workloadDays` |
| `apps/api/src/overview/overview.{service,controller}.ts` (+ one line in `app.module.ts`) | aggregate |
| `apps/api/test/overview.e2e.test.ts` | RBAC, team filter, empty / 0 / 1 / many, past date, DST zone, 100-employee timing |
| `apps/dashboard/src/app/(admin)/page.tsx`, `app/(admin)/_components/overview-*.tsx` | page + widgets |
| `apps/dashboard/src/lib/overview.ts` (+ test) | pure widget logic (KPI cards, workload chart data, app slices) |
| `apps/dashboard/scripts/verify-web-app.mjs` | overview card check compares with `/overview` (same labels kept) |

## API

`attendance:read-all`, `@TeamScoped`. `assertTeamReadable` once, then existing services (each re-applies `scopeSql` +
`teamFilterSql`), all in parallel:

| Section | Source | Visible when |
|---|---|---|
| `kpis` | `AttendanceService.summary` (counts, pending, screenshots stored), `ScheduleService.daily` (late / absent / on leave), `AnomaliesService.missingClockOuts` (count), one query: active members without a non-revoked device ("app not installed") | always |
| `late`, `absent` | `ScheduleService.daily` rows with status LATE / ABSENT | always |
| `missingClockOuts` | `AnomaliesService.missingClockOuts` items | always |
| `workload` | sessions of the last 7 local days (date-6 … date) → shared `buildTimesheet` per employee → `workloadDays` | always |
| `workHours` | `AttendanceService.overview` (state, online, lastSeenAt) + the same timesheet day (net minutes incl. open shift so far, first in) | always |
| `topApps` | one grouped query over `activity_intervals` (ACTIVE), per-employee local-day bounds, scoped by `activity:read-all` | `activity:read-all` scope ≠ own |
| `recentScreenshots` | `ScreenshotsService.gallery` (metadata; thumbnails load via `/screenshots/:id/content`, which writes the access log) | `screenshots:read` scope ≠ own |
| `upcomingHolidays` | `HolidaysService.list` (date … date+30) | always |
| `upcomingLeaves` | approved leave overlapping date … date+14, scoped by `leave:read-all` (no reasons) | `leave:read-all` scope ≠ own |
| `pendingApprovals` | `AttendanceService.summary` pending counts | always |

Hidden section → `null`. Date defaults to today in `DEFAULT_TIMEZONE`; each employee's local date rules come from the reused services.

Workload rule (shared constants): per member per local day with completed net work > 0: `> 110 %` of
`scheduledDailyMinutes` (480) = OVERWORKED, `< 80 %` = LESS_UTILISED, otherwise HEALTHY. Days without work are not counted
(rest days, absences). Open shifts are not counted (only completed, reportable time).

## UI

`<GlobalFilters />` (date + team). Widgets fed by one request but each renders its own empty / null ("not available
for your role") state; the request's loading / error shows per widget with retry. KPI grid 5→3→2→1 columns; cards keep
the labels the browser suite reads ("Active employees", "Working now", …, "Late today", "Absent today", "Pending leave
requests", "Pending corrections", "Screenshots stored today"). Lists link to `/employees/[id]` and `/attendance`.
Long text in `PageHeader about`.

## Tests / acceptance

API e2e as listed; shared unit tests for bucketing; dashboard SSR/unit tests for pure widget logic. Gates: build:packages,
typecheck + lint (shared, api, dashboard), full API suite, dashboard test:unit. Accept: < 1 s for 100 employees (timing
printed), no browser suite run (checks described in the report).
