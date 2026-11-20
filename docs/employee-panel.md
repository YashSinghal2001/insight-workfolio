# Employee web panel (P2)

`/my/*` in the dashboard: the signed-in employee's own records, read from existing employee endpoints.
The same account works in the desktop app. Identity always comes from the server session; no page
takes an employee id from the URL, a query parameter or browser storage. Every request is authorized
again by the API (other employees' records: 404; admin routes: 403).

The panel mostly reads. Its writes (all self-scoped by the server): leave requests (create, cancel
while pending), attendance correction requests (create; reviewed by another administrator), the
website notice acknowledgement and browser pairing/disconnect (`/my/websites`), and revoking own
sessions (`/my/profile`). It never clocks in or out, starts timers, acknowledges the activity or
screenshot notices (desktop app), captures or records anything. Clocking in and out is desktop-only by
decision: the panel has no clock buttons, the API rejects device-bound writes from browser sessions, and
the dashboard and attendance pages say where to clock in. Productive share and application
labels appear only when an administrator has labelled applications (labels apply at read time).

| Page | Route | Endpoints (GET unless noted) |
| --- | --- | --- |
| Dashboard | `/my` | `activity/me` (live status, idle threshold, sampling interval), `attendance/current` (+ missing clock-out banner), `attendance/timesheet` (today), `activity/summary` (today), `websites/me/usage` (today), `screenshots/me` (+ `screenshots?pageSize=4` and thumbnails when self-view is on), `task-time/assignments`, `task-time/current`, `leave?status=PENDING` |
| Attendance | `/my/attendance` | `attendance/current`, `attendance/timesheet`, `attendance/history`, `attendance/corrections?mine=true`, `POST attendance/corrections`, monthly calendar: `attendance/timesheet` + `attendance/expected` for the month and every page of `leave?mine=true&status=APPROVED`. History and corrections are paged (100 per page) |
| Activity | `/my/activity` | `activity/me` (live status), `attendance/timeline` (day timeline), `activity/summary`, `activity/timeline`, `websites/me/usage` (one day at a time) |
| Websites | `/my/websites` | `websites/me`, `websites/me/usage` (≤ 31 days, profile time zone), `POST websites/consent`, `POST websites/links`, `DELETE websites/links/:id` |
| Screenshots | `/my/screenshots` | `screenshots/me`, `screenshots`, `screenshots/:id`, `screenshots/:id/content` (blob URLs, revoked; every view logged by the API). The state badge from `screenshots/me` `state` is always shown; self-view off hides only the gallery |
| Projects | `/my/projects` | `task-time/assignments` |
| Tasks | `/my/tasks` | `task-time/current`, `task-time/assignments`, `task-time/entries` |
| Leave | `/my/leave` | `leave`, `POST leave`, `POST leave/:id/cancel` |
| Reports | `/my/reports` | `attendance/timesheet`, `activity/summary` (≤ 31 days), `attendance/export?format=csv|xlsx` (own draft timesheet) |
| Profile | `/my/profile` | `employees/:id` and `employees/:id/devices` (own id from the session), `activity/me`, `screenshots/me`, `websites/me` (each notice's title and points as served by the API, with its own acknowledged state) |

## Missing clock-out banner and monthly calendar (W3)

- **Banner** (`/my`, `/my/attendance`): "You are still clocked in since <local date/time>" when the open shift (an
  open break included) was clocked in on an earlier local date in the employee's zone (shared `missingClockOut`)
  or has been open longer than `ANOMALY_THRESHOLDS.maxShiftMinutes` (14 h of real time, so DST does not matter).
  Same rule as the desktop banner (`staleClockInSince`); evaluated at the response's `serverTime`. Flag only: it
  never closes the shift. "Request a correction" opens the correction form pre-filled as Missing clock-out for
  that shift (from `/my` via `/my/attendance?correct=missing-clock-out`).
- **Monthly calendar** (`/my/attendance`): one table per month (Monday first), each day with a status code, label
  and the net worked time of completed shifts that started that day. Status uses the shared
  `dailyAttendanceStatus` with the employee's expected window that day; an open shift shows OPEN. Only the
  employee's own endpoints are read (no admin endpoints). Limitation: holidays are admin-only data, so a day without
  an expected window while a schedule exists shows "Day off or holiday" (OFF); without any schedule days show
  "No schedule". Leave of any portion marks the day On leave.

## Status, timeline and screenshot state

- **Live status** (`ActivityStatusResponse.liveStatus`, `liveSince`): Not clocked in, On a break, Active, Idle or
  Unknown. Unknown (clocked in, no fresh report from the desktop app) is shown as Unknown, never as active or
  idle. Next to it: the idle threshold and sampling interval in force for this employee (`policy`).
- **Day timeline** (`GET /attendance/timeline?date&page&pageSize`): clock-in, clock-out, breaks, active and idle
  rows in the order the API returns them, in the time zone the response names, 100 per page. Only stored
  records are listed; gaps are never filled. The older application timeline (with organisation labels) stays
  below it.
- **Screenshot state** (`ScreenshotStatusResponse.state`): Disabled, Awaiting consent, Enabled, Permission
  denied, Capture failed. Each screenshot is labelled Upload pending, Uploaded or Deleted. There is no delete
  or edit control.
- **Notices**: activity and screenshot notices are separate acknowledgements (the server refuses a screenshot
  notice version that is an activity notice version). Both are acknowledged in the desktop app.
- "Updated" times use the employee's profile time zone.

## Known gaps (no API change made in P2)

- ~~Administrators with an employee profile received everyone's leave and correction rows~~: fixed in
  P1 by the server-side `mine=true` filter (identity from the session), used by `/my`.
- Sessions: the profile page lists and revokes own sessions since P1.
- `GET /devices/me` needs the desktop device header and records last-seen, so the profile uses
  `employees/:id/devices`.
- `task-time/assignments` returns active projects and open tasks only (no due dates or progress);
  `task-time/current|entries` close timers already ended by a break or clock-out (existing behaviour).
- Screenshot thumbnails are logged as views (existing behaviour); the dashboard shows four.
- Leave history (`/my/leave`) and the team lists (`/my/team/*`) show the first 100 rows; no paging beyond that.
- `/my/reports` shows activity warnings in the API's wording (written for administrators).
- Team pages use the browser's time zone for the default date or range.

## Verification

`pnpm build && pnpm --filter @workfolio/dashboard verify:my-panel`: production build, headless Chrome,
throwaway API, two employees plus a Super Admin and an IT Admin (34 checks: every page with real data,
isolation in the browser, admin redirects and 403s, id swaps 404, self-view off, leave create/cancel,
CSV export, phone width and menu drawer, sign-out 401, admin panel unchanged). API isolation:
`apps/api/test/employee-panel.e2e.test.ts` (13 tests).
