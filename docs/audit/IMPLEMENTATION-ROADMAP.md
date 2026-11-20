# Insight Workfolio — Design, Attendance, Email, Security and Roadmap (Parts 5–10)

Status: **plan for review. No implementation started.** Builds on `REFERENCE-WORKFOLIO-PRODUCT-AUDIT.md` and
`INSIGHT-WORKFOLIO-CURRENT-STATE.md`.

Guiding rule: the existing backend already covers most of the reference's *functionality* (attendance state machine,
corrections with audit, schedules, leave, holidays, teams, alerts, scheduled reports, notifications, screenshots,
timelapse, activity, websites). The biggest gaps are **(1) UI presentation**, **(2) missing-clock-out handling**,
**(3) email actually leaving the server**, and **(4) production running an older build with the work schedule off**.
The plan reuses tables and services and adds as little as possible.

---

## Part 5 — Admin Dashboard design

### Visual language (own implementation, Insight Workfolio branding kept)

| Token | Proposal |
|---|---|
| Default theme | **Light by default**, dark kept as an explicit user choice (toggle stored per browser), instead of following the OS only |
| Canvas / surface | `#f6f7f9` page, `#ffffff` cards, 1 px `#e5e7eb` borders, shadow `0 1px 2px rgb(0 0 0 / .04)` |
| Accent | Keep the existing Insight Workfolio blue; status colours: green working/healthy, amber break/not started, red late/absent/over, grey offline |
| Type | System font stack (already used), 13–14 px body, 12 px table meta, 20 px page title |
| Density | 12 px card padding, 36 px table rows, 8 px grid |
| Charts | Hand-built SVG components (bar, stacked bar, donut, Gantt strip, sparkline): no chart dependency needed for these five shapes. Re-evaluate only if a sixth chart type is needed |
| Explanatory text | Move the long per-page compliance paragraphs into an "About this page" disclosure; keep them, do not delete (they document monitoring transparency) |

### Proposed sidebar

```
Insight Workfolio                [Today ▾] [All teams ▾]   (global filters in the top bar)
REALTIME     Overview · Live team
ATTENDANCE   Attendance · Timesheets · Corrections · Leave · Holidays
MONITORING   Activity · Timeline · Screenshots · Websites
WORK         Projects
REPORTS      Reports (sub-menu) · Alerts
PEOPLE       Employees · Teams · Devices · Roles (Super Admin)
ADMIN        Notifications · Audit · Desktop updates · Settings (sub-menu)
```

Settings sub-menu (split of today's single long page): General & schedule · Monitoring & notices · Screenshots &
masks · Application labels · Website policy · Storage · Email & notifications · Leave types.

### Page-by-page plan

| Page | Content (reuse → new) |
|---|---|
| Overview | KPI strip (existing counters) · Late today / Absent today lists (`/attendance/daily`) · Missing clock-outs (new) · Work hours today table (`/attendance/overview`) · Workload 7-day bar (timesheets) · Top apps donut (`/activity/summary`) · Recent screenshots (existing API, access-logged) · Upcoming holidays & leave · Pending approvals |
| Live team | Card grid with status chips (Working / Break / Stopped / Not started / Leave / App not installed) from `/attendance/overview` + devices |
| Attendance | Tabs Live · Daily · Monthly matrix (new) · Late · Missing clock-out; team filter; export |
| Employee profile | Header + KPI cards (worked, active, idle %, first in, last out) · 14-day bar · apps donut · clock-in/out log · corrections · leave · devices; existing edit form moves to an "Edit" tab |
| Timesheets | Keep summary; add week grid view (IN/OUT/WORK/BREAK per day) |
| Timeline | Gantt per employee for a day from `/activity/timeline` + attendance sessions |
| Reports | Sub-menu: Daily attendance · Monthly attendance · Monthly in/out · Late · Overtime · Summary · Scheduled emails |

Responsive: sidebar collapses to the existing menu button < 1024 px; cards reflow 5→3→2→1; tables scroll horizontally
inside their card (never the page).

---

## Part 6 — Attendance management (top priority)

### Reuse, do not duplicate

| Need | Existing piece |
|---|---|
| Clock in/out, breaks, offline sync, idempotency, device check | `attendance_sessions`, `break_sessions`, `attendance_events`, `AttendanceService` |
| Status, hours, history, timesheet, export | `/attendance/current|history|timesheet(s)|export|summary|overview` |
| Late / absent / leave / holiday per day | `ScheduleService.daily` + `work_schedule_policies` + per-person overrides |
| Corrections with audit | `correction_requests`, `attendance_corrections` (append-only, approver ≠ requester) |
| Department | `teams` / `team_members` (team = department; no new table) |
| Alerts | `alert_rules`, `alerts` |

### New pieces (minimal)

1. **Missing clock-out detection** (no new table). Definition: a session still `OPEN` when (a) the employee's local
   workday ended + `missingClockOutGraceMinutes`, or (b) open longer than `maxShiftHours` (default 14), or (c) the
   device has not been seen for `staleDeviceMinutes` while clocked in. Computed in a query in `ScheduleService`/
   `AttendanceService` and shown on Overview/Attendance. Never auto-closes a shift (keeps the existing "breaks are
   never auto-closed" principle and the immutable-history guarantee) — the fix path is a correction.
   *Option for approval:* an employee-side desktop prompt "You are still clocked in — clock out at <last activity>?",
   which files a correction request rather than editing history.
2. **Alert kind `MISSING_CLOCK_OUT`** (+ `LONG_BREAK`). `alert_rules.kind` has a `CHECK` list, so this needs a
   SQLite **table-rebuild migration** (copy → recreate → reinsert inside one transaction) with a pre-migration backup.
3. **Admin-initiated correction**: allow `POST /attendance/corrections` with `employeeId` for `attendance:review`
   holders; still requires a **different** admin to approve (existing trigger). *Decision needed:* with only one
   active admin, allow Super Admin self-approval with a mandatory reason and audit flag, or require two admins.
4. **Team filter** (`teamId`) on `overview`, `daily`, `timesheets`, exports — query parameter only.
5. **Monthly views**: `GET /attendance/monthly?month=YYYY-MM&teamId=` returning per-employee per-day
   {firstIn, lastOut, workedSeconds, status} — derived, no storage. XLSX via existing `timesheet-xlsx.ts`.
6. **Live status freshness**: "Online" only if `last_seen_at` < 5 min; otherwise "Last seen 6 h ago" (fixes the
   misleading label observed in production).

### API additions

| Method | Path | Permission |
|---|---|---|
| GET | `/attendance/monthly` | `attendance:read-all` (team heads: own teams) |
| GET | `/attendance/missing-clock-outs?date=` | `attendance:read-all` |
| GET | `/attendance/late?from&to&teamId` | `attendance:read-all` |
| POST | `/attendance/corrections` (+ optional `employeeId`) | `corrections:request`; `employeeId` only with `attendance:review` |
| GET | existing endpoints + `teamId` | unchanged |

### Screens

Employee (desktop app + `/my/attendance`, both exist): today's status, clock in/out, break start/end, worked & break
time, history, timesheet, "request correction". Additions: missing-clock-out banner, monthly calendar.
Admin: Part 5 pages.

### Edge cases to cover in tests

Shift across midnight / across a DST change (employee time zones are IANA) · employee changes time zone · open break
at clock-out (already rejected) · offline events arriving days late (skew logic exists) · two devices (one active device
rule) · holiday + approved half-day leave + late · schedule changed mid-day (applies next local day, existing rule) ·
disabled/terminated employee with open session · correction overlapping another session (trigger) · admin is also an
employee · team head reading outside their team (404).

### Permissions

Unchanged model: Admin/Super Admin all; team heads scoped reads (`TEAM_HEAD_PERMISSIONS`); employees own data only.

### Configuration decisions (P0, no code)

Production has **Work schedule = Off**, so late/absent are blank. The owner must decide expected start, grace minutes and
workdays (per-person overrides exist), and whether to publish non-draft monitoring notices.

---

## Part 7 — Email notification system

### Reuse

- **Transport**: Microsoft Graph delegated `Mail.Send` through the existing connection (`INVITATION_MAIL_PROVIDER`,
  `MAIL_SENDER` from server env). No address is hard-coded in code or in this plan.
- **Event emails**: the `notifications` module on `main` (queue table, 4 attempts 1/5/30 min, dedupe key, delivery log,
  retry button, recipient re-check at send time, HTML-escaped templates). **Not deployed yet** (migration `0033`).
- **Scheduled summaries**: the `reports` module (one run per schedule-period, leases, retries); currently transport
  `none` — point it at the same Graph transport.

### Additions

| Item | Design |
|---|---|
| Event types | `ATTENDANCE_CLOCK_IN`, `ATTENDANCE_CLOCK_OUT`, `LATE_ARRIVAL`, `ABSENCE`, `MISSING_CLOCK_OUT`, `PRODUCTIVITY_ALERT` (from alert rules) — `notification_events.type` is free text, so **no table rebuild** |
| Rules table `notification_rules` | `type`, `enabled`, `mode` (`IMMEDIATE` · `DAILY_DIGEST` · `OFF`), `digest_local_time`, `timezone`, `team_id` NULL=all, `changed_by`, timestamps. Critical system events stay non-switchable (existing rule) |
| Recipients `notification_rule_recipients` | `rule_id`, `user_id` (accounts only — existing security rule). *Decision needed:* allow external addresses (e.g. an owner mailbox without an account)? Recommended: create a "notifications-only" account instead, keeping the no-free-form-address guarantee |
| Digest | clock-in/clock-out default to `DAILY_DIGEST` (one email per recipient per day, sent at `digest_local_time`); late/absence/missing clock-out default `IMMEDIATE` but capped at one per employee per day (dedupe key `type:employee:localDate`) |
| Daily / weekly / monthly summaries | reports pipeline; add report kinds `LATE`, `ABSENT` and a `send_at_local_time` column (additive) |
| HTML templates | extend `templates.ts`; plain-text alternative; no screenshots/app names/leave reasons (existing exclusion list) |
| Timezone scheduling | per rule `timezone` (default org); digest fires once per local date; DST-safe via the existing period helpers |
| Logs / retry / failures | existing delivery table + page; failures of the whole channel surface on Overview |
| Role access | rules and logs: `settings:manage`; team heads may be recipients only for their teams' events |

**Testing without sending:** mock provider (exists) + `INVITATION_MAIL_PROVIDER=none` in staging. No real email until
the owner supplies and approves recipients.

Known limitation (documented in `docs/notifications.md`): mail and storage share one Microsoft sign-in; if it expires,
email fails too → keep `monitor.sh` as an independent alert path.

---

## Part 8 — Architecture verification summary

Verified on `main` (details in Current State §3): monorepo/pnpm/TS ✓, NestJS ✓, Next.js ✓, Tauri 2 ✓, libSQL ✓
(production = SQLite file on the VPS, not Turso), OneDrive/SharePoint via Graph ✓, macOS + Windows ✓, role-based admin
and employee dashboards ✓. Nothing in this plan replaces any of it. All schema changes are additive except the
`alert_rules` CHECK rebuild, which is flagged for explicit approval with a backup.

---

## Part 9 — Security and privacy audit

| Area | Finding | Severity | Recommendation |
|---|---|---|---|
| AuthN | Argon2id, 15-min JWT + rotating refresh with reuse detection, HttpOnly/Secure/SameSite=Strict cookies, setup links in URL fragment [C][D] | Good | Keep |
| AuthZ | Global deny-by-default guard, server-side permission map, Super-Admin-only destructive actions, team-head scoping, 404 for foreign IDs, route-permission test [C] | Good | Keep; add new routes to `route-permissions.test.ts` |
| Data isolation | Attendance writes take no employee ID; reads scoped [C] | Good | Admin-initiated corrections must keep this for employees |
| Screenshot access | Every view logged — confirmed: this audit's page visits appear in the production audit log [P] | Good | Keep; mention to admins that browsing creates entries |
| Monitoring transparency | Production notices are all **"Draft"** versions; retention periods **not approved** (nothing is purged; 202 screenshots accumulating) [P] | **High (compliance)** | HR/Legal approve notice wording and retention, then publish final versions (employees re-acknowledge) |
| Deletion semantics | Purged screenshots sit in the SharePoint recycle bin up to 93 days [P] | Medium | Document in the notice or empty the bin as part of purge |
| Attendance integrity | DB triggers, append-only events/corrections [C]; but open shifts/breaks persist for a day+ [P] | Medium | Missing-clock-out detection (Part 6) |
| Version visibility | Health endpoint exposes no version; no deploy tags; prod behind `main` | Medium | Add commit to health (no secret), tag deploys |
| Desktop updates | Devices report "unknown" version [P] | Medium | Fix telemetry before relying on the update channel |
| Email privacy | Recipients from accounts only; no bodies stored; descriptions sanitised [C] | Good | Keep in new event types; digests must not reveal other teams to team heads |
| Secrets | `.env.staging` only locally and git-ignored; server env files 0640 [D]; no keys found on disk | Good | Keep the encrypted hotfix bundle out of shared archives |
| Local data | Backup folder on the dev Mac holds employee activity rows [Inventory §3.10] | Low | Delete after confirmation |
| Transport | Single origin on a bare IP with a 6-day Let's Encrypt IP certificate [D] | Medium (ops) | A domain name gives normal 90-day certs and simpler cookie/site setup |
| Scheduler model | All timers assume one API instance (dedupe keys prevent duplicates) [D] | Low | Keep single instance; document |

---

## Part 10 — Phased roadmap

Estimates are **engineering hours for one experienced developer familiar with this codebase**, including tests and
docs, excluding waiting time for decisions and reviews. Ranges are honest: the low end assumes no surprises.

| Phase | Hours |
|---|---|
| 0 Audit & consolidation | 12–20 |
| 1 UI foundation & navigation | 45–65 |
| 2 Admin Dashboard | 40–60 |
| 3 Attendance management | 70–100 |
| 4 Email notifications | 55–80 |
| 5 Employee management & reporting | 50–70 |
| 6 Productivity/screenshot parity | 50–80 |
| 7 Integration & E2E testing | 40–60 |
| 8 Production deployment | 16–28 |
| **Total** | **≈ 380–565 h** (≈ 10–14 weeks full-time for one person) |

### Phase 0 — Audit and repository consolidation (12–20 h)
- Tasks: approve this audit · execute `REPOSITORY-CONSOLIDATION-PLAN.md` §6 · identify and tag the deployed commit · add commit SHA to `/api/v1/health` · deploy record template.
- Depends on: owner approvals (installers WIP, lock-break CI commits, test backup).
- Tests: CI green on `main` after the distribution merge; health returns SHA.
- Acceptance: one working folder; no unique work lost (checked against the inventory); tags pushed.
- Risks: merging distribution conflicts with the live Caddy hotfix. Rollback: consolidation plan §7.

### Phase 1 — UI foundation and navigation (45–65 h)
- Tasks: light-default tokens + theme toggle · new sidebar + top bar with global date/team filters · Settings split into sub-pages · shared components (KPI card, data table with sort, status chip, empty/error states, SVG bar/donut/Gantt/sparkline) · "About this page" disclosure.
- Depends on: Phase 0. Tests: existing browser suites assert nav labels (`nav a` text) — update them; visual check at 1440/1024/768/375 px; a11y (keyboard, contrast).
- Acceptance: every existing page reachable, same permissions, no API change. Risk: breaking browser tests. Rollback: revert the UI PR (no data change).

### Phase 2 — Admin Dashboard (40–60 h)
- Tasks: Overview widgets (Part 5) · Live team cards · Employee profile page.
- Depends on: Phase 1; one aggregate endpoint for the overview to avoid N requests.
- Tests: API e2e for the aggregate (RBAC incl. team head), empty states, 0/1/many employees.
- Acceptance: overview loads < 1 s with 100 employees on the VPS; screenshot thumbnails still access-logged. Rollback: revert PR.

### Phase 3 — Attendance management (70–100 h)
- Tasks: missing-clock-out detection + UI · alert kinds (table-rebuild migration) · admin-initiated corrections (+ decision) · team filter · monthly matrix, late, overtime views + XLSX · live freshness label · desktop "still clocked in" prompt (optional) · enable schedule in production (config).
- Depends on: Phase 1–2; owner decisions on schedule and correction approval.
- Tests: all edge cases in Part 6 (unit + e2e, injected clock, IST/New York/DST zones); migration test on a copy of the production DB schema.
- Acceptance: the three anomalies seen in production are flagged; late/absent show for every scheduled employee; no correction possible without audit row.
- Risks: table-rebuild migration. Rollback: pre-migration backup + `verify-backup.sh`; code revert; migrations are forward-only so the restore path is the backup.

### Phase 4 — Email notifications (55–80 h)
- Tasks: deploy `0033` · `notification_rules` (+recipients) migration · new event producers from attendance/alerts · digest scheduler · report kinds LATE/ABSENT + send time · reports → Graph transport · templates · settings UI.
- Depends on: Phase 3 events; owner supplies recipients later; Graph `Mail.Send` consent already part of the invitation rollout.
- Tests: mock provider e2e (routing, digest once per local day across DST, dedupe, retries, recipient re-check, RBAC); staging with provider `none`.
- Acceptance: zero real emails until the owner enables a rule with recipients; one digest per recipient per day; delivery log shows every attempt.
- Risks: mail volume limits, shared Microsoft sign-in. Rollback: set rules to `OFF` / provider `none` (instant, no deploy).

### Phase 5 — Employee management and reporting (50–70 h)
- Tasks: employee list filters (team, role, OS, app version) · summary/custom XLSX report · scheduled report types in UI · leave-balance polish.
- Tests: export content excludes forbidden fields (existing planted-data tests pattern). Acceptance: reports match timesheet totals to the minute. Rollback: revert.

### Phase 6 — Productivity / screenshot parity (50–80 h)
- Tasks: Timeline Gantt · apps summary donut & per-app history · idle marker on screenshots · bulk export (Super Admin, logged) · "less working hours" risk rule.
- Depends on: HR/Legal approval of what productivity data admins may see. Tests: privacy assertions (no window titles/keystrokes). Rollback: feature flags/revert.

### Phase 7 — Integration and end-to-end testing (40–60 h)
- Tasks: Playwright flows (admin + employee + team head) against a seeded staging; desktop clock-in → dashboard → email (mock) path on macOS and Windows; load test overview with 200 synthetic employees; backup/restore drill.
- Acceptance: all suites green; restore drill documented.

### Phase 8 — Production deployment (16–28 h)
- Tasks: hPanel snapshot + DB backup + `verify-backup.sh` · migration dry-run on a copy · deploy tagged release · smoke tests · enable schedule/rules per owner decisions · deploy record.
- Acceptance: health shows the tagged SHA; no 5xx in 24 h; backups continue.
- Rollback: previous release dir (`/opt/workfolio/releases/*`) + DB restore from the pre-deploy backup if a migration ran.

---

## Decisions needed from the owner (blocking)

1. Approve deletion/archive per the inventory (especially `insight-workfolio-installers` WIP and the test backup).
2. Work schedule values (start, grace, workdays) and whether to enable it in production now.
3. Missing clock-out policy: flag only (recommended) vs desktop prompt vs auto clock-out on screen lock (reference behaviour; conflicts with immutable history and the Windows lock→break feature).
4. Admin-initiated corrections: two-admin approval vs Super Admin self-approval with audit flag.
5. Email recipients: accounts only (recommended) vs free-form addresses; default digest time and timezone.
6. HR/Legal: final monitoring notice wording and retention periods.
7. Domain name for production (certificate and cookie setup).
