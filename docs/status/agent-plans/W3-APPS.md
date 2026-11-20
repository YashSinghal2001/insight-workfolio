# W3-APPS — plan

Scope: app-usage analytics on `/activity` (tabs) and computed risk users (`/risk-users`). No schema change, no new deps.

## API (all `activity:read-all`, `@TeamScoped`, `assertTeamReadable`, scope = `scopeSql` + `teamFilterSql`, active employees)

| Route | What | Reuse |
|---|---|---|
| GET `/activity/apps?from&to&teamId` (≤ 31 days) | per-app active time (+ dominant label, employee count), label totals, per-employee usage (active, idle, label split, top app) | `APP_KEY` (exported from activity.service), per-employee local-day bounds as `appTotals`, `ActivityCategoriesService.labelsFor` (team labels) |
| GET `/activity/apps/history?from&to&teamId&app=<key>` (≤ 31 days) | one app: active time per local day (all) and per employee per day | same; employees chunked (≤ 100 per query); one `EMPLOYEE_ACTIVITY_SUMMARY_VIEWED` audit row per other employee with usage (existing pattern) |
| GET `/activity/risk-users?from&to&teamId` (≤ 92 days) | employees with ≥ 1 trigger: alert rows in range grouped by rule kind + "less working hours" | alerts table (read-only); `MonthlyService.monthly` per month (status/holiday/leave/schedule rules) + `POLICY.scheduledDailyMinutes` |

Less working hours: scheduled days = days with status PRESENT / LATE / ABSENT (holiday, leave, not scheduled, not yet due and
open shifts excluded by the existing daily rules). Trigger when ≥ 1 scheduled day and average worked minutes per scheduled
day < `scheduledDailyMinutes × RISK_LESS_HOURS_SHARE` (shared constant 7/8: 7 h of 8 h). Count = scheduled days below that.
Ordering: distinct triggers desc, total count desc, name. No alert detail text, no app names in risk users.

Shared: new `packages/shared/src/activity-apps.ts`, new `packages/shared/src/risk-users.ts` (+ index exports), additive
`teamId` on `activityOverviewQuerySchema` (so the existing overview table honours the team filter).

## Dashboard

- `/activity`: `?tab=` summary | employees | history | review | employee. RangePicker (31 days) + `<GlobalFilters date={false} />` (team).
  Summary: DonutChart (top apps, slice colour by label) + StackedBar (label share) + existing overview table (now with teamId).
  Per employee: sortable DataTable. App history: app select → BarChart per day + per-employee table. Review apps: unclassified
  count + top unclassified apps, link to `/settings/labels` (no editor duplicated). One employee: existing view unchanged.
- `/risk-users` (nav MONITORING, smoke route): risky list + "Rules violated" accordion (`<details>`), links `/alerts`, `/employees/[id]`; about explains computation.
- Pure shaping in `src/lib/activity-apps.ts` (+ test).

## Tests

- `apps/api/test/activity-apps.e2e.test.ts`: apps + history (scope, team, 404/403, validation, labels, audit), risk users (alerts triggers, less-hours with holiday/leave excluded, empty, head own/other 404, employee 403, range validation).
- `packages/shared/src/risk-users.test.ts` (pure ordering/less-hours), dashboard `src/lib/activity-apps.test.ts` (chart data).

Browser checks for the lead: listed in the final report.
