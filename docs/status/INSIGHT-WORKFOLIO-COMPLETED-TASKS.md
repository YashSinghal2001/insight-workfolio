# Insight Workfolio: Completed Tasks (2026-11-02)

**13 of the 139 cohort tasks are now DONE**, each verified against its own criterion from the master checklist. Baseline DONE rows from the audit (51) are not repeated here.

All test runs below were repeated on the final tree (shared 67/67, database 37/37, API 367/367, desktop TS 66/66, Rust 94 + 1 ignored, extension 7/7, typecheck and lint clean, dashboard smoke 35 routes).

## AW-05: Screenshot gallery times in the employee's timezone (OD-14)

- **Previous status:** PENDING
- **Criterion:** Two employees in different timezones show local capture times
- **What was implemented:** Gallery items now carry the employee's timezone from the API; the admin gallery formats thumbnail text, aria-label, viewer header and alt in that zone with the zone named, and no longer fetches each employee.
- **Files:**
  - `apps/api/src/screenshots/screenshots.service.ts`
  - `packages/shared/src/screenshots.ts`
  - `apps/api/test/screenshots-gallery.e2e.test.ts`
  - `apps/dashboard/src/app/(admin)/screenshots/page.tsx`
  - `apps/dashboard/src/lib/zoned-time.ts`
  - `apps/dashboard/src/lib/zoned-time.test.mjs`
  - `apps/dashboard/scripts/verify-wave2.mjs`
- **Tests executed:** screenshots-gallery.e2e (in API 367/367); zoned-time.test.mjs 2/2; verify-gallery.mjs 18/18; verify-wave2.mjs 55/55 in next dev and in a production next start.
- **Result:** Pass.
- **Evidence the criterion is met:** API returns employee.timezone on gallery items (e2e); page formats every capture time in that zone with the zone named. Browser: same instant shows 16:40:07 (Asia/Kolkata) and 06:10:07 (America/New_York); verify-gallery 18/18; verify-wave2 55/55 dev + prod.

## EW-05: **[audit]** Uncommitted `setup-password/page.tsx` change (fragment token read once and not overwritten when the effect runs twice; new success wording). The author session is unknown, and the change was made after the last full web verification.

- **Previous status:** NEEDS VERIFICATION
- **Criterion:** Open a setup link in dev (StrictMode) and in a production build; the password can be set; the fragment is stripped from history
- **What was implemented:** Verified the unknown-author change to setup-password/page.tsx (it was correct and left unchanged); added a re-runnable headless-browser check with a production mode.
- **Files:**
  - `apps/dashboard/src/app/setup-password/page.tsx (verified, not edited)`
  - `apps/dashboard/scripts/verify-setup-password.mjs`
  - `apps/dashboard/package.json (verify:setup-password)`
- **Tests executed:** verify-setup-password.mjs against next dev (StrictMode) and VERIFY_MODE=start against a production build.
- **Result:** 14/14 in dev, 14/14 in production.
- **Evidence the criterion is met:** Unknown-author change reviewed (correct, unchanged). verify-setup-password.mjs 14/14 in next dev (StrictMode) and 14/14 against a production next build: password set, fragment stripped from address bar and history, reuse refused, empty fragment warns. Author still unidentified.

## API-06: **[audit]** `/api/v1/ready` checks only the database (`health.controller.ts:38`); a broken storage provider still reports ready

- **Previous status:** PENDING
- **Criterion:** Ready returns 503 when the storage provider fails its check
- **What was implemented:** /api/v1/ready probes the configured storage provider (FILE_STORAGE.stat on a never-written key) in parallel with the DB ping, 2 s timeout each; returns 503 with checks.storage {status, provider} and no secrets on failure.
- **Files:**
  - `apps/api/src/health/health.controller.ts`
  - `packages/shared/src/api.ts`
  - `apps/api/test/health.e2e.test.ts`
- **Tests executed:** health.e2e: up case asserts provider LOCAL_DEV; forced-failure case asserts 503, error 'unreachable', no secret text, recovery to 200.
- **Result:** Pass (in API 367/367).
- **Evidence the criterion is met:** /ready probes FILE_STORAGE.stat() alongside the DB; 503 + {status:down, error:unreachable, provider} on failure, no secrets. health.e2e forced-failure test. Real Graph/Drive probes run only once a provider exists.

## API-07: API HSTS header (SEC-05)

- **Previous status:** PENDING
- **Criterion:** `Strict-Transport-Security` on API responses in production mode
- **What was implemented:** HSTS (max-age=31536000; includeSubDomains) added by the API header middleware only when NODE_ENV=production; applies to error responses too.
- **Files:**
  - `apps/api/src/app.setup.ts`
  - `apps/api/test/health.e2e.test.ts`
- **Tests executed:** e2e: header absent in test mode; second app with production config has it on /health and on a 404.
- **Result:** Pass (in API 367/367).
- **Evidence the criterion is met:** app.setup.ts header middleware adds HSTS max-age=31536000; includeSubDomains when NODE_ENV=production (also on 404s). e2e asserts absent in test mode, present in production config.

## API-08: Revoking a device also revokes its sessions; optional re-enrolment approval (SEC-08)

- **Previous status:** PENDING
- **Criterion:** e2e: revoke device → refresh with its token fails
- **What was implemented:** Migration 0023_session_device adds sessions.device_id; DevicesService.touch() links the caller's session to its active device; revoke() revokes those sessions in the same batch as the device update and audit row. Super Admin guard unchanged.
- **Files:**
  - `packages/database/src/migrations.ts (0023)`
  - `apps/api/src/devices/devices.service.ts`
  - `apps/api/test/device-sessions.e2e.test.ts`
  - `packages/database/src/session-device.test.ts`
  - `apps/api/test/{attendance,devices-audit,activity,screenshots,security-hardening}.e2e.test.ts (adjusted for 401)`
- **Tests executed:** device-sessions.e2e; session-device.test.ts (existing sessions survive, FK, index used).
- **Result:** Pass (API 367/367, database 37/37).
- **Evidence the criterion is met:** Migration 0023_session_device; DevicesService.touch() binds the session to its device; revoke() revokes those sessions in the same batch. device-sessions.e2e: revoked device's refresh → 401, other sessions unaffected. Optional re-enrolment approval not built (optional). Revoked device's own session now gets 401 instead of 403.

## SEC-08: **[audit]** Re-run the secret scan before the first commit. W0 scanned earlier; new files since then include the Google Drive reports and scripts, and the OneDrive reports contain tenant/site/drive identifiers.

- **Previous status:** NEEDS VERIFICATION
- **Criterion:** Scan finds no secrets; identifiers redacted or a decision to keep them private
- **What was implemented:** Secret scan re-run on the whole tree (excluding .env*, node_modules, build output) and every hit classified without printing values.
- **Files:**
  - `(no repository files changed)`
- **Tests executed:** Scan at end of wave 2 (206 hits) and on the final tree (226 hits: 211 password-literal, 9 token-literal, 6 client_secret-literal).
- **Result:** 0 real secrets; all hits are field names, env references, fixture passwords or obvious placeholders. Tenant/site/drive identifiers: none left in the repo (only the fixed leave-type GUID matches).
- **Evidence the criterion is met:** Scan re-run: 0 real secrets (206 hits = field names, fixtures, placeholders). The files holding tenant/site/drive identifiers were moved to Trash by you, so the repo no longer contains them (re-checked: only the fixed leave-type GUID matches).

## SEC-11: **[audit]** Re-confirm containment of the Microsoft app before any new consent (dormant Limited Access would re-activate if the folder scope is re-consented)

- **Previous status:** PENDING
- **Criterion:** Documented guard: never re-consent `Files.SelectedOperations.Selected`
- **What was implemented:** Documented guard against re-consenting the Microsoft app's folder scope, the prerequisites before any consent, and the post-change probe.
- **Files:**
  - `docs/security.md`
- **Tests executed:** Document review.
- **Result:** Section present.
- **Evidence the criterion is met:** docs/security.md 'Microsoft app re-consent guard': never consent Files.SelectedOperations.Selected / Files.*, prerequisites, post-change probe.

## DEP-05: Build guards for unset `NEXT_PUBLIC_API_URL` / `VITE_DASHBOARD_URL` (HOST-05)

- **Previous status:** PENDING
- **Criterion:** Build fails without them in production
- **What was implemented:** Dashboard next build refuses to run in production without an https NEXT_PUBLIC_API_URL (localhost allowed). Desktop release config refuses a missing or non-https WORKFOLIO_DASHBOARD_URL; vite release guard; CI sets the variables.
- **Files:**
  - `apps/dashboard/next.config.ts`
  - `apps/dashboard/package.json`
  - `.github/workflows/ci.yml`
  - `apps/desktop/scripts/desktop-config.mjs`
  - `apps/desktop/vite.config.ts`
  - `apps/desktop/test/desktop-config.test.ts`
- **Tests executed:** next build with the variable empty, unset and http (all exit 1) and with localhost / https (exit 0); desktop-config dry runs (exit 1 without the URL); desktop-config tests.
- **Result:** Pass (desktop TS 66/66; final dashboard build + smoke pass).
- **Evidence the criterion is met:** Dashboard: next build exits 1 with NEXT_PUBLIC_API_URL unset/empty/http (verified builds). Desktop: desktop-config exits 1 without https WORKFOLIO_DASHBOARD_URL; vite release guard; tests in desktop-config.test.ts.

## W18: Absence marking

- **Previous status:** PARTIAL
- **Criterion:** Holidays not considered
- **What was implemented:** Daily attendance treats an organisation holiday as HOLIDAY (never ABSENT); leave-day counting skips holidays.
- **Files:**
  - `apps/api/src/attendance/attendance.service.ts`
  - `apps/api/src/holidays/**`
  - `packages/shared/src/holidays.ts`
  - `apps/dashboard/src/app/(admin)/attendance/page.tsx`
  - `apps/api/test/holidays.e2e.test.ts`
- **Tests executed:** holidays.e2e (4 tests); verify-wave2 browser check of /attendance.
- **Result:** Pass.
- **Evidence the criterion is met:** Holidays (0022) labelled HOLIDAY, never ABSENT (holidays.e2e). Browser: 2026-11-01 holiday shows all 4 employees Holiday, nobody Absent; contrast day shows Absent.

## W35: Short leave with a limit

- **Previous status:** PARTIAL
- **Criterion:** Quota missing
- **What was implemented:** Leave types can carry a monthly short-leave hours quota; short leave is counted in hours against it and refused when exceeded.
- **Files:**
  - `packages/database/src/migrations.ts (0021)`
  - `apps/api/src/leave/leave.service.ts`
  - `packages/shared/src/leave.ts`
  - `apps/dashboard/src/app/(admin)/leave/leave-types.tsx`
  - `apps/dashboard/src/app/my/leave/page.tsx`
  - `apps/api/test/leave-balances.e2e.test.ts`
- **Tests executed:** leave-balances.e2e 'short leave counts against the monthly hours quota'; browser /my/leave.
- **Result:** Pass.
- **Evidence the criterion is met:** Leave types carry a short-leave hours quota per month; short leave counts against it (leave-balances.e2e). Browser: /my/leave shows 4 of 4 h left.

## W36: Leave types and balances

- **Previous status:** PENDING
- **Criterion:** Migration needed
- **What was implemented:** Admin-defined leave types (paid/unpaid, yearly allowance, optional short-leave quota; deactivate, never delete); computed balances; approval past the allowance refused with a clear message; existing requests default to an unlimited 'General' type.
- **Files:**
  - `packages/database/src/migrations.ts (0021)`
  - `packages/database/src/leave-holidays.test.ts`
  - `apps/api/src/leave/**`
  - `packages/shared/src/leave.ts`
  - `packages/shared/src/leave-balances.test.ts`
  - `apps/dashboard/src/app/(admin)/leave/{page,leave-types,leave-balances}.tsx`
  - `apps/dashboard/src/app/my/leave/page.tsx`
  - `apps/api/test/leave-balances.e2e.test.ts`
  - `docs/leave-requests.md`
- **Tests executed:** leave-balances.e2e (6 tests incl. concurrency and isolation); leave-holidays.test.ts (existing data survives); browser admin + employee.
- **Result:** Pass.
- **Evidence the criterion is met:** 0021_leave_types (existing requests default to General); balances computed; approval past allowance refused; concurrency-safe; isolation (leave-balances.e2e, 6 tests). Browser: type created, admin balances column, employee sees balance and requests with a type.

## W38: Holiday calendar

- **Previous status:** PENDING
- **Criterion:** Migration needed
- **What was implemented:** Organisation holiday calendar (one per date) with admin API (list/add/remove/CSV import) and page.
- **Files:**
  - `packages/database/src/migrations.ts (0022)`
  - `apps/api/src/holidays/{holidays.controller,holidays.service}.ts`
  - `packages/shared/src/holidays.ts`
  - `apps/dashboard/src/app/(admin)/holidays/page.tsx`
  - `apps/dashboard/src/components/sidebar.tsx`
  - `apps/api/test/holidays.e2e.test.ts`
- **Tests executed:** holidays.e2e; leave-holidays.test.ts; browser /holidays.
- **Result:** Pass.
- **Evidence the criterion is met:** 0022_holidays + /holidays admin API and page (holidays.e2e). Browser: empty state, add, list.

## W40: Teams

- **Previous status:** PENDING
- **Criterion:** Migration needed
- **What was implemented:** Teams: create, rename, deactivate/reactivate, set or clear the head, set members (an employee may be in several teams), admin page and sidebar entry.
- **Files:**
  - `packages/database/src/migrations.ts (0024)`
  - `apps/api/src/teams/{teams.controller,teams.service}.ts`
  - `packages/shared/src/teams.ts`
  - `packages/shared/src/teams.test.ts`
  - `packages/database/src/teams.test.ts`
  - `apps/dashboard/src/app/(admin)/teams/page.tsx`
  - `apps/api/test/teams.e2e.test.ts`
  - `docs/teams.md`
- **Tests executed:** teams.e2e (CRUD, validation 400, duplicate 409, unknown 404, employees 403); teams.test.ts; browser /teams.
- **Result:** Pass.
- **Evidence the criterion is met:** 0024_teams; teams CRUD, members, head (teams.e2e). Browser: empty states, create Support, add 2 members, members column 2.

