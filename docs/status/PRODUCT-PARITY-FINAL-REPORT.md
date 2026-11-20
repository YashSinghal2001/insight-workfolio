# Product Parity Programme — Final Report

Date: 2026-11-20 · Branch: `integration/product-parity` (base `main` @ `0493e54`, 120 commits, 283 files, +20 191 / −1 732).
Nothing was merged into `main`, pushed, or deployed. No production system, database, environment file or DNS was touched.
No real email was sent (mock / `none` transports only). Tracker: `docs/IMPLEMENTATION-MASTER-TRACKER.md` (63 Done, 4 Blocked on owner).
Contracts: `docs/IMPLEMENTATION-CONTRACTS.md`. Agent plans: `docs/status/agent-plans/`.

## 1. Implemented features

| Area | Delivered |
|---|---|
| Phase 0 | Verified backup (git bundle of all refs + folder tar, `~/Backups/insight-workfolio-20261120/`); uncommitted installer WIP and untracked hotfix report preserved as `refs/backup/*`; `/health` returns `version` + `commit`; `deploy.sh` writes `release.env` and a deploy log line |
| UI foundation | Light theme by default + persistent Light/Dark toggle (no flash); compact tokens; regrouped sidebar (Realtime / Attendance / Monitoring / Work / Reports / People / Admin); top bar with global date + team filters; Reports and Settings sub-menus; "About this page" disclosures (text kept); sortable tables; SVG chart library (bar, stacked, donut, Gantt, sparkline) |
| Admin dashboard | Overview (`GET /overview`): 12 KPIs, 7-day workload chart, top apps, late / absent / missing clock-out lists, recent screenshots (access-logged), work-hours table, upcoming holidays & leave, pending approvals; Live team cards with status chips; employee profile analytics (`GET /employees/:id/analytics`, audited) |
| Attendance | Missing clock-out / stale device / long break detection (flag only, never auto-closes); admin-initiated corrections (different admin approves); `teamId` on all attendance reads; monthly matrix + XLSX/CSV export; late report; overtime; "Online" shown only when the device was seen < 5 min ago (fixes the production anomaly); tabbed Attendance page; desktop and web "still clocked in" banners |
| Email notifications | Rules for clock-in, clock-out, late arrival, absence, missing clock-out, productivity alert (migration `0034`): Off / Immediate / Daily digest per type and team, account-only recipients, DST-safe once-per-local-day digest, dedupe, recheck at send; settings UI; scheduled reports gain Late / Absent kinds, send time, team scope, optional Graph transport (migration `0035`) |
| Management & reports | Settings split into 8 sub-pages; employee filters (team, role, platform, app version); report pages (daily, monthly, monthly in/out, late, overtime, summary) with server XLSX/CSV; timesheet week grid |
| Productivity | Timeline Gantt (`/timeline`); app usage tabs (summary, per employee, per-app history, review); risk users (computed from existing alerts + scheduled-hours shortfall, no schema change); screenshot idle marker + filter; Super-Admin bulk ZIP export (capped, access-logged, audited) |
| Employee / team head | Monthly calendar on `/my/attendance`; team head Late + Missing clock-out sections with team picker |
| Desktop | Root cause of "Installed: unknown": builds without the in-app updater never reported their version; now they report from the public manifest. Live-region accessibility fix |

Decisions taken within the brief: no `alert_rules` table rebuild (anomalies and risk users are computed); all schema changes additive; Next.js 16.4.3 → 16.4.6 (security patch flagged by `next build`).

## 2. Sub-agents and results

| Wave | Agents (feature owners) | Review outcome |
|---|---|---|
| 1 | W1-UI, W1-CHARTS, W1-ATT-ANOMALY, W1-ATT-DATA, W1-NOTIFY, W1-REPORTS-SCHED, W1-RELEASE | 2 reviews, no blockers; 2 major perf issues in the notification timer + 7 minor fixed by owners |
| 2 | W2-OVERVIEW, W2-LIVETEAM, W2-ATTENDANCE-UI, W2-PROFILE, W2-REPORTS, W2-SETTINGS | 2 reviews, no blockers; summary report SQL-variable limit (fixed, 41 400-shift scale test) and stale-response bug + minors fixed |
| 3 | W3-TIMELINE, W3-APPS, W3-EMPLOYEE | 1 review, no blockers; truncated-ZIP-on-failure fixed + 6 minor; gallery viewer regression fixed |
| 4 | W4-SECURITY, W4-RELEASE-DOCS, W4-E2E | RBAC matrix; readiness docs; E2E, performance, backup drill, deterministic tests |

Every feature went inspect → plan file → implement → tests → lead gates → independent review → owner fixes → integration → full re-test.

## 3. Test results

| Suite | Baseline (`main`) | Final |
|---|---|---|
| Build, typecheck, lint (all packages) | pass | 17/17 gates pass |
| API integration | 544/550 (6 time-of-day failures) | **684/684** (stable across repeated and parallel runs) |
| Shared / database units | pass | 116/116 · 51/51 |
| Dashboard units (new runner) | 9 (not in CI) | 115/115 (now in CI) |
| Dashboard smoke | 37 routes | 53 routes |
| Browser suites (CDP) | my-panel 45/46 | **15 suites, 473/473** incl. new `verify:parity` 65/65 |
| Desktop | — | node 109/109, `cargo test` 108 pass, clippy clean, Windows `cargo check` (gnu target) clean |

Failed then fixed (highlights): reports suite selector bugs; daily-view and invitations suite drift; notification timer writing every minute; summary report 500 above ~330 employees; stale analytics responses; truncated export ZIP; gallery viewer reopen; 6 midnight-UTC flaky tests (now deterministic); `/my` "Request a correction" link not pre-filling.

## 4. Security review

Every new route is permission-guarded; team-scoped reads use `assertTeamReadable` + `teamFilterSql` + `scopeSql` and return 404 for foreign teams/ids. `parity-rbac-matrix.e2e` (25 tests) proves no team-B data reaches a team-A head on any new endpoint. Super-Admin-only actions (screenshot export/delete, roles, storage, update publishing) are refused for Admin. One real issue found and fixed: an admin could approve a correction of their own attendance filed by another admin. CSV/XLSX formula-safe, email HTML escaped, no secrets or real personal data in code, tests or docs. Details: `docs/security.md` → "Product-parity additions".

## 5. Performance (200 synthetic employees, 30 days, ~99k activity intervals)

`GET /overview` p50 67 ms / p95 97 ms · monthly 81 / 85 ms · missing clock-outs 9 / 10 ms · risk users 246 / 265 ms ·
team timeline 15 / 18 ms · Overview page load p50 535 ms / p95 643 ms. Target (< 1 s) met.

## 6. Remaining limitations

- Devices already installed keep showing version "unknown" until they install a build with the telemetry fix.
- `/health` `commit` stays null until the new systemd unit line is installed and a deploy uses the new `deploy.sh`.
- Idle marker depends on synced activity data; screenshots without activity data stay unmarked.
- Employee calendar shows holidays as "Day off or holiday" (employees cannot read the holiday calendar).
- Some org-wide reads (overview, risk users, exports) are bounded by headcount; fine at current scale, chunk if headcount grows large.
- A digest is skipped if the API is down from digest time to local midnight; late-recorded events roll into the next digest.
- Pre-existing: a team head viewing a correction sees requester/reviewer emails.
- Encrypted (gpg) backup path not drilled locally (no gpg on this Mac).
- Windows: compile check only; installer/runtime verification needs Windows CI or a Windows machine.

## 7. Deployment readiness

Ready for an owner-approved deploy following `docs/status/PRODUCTION-READINESS.md`. Key points found during preparation:
production probably runs `4215c8e` (schema `0032`), so a deploy applies **three** migrations (`0033`–`0035`; local dry run on
synthetic data: < 0.6 s, all rows preserved). Re-running `install-vps.sh` would overwrite the live Caddy hotfix — install the API
unit change by hand. `deploy.sh --migrate`'s own backup is unencrypted and not off-site — run `workfolio-backup` + `verify-backup.sh`
first. After migrations, rolling back code requires a DB restore (writes since deploy lost) — prefer fixing forward.

## 8. Pending owner decisions

1. **Production deploy** of `integration/product-parity` (requires your explicit approval; merge to `main` + tag first).
2. **Identify the production commit** (read-only SSH: `readlink /opt/workfolio/current`) and confirm `INVITATION_MAIL_PROVIDER` there.
3. **Single-admin corrections**: today a correction filed by an admin needs a *different* admin (a third admin if it concerns an admin). Allow Super Admin self-approval with an audit flag, or keep two admins?
4. **Work schedule** values (start, grace, workdays) and enabling it in production — late/absent stay blank until then.
5. **Email**: which notification rules to switch on, recipients, digest time; whether to set `REPORT_MAIL_PROVIDER=graph-delegated`. Every rule starts Off.
6. **Missing clock-out policy**: flag only is implemented; desktop prompt or auto clock-out on screen lock not built.
7. **Risk "less hours" threshold** (7 of 8 scheduled hours, a constant) — keep or make configurable.
8. **HR/Legal**: monitoring notice wording and retention periods (still draft / unapproved).
9. **Repository consolidation** per `docs/audit/REPOSITORY-CONSOLIDATION-PLAN.md` (nothing deleted). Agent branches `agent/w*` are merged and can be deleted with `git branch -d`.
10. **Caddy hotfix vs repo Caddyfile** reconciliation before any `install-vps.sh` run; **domain name** for production.
