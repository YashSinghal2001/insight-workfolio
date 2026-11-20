# W1-NOTIFY plan — notification rules, attendance event emails, daily digest

## Scope
Rules (type × team) with recipients (accounts only), six attendance event types, IMMEDIATE / DAILY_DIGEST / OFF
routing on top of the existing `notifications` queue (events + per-recipient deliveries, retries, re-check at send
time, mock transport). No dashboard UI (wave 2), no reports module.

## Files
- `packages/database/src/migrations.ts`: `0034_notification_rules` (+ migration test expectations).
- `packages/shared/src/notifications.ts`: types, zod schemas, catalogue entries (`roles: []` = routed by rules).
- `apps/api/src/notifications/notification-rules.service.ts` (new): rules CRUD, recipients, producers, digest, absence/late timer.
- `apps/api/src/notifications/notifications.controller.ts`: 4 routes. `notifications.service.ts`: send-time re-check and rendering of rule deliveries. `templates.ts`: attendance + digest templates.
- `apps/api/src/alerts/alerts.service.ts`: `sendAlertEmails` hook only. `attendance.service.ts`: ≤ 10 lines (one dependency, one call in `endWorkTime`, which both online and offline-sync paths call after commit).
- `apps/api/src/app.module.ts`: one provider line. `docs/notifications.md`.

## Schema (additive)
- `notification_rules`: id, type CHECK in the six types, mode CHECK default OFF, digest_local_time HH:MM default 18:00,
  timezone, team_id NULL = all, changed_by, timestamps; unique (type, coalesce(team_id,'')); no delete.
- `notification_rule_recipients`: append-only like `report_recipients` (added/removed, unique current row).
- `notification_events` + `employee_id`, `local_date`, `occurred_at` (NULL for existing system events).
- `notification_deliveries` + `rule_id` (NULL for matrix-routed deliveries).

## API (`settings:manage`)
GET `/notifications/rules` (creates missing org-wide OFF rows, then lists every rule), POST `/notifications/rules`
(409 duplicate, 404 unknown team), PATCH `/notifications/rules/:id` (mode, digestLocalTime, timezone),
PUT `/notifications/rules/:id/recipients` (`userIds`; each ACTIVE and admin, or head of the rule's team → else 400).
Account audit rows for create/update/recipient add/remove.

## Producers and routing
Events are recorded only when a non-OFF rule matches the employee (org-wide or a team they belong to): no rows otherwise.
Dedupe: clock-in/out `TYPE:<attendance event id>`; late/absence/missing clock-out `TYPE:<employee>:<local date>`;
productivity `PRODUCTIVITY_ALERT:<alert rule>:<employee>:<date>` (one per created alert).
IMMEDIATE: one delivery per eligible current recipient (admin → IT / SUPER_ADMIN, team head → EMPLOYEE role value), deduped across rules.
Send time re-check: account active, still a current recipient, still eligible, rule not OFF, employee still in the team.
LATE/ABSENCE: 60 s timer over `ScheduleService.daily` for each zone's today (ABSENT never on leave/holiday/non-workday/no policy); clock-in hook also checks late at once.
MISSING_CLOCK_OUT: public `recordMissingClockOut()` only.

## Digest / DST
Each tick, per DAILY_DIGEST rule: local now in the rule zone; once local HH:MM ≥ digest time, one digest event per
(rule, local date) by dedupe key `digest:<rule>:<date>` → one delivery per recipient. Content: events of that local
date recorded up to min(now, digest instant). Empty → nothing. DST: wall-clock comparison (gap → fires at first time
after it; overlap → dedupe keeps one). Restarts/repeated ticks: dedupe key.

## Tests
`apps/api/test/notification-rules.e2e.test.ts`: CRUD + RBAC (admin, employee 403, team head 403), validation 400,
recipient eligibility, each producer, dedupe, IMMEDIATE/DIGEST/OFF, digest once per day incl. New York spring/fall DST,
team scoping, disabled recipient skipped, retry still works, mock transport only. Migration tests updated.

## Acceptance
All gates green; existing notifications suite unchanged except the matrix expectation (new rule-routed types).
