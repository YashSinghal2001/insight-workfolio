# Employee web panel (P2)

`/my/*` in the dashboard: the signed-in employee's own records, read from existing employee endpoints.
The same account works in the desktop app. Identity always comes from the server session; no page
takes an employee id from the URL, a query parameter or browser storage. Every request is authorized
again by the API (other employees' records: 404; admin routes: 403).

The panel mostly reads. Its writes (all self-scoped by the server): leave requests (create, cancel
while pending), attendance correction requests (create; reviewed by another administrator), the
website notice acknowledgement and browser pairing/disconnect (`/my/websites`), and revoking own
sessions (`/my/profile`). It never clocks in or out, starts timers, acknowledges the activity or
screenshot notices (desktop app), captures or records anything. Productive share and application
labels appear only when an administrator has labelled applications (labels apply at read time).

| Page | Route | Endpoints (GET unless noted) |
| --- | --- | --- |
| Dashboard | `/my` | `attendance/current`, `attendance/timesheet` (today), `activity/summary` (today), `websites/me/usage` (today), `screenshots/me` (+ `screenshots?pageSize=4` and thumbnails when self-view is on), `task-time/assignments`, `task-time/current`, `leave?status=PENDING` |
| Attendance | `/my/attendance` | `attendance/current`, `attendance/timesheet`, `attendance/history`, `attendance/corrections?mine=true`, `POST attendance/corrections` |
| Activity | `/my/activity` | `activity/me`, `activity/summary`, `activity/timeline`, `websites/me/usage` (one day at a time) |
| Websites | `/my/websites` | `websites/me`, `websites/me/usage` (≤ 31 days, profile time zone), `POST websites/consent`, `POST websites/links`, `DELETE websites/links/:id` |
| Screenshots | `/my/screenshots` | `screenshots/me`, `screenshots`, `screenshots/:id`, `screenshots/:id/content` (blob URLs, revoked; every view logged by the API). Self-view off: explanation only |
| Projects | `/my/projects` | `task-time/assignments` |
| Tasks | `/my/tasks` | `task-time/current`, `task-time/assignments`, `task-time/entries` |
| Leave | `/my/leave` | `leave`, `POST leave`, `POST leave/:id/cancel` |
| Reports | `/my/reports` | `attendance/timesheet`, `activity/summary` (≤ 31 days), `attendance/export?format=csv|xlsx` (own draft timesheet) |
| Profile | `/my/profile` | `employees/:id` and `employees/:id/devices` (own id from the session), `activity/me`, `screenshots/me`, `websites/me` |

## Known gaps (no API change made in P2)

- ~~Administrators with an employee profile received everyone's leave and correction rows~~: fixed in
  P1 by the server-side `mine=true` filter (identity from the session), used by `/my`.
- Sessions: the profile page lists and revokes own sessions since P1.
- `GET /devices/me` needs the desktop device header and records last-seen, so the profile uses
  `employees/:id/devices`.
- `task-time/assignments` returns active projects and open tasks only (no due dates or progress);
  `task-time/current|entries` close timers already ended by a break or clock-out (existing behaviour).
- Screenshot thumbnails are logged as views (existing behaviour); the dashboard shows four.
- History and correction lists show the most recent 100; no paging beyond that.

## Verification

`pnpm build && pnpm --filter @workfolio/dashboard verify:my-panel`: production build, headless Chrome,
throwaway API, two employees plus a Super Admin and an IT Admin (34 checks: every page with real data,
isolation in the browser, admin redirects and 403s, id swaps 404, self-view off, leave create/cancel,
CSV export, phone width and menu drawer, sign-out 401, admin panel unchanged). API isolation:
`apps/api/test/employee-panel.e2e.test.ts` (13 tests).
