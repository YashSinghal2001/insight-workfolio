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
| P0-04 | Build version in `/health` (version + commit) | 0 | W1-RELEASE | Complete | Pass | Pass | Pass | Pass | Done | `commit` null until owner reinstalls the unit (install-vps.sh) and deploys with new deploy.sh |
| P0-05 | Identify the production commit | 0 | Owner | Pending | N/A | N/A | N/A | N/A | Blocked | Needs read-only SSH (`readlink /opt/workfolio/current`) |
| P0-06 | Repository consolidation (worktrees/branches/folders) | 0 | Owner | Pending | N/A | N/A | N/A | N/A | Blocked | Proposal: `docs/audit/REPOSITORY-CONSOLIDATION-PLAN.md`; nothing deleted |
| P1-01 | Light default theme + explicit toggle | 1 | W1-UI | Complete | Pass | Pass | Pass | Pass | Done | verify:web-app theme check passes |
| P1-02 | Design tokens, compact density | 1 | W1-UI | Complete | Pass | Pass | Pass | Pass | Done | |
| P1-03 | Sidebar + top bar + final route map | 1 | W1-UI | Complete | Pass | Pass | Pass | Pass | Done | Nav lists existing routes only |
| P1-04 | Global date / team filters | 1 | W1-UI | Complete | Pass | Pass | Pass | Pass | Done | No page opts in yet (wave 2) |
| P1-05 | Shared components (sortable table, About disclosure, sub-nav) | 1 | W1-UI | Complete | Pass | Pass | Pass | Pass | Done | Settings + Reports SubNav layouts |
| P1-06 | SVG charts (bar, stacked bar, donut, Gantt strip, sparkline) | 1 | W1-CHARTS | Complete | Pass | Pass | Pass | Pass | Done | Review: bar clamp + fallback colours fixed |
| P1-07 | Settings split into sub-pages | 1 | W2-SETTINGS | Complete | Pass | Pass | Pass | Pass | Done | Settings split into 8 sub-pages; OAuth return forwarded |
| P1-08 | Responsive layout (1440/1024/768/375) | 1 | W1-UI + page owners | Complete | Pass | Pass | Pass | Pass | Done | Responsive checks 1440/1024/768/375/360 in web-app + parity |
| P2-01 | Overview aggregate endpoint + KPI strip | 2 | W2-OVERVIEW | Complete | Pass | Pass | Pass | Pass | Done | GET /overview; 108 employees ~0.37 s in suite |
| P2-02 | Workload analysis chart | 2 | W2-OVERVIEW | Complete | Pass | Pass | Pass | Pass | Done | |
| P2-03 | Top apps donut | 2 | W2-OVERVIEW | Complete | Pass | Pass | Pass | Pass | Done | Reuses ActivityService.appTotals |
| P2-04 | Late / absent / missing clock-out lists | 2 | W2-OVERVIEW | Complete | Pass | Pass | Pass | Pass | Done | |
| P2-05 | Recent screenshots (access-logged) | 2 | W2-OVERVIEW | Complete | Pass | Pass | Pass | Pass | Done | Gallery metadata only; thumbnails access-logged |
| P2-06 | Work hours summary table | 2 | W2-OVERVIEW | Complete | Pass | Pass | Pass | Pass | Done | |
| P2-07 | Upcoming holidays & leaves, pending approvals | 2 | W2-OVERVIEW | Complete | Pass | Pass | Pass | Pass | Done | |
| P2-08 | Live Team card page + status chips | 2 | W2-LIVETEAM | Complete | Pass | Pass | Pass | Pass | Done | /live-team; worked today sums all shifts |
| P2-09 | Employee profile analytics | 2 | W2-PROFILE | Complete | Pass | Pass | Pass | Pass | Done | GET /employees/:id/analytics, audited; Overview/Edit tabs |
| P3-01 | Missing clock-out / stale device / long break detection | 3 | W1-ATT-ANOMALY | Complete | Pass | Pass | Pass | Pass | Done | Flag only |
| P3-02 | Admin-initiated corrections (API) | 3 | W1-ATT-ANOMALY | Complete | Pass | Pass | Pass | Pass | Done | API only; one-admin org cannot approve (owner decision) |
| P3-03 | `teamId` filter on attendance endpoints | 3 | W1-ATT-DATA | Complete | Pass | Pass | Pass | Pass | Done | |
| P3-04 | Monthly attendance data + XLSX/CSV export | 3 | W1-ATT-DATA | Complete | Pass | Pass | Pass | Pass | Done | 100×31 in 0.27 s |
| P3-05 | Late arrivals report API | 3 | W1-ATT-DATA | Complete | Pass | Pass | Pass | Pass | Done | |
| P3-06 | Overtime data | 3 | W1-ATT-DATA | Complete | Pass | Pass | Pass | Pass | Done | In monthly rows |
| P3-07 | Live status freshness ("Online" only when fresh) | 3 | W1-ATT-DATA | Complete | Pass | Pass | Pass | Pass | Done | API fields; UI label fix in W2-ATTENDANCE-UI |
| P3-08 | Attendance page tabs (live, daily, monthly, late, missing clock-out, corrections) | 3 | W2-ATTENDANCE-UI | Complete | Pass | Pass | Pass | Pass | Done | Tabs Live/Daily/Monthly/Late/Missing; 'Online' only when fresh |
| P3-09 | Desktop "still clocked in" banner (informational) | 3 | W1-RELEASE | Complete | Pass | Pass | Pass | Pass | Done | Live region announces once |
| P4-01 | Notification rules + recipients (migration 0034) | 4 | W1-NOTIFY | Complete | Pass | Pass | Pass | Pass | Done | |
| P4-02 | Clock-in / clock-out events + daily digest | 4 | W1-NOTIFY | Complete | Pass | Pass | Pass | Pass | Done | Review: per-minute writes removed; hook outside lock |
| P4-03 | Late arrival / absence notifications | 4 | W1-NOTIFY | Complete | Pass | Pass | Pass | Pass | Done | |
| P4-04 | Missing clock-out notifications | 4 | W1-NOTIFY | Complete | Pass | Pass | Pass | Pass | Done | Wired in wave 1 (moved from W2) |
| P4-05 | Report kinds LATE/ABSENT, send time, team scope (migration 0035) | 4 | W1-REPORTS-SCHED | Complete | Pass | Pass | Pass | Pass | Done | |
| P4-06 | Microsoft Graph transport for reports (off by default) | 4 | W1-REPORTS-SCHED | Complete | Pass | Pass | Pass | Pass | Done | Default provider none; mock in tests |
| P4-07 | Notification rules settings UI + delivery log | 4 | W2-SETTINGS | Complete | Pass | Pass | Pass | Pass | Done | Done by W2-SETTINGS (/settings/notifications) + recipient-candidates API |
| P4-08 | Retry / delivery logs (existing module) | 4 | W1-NOTIFY | Complete | Pass | Pass | Pass | Pass | Done | |
| P5-01 | Employee list filters (team, role, OS, app version) | 5 | W2-SETTINGS | Complete | Pass | Pass | Pass | Pass | Done | teamId/role/platform/appVersion filters |
| P5-02 | Team and role management polish | 5 | W2-SETTINGS | Complete | Pass | Pass | Pass | Pass | Done | Recipient candidates endpoint; teams scoped for heads |
| P5-03 | Reports hub + detailed report pages | 5 | W2-REPORTS | Complete | Pass | Pass | Pass | Pass | Done | 6 report sub-pages |
| P5-04 | Summary / custom XLSX report | 5 | W2-REPORTS | Complete | Pass | Pass | Pass | Pass | Done | summary-report + daily export (server XLSX); 41,400-shift scale test |
| P5-05 | Leave balances polish | 5 | W2-SETTINGS | Complete | Pass | Pass | Pass | Pass | Done | Leave types moved to settings; balances tab kept |
| P5-06 | Scheduled report configuration UI | 5 | W1-REPORTS-SCHED | Complete | Pass | Pass | Pass | Pass | Done | verify:reports 11/11, Preview restored |
| P5-07 | Timesheet week grid | 5 | W2-REPORTS | Complete | Pass | Pass | Pass | Pass | Done | Week grid tab |
| P6-01 | Timeline Gantt | 6 | W3-TIMELINE | Complete | Pass | Pass | Pass | Pass | Done | /timeline + GET /activity/team-timeline |
| P6-02 | App usage charts + per-app history | 6 | W3-APPS | Complete | Pass | Pass | Pass | Pass | Done | /activity tabs + /activity/apps(/history) |
| P6-03 | Screenshot idle indicator | 6 | W3-TIMELINE | Complete | Pass | Pass | Pass | Pass | Done | Idle derived from activity intervals (no schema) |
| P6-04 | Bulk screenshot export (Super Admin, logged) | 6 | W3-TIMELINE | Complete | Pass | Pass | Pass | Pass | Done | Super Admin only; aborts on mid-stream failure; access-logged + audited |
| P6-05 | Timelapse workflows (verify existing) | 6 | W3-TIMELINE | Complete | Pass | Pass | Pass | Pass | Done | Unchanged; timelapse suite 22/22 |
| P6-06 | Risk users (computed, no schema change) | 6 | W3-APPS | Complete | Pass | Pass | Pass | Pass | Done | Computed; less-hours 7/8 constant |
| P6-07 | Employee panel: missing clock-out banner, monthly calendar; team-head views | 6 | W3-EMPLOYEE | Complete | Pass | Pass | Pass | Pass | Done | Banner, monthly calendar, team-head Late/Missing |
| P7-01 | Admin E2E flows | 7 | W4-E2E | Complete | N/A | Pass | Pass | Pass | Done | verify:parity 65/65 + 14 existing suites |
| P7-02 | Employee E2E flows | 7 | W4-E2E | Complete | N/A | Pass | Pass | Pass | Done | |
| P7-03 | Team-head permission E2E | 7 | W4-E2E | Complete | N/A | Pass | Pass | Pass | Done | parity-rbac-matrix (25) + teamhead 27/27 |
| P7-04 | Desktop → API → dashboard attendance flow | 7 | W4-E2E | Complete | N/A | Pass | Pass | Pass | Done | Simulated device incl. skewed offline sync |
| P7-05 | Notification mock delivery E2E | 7 | W4-E2E | Complete | N/A | Pass | Pass | Pass | Done | Mock transport only |
| P7-06 | macOS desktop verification (cargo test, clippy, build) | 7 | W1-RELEASE | Complete | Pass | Pass | Pass | Pass | Done | cargo test 108, clippy ok; Windows cargo check (gnu) ok |
| P7-07 | Windows desktop verification | 7 | Owner (CI) | Pending | N/A | N/A | N/A | Pending | Blocked | Partial: `cargo check --target x86_64-pc-windows-gnu` passes on the Mac; runtime + installer verification needs the Windows CI job (push) or a Windows machine |
| P7-08 | Backup / restore drill | 7 | W4-E2E | Complete | N/A | Pass | Pass | Pass | Done | docs/status/BACKUP-RESTORE-DRILL.md; gpg path untested (no gpg locally) |
| P7-09 | Performance: overview with 200 employees < 1 s | 7 | W4-E2E | Complete | N/A | Pass | Pass | Pass | Done | overview p95 97 ms, page 643 ms @200 employees |
| P7-10 | RBAC / security review of all new routes | 7 | W4-SECURITY | Complete | Pass | Pass | Pass | Pass | Done | 1 fix: self-approval via on-behalf correction |
| P7-11 | Pre-existing time-of-day test failures | 7 | W4-E2E | Complete | Pass | Pass | Pass | N/A | Done | Deterministic seeding; verified at shifted clocks |
| P8-01 | Deployment, migration, rollback and smoke-test documentation | 8 | W4-RELEASE-DOCS | Complete | N/A | Pass | N/A | N/A | Done | docs/status/PRODUCTION-READINESS.md + deploy record template |
| P8-02 | Production deployment | 8 | Owner | Pending | N/A | N/A | N/A | N/A | Blocked | Requires explicit owner approval |

## Wave log

| Wave | Agents | Started | Integrated | Notes |
|---|---|---|---|---|
| 1 | W1-UI, W1-CHARTS, W1-ATT-ANOMALY, W1-ATT-DATA, W1-NOTIFY, W1-REPORTS-SCHED, W1-RELEASE | 2026-11-20 | 2026-11-20 (`1ea835e`) | Gates 17/17; API 608/608; dashboard units 49; smoke 38; verify:web-app 92/92, verify:reports 11/11, verify:my-panel 45/46 (pre-existing desktop-downloads assertion). Two reviews: no blockers; 9 findings fixed by owners. Usage-limit interruption resumed. Approved cleanup: cargo clean in -lockbreak and -distribution worktrees (6.5 GB). |
| 2 | W2-OVERVIEW, W2-LIVETEAM, W2-ATTENDANCE-UI, W2-PROFILE, W2-REPORTS, W2-SETTINGS | 2026-11-20 | 2026-11-20 (`6e32822`) | Gates 17/17; API 639/639; dashboard units 90; smoke 51 routes; browser: web-app 105/105, reports 11, wave2 57, schedule 21, masks 14, labels 18, invitations 11, teamhead 27, gallery 18, timelapse 22, xlsx 11, setup-password 14; my-panel 45/46 (pre-existing); web-product 13/15 (stale expectations, assigned to W3-APPS). Two reviews: no blockers; 1 major backend (summary-report SQL variable limit) + 1 major frontend (stale response) + minors fixed by owners. Next.js 16.4.3→16.4.6 security patch. |
| 3 | W3-TIMELINE, W3-APPS, W3-EMPLOYEE | 2026-11-20 | 2026-11-20 (`ded9c62`) | Review: 1 major (export truncation) + 6 minor fixed; gallery regression fixed. |
| 4 | W4-SECURITY, W4-RELEASE-DOCS, W4-E2E | 2026-11-20 | 2026-11-20 (`09a3e00`) | Final: gates 17/17; API 684/684; shared 116; database 51; dashboard units 115; smoke 53 routes; 15 browser suites 473/473 (parity 65). |
