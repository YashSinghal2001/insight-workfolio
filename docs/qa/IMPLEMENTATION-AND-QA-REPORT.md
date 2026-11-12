# Implementation and QA report

Statuses used: PASS, FAIL, PARTIAL, BLOCKED, NOT IMPLEMENTED, NOT RUN. A build or compile result is never counted as a runtime PASS. Date of the runs: 2026-11-12, host macOS (Apple Silicon). No Windows machine was available. Nothing was committed, pushed, merged or deployed.

## Overview

A six-agent remediation of idle detection, live status, screenshot permissions and role separation in Insight Workfolio (API, dashboard, desktop app), done in five rounds: read-only investigation, implementation, independent QA review, fix round, final review. Everything is in the working tree of branch `deploy/hostinger-vps`, uncommitted.

## Agents

| Agent | Responsibility |
|---|---|
| 1 | Windows desktop and the shared activity tracker |
| 2 | macOS desktop and the screenshot pipeline |
| 3 | Backend, database, shared contracts |
| 4 | Super Admin / IT Admin panels |
| 5 | Employee panel |
| 6 | QA and security (author of this report) |
| Coordinator | Integration, file ownership, decisions |

## Root cause of the Windows idle report

From code analysis only: the owner never stated the exact symptom and nothing was run on a PC.

| # | Cause |
|---|---|
| 1 | No live state reached the server: only closed intervals upload, and an idle interval closes only when input resumes |
| 2 | Locking or sleeping before the 300 s threshold recorded no idle at all, because a locked screen was treated as unobserved, contradicting the employee notice |
| 3 | The desktop hid the threshold until 60 s without input |

`GetLastInputInfo` was found correct for mouse movement, clicks, wheel and repeated key presses. Held-key auto-repeat is believed to refresh it (about 85% confidence) and needs a PC to confirm.

## Features implemented

| Feature | Where | Verified by |
|---|---|---|
| Locked screen = IDLE from the lock; sleep / other session unobserved; IDLE split every 15 min | `apps/desktop/src-tauri/src/activity.rs`, `collector.rs`, `session_events.rs` | Rust tests |
| Live state report (on change and every 60 s, retry with backoff) on the existing sync call | `apps/desktop/src/live-state.ts`, `activity-ui.ts` | TypeScript tests |
| Live status on the server with a 3-minute staleness rule; UNKNOWN when monitoring is off or the notice is not acknowledged | `packages/shared/src/attendance.ts`, `apps/api/src/activity`, `attendance` | API tests |
| `GET /attendance/timeline` (one local day, stored rows only) | `apps/api/src/attendance` | API tests |
| Forgotten clock-out flag (`missingClockOut`) | `packages/shared/src/timesheet.ts` | API tests |
| Screenshot feature state (disabled, awaiting consent, enabled, permission denied, capture failed) | `packages/shared/src/screenshots.ts` | API tests |
| Super Admin-only permissions (`can`, `SUPER_ADMIN_ONLY`) | `packages/shared/src/roles.ts`, `apps/api/src/auth/auth.guard.ts`, `common/policy.ts` | API tests |
| Stored delete reason; scheduled purges in the audit view; audited reads of another employee | `apps/api/src/screenshots`, `audit` | API tests |
| Desktop-only device registration and device-bound writes | `apps/api/src/devices/devices.service.ts` | API tests |
| Separate notices for activity monitoring and screenshots | `apps/api/src/settings`, `screenshots` | API tests |
| macOS idle source = HID system state; no capture with the display asleep; capture failures retry | `activity.rs`, `screenshot.rs` | Rust tests (fake OS) |
| Windows display-off notification feeding `display_asleep` | `win/session.rs` | compile, plus a unit test of the mapping only |
| Dashboard: live status, day timeline, hidden Super Admin-only controls, retention inputs locked for IT Admin | `apps/dashboard/src` | build, smoke, browser suites |

## Bugs fixed

| Bug | Found in | Fixed and re-tested |
|---|---|---|
| IT Admin identical to Super Admin (delete, purge, storage, roles) | round 1 | yes |
| IT Admin could purge indirectly by shortening / approving retention | round 3 (QA review) | yes (`qa-round3-fixes`) |
| `POST /websites/retention/run` open to IT Admin | round 3 | yes |
| Tracker panic on a backwards timestamp after a lock event | round 3 | yes (Rust `mod qa`) |
| ACTIVE could start before the unlock | round 3 | yes |
| Sibling reads of another employee not audited | round 3 | yes |
| Live status shown after monitoring was switched off | round 3 | yes |
| Timeline order at a shared instant | round 3 | yes |
| Thumbnail requests logged as THUMBNAIL while serving the full image | round 1 | yes (logged as VIEW) |
| Delete reason required but not stored | round 1 | yes |
| Team heads saw the organisation's retention status | round 2 | yes |
| Capture error latched until restart | round 2 | yes (Rust tests) |

## Files changed

Source: `git status --short` and `git diff --stat` on 2026-11-12, working tree only (nothing committed). Tracked files modified: 88 (88 files changed, 1861 insertions(+), 364 deletions(-)). New files: 9, plus this `docs/qa/` directory (7 files). Two untracked files under `docs/status/` existed before this work and are not part of it.

**Modified**

| Area | Files | Names (path under the area) |
|---|---|---|
| apps/api/src | 22 | `activity/activity.controller.ts`, `activity/activity.service.ts`, `attendance/attendance.controller.ts`, `attendance/attendance.service.ts`, `attendance/sessions.ts`, `attendance/timesheet.service.ts`, `audit/account-audit.ts`, `audit/audit.service.ts`, `auth/auth.guard.ts`, `auth/auth.service.ts`, `common/policy.ts`, `devices/devices.service.ts`, `employees/employees.service.ts`, `screenshots/screenshot-settings.service.ts`, `screenshots/screenshots.controller.ts`, `screenshots/screenshots.service.ts`, `screenshots/timelapse.controller.ts`, `settings/monitoring-settings.service.ts`, `storage/google-drive-oauth.ts`, `storage/onedrive.ts`, `websites/websites.controller.ts`, `websites/websites.service.ts` |
| apps/api/test | 14 | `activity-policy.e2e.test.ts`, `employee-panel.e2e.test.ts`, `google-drive.e2e.test.ts`, `onedrive.e2e.test.ts`, `roles.e2e.test.ts`, `screenshots-delete.e2e.test.ts`, `screenshots-gallery.e2e.test.ts`, `screenshots-self-view.e2e.test.ts`, `screenshots.e2e.test.ts`, `security-hardening.e2e.test.ts`, `teams.e2e.test.ts`, `timelapse.e2e.test.ts`, `verify-turso-script.test.ts`, `websites.e2e.test.ts` |
| apps/dashboard | 23 | `scripts/verify-schedule.mjs`, `scripts/verify-timelapse.mjs`, `scripts/verify-wave2.mjs`, `scripts/verify-web-app.mjs`, `src/app/(admin)/activity/page.tsx`, `src/app/(admin)/attendance/page.tsx`, `src/app/(admin)/audit/page.tsx`, `src/app/(admin)/roles/page.tsx`, `src/app/(admin)/screenshots/page.tsx`, `src/app/(admin)/settings/page.tsx`, `src/app/(admin)/timesheets/[id]/page.tsx`, `src/app/(admin)/timesheets/page.tsx`, `src/app/(admin)/websites/page.tsx`, `src/app/my/activity/page.tsx`, `src/app/my/attendance/page.tsx`, `src/app/my/page.tsx`, `src/app/my/profile/page.tsx`, `src/app/my/screenshots/page.tsx`, `src/app/my/team/attendance/page.tsx`, `src/app/my/team/timesheets/page.tsx`, `src/components/my-ui.tsx`, `src/components/sidebar.tsx`, `src/components/timelapse-panel.tsx` |
| apps/desktop (TypeScript, tests, html) | 9 | `index.html`, `src/activity-ui.ts`, `src/monitoring.ts`, `src/screenshot-sync.ts`, `src/screenshot-ui.ts`, `test/client.test.ts`, `test/monitoring.test.ts`, `test/platform.test.ts`, `test/screenshots.test.ts` |
| apps/desktop (Rust) | 6 | `src/activity.rs`, `src/collector.rs`, `src/lib.rs`, `src/screenshot.rs`, `src/session_events.rs`, `src/win/session.rs` |
| docs | 4 | `audit.md`, `employee-panel.md`, `roles.md`, `windows.md` |
| packages/database | 3 | `src/auto-timelapse.test.ts`, `src/migration-status.test.ts`, `src/migrations.ts` |
| packages/shared | 7 | `src/activity.ts`, `src/api.ts`, `src/attendance.ts`, `src/audit.ts`, `src/roles.ts`, `src/screenshots.ts`, `src/timesheet.ts` |

**New**

| Area | Files | Names (path under the area) |
|---|---|---|
| apps/api/test | 3 | `qa-round2-security.e2e.test.ts`, `qa-round3-fixes.e2e.test.ts`, `role-separation-live-status.e2e.test.ts` |
| apps/dashboard | 2 | `src/app/(admin)/_components/day-timeline.tsx`, `src/app/my/_components/live-status.tsx` |
| apps/desktop (TypeScript, tests, html) | 3 | `src/live-state.ts`, `test/live-state.test.ts`, `test/privacy-apis.test.ts` |
| packages/shared | 1 | `src/live-status.test.ts` |

## Migration added

| Id | Change |
|---|---|
| `0029_device_live_state` | `devices`: `activity_state`, `activity_state_since`, `activity_state_at`, `screenshot_state`, `screenshot_state_at`; `screenshots.deleted_reason` (max 500 chars). Additive and nullable. Tested from 0016 with data in `packages/database/src/migration-status.test.ts`. Not applied to any real database. |

## Decisions taken (coordinator)

| Decision |
|---|
| A locked screen counts as IDLE on both platforms; sleep and another user's session stay unobserved |
| Live state rides on the existing sync call, plus a report on change and every 60 s |
| Long idle splits every 15 minutes |
| macOS idle source switched to HID system state |
| No Windows input hooks (injected input still counts as activity on Windows) |
| Super Admin-only: screenshot and timelapse deletion, all retention purges and retention changes, storage connect / disconnect, role management; other settings shared by both admin identities |
| No web clock-in (desktop only) |
| No automatic closing of forgotten clock-outs (flag plus the existing corrections) |
| Team-head read scope unchanged |

## Decisions awaiting the owner

| Question |
|---|
| Is locked = IDLE wanted? |
| Approve a Windows low-level hook that reads only the injected flag? |
| Do any employees work through remote-desktop tools? (the macOS HID source marks them idle) |
| Should team heads keep read access to members' screenshots and activity? |
| Is web clock-in wanted? |
| `staging-suite.mjs` needs its admin account to be a Super Admin |
| Does production already have equal activity and screenshot notice versions? (the new check only blocks future changes) |
| 30-day absolute sessions with no idle timeout |

## Known limits / not done

| Item |
|---|
| Desktop "My screenshots" has no date filter (web has one) |
| Teams admin page loads the first 100 employees; leave history and team pages show the first 100 rows |
| IT Admin loses the Actor / Target filters on the audit page |
| All-employees gallery reads are not audited per employee |
| Thumbnails serve the full image |
| OneDrive disconnect returns 500 when OneDrive is not configured (existed before) |
| The 250 ms collector loop was left as is |
| The desktop client type is self-declared at login |
| Code signing, auto-update, Windows ARM64 unchanged |

## Test totals (QA's own final run)

| Suite | Command | Result | Status |
|---|---|---|---|
| Build packages | `pnpm build:packages` | exit 0 | PASS |
| Typecheck (all packages, incl. dashboard) | `pnpm typecheck` | exit 0 | PASS |
| Lint (all packages, incl. `cargo clippy -D warnings`) | `pnpm lint` | exit 0 | PASS |
| packages/shared | `pnpm --filter @workfolio/shared test` | 16 files, 76 tests, 76 pass, 0 fail, 0 skipped | PASS |
| packages/database | `pnpm --filter @workfolio/database test` | 10 files, 49 tests, 49 pass | PASS |
| apps/api | `pnpm --filter @workfolio/api test` | 58 files, 479 tests, 479 pass, 0 fail, 0 skipped, 0 todo | PASS |
| browser-extension | `pnpm --filter @workfolio/browser-extension test` | 7 tests, 7 pass | PASS |
| desktop TypeScript | `node --test` in apps/desktop | 15 files, 81 tests, 81 pass | PASS |
| desktop Rust | `cargo test` | 103 pass, 0 fail, 1 ignored (`native_capture_benchmark`: captures the screen) | PASS |
| desktop Rust lint | `cargo clippy -- -D warnings` | exit 0 | PASS |
| dashboard unit | `node --test src/lib/*.test.mjs` | 2 files, 9 tests, 9 pass | PASS |
| dashboard build + smoke | `pnpm --filter @workfolio/dashboard test` | build ok, smoke 35 routes | PASS |
| Windows cross-compile | `cargo check --target x86_64-pc-windows-gnu`, empty separate target dir | 260 crates compiled, 54 s, exit 0 | PASS (compile only; not a runtime result) |

Browser suites and the list of what was not run are in FINAL-REGRESSION-REPORT.md.

## Acceptance criteria

The brief's 18 criteria, in the brief's numbering. Mapped by the coordinator from QA's verified results; a compile or unit-test result is never counted as a runtime PASS.

| # | Criterion (brief) | Status | Evidence |
|---|---|---|---|
| 1 | Windows keyboard and mouse activity resets the idle timer | BLOCKED | `GetLastInputInfo` path unchanged and code-reviewed; tracker unit tests PASS; no Windows machine, so no runtime run |
| 2 | Repeated presses of the same key count as activity without recording key content | PARTIAL | No key content is read (`privacy-apis.test.ts` PASS, source check). Repeated presses reset the counter by API contract; held-key auto-repeat believed to (about 85%); Windows runtime BLOCKED |
| 3 | Windows goes IDLE after the configured threshold | BLOCKED | Tracker tests PASS on the host; Windows cross-compile PASS (compile only); runtime BLOCKED |
| 4 | Windows returns to ACTIVE when genuine input resumes | BLOCKED | As 3. Injected input still counts as genuine on Windows (no hooks; awaiting owner) |
| 5 | macOS has equivalent verified behaviour | PARTIAL | 103 Rust tests PASS on this Mac; idle source and lock rule changed since the 2026-10-19 native run, so `verify:native` and the human checks are NOT RUN |
| 6 | Clock-in/clock-out works end to end | PARTIAL | API e2e PASS (duplicates, invalid transitions, offline, DST, missing clock-out); dashboards render it in browser suites; clock-in from a real desktop app NOT RUN / BLOCKED. Web clock-in NOT IMPLEMENTED by decision |
| 7 | Employee sees only own screenshots and cannot delete them | PASS | API e2e (404 on others, 403 on delete, no modify route); `verify-my-panel` browser suite 46/46. Team heads read their team's screenshots by earlier design (awaiting owner) |
| 8 | IT Admin can view all authorised employee information incl. screenshots, attendance, activity | PARTIAL | API e2e PASS; `verify-web-app` 91/91 as both identities; live ACTIVE/IDLE column never exercised with a real desktop app |
| 9 | Super Admin dashboard shows correct organisation-wide information | PARTIAL | `verify-web-app` 91/91: every admin page loads with real API data and no errors; content of the new live column and day timeline code-read only |
| 10 | Activity timelines display real persisted data | PARTIAL | GET /attendance/timeline e2e PASS (order, ties, pagination, DST); components render server rows only (code read); no browser assertion on timeline content |
| 11 | Screenshot capture and storage work in an isolated authorised test environment | PARTIAL | Upload, storage, retrieval, retention PASS in API e2e with local storage and a fake Graph; real capture NOT RUN (macOS) / BLOCKED (Windows); real OneDrive NOT RUN |
| 12 | Screenshot consent and production feature controls are enforced | PASS | Server rejects uploads with policy off or before consent (e2e); separate screenshot notice version enforced; device gating PASS in Rust tests with a fake OS; default remains off |
| 13 | All three web panels enforce server-side role permissions | PASS | `qa-round2-security` (HTTP sweep, role separation), `qa-round3-fixes`, `role-separation-live-status` |
| 14 | Backend integration tests pass | PASS | api 479/479 |
| 15 | Unit and regression tests pass | PASS | shared 76, database 49, extension 7, desktop TS 81, Rust 103 (+1 ignored: real capture), dashboard 9; browser suites in FINAL-REGRESSION-REPORT.md |
| 16 | Windows and macOS builds pass | PARTIAL | macOS: `cargo test`/clippy PASS, release bundle NOT RUN this session. Windows: cross `cargo check` PASS (260 crates), MSVC installer build NOT RUN (needs CI on windows-latest) |
| 17 | Runtime verification documented separately per OS | PASS | WINDOWS-IDLE-AND-SCREENSHOT-TESTS.md (all runtime rows BLOCKED), MACOS-IDLE-AND-SCREENSHOT-TESTS.md (human rows NOT RUN) |
| 18 | No production deployment has occurred | PASS | Nothing committed, pushed, merged or deployed |

## Production and rollout

Nothing was committed, pushed, merged or deployed; no production data, service or secret was touched; capture and website tracking defaults remain off. Production activation is pending.

| Rollout requirement |
|---|
| Owner review of the diff and of the decisions above |
| Migration `0029_device_live_state` applied through the normal deployment process |
| At least one account with the Super Admin title before deploying (otherwise nobody can manage roles, delete, purge, change retention or connect storage) |
| Approved monitoring policy, notice wording and consent before enabling screenshots |
| New desktop builds for both platforms (old builds send no live state: their users show as UNKNOWN) |
| Physical Windows and macOS runtime passes of the checklists in `docs/windows.md` and MACOS-IDLE-AND-SCREENSHOT-TESTS.md |
