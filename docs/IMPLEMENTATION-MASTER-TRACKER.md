# Implementation Master Tracker

Programme: product parity per `docs/audit/IMPLEMENTATION-ROADMAP.md`. Contracts: `docs/IMPLEMENTATION-CONTRACTS.md`.
Integration branch: `integration/product-parity` (base `main` @ `0493e54`). Nothing is merged to `main`, pushed or deployed.

Status values: Implementation Pending / In Progress / Complete · tests, review, integration, E2E Pending / Pass / Fail / N/A ·
a feature is **Done** only when every applicable column is Pass.

## Baseline (2026-11-20, `main` code, before any change)

Build, typecheck and lint pass for every package; unit tests pass (shared, database, extension, desktop TS, dashboard lib).
API integration: **544 / 550 pass**; 6 failures are pre-existing and time-of-day dependent (run at 01:14 UTC; seeded
"3 h ago" sessions cross UTC midnight): `screenshots-gallery` (1), `self-service` (3), `team-head-scope` summary (1),
`timelapse` frames (1). Tracked as P7-11.

## Features

| Feature ID | Feature | Phase | Assigned Agent | Implementation | Unit Tests | Code Review | Integration | E2E | Status | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| P0-01 | Verified backup (git bundle of all refs + folder tar, SHA-256) | 0 | Lead | Complete | N/A | N/A | N/A | N/A | Done | `~/Backups/insight-workfolio-20261120/` (bundle verified, 28 refs). Contains `.env.staging` — must not leave the Mac |
| P0-02 | Preserve uncommitted installer work | 0 | Lead | Complete | N/A | N/A | N/A | N/A | Done | Refs `refs/backup/installer-release-manager-wip-20261120`, `refs/backup/installer-distribution-untracked-20261120`; worktrees untouched |
| P0-03 | Integration branch + baseline gates | 0 | Lead | Complete | Pass | N/A | N/A | N/A | Done | See Baseline |
| P0-04 | Build version in `/health` (version + commit) | 0 | W1-RELEASE | Pending | Pending | Pending | Pending | Pending | Pending | |
| P0-05 | Identify the production commit | 0 | Owner | Pending | N/A | N/A | N/A | N/A | Blocked | Needs read-only SSH (`readlink /opt/workfolio/current`) |
| P0-06 | Repository consolidation (worktrees/branches/folders) | 0 | Owner | Pending | N/A | N/A | N/A | N/A | Blocked | Proposal: `docs/audit/REPOSITORY-CONSOLIDATION-PLAN.md`; nothing deleted |
| P1-01 | Light default theme + explicit toggle | 1 | W1-UI | Pending | Pending | Pending | Pending | Pending | Pending | |
| P1-02 | Design tokens, compact density | 1 | W1-UI | Pending | Pending | Pending | Pending | Pending | Pending | |
| P1-03 | Sidebar + top bar + final route map | 1 | W1-UI | Pending | Pending | Pending | Pending | Pending | Pending | |
| P1-04 | Global date / team filters | 1 | W1-UI | Pending | Pending | Pending | Pending | Pending | Pending | |
| P1-05 | Shared components (sortable table, About disclosure, sub-nav) | 1 | W1-UI | Pending | Pending | Pending | Pending | Pending | Pending | |
| P1-06 | SVG charts (bar, stacked bar, donut, Gantt strip, sparkline) | 1 | W1-CHARTS | Pending | Pending | Pending | Pending | Pending | Pending | |
| P1-07 | Settings split into sub-pages | 1 | W2-SETTINGS | Pending | Pending | Pending | Pending | Pending | Pending | |
| P1-08 | Responsive layout (1440/1024/768/375) | 1 | W1-UI + page owners | Pending | Pending | Pending | Pending | Pending | Pending | |
| P2-01 | Overview aggregate endpoint + KPI strip | 2 | W2-OVERVIEW | Pending | Pending | Pending | Pending | Pending | Pending | |
| P2-02 | Workload analysis chart | 2 | W2-OVERVIEW | Pending | Pending | Pending | Pending | Pending | Pending | |
| P2-03 | Top apps donut | 2 | W2-OVERVIEW | Pending | Pending | Pending | Pending | Pending | Pending | |
| P2-04 | Late / absent / missing clock-out lists | 2 | W2-OVERVIEW | Pending | Pending | Pending | Pending | Pending | Pending | |
| P2-05 | Recent screenshots (access-logged) | 2 | W2-OVERVIEW | Pending | Pending | Pending | Pending | Pending | Pending | |
| P2-06 | Work hours summary table | 2 | W2-OVERVIEW | Pending | Pending | Pending | Pending | Pending | Pending | |
| P2-07 | Upcoming holidays & leaves, pending approvals | 2 | W2-OVERVIEW | Pending | Pending | Pending | Pending | Pending | Pending | |
| P2-08 | Live Team card page + status chips | 2 | W2-LIVETEAM | Pending | Pending | Pending | Pending | Pending | Pending | |
| P2-09 | Employee profile analytics | 2 | W2-PROFILE | Pending | Pending | Pending | Pending | Pending | Pending | |
| P3-01 | Missing clock-out / stale device / long break detection | 3 | W1-ATT-ANOMALY | Pending | Pending | Pending | Pending | Pending | Pending | Flag only (decision default) |
| P3-02 | Admin-initiated corrections (API) | 3 | W1-ATT-ANOMALY | Pending | Pending | Pending | Pending | Pending | Pending | Different-admin approval kept |
| P3-03 | `teamId` filter on attendance endpoints | 3 | W1-ATT-DATA | Pending | Pending | Pending | Pending | Pending | Pending | |
| P3-04 | Monthly attendance data + XLSX/CSV export | 3 | W1-ATT-DATA | Pending | Pending | Pending | Pending | Pending | Pending | |
| P3-05 | Late arrivals report API | 3 | W1-ATT-DATA | Pending | Pending | Pending | Pending | Pending | Pending | |
| P3-06 | Overtime data | 3 | W1-ATT-DATA | Pending | Pending | Pending | Pending | Pending | Pending | In monthly rows |
| P3-07 | Live status freshness ("Online" only when fresh) | 3 | W1-ATT-DATA | Pending | Pending | Pending | Pending | Pending | Pending | Production anomaly #1 |
| P3-08 | Attendance page tabs (live, daily, monthly, late, missing clock-out, corrections) | 3 | W2-ATTENDANCE-UI | Pending | Pending | Pending | Pending | Pending | Pending | |
| P3-09 | Desktop "still clocked in" banner (informational) | 3 | W1-RELEASE | Pending | Pending | Pending | Pending | Pending | Pending | |
| P4-01 | Notification rules + recipients (migration 0034) | 4 | W1-NOTIFY | Pending | Pending | Pending | Pending | Pending | Pending | |
| P4-02 | Clock-in / clock-out events + daily digest | 4 | W1-NOTIFY | Pending | Pending | Pending | Pending | Pending | Pending | |
| P4-03 | Late arrival / absence notifications | 4 | W1-NOTIFY | Pending | Pending | Pending | Pending | Pending | Pending | |
| P4-04 | Missing clock-out notifications | 4 | W2-NOTIFY-UI | Pending | Pending | Pending | Pending | Pending | Pending | Needs P3-01 |
| P4-05 | Report kinds LATE/ABSENT, send time, team scope (migration 0035) | 4 | W1-REPORTS-SCHED | Pending | Pending | Pending | Pending | Pending | Pending | |
| P4-06 | Microsoft Graph transport for reports (off by default) | 4 | W1-REPORTS-SCHED | Pending | Pending | Pending | Pending | Pending | Pending | Mock only in dev/test |
| P4-07 | Notification rules settings UI + delivery log | 4 | W2-NOTIFY-UI | Pending | Pending | Pending | Pending | Pending | Pending | |
| P4-08 | Retry / delivery logs (existing module) | 4 | W1-NOTIFY | Pending | Pending | Pending | Pending | Pending | Pending | |
| P5-01 | Employee list filters (team, role, OS, app version) | 5 | W2-SETTINGS | Pending | Pending | Pending | Pending | Pending | Pending | |
| P5-02 | Team and role management polish | 5 | W2-SETTINGS | Pending | Pending | Pending | Pending | Pending | Pending | |
| P5-03 | Reports hub + detailed report pages | 5 | W2-REPORTS | Pending | Pending | Pending | Pending | Pending | Pending | |
| P5-04 | Summary / custom XLSX report | 5 | W2-REPORTS | Pending | Pending | Pending | Pending | Pending | Pending | |
| P5-05 | Leave balances polish | 5 | W2-LEAVE | Pending | Pending | Pending | Pending | Pending | Pending | |
| P5-06 | Scheduled report configuration UI | 5 | W1-REPORTS-SCHED | Pending | Pending | Pending | Pending | Pending | Pending | |
| P5-07 | Timesheet week grid | 5 | W2-REPORTS | Pending | Pending | Pending | Pending | Pending | Pending | |
| P6-01 | Timeline Gantt | 6 | W3-TIMELINE | Pending | Pending | Pending | Pending | Pending | Pending | |
| P6-02 | App usage charts + per-app history | 6 | W3-APPS | Pending | Pending | Pending | Pending | Pending | Pending | |
| P6-03 | Screenshot idle indicator | 6 | W3-TIMELINE | Pending | Pending | Pending | Pending | Pending | Pending | |
| P6-04 | Bulk screenshot export (Super Admin, logged) | 6 | W3-TIMELINE | Pending | Pending | Pending | Pending | Pending | Pending | |
| P6-05 | Timelapse workflows (verify existing) | 6 | W3-TIMELINE | Pending | Pending | Pending | Pending | Pending | Pending | |
| P6-06 | Risk users (computed, no schema change) | 6 | W3-APPS | Pending | Pending | Pending | Pending | Pending | Pending | |
| P6-07 | Employee panel: missing clock-out banner, monthly calendar; team-head views | 6 | W3-EMPLOYEE | Pending | Pending | Pending | Pending | Pending | Pending | |
| P7-01 | Admin E2E flows | 7 | W4-E2E | Pending | N/A | Pending | Pending | Pending | Pending | |
| P7-02 | Employee E2E flows | 7 | W4-E2E | Pending | N/A | Pending | Pending | Pending | Pending | |
| P7-03 | Team-head permission E2E | 7 | W4-E2E | Pending | N/A | Pending | Pending | Pending | Pending | |
| P7-04 | Desktop → API → dashboard attendance flow | 7 | W4-E2E | Pending | N/A | Pending | Pending | Pending | Pending | |
| P7-05 | Notification mock delivery E2E | 7 | W4-E2E | Pending | N/A | Pending | Pending | Pending | Pending | |
| P7-06 | macOS desktop verification (cargo test, clippy, build) | 7 | W1-RELEASE | Pending | Pending | Pending | Pending | Pending | Pending | |
| P7-07 | Windows desktop verification | 7 | Owner (CI) | Pending | N/A | N/A | N/A | Pending | Blocked | Needs the Windows CI job (push) or a Windows machine |
| P7-08 | Backup / restore drill | 7 | W4-E2E | Pending | N/A | Pending | Pending | Pending | Pending | |
| P7-09 | Performance: overview with 200 employees < 1 s | 7 | W4-E2E | Pending | N/A | Pending | Pending | Pending | Pending | |
| P7-10 | RBAC / security review of all new routes | 7 | W4-SECURITY | Pending | Pending | Pending | Pending | Pending | Pending | |
| P7-11 | Pre-existing time-of-day test failures | 7 | W4-E2E | Pending | Pending | Pending | Pending | N/A | Pending | |
| P8-01 | Deployment, migration, rollback and smoke-test documentation | 8 | W4-RELEASE-DOCS | Pending | N/A | Pending | N/A | N/A | Pending | |
| P8-02 | Production deployment | 8 | Owner | Pending | N/A | N/A | N/A | N/A | Blocked | Requires explicit owner approval |

## Wave log

| Wave | Agents | Started | Integrated | Notes |
|---|---|---|---|---|
| 1 | W1-UI, W1-CHARTS, W1-ATT-ANOMALY, W1-ATT-DATA, W1-NOTIFY, W1-REPORTS-SCHED, W1-RELEASE | 2026-11-20 | | |
