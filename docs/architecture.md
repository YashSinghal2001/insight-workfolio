# Architecture

```
 ┌──────────────────────┐        HTTPS / JSON         ┌───────────────────────┐
 │  Desktop (Tauri 2)   │ ──────────────────────────▶ │                       │
 │  Rust core + TS UI   │                             │   API (NestJS)        │      libSQL       ┌──────────────┐
 │  local SQLite queue* │                             │   /api/v1/*           │ ────────────────▶ │ Turso        │
 └──────────────────────┘                             │   auth*, RBAC*,       │                   │ (SQLite)     │
 ┌──────────────────────┐        HTTPS / JSON         │   validation, logs    │                   └──────────────┘
 │ Dashboard (Next.js)  │ ──────────────────────────▶ │                       │   Microsoft Graph ┌──────────────┐
 │ admin UI             │                             │                       │ ────────────────▶ │ OneDrive /   │
 └──────────────────────┘                             └───────────────────────┘   (screenshots*)  │ SharePoint   │
                                                                                                  └──────────────┘
 * = planned, not implemented yet
```

## Responsibilities

**API (`apps/api`)** — the single trust boundary. Owns database access, authentication,
role-based authorization, input validation, screenshot upload brokering (Graph credentials
stay server-side), and audit logging. Clients never hold database or Graph credentials.

**Dashboard (`apps/dashboard`)** — admin-only web UI. Reads/writes exclusively via the API
using HttpOnly session cookies; page code never sees a token. Pages are static shells
(Next.js Cache Components) that fetch on the client. Employees who sign in get an
access-denied screen. Only `NEXT_PUBLIC_API_URL` is configured client-side.

**Desktop (`apps/desktop`)** — employee client. Sign-in, identity, visible tracking status,
and (later) clock in/out, activity sampling and screenshots with an offline SQLite queue that
syncs to the API. The refresh token is kept in the OS credential store via Rust commands
(`save/load/clear_refresh_token`); the access token lives only in memory.
The Rust side is the source of truth for whether tracking is enabled (`app_info` command);
Tauri capabilities grant only `core:default`.

**`packages/shared`** — types, the `ADMIN`/`EMPLOYEE` role model, the permission map and zod
schemas. Pure TypeScript with no runtime secrets; `sideEffects: false` so clients tree-shake it.

**`packages/database`** — `createDatabase()`, `pingDatabase()` and `migrate()` over `@libsql/client`.
Uses a local `file:` SQLite DB in development and Turso (`libsql://` + auth token) in
production. Imported only by the API.

## Database schema

All tables are SQLite `STRICT`. Timestamps are UTC ISO-8601 strings with milliseconds
(`2026-10-12T08:35:46.806Z`, same as `Date#toISOString()`), so string comparison is
chronological. Clients convert to the employee's IANA `timezone` for display.

| Table | Key columns and constraints |
| --- | --- |
| `users` | `id` PK · `email` UNIQUE, CHECK lowercase/trimmed · `password_hash` (Argon2id PHC, NULL until setup) · `role` CHECK ADMIN/EMPLOYEE · `status` CHECK ACTIVE/DISABLED · `created_at`, `updated_at` |
| `employee_profiles` | `id` PK · `user_id` UNIQUE FK→users · `employee_code` UNIQUE, CHECK uppercase · `full_name` · `timezone` DEFAULT `Asia/Kolkata` · `employment_status` CHECK ACTIVE/ON_LEAVE/TERMINATED · timestamps |
| `devices` | `id` PK · `employee_id` FK→employee_profiles · `device_name` · `platform` CHECK windows/macos · `device_identifier` (SHA-256 of the app's random installation UUID; no hardware IDs) · `registered_at`, `last_seen_at`, `revoked_at` · UNIQUE(`employee_id`, `device_identifier`) · partial UNIQUE(`employee_id`) WHERE not revoked (one active device) |
| `sessions` | `id` PK · `user_id` FK→users (indexed) · `refresh_token_hash` UNIQUE (SHA-256) · `expires_at` · `revoked_at` · `created_at` |
| `account_setup_tokens` | `id` PK · `user_id` FK→users (indexed) · `token_hash` UNIQUE (SHA-256) · `expires_at` · `used_at` · `created_at` |
| `attendance_sessions` | `id` PK · `employee_id` FK · `device_id` FK · `clock_in_at` · `clock_out_at` · `status` OPEN/CLOSED (CHECK consistent with `clock_out_at`) · timestamps · partial UNIQUE(`employee_id`) WHERE open · index (`employee_id`, `clock_in_at`) |
| `break_sessions` | `id` PK · `attendance_session_id` FK · `started_at` · `ended_at` · `status` OPEN/CLOSED · timestamps · partial UNIQUE(session) WHERE open |
| `attendance_events` | `id` PK · `employee_id` FK · `device_id` FK · `event_type` · `occurred_at` (effective UTC) · `device_time` (raw device clock) · `received_at` · `idempotency_key` · `source` ONLINE/OFFLINE_SYNC · `outcome` ACCEPTED/REJECTED + `reject_reason` · UNIQUE(`employee_id`, `idempotency_key`) · **append-only** |
| `attendance_corrections` | One row per **applied** correction: `attendance_session_id` FK · `requested_by` · `approved_by` (≠ requester) · `original_values`/`corrected_values` (JSON before/after) · `reason` · `request_id` FK (0003) · **append-only** |
| `monitoring_consents` (0004) | `employee_id` FK · `notice_version` · `acknowledged_at` · UNIQUE(employee, version) · append-only |
| `activity_intervals` (0004) | `employee_id`/`device_id`/`attendance_session_id` FK · `kind` ACTIVE/IDLE · `application_identifier`, `application_name` (ACTIVE only) · `started_at`/`ended_at` (UTC, skew-corrected) · `active_seconds`/`idle_seconds` · `source` DESKTOP_MACOS/DESKTOP_WINDOWS · `device_started_at` (raw) · `received_at` · `idempotency_key` UNIQUE per employee · no overlaps per employee (trigger) · no updates |
| `correction_requests` (0003) | `id` PK · `employee_id` FK · `requested_by` FK · `type` MISSING_CLOCK_IN/MISSING_CLOCK_OUT/BREAK_TIME/ATTENDANCE_TIME · `attendance_session_id`/`break_session_id` FK · `proposed` (JSON) · `reason` · `status` PENDING/APPROVED/REJECTED · `reviewed_by` (≠ requester) · `reviewed_at` · `review_reason` (required once reviewed) · reviewed **once** (trigger), never deleted |
| `schema_migrations` | `id` PK · `applied_at` |

**Attendance guards in the schema** (migration `0002`, triggers raise named errors):
sessions of one employee never overlap and at most one is open; breaks start inside an open
session after clock-in and never overlap; clock-out requires every break to have ended;
closed sessions/breaks and clock-in times are immutable; events and corrections cannot be
updated or deleted. **Since 0003** the only exception is an approved correction: a closed
session/break (or a clock-in) may change only in the statement that sets its `correction_id`
to a *new* `attendance_corrections` row for that session with `approved_by` set. One audit row
authorizes one change, and updated times must still satisfy the overlap/containment triggers. The API checks the same rules first for friendly errors; the triggers
are the backstop against races and bugs.

Foreign keys use `ON DELETE RESTRICT`; nothing is hard-deleted in the MVP (accounts are
disabled). **Migrations** live in `packages/database/src/migrations.ts` as an append-only
list. `migrate()` applies each pending migration and its bookkeeping row in one
transaction, so a re-run is a no-op and a concurrent runner rolls back. The API runs it at
boot, and so does the bootstrap CLI. Migrations must stay additive; destructive changes need
explicit approval and a backup.

## Authentication

Email/password with server-side sessions plus short-lived signed access tokens.

| Credential | Format | Lifetime | Stored server-side as |
| --- | --- | --- | --- |
| Password | user-chosen, 12–128 chars | — | Argon2id (m=19 MiB, t=2, p=1), PHC string |
| Access token | JWT HS256 (`sub`, `sid`, `iss`, `aud`) | 15 min | not stored |
| Refresh token | `<sessionId>.<256-bit random>` | 30 days absolute | SHA-256 in `sessions` |
| Setup token | 256-bit random | 72 h, single use | SHA-256 in `account_setup_tokens` |

Every authenticated request verifies the JWT **and** looks up its session and user, so logout,
disabling an account, and token-reuse revocation take effect immediately rather than when
the access token expires. The role is read from the database, never from the token.

**Transports**

- **Dashboard (`client: "web"`):** tokens are only ever in cookies.
  `wf_access` (Path `/api`, 15 min) and `wf_refresh` (Path `/api/v1/auth`, 30 days), both
  `HttpOnly`, `SameSite=Strict`, and `Secure` in production. The dashboard and API must share
  a site (e.g. `app.example.com` and `api.example.com`).
- **Desktop (`client: "desktop"`):** tokens are returned in the JSON body. The app keeps the
  access token in memory and the refresh token in macOS Keychain / Windows Credential
  Manager, never in `localStorage` or files. It sends `Authorization: Bearer …`.

**Session lifecycle**

```
setup link ─▶ POST /auth/setup-password ─▶ password set (all sessions revoked, all setup links consumed)
POST /auth/login ─▶ session row + access token (15 min) + refresh token
     │ access token expires
     ▼
POST /auth/refresh ─▶ compare-and-swap the refresh hash ─▶ new access + new refresh token
     │                    old refresh token presented again? ─▶ session revoked (theft signal)
     ▼
POST /auth/logout ─▶ session revoked, cookies cleared
admin disables account ─▶ all sessions revoked; login/refresh/requests rejected
session reaches 30 days ─▶ refresh rejected; sign in again
```

**Account creation** never involves a password chosen or seen by an admin. Creating an
employee (or running the bootstrap CLI) creates the user with `password_hash = NULL` and
issues a one-time setup token. The link carries it in the URL **fragment**
(`/setup-password#token=…`), which browsers never send to servers, so it can't reach access
logs. The setup page removes it from the address bar as soon as it loads.

## Authorization (RBAC)

A global `AuthGuard` (APP_GUARD) runs on every route:

1. **CSRF origin check:** a non-GET request without a bearer token must carry an `Origin` in
   `CORS_ORIGINS`, otherwise 403. This sits on top of `SameSite=Strict`.
2. **Deny by default:** routes require a valid session unless marked `@Public()`
   (health, ready, login, refresh, logout, setup-password).
3. **Role check:** `@RequirePermission(p)` resolves via `hasPermission(role, p)` from
   `packages/shared/src/roles.ts`, otherwise 403.
4. **Ownership** is checked in the service. `GET /employees/:id` and `/:id/devices` serve
   admins any record and employees only their own. Anything else returns **404**, the same
   as a missing ID, so guessing IDs reveals nothing. IDs are random UUIDv4 and validated
   (400 otherwise).

| Endpoint | ADMIN | EMPLOYEE |
| --- | --- | --- |
| `POST /auth/login`, `/refresh`, `/logout`, `/setup-password` | public | public |
| `GET /auth/me` | ✓ | ✓ (own) |
| `GET /employees` (paginated, `?q=` search, `page`, `pageSize` ≤ 100) | ✓ | 403 |
| `POST /employees` | ✓ | 403 |
| `GET /employees/:id`, `GET /employees/:id/devices` | ✓ | own only, else 404 |
| `PATCH /employees/:id` | ✓ | 403 |
| `PATCH /employees/:id/status` (ACTIVE/DISABLED; disabling revokes sessions) | ✓ (not self) | 403 |
| `POST /employees/:id/setup-token` (new one-time link) | ✓ | 403 |
| `POST /devices/register` (installation UUID, name, platform) | own profile only | own |
| `GET /devices/me` (status of the calling installation) | own | own |
| `POST /devices/:id/revoke` | ✓ | 403 |
| `POST /attendance/clock-in`, `/clock-out`, `/break/start`, `/break/end` | own | own |
| `POST /attendance/sync` (offline queue upload, ≤ 100 events) | own | own |
| `GET /attendance/current` | own | own |
| `GET /attendance/history` (`page`, `pageSize`, `from`, `to`, `employeeId`) | any (`employeeId`) | own (other IDs → 404) |
| `GET /attendance/timesheet` (`from`, `to` ≤ 92 days, `employeeId`) | any (`employeeId`) | own (other IDs → 404) |
| `GET /attendance/timesheets` (`from`, `to`, `q`, paginated: totals per employee) | ✓ | 403 |
| `GET /attendance/overview` (paginated, `?q=`) | ✓ | 403 |
| `POST /attendance/corrections` | own | own |
| `GET /attendance/corrections` (`status`, `employeeId`, paginated), `GET /attendance/corrections/:id` | all | own (others → 404) |
| `POST /attendance/corrections/:id/approve`, `/reject` (`{reason}` required) | ✓, not own requests | 403 |
| `POST /activity/consent` (`{noticeVersion}`) | own | own |
| `POST /activity/sync` (active device, consent, ≤ 500 intervals) | own | own |
| `GET /activity/me` (policy, consent, today/session totals) | own | own |
| `GET /activity/summary`, `GET /activity/timeline` (`from`, `to` ≤ 31 days, `employeeId`, paginated timeline) | any (`employeeId`) | own (other IDs → 404) |

Attendance writes never take an employee ID: the employee comes from the session. Reads
default to the caller; `employeeId` is honoured for admins and otherwise only for the
caller's own ID. Admin accounts without an employee profile must pass `employeeId`.

There is no DELETE endpoint; accounts are disabled, not removed.

## Attendance

**State machine** (`packages/shared/src/attendance.ts`, used by the API and the desktop
preview): `CLOCKED_OUT → CLOCKED_IN → ON_BREAK → CLOCKED_IN → CLOCKED_OUT`. Anything else is
rejected (409 online, `REJECTED` in sync). Clock-out while on break is rejected ("End your
break before clocking out"); breaks are never auto-closed.

**Device validation.** Every write carries `X-Device-Id`: the app's random installation
UUID, generated once and kept in the OS credential store. The API looks up
`sha256(id)` among the caller's devices, rejects unknown or revoked ones (403), and updates
`last_seen_at` in the same statement. One active device per employee; a revoked
installation cannot re-register (an admin revokes, the employee registers a new install).

**Idempotency.** Direct endpoints require an `Idempotency-Key` UUID header; sync events use
their client UUID. Every attempt is stored in `attendance_events` with its outcome, so a
retry returns the original result (`DUPLICATE` for accepted, the same reason for rejected)
and never applies twice. Reusing a key for a different action is rejected. Writes for one
employee are serialized in-process; the schema triggers and partial unique indexes turn any
remaining race (e.g. several API instances) into a 409, never a double session.

**Timestamps.** Online (direct endpoints): server time. Sync uploads: the device sends each
event's device time plus `sentAt` (device clock at upload); the server estimates the skew as
`receivedAt - sentAt` and stores `occurredAt = deviceTime + skew` (capped at `receivedAt`),
keeping the raw `device_time`. Events uploaded more than 60 s after they happened are
labelled `OFFLINE_SYNC`. Rejected: device time after `sentAt` (+5 s tolerance), older than
7 days, or earlier than the employee's last recorded change (no back-dating over existing
records; conflicts are never overwritten). The skew estimate assumes the device clock was
not changed between the event and the upload.

**Calculations** (`attendanceTotals`): elapsed = clock-in to clock-out (or now), breaks =
sum of break intervals (clamped to the session), net = elapsed - breaks. They are
differences of UTC instants, so midnight-crossing and DST shifts are correct; time zones
are used for display only. A session belongs to the local date of its clock-in. No fixed
shift is assumed.

**Desktop offline queue.** Each button press is first written to SQLite
(`attendance-queue.db` in the app data directory, WAL + `synchronous=FULL`), then uploaded
FIFO in one ordered batch to `/attendance/sync`. Accepted/duplicate events are removed;
rejected ones stay visible with the server's reason until dismissed. Failures retry with
exponential backoff (2 s doubling to 5 min) and immediately when the API becomes reachable
again. 401/403 stop retries (signed out / device revoked). The queue is scoped to employee
+ registered device and survives sign-out, restarts and crashes. Tokens are never stored in
it. Without connectivity the app starts in offline mode from the cached identity and last
server snapshot, and shows pending changes as a device-clock preview.

## Attendance policy (configurable MVP defaults)

These are product defaults for the pilot, **not legal or payroll rules**; confirm them with
HR before relying on them. Configurable values come from the API environment and are returned
with every timesheet, so clients never assume their own.

| Policy | Default | Where |
| --- | --- | --- |
| Workweek start | Monday | `WORKWEEK_START_DAY` (1 = Mon … 7 = Sun) |
| Scheduled work per worked day | 8 h | `SCHEDULED_HOURS_PER_DAY` |
| Offline events accepted up to | 7 days old | `OFFLINE_MAX_AGE_DAYS`; older ones need a correction |
| Active devices per employee | 1 | schema (partial unique index) |
| Break must end before clock-out | yes, never auto-closed | state machine + schema |
| Midnight-crossing shift belongs to | its clock-in local date | timesheet engine |
| Overtime | net time beyond the scheduled day, **reported only**, never applied to payroll | timesheet engine |
| Forgotten clock-out | stays open and flagged "incomplete" until a correction is approved; never auto-closed | — |

## Timesheets

`buildTimesheet` (`packages/shared/src/timesheet.ts`, used by API and clients) groups
sessions by the **local date of clock-in** in the employee's time zone and reports per day:
first clock-in, last clock-out, gross (elapsed), breaks, net, overtime, shift count, and flags
for *incomplete* (an open shift), *corrected* and *offline-synced* shifts. **Only completed
shifts count**; an open shift is reported separately as live "in progress" time. Weekly
totals sum the days of each workweek. Durations are UTC differences, so DST and midnight are
exact; days without shifts are omitted (no fixed schedule is assumed). Overtime is computed
per worked day and summed for the week. Pending offline events are not on the server, so
the desktop states how many local events are not yet included.

## Corrections

1. The employee submits a request for their own attendance (`MISSING_CLOCK_IN`: a whole
   missing shift; `MISSING_CLOCK_OUT`: closes an open shift, and its open break if any;
   `BREAK_TIME`; `ATTENDANCE_TIME`: clock-in and/or clock-out). Times are UTC; clients enter
   them in the employee's zone. The request is validated against current records (no future
   times, no overlaps, breaks inside the shift) but **changes nothing**.
2. An admin who is not the requester approves or rejects it, with a reason. Approval
   re-validates against the *current* records (they may have changed), then in one
   transaction: marks the request approved (a trigger aborts if it was already reviewed),
   inserts the `attendance_corrections` audit row with exact before/after values, and
   applies the change linked to that row. Rejection only records the decision.
3. Timesheets are computed on request, so they reflect approved corrections immediately.
   The `attendance_events` log is never modified: it keeps what devices sent, while
   corrections keep what was changed, by whom, when and why. Missing shifts are attributed to
   the employee's most recently registered device.

## Activity monitoring

Desktop: a single Rust worker thread (`src-tauri/src/collector.rs`) samples while the UI sets
mode `ACTIVE`; the pure `Tracker` (`activity.rs`) turns samples into ACTIVE/IDLE intervals,
saved to the local SQLite `activity` table (open and held intervals checkpointed each sample). The
webview decides the mode with `decideMonitoring` (`src/monitoring.ts`) from the attendance
projection, device status, consent and sync health, and uploads closed intervals with the
same generic `SyncEngine` as attendance (`POST /activity/sync`, after attendance is in sync).
Server: `ActivityService` validates device, consent, clocked-in time and overlaps, then
stores intervals; `summarizeActivity` (shared) computes per-day (split at local midnight)
and per-application totals. No productivity scores. Policy and edge cases: docs/security.md.

## API conventions

- **Versioning:** URI versioning with global prefix: `/api/v{n}/...`. Default version `1`.
  Breaking changes ship as `v2` controllers/routes alongside `v1`.
- **Health vs readiness:** `GET /api/v1/health` is liveness (process is up, no dependency
  calls). `GET /api/v1/ready` pings the database with a 2 s timeout and returns `503` +
  `status: "not_ready"` when it fails.
- **Errors:** every error is the shared `ApiError` envelope
  (`statusCode`, `error`, `message`, `path`, `timestamp`, `requestId`). 5xx details are logged,
  never returned. Query strings are never echoed.
- **Validation:** request bodies and queries are validated with the shared zod schemas
  (`ZodPipe`), so the dashboard and API enforce identical rules. Messages name the field and
  rule, never the value. The global `ValidationPipe` remains for any class-based DTOs. The
  environment is validated with zod at boot (fails fast, prints names not values).
- **Logging:** pino via `nestjs-pino`, JSON in production, pretty in development. Each request
  gets an `x-request-id` (accepted from the caller if well-formed). Requests are logged as
  `{id, method, path}` only, with no headers, query strings or bodies.
- **CORS:** explicit allow-list from `CORS_ORIGINS`, with credentials.
- **Proxy:** `trust proxy` is `loopback`. `X-Forwarded-For` is honoured only from a reverse
  proxy on the same host, so rate limits key on the real client IP.

## Module format & tooling

All packages are ESM (`"type": "module"`, NodeNext resolution); NestJS 12 is ESM-only.
Shared packages compile to `dist/` with `tsc`; the root `dev`/`typecheck`/`test` scripts build
them first. TypeScript is pinned to 6.0.x because typescript-eslint and @nestjs/cli do not yet
support TypeScript 7.

## Ports

| Service | Port |
| --- | --- |
| Dashboard | 3000 |
| API | 4000 |
| Desktop Vite dev server | 1420 (HMR 1421) |
| Dashboard smoke test | 3100 |
