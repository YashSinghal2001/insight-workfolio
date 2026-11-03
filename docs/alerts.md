# Custom rules and alerts (F06)

Admins define alert rules from a fixed set of kinds; a scheduled evaluator turns matches into alerts
shown on the admin **Alerts** page (`/alerts`), where they can be acknowledged. **In-app only**:
email delivery is blocked on API-09 (no email provider; see `docs/email-reports.md`).

## Rule kinds

| Kind | Setting | Matches (in each employee's own time zone) | Data |
| --- | --- | --- | --- |
| `LATE_CLOCK_IN` | none | Today's daily attendance status is **Late** (first clock-in after expected start + grace) | Work schedule (W17/W18), attendance sessions |
| `NOT_CLOCKED_IN_BY` | local `HH:MM` | Today is a scheduled workday, the local time is at or after `HH:MM`, and there is no clock-in that started today | Work schedule, attendance sessions |
| `IDLE_SHARE_ABOVE` | 1–99 % | **Yesterday**: idle seconds / (active + idle) of activity intervals started that day is above the percentage, with at least 60 tracked minutes | Activity intervals |
| `NO_ACTIVITY_FOR` | 5–720 min | Clocked in now, not on a break, and no **active** interval for N minutes (counted from the latest of clock-in, last break end and last active interval). Only sessions with at least one recorded interval count, so untracked employees are never flagged | Attendance, breaks, activity intervals |

Attendance rules use the daily attendance view (`ScheduleService.daily`), so they need an **enabled
work schedule**; without one nobody is late or "not clocked in" (same rule as W18). There are no
per-person schedules.

## Never alerted

- On an organisation **holiday** (`holidays`, read as a local date in the employee's zone).
- On a day with **approved leave** of any portion (pending or rejected leave does not count).
- Employees who are not active (employment or account), or whose profile did not exist that day.

Alerts contain only what admins already see (daily attendance, activity totals): the employee, rule,
local date and a short detail such as "Clocked in at 09:30, 30 min after the expected start" or
"Idle 67% of 90 min tracked". Never application names, websites, screenshots or leave reasons.

## Evaluator

- In-process timer every 60 s (skipped under `NODE_ENV=test`), like the report scheduler.
- **One alert per (rule, employee, local date)**: unique key in the database, inserted with
  `ON CONFLICT DO NOTHING`. Later ticks the same day add nothing.
- Assumes a **single API instance**; a second instance only repeats work, the unique key still
  prevents duplicates.
- Activity is uploaded by the desktop app in batches, so `NO_ACTIVITY_FOR` with a short threshold can
  fire while an upload is pending. Prefer 30 minutes or more.
- Email hook: `AlertsService.sendAlertEmails` is called with each tick's new alerts and does nothing
  until a provider exists (inject `MAIL_TRANSPORT` from `reports/mail.ts` there).

## API (admin only, `alerts:manage`)

`GET /alerts?status=open|acknowledged|all` (default open, newest first, at most 500);
`POST /alerts/:id/acknowledge` (204; 409 if already acknowledged);
`GET/POST /alerts/rules`; `PATCH /alerts/rules/:id` (name, active, and the setting of its kind; the
kind never changes); `DELETE /alerts/rules/:id` (deletes the rule **and its alerts**; pause instead to
keep them). Data: migration `0026_alert_rules` (additive: `alert_rules`, `alerts`; an alert is
acknowledged once and otherwise never changes).

## Verification

| Layer | Test |
| --- | --- |
| Schema, constraints, existing data kept | `packages/database/src/alerts.test.ts` |
| CRUD, permissions (employee 403, signed out 401), evaluator with injected clock, dedup, holiday, approved leave, acknowledge | `apps/api/test/alerts.e2e.test.ts` |
| Every route has a permission | `apps/api/test/route-permissions.test.ts` |

Dashboard page not yet checked in a browser.
