# Insight Workfolio — Current State (production + `main`)

Audited 2026-11-19 (~23:15–23:30 IST). Two sources, kept separate:

- **Production** `https://189.72.144.117/` inspected through Claude in Chrome, signed in as the Super Admin account
  (read-only browsing; no form saved).
- **Repository** `insight-workfolio` on `main` @ `0493e54` (code and docs read; nothing run against production).

Legend: **[P]** observed in production · **[C]** present in code on `main` · **[D]** stated in repo docs only · **[I]** inference.

Employee names are replaced by employee codes (101, 102, 105, 106).

---

## 1. Production is behind `main`

| Evidence | Meaning |
|---|---|
| [P] `/notifications` → Next.js **404** | `main` commit `2f43266` (notifications page, migration `0033_notifications`, 2026-11-19) is **not deployed** |
| [P] `/desktop-updates` renders | commit `6940607` (2026-11-17) **is** deployed |
| [D] `docs/status/HOSTINGER-VPS-IMPLEMENTATION-STATUS.md` records first launch from `deploy/hostinger-vps` @ `2cceaa1` (2026-11-10) | later redeploys are not recorded in the repo |
| [I] | production most likely runs `deploy/hostinger-vps` / `main` @ `4215c8e` (2026-11-17). **Not verifiable** from the browser: `/api/v1/health` returns `{status, uptimeSeconds, timestamp}` with no version/commit |
| [P] API uptime 102 957 s at 17:48 UTC | API last restarted ≈ 2026-11-18 13:12 UTC |

Consequence: features below marked **[C]** but not **[P]** exist only in code.

## 2. What production shows (admin)

| Page | Observed [P] |
|---|---|
| Shell | Dark theme in this browser (dashboard follows the OS `prefers-color-scheme`; a light theme exists in `globals.css` [C]); header "API connected", account email, "Super Admin" badge, Sign out. Sidebar groups Overview / People / Time / Monitoring / Work / Reports / Administration |
| Overview | KPI cards only: Active employees 4, Working now 1, On a break 0, Clocked out today 2, Not clocked in 3, Net work today, Breaks today, Screenshots stored today 11, **Late/absent today "—" (Work schedule not configured)**, pending leave/corrections, projects, tasks. Long explanatory banner. **No charts, no lists, no screenshots, no drill-down** |
| Attendance › Live | Table refreshed every 30 s: status, activity, clocked-in time, breaks, net time, screenshots state, last sync/device seen. Search. Read-only |
| Attendance › Daily | Per-date status vs schedule; all 4 employees "No schedule" because the **work schedule is off** |
| Timesheets | Range filter, This/Last week, per-employee shifts/worked/breaks/overtime/needs attention; **Export CSV / XLSX** (draft format) |
| Corrections | Pending / Approved / Rejected / All; empty |
| Reports | "Email reports": schedule form (daily/weekly/monthly, timezone, all or one employee, project time). Banner: **"No email provider is configured … nothing is emailed."** Plus an activity overview table |
| Alerts | 4 rule kinds (late clock-in, not clocked in by, idle share, no activity for N min); **no rules configured**; "nothing is emailed" |
| Settings | Activity monitoring (sampling 15 s, idle 300 s, retention 30 d **not approved**), monitoring notices (all three versions labelled **Draft**), screenshots (enabled, 300 s, WebP, masks, blur, retention 30 d not approved, timelapse auto off), storage: Microsoft 365 / OneDrive **connected**, 0.29 GB used |
| Work schedule | **Off, never configured** ("values are proposals pending business approval") |
| Employees | 4 employees; detail page = edit form (name, email, code, timezone, status), account access (disable, new setup link, invitation state), devices (sign-in, revoke), per-person blur, per-person schedule/idle/screenshot visibility overrides. **No analytics on the employee page** (tabs link to Timesheet / Activity / Screenshots) |
| Screenshots | Employee + date-range filters, counters (202 stored, 0 awaiting upload), retention box, thumbnail grid, timelapse per session |
| Activity | Weekly table: clocked in, active, idle, unobserved, last upload |
| Audit | Filterable log (source, action, actor, target); 1 187 events this week |
| Desktop app updates | No releases published; all 4 devices "Installed: unknown / Not reported" |
| `/my` (employee panel) | The Super Admin account has no employee profile → "no personal activity to show". **Employee panel not verifiable in the browser**; code exists [C] (`/my`, `/my/attendance`, `/my/leave`, `/my/screenshots`, `/my/team/*`, …) |

### Data-quality issues seen in production [P]

1. Employee 102 shown **"Clocked in"** since 16:18 with last device contact 17:06 and the time 23:17 — an open shift with no live device for 6 h, still labelled "Online". (The reference app showed the same person clocked out at 19:28.) → no missing-clock-out detection, and the "Online" label is not tied to freshness.
2. Employee 106: "Last shift **26 h 53 m**", timesheet overtime 19 h 08 m, 25 h 59 m "unobserved" → a shift left open overnight.
3. Employee 101: **21 h 49 m of breaks** this week → a break left open for most of a day.
4. All desktops report version "unknown" → update telemetry not reaching the server from installed builds.
5. Late/absent figures are blank org-wide because the schedule is off — a **configuration decision**, not missing code.

## 3. Architecture verified in code [C]

| Note in the brief | Verified |
|---|---|
| Monorepo, pnpm, TypeScript | ✓ pnpm 11, TS 6, workspaces `apps/*`, `packages/*` |
| `apps/api` NestJS | ✓ 25 modules (attendance, schedule, alerts, reports, notifications, leave, holidays, teams, roles, projects, screenshots/timelapse, activity, websites, storage, desktop-updates, audit, …) |
| `apps/dashboard` Next.js | ✓ Next 16.4, React 19.3, Tailwind 4; **no chart library** (charts would be hand-made SVG) |
| `apps/desktop` Tauri | ✓ Tauri 2, Rust core (offline SQLite queue, activity collector, screenshots, tray, lock→break on Windows) |
| Turso/libSQL | ✓ `@libsql/client`; **production uses a local SQLite file on the VPS** (`file:/var/lib/workfolio/db/workfolio.db`), Turso still supported |
| OneDrive/SharePoint | ✓ Microsoft Graph delegated, connected in production |
| Roles | ✓ `ADMIN`/`EMPLOYEE` permission roles + `SUPER_ADMIN` identity + team heads (scoped reads). 39 permissions in `packages/shared/src/roles.ts`; Super-Admin-only: screenshot deletion, storage, roles, update publishing |
| Also present | `apps/browser-extension` (website domain tracking), Caddy + systemd deployment (`deploy/`), 6 GitHub workflows |

### Attendance data model already in place [C]

`attendance_sessions`, `break_sessions` (DB triggers forbid overlaps/double-open), `attendance_events` (append-only,
idempotent, device-clock skew corrected), `correction_requests` + `attendance_corrections` (append-only, approver ≠
requester), `work_schedule_policies` (versioned, org-wide; per-employee overrides in `employee_tracking_overrides`),
`holidays`, `leave_requests`/`leave_types`, `teams`/`team_members`, `alert_rules`/`alerts`.
Endpoints: clock-in/out, break start/end, offline sync, current, history, timeline, timesheet(s) + export (CSV/XLSX),
summary, overview, daily (late/absent/leave), expected, corrections CRUD/approve/reject.

### Email infrastructure already in place [C]

- `notifications` module (main only, **not deployed**): event → routing matrix → recipients from accounts → queue table +
  60 s timer → Graph `sendMail` → delivery log, 4 attempts with backoff, dedupe key, dashboard page, CLI.
- `reports` module (deployed): scheduled daily/weekly/monthly attendance summaries, recipients = user accounts, one run
  per period, leases, retries; **transport `none`/`mock` only** (`REPORT_MAIL_PROVIDER`).
- `alerts` module (deployed): late / not-clocked-in / idle / no-activity rules, one alert per rule-employee-day,
  **in-app only**; `sendAlertEmails` hook is a no-op.
- Invitations use the same Graph transport (sender configured server-side; not hard-coded in this plan).

## 4. Comparison matrix

Status values for **Our Workfolio**: Existing · Partial · Missing · Not verifiable. "Existing" requires working
behaviour, not just a nav item. Priority: P0 (do first) … P3 (optional).

| Module | Actual Workfolio | Our Workfolio | Gap | Priority |
|---|---|---|---|---|
| Overview — live KPIs | 5 live counters | **Existing** (more counters) | Visual density; no team/date filter | P1 |
| Overview — charts & lists (workload, top apps, late, absent, recent screenshots, hours table, holidays, leaves) | Yes | **Missing** | Build widgets on existing endpoints | P1 |
| My Team live cards | Card per member + status chips | **Partial** (Live attendance table) | Card view, status filter chips, "yet to start", "app not installed" | P2 |
| Employee drill-down (personal statistics) | KPI cards, charts, clock in/out log | **Partial** (edit form + links to filtered pages) | Analytics profile page | P1 |
| Clock in/out, breaks (employee) | Desktop agent | **Existing** [C] desktop + API; employee web panel **Not verifiable** in browser | — | — |
| Late arrivals | Overview + report + email | **Partial**: logic exists, **schedule off** in prod; one org schedule + per-person override | Enable schedule (decision); late report page | **P0** |
| Absence | Overview + report + email | **Partial** (daily view; needs schedule) | Same as above | **P0** |
| Missing clock-out | Auto clock-out on screen lock | **Missing** (open shifts stay open; seen in prod) | Detection + alert + admin correction path | **P0** |
| Attendance corrections + audit | Manual Time approve/reject | **Existing** (employee-requested, different-admin approval, append-only audit) | Admin-initiated correction for an employee | P1 |
| Timesheet grid / export | Grid + column filter + export | **Existing** (summary + CSV/XLSX draft) | Day-grid layout, format approval | P2 |
| Monthly attendance / In-Out matrix / Overtime reports | Yes | **Partial** (timesheet totals, overtime flag) | Monthly matrix views + export | P1 |
| Department/team filter | "All Team" everywhere | **Partial** (teams exist; filter not on all pages) | Global team filter | P1 |
| Shifts (multiple) | Shift Time report, create shifts | **Partial** (one org schedule + per-person start/workdays) | Multiple named shifts | P3 |
| Screenshots | Grid, idle border, export, delete | **Existing** (grid, masks, blur, access log, retention, Super-Admin delete) | Idle marker, bulk export | P2 |
| Timelapse | On-demand per day | **Existing** (per session, optional auto) | — | — |
| Activity / apps usage | Review apps, history, summary donut | **Partial** (activity totals, app labels page) | Charts, per-app history UI | P2 |
| Timeline (Gantt) | Yes | **Partial** (`/attendance/timeline`, `/activity/timeline` APIs) | Gantt UI | P2 |
| Risk users | Rule-based list | **Partial** (alert rules: idle share, no activity) | "Less working hours" rule kind, risk list view | P3 |
| Websites | Within apps usage | **Existing** (extension, domain-only, opt-in) | — | — |
| Leave (apply, balances, approve, holidays, import) | Yes | **Existing** [C]/[P] pages | Short leave; UI polish | P3 |
| Projects / tasks | Premium toggles | **Existing** (projects, tasks, time entries) | — | — |
| Email scheduled reports | Worked hours / Late / Absent; daily/weekly/monthly; time; recipients | **Partial**: pipeline exists, **no provider** | Wire Graph transport; late/absent report types; send-at time | **P0** |
| Event emails (clock-in/out, late, absence, missing clock-out) | Not observed (real-time alerts premium) | **Missing** (alerts in-app only) | Rules + digest via notifications module | P1 |
| Notification log / retries | [?] | **Existing in code, not deployed** | Deploy `0033` | P0 |
| Roles & permissions | Admin / Team head / Employee + toggles | **Existing** (Super Admin, Admin, team heads, Employee, server-enforced) | — | — |
| Audit log | [?] not visible | **Existing** (screenshot views, settings, roles, corrections) | — | — |
| Rebrand (name/logo) | Yes | **Missing** | Low value for single-tenant | P3 |
| Billing | Yes | N/A (self-hosted) | — | — |
| Login IP report | Yes | **Missing** | Privacy review first | P3 |
| Keyboard/mouse counts | Premium | **Deliberately not collected** (privacy design) | Keep excluded | — |
| Desktop update management | [?] | **Existing** (no release published; devices report "unknown") | Fix version reporting | P1 |
| UI: light, compact, charts | Yes | **Partial** (light theme exists but follows OS; text-heavy; no charts) | UI foundation phase | P1 |

## 5. UI consistency notes [P]

- Every page opens with a long explanatory paragraph; useful for compliance, heavy for daily use → move to an "ⓘ" popover or a collapsible "About this page".
- Tables are clean but wide; status chips exist (green "Clocked in", "Active"); no sortable headers.
- Settings is one very long page (activity, notices, retention, screenshots, masks, storage) → split into sub-pages like the reference.
- No global date/team selector; each page has its own range inputs.
- Dark appearance is automatic; there is no explicit theme toggle.
