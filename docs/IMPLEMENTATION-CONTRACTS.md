# Implementation Contracts — Product Parity Programme

Owner: lead agent (integration owner). Source plan: `docs/audit/IMPLEMENTATION-ROADMAP.md`.
Every sub-agent reads this file before starting. A change to anything marked **[contract]** needs the lead's
approval first: stop, report the proposed change, do not work around it.

## 1. Branches, worktrees, commits

| Item | Rule |
|---|---|
| Integration branch | `integration/product-parity` (from `main` @ `0493e54`). Never merged into `main` or pushed by agents. |
| Agent branch | `agent/<wave>-<id>`, checked out at `/Users/yashsinghal/Desktop/Projects/workfolio/.iw-agents/<wave>-<id>`. Work **only** inside your worktree. |
| Commits | Commit on your agent branch (small, conventional messages: `feat(api): …`, `test(api): …`). Never push, never touch other branches, never `git stash`, never rewrite history, never remove worktrees. |
| Other folders | Never read from or write to the other `insight-workfolio-*` worktrees, `hotfix-0.2.1/`, backups, or `~/.Trash`. |
| Disk | The disk has ~6 GB free. Run `df -h /System/Volumes/Data` before any `next build` or `cargo` build; stop and report if < 2 GB free. Delete your own worktree's `apps/dashboard/.next` after your last build. |
| Install | `pnpm install --frozen-lockfile --offline` (already done in your worktree). **No new dependencies** without lead approval. |

## 2. Feature ownership (wave 1)

Only the owner edits a file. Shared registration files may get **additive one-line edits** by anyone (the lead
resolves textual conflicts): `apps/api/src/app.module.ts`, `packages/shared/src/index.ts`,
`apps/api/src/config/env.ts`, `apps/dashboard/scripts/smoke.mjs` (route list).

| ID | Feature | Owns |
|---|---|---|
| W1-UI | UI foundation, theme, shell, navigation, global filters | `apps/dashboard/src/app/{layout.tsx,globals.css,loading.tsx,error.tsx}`, `app/(admin)/layout.tsx`, `app/my/layout.tsx`, `components/{app-shell,sidebar,my-nav,kit,ui,api-status}.tsx`, new `components/{theme-toggle,global-filters,sub-nav}.tsx`, every existing `app/**/page.tsx` **except** `app/(admin)/reports/**` and `app/(admin)/desktop-updates/**`, dashboard `package.json` scripts, the dashboard steps of `.github/workflows/ci.yml`, nav assertions in `apps/dashboard/scripts/verify-*.mjs` |
| W1-CHARTS | SVG chart library | new `apps/dashboard/src/components/charts/**`, new `apps/dashboard/src/lib/charts*.ts` (+ tests) |
| W1-ATT-ANOMALY | Missing clock-out / stale device / long break detection; admin-initiated corrections | new `apps/api/src/attendance/anomalies.{service,controller}.ts`, `attendance/corrections.{service,controller}.ts`, new `packages/shared/src/attendance-anomalies.ts`, `packages/shared/src/corrections.ts` |
| W1-ATT-DATA | `teamId` filter, monthly / late data, overtime, export, live-status freshness | `apps/api/src/attendance/{attendance.service,attendance.controller,timesheet.service,timesheet-xlsx,sessions}.ts`, new `attendance/monthly.service.ts`, `apps/api/src/schedule/**`, `apps/api/src/common/scope.ts`, `packages/shared/src/{attendance,schedule,timesheet}.ts`, new `packages/shared/src/attendance-reports.ts` |
| W1-NOTIFY | Notification rules, attendance event emails, daily digest | `apps/api/src/notifications/**`, `packages/shared/src/notifications.ts`, migration `0034_notification_rules`, `docs/notifications.md`. May add **≤ 10 lines** to `attendance.service.ts` (one injected dependency + one call after a committed clock-in / clock-out); nothing else in that file |
| W1-REPORTS-SCHED | Scheduled report kinds, send time, team scope, Graph transport | `apps/api/src/reports/**`, `packages/shared/src/reports.ts`, migration `0035_report_schedule_kinds`, `app/(admin)/reports/**` (incl. new `/reports/scheduled`), `docs/email-reports.md` |
| W1-RELEASE | Build version visibility, desktop update telemetry, desktop attendance banner | `apps/api/src/health/**`, `HealthResponse` in `packages/shared/src/api.ts`, `apps/api/src/desktop-updates/**`, `apps/api/src/devices/**`, `packages/shared/src/desktop-updates.ts`, `apps/desktop/**`, `deploy/**`, `app/(admin)/desktop-updates/**`, `app/(admin)/account/**`, `docs/desktop/**`, `docs/deployment.md` |

## 3. Database [contract]

- Migrations live in `packages/database/src/migrations.ts` (append-only array, ascending ids, statements are
  checksummed — **never edit an existing migration**). Allocated ids: `0034_notification_rules` (W1-NOTIFY),
  `0035_report_schedule_kinds` (W1-REPORTS-SCHED). Any other schema change: ask the lead for an id first.
- Additive only (new tables, `ALTER TABLE … ADD COLUMN` with a NULL or constant default). **No table rebuilds**
  (decision: the `alert_rules.kind` CHECK rebuild from the roadmap is not done; anomalies and risk users are
  computed by queries).
- Preserve append-only history: never UPDATE/DELETE attendance events, sessions, corrections, audit rows;
  never auto-close a session or break. Fixes go through correction requests (approver ≠ requester).
- Update `packages/database/src/migration-*.test.ts` expectations when you add a migration.

## 4. API conventions [contract]

- Prefix `/api/v1`. Every new route has `@RequirePermission(...)` (the route-permission test reflects over all
  controllers). Reads of other people's data that team heads may use carry `@TeamScoped()` and filter rows
  with `scopeSql(caller, permission, column)` from `apps/api/src/common/scope.ts`.
- Foreign or out-of-scope ids → **404** (never 403, never a leak of existence). Validation → 400 via `ZodPipe`
  with schemas exported from `packages/shared`. Errors use the existing `ApiError` envelope (all-exceptions
  filter); add a machine-readable `code` only when a client must react to it.
- **Team filter**: optional query `teamId` (uuid). Semantics: rows restricted to *active* members of that team,
  intersected with the caller's scope. Admin + unknown team → 404. Team head + a team they do not head → 404.
  Helper (owned by W1-ATT-DATA, in `common/scope.ts`):
  `teamFilterSql(teamId: string | undefined, column: string): { sql: string; args: string[] }` and
  `assertTeamReadable(db, caller, teamId?: string): Promise<void>` (throws `NotFoundException`).
  Until it lands, other agents may only *declare* `teamId` in their schemas.
- Pagination: `page`, `pageSize` (≤ 100) → `Paginated<T>` (`items,total,page,pageSize`).
- Dates and time [contract]: instants are UTC ISO strings; a *local date* is `YYYY-MM-DD` read in **each
  employee's own IANA zone** (as `/attendance/daily` does); a month is `YYYY-MM`; a local time is `HH:MM`
  (24 h); ranges are inclusive `from`/`to`, at most `MAX_RANGE_DAYS` (92). Org-level settings without a
  zone default to `DEFAULT_TIMEZONE`. Use the helpers in `packages/shared/src/timesheet.ts`
  (`localDate`, `zonedToUtc`, `addDays`, …) — do not add another date library. Every scheduler/digest is
  DST-safe and fires at most once per local date (dedupe key or unique row).
- No secrets, tokens, file paths, screenshot content, window titles or keystrokes in responses, logs, emails or
  test fixtures. Sensitive reads (screenshots) stay access-logged through the existing services.

## 5. New endpoints (wave 1) [contract]

| Method + path | Permission | Team-scoped | Owner | Response type (packages/shared) |
|---|---|---|---|---|
| GET `/attendance/missing-clock-outs?teamId=` | `attendance:read-all` | yes | W1-ATT-ANOMALY | `MissingClockOutsResponse` |
| POST `/attendance/corrections` (+ optional `employeeId`) | `corrections:request`; `employeeId` ≠ own requires `attendance:review` (else 404) | — | W1-ATT-ANOMALY | existing correction type |
| GET `/attendance/monthly?month=&teamId=&q=&page=&pageSize=` | `attendance:read-all` | yes | W1-ATT-DATA | `MonthlyAttendanceResponse` |
| GET `/attendance/monthly/export?month=&teamId=&format=xlsx\|csv` | `attendance:read-all` | yes | W1-ATT-DATA | file |
| GET `/attendance/late?from=&to=&teamId=&page=&pageSize=` | `attendance:read-all` | yes | W1-ATT-DATA | `LateArrivalsResponse` |
| existing `overview`, `daily`, `summary`, `timesheets`, `timesheets/export` + `teamId` | unchanged | yes | W1-ATT-DATA | unchanged (additive fields only) |
| `/notifications/rules` (GET, POST), `/notifications/rules/:id` (PATCH), `/notifications/rules/:id/recipients` (PUT) | `settings:manage` | — | W1-NOTIFY | `NotificationRule` |
| report schedules (existing routes) + `kind`, `sendAtLocalTime`, `teamId` | `reports:manage` | — | W1-REPORTS-SCHED | `ReportSchedule` (additive) |
| GET `/health` + `version`, `commit` | public | — | W1-RELEASE | `HealthResponse` (additive) |

Shared shapes (the owner may **add** fields; renaming/removing needs approval):

```ts
// attendance-anomalies.ts (W1-ATT-ANOMALY)
export const MISSING_CLOCK_OUT_REASONS = ["PREVIOUS_DAY", "WORKDAY_ENDED", "MAX_SHIFT_EXCEEDED", "DEVICE_STALE", "LONG_BREAK"] as const;
export interface AttendanceAnomaly {
  employee: EmployeeRef; sessionId: string; clockInAt: string; clockInLocal: string; openForMinutes: number;
  lastDeviceSeenAt: string | null; openBreakSince: string | null;
  reasons: MissingClockOutReason[]; // never empty
  pendingCorrectionId: string | null;
}
export interface MissingClockOutsResponse { generatedAt: string; thresholds: AnomalyThresholds; items: AttendanceAnomaly[] }

// attendance-reports.ts (W1-ATT-DATA)
export interface MonthlyAttendanceDay {
  date: string; status: DailyAttendanceStatus | "OPEN"; firstInLocal: string | null; lastOutLocal: string | null;
  workedMinutes: number; breakMinutes: number; overtimeMinutes: number; lateMinutes: number | null;
}
export interface MonthlyAttendanceRow {
  employee: EmployeeRef; days: MonthlyAttendanceDay[];
  totals: { workedDays: number; presentDays: number; lateDays: number; absentDays: number; leaveDays: number;
            holidayDays: number; workedMinutes: number; overtimeMinutes: number };
}
export interface MonthlyAttendanceResponse extends Paginated<MonthlyAttendanceRow> { month: string }
export interface LateArrival { employee: EmployeeRef; date: string; dueLocal: string; firstClockInLocal: string; lateMinutes: number }
export interface LateArrivalsResponse extends Paginated<LateArrival> { from: string; to: string }

// notifications.ts (W1-NOTIFY)
export const ATTENDANCE_NOTIFICATION_TYPES = ["ATTENDANCE_CLOCK_IN", "ATTENDANCE_CLOCK_OUT", "LATE_ARRIVAL", "ABSENCE", "MISSING_CLOCK_OUT", "PRODUCTIVITY_ALERT"] as const;
export const NOTIFICATION_RULE_MODES = ["IMMEDIATE", "DAILY_DIGEST", "OFF"] as const;
export interface NotificationRule {
  id: string; type: AttendanceNotificationType; mode: NotificationRuleMode; digestLocalTime: string | null;
  timezone: string; teamId: string | null; recipients: { userId: string; fullName: string | null; email: string }[];
  changedBy: string; createdAt: string; updatedAt: string;
}
```

## 6. Dashboard conventions [contract]

- Data: `api<T>(path)` / `apiBlob` / `apiResponse` from `src/lib/api.ts`. No new data-fetching library.
- UI kit (`components/kit.tsx`): `PageHeader`, `StatCard`/`StatGrid` (KPI cards), `DataTable`, `StatusBadge`
  (status chips; tones `success|warning|danger|neutral|info`), `Tabs`, `EmptyState`, `ErrorState(onRetry)`,
  `SkeletonRows`, `ConfirmDialog`, `Button`, `FormField`. Reuse; do not fork.
- Every widget handles **loading / empty / error independently**: one failing request never blanks a page.
- Theme tokens are CSS variables (`--background`, `--surface`, `--surface-muted`, `--foreground`, `--muted`,
  `--border`, `--border-strong`, `--brand`, `--focus`, `--success[-soft]`, `--warning[-soft]`,
  `--danger[-soft]`, `--info[-soft]`) exposed as Tailwind colours (`bg-surface`, `text-muted`, …). Never
  hard-code hex colours in components; charts use the same variables. Status colours: green working/healthy,
  amber break/not started, red late/absent/over, grey offline.
- Global filters (W1-UI, `components/global-filters.tsx`) [contract]:
  `useGlobalFilters(): { date: string; teamId: string | null; setDate(d): void; setTeamId(id): void }`
  (URL query `?date=YYYY-MM-DD&team=<uuid>`, date defaults to today in the viewer's zone) and
  `<GlobalFilters date? team? />` which a page renders to opt in. Pages that ignore filters do not render it.
- Sub-menus (Reports, Settings) use `<SubNav items={[{label, href}]} />` from `components/sub-nav.tsx` (W1-UI).
- `PageHeader` gains `about?: ReactNode`: long compliance/explanatory text goes there (a closed
  "About this page" disclosure); it is kept, never deleted.
- Responsive: no page-level horizontal scroll at 375 px; wide tables scroll inside their card; cards reflow.
  Keyboard reachable, visible focus, `aria-label`s on icon buttons, colour never the only signal.
- Admin route map (final; W1-UI builds the nav, later waves build missing pages):
  REALTIME `/` Overview · `/live-team` Live team — ATTENDANCE `/attendance` · `/timesheets` · `/corrections` ·
  `/leave` · `/holidays` — MONITORING `/activity` · `/timeline` · `/screenshots` · `/websites` · `/risk-users`
  — WORK `/projects` — REPORTS `/reports` (sub-menu: `/reports/daily-attendance`, `/reports/monthly-attendance`,
  `/reports/monthly-in-out`, `/reports/late`, `/reports/overtime`, `/reports/summary`, `/reports/scheduled`)
  · `/alerts` — PEOPLE `/employees` · `/teams` · `/devices` · `/roles` (Super Admin) — ADMIN `/notifications`
  · `/audit` · `/desktop-updates` · `/settings` (sub-menu: `/settings/schedule`, `/settings/monitoring`,
  `/settings/screenshots`, `/settings/labels`, `/settings/websites`, `/settings/storage`,
  `/settings/notifications`, `/settings/leave-types`) · `/account`.
  Nav links to pages that do not exist yet are allowed only in the nav config; they are built in later waves.

## 7. Tests [contract]

| Layer | Where / how |
|---|---|
| Shared + database units | `packages/*/src/*.test.ts`, `node --test` (via `pnpm --filter … test`) |
| API integration | `apps/api/test/<feature>.e2e.test.ts`: in-process Nest app, `DATABASE_URL=:memory:`, synthetic people (`*@example.com`), built from `dist` (`pnpm --filter @workfolio/api test` runs `nest build` first). While iterating run one file: `pnpm --filter @workfolio/api build && cd apps/api && node --test test/<file>` |
| Dashboard units | pure logic in `src/lib/*.ts` with `*.test.ts`/`*.test.mjs` next to it, `node --test` (W1-UI wires a `test:unit` script into `test` and CI). React components: `react-dom/server` render assertions in node tests |
| Browser (CDP) | existing `apps/dashboard/scripts/verify-*.mjs` use **fixed ports 4000/3105/9345** → only the lead (and W1-UI in wave 1) runs them. New browser suites must read `IW_API_PORT`, `IW_APP_PORT`, `IW_CDP_PORT` from env (defaults 4000/3105/9345) |
| Desktop | `node --test` + `cargo test` / `cargo clippy -- -D warnings` in `apps/desktop` |

Every feature covers: success, failure, empty, boundary, permission (admin / team head in-team / team head
out-of-team → 404 / employee → 403), validation (400), and a regression case for the bug it fixes. Use an
injected clock (`now` parameter) for time logic; test IST, America/New_York and a DST transition.
**Known pre-existing failures** (baseline on `main`, time-of-day dependent, fail 00:00–~03:00 UTC):
`screenshots-gallery`, `self-service` ×3, `team-head-scope` (summary), `timelapse` (frames). Do not "fix" them
in your branch unless assigned; just report whether you saw them.

Gates before reporting done (run in your worktree): `pnpm build:packages`, typecheck + lint of every package
you touched, your new tests, and the full suite of every package you touched (API: all 63+ files).

## 8. Email and privacy [contract]

Development and tests use the **mock** transport (`REPORT_MAIL_PROVIDER=mock`, `INVITATION_MAIL_PROVIDER=none|mock`).
Never configure or call a real provider, never use a real address. Recipients are user accounts only (no
free-form addresses). Emails never contain screenshots, app/window names, leave reasons or another team's data.

## 9. Owner decisions — defaults used until the owner decides

| Decision | Default implemented |
|---|---|
| Missing clock-out policy | **Flag only** (dashboard + optional email). No auto clock-out, no desktop auto-correction |
| Admin-initiated correction approval | Existing rule: a **different** admin approves (no self-approval) |
| Email recipients | Accounts only |
| Digest time / zone | `18:00` in `DEFAULT_TIMEZONE`, editable per rule; every rule starts `OFF` |
| Anomaly thresholds | Constants: workday end = expected start + 8 h + 2 h grace; max shift 14 h; stale device 30 min; long break 2 h |
| Work schedule in production | Unchanged (off) — configuration, not code |

## 10. Agent report format (≤ 350 words, plain text)

```
REPORT <ID> — branch agent/<…> @ <sha>
Plan: docs/status/agent-plans/<ID>.md
Delivered: <≤ 10 bullets>
Contract changes/deviations: <none | list>
Schema/API: <migrations, endpoints>
Tests added: <files, counts>  Gates: typecheck <ok>, lint <ok>, tests <pass/total per package>
Not done / risks / owner decisions: <list>
```
