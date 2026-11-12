# IT Admin, Super Admin and employee visibility

Statuses used: PASS, FAIL, PARTIAL, BLOCKED, NOT IMPLEMENTED, NOT RUN. A build or compile result is never counted as a runtime PASS. Date of the runs: 2026-11-12, host macOS (Apple Silicon). No Windows machine was available. Nothing was committed, pushed, merged or deployed.

All results below come from API tests against an in-memory database and from dashboard browser suites against a throwaway local API. No physical device is involved in these checks.

## Who can do what (as tested)

| Action | Super Admin | IT Admin | Team head (an employee) | Employee | Test |
|---|---|---|---|---|---|
| See every employee's attendance, activity, screenshots | yes | yes | own team only | own only | `qa-round2-security`, `team-head-scope.e2e`, `screenshots-self-view.e2e` |
| Live status of employees | yes | yes | own team | own | `role-separation-live-status`, `qa-round3-fixes` |
| Delete a screenshot or a timelapse video | yes | 403 | 403 | 403 | `qa-round2-security` |
| Run a purge (screenshots, activity, websites) | yes | 403 | 403 | 403 | `qa-round2-security`, `qa-round3-fixes` |
| Change a retention period or its approval | yes | 403 | 403 | 403 | `qa-round3-fixes` |
| Other monitoring / screenshot / website settings | yes | yes | 403 | 403 | `qa-round3-fixes`, `qa-round2-security` |
| Connect / disconnect storage | yes | 403 | 403 | 403 | `qa-round2-security` |
| Role management (`/roles/*`) | yes | 403 | 403 | 403 | `qa-round2-security`, `roles.e2e` |
| Manage a Super Admin's account or device | yes | 403 | 403 | 403 | `security-hardening.e2e` |
| Read the audit log | yes | yes (without the actor / target pickers in the page) | 403 | 403 | `audit.e2e` |
| Any guarded route without signing in | 401 | 401 | 401 | 401 | `qa-round2-security` sweep |

## Features

| Feature | Implementation | Files changed | Tests executed | Actual result | Remaining limitations | Physical runtime test passed? | Production activation |
|---|---|---|---|---|---|---|---|
| Super Admin-only permissions enforced in the API guard | PASS | `packages/shared/src/roles.ts`, `apps/api/src/auth/auth.guard.ts`, `common/policy.ts`, controllers | `qa-round2-security` (30), `qa-round3-fixes` (7), `role-separation-live-status`, `roles.e2e` | PASS (API suite 479/479) | Before deploying, one account must hold the Super Admin title | Not applicable (server / browser check) | Pending |
| Employee sees own data only | PARTIAL | scope code unchanged | the same, plus `screenshots-self-view.e2e`, `employee-panel.e2e` | PASS | Team heads keep read access to their members (awaiting the owner) | Not applicable (server / browser check) | Pending |
| Audited reads of another employee: screenshot list, filtered gallery and detail; activity timeline and summary; attendance timeline, history, timesheet, export | PARTIAL | `apps/api/src/audit/account-audit.ts`, services and controllers | `qa-round2-security`, `qa-round3-fixes` | PASS: one row per served read; none for refused, invalid or own reads | All-employees gallery pages, organisation overviews, website reports and leave reads are not audited | Not applicable (server / browser check) | Pending |
| Live status and day timeline in the admin and team pages | PARTIAL | `apps/dashboard/src/app/(admin)/attendance/page.tsx`, `_components/day-timeline.tsx`, `my/team/*` | build, smoke (35 routes), `verify-web-app` 91/91, `verify-teamhead` 27/27, `verify-wave2` 55/55 | PASS | Never fed by a real desktop app; old desktop builds show Unknown | No (NOT RUN on macOS, BLOCKED on Windows) | Pending |
| Hidden controls in the dashboard match server denials | PASS | `settings/page.tsx`, `screenshots/page.tsx`, `websites/page.tsx`, `roles/page.tsx`, `timelapse-panel.tsx`, `sidebar.tsx` | code read against the API tests above | Every hidden control has a tested 403 | OneDrive folder names are shown to both admin identities (existed before; no secret) | Not applicable (server / browser check) | Pending |
| No secrets returned | PASS | none | code read; audit metadata filter; storage status route | No token, key or storage key in any response examined | none known | Not applicable (server / browser check) | Pending |

## Dashboard review

| Check | Result |
|---|---|
| Delete screenshot, delete video, purge buttons, storage buttons and the roles link are hidden for IT Admin | PASS (code read): each uses `can(user, ...)` and each is backed by a tested 403 |
| Retention inputs are disabled for IT Admin and their values are not sent as changes | PASS (code read): `settings/page.tsx:278-279, 516-517`, `websites/page.tsx:75` |
| Unknown is rendered as its own neutral state | PASS (code read) |
| Timelines render the server's rows in the server's order, paginated, with no computed rows | PASS (code read): `day-timeline.tsx`, `my/activity/page.tsx` |
| The time zone is named next to times | PASS (code read): `day-timeline.tsx:61` |
| Employee pages offer no delete or edit of screenshots | PASS (code read) |
| The employee's screenshot list states that viewing is logged | FAIL: `verify-my-panel.mjs:252` (the sentence is now only in the viewer dialog) |
