# Roles: Super Admin, Admin, Employee

Three identities. Super Admin and Admin (IT) share the `ADMIN` permission role and see the same data,
but **an Admin does not hold the Super Admin-only permissions** below. Employees see only their own data;
the head of an active team additionally reads their team members' records (see [teams.md](teams.md)).

| Identity | `users.role` | `users.admin_title` | Sees |
| --- | --- | --- | --- |
| Super Admin | `ADMIN` | `SUPER_ADMIN` | Everything an admin sees |
| Admin (IT) | `ADMIN` | `ADMIN` | Everything an admin sees |
| Employee | `EMPLOYEE` | `NULL` | Own records only (desktop app, `/my` web page) |

## Super Admin only

`SUPER_ADMIN_ONLY` in `packages/shared/src/roles.ts`; an Admin, a team head and an employee get 403.

| Permission | Routes / actions |
| --- | --- |
| `screenshots:delete` | `DELETE /screenshots/:id` (reason required, stored in `screenshots.deleted_reason`); `DELETE /timelapses/:id`; `POST /screenshots/retention/run`, `POST /activity/retention/run`, `POST /websites/retention/run`; changing `retentionDays` or `retentionApproved` in the screenshot, activity-monitoring or website settings (`assertMayChangeRetention`, `apps/api/src/common/policy.ts`). Saving those forms with retention unchanged stays open to both admin identities. |
| `storage:manage` | `GET /storage/onedrive/oauth/start`, `POST /storage/onedrive/disconnect`, `GET /storage/google-drive/oauth/start` |
| `roles:manage` | `GET /roles/users`, `PATCH /roles/users/:id` (`platformRole`, `reason` 3–500 chars), `GET /roles/history` |
| `updates:publish` | Desktop app releases: publish (`POST /desktop-updates/releases/:id/status` to `PUBLISHED`), move a published release back to Draft/Testing, and change a published release's policy, rollout or minimum version (`PATCH /desktop-updates/releases/:id`). Admin (IT) holds `updates:manage` (view releases and device update status, create and edit drafts, verify into Testing, **disable** any release). Employees hold only `updates:report` (their own device's update state). See docs/desktop/AUTO-UPDATE-ARCHITECTURE.md. |

A Super Admin also manages Super Admin accounts: an Admin cannot edit, disable, reissue a setup link for,
or revoke a device of a Super Admin (403 "Only a Super Admin can manage a Super Admin account").

The check is `can(user, permission)` (role check plus the Super Admin-only list), used by `AuthGuard`.
`hasPermission(role, permission)` is the role-level check only. `platformRoleOf(role, adminTitle)` derives
the identity; `roleOf(identity)` gives the permission role.

**Before deploying:** at least one account must hold the Super Admin title, or nobody can manage roles,
delete, purge, change retention or connect storage (`admin:create --super-admin`, see Setup).

## Enforcement

- The role is read from the database on every request (`AuthGuard` → `authenticate`); headers,
  tokens or client state cannot raise it (tested with spoofed `x-role` headers).
- The dashboard and the desktop app only *display* the identity they get from `/auth/me`. The admin
  layout redirects employees to `/my`; the API refuses them regardless.
- Device registration and device-bound writes (clock-in/out, activity and screenshot uploads) need a
  desktop sign-in (`sessions.client = DESKTOP`); a browser session gets 403. The client type is declared
  at login, so this separates sessions, not people.
- Tests: `apps/api/test/roles.e2e.test.ts`, `role-separation-live-status.e2e.test.ts`,
  `qa-round2-security.e2e.test.ts`, `qa-round3-fixes.e2e.test.ts`.

## Safeguards

| Rule | Response |
| --- | --- |
| Changing your own role (no self-lockout) | 403 |
| Granting or removing Super Admin without being a Super Admin (no escalation) | 403 |
| Leaving zero active administrators | 409 "This is the last active administrator" |
| Removing the last active Super Admin | 409 "This is the last active Super Admin" |
| Making an account without an employee profile an Employee | 400 |
| Disabling the last active administrator / Super Admin account (`PATCH /employees/:id/status`) | 409 |
| Disabling your own account | 400 |
| Admin editing, disabling, reissuing a setup link for, or revoking a device of a Super Admin | 403 "Only a Super Admin can manage a Super Admin account" |

The last-admin checks are subqueries inside the same `UPDATE` (role change *and* account disable), so
concurrent demotions and disables cannot race past them: `roles.e2e.test.ts` (two admins demoting each
other) and `account-lifecycle.e2e.test.ts` (rounds of mixed concurrent disables/demotions over HTTP and
directly in the services with interleaved reads; never zero active admins or Super Admins).
`assertCanDisable` only gives the clearer message up front; before P1 it was the *only* disable check
(read, then write), which concurrent disables could slip past. Every change is written to
`role_changes` (append-only; who, from, to, reason, when), shown on the dashboard **Roles** page. Role changes are *not* copied into
`account_audit`; the unified audit view reads `role_changes` directly.

Account lifecycle (create, update, disable/enable, setup links) is recorded in `account_audit`; see
[provisioning.md](provisioning.md).

## Route permissions

`test/route-permissions.test.ts` reflects over every controller in `AppModule`: each handler must be
`@Public()` or carry `@RequirePermission(...)`, and the public set must equal an explicit allow-list
(health/ready, login, refresh, logout, setup-password, extension pair/state/intervals/disconnect).
Every signed-in route carries a permission; `GET /auth/me` requires `profile:read-own`, which every
role has (`AUTHENTICATED_ONLY` in the test is empty). A missing permission returns 403 "Your role does
not allow this action".

## Own data for administrators (`mine`)

`GET /leave` and `GET /attendance/corrections` accept `mine=true`: the server uses the caller's own
employee profile from the session (Super Admins and Admins included). `mine=true` together with
`employeeId` is a 400; an account without a profile gets the usual 403 "no employee profile". Without
`mine`, nothing changes (admins see the organisation). The `/my` pages use it instead of filtering.

## Setup

Migration `0014_platform_roles` gives every existing admin the `ADMIN` identity. Create the first
Super Admin with the CLI (no role-change row; the server operator is the actor):

```bash
pnpm --filter @workfolio/api admin:create --email <super-admin-email> --super-admin   # add --additional if an admin exists
```

Business decision still open: who holds Super Admin in production (the brief names the CEO).
