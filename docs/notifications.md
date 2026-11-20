# Email notifications

One sender (`IT@TFFDigital.com`, `MAIL_SENDER`), one provider (Microsoft Graph, delegated `Mail.Send` through the
OneDrive connection: [invitations.md](invitations.md) §2 to §4), recipients chosen by the server from the event type
and each account's role.

Status (2026-11-18): **implemented and tested locally with the mock provider; not deployed, no real email sent.**
Needs migrations `0033_notifications` and `0034_notification_rules` (attendance rules, §9) and the mail rollout in [invitations.md](invitations.md) §4.

## 1. How it works

```
application code ──emit({type, description, subjectUserId?, dedupeKey?})──► NotificationsService
   1. routing        NOTIFICATION_ROUTES[type]            packages/shared/src/notifications.ts (the matrix)
   2. recipients     accounts table, per group            recordNotification() in notifications.service.ts
   3. record         notification_events + one notification_deliveries row per recipient (one transaction)
   4. queue          the deliveries table + a 60 s in-process timer (and at once after emit)
   5. template       renderNotification()                 apps/api/src/notifications/templates.ts
   6. send           EmailService ─► the configured transport ─► POST /me/sendMail
   7. log            status, attempts, error, provider request id on the delivery row ─► dashboard
```

| Piece | File |
|---|---|
| Routing matrix, types shared with the dashboard | `packages/shared/src/notifications.ts` |
| Service: emit, recipients, queue, retries, storage check, weekly summary, dashboard queries | `apps/api/src/notifications/notifications.service.ts` |
| `EmailService`: the one way out, address and subject checks, service status | `apps/api/src/notifications/email.service.ts` |
| Templates | `apps/api/src/notifications/templates.ts` |
| Admin endpoints `GET /notifications`, `POST /notifications/deliveries/:id/retry` (`settings:manage`) | `apps/api/src/notifications/notifications.controller.ts` |
| CLI for failures outside the API process (backup, monitor) | `apps/api/src/cli/notify.ts` |
| Dashboard page (Administration › Notifications) | `apps/dashboard/src/app/(admin)/notifications/page.tsx` |
| Tables | migration `0033_notifications` |

No new package, queue or scheduler: the queue is a table and a timer, the pattern the report and alert schedulers
already use (single API instance, API-13).

Invitation emails keep their own flow and table (`account_invitations`): the message carries a one-time link that
exists only inside the request, so it cannot be queued. They use the same transport, so the same sender. Periodic
report emails keep the reports pipeline (`report_deliveries`), which is not connected to a real provider yet (§6).

## 2. Routing matrix

Recipient groups, resolved from `users` when the event is recorded and checked again when each email is sent:

| Group | Accounts |
|---|---|
| Employee | The one affected account (`subjectUserId`), if active. Never anyone else |
| IT | Active accounts with role `ADMIN` whose title is not Super Admin ("Admin" in the dashboard) |
| Super Admin | Active accounts with role `ADMIN` and title `SUPER_ADMIN` |

| Event (type) | Severity | Employee | IT | Super Admin | Raised by |
|---|---|---|---|---|---|
| Employee invitation | Info | Yes | No | No | Existing invitation flow |
| Account activation (`ACCOUNT_ACTIVATED`) | Info | Yes | No | No | First password set (`AuthService.setupPassword`) |
| Password changed (`PASSWORD_CHANGED`) | Warning | Yes | No | No | Password set again through a reset link |
| Security alert (`SECURITY_ALERT`) | Warning | Yes | Yes | No | Refresh-token reuse detected (session revoked) |
| Device registration issue (`DEVICE_ISSUE`) | Warning | No | Yes | No | Registration refused: computer belongs to another employee |
| Screenshot service failure (`SCREENSHOT_FAILURE`) | Warning | No | Yes | No | A screenshot upload hit a storage error, or the storage probe failed twice (once a day) |
| Backup failure (`BACKUP_FAILURE`) | Critical | No | Yes | Yes | `notify.js backup-failure` (not wired into the backup script yet, §6) |
| Critical system failure (`CRITICAL_FAILURE`) | Critical | No | Yes | Yes | Storage unreachable for an hour; `notify.js critical-failure` |
| Major security incident (`SECURITY_INCIDENT`) | Critical | Affected | Yes | Yes | No producer yet (§6) |
| Employee onboarding summary (`ONBOARDING_SUMMARY`) | Info | No | Yes | Yes | Mondays (UTC), counts for the past 7 days, skipped when nobody was added |
| Periodic report (`PERIODIC_REPORT`) | Info | No | Yes | Yes | No producer yet: reports have their own pipeline (§6) |

To change who is told about an event, edit `NOTIFICATION_ROUTES`; no event producer changes.

## 3. Critical incidents

- Every event with severity Critical is routed to **both** IT and Super Admin (asserted by a test over the matrix).
- The two groups are resolved separately and every recipient has their own delivery row, attempts and outcome.
  One recipient's failure neither blocks nor hides another's.
- There are no user preferences, so nothing can switch a recipient off.
- A group with no active account gets a `FAILED` row ("No active IT (Admin) account to notify") instead of silence.
- The event row is written before anything is sent and is never changed by delivery: if every email fails, the
  incident is still in the database, the page shows "critical incidents not delivered", and nothing is marked sent.
- The email contains the incident ID, severity, category, time (UTC), the sanitized one-line description and a
  link to `<DASHBOARD_URL>/notifications?event=<id>` (sign-in required). No secret, token, screenshot or employee
  activity.

## 4. Delivery and reliability

| Status | Meaning |
|---|---|
| `PENDING` | Queued; sent within a minute |
| `PROCESSING` | Being sent now |
| `RETRYING` | A transient failure (HTTP 429, 5xx, network, Microsoft unreachable); waiting for the next attempt |
| `SENT` | Accepted by the provider (Graph gives no delivery confirmation) |
| `FAILED` | Not sent: a permanent error, or all attempts used. "Send again" on the page starts a fresh set |

- At most 4 attempts per recipient, 1, 5 and 30 minutes apart. Inside one attempt, a 401 from Graph gets one fresh
  token and one more try (the transport).
- Idempotency: a `dedupeKey` (unique) makes a repeated event a no-op; one delivery row per event, group and account.
- A send interrupted by a restart is retried after 10 minutes (that one email could arrive twice).
- A failed notification never raises another notification.
- Kept 365 days, then deleted (events and deliveries). Message bodies are never stored; logs carry ids and the
  short failure reason only.

## 5. Security

- Recipients come from the accounts table only. No endpoint, CLI argument or event field names an address.
- Membership is re-checked at send time: a disabled account, or one whose role changed, is not emailed.
- `EmailService` accepts exactly one valid address and a one-line subject (no recipient or header injection; Graph
  takes JSON, not raw headers). Every template value is HTML-escaped.
- Descriptions are reduced to one line of at most 500 characters with token-like strings removed; the affected
  employee never receives the description, the incident ID or an admin link.
- The log and the recipient lists are readable only with `settings:manage` (both admin identities); employees get 403.
- Tokens: unchanged. The OneDrive refresh token stays in its encrypted file; no token reaches the database or a log.
- Graph permissions: delegated `Mail.Send` only. `Mail.Read`, `Mail.ReadWrite`, `Mail.Send.Shared` are refused by
  the OneDrive scope check.

## 6. Limits and gaps

- **Storage and mail share one Microsoft sign-in.** If the OneDrive authorization expires or is revoked, the
  storage-failure emails cannot be sent either: they stay `FAILED`/`RETRYING` on the page. An independent channel
  (the existing `deploy/scripts/monitor.sh` alert) is still needed for that case.
- **Backup failure** is not raised automatically: `deploy/scripts/backup-db.sh` was not changed. To wire it, call
  `node --env-file=/etc/workfolio/api.env dist/cli/notify.js backup-failure "<reason>"` from its failure path (and
  from `monitor.sh` for a stale backup). The CLI only writes rows; the running API sends the emails.
- **No producer yet:** major security incident, periodic report, desktop-agent failures, screenshot *capture*
  failures on the desktop (the API only sees storage failures), API crash or database outage (the API cannot
  report its own death; that is `monitor.sh`'s job).
- **Report emails** still use `REPORT_MAIL_PROVIDER` (`none`/`mock`); pointing that pipeline at this sender is a
  separate change.
- **Attendance alerts** (`alerts`, F06) are emailed only through a `PRODUCTIVITY_ALERT` notification rule (§9).
- With `INVITATION_MAIL_PROVIDER=none` every delivery is recorded as `FAILED` ("No email provider is configured"):
  events are visible in the dashboard, nothing is emailed.
- Sending volume: one email per recipient per event. Exchange Online limits apply to the IT mailbox.

## 7. Configuration

No new variable. `INVITATION_MAIL_PROVIDER` selects the transport for invitations **and** notifications;
`MAIL_SENDER` is the sender and the IT contact named in every email; `DASHBOARD_URL` is the base of the links.
Rollout order, Entra steps and troubleshooting: [invitations.md](invitations.md) §3 and §4, plus migration `0033`.

## 8. Tests

`apps/api/test/notifications.e2e.test.ts` (mock provider, in-memory database, example.com accounts): the matrix,
IT / employee / Super Admin routing, critical incidents to both groups, each group failing on its own, both
failing, an empty group, retries and their bound, backoff, duplicates, interrupted sends, recipients re-checked at
send time, address and subject validation, HTML escaping and sanitizing, RBAC, the producers (activation, password
change, token reuse, storage, weekly summary) and the CLI. Graph 401/403 handling and the OneDrive scope policy:
`invitations.e2e.test.ts`, `onedrive.e2e.test.ts`. Not tested: real Microsoft, real delivery, the page in a browser.

## 9. Attendance notification rules (W1-NOTIFY)

Attendance events are not in the fixed matrix (§2): their `NOTIFICATION_ROUTES` entries have no group, and who
is told, and how, is set per rule by an admin.

| Type | Producer | One event per |
|---|---|---|
| `ATTENDANCE_CLOCK_IN` / `ATTENDANCE_CLOCK_OUT` | `AttendanceService`, after a committed clock-in/out, online or offline-synced (`endWorkTime`) | attendance event row (`TYPE:<attendance_events.id>`): replays and duplicate uploads add nothing |
| `LATE_ARRIVAL` | clock-in hook (at once) and the 60 s timer, from `ScheduleService.daily` status `LATE` | employee and local date |
| `ABSENCE` | 60 s timer, status `ABSENT` (each employee's today in their zone). Never on leave, a holiday, a non-workday or without an enabled schedule | employee and local date |
| `MISSING_CLOCK_OUT` | `NotificationRulesService.recordMissingClockOut()` (called by the anomaly detector, wave 2; no detection here) | employee and local date of the clock-in |
| `PRODUCTIVITY_ALERT` | `AlertsService.sendAlertEmails`, each created alert | alert rule, employee and local date (= one per alert) |

**Rules** (`notification_rules`, migration 0034): one per (type, team); `team_id` NULL = every employee, otherwise
only members of that active team. Mode `OFF` (default) · `IMMEDIATE` · `DAILY_DIGEST`; `digestLocalTime` (HH:MM,
default 18:00) in the rule's `timezone` (default `Asia/Kolkata`). Rules are switched OFF, never deleted.

**Recipients** (`notification_rule_recipients`, append-only like `report_recipients`): accounts only. Each must be
an ACTIVE admin (Admin or Super Admin), or, for a team rule only, the head of that team; anything else is a 400.
A team head therefore never receives another team's events. Delivery rows use the existing roles: Admin → `IT`,
Super Admin → `SUPER_ADMIN`, a team head without an admin role → `EMPLOYEE`; `rule_id` names the rule.

**Recording**: an event is written only when at least one rule that is not OFF covers the employee (with every
rule OFF, attendance writes nothing). IMMEDIATE rules add one delivery per eligible recipient (one per account even
if several rules name it). The event row keeps `employee_id`, `local_date` and `occurred_at`; no message is stored.

**Digest**: every 60 s, for each DAILY_DIGEST rule, once the wall clock in the rule's zone reaches
`digestLocalTime`, one digest event per rule and local date (dedupe key `digest:<rule>:<date>`) with one delivery
per current recipient: at most one email per recipient, rule and local date, whatever the number of ticks,
restarts or instances. It lists that date's events (employee local date) recorded up to the digest time, for
employees the rule covers at send time. An empty day sends nothing; events recorded after the digest time are
not emailed (they are on the Notifications page). DST: a digest time inside the spring-forward gap fires at the
first minute after it; the repeated fall-back hour cannot fire twice. A digest missed because the API was down
from digest time until local midnight is not sent later.

**Send-time re-check** (rule deliveries): the account is still active, still a current recipient, still eligible,
the rule is not OFF, and the employee is still covered (team member). Otherwise the delivery ends `FAILED`
("The recipient no longer receives this notification rule") and nothing is sent. Retries, backoff, the retry
button and the log are those of §4.

**Content** (`renderAttendance`, HTML escaped + plain text): employee name, employee code, local time with zone,
event type; a digest lists the same fields (first 200). Never screenshots, app or window names, alert details,
leave reasons or another team's data.

**API** (`settings:manage`; employees and team heads 403): `GET /notifications/rules` (creates any missing
organisation-wide OFF rule, then lists all), `POST /notifications/rules` (`type`, `mode`, `digestLocalTime`,
`timezone`, `teamId`; 409 duplicate, 404 unknown team), `PATCH /notifications/rules/:id` (`mode`,
`digestLocalTime`, `timezone`), `PUT /notifications/rules/:id/recipients` (`{ userIds }`, the full list, ≤ 50).
Every create, update, recipient added or removed writes an `account_audit` row (`NOTIFICATION_RULE_CREATED`,
`NOTIFICATION_RULE_UPDATED`, `NOTIFICATION_RECIPIENT_ADDED`, `NOTIFICATION_RECIPIENT_REMOVED`; metadata `ruleId`).

**Configuration**: none beyond §7. Tests: `apps/api/test/notification-rules.e2e.test.ts` (mock transport only).
