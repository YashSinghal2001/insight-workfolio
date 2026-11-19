# Notifications: Phase 2 approved design

**Status: DESIGN FOR FINAL IMPLEMENTATION APPROVAL (2026-11-18). This document describes no existing code.**

It carries the reviewed design plus the final corrections: transactional outbox, at-least-once delivery,
event-specific recipients, aggregated login warnings, persistent incident detection, the monitoring
dependency, and the application-side send limit.

> **Read first.** `docs/notifications.md` and a working-tree implementation (`apps/api/src/notifications/`,
> a `0033_notifications` migration, `cli/notify.ts`, a dashboard page) appeared on 2026-11-18 between 16:03
> and 16:14, written outside this design process. That implementation does **not** follow this design
> (§14 lists the differences). This file is kept separate so neither overwrites the other. Which one is the
> basis for Phase 2 is an open decision.

## 0. Scope

In scope: one `NotificationsService`, a fixed catalogue and router, templates, migration 0033, a delivery
worker, persistent incident detection, two admin endpoints, one dashboard page, one CLI and one systemd
unit file for events raised outside the API process.

Out of scope, unchanged:

- Invitation emails (`employees/invitations.ts`, `account_invitations`): the one-time link is never stored,
  so they cannot go through a stored-payload queue.
- Report emails (`reports/`, `report_*`, `REPORT_MAIL_PROVIDER`).
- `deploy/scripts/monitor.sh` (Teams / ntfy): stays the out-of-band alarm for a dead API or database (§10).
- No second OAuth flow, token store, mail transport, mailbox or free-form recipient address. The sender is
  the one central mailbox `IT@TFFDigital.com` through `INVITATION_MAIL_PROVIDER=graph-delegated` and
  `DelegatedGraphMailTransport`.

Reused as is: `MailTransport` / `MailMessage` / `MailError` (`reports/mail.ts`), the transports behind
`INVITATION_TRANSPORT`, the claim / lease / attempt-history pattern of `ReportsService.deliverDue`, the
timer pattern of `AlertsService`, `accountAudit`'s "statement for the caller's batch" pattern
(`audit/account-audit.ts`), the global `AuthGuard` with `@RequirePermission`, `RateLimiter`, and the
unified audit view.

## 1. Event catalogue and recipient matrix

Severity is fixed per type in code: `INFO`, `WARNING`, `CRITICAL`. Routing is fixed per type in code.
Invariant, asserted by a test over the whole catalogue: **every `CRITICAL` type goes to both IT and Super
Admin, and never excludes the actor.** Nothing can configure this away.

"Affected" is the one account the event is about (`subject_user_id`), whatever its role. "Actor" is the
signed-in account whose action caused the event (`actor_user_id`), if any.

| Type | Severity | Affected | IT | Super Admin | Actor mailed? | Recording |
|---|---|---|---|---|---|---|
| `LEAVE_DECIDED` | INFO | Yes | No | No | n/a (reviewer is not a recipient) | Outbox |
| `CORRECTION_DECIDED` | INFO | Yes | No | No | n/a | Outbox |
| `LEAVE_REQUESTED` | INFO | No | Yes | No | No | Outbox |
| `CORRECTION_REQUESTED` | INFO | No | Yes | No | No | Outbox |
| `ALERTS_RAISED` (one digest per evaluator pass) | INFO | No | Yes | No | no actor | Standalone |
| `INVITATION_FAILED` | WARNING | No | Yes | No | No (they saw the error on screen) | Outbox |
| `DESKTOP_UPDATE_FAILED` | WARNING | No | Yes | No | no actor | Outbox |
| `DEVICE_REGISTRATION_FAILED` | WARNING | No | Yes | No | no actor | Standalone (incident) |
| `RETENTION_FAILED` | WARNING | No | Yes | No | no actor | Standalone (incident) |
| `SECURITY_LOGIN_SUSPICIOUS` (aggregated, §6) | WARNING | No | Yes | No | no actor | Standalone (incident) |
| `ROLE_CHANGED` | WARNING | Yes | Yes | Yes | No | Outbox |
| `STORAGE_CONNECTION_CHANGED` | WARNING | No | Yes | Yes | No | Standalone |
| `SECURITY_SESSION_REUSE` | CRITICAL | Yes | Yes | Yes | no actor | Outbox |
| `STORAGE_RECONNECT_REQUIRED` | CRITICAL | No | Yes | Yes | no actor | Standalone (incident) |
| `BACKUP_FAILED` | CRITICAL | No | Yes | Yes | no actor | CLI (incident) |
| `SCHEDULER_FAILING` | CRITICAL | No | Yes | Yes | no actor | Standalone (incident) |
| `API_ERRORS_SPIKE` | CRITICAL | No | Yes | Yes | no actor | Standalone (incident) |
| `TEST_NOTIFICATION` (CLI only, go-live check) | INFO | No | Yes | Yes | no actor | CLI |

Producers:

| Type | Where |
|---|---|
| `LEAVE_DECIDED` | `leave/leave.service.ts:409` `close`, for `APPROVED` and `REJECTED` (not a cancellation) |
| `LEAVE_REQUESTED` | `leave/leave.service.ts:132`, the INSERT in `create` |
| `CORRECTION_DECIDED` | `attendance/corrections.service.ts:137` (approve batch) and `:168` (reject) |
| `CORRECTION_REQUESTED` | `attendance/corrections.service.ts:92` |
| `ALERTS_RAISED` | `alerts/alerts.service.ts`, the existing `sendAlertEmails` hook, after the alert rows are written |
| `INVITATION_FAILED` | `employees/invitations.ts`, the final `FAILED` batch of `deliverInvitation` |
| `DESKTOP_UPDATE_FAILED` | `desktop-updates/desktop-updates.service.ts:227` `report`, state `FAILED` |
| `DEVICE_REGISTRATION_FAILED` | `devices/devices.service.ts:72` `register`, the three refusals |
| `RETENTION_FAILED` | the scheduled-purge catch blocks in `screenshots.service.ts`, `activity/retention.service.ts`, `websites.service.ts` |
| `SECURITY_LOGIN_SUSPICIOUS` | `auth/auth.service.ts` `login`: the throttle refusal and the invalid-login branch |
| `ROLE_CHANGED` | `roles/roles.service.ts:50`, the batch in `change` |
| `STORAGE_CONNECTION_CHANGED` | the OneDrive and Google Drive connect callbacks and disconnect handlers |
| `SECURITY_SESSION_REUSE` | `auth/auth.service.ts` `refresh`, the batch that revokes the session |
| `STORAGE_RECONNECT_REQUIRED` | storage watchdog in the worker (§5.4) |
| `BACKUP_FAILED`, `TEST_NOTIFICATION` | `cli/notify-event.ts` (§8) |
| `SCHEDULER_FAILING` | the timer catch blocks of the alert evaluator, report scheduler and timelapse jobs |
| `API_ERRORS_SPIKE` | `common/all-exceptions.filter.ts`, the 5xx branch. The filter is created with `new` in `app.setup.ts:46`, so the service is passed to its constructor there |

Line numbers are from the tree at `4215c8e`; re-check them when implementing.

Deliberately **not** events: one failed scheduler tick, one 5xx, a transient storage or provider error, a
single failed login, routine device session takeovers, and a failed notification delivery (mail about
failed mail loops; it is on the dashboard).

### Recipient rules

| Audience | Accounts, resolved in SQL when the event is recorded |
|---|---|
| Affected (`EMPLOYEE` in the schema) | `users.id = subject_user_id AND status = 'ACTIVE'` |
| `IT` | `role = 'ADMIN' AND coalesce(admin_title, 'ADMIN') = 'ADMIN' AND status = 'ACTIVE'` |
| `SUPER_ADMIN` | `role = 'ADMIN' AND admin_title = 'SUPER_ADMIN' AND status = 'ACTIVE'` |

- The address is `users.email`, copied onto the delivery row. No request, environment variable, CLI
  argument or payload ever supplies an address.
- **No universal self-notification.** Where the matrix says the actor is not mailed, the audience query
  adds `AND u.id <> actor_user_id`. Routine administrative actions never mail the person who did them.
- **Role changes** go to the affected account and to the security administrators (IT and Super Admin),
  minus the actor. Every role change crosses an admin boundary (the roles are Super Admin, Admin,
  Employee), so every one is privilege-relevant. Recipients are resolved after the change inside the same
  transaction: a newly promoted admin is the affected account and receives one message, not two.
- **Security-sensitive changes** (`STORAGE_CONNECTION_CHANGED`) go to IT and Super Admin, minus the actor.
- One person is mailed once per event (first match in the order Affected, IT, Super Admin).
- An audience with no active account at all gets one `NO_RECIPIENT` row. An audience that is empty only
  because its one member is the excluded actor gets no row and no warning.
- At send time the recipient is checked again; disabled or no longer in the audience ends as `SKIPPED`.

## 2. Database: migration `0033_notifications`

Four tables. Events and attempts are append-only; delivery state and incident state are mutable and kept
apart from them.

```sql
-- What happened. Append-only. payload: ids, counts, enum codes and dates only (validated per type before
-- insert): never free text, names, addresses, IP addresses, tokens or error messages.
CREATE TABLE notification_events (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL CHECK (length(type) BETWEEN 3 AND 64),
  severity        TEXT NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  dedupe_key      TEXT NOT NULL UNIQUE CHECK (length(dedupe_key) BETWEEN 3 AND 200),
  subject_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  actor_user_id   TEXT REFERENCES users(id) ON DELETE RESTRICT,
  incident_key    TEXT,                                             -- set for events raised by §5
  source          TEXT NOT NULL DEFAULT 'API' CHECK (source IN ('API', 'CLI')),
  payload         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload) AND length(payload) <= 2000),
  created_at      TEXT NOT NULL DEFAULT (now)
) STRICT;
CREATE INDEX notification_events_created ON notification_events(created_at);
-- + no-update and no-delete triggers (RAISE(ABORT, 'append_only')), as on account_audit.

-- One row per event and recipient: its own state, attempts and schedule.
CREATE TABLE notification_deliveries (
  id              TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL REFERENCES notification_events(id) ON DELETE RESTRICT,
  audience        TEXT NOT NULL CHECK (audience IN ('EMPLOYEE', 'IT', 'SUPER_ADMIN')),
  user_id         TEXT REFERENCES users(id) ON DELETE RESTRICT,     -- NULL only for NO_RECIPIENT
  email           TEXT,
  status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN
                  ('PENDING', 'SENDING', 'RETRYING', 'SENT', 'MOCKED', 'NOT_CONFIGURED', 'SKIPPED', 'FAILED', 'NO_RECIPIENT')),
  provider        TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 50),
  next_attempt_at TEXT,
  claimed_until   TEXT,
  last_error      TEXT CHECK (last_error IS NULL OR length(last_error) <= 300),
  message_id      TEXT,
  finished_at     TEXT,
  created_at      TEXT NOT NULL DEFAULT (now),
  updated_at      TEXT NOT NULL DEFAULT (now),
  CHECK ((user_id IS NULL) = (email IS NULL)),
  CHECK ((user_id IS NULL) = (status = 'NO_RECIPIENT')),
  CHECK ((status = 'SENDING') = (claimed_until IS NOT NULL)),
  CHECK ((status IN ('SENT', 'MOCKED', 'NOT_CONFIGURED', 'SKIPPED', 'FAILED', 'NO_RECIPIENT')) = (finished_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX notification_deliveries_recipient ON notification_deliveries(event_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX notification_deliveries_empty ON notification_deliveries(event_id, audience) WHERE user_id IS NULL;
CREATE INDEX notification_deliveries_due ON notification_deliveries(status, next_attempt_at);
-- Guard trigger: event_id, audience, user_id, email, created_at never change; a finished row changes only
-- by the manual retry (FAILED or NOT_CONFIGURED -> PENDING). No-delete trigger.

-- Every attempt and every manual retry. Append-only. report_delivery_attempts plus the acting admin.
CREATE TABLE notification_delivery_attempts (
  id            TEXT PRIMARY KEY,
  delivery_id   TEXT NOT NULL REFERENCES notification_deliveries(id) ON DELETE RESTRICT,
  attempt       INTEGER CHECK (attempt IS NULL OR attempt >= 1),
  outcome       TEXT NOT NULL CHECK (outcome IN
                ('SENT', 'MOCKED', 'NOT_CONFIGURED', 'SKIPPED', 'TRANSIENT_ERROR', 'PERMANENT_ERROR', 'INTERRUPTED', 'MANUAL_RETRY')),
  error         TEXT CHECK (error IS NULL OR length(error) <= 300),
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  created_at    TEXT NOT NULL DEFAULT (now),
  UNIQUE (delivery_id, attempt),
  CHECK ((outcome = 'MANUAL_RETRY') = (actor_user_id IS NOT NULL)),
  CHECK ((outcome = 'MANUAL_RETRY') = (attempt IS NULL))
) STRICT;
-- + no-update and no-delete triggers.

-- Persistent detection state: one row per watched condition (§5). Mutable; holds counts and times only.
CREATE TABLE notification_incidents (
  key               TEXT PRIMARY KEY CHECK (length(key) BETWEEN 3 AND 160),
  count             INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  window_started_at TEXT,          -- window counters: start of the current window
  opened_at         TEXT,          -- when the threshold was crossed; NULL = not open
  last_seen_at      TEXT NOT NULL,
  last_notified_at  TEXT,          -- kept after the incident closes: it is the repeat-suppression clock
  notifications     INTEGER NOT NULL DEFAULT 0 CHECK (notifications >= 0),
  updated_at        TEXT NOT NULL DEFAULT (now)
) STRICT;
CREATE INDEX notification_incidents_open ON notification_incidents(opened_at) WHERE opened_at IS NOT NULL;
```

`(now)` stands for the migration file's `${NOW}`. `type` has no enum CHECK (SQLite cannot alter one; the
API validates it), like `account_audit.action`. No message body is stored anywhere: it is rendered from
the payload at send time. No retention job for events, deliveries or attempts in this phase.

## 3. Transaction flow (transactional outbox)

```
 request ──► service
              │  build   outbox = notifications.statements(event)     pure; validates type and payload;
              │                                                        [] while NOTIFICATIONS_ENABLED=false
              │  commit  db.batch([ business change …, …outbox ], "write")      ONE transaction
              ▼
        committed: business rows + notification_events row + one notification_deliveries row per recipient
              ·
              ·  (no email has been attempted; the request has already returned)
              ▼
 worker tick ──► claim a delivery row ──► render ──► MailTransport.send ──► record outcome
                 (its own transactions; reads only committed rows; never touches business tables)
```

`notifications.statements(event, when?)` returns the same statement list as before, for the caller's
batch, in the style of `accountAudit`:

1. `INSERT INTO notification_events … SELECT … WHERE <when> ON CONFLICT (dedupe_key) DO NOTHING`
2. per audience: `INSERT OR IGNORE INTO notification_deliveries … SELECT … FROM users u WHERE <audience rule> [AND u.id <> :actor] AND EXISTS (SELECT 1 FROM notification_events WHERE id = :eventId)`
3. per audience: the `NO_RECIPIENT` row `WHERE EXISTS (event) AND NOT EXISTS (SELECT 1 FROM users WHERE <audience rule>)`

`when` ties the event to the business change where that change is conditional. It must name the business
row (`EXISTS (SELECT 1 FROM role_changes WHERE id = ?)`), not `changes()`: `changes()` only describes the
statement immediately before it, and the outbox is several statements long.

Rules:

- **Email is never sent inside a business transaction or a request.** The only caller of
  `MailTransport.send` for notifications is the worker.
- **The worker sees an event only after commit**, by construction: it reads through its own statements,
  and SQLite does not expose uncommitted rows.
- **Delivery cannot undo business.** Delivery runs later, in separate transactions, and writes only
  `notification_deliveries` and `notification_delivery_attempts`. A failed, refused or interrupted send
  changes a delivery row and nothing else.
- **Flag off:** `statements()` returns `[]`; the business batch is byte-for-byte today's.

### Events recorded in the business transaction

| Event | Business statement it joins |
|---|---|
| `LEAVE_DECIDED` | the `UPDATE leave_requests` in `close` (today a single `execute`; becomes a batch) |
| `LEAVE_REQUESTED` | the `INSERT INTO leave_requests` |
| `CORRECTION_DECIDED` | the approve batch (with the attendance changes), and the reject `UPDATE` |
| `CORRECTION_REQUESTED` | the `INSERT INTO correction_requests` |
| `ROLE_CHANGED` | the `UPDATE users` + `INSERT INTO role_changes` batch, `when` = that `role_changes` row exists |
| `SECURITY_SESSION_REUSE` | the session revocation + audit batch, `when` = the session was revoked by this statement |
| `INVITATION_FAILED` | the batch that marks the invitation `FAILED` and writes its audit row |
| `DESKTOP_UPDATE_FAILED` | the write of `desktop_update_status` |

### If outbox persistence fails

- **Before the transaction** (unknown type, payload failing its schema): `statements()` throws. Nothing
  has been written; the request fails with 500. This is a programming error and is caught by the
  per-producer tests, not a runtime condition.
- **Inside the transaction** (database error on an outbox statement): the whole batch rolls back,
  business change included. The caller gets an error and can repeat the action; there is never a decision
  without its notification, nor a notification without its decision. The existing guards keep working:
  an "already reviewed" trigger aborts the batch and still maps to 409.
- The outbox statements are written so that data cannot make them fail: duplicates are `DO NOTHING`,
  recipients are `INSERT OR IGNORE`, and everything the CHECKs test is validated when the statements are
  built. What remains is what would fail the business statement as well (disk, lock timeout, corruption).
- Accepted cost: a defect in the notification path can now block a business action. The mitigations are
  the build-time validation, a test per producer, and the flag (off = no outbox statements at all).

### Events recorded on their own ("standalone")

Events with no business write to join: refusals (`DEVICE_REGISTRATION_FAILED`), detections (§5), the
alerts digest (its alert ids exist only after the insert), storage connect / disconnect (the change is a
token file, not a database row), and CLI events. `notifications.record(event)` runs the same statements
as one transaction of their own and **never throws**: a failure is logged (`Notification event not
recorded`, type and key only) and the caller carries on. A crash before `record` loses that one
notification; for detections the next occurrence raises it again.

## 4. Delivery

### 4.1 State machine

```
                     claim (conditional UPDATE)
  PENDING ─────────────────────────────────────► SENDING ──► SENT            provider accepted (202)
     ▲                                             │  │ ───► MOCKED          mock provider (dev, tests)
     │ manual retry                                │  │ ───► NOT_CONFIGURED  provider "none"
     │ (FAILED, NOT_CONFIGURED)                    │  │ ───► SKIPPED         recipient no longer active / in audience
  FAILED ◄── permanent error, or attempts spent ───┘  │
                                                      ▼
  RETRYING ◄── transient error or expired lease, attempts left
     └────────────── claim when next_attempt_at is due ──────► SENDING

  NO_RECIPIENT: written final with the event; never claimed.
```

Every transition out of `SENDING` writes its attempt row in the same batch as the state change.

### 4.2 Worker

A dedicated timer in `NotificationsService`, every 30 s (not the report scheduler: 300 s, and out of
scope). Off under `NODE_ENV=test` (tests drive `deliverDue(now)`), idle while the flag is off.

1. **Stale claims:** `SENDING` with `claimed_until < now` → attempt `INTERRUPTED`, then `RETRYING` (due
   now) if attempts remain, else `FAILED`.
2. **Due rows:** `PENDING` / `RETRYING` and due, CRITICAL first, then oldest, up to the send limit (§4.4).
3. **Claim:** `UPDATE … SET status = 'SENDING', attempts = attempts + 1, claimed_until = now + 2 min WHERE id = ? AND status IN ('PENDING', 'RETRYING')`; `rowsAffected = 0` → someone else has it.
4. Re-check the recipient, check the provider, render, send, record.

Each row has its own `try/catch`, state, attempts and schedule. One recipient's failure or slowness
changes nothing for any other recipient, audience or event. Sends are sequential and bounded by the
transport's 15 s timeout.

### 4.3 Retries

- Automatic attempts: **5**. Waits after attempts 1 to 4: **1, 5, 15, 60 minutes**.
- Transient: network, timeout, 429, 5xx, expired lease, unexpected exception. Permanent (`MailError`
  with `permanent = true`: refused recipient, 401/403 after a fresh token, missing `Mail.Send`): `FAILED`
  at once.
- Manual retry: one more attempt per click.

### 4.4 Send limit

`NOTIFICATIONS_MAX_PER_MINUTE`, default **20**, validated 1 to 60. The worker sends at most half of it
per 30 s tick. **This is an application-side safety limit, chosen conservatively. It is not Microsoft's
limit and must not be presented as one.** Checking the current Microsoft documentation for Exchange Online
sending limits that apply to this mailbox's licence is a go-live step (§11). A 429 from Graph is a
transient error whatever the limit is set to. Invitations are sent in-request and are not counted here.

### 4.5 Duplicate delivery (at least once, all severities)

Delivery is at least once for every severity. A recipient can receive the same notification twice when:

1. Microsoft accepts the message (202) and the API stops before `SENT` is written. The lease expires, the
   attempt is recorded `INTERRUPTED`, and the row is sent again.
2. A send is still in flight when its lease expires (a stalled process), and a second claim sends too.
   The 2-minute lease against a 30 s worst-case send makes this unlikely, not impossible.
3. An admin retries a `FAILED` row whose message the provider had in fact accepted.

Graph `sendMail` has no idempotency key, so exactly-once is not available; the choice is between a
possible duplicate and a possible loss, and this design takes the duplicate. So that a duplicate is
recognisable, every message carries a short event reference in its footer, identical across copies, and
the attempt history shows the `INTERRUPTED` row. Reports keep their own, opposite rule.

## 5. Persistent incident detection

All detection state lives in `notification_incidents`. Nothing is counted in process memory, so a restart
resets nothing.

### 5.1 Counters

| Incident key | Kind | Threshold | Closes when | Event |
|---|---|---|---|---|
| `scheduler:<job>` | consecutive failures | 3 | the job's next successful tick | `SCHEDULER_FAILING` |
| `retention:<job>` | consecutive failures | 1 | next success | `RETENTION_FAILED` |
| `http5xx` | fixed window, 5 min | 20 | a full window below the threshold | `API_ERRORS_SPIKE` |
| `storage` | consecutive failed checks (5 min apart) | 2; 1 for a "reconnect required" result | next good check | `STORAGE_RECONNECT_REQUIRED` |
| `backup` | occurrence (CLI) | 1 | 26 h without another failure | `BACKUP_FAILED` |
| `device:<userId>:<cause>` | occurrence | 1 | 24 h quiet | `DEVICE_REGISTRATION_FAILED` |
| `login:*` | fixed window, 15 min | §6 | a full window below the threshold | `SECURITY_LOGIN_SUSPICIOUS` |

One occurrence is one transaction:

```
1. UPSERT notification_incidents            count + 1 (window counters: restart the window when it has expired),
                                            last_seen_at = now
2. outbox statements for the event, WHEN    count >= threshold
                                            AND (last_notified_at IS NULL OR last_notified_at <= now - repeat interval)
3. UPDATE notification_incidents            opened_at = coalesce(opened_at, now), last_notified_at = now,
                                            notifications = notifications + 1
                                            WHERE the event of step 2 was inserted
```

SQLite runs write transactions one at a time, so two occurrences crossing the threshold together produce
one event: the second sees `last_notified_at` already set. The event's dedupe key
(`<TYPE>:<incident key>:<minute>`) is a second guard.

A success resets `count` and `opened_at` and keeps `last_notified_at`. Healthy jobs do not write on every
tick: each remembers in memory that it has nothing to reset, and after a restart performs one reset write.
That flag only saves writes; no detection decision depends on it.

### 5.2 Repeats and suppression

One rule per severity, measured from `last_notified_at` of that incident key:

| Severity | Minimum time between two notifications for the same key |
|---|---|
| CRITICAL | 6 hours |
| WARNING | 24 hours |

The first crossing notifies at once. While the condition persists it notifies again each interval. A
condition that clears and returns inside the interval is suppressed until the interval has passed (there
are no "resolved" emails, so to the recipient it is the same alarm); the dashboard shows it immediately.
A flapping job therefore produces at most 4 critical emails a day per key, never a flood. Exact intervals
replace the earlier time-bucket keys, which could fire twice across a bucket boundary.

### 5.3 Housekeeping

Each worker tick closes incidents whose close condition is met by time (`backup`, `device:*`, window
counters) and deletes closed rows whose `last_notified_at` is older than 7 days.

### 5.4 Storage watchdog and dashboard visibility

Every 10th tick the worker runs `OneDriveService.check()` when OneDrive is the configured storage, and
feeds the `storage` incident. `OneDriveService` cannot record anything itself (it has no database and the
mail transport depends on it).

The mail token is the OneDrive connection. When OneDrive is disconnected the `STORAGE_RECONNECT_REQUIRED`
email cannot be sent. It does not need to be, to be seen:

- the incident row is open, and `GET /notifications` returns open incidents separately from deliveries;
- the dashboard shows an "Open incidents" panel at the top of the page, from incident state alone, with
  no dependency on any delivery succeeding;
- the event and its `FAILED` deliveries are in the list, retryable after the reconnect.

How `check()`'s result maps to "reconnect required" is to be confirmed against the code when implementing.

## 6. Login security aggregation

No email is ever sent for an individual failed login, and none is sent synchronously from a login request.

### 6.1 What is counted

In `AuthService.login`, on every refused attempt (wrong credentials, and attempts refused by the existing
in-memory throttles), one batch upserts three counters, each a 15-minute window:

| Counter key | Counts | Threshold |
|---|---|---|
| `login:account:<userId>` (an existing account) or `login:unknown` (any other email) | refused attempts for that account | 10 (the existing per-email lockout level) |
| `login:ip:<hash>` | refused attempts from one address | 50 |
| `login:global` | all refused attempts | 200 |

A successful login resets nothing: correct guesses by an attacker, or the owner signing in meanwhile, must
not hide the pattern.

### 6.2 One aggregated warning

Whichever counter crosses first, the result is a single event type, `SECURITY_LOGIN_SUSPICIOUS`, WARNING,
to **IT only**. Its payload is counts: accounts over threshold, addresses over threshold, total refused
attempts in the window. The email says which accounts by looking the ids up at send time.

### 6.3 Cooldown and flood protection

- **Organisation-wide cooldown of 4 hours** for this type, independent of which counter fired: the
  notify condition reads one shared row (`login:notify`). An attacker rotating accounts, addresses or
  both cannot produce more than one email per IT recipient per 4 hours (6 a day). During the cooldown the
  counters keep counting and the dashboard shows the open incidents live.
- **No state per unknown email.** Unknown addresses share one counter, so submitting random emails cannot
  create rows.
- **Bounded address rows.** At most 1,000 `login:ip:*` rows; beyond that an attempt counts only towards
  `login:global`. Rows close after one quiet window and are deleted by housekeeping.
- **The affected employee is not emailed.** Anyone can trigger failed logins for any address; mailing the
  target would hand an attacker a way to mail employees at will. A confirmed compromise signal
  (`SECURITY_SESSION_REUSE`) does go to the employee.
- **No account enumeration.** The same number of statements runs for a known and an unknown email (the
  account counter or `login:unknown`), next to the existing dummy-hash verification, and the response is
  unchanged.
- **No IP address in a payload, an email or this table in clear.** The address is stored as a keyed hash
  (HMAC with the API's secret), enough to count, useless to read.
- One small write per refused login. It costs far less than the password hash verification that precedes
  it, and the existing per-IP throttle bounds it per address.

## 7. RBAC, API, dashboard

`packages/shared/src/roles.ts`: `notifications:read` and `notifications:manage`, both `["ADMIN"]`, neither
in `SUPER_ADMIN_ONLY` nor in `TEAM_HEAD_PERMISSIONS`. IT Admin and Super Admin hold both; employees and
team heads get 403 on every route. Enforcement is the global `AuthGuard`; `route-permissions.test.ts`
fails the build for a route without a permission.

**`GET /api/v1/notifications`** (`notifications:read`). Query: `from`, `to` (default last 7 days, max 92),
`timeZone`, `severity?`, `type?`, `status?` (`OPEN`, `FAILED`, `DELIVERED`), `page`, `pageSize` (max 200).
Response: `enabled`, `provider`, `delivers`, `maxPerMinute`; `incidents` (open: key label, event type,
severity, since, count, last notified); paged `items`, each with type, severity, source, time, affected
account, actor, a rendered one-line summary, overall status, and its deliveries with recipient, audience,
status, last error, next attempt and attempt history. The raw payload is not returned.

**`POST /api/v1/notifications/deliveries/:id/retry`** (`notifications:manage`). No body. `FAILED` or
`NOT_CONFIGURED` → `PENDING`, plus a `MANUAL_RETRY` history row with the acting admin, in one batch
guarded by the current status. 404 unknown; 409 any other status, a concurrent retry, or notifications
disabled; 429 over 30 retries per admin per 15 minutes. The history row is the audit record and appears
in the unified audit view through a new `NOTIFICATION` source (read from its table, nothing copied).

**Dashboard** `apps/dashboard/src/app/(admin)/notifications/page.tsx`, nav "Notifications" after "Alerts":

- "Open incidents" panel first, from incident state (§5.4).
- Banner when disabled or when the provider does not deliver.
- Filters: period, severity, status. Event rows expand to deliveries and attempt history.
- "Retry" only on `FAILED` / `NOT_CONFIGURED`. `NO_RECIPIENT` shown as a warning on the event.
- No free-text input. Not reachable from the employee area.

## 8. Events from outside the API process

`apps/api/src/cli/notify-event.ts`:
`node --env-file=/etc/workfolio/api.env dist/cli/notify-event.js record <BACKUP_FAILED|TEST_NOTIFICATION>`.
A fixed allow-list of types, no free text, no address. It opens the database from the same environment
and runs the same transaction as the API (`source = 'CLI'`; for `BACKUP_FAILED`, through the `backup`
incident). It sends nothing: the API worker delivers.

`deploy/systemd/workfolio-notify@.service` (oneshot, same hardening as the backup unit) and an
`OnFailure=workfolio-notify@BACKUP_FAILED.service` line for `workfolio-backup.service` are implementation
deliverables **as files in the repository only. They are not installed or enabled in production** as
part of Phase 2; that is a separate, approved go-live step.

## 9. Templates and payload safety

`templates.ts`: one pure function per type returning `MailMessage`, in the invitation email's HTML shell,
every value escaped. Names are looked up from ids at send time. Subjects carry the severity for WARNING
and CRITICAL. A message says what happened, when, and links to the relevant dashboard page; it carries no
leave reason, correction text, screenshot, device name, IP address or raw error text. Critical messages
name a component, a fixed code and a fixed next step. Each message ends with the short event reference.

Payloads pass a strict per-type schema (ids, counts, enum codes, dates) and the audit deny-list of key
names. Free text cannot enter a payload, so it cannot enter an email or the dashboard through one.
`last_error` holds `MailError` messages only (HTTP status and Microsoft's error code), cut to 300
characters. Logs carry ids, types, statuses and counts.

## 10. Failure modes and the monitoring dependency

| Situation | Behaviour |
|---|---|
| `NOTIFICATIONS_ENABLED=false` (default) | No outbox statements, no standalone records, no incident counting, no worker. Nothing accumulates to burst out later. |
| Provider `none` with the flag on | Rows end `NOT_CONFIGURED`, retryable once a provider is set. |
| Mail path down (OneDrive disconnected, `Mail.Send` missing) | Sends fail permanently, rows `FAILED`, open incident on the dashboard (§5.4). No notification about failed notifications. |
| Outbox statement fails | The business transaction rolls back with it (§3). |
| Standalone record fails | Logged, dropped, caller unaffected. |
| **Database down** | Nothing can be recorded or counted. **Notifications cannot report this.** |
| **API down** | Nothing runs. CLI-recorded rows wait for it. **Notifications cannot report this.** |
| **Backup never started** (timer dead) | No failure occurs, so `OnFailure=` never fires. **Notifications cannot report this.** |
| API restart mid-send | Lease expiry, `INTERRUPTED`, resend (§4.5). Incident counters are in the database and continue. |
| Two writers (API and CLI, or two instances) | Conditional claim: one sender per row. Serialised write transactions: one event per threshold crossing. |
| One audience fails | Independent rows: the other audience is untouched. |

The three bold rows are covered **only** by `deploy/scripts/monitor.sh` (every 5 minutes on the VPS: API
`/health` and `/ready`, backup age and last backup result, storage failures in the journal; Teams and ntfy
channels) and by an external uptime check, which `monitor.sh` itself asks for because it dies with the
VPS. Phase 2 depends on them and does not replace them. Whether the Teams and ntfy channels are actually
configured in production has not been verified; it is a go-live item (§11).

Module cycles: none. Everything is in the single `AppModule`. `NotificationsService` depends on the
database, configuration, `INVITATION_TRANSPORT` and `OneDriveService`; producers depend on
`NotificationsService`; nothing it depends on is a producer.

## 11. Production verification checklist (go-live, each step separately approved)

Before enabling:

1. Phase 1 rollout order followed (docs/invitations.md §4): tolerant build deployed, then delegated
   `Mail.Send` granted, then OneDrive reconnected.
2. **Monitor channels verified in production:** `ALERT_TEAMS_WEBHOOK_URL` and `ALERT_NTFY_URL` are set in
   `monitor.env`; `monitor.sh --test-alert all` arrives in Teams and on ntfy; `workfolio-monitor.timer` is
   active; an external uptime check on `/api/v1/health` exists.
3. **Microsoft sending limits checked** against the current Microsoft documentation for the IT mailbox's
   licence (messages per minute, recipients per day); `NOTIFICATIONS_MAX_PER_MINUTE` set at or below what
   that allows. The default of 20 is this application's own caution, not a Microsoft figure.
4. At least one active IT Admin and one active Super Admin account, each with a mailbox that receives
   mail from `IT@TFFDigital.com` outside the junk folder.
5. Database backed up and the backup verified; migration 0033 applied; schema version confirmed.
6. Full test suite green on the exact build, with the flag off and on.

Enabling:

7. `NOTIFICATIONS_ENABLED=true`; restart; `/ready` green; the notifications page loads for an IT Admin and
   for a Super Admin, and returns 403 for an employee.
8. `notify-event.js record TEST_NOTIFICATION`: one message each to IT and Super Admin; the page shows
   `SENT` with one attempt per recipient.
9. One real low-risk business event (a test leave decision): the employee is mailed, the reviewer is not.

After enabling:

10. `workfolio-notify@.service` and the `OnFailure=` line installed (separate approval); announced
    beforehand, then one deliberate `systemctl start workfolio-notify@BACKUP_FAILED` to prove the path.
11. The OneDrive-disconnected case is rehearsed outside production only; in production, confirm the "Open
    incidents" panel renders.
12. First week: review `FAILED` and `NO_RECIPIENT` rows and the volume per recipient daily.

Rollback: `NOTIFICATIONS_ENABLED=false` and restart. Recording, counting and sending stop; tables and
history stay; business behaviour returns to exactly today's.

## 12. Test plan

Database (`packages/database/src/notifications.test.ts`): every CHECK, both partial unique indexes, the
append-only triggers, the delivery guard, the incident table.

API (`apps/api/test/notifications.e2e.test.ts`, mock transport, `deliverDue(now)` by hand):

**Catalogue and recipients**
- Every type has severity, audiences, actor rule, payload schema and template. Every CRITICAL type
  includes IT and Super Admin and never excludes the actor.
- The matrix row by row. Actor exclusion: an admin who requests leave is not mailed as IT; a sole IT admin
  as actor yields no IT row and no `NO_RECIPIENT`; no active Super Admin yields `NO_RECIPIENT` while IT
  still sends.
- Role change: affected + IT + Super Admin, minus the actor; a newly promoted admin gets exactly one.

**Outbox**
- Leave decision, correction approve / reject, role change, session reuse: after the request, the business
  rows, the event and the delivery rows are all present, and the mock outbox is **empty** until
  `deliverDue` runs.
- The business statement fails (already-reviewed trigger, last-Super-Admin guard): no event, no delivery.
- An outbox statement fails (a trigger planted on `notification_events` in the test database): the
  business change is rolled back, the API answers 500, and after the fault is removed the same action
  succeeds with exactly one event.
- Invalid payload: `statements()` throws before any write.
- Delivery fails permanently, then transiently for all attempts: business rows unchanged throughout.
- Flag off: the batch contains no notification statement; no rows.
- Standalone `record` with a failing database call: the caller does not throw.

**Delivery**
- Independent recipients: one fails permanently, one transiently, one succeeds, in one event.
- Retry schedule 1, 5, 15, 60; `FAILED` after 5; permanent fails at once; an attempt row per attempt.
- Stale claim: `INTERRUPTED`, resend, the message is delivered twice and both copies carry the same event
  reference. Concurrent `deliverDue` calls send each row once.
- `SKIPPED` after the recipient was disabled or changed identity.
- Send limit: 50 due rows at 20 per minute → 10 per tick, CRITICAL first; the variable's bounds.

**Persistent detection**
- Scheduler: two failures, **a new service instance over the same database**, a third failure → one
  event. A success resets.
- 5xx window: a count survives a restart; a new window starts after 5 minutes.
- Repeats: CRITICAL ongoing → nothing at 5 h 59, one at 6 h; WARNING at 24 h. Clear and return inside the
  interval → suppressed. Flapping for a simulated day → at most 4.
- Two occurrences crossing the threshold concurrently → one event.
- Housekeeping closes and deletes as specified.

**Login aggregation**
- 9 refused logins: nothing. The 10th: one event, IT only, the targeted account not mailed.
- 1,000 further refusals across many accounts and addresses inside the cooldown: no further event. After
  4 hours with activity continuing: exactly one more.
- 5,000 distinct unknown emails: no per-email rows. Address rows never exceed the cap.
- Known and unknown emails run the same number of statements and get the same response.
- A successful login sends nothing and resets nothing. No IP address appears in any row in clear.

**Visibility with mail down**
- Transport fails every send with the token error: the storage incident is in `incidents`, the event is
  listed with `FAILED` deliveries, no event is raised about the failed deliveries, and a manual retry
  after the transport recovers ends `SENT`.

**Endpoints**
- 401 without a session; 403 for an employee and for a team head; 200 for IT Admin and Super Admin.
- Filters and paging; no raw payload and no body in the response.
- Manual retry: the transitions, the history row and its actor, the audit view entry, each 409, the 429.

Also: `route-permissions.test.ts`, `env.test.ts` (flag default false, limit default 20 and bounds), a CLI
test (allow-list, refusal of unknown types and extra arguments), a syntax check of the unit file where
`systemd-analyze` is available, one producer test in each affected feature suite, and the existing
invitation, report, alert and OneDrive suites unchanged and passing.

## 13. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `NOTIFICATIONS_ENABLED` | `false` | Outbox, standalone records, incident counting and the worker. |
| `NOTIFICATIONS_MAX_PER_MINUTE` | `20` | Application-side safety limit on notification sends (§4.4). |
| `INVITATION_MAIL_PROVIDER` | (existing) | The transport notifications use. |

No new secret, Entra permission or OneDrive reconnect beyond Phase 1's.

## 14. Differences from the implementation found in the working tree

From its own `docs/notifications.md` and a short read of the code; not a full review.

| This design | Found in the working tree |
|---|---|
| `NOTIFICATIONS_ENABLED`, default off | No flag ("No new variable") |
| Events in the business transaction (outbox) | `emit` after the business commit |
| `notifications:read` / `notifications:manage` | `settings:manage` |
| `NO_RECIPIENT` status | An empty group is a `FAILED` row |
| Per-attempt history table; manual retry audited | No attempts table |
| Payload of ids and codes; no free text | A free-text `description` (up to 500 characters, sanitised) |
| Events append-only, kept | Events and deliveries deleted after 365 days |
| 5 attempts: 1, 5, 15, 60 min; 30 s tick | 4 attempts: 1, 5, 30 min; 60 s tick |
| Session-token reuse → affected, IT and Super Admin | → affected and IT |
| Persistent incident counters, repeat intervals | None found |
| Aggregated login warning | None |
| Leave, correction, role, alert and scheduler events | Not present; it has account activation, password changed, a weekly onboarding summary and screenshot failures instead |
| Configurable send limit | None found |

Its `0033_notifications` migration has a different schema under the same id. The migration runner refuses
to start when an applied migration's statements change (checksum), so that migration must not be applied
to any database that matters before the schema is settled.
