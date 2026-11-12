# Audit log (P1)

One read-only view over the append-only history tables that already exist. Nothing is copied or
backfilled: an event is shown only if its row exists. Admins (Super Admin and Admin, permission
`audit:read`) can read it; employees get 403.

## Sources

| Source | Table | Action names | Actor / target | Resource | Details |
|---|---|---|---|---|---|
| `ACCOUNT` | `account_audit` (0015) | as stored: `ACCOUNT_CREATED`, `ACCOUNT_UPDATED`, `ACCOUNT_DISABLED`, `ACCOUNT_ENABLED`, `SETUP_LINK_ISSUED`, `PASSWORD_SET`, `SESSION_REVOKED`, `SESSIONS_REVOKED_OTHERS`, `SESSIONS_REVOKED_ALL`, `SESSION_REUSE_DETECTED`, `DEVICE_REGISTERED`, `DEVICE_REVOKED`; reads of ANOTHER employee's records by an admin or team head (one row per served request, target = that employee's account): `EMPLOYEE_SCREENSHOTS_VIEWED` (list, gallery filtered to one employee, screenshot detail), `EMPLOYEE_ACTIVITY_TIMELINE_VIEWED`, `EMPLOYEE_ACTIVITY_SUMMARY_VIEWED`, `EMPLOYEE_ATTENDANCE_TIMELINE_VIEWED`, `EMPLOYEE_ATTENDANCE_VIEWED` (history, timesheet), `EMPLOYEE_ATTENDANCE_EXPORTED` | `actor_user_id` (null = System) / `target_user_id` | `resource_type`, `resource_id` | `metadata` (sanitized, see below) |
| `ROLE` | `role_changes` | `ROLE_CHANGED` | `actor_id` (null = bootstrap tool) / `target_user_id` | `USER`, target id | `{from, to}` |
| `WEBSITE` | `website_audit` | as stored: `RULE_ADDED`, `RULE_CHANGED`, `RULE_REMOVED`, `RETENTION_RUN` | `actor_id` (null = retention scheduler) / none | `WEBSITE_CATEGORY_RULE` + rule id, or `WEBSITE_DATA` | `details` (rule id, domain, match, category; or cutoff, retentionDays, deleted) |
| `PROJECT` | `project_audit` | as stored: `PROJECT_CREATED`, `PROJECT_UPDATED`, `PROJECT_ARCHIVED`, `PROJECT_RESTORED`, `EMPLOYEE_ASSIGNED`, `EMPLOYEE_UNASSIGNED`, `TASK_CREATED`, `TASK_UPDATED`, `TASK_CLOSED`, `TASK_REOPENED` | `actor_id` / the assigned employee's user (when `details.employeeId` is set) | `PROJECT`, project id | `details` (code, name, status, taskId, title, employeeId...; `description` dropped) |
| `SCREENSHOT_ACCESS` | `screenshot_access_log` | `VIEW` (new rows; `variant=thumbnail` serves the full image and is logged as `VIEW`; older rows may say `THUMBNAIL`) | viewer / the screenshot's employee's user | `SCREENSHOT`, id | `{screenshotId, employeeId, capturedAt}` |
| `SCREENSHOT_DELETION` | `screenshots` rows with `upload_status = 'DELETED'` | `SCREENSHOT_DELETED` (`deleted_by` set: a Super Admin's delete or a purge a Super Admin started) or `SCREENSHOT_DELETED_BY_RETENTION` (`deleted_by` NULL: the scheduled purge), at `deleted_at` | `deleted_by` (none for the scheduled purge) / the screenshot's employee's user | `SCREENSHOT`, id | `{screenshotId, employeeId, capturedAt}` (`by: SCHEDULED_RETENTION` for the scheduled purge). The reason given to `DELETE /screenshots/:id` is stored (`screenshots.deleted_reason`, migration 0029) and shown as the event's reason; purges have none. |
| `TIMELAPSE_ACCESS` | `timelapse_access_log` | as stored: `CREATE`, `VIEW`, `DOWNLOAD`, `CANCEL`, `DELETE` | user / the timelapse's employee's user | `TIMELAPSE`, id | `{timelapseId, employeeId, attendanceSessionId}` |
| `SETTINGS` | `monitoring_policies` | `MONITORING_POLICY_CHANGED` | `changed_by` | `MONITORING_POLICY`, seq | `{version, enabled, sampleSeconds, idleThresholdSeconds, retentionDays, retentionApproved, noticeVersion}` |
| `SETTINGS` | `screenshot_policies` | `SCREENSHOT_POLICY_CHANGED` | `changed_by` | `SCREENSHOT_POLICY`, seq | `{version, enabled, intervalSeconds, retentionDays, retentionApproved, employeeSelfView, maskCount, blur, noticeVersion}` |
| `SETTINGS` | `screenshot_blur_overrides` (0019) | `SCREENSHOT_BLUR_OVERRIDE_CHANGED` | `changed_by` / the employee's user | `EMPLOYEE`, employee id | `{employeeId, blur}` (`blur` null = override cleared) |
| `SETTINGS` | `website_policies` | `WEBSITE_POLICY_CHANGED` | `changed_by` | `WEBSITE_POLICY`, seq | `{version, enabled, retentionDays, noticeVersion}` |
| `SETTINGS` | `monitoring_notices` | `MONITORING_NOTICE_PUBLISHED` | `created_by` (null for notices seeded by migrations) | `MONITORING_NOTICE`, version | `{noticeVersion, draft, points}` (count of points) |

Event ids are `SOURCE:rowid` (settings rows: `SETTINGS:monitoring-policy:<seq>` and similar), so
they are unique and stable. Times are the table's own: `created_at`, `accessed_at`, or a policy's
`effective_at`.

## Never recorded or returned

- Passwords, password hashes, access/refresh tokens, setup or pairing codes, device token hashes, cookies.
- Screenshot bytes, storage keys/paths, provider item ids, checksums; timelapse files and hashes.
- Mask labels and coordinates (only the count), notice wording, project descriptions.
- Activity, website-usage intervals or any monitored content: the log covers admin actions and
  access, not employee activity.

Stored JSON (`account_audit.metadata`, `website_audit.details`, `project_audit.details`) is
re-filtered on read: only primitive values are kept, keys matching
`pass|token|secret|hash|cookie|authorization|key|content|image|path|storage|checksum|description`
are dropped, and strings are cut at 200 characters. The write helper (`account-audit.ts`) already
refuses such keys for account rows.

## Gaps

- Account auditing starts with migration 0015. Earlier account changes (creation, disable,
  password setup, session revocation) were not recorded and are not shown.
- Screenshot deletions are read from `screenshots.deleted_at/deleted_by/deleted_reason` (the row, not an
  event log). Retention run summaries in `activity_retention_runs` / `screenshot_retention_runs` are not in
  the view (website retention runs are, via `website_audit`).
- Not audited: the all-employees screenshot gallery page (each image opened is in `screenshot_access_log`),
  the organisation overviews (attendance, activity, timesheets), website reports and leave reads.
- A read is audited only when the reader is not the employee. Own reads are never recorded.
- Leave decisions, attendance corrections and report schedules keep their own state/history and
  are not in this view.

## Retention

No retention job deletes audit rows. The only purges are `activity_intervals`
(`activity/retention.service.ts`) and `website_intervals` (`websites.service.ts`); screenshots are
marked `DELETED`, not removed. Every source table above has `BEFORE UPDATE` / `BEFORE DELETE`
triggers raising `append_only` (screenshot/timelapse rows referenced by the access logs are
themselves undeletable).

## API

`GET /api/v1/audit` (`audit:read`). Query (strict; unknown params are 400):

- `from`, `to`: local dates (`YYYY-MM-DD`), inclusive, in `timeZone` (IANA, default `UTC`). The
  window is `[from 00:00, to+1 00:00)` in that zone, converted to UTC. At most 92 days
  (`AUDIT_RANGE_MAX_DAYS`); unknown zone or longer range is 400.
- `source`, `actorId`, `targetUserId`, `action` (exact, case-insensitive): optional filters.
- `page` (1..10000), `pageSize` (1..200, default 50).

Response: `Paginated<AuditEvent>` (`items`, `total`, `page`, `pageSize`), ordered by time
descending, then source, then row id (stable across pages). There is no write route; POST, PUT,
PATCH and DELETE on `/audit` are 404.

### Query shape and cost

One `UNION ALL` (a CTE with one SELECT per table; the time window is applied inside every branch
on the table's own column) joined to `users` for emails, plus a `count(*)` with the same filters,
both in one read batch. Index use for the time window:

- `account_audit(created_at, id)`: indexed.
- `screenshot_access_log(accessed_at)` and `timelapse_access_log(accessed_at)`: indexed (added in
  0015 for this view; the screenshot access log is the largest source, one row per thumbnail view).
- `project_audit`, `website_audit`, `role_changes`: no time index; scans (small tables in practice).
- Settings tables: a handful of rows each.

Deep pages use `OFFSET`, bounded by
`page <= 10000` and the 92-day window.

## Page

`/audit` in the admin dashboard: date range (default the last 7 days in the viewer's zone), source,
exact action, actor and target (from `/roles/users`), a table (`aria-label="Audit events"`) with
time in the viewer's zone, a colored source badge, action, actor (or "System"), target, resource,
reason and details, and Previous/Next server-side pagination. It has no edit or delete controls. The actor and
target pickers load `/roles/users`, which is Super Admin-only: an Admin (IT) sees the page without those two filters.

Tests: `apps/api/test/audit.e2e.test.ts`, `role-separation-live-status.e2e.test.ts`, `qa-round2-security.e2e.test.ts`, `qa-round3-fixes.e2e.test.ts`.
