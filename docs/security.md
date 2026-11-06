# Security & privacy

Insight Workfolio monitors employees on **company-owned devices**. Transparency and least
privilege are product requirements, not afterthoughts.

## Hard rules (non-negotiable)

- **No keylogging.** Keystroke content is never captured. Activity is measured, if at all,
  as aggregate active/idle time.
- **No clipboard collection.**
- **No covert monitoring.** The desktop app is always visible (window or tray) while
  tracking, shows the current tracking state, and cannot hide itself from the employee.
  On macOS the menu-bar item is always present while the app runs (it cannot be turned off; only
  the Dock icon can be hidden, by the employee) and shows the state, elapsed time and what is
  recorded. Closing the window keeps the app in the menu bar; quitting while clocked in asks
  first and stops all recording.
- **No monitoring outside clocked-in time.** Tracking starts on clock-in, stops on clock-out.
- No hardcoded credentials anywhere in the repository.

## Secrets and environment separation

| Scope | Where | May contain secrets? |
| --- | --- | --- |
| API | `apps/api/.env` (development) / `/etc/workfolio/api.env` on the VPS (root:workfolio 0640) | **Yes**: JWT secret, OneDrive client secret and token key, (previous plan: Turso token, Graph credentials) |
| Dashboard | `NEXT_PUBLIC_*` in `.env.local` | **No**: embedded in the browser bundle |
| Desktop | `VITE_*` in `.env` | **No**: embedded in the app binary |

- `.env*` files are git-ignored except `.env.example`, which contains no real values.
- Only the API has database or Microsoft Graph access. `@workfolio/database` is marked
  server-only and must never be imported by `apps/dashboard` or `apps/desktop`.
- Production config is validated at boot: `DATABASE_URL` must be an absolute `file:` path (the VPS,
  selected) or `libsql://`/`https://` (Turso, previous plan); a relative `file:`, `:memory:` and `wss://`
  are refused; a remote DB requires a token; `JWT_SECRET` (≥ 32 chars) required; `HOST` defaults to
  `127.0.0.1`. Validation errors print variable names, never values.
- On the VPS, secrets live only in `/etc/workfolio/*.env` (root:workfolio 0640) and
  `/var/lib/workfolio/secrets/` (0700: the encrypted OneDrive token file, the backup passphrase); the API
  and the backup/monitor units run as the unprivileged `workfolio` user under systemd sandboxing, both
  apps listen on loopback only and Caddy terminates TLS (`deploy/README.md`). Database backups are
  gpg-encrypted before they leave the host; the OneDrive uploader refuses unencrypted files.
- Previous plan (reference): hosted secrets in Render env vars / Secret Files, Vercel project env, GitHub
  `staging` environment secrets.

### Microsoft app containment (SEC-11)

- **Never re-consent `Files.SelectedOperations.Selected` for the Insight Workfolio app.** The rejected
  OneDrive-folder test left two dormant SharePoint Limited Access entries for the app on a personal
  OneDrive; re-consenting that scope re-activates them at once, with no new grant (observed
  2026-11-02), and exposes that OneDrive's site, drive and root metadata again.
- The only intended permission is `Sites.Selected` with a grant on the dedicated storage site.
  Before and after any consent or grant change, run an app-only probe and confirm 403 outside the target.
- Details and the remaining manual cleanup: docs/onedrive.md.

#### Microsoft app re-consent guard

Before **any** new admin consent or permission change on the Insight Workfolio app registration:

1. **Do not add or consent `Files.SelectedOperations.Selected`** (or any `Files.*` scope). It is the scope
   that re-activates folder-level Limited Access; storage uses `Sites.Selected` on the dedicated site only.
2. **Confirm the dormant Limited Access entries are gone first (ST-04):** the app (SharePoint principal
   `i:0i.t|ms.sp.ext|<app-id>@<tenant-id>`) must be absent from the role assignments of the personal
   OneDrive site **and** its `Documents` library. Decision doc §7 records their removal on 2026-11-02;
   re-check read-only, because a re-created entry would re-activate on consent.
3. Confirm the app registration lists only `Sites.Selected` (the unconsented `Files.SelectedOperations.Selected`
   was removed, §7) and that Graph Explorer's delegated `Files.ReadWrite` is not consented.
4. After the change, run the app-only probe with a fresh token: `roles` must be exactly `["Sites.Selected"]`
   and every check outside the storage site must return 403.

If any check fails, stop and do not consent. Source of record:
[INSIGHT-WORKFOLIO-FINAL-STORAGE-DECISION.md §6–§7](../INSIGHT-WORKFOLIO-FINAL-STORAGE-DECISION.md).

## Secret-safe logging

- Requests are logged as `{id, method, path}` only, with no headers, cookies, query strings or bodies.
- `set-cookie`, `cookie` and any `password`, `token`, `authToken`, `accessToken`,
  `refreshToken` fields are redacted.
- Verified on Day 2 by running live login, refresh, setup and logout flows and searching the
  full API log for every password, token and cookie value used: zero matches.
- Security events log identifiers only (e.g. the session id on refresh-token reuse), never
  token material.
- Error responses never include stack traces or internal messages for 5xx, and never
  echo query strings.
- Readiness failures return `"unreachable"`; the underlying error is logged server-side only.

## Authentication (implemented Day 2)

Design details are in [architecture.md](architecture.md#authentication).

- **Passwords:** Argon2id via `node:crypto` (OWASP minimum m=19 MiB, t=2, p=1, 16-byte
  salt), stored as PHC strings. Policy: 12–128 characters, not mostly whitespace (NIST
  800-63B: length over composition). Policy is checked on setup, not at login.
- **No admin-chosen or default passwords.** Accounts start without a password. A one-time,
  72-hour setup token (stored hashed) is delivered out-of-band in a URL fragment and
  consumed atomically. Issuing a new one invalidates older ones.
- **Generic login errors:** unknown email, wrong password, no password yet and disabled
  account all return the same `401 Invalid email or password`. Unknown emails are still
  checked against a dummy Argon2 hash to equalise timing.
- **Rate limiting:** login is limited to 10 attempts per email and 100 per IP per 15 minutes
  (429), and password setup to 20 per IP per 15 minutes. A successful login resets that
  email's counter.
- **Tokens:** 15-minute HS256 access tokens. Refresh tokens are 256-bit random, rotated on
  every use, and stored only as SHA-256. Replaying a rotated refresh token revokes the
  session. Each request re-checks the session and account status in the database.
- **Logout** revokes the session server-side and clears cookies. **Disabling** an account
  revokes all its sessions at once. **Setting a password** revokes all existing sessions.
- **Dashboard:** tokens only in `HttpOnly`, `SameSite=Strict` cookies (`Secure` in
  production). The refresh cookie is path-scoped to `/api/v1/auth`. CSRF is defended by
  SameSite=Strict plus a server-side `Origin` allow-list check on every state-changing
  request that lacks a bearer token.
- **Desktop:** the refresh token lives in the OS credential store (macOS Keychain / Windows
  Credential Manager) through Rust commands. The access token is in memory only. Nothing is
  in `localStorage`. The webview CSP limits `connect-src` to the API origin.

### Sessions and account audit (P1, 2026-10-30)

- Every account can list its own live sessions (`GET /auth/sessions`: client Web/Desktop, signed in,
  last renewed, expires, current; never tokens or hashes), revoke one (`DELETE /auth/sessions/:id`,
  someone else's id → 404), sign out its other sessions or sign out everywhere. Ownership comes from
  the authenticated session. Admins cannot revoke other users' sessions individually (disabling the
  account revokes all of them).
- Append-only `account_audit` (migration 0015) records account creation, updates (field names
  only), disable/enable (with sessions revoked), setup links, password set, session revocations,
  refresh-token reuse, device registration and revocation, each in the same transaction as the
  change. Metadata keys that could carry secrets are refused. Admins read it, together with the
  other audit tables, at `GET /audit` and the dashboard **Audit** page (docs/audit.md).
- Every route declares `@Public()` or `@RequirePermission(...)`; `test/route-permissions.test.ts`
  fails on any new route without one and pins the public allow-list.
- Disabling an administrator checks "another active admin / Super Admin remains" inside the write
  itself (race-safe, like role changes).

## Role-based authorization (implemented Day 2)

Roles: `ADMIN`, `EMPLOYEE` (`packages/shared/src/roles.ts`). Enforcement happens in the API
only; client-side checks exist for UX only.

| Permission | ADMIN | EMPLOYEE |
| --- | --- | --- |
| `employees:read`, `employees:manage`, `devices:read` | ✓ | |
| `profile:read-own` | ✓ | ✓, own records only |
| `screenshots:read` | ✓ (any employee's images and metadata) | own screenshots only (Day 7) |
| `timesheet:read-own`, `timesheet:clock` | ✓ | ✓ (planned) |

- A global guard denies by default; public routes are explicitly marked.
- The role is loaded from the database on every request, never trusted from a token or client.
- **Horizontal escalation:** employee-accessible routes check ownership in the service. Another
  employee's ID returns 404, identical to a non-existent ID. IDs are random UUIDv4.
- Admins cannot change their own account status, so they can't lock themselves out.
- Employee update rejects unknown fields (`role` can't be changed via `PATCH /employees/:id`).
- Every screenshot image view is recorded in `screenshot_access_log` (who, which, when; append-only).
- Planned: audit log for other admin actions (status changes, exports).
- **Identities (2026-10-30, [roles.md](roles.md)):** Super Admin (CEO) and Admin (IT) both have the
  `ADMIN` permission role, so they pass the same checks (tested on 16 admin routes). Role changes go
  through `PATCH /roles/users/:id` only: no self-change (403), only a Super Admin grants or removes
  Super Admin (403), never zero active admins or Super Admins (409, guarded inside the `UPDATE`, race
  tested), every change in append-only `role_changes` with a reason. Disabling the last active admin
  account is refused (409).
- **Extension routes (F04):** `/websites/extension/*` are not session routes (`@Public()` to the session guard); the service accepts only an extension bearer token (random, stored
  as SHA-256); pairing is the one route both `@Public()` and `@CsrfExempt()` (no cookie involved).

## API response hygiene

- Password hashes never leave the database. The employee query reduces `password_hash` to
  a boolean `passwordSet` in SQL.
- The device hardware identifier is never returned.
- Setup tokens are returned once (create or reissue response) and never retrievable again.

## Device identity and attendance (implemented Day 3)

- **No hardware fingerprinting.** The device ID is a random UUID the app generates once and
  keeps in the OS credential store (account `installation-id`). The server stores only its
  SHA-256 and never returns it.
- **Attendance only, and only on the employee's action.** Nothing is recorded before or
  after clock-in other than the clock/break events the employee presses. Both clients say so.
- **Employees cannot touch other employees' attendance:** no attendance endpoint accepts an
  employee ID; another employee's device ID is rejected (403).
- **No silent attendance changes.** Admins cannot edit attendance directly. Changes happen
  only through an employee's correction request approved by a *different* admin with a
  reason; the schema refuses any change to a closed record that is not linked to a new
  approved audit row, and refuses a second review of a request. Every request, decision and
  applied before/after value is kept (append-only), and logged (`Correction requested /
  approved and applied / rejected`, with IDs only).
- **Timesheet export (F03, docs/timesheet-export.md):** CSV and XLSX from the same rows, same
  permission, employee rule and 92-day range; built in memory, never stored. CSV text starting with a
  formula character gets an apostrophe; XLSX text is stored as string cells (never formulas). The
  packaged app's download handler accepts only `blob:` export file names saved directly in Downloads
  (no overwrite) and logs no file names.
- **Leave requests (F10, docs/leave-requests.md):** employees request leave only for themselves
  (identity from the session; the body cannot name an employee); another employee's request is
  404. Approve and reject need `leave:review` (admins) and are refused for the requester. Each
  request is decided once and never deleted. Reasons are optional, visible only to the employee
  and admins, and never logged. Leave never changes attendance.
- **Project and task time (F11, docs/project-time.md):** projects, tasks and assignments are
  admin-only (`projects:manage`), checked by the API; every change is kept in `project_audit`.
  Employees start and stop timers only for themselves, only on tasks of projects they are assigned
  to (others 404), with server times. Timers read attendance but never write it. Entries are never
  edited or deleted. No new data is collected: no activity, screenshots or idle data are used.
- **Email reports (F12, docs/email-reports.md):** admin-only configuration (`reports:manage`).
  Recipients are user accounts checked on the server when added and again at every send: active
  admins, or the employee for a report about only them; never free-form addresses. Reports carry
  attendance and task-time aggregates only (no screenshots, activity, leave details, websites or
  scores). No real email provider exists; the default records "not emailed" and the mock is refused
  in production. Delivery records keep a SHA-256 of the content, never the content; logs carry ids.
- **Website usage (F04, docs/website-usage.md):** domain names only, from a browser extension the
  employee connects with a one-time code (only hashes of codes and tokens are stored; the token is
  limited to the extension routes and revocable). Off by default; needs the policy on, the employee's
  acknowledgement of the website notice, an open shift without a break, and in production
  `WEBSITE_TRACKING_APPROVED`. Paths, queries, titles, content, history and incognito windows are never
  collected; the server rejects anything that is not a domain and any extra field. Pairing is the only
  route exempt from the origin check (it reads no cookies). Logs carry ids and counts, never domains.
- **Every action is auditable:** accepted and rejected events, with source (online/offline),
  raw device time and receive time.
- **Local queue:** holds attendance events and non-secret cache (name, email, timezone,
  last status). No tokens. It is not encrypted at rest; it relies on the OS account's file
  permissions.
- **Dev-only test harness:** debug builds evaluate `WF_E2E_SCRIPT` in the window for
  end-to-end tests. Release builds compile it to a no-op (`cfg!(debug_assertions)`).

## Known limitations

- **Rate limits are in-memory per process.** This is fine for a single API instance; move
  them to the database or Redis before running more than one. Restarting the API resets them.
- **Desktop refresh token passes through the webview** in transit (JS calls the API, then
  hands the token to Rust for storage). Moving the auth HTTP calls into Rust would keep it
  out of JS entirely.
- **Concurrent refresh across dashboard tabs** is serialized with the Web Locks API (Day 4),
  so a second tab refreshes with the renewed cookie instead of replaying the old one. Browsers
  without Web Locks fall back to per-tab de-duplication.
- **No self-service password change or "forgot password" flow.** Admins issue a new setup
  link instead. No MFA yet; Microsoft Entra SSO is planned to cover it.
- **No breached-password check** (e.g. HIBP k-anonymity). It's a candidate for hardening.
- **Disabled accounts can still use an outstanding setup link** to set a password, but they
  can't sign in until re-enabled.
- **Revoking a device is permanent for that installation.** To re-enroll the same machine
  the app's Keychain entry `installation-id` must be removed so a new ID is generated.
- **Attendance write serialization is per API process** (like the rate limits); the schema
  guards still prevent corrupt data with several instances.
- **The offline queue file is not encrypted**; see "Local queue: encryption at rest" below.
- **Unsigned (debug/ad-hoc) desktop builds lose Keychain access after every rebuild**: macOS
  asks the user to allow the "new" app, and Keychain reads wait for that answer (the app now
  says so after 3 s instead of showing a bare spinner). Builds signed with a stable Developer
  ID keep access across updates. Denying it signs the user out; nothing is lost on the server.
- **Windows is untested**: Credential Manager storage and the SQLite queue path have only
  run on macOS, and the Windows activity collector is not implemented (plan: docs/windows.md).
- **Activity retention is implemented but off until approved** (see "Activity retention").
- **Screenshots are not masked** (see "Screenshots"): anything on the main screen can appear.
- **Microsoft Graph storage is not verified against a real tenant** (blocked on credentials);
  development uses the `LOCAL_DEV` adapter (refused in production). See docs/onedrive.md.
- **All admins can view all screenshots**; there is no narrower viewer role yet.
- **One app instance per user (Day 8):** a second copy exits at start (advisory `flock` on
  `instance.lock` in the app data directory, released by the OS on exit or crash), so there is
  never a second activity collector or screenshot worker. Windows needs a named mutex (pending).

## Local queue: encryption at rest (assessment, Day 4)

**What is stored:** pending/rejected attendance events (type, time, IDs) and a non-secret
cache (name, email, employee code, time zone, last attendance status, last sync time). No
tokens or passwords (those are in the OS credential store).

**Threat model.**
| Threat | Current mitigation |
| --- | --- |
| Other OS users on the same machine | App data directory is created `0700` (owner only) on macOS (Day 4); Windows `%LOCALAPPDATA%` (never roaming) is per-user by default (profile ACL: user, SYSTEM, Administrators) |
| Lost/stolen laptop, disk removed | Requires full-disk encryption (FileVault / BitLocker), to be enforced by policy/MDM for pilot devices |
| Backups (Time Machine, OneDrive) copying the file | Same: encrypted backups; the data is low-sensitivity attendance times |
| Malware running as the employee | Out of scope for file encryption: it could read the screen, the webview or request the key as the user |
| Tampering with queued events | Server re-validates everything (state machine, ownership, device, timestamps, 7-day window); tampering cannot affect another employee or bypass rules |

**Decision: not implemented today.** SQLCipher (`rusqlite` `bundled-sqlcipher-vendored-openssl`)
or field-level AES-GCM would need a key in the OS keychain. On unsigned builds the keychain
becomes unavailable after each rebuild (observed during Day 4 testing), and an unreadable key
would make queued events unrecoverable, contradicting "no event loss" for low-sensitivity
data already protected by OS permissions and disk encryption. **Plan:** after code signing
(Day 9) adopt SQLCipher with a random per-installation key in the keychain; if the key is
unavailable, keep the encrypted file and block uploads (never reset it); require FileVault /
BitLocker on pilot devices in the meantime.

**Integrity:** the queue is opened with `PRAGMA quick_check`; a damaged file is never
deleted. It is moved aside as `attendance-queue.damaged-<time>` for support, a fresh queue
is created, and the employee is told to request corrections for missing times.

## Activity monitoring policy (implemented Day 5, macOS; server-controlled since Day 6)

Admins change these in the dashboard (**Settings**, `PUT /api/v1/settings/monitoring`). Every
change is a new row in `monitoring_policies` (who, when, reason); rows are never edited or
deleted. Desktops fetch the effective policy with `GET /activity/me` at sign-in and every
minute, and never assume their own values. Until the first change, the defaults apply:

| Setting | Default (proposed, pending HR/Legal) | Allowed |
| --- | --- | --- |
| Monitoring enabled | on | on/off |
| Foreground-application sampling interval | 15 s (`ACTIVITY_SAMPLE_SECONDS` env overrides the default) | 5–300 s |
| Idle threshold (no keyboard/mouse input) | 300 s (`IDLE_THRESHOLD_SECONDS`) | 30–3600 s, at least 2 samples |
| Activity retention | 30 days, **not approved** (nothing deleted) | 7–3650 days, ≥ offline limit |
| Required notice | `2026-10-draft-1` | any published notice |
| Offline activity accepted up to | 7 days | `OFFLINE_MAX_AGE_DAYS` (shared with attendance) |

The desktop cannot bypass these: the server checks every uploaded interval against the
settings history at the time it was **recorded** (not uploaded). Activity recorded while
monitoring was off, or before the employee acknowledged the notice required at that moment
(60 s tolerance), is rejected with a visible reason. Short dev-only thresholds (e.g. 5 s / 30 s)
are only used through env on throwaway databases (`verify:native`).

**When:** only while the employee is clocked in and not on a break, on their active
registered device, after they acknowledged the current monitoring notice. Attendance is the
authority: monitoring is `STOPPED` before clock-in, after clock-out, when signed out, on a
revoked/unregistered device or without consent; `PAUSED_BREAK` during breaks;
`PAUSED_OFFLINE_OR_UNVERIFIED` when the attendance state is unknown or cannot be verified;
`ERROR` when the collector cannot record. An offline clock-in may start monitoring, shown as
"On (pending)" until the server confirms it; if the server rejects that clock-in, the
activity recorded under it is rejected too (it falls outside clocked-in time).

**What is collected:** the foreground application's display name and bundle identifier,
start/end of each interval, and whether the user was idle (no input for the threshold, or the
screen locked). **Never:** keystrokes or input contents, clipboard, window titles, document
names, browser history, websites or URLs, screenshots. Website/domain tracking is deferred:
no permission-based mechanism exists in the app. The API rejects any extra field (e.g. a
window title or URL) with 400.

**How (macOS):**
- Foreground application: owner of the frontmost normal on-screen window
  (`CGWindowListCopyWindowInfo`, reading only layer and owner PID), resolved with
  `NSRunningApplication` to name and bundle ID. Window titles are not read (macOS withholds
  them without Screen Recording permission anyway). `NSWorkspace.frontmostApplication` was
  tried first and returned stale values inside the app during testing.
- Idle: `CGEventSourceSecondsSinceLastEventType`, a counter of seconds since the last input
  event. No event tap, no keyboard hook, no input contents.
- Screen lock, sleep and fast user switching / logout: `com.apple.screenIsLocked`/`screenIsUnlocked` and NSWorkspace sleep/wake/session notifications (`session_events.rs`), with the session dictionary's `CGSSessionScreenIsLocked` and on-console flags as the authority. Since 2026-11-02 that time is **unobserved** (neither active nor idle; the open interval is closed at the transition), not counted as idle. While recording, the app opts out of App Nap without preventing system or display sleep (`power.rs`).
- Invisible bidi marks in app names (e.g. WhatsApp's U+200E) are stripped before storage.
- **No Accessibility, Input Monitoring or Screen Recording permission is required or
  requested.**

**Edge cases:** idle time is attributed retroactively from the last input, so time below the
threshold counts as active and time after the last input counts as idle once the threshold is
reached. An application coming to the front by itself (no input) is not treated as input:
the interval it ends is held, not uploaded, until input is seen after it; if the threshold is
reached first, idle still starts at the last real input and the held intervals are cut back to
it (before 2026-10-19 such a switch could add up to the threshold as active time). An invalid
idle reading counts as unobserved, never as input. Sleep, a suspended process, or a wall-clock change (detected by comparing the wall
clock with a monotonic clock that stops during sleep) closes the interval at the last
trustworthy sample; the gap is not counted. App switches are resolved to the sample
interval (±15 s by default). Long single-app intervals are split every 15 minutes so they
upload regularly. The open interval is checkpointed to local SQLite on every sample; after a
crash it ends at its last checkpoint (at most one sample period is lost) and uploads normally;
held intervals are checkpointed the same way, so a crash while one is held keeps it as observed.

**Data handling:** only aggregated intervals are stored (raw samples are never kept). The
server accepts intervals only from the employee's active device, only inside clocked-in,
non-break time (edges within 60 s are trimmed), applies the same clock-skew correction as
attendance, and never stores overlapping intervals (schema trigger), so no time is counted
twice. Uploads wait until attendance changes have synced. Rejected intervals stay visible on
the device until dismissed. Locally, unsynced intervals are capped at 50,000 (~1 month of
heavy app switching); at the cap collection pauses with a visible error instead of dropping
data, and resumes by itself once the backlog uploads (the same applies to a failed local save:
the error clears once the local queue is writable again; no restart needed). **Server retention is not automated yet**: a retention period (e.g. 12 months) must be
set by HR/Legal and a purge job added before the pilot.

**Accuracy (Day 6 review):** app switches are split at the midpoint between the two samples
that observed them (error ≤ half a sample period, no bias toward the previous app); idle
start and end use the exact time of the last/next input. Observed time (active + idle
intervals) is reported separately from clocked-in time; the difference is **unobserved**
(asleep, app not running, monitoring paused, not uploaded yet) and is shown as such in the
dashboard, never estimated or attributed to an application. The desktop shows the latest
unobserved gap ("Not recorded from … to …") and a notice after a crash recovery. Interval
uploads are batched (three reads and one write transaction per batch of up to 500); a 24-hour
cap per interval and an end-time index keep the no-overlap check cheap at scale.

**Platform status:** macOS implemented and verified on real application switches; native idle,
lock and sleep runs are recorded with `pnpm --filter @workfolio/desktop verify:native` (see
docs/setup.md). **Windows
collector pending**: the Windows build compiles a stub that collects nothing and the app says
"Activity collection is not available on this operating system yet"; attendance works.

## Employee disclosure and consent (required before the pilot)

- Written monitoring policy reviewed by HR/legal for each jurisdiction where employees
  work, covering what is collected, why, when, retention, and who can access it.
- Each employee acknowledges the policy before first use; the desktop app records the
  acknowledgement (version + timestamp) via the API and blocks tracking until it exists.
  **Implemented Day 5, extended Day 6:** notices are stored on the server
  (`monitoring_notices`, append-only, one row per version) and served to the app, so the
  wording can change without an app release. Admins publish a new version and select it as
  required in Settings; the desktop then stops monitoring until the employee acknowledges it,
  and the server rejects activity recorded in between. Every acknowledgement is kept
  (`monitoring_consents`, append-only; `GET /activity/consents`). The app shows the notice,
  what is and is never recorded, and when the employee acknowledged which version. The seeded
  notice is a factual **draft** pending HR/Legal review; this software does not by itself make
  monitoring lawful in any jurisdiction. Declining is not a technical option in the app
  (monitoring simply stays off); how to handle that is an HR decision.
- The desktop app shows a persistent indicator whenever tracking or screenshot capture is
  active, and a notice when a screenshot is taken.
- Employees can view their own collected data (time, activity summaries, screenshots): the desktop
  History tab (shifts, breaks, weekly hours and application activity) and "My screenshots" tab,
  over self-scoped API routes. Verified in headless Chrome, not yet in the packaged app.
- Policy changes require re-acknowledgement.

## Activity retention (implemented Day 6, off until approved)

- **What:** only `activity_intervals` rows whose interval **ended** before
  `now − retentionDays` are deleted. Attendance sessions, breaks, events, corrections and their
  audit trail, consent records, notices and the settings history are separate tables and are
  never purged by this job.
- **Approval gate:** nothing is deleted until an admin records "retention approved" in
  Settings (with a reason, e.g. the HR/Legal decision). Default: 30 days, not approved.
- **Dry run:** `GET /api/v1/activity/retention` (Settings page) shows the cut-off, how many
  intervals and employees would be affected, the oldest stored activity and past purges.
  It deletes nothing.
- **Runs:** once approved, the API purges every 6 hours; an admin can also run it from
  Settings (`POST /activity/retention/run` with `{"confirm": true}`). Deletes happen in chunks of
  5,000; each chunk is recorded in `activity_retention_runs` (cut-off, count, who or
  "scheduled") **in the same transaction** as the delete, so no deletion goes unrecorded.
- **Unsynced data:** activity waiting on a computer is never deleted there. The server accepts
  uploads only up to the offline limit (7 days) and the retention period cannot be shorter than
  that, so an accepted upload is never purged immediately.
- **Recovery:** a purge is permanent. The only way back is a database backup or point-in-time
  restore (Turso keeps point-in-time history depending on plan); restoring would also undo
  later writes, so it is a last resort. Test on a copy first; use the dry run before approving.

## Screenshots (implemented Day 7, macOS; off by default)

**What is captured:** the **primary display only** (`CGMainDisplayID`), scaled down to the
policy's maximum resolution (default 1920 px on the longest edge), without the mouse cursor,
encoded as lossy WebP (default quality 70). Other monitors are never captured. No window titles,
app names, OCR or other content is extracted. **Only admin-defined privacy masks are hidden**
(2026-10-29, docs/screenshot-masks.md): fixed rectangles filled black on the device before
encoding, so those pixels are never stored or uploaded. Masks are off (none) by default. Passwords
already hidden by apps stay hidden, but anything else on the main screen outside the masks
(messages, personal websites, documents, health or banking pages) can appear. Nothing is detected
or blurred automatically, and app exclusions are not implemented (options: exclude specific apps
via `SCContentFilter` window exclusion; pause while chosen apps are frontmost). The notice says
plainly that screenshots may contain sensitive information.

**When:** only when *all* of these hold, checked by the app before scheduling and again by the
capture worker right before each capture, and once more by the server against the capture time:

| Condition | Desktop | Server (at capture time) |
| --- | --- | --- |
| Clocked in, not on a break | `decideScreenshots` (attendance projection, incl. offline events) | capture inside a clocked-in, non-break segment, no edge tolerance |
| Device registered and active | ✓ | `devices.require` (403 otherwise) |
| Screenshots enabled by the organization | ✓ | policy period in force then |
| Screenshot-specific notice acknowledged | ✓ (separate from the activity notice) | acknowledgement of the then-required version before the capture |
| OS Screen Recording permission | `CGPreflightScreenCaptureAccess` before every capture | — |
| Screen not locked | before **and** after the capture (a frame taken while locking is dropped) | — |
| Not asleep | sleep/clock change restarts the interval (no capture at wake) | — |
| Interval respected | worker schedule | another screenshot within half the interval is rejected |

A capture that is in progress when the employee starts a break or clocks out is discarded
(generation check under the worker lock), so no screenshot is saved after the button press.

**Visibility:** the app always shows screenshot state (On / Paused / Off / Needs permission /
Error and why), the Screen Recording permission state, the next scheduled capture, the last
local capture, the last capture **confirmed by cloud storage** (shown separately), pending
uploads, local storage use and warnings. For a minute after each capture it shows "Screenshot
taken at HH:MM". The "What is recorded" card lists screenshots as on/off. The policy details
(interval, quality, resolution, retention, storage) and the screenshot notice are in the app.

**OS permission (macOS):** ScreenCaptureKit requires the user to allow "Screen & System Audio
Recording" for the app in System Settings. The app never bypasses or automates this: it only
calls `CGRequestScreenCaptureAccess` when the employee clicks "Allow screen recording…", which
shows the system prompt the first time. Denied → no capture, the app explains how to allow it.
Revoked later → the next preflight fails, capture stops, the app shows "Needs permission".
macOS may require quitting and reopening the app after granting. macOS 15+ periodically asks
the user to re-confirm apps that record the screen. Unsigned development builds are identified by
their binary, so a rebuild can require granting the permission again.

**Local queue (desktop):** metadata in the existing SQLite queue (`screenshots` table: id,
employee, device, local session, capture time, size, dimensions, SHA-256, status, retries,
next attempt, last error) and files in `<app data>/screenshots/` (directory `0700`, files `0600`,
named `<uuid>.webp`, no names or content). Writes are atomic (temp file → fsync → rename →
fsync directory) with the row written first; startup recovery finishes interrupted saves,
removes only temp files of saves that never completed, and marks missing/damaged files FAILED
(visible to the employee). Every upload re-verifies the file checksum. **Unsynced screenshots
are never deleted automatically:** a failed upload backs off (30 s doubling to 1 h) and retries
indefinitely. Files of screenshots **confirmed** by cloud storage are deleted 24 h later.
Failed/rejected screenshots are deleted only when the employee clicks "Dismiss". **Storage cap:**
500 MB of local screenshots (all users on the computer); warning from 80 %, capture pauses at
100 % (and when free disk space drops below 1 GB) until uploads catch up. No raw (unencoded)
copy is ever written; frames exist only in memory. Logs record size and timing, never pixels.
The local files are not encrypted beyond the OS account protections (same assessment as the
queue; FileVault recommended).

**Server:** metadata only in Turso (`screenshots`, migration 0006): no image bytes, no
links. Identity columns are immutable (trigger), status only moves REGISTERED → STORED →
DELETED, rows are never deleted. Uploads are brokered by the API (Graph credentials stay on
the server, see docs/onedrive.md): size, WebP header, dimensions and SHA-256 must match the
registration; STORED is set only after the provider confirmed the file. Per-employee rate
limit: 120 screenshot requests / 10 min (in-memory). Upload bodies are capped at 10 MB.

**Access (Day 8):** admins (`screenshots:read`) always; the employee for their own screenshots
only while the policy's **"employees may view their own screenshots"** is on (default on; off →
403 for their list, metadata and images). Everyone else gets 404, identical to a missing id.
Checked on every request for both the metadata (`GET /screenshots/:id`, `/screenshots`,
`/screenshots/gallery`, `/screenshots/overview`) and the image (`GET /screenshots/:id/content`).

**Image delivery:** only through that authenticated endpoint; no public, shareable or
pre-signed links exist (Graph's short-lived download redirect is followed by the API). Before
sending, the bytes are validated (WebP header, ≤ 10 MB, exactly the registered size); anything else
is refused with a generic 502 that names no path, key or provider detail. Headers:
`Content-Type: image/webp`, `Content-Length`, `Cache-Control: no-store, private, max-age=0`,
`Pragma: no-cache`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none';
sandbox`, `Cross-Origin-Resource-Policy: same-site`, `Referrer-Policy: no-referrer`,
`Content-Disposition: inline; filename="screenshot-<id>.webp"`. The dashboard gallery fetches
images with the session cookie into short-lived `blob:` URLs and revokes them when they leave the
screen; it does not use `next/image` (which would proxy and cache them). No thumbnails are stored:
the gallery shows the same bytes scaled down (bounded by the 10 MB cap; typically 50–150 KB).

**Audit:** every successful image access is recorded in `screenshot_access_log` (viewer, screenshot,
time, action `VIEW` or `THUMBNAIL`; append-only); refused requests are not logged as access. The
admin viewer shows each screenshot's access log. Logs and API logs never contain image bytes.

**Retention:** proposed default 30 days, configurable, **off until approved** (same gate as
activity). Once approved, expired screenshots are deleted from storage every 6 hours (or from
Settings) and their metadata is marked DELETED with who/when. Every run is recorded in
`screenshot_retention_runs` (cut-off, deleted, failed, deletion mode, who/scheduled). A file the
provider fails to delete stays STORED and is retried next run. **Deletion is not necessarily
permanent:** with SharePoint the default sends files to the site recycle bin (recoverable for up to
93 days unless emptied; `GRAPH_PERMANENT_DELETE=true` bypasses it), and Microsoft 365 retention
policies or holds may preserve copies regardless. Screenshots registered but never uploaded are
also marked DELETED once expired; the desktop is told (410 / REJECTED) and keeps its local copy
until the employee dismisses it; it is never reported as stored. Local copies on the Mac: unsynced
ones are never deleted automatically; confirmed ones are removed 24 h after confirmation.

### Screenshot privacy safeguards (Day 8 review)

| Risk / topic | What the app does | Not done (decision needed) |
| --- | --- | --- |
| Sensitive content exposure | Notice states screenshots may contain personal or sensitive information; admins-only access with audit; retention. Privacy masks (2026-10-29): admin-defined rectangles blacked out on the device before encoding; the API refuses screenshots captured without the masks in force; unreadable stored masks turn capture off | Masks cover fixed screen areas, not apps; none configured by default; no automatic detection or blur; existing screenshots are not redacted retroactively. Not verified on a real ScreenCaptureKit capture. Which areas to mask: HR/Legal |
| Application exclusions | — | Not implemented. Feasible with ScreenCaptureKit (exclude windows of chosen bundle IDs via `SCContentFilter`, or skip the capture while such an app is frontmost). Needs an HR/Legal list (e.g. password managers, banking, health, HR portals, personal messaging) |
| Display exclusions / multi-monitor | Only the primary display (`CGMainDisplayID`) is captured; other monitors are never captured, not even listed in the upload | Capturing more displays would be a policy change, a new notice and code change; not configurable |
| Consent | Separate screenshot notice, acknowledged per version before any capture; server rejects captures from before the acknowledgement | Employee withdrawal of consent is not an in-app action (stopping is via HR/admin turning screenshots off or a new notice version); how to handle a refusal is an HR decision |
| Employee notification | Always-visible state, next capture time, "Screenshot taken at HH:MM" for a minute after each capture, policy details in the app; macOS shows its own screen-recording permission UI | No sound or system notification per capture |
| OS permission | Explicit macOS Screen Recording permission, never bypassed; revocation stops capture | — |
| Retention | Approval-gated, dry run, run log, recycle-bin caveat documented | Final period from HR/Legal |
| Authorized viewers | Admin role only (+ employee self-view if enabled: desktop "My screenshots" tab since 2026-10-29, own screenshots only, identity from the session, 403 when self-view is off); every view logged | No finer-grained "screenshot viewer" role yet; all admins can view all employees |
| Timelapse videos (2026-10-28) | Built only from screenshots already stored under the notice (no extra capture, no interval change); admins only; the employee comes from the session, never the request; every create, view, download, cancel and delete logged (`timelapse_access_log`); delivered through the API only (no-store, sandbox CSP, Repr-Digest); kept on the API host 0700/0600 for 24 h and deleted as soon as a source screenshot is deleted (docs/timelapse.md) | Show exactly the stored screenshots: privacy masks applied at capture stay black, nothing else is masked. The current screenshot notice does not mention videos (HR/Legal decision). Timelapse views are not in the per-screenshot access log |
| Hidden capture | Not possible by design: capture runs only from the visible app with the state on screen; one instance per user (lock) | — |

## Transport and client hardening

- CORS allow-list via `CORS_ORIGINS`; no wildcard origins.
- Tauri: CSP restricts `connect-src` to self, IPC and the configured API origin; capabilities
  grant `core:default` only (no filesystem/shell plugins). The webview cannot capture the screen
  or read files itself: screenshot capture and the screenshot files are handled by the app's own
  Rust commands (`screenshot_*`), which read only files the capture worker wrote.
- `x-powered-by` disabled on the API.
- Production API must sit behind TLS (reverse proxy on the VPS).
