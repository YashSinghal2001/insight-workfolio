# Teams and team heads (W40, W41, F05/F08/F09 team scope)

## Model

Migration `0024_teams`:

- `teams`: name (unique, any case, 1–80 chars), optional `head_user_id` (any account), `active`. Never
  deleted (trigger); deactivate instead.
- `team_members (team_id, employee_id)`: an employee can be in **several** teams (Workfolio behaviour).
  Rows are added or removed, never updated.

Existing employees have no team after the migration and nothing changes for them.

## Who is a team head

The account named in `teams.head_user_id` of at least one **active** team. Checked on every request
(`AuthService.authenticate`, same query that loads the role), so clearing the head or deactivating the team
ends access immediately. No new role: `users.role` stays `ADMIN`/`EMPLOYEE`.

## Enforcement (data scope, not a role check per route)

- `TEAM_HEAD_PERMISSIONS` (`packages/shared/src/roles.ts`): `employees:read`, `screenshots:read`,
  `attendance:read-all`, `activity:read-all`, `leave:read-all` (all reads).
- A route opts in with `@TeamScoped()` (`apps/api/src/auth/auth.guard.ts`). On such a route a team head
  passes the permission check for those permissions; on every other route the role check is unchanged
  (deny by default).
- `apps/api/src/common/scope.ts` decides the rows: `readScope` (all / team / own), `scopeSql` (WHERE
  fragment for lists), `inScope` / `canReadEmployee` (single records). `EmployeesService.attendanceTarget`
  uses it, so every per-employee read that goes through it is team-scoped.
- Outside their teams a team head gets **404**, exactly like an employee asking for someone else's record.

| Area | Team-scoped for heads |
| --- | --- |
| Employees | `GET /employees`, `GET /employees/:id`, `GET /employees/:id/devices` |
| Screenshots (F08) | `GET /screenshots?employeeId`, `/screenshots/gallery`, `/screenshots/overview`, `/screenshots/:id`, `/screenshots/:id/content` (access log only for admins) |
| Timelapses (F09) | all `/timelapses` routes (list sessions, create, job, cancel, delete, content) |
| Attendance | `history`, `timesheet`, `export` with `employeeId`; `GET /attendance/overview`, `/attendance/summary`, `/attendance/timesheets`, `/attendance/timesheets/export` (CSV/XLSX); correction requests list/detail (read only) |
| Leave | `GET /leave` (no filter = their teams' requests; `mine=true` stays own), `GET /leave/:id`, `/leave/summary`, `/leave/balances` |
| Leave decisions | `POST /leave/:id/approve` and `/reject`: explicit exception in `LeaveService.decide`: only members of a team they head, never their own request (403), outside the team 404. Role permissions are unchanged (`leave:review` stays admin-only). |
| Activity | `summary`, `timeline` with `employeeId`; `GET /activity/overview` |
| F05 per team | `GET /teams/productivity?from&to` (admins: every active team; heads: theirs) |

## Per-team application labels (F05)

Migration `0027_team_labels_self_view`, table `team_application_category_rules`. An admin can give a team its
own label (Productive / Neutral / Unproductive) for an application, matched like the organisation rules
(application ID first, then name; exact, case-insensitive). Rows are never edited: changing a label ends the
current row and adds a new one, removing ends it (who and when are kept on the row).

Which label applies to an employee's application time (`categorizeForEmployee`, `packages/shared/src/activity.ts`):

1. Look at the **active** teams the employee is a member of and keep those that have a label for the application.
2. If they all give the same label, that label applies.
3. Otherwise (no team label, or the teams **disagree**) the organisation label applies (or Unclassified when
   there is none). A team without a label for the app does not count as disagreeing.

Deactivated teams' labels are ignored. Labels apply when activity is read, so a change is retroactive, like
the organisation labels. This scoring is used everywhere productive time is computed: per-person
`GET /activity/summary` and `/activity/timeline`, `GET /activity/overview`, and `GET /teams/productivity`
(the sum of each member's own scoring; an employee in two teams counts in both with the same labels).

API (`teams:manage`): `GET /teams/:id/labels`, `PUT /teams/:id/labels` `{ matchKind, value, category }`
(sets/replaces), `DELETE /teams/:id/labels/:labelId`. Dashboard: **Teams → Edit → Labels for this team**.

## Per-person screenshot self-view (F08)

Whether an employee may see their **own** screenshots is the organisation switch (screenshot settings), unless
the employee has a per-person override: `employee_tracking_overrides.screenshot_self_view` (migration 0027;
part of the append-only per-person override versions; NULL = inherit, which every existing version is).
Admins set it on the employee page (**Schedule, idle time and screenshots for this person**): follow the
organisation / allow / deny. Deny refuses (403) the employee's own `GET /screenshots`, `/screenshots/:id` and
`/screenshots/:id/content`, even when the organisation allows; allow works when the organisation denies.
`GET /screenshots/me` reports the effective value. Admin and team-head access are unchanged.

Still admin-only (not team-scoped yet): `GET /attendance/daily` (schedule module), projects and reports
(organisation-level, not per-employee reads), websites, alerts, settings, leave types, screenshot deletion. A team head's **own**
screenshots still follow the self-view switch (their per-person override, else the organisation's).

## API (`teams:manage`, admins)

- `GET /teams`: every team with head and members.
- `POST /teams` `{ name, headUserId? }` (head must be an active account; 409 on a duplicate name).
- `PATCH /teams/:id` `{ name?, headUserId?, active? }`.
- `PUT /teams/:id/members` `{ employeeIds }`: replaces the member list (400 on an unknown employee).

Dashboard: **People → Teams** (`/teams`), including the per-team productivity table.

## Dashboard (W41/F09)

Team heads get a **My team** section in the `/my` navigation (only when `/auth/me` returns `teamHead: true`):
`/my/team` (members, today's counts), `/my/team/attendance` (counts for a date + live status),
`/my/team/timesheets` (+ CSV/XLSX export), `/my/team/screenshots` (gallery + timelapse per member),
`/my/team/leave` (approve/reject). They never enter the admin layout. Browser check:
`apps/dashboard/scripts/verify-teamhead.mjs`.

## Not done yet

- Team heads adding members; admin switch to turn off a head's screenshot access; per-team idle
  exclusions (W22); audit table for team changes and team labels (changes are logged and kept on the
  rows, but not in the audit view).
