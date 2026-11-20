# W4-SECURITY — RBAC / scoping / privacy verification of waves 1–3

Branch `agent/w4-security`. Contracts §4, §8, §13. Base `0493e54`.

## 1. Route inventory (added or changed since 0493e54)

Legend: TS = `@TeamScoped()`; T = accepts `teamId` (uuid, `assertTeamReadable` → 404); E = path/query employee id.

| Method + path | Permission | TS | Params | Owner |
|---|---|---|---|---|
| GET `/overview` | attendance:read-all (sections: screenshots:read, activity:read-all, leave:read-all) | yes | date, T | W2-OVERVIEW |
| GET `/attendance/missing-clock-outs` | attendance:read-all | yes | T | W1-ATT-ANOMALY |
| POST `/attendance/corrections` (+`employeeId`) | corrections:request; other employee needs attendance:review (else 404) | — | E | W1-ATT-ANOMALY |
| GET `/attendance/monthly` | attendance:read-all | yes | month, q, page, pageSize≤100, T | W1-ATT-DATA |
| GET `/attendance/monthly/export` | attendance:read-all | yes | month, format, T | W1-ATT-DATA |
| GET `/attendance/late` | attendance:read-all | yes | from, to (≤92 d), page, pageSize≤100, T | W1-ATT-DATA |
| GET `/attendance/{overview,summary,timesheets,timesheets/export}` (+teamId) | attendance:read-all | yes | T | W1-ATT-DATA |
| GET `/attendance/daily` (+teamId) | attendance:read-all | yes | date, T | W1-ATT-DATA |
| GET `/attendance/summary-report` (json/xlsx) | attendance:read-all | yes | from, to (≤92 d), page, pageSize≤100, T | W2-REPORTS |
| GET `/attendance/daily/export` | attendance:read-all | yes | date, tab, format, T | W2-REPORTS |
| GET `/employees` (+teamId, role, platform, appVersion) | employees:read | yes | T | W2-SETTINGS |
| GET `/employees/:id/analytics` | attendance:read-all (activity / leave sections by own permission) | yes | E (uuid v4), from/to ≤92 d | W2-PROFILE |
| GET `/activity/apps`, `/activity/apps/history` | activity:read-all | yes | from, to (≤31 d), app ≤300, T | W3-APPS |
| GET `/activity/risk-users` | activity:read-all | yes | from, to (≤92 d), T | W3-APPS |
| GET `/activity/team-timeline` | activity:read-all | yes | date, page, pageSize≤100, T | W3-TIMELINE |
| POST `/screenshots/export` | screenshots:delete (Super Admin) | — | ids ≤200 uuid, ≤200 MB | W3-TIMELINE |
| GET/POST `/notifications/rules`, PATCH `/rules/:id`, PUT `/rules/:id/recipients`, GET `/rules/recipient-candidates` | settings:manage | — | teamId (admin) | W1-NOTIFY |
| report schedules (+kind, sendAtLocalTime, teamId) | reports:manage | — | teamId | W1-REPORTS-SCHED |
| GET `/health` (+version, commit) | public | — | — | W1-RELEASE |

## 2. Threats checked

1. Team head reads another team (rows, `teamId=B`, `employees/:id` of team B, team names via `teams`/analytics).
2. Employee reaches admin/team reads (should be 403) or another employee via `employeeId` (404).
3. Admin (IT) reaching Super-Admin-only actions (export, delete, roles, storage, update publishing).
4. Privacy: emails, leave reasons, storage keys / file paths, window titles (not collected), alert details in new responses/exports/emails.
5. CSV/XLSX formula injection; email header/HTML injection.
6. SQL built from user input; unbounded reads from request parameters (range, page size, export caps).
7. Corrections on behalf: an admin approving a correction of their own attendance requested by someone else.
8. Secrets / real data in the diff and docs.

## 3. Test matrix (`apps/api/test/parity-rbac-matrix.e2e.test.ts`)

Users: Super Admin, Admin (IT), team head of A, employee (member of A), members of A and B; leave with a reason,
shifts, activity, screenshot rows with a recognisable storage key, an alert.
For every team-scoped read: unauthenticated 401 · employee 403 · head 200 with no team-B id/name/code/team name ·
head `teamId=A` 200 · head `teamId=B` 404 · admin 200 (team-B data present: proves the leak check is live) · admin
unknown team 404 · Super Admin 200. Per-employee route: head on a team-B id 404. Body checks over every 200: no
leave reason, no storage key, no emails outside routes that list accounts. Super-Admin-only: Admin/head/employee
403, Super Admin not 403. Employee: correction for another employee 404.

## 4. Fix policy
Minimal root fixes in `apps/api/src/**`, each listed in the report; anything that changes a contract goes to the lead.
