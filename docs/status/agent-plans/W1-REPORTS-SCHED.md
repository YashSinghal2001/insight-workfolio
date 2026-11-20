# W1-REPORTS-SCHED — plan

Scheduled email reports: report kinds, send time, team scope, Graph delegated transport, configuration UI.
Builds on F12 (`apps/api/src/reports/**`, `packages/shared/src/reports.ts`, migration 0012). No new dependencies.

## Scope and files

| Area | Files |
|---|---|
| Schema | `packages/database/src/migrations.ts` (append `0035_report_schedule_kinds`), migration tests (`migration-status`, `database.test.ts`) |
| Shared | `packages/shared/src/reports.ts` (+ `reports.test.ts` or the existing shared test file): kinds, schemas, `reportDueAt`, rendering |
| API | `apps/api/src/reports/{reports.service,reports.controller,mail}.ts`; `config/env.ts` (additive: provider enum + one refine); `apps/api/.env.example` |
| Dashboard | new `app/(admin)/reports/scheduled/page.tsx`; `app/(admin)/reports/page.tsx` (activity overview + link only); `scripts/smoke.mjs` (+1 route); `scripts/verify-reports.mjs` (routes/selectors, not run) |
| Docs | `docs/email-reports.md` |
| Tests | `apps/api/test/reports.e2e.test.ts` (+ new `reports-kinds.e2e.test.ts`), `apps/api/test/env.test.ts` (one case), shared unit tests |

## Schema (0035, additive)

- `report_schedules.kind TEXT NOT NULL DEFAULT 'WORKED_HOURS' CHECK (kind IN ('WORKED_HOURS','LATE','ABSENT'))`
- `report_schedules.send_at_local_time TEXT` (CHECK `HH:MM` 00:00–23:59 or NULL; NULL = current behaviour: first scheduler check after the period ends)
- `report_schedules.team_id TEXT REFERENCES teams(id)` (NULL)
- Two triggers (insert / update) raising when `employee_id` and `team_id` are both set: a DB backstop for the zod + service rule.

## API (existing routes, additive fields; all `reports:manage`)

- `POST /reports/schedules`: + `kind` (default WORKED_HOURS), `sendAtLocalTime` (`HH:MM` | null), `teamId` (uuid). `employeeId` + `teamId` → 400. Unknown employee/team → 404 (existing reference rule).
- `PATCH /reports/schedules/:id`: + `kind`, `sendAtLocalTime`, `timeZone`, `employeeId` (nullable), `teamId` (nullable). Merged result with both set → 400.
- `ReportSchedule` gains `kind`, `sendAtLocalTime`, `team: { id, name } | null`, `nextDueAt` (UTC ISO, for the list).
- `ReportProviderInfo.provider` gains `graph-delegated`.

## Generation

- WORKED_HOURS: the existing report; scope organisation / team (active members of the team, not terminated) / one employee. Project time for a team = merged per-member summaries (never other teams' time).
- LATE / ABSENT: for each local date in the period, `ScheduleService.daily({ date })` (existing late/absent/leave/holiday/no-policy rules, each employee's own zone), filtered to the scope; rows with status LATE (date, first clock-in local, minutes late) or ABSENT (date). Holiday / leave / not scheduled / no policy rows are never listed. Warning when days had no enabled work schedule. No leave details, no reasons.
- Email: plain text plus an HTML `<pre>` of the same text, HTML-escaped; subject single-line (control characters removed).

## Scheduling and DST

- Pure `reportDueAt(period, timeZone, sendAtLocalTime)` in shared: `zonedToUtc(<period.to + 1 day>T<HH:MM or 00:00>, zone)`, so daily → next local day, weekly → first local day after the week, monthly → the 1st of the next month. `zonedToUtc` resolves DST gaps forward and repeated times to the first occurrence.
- `tick(now)`: for each active schedule, the last complete period and the one before it; create the run for the most recent period whose due time has passed and that became due after the schedule was created (no backfill). Checking the previous period covers late send times (e.g. 23:59) that a 5-minute tick would otherwise skip. Exactly one run per schedule and period stays enforced by the existing unique key.
- "Run now" unchanged (last complete period, ignores send time).

## Transport

- `REPORT_MAIL_PROVIDER = none | mock | graph-delegated` (default none). `graph-delegated` reuses `DelegatedGraphMailTransport` (invitations.ts) with the OneDrive connection, sending as MAIL_SENDER. Env refine as for invitations (OneDrive settings and `MAIL_SENDER = ONEDRIVE_ACCOUNT_EMAIL`). Tests use mock only; no real provider is called.

## UI (`/reports/scheduled`)

- Provider banner: none / mock → "nothing is emailed"; graph-delegated → sends from the connected Microsoft account.
- Table (DataTable): name, kind, frequency, send time + zone, scope, recipients, last run status. Row actions: Edit, Run now, Pause/Activate (deactivate).
- Form (create / edit, FormField): kind, title, frequency, send time (`<input type=time>`, empty = after the period ends), time zone, scope (organisation / team / employee + pickers), include projects (WORKED_HOURS only). Recipients: checkboxes of eligible accounts in edit mode (after create the form switches to edit).
- Loading (SkeletonRows), empty (EmptyState), error (ErrorState + retry) per request; keyboard reachable native controls; table scrolls inside its card at 375 px.
- `/reports` keeps the activity overview and links to `/reports/scheduled`.

## Permissions

- Unchanged: `reports:manage` (admins). Employees and team heads → 403.
- Recipients: active admins; for one-employee reports also that employee; for team reports also the head of that (active) team. Rechecked at send time.

## Tests

- Shared: `reportDueAt` (IST, New York DST start/end, month ends incl. Feb/leap year, weekly), schema refinements, render escaping.
- API e2e: create/update each kind; validation (employee+team 400, bad time 400, unknown team 404); RBAC employee 403, team head 403; LATE/ABSENT content (holiday and leave excluded, New York date correct); team scope only team members; due time respected by `tick` (before → none, after → one, repeat → still one); previous-period catch-up; mock delivery recorded; no forbidden fields (leave reason, app name, email addresses).
- Database: 0035 columns, CHECKs and triggers; migration counts.

## Acceptance

All gates green (build:packages; typecheck + lint shared/database/api/dashboard; shared + database tests; full API suite, known time-of-day failures listed only). Default behaviour of existing schedules unchanged (kind WORKED_HOURS, send time NULL).
