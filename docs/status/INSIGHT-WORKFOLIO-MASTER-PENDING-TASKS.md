# Insight Workfolio: Master Pending-Task Checklist (updated 2026-11-02, after Phase 1)

Successor to the audit's checklist of the same name, which you moved to `~/.Trash/workfolio-md/` together with the other root reports. It keeps every original row (202), original ID and description. **Audit** is the audit status, **After exec 1** the status after the first execution (139-task run), **Status** the current status after Phase 1 (the 24 PARTIAL tasks), each set only on evidence. Phase 1 details: `INSIGHT-WORKFOLIO-PARTIAL-TASK-EXECUTION-REPORT.md`.

The **139-task execution cohort** is every row that was not DONE or DEFERRED in the audit; those rows are marked ● in the C column. The 63 baseline rows (51 DONE + 12 DEFERRED) are kept for traceability and were not re-opened.

## Totals

### 139-task cohort

| Status | Tasks |
|---|---:|
| DONE | 19 |
| PARTIAL | 1 |
| BLOCKED | 79 |
| NEEDS VERIFICATION | 40 |
| PENDING | 0 |
| DEFERRED | 0 |
| **Total** | **139** |

### All 202 rows by area (new status)

| Area | DONE | PARTIAL | BLOCKED | NEEDS VERIFICATION | PENDING | DEFERRED | Total |
|---|---:|---:|---:|---:|---:|---:|---:|
| Admin Web | 3 | 0 | 4 | 0 | 0 | 0 | 7 |
| Employee Web | 5 | 0 | 1 | 0 | 0 | 0 | 6 |
| API | 8 | 0 | 5 | 0 | 0 | 0 | 13 |
| Database | 6 | 0 | 10 | 1 | 0 | 0 | 17 |
| Storage | 2 | 0 | 14 | 2 | 0 | 4 | 22 |
| macOS | 2 | 0 | 5 | 12 | 0 | 0 | 19 |
| Windows | 1 | 0 | 5 | 15 | 0 | 1 | 22 |
| Browser Extension | 1 | 0 | 1 | 1 | 0 | 1 | 4 |
| Security | 9 | 0 | 4 | 0 | 0 | 1 | 14 |
| Deployment | 1 | 0 | 13 | 1 | 0 | 0 | 15 |
| CI/CD | 1 | 0 | 4 | 2 | 0 | 0 | 7 |
| Product Features | 31 | 1 | 13 | 6 | 0 | 5 | 56 |
| **Total** | **70** | **1** | **79** | **40** | **0** | **12** | **202** |

Overlap kept from the audit (one root cause, two rows): W34↔ST-02, F12↔API-09, W48↔Windows rows, W49↔MAC-17/MAC-13, W53↔DEP-07, W46↔MAC-09.

## Admin Web

| C | ID | Task | P | Audit | After exec 1 | Status | Evidence / what remains | Depends on | Decision |
|---|---|---|---|---|---|---|---|---|---|
|  | AW-01 | 20 admin pages: employees, attendance, timesheets, corrections, activity, screenshots, websites, projects, leave, reports, roles, audit, settings (schedule, labels), account | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
|  | AW-02 | Destructive actions behind confirmation dialogs; 403 messages shown | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
| ● | AW-03 | Admin web on staging over HTTPS against the real API | P0 | BLOCKED | BLOCKED | **BLOCKED** | Needs Render + Vercel accounts and a domain (D4: DEP-01, DEP-04, DEP-06). Nothing to do locally. | DEP-01, DEP-04, DEP-06 | Hosting accounts and domain |
| ● | AW-04 | Storage connection and status panel (provider, account, last upload, "Connect Google Drive" button if Google is chosen) | P1 | PENDING | PARTIAL | **BLOCKED** | Local part done: Storage card shows provider, status and 'Last upload' (admin-only GET /settings/screenshots, not exposed on public /ready; e2e + browser). Remaining account display and Connect/disconnect against the real provider need the storage decision (D1). | ST-02 | Storage provider |
| ● | AW-05 | Screenshot gallery times in the employee's timezone (OD-14) | P2 | PENDING | DONE | **DONE** | API returns employee.timezone on gallery items (e2e); page formats every capture time in that zone with the zone named. Browser: same instant shows 16:40:07 (Asia/Kolkata) and 06:10:07 (America/New_York); verify-gallery 18/18; verify-wave2 55/55 dev + prod. | — | — |
| ● | AW-06 | Timelapse viewer: durable playback after API restart (today the MP4 lives only in the API host cache) | P1 | PARTIAL | PARTIAL | **BLOCKED** | No local work left: durable playback needs ST-19 → DB-11 (0018), i.e. the storage decision (D1). | ST-19 | — |
| ● | AW-07 | Policy and UI for admin-issued setup links (SEC-07: an Admin can mint a link for another user) | P1 | BLOCKED | BLOCKED | **BLOCKED** | Needs your setup-link policy (D6): who may mint links for whom. | — | Setup-link policy |

## Employee Web

| C | ID | Task | P | Audit | After exec 1 | Status | Evidence / what remains | Depends on | Decision |
|---|---|---|---|---|---|---|---|---|---|
|  | EW-01 | 10 `/my/*` pages (attendance, activity, screenshots, websites, projects, tasks, leave, reports, profile, home) | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
|  | EW-02 | Server-side isolation: other people's records return 404 | P0 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
|  | EW-03 | 390 px mobile layout and drawer | P2 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
|  | EW-04 | Redirect to login when the session expires mid-use | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
| ● | EW-05 | **[audit]** Uncommitted `setup-password/page.tsx` change (fragment token read once and not overwritten when the effect runs twice; new success wording). The author session is unknown, and the change was made after the last full web verification. | P1 | NEEDS VERIFICATION | DONE | **DONE** | Unknown-author change reviewed (correct, unchanged). verify-setup-password.mjs 14/14 in next dev (StrictMode) and 14/14 against a production next build: password set, fragment stripped from address bar and history, reuse refused, empty fragment warns. Author still unidentified. | — | — |
| ● | EW-06 | Employee web on staging over HTTPS | P0 | BLOCKED | BLOCKED | **BLOCKED** | Needs staging hosts (AW-03 / D4). | AW-03 | Hosting accounts |

## API

| C | ID | Task | P | Audit | After exec 1 | Status | Evidence / what remains | Depends on | Decision |
|---|---|---|---|---|---|---|---|---|---|
|  | API-01 | Deny-by-default `AuthGuard` + `@RequirePermission`; route-permission test (11 public routes incl. Google OAuth callback) | P0 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
|  | API-02 | Own-session management, `account_audit`, `/audit` viewer, `mine` filters | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
|  | API-03 | Per-device `UNSUPPORTED_PLATFORM` warning | P2 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
|  | API-04 | Env validation refuses unsafe production config (local DB, `wss://`, local storage, http CORS, bad OAuth redirect) | P0 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
|  | API-05 | **[audit]** API refuses to start with `SCREENSHOT_STORAGE=google-drive` until the `storage_provider` CHECK accepts `GOOGLE_DRIVE` (fail-closed guard) | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
| ● | API-06 | **[audit]** `/api/v1/ready` checks only the database (`health.controller.ts:38`); a broken storage provider still reports ready | P2 | PENDING | DONE | **DONE** | /ready probes FILE_STORAGE.stat() alongside the DB; 503 + {status:down, error:unreachable, provider} on failure, no secrets. health.e2e forced-failure test. Real Graph/Drive probes run only once a provider exists. | ST-02 | — |
| ● | API-07 | API HSTS header (SEC-05) | P2 | PENDING | DONE | **DONE** | app.setup.ts header middleware adds HSTS max-age=31536000; includeSubDomains when NODE_ENV=production (also on 404s). e2e asserts absent in test mode, present in production config. | — | — |
| ● | API-08 | Revoking a device also revokes its sessions; optional re-enrolment approval (SEC-08) | P1 | PENDING | DONE | **DONE** | Migration 0023_session_device; DevicesService.touch() binds the session to its device; revoke() revokes those sessions in the same batch. device-sessions.e2e: revoked device's refresh → 401, other sessions unaffected. Optional re-enrolment approval not built (optional). Revoked device's own session now gets 401 instead of 403. | — | — |
| ● | API-09 | Email `MailTransport` for setup/invite links and reports (EM-02…04) | P1 | PENDING | BLOCKED | **BLOCKED** | Needs an email provider and sending mailbox (D5). Alerts (F06) already call a no-op sendAlertEmails hook ready for it. | DEC email provider | Email provider |
| ● | API-10 | Google OAuth pending state and connection survive restarts / more than one instance (state is an in-process `Map`) | P3 | PENDING | BLOCKED | **BLOCKED** | Only relevant if Google Drive is chosen (D1). Pending state is still an in-process Map, documented in docs/deployment.md single-instance section. | ST-02 = Google | — |
| ● | API-11 | Multi-device per employee (P3-02…04: index relaxation, clock-event conflict rules, tests) | P2 | BLOCKED | BLOCKED | **BLOCKED** | Needs the devices-per-employee decision (D10). | P3-01 decision | Devices per employee |
| ● | API-12 | FFmpeg with libx264 on the API host; persistent `TIMELAPSE_DIR` (TL-05) | P1 | BLOCKED | BLOCKED | **BLOCKED** | Needs the Render service (DEP-01) with FFmpeg + the persistent disk declared in render.yaml. | DEP-01 | Render plan |
| ● | API-13 | **[audit]** Single-instance constraint documented and enforced on Render (OAuth state, in-process caches, migration runner assumptions) | P1 | NEEDS VERIFICATION | PARTIAL | **BLOCKED** | No local work left: the single-instance rule is audited and recorded (render.yaml numInstances: 1, docs/deployment.md); the criterion is the real Render setting (DEP-01, D4). | DEP-01 | — |

## Database

| C | ID | Task | P | Audit | After exec 1 | Status | Evidence / what remains | Depends on | Decision |
|---|---|---|---|---|---|---|---|---|---|
|  | DB-01 | Checksummed forward-only migrations; unknown or edited migration refuses boot; concurrent-runner safe; FK enforcement check | P0 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
|  | DB-02 | Migrations 0001–0017 and 0019 in source; local `dev.db` at 0019 (44 tables) | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
|  | DB-03 | Turso staging DB `workfolio` (aws-ap-south-1) created; credentials git-ignored, mode 600 | P0 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
|  | DB-04 | T1 connectivity over HTTP and WebSocket | P0 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
|  | DB-05 | T3 foreign keys enforced on Turso | P0 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
|  | DB-06 | `verify:turso` and migrate-only command in the repo | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
| ● | DB-07 | T2 second migration run applies nothing on Turso | P1 | NEEDS VERIFICATION | BLOCKED | **DONE** | **DONE 2026-11-03:** a second `db:migrate` on Turso staging printed "No pending migrations." (TURSO-DATABASE-IMPLEMENTATION-REPORT.md). Needs Turso migration approval (D3, after DB-09/DB-10). Locally: migration-order.test.ts proves a second run applies nothing. | DB-09 | — |
| ● | DB-08 | T4 integrity check and guard/unique error mapping on Turso | P1 | NEEDS VERIFICATION | NEEDS VERIFICATION | **NEEDS VERIFICATION** | 2026-11-03: integrity_check, quick_check and foreign_key_check clean on Turso at 0028; guard/unique error mapping on Turso still not exercised. Audit 2026-11-03 (read-only, docs/status/TURSO-DATABASE-READINESS-AUDIT.md): `verify:turso` plus `integrity_check`, `quick_check` and `foreign_key_check` ran clean on Turso staging at 0016. Still open: guard/unique error mapping on Turso (needs the migrated schema and the API) and a re-check at 0028. | — | — |
| ● | DB-09 | **Apply 0017 to Turso staging.** Turso is at 0016. | P0 | BLOCKED | BLOCKED | **DONE** | **DONE 2026-11-03** (approved by the user): `db:migrate` applied 0017 with 0019 and 0021–0028 to Turso staging; `verify:turso`: 26 applied, 0 pending, 51 tables / 65 indexes / 91 triggers identical to reference, integrity/quick/FK checks clean (TURSO-DATABASE-IMPLEMENTATION-REPORT.md). Turso migration approval (D3). Turso is at 0016; Audit 2026-11-03 (read-only, docs/status/TURSO-DATABASE-READINESS-AUDIT.md): 10 pending (0017, 0019, 0021–0028), no Turso dump yet. | CI-01 (commit first) | Migration approval |
| ● | DB-10 | **[audit] Apply 0019 (screenshot blur policy) to Turso staging.** It is not on Turso (Turso is at 0016). | P0 | BLOCKED | BLOCKED | **DONE** | **DONE 2026-11-03** (approved by the user): 0019 applied to Turso staging with 0017 and 0021–0028; verified as for DB-09 (TURSO-DATABASE-IMPLEMENTATION-REPORT.md). Turso migration approval (D3). NOTE: source now has 0021–0028 too. Audit 2026-11-03 (read-only, docs/status/TURSO-DATABASE-READINESS-AUDIT.md): Turso at 0016, 10 pending (0017, 0019, 0021–0028), no Turso dump yet, no Super Admin. Hosted API boots no longer migrate (they refuse to start while any are pending; this change set), so apply via the runbook in docs/database-operations.md. | DB-09 | Migration approval |
| ● | DB-11 | Migration 0018 (timelapse storage columns, reserved by the Graph session, **not written**) | P1 | BLOCKED | BLOCKED | **BLOCKED** | 0018 waits on the storage decision (D1). Gap-fill tests now prove a later 0018 applies safely after 0019–0028. | ST-02 | Storage provider |
| ● | DB-12 | **[audit]** Migration 0020: widen `screenshots.storage_provider` CHECK to include `GOOGLE_DRIVE` (not written; required before Google Drive can store screenshots) | P1 | BLOCKED | BLOCKED | **BLOCKED** | 0020 only if Google Drive is chosen (D1) + migration approval. | ST-02 = Google | Storage provider + migration approval |
| ● | DB-13 | Turso plan and restore window recorded | P1 | PENDING | BLOCKED | **BLOCKED** | Needs Turso account access to read the plan/PITR window (the `turso` CLI is not installed on the audit machine). docs/database-operations.md has the blank table to fill. | — | — |
| ● | DB-14 | T19 point-in-time restore rehearsal into a new database | P1 | PENDING | BLOCKED | **BLOCKED** | Needs Turso account (and DB-13). Owner steps written in docs/database-operations.md. | DB-13 | — |
| ● | DB-15 | Dump procedure before each migration-bearing deploy | P1 | PENDING | PARTIAL | **DONE** | **DONE 2026-11-03:** first Turso dump `~/insight-workfolio-backups/workfolio-2026-11-03T06-40-01-494Z.sql` (0600, 40 tables, 19 rows, ids 0001–0016) restored into a scratch SQLite file; `verify:turso` on the restore passed and matched Turso (TURSO-DATABASE-IMPLEMENTATION-REPORT.md). No local work left: dump/restore script and docs done and rehearsed on a local copy; the first real Turso dump needs Turso access and the migration approval (D3). Audit 2026-11-03 (read-only, docs/status/TURSO-DATABASE-READINESS-AUDIT.md): no Turso dump exists yet. | — | — |
| ● | DB-16 | DB-scoped token stored only in Render | P1 | PENDING | BLOCKED | **BLOCKED** | Needs the Render service (DEP-01). render.yaml declares DATABASE_AUTH_TOKEN as sync:false (no value). Audit 2026-11-03 (read-only, docs/status/TURSO-DATABASE-READINESS-AUDIT.md): the current staging token is read-write with no expiry and sits in apps/api/.env.staging inside the repo tree; move it out and rotate once Render/GitHub secrets exist. | DEP-01 | — |
| ● | DB-17 | Separate production Turso database | P2 | PENDING | BLOCKED | **BLOCKED** | Needs pilot sign-off and Turso account. | Pilot sign-off | — |

## Storage

| C | ID | Task | P | Audit | After exec 1 | Status | Evidence / what remains | Depends on | Decision |
|---|---|---|---|---|---|---|---|---|---|
|  | ST-01 | `LocalDevStorage` for development; refused in production by env validation | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
| ● | ST-02 | **Choose the production storage target**: dedicated SharePoint site (`Sites.Selected`), Google Drive (`drive.file`, OAuth), or another provider. The documents disagree: the roadmap keeps "OneDrive folder", the final storage decision says "dedicated SharePoint site", and Google Drive was then prototyped. | P0 | BLOCKED | BLOCKED | **BLOCKED** | Your storage decision (D1). Recommendation in the (trashed) decision doc: dedicated SharePoint site with Sites.Selected. | — | **Storage provider** |
|  | ST-03 | OneDrive-folder containment: folder grant deleted, `Files.SelectedOperations.Selected` consent revoked, 14/14 app-only probes 403 | P0 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
| ● | ST-04 | Remove the dormant app `Limited Access` entries on the personal site and the Documents library (OD-23) | P2 | BLOCKED | NEEDS VERIFICATION | **NEEDS VERIFICATION** | The storage decision doc §7 (read before it was trashed) recorded the Limited Access entries removed on 2026-11-02 by you; not re-checked here (no tenant access). | — | Your manual action (blocked for automation) |
| ● | ST-05 | Revoke Graph Explorer's delegated `Files.ReadWrite` for your account | P2 | BLOCKED | BLOCKED | **BLOCKED** | Your manual action at myapplications.microsoft.com. | — | Your manual action |
|  | ST-06 | Remove unused `Files.SelectedOperations.Selected` and `User.Read` from the app registration (OD-20) | P3 | DEFERRED | DEFERRED | **DEFERRED** | Baseline (not in the 139 cohort); unchanged. | — | — |
| ● | ST-07 | Dedicated private SharePoint site + `Sites.Selected` `write` grant + boundary tests T5–T8 (OD-24) | P0 | BLOCKED | BLOCKED | **BLOCKED** | Needs D1 = SharePoint and your approval to create the site and grant. | ST-02 = SharePoint | Approval to create site and grant |
| ● | ST-08 | Graph session's paused code: `GRAPH_FOLDER_ID`, folder-ID addressing, chunked `putFile`, `getStream`, `folderIsConfigured()` (uncommitted, tenant-untested) | P1 | PARTIAL | PARTIAL | **BLOCKED** | No local work left: keep or drop the storage session's Graph code depends on the storage decision (D1); T6/T7 need the chosen site. | ST-02 | Keep or drop with the decision |
| ● | ST-09 | Storage key layout `Employees/<CODE>/YYYY/MM/DD/<uuid>.webp` (OD-13) | P1 | BLOCKED | BLOCKED | **BLOCKED** | Needs D1. | ST-02 | Storage provider |
| ● | ST-10 | T10 staging end to end: real screenshots land in the target; retention deletes them | P0 | PENDING | BLOCKED | **BLOCKED** | Needs D1 and staging (DEP-01). The staging suite (DEP-13) covers upload/view/delete when it runs. | ST-02, DEP-01 | — |
| ● | ST-11 | Purview retention and holds on the storage site confirmed with the tenant admin (OD-19) | P2 | PENDING | BLOCKED | **BLOCKED** | Needs ST-07 and the tenant admin's written confirmation. | ST-07 | — |
| ● | ST-12 | Microsoft docs updated for the OneDrive rejection (OD-17) | P2 | PENDING | PARTIAL | **BLOCKED** | No local work left: docs/onedrive.md already records the rejection; it becomes final when you approve the storage decision (D1). | ST-02 | — |
| ● | ST-13 | Google Drive adapter + OAuth (code + PKCE S256, single-use 10-min state, binding cookie, server-side exchange, `drive.file`) | P1 | NEEDS VERIFICATION | NEEDS VERIFICATION | **NEEDS VERIFICATION** | Unchanged: fake-Google tests pass (in 367/367); real account run needs ST-14. | — | — |
| ● | ST-14 | Google Cloud project, OAuth client, consent screen, test user | P1 | BLOCKED | BLOCKED | **BLOCKED** | Needs D1 = Google and your Google account. | ST-02 = Google | Your Google account |
| ● | ST-15 | Real Google verification (`verify-google-drive.mjs`) | P1 | PENDING | BLOCKED | **BLOCKED** | Needs ST-14. | ST-14 | — |
| ● | ST-16 | **[audit]** Google refresh token lives in `GOOGLE_DRIVE_TOKEN_FILE` (0600). On Render the filesystem is ephemeral unless a disk is attached, so the connection is lost on every deploy. | P1 | PENDING | BLOCKED | **BLOCKED** | Only if D1 = Google. | ST-02 = Google | — |
| ● | ST-17 | Durable timelapse storage: upload MP4, serve/delete from storage, TTL (TL-01…03) | P1 | PENDING | BLOCKED | **BLOCKED** | Needs DB-11 (0018), blocked on D1. | DB-11 | — |
| ● | ST-18 | Screenshots on Google Drive wired but guarded off until DB-12 | P1 | BLOCKED | BLOCKED | **BLOCKED** | Needs DB-12 (0020), blocked on D1. | DB-12 | Storage provider |
| ● | ST-19 | Timelapse cloud upload adapter (Google adapter ready; service not wired) | P1 | PENDING | BLOCKED | **BLOCKED** | Needs DB-11 / ST-17. | DB-11, ST-17 | — |
|  | ST-20 | Graph upload session for files over 250 MB (TL-04) | P3 | DEFERRED | DEFERRED | **DEFERRED** | Baseline (not in the 139 cohort); unchanged. | — | — |
|  | ST-21 | Certificate credential for Entra app; secret expiry recorded (OD-21) | P2 | DEFERRED | DEFERRED | **DEFERRED** | Baseline (not in the 139 cohort); unchanged. | ST-07 | — |
|  | ST-22 | OneDrive folder tests T6–T8 and folder-specific code (OD-09…12, OD-16) | — | DEFERRED | DEFERRED | **DEFERRED** | Baseline (not in the 139 cohort); unchanged. | — | — |

## macOS

| C | ID | Task | P | Audit | After exec 1 | Status | Evidence / what remains | Depends on | Decision |
|---|---|---|---|---|---|---|---|---|---|
|  | MAC-01 | Feature code: ScreenCaptureKit capture, masks, whole-image blur, unobserved lock/sleep/switch, App Nap opt-out, menu bar, close-to-tray, quit confirm, launch at login, Dock hide | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
|  | MAC-02 | Unsigned arm64 `.app` / `.dmg` build pipeline (P8-08) | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
| ● | MAC-03 | MV-01 automatic app switching (native run, corrected harness) | P1 | NEEDS VERIFICATION | NEEDS VERIFICATION | **NEEDS VERIFICATION** | Needs a human at the Mac (checklist items in MACOS checklist). Not run in this session. | — | — |
| ● | MAC-04 | MV-02 screenshot skipped while asleep ≥ 60 s | P1 | NEEDS VERIFICATION | NEEDS VERIFICATION | **NEEDS VERIFICATION** | Needs a human at the Mac (checklist items in MACOS checklist). Not run in this session. | — | — |
| ● | MAC-05 | MV-03 masks on a real capture | P1 | NEEDS VERIFICATION | NEEDS VERIFICATION | **NEEDS VERIFICATION** | Needs a human at the Mac (checklist items in MACOS checklist). Not run in this session. | — | — |
| ● | MAC-06 | MV-05 lock, sleep, fast-user-switch = unobserved; interval closes at the transition | P1 | NEEDS VERIFICATION | NEEDS VERIFICATION | **NEEDS VERIFICATION** | Needs a human at the Mac (checklist items in MACOS checklist). Not run in this session. | — | — |
| ● | MAC-07 | MV-06 App Nap opt-out while recording; no sleep prevention | P2 | NEEDS VERIFICATION | NEEDS VERIFICATION | **NEEDS VERIFICATION** | Needs a human at the Mac (checklist items in MACOS checklist). Not run in this session. | — | — |
| ● | MAC-08 | MV-07 whole-image blur on a real capture | P1 | NEEDS VERIFICATION | NEEDS VERIFICATION | **NEEDS VERIFICATION** | Needs a human at the Mac (checklist items in MACOS checklist). Not run in this session. | DB-10 (staging) | — |
| ● | MAC-09 | MV-08 menu bar, close/reopen, quit confirmation, Dock hide, launch at login | P1 | NEEDS VERIFICATION | NEEDS VERIFICATION | **NEEDS VERIFICATION** | Needs a human at the Mac (checklist items in MACOS checklist). Not run in this session. | — | — |
| ● | MAC-10 | MV-09 background operation with window hidden; resource use | P1 | NEEDS VERIFICATION | NEEDS VERIFICATION | **NEEDS VERIFICATION** | Needs a human at the Mac (checklist items in MACOS checklist). Not run in this session. | — | — |
| ● | MAC-11 | MV-04 History, My screenshots, Leave tabs inside the packaged window | P2 | NEEDS VERIFICATION | NEEDS VERIFICATION | **NEEDS VERIFICATION** | Packaged suites need a Keychain 'Always Allow' click at first sign-in (fresh build cdhash). Steps: api build; tauri build --debug --bundles app; verify:tasks-packaged / export-packaged / websites-packaged. | — | — |
| ● | MAC-12 | P1-07 platform features verified inside the packaged app | P1 | NEEDS VERIFICATION | NEEDS VERIFICATION | **NEEDS VERIFICATION** | As MAC-11 (Keychain prompt needs a human); plus revoke device/session check. | — | — |
| ● | MAC-13 | Apple Developer ID certificate (P8-01) | P1 | BLOCKED | BLOCKED | **BLOCKED** | Needs your Apple Developer ID (D8). | — | Apple account |
| ● | MAC-14 | Notarisation, hardened runtime, entitlements, `minimumSystemVersion` 14 (P8-02) | P1 | BLOCKED | BLOCKED | **BLOCKED** | Needs MAC-13. | MAC-13 | — |
| ● | MAC-15 | HR/Legal: revised screenshot notice wording (blur) | P1 | BLOCKED | BLOCKED | **BLOCKED** | Needs HR/Legal wording (D7). | — | HR/Legal |
| ● | MAC-16 | Per-environment bundle identifier and keychain service (P8-03) | P1 | PENDING | NEEDS VERIFICATION | **NEEDS VERIFICATION** | WORKFOLIO_ENV=staging\|production → identifier com.insightworkfolio.desktop.staging, product name, keychain service (compile-time), Windows run-at-sign-in value. desktop-config tests pass. Side-by-side install not done. | — | — |
| ● | MAC-17 | Intel / universal build (P8-04) | P2 | PENDING | PARTIAL | **BLOCKED** | No local work left: universal binary built and launched under Rosetta; the criterion needs a real Intel Mac (hardware). | — | — |
| ● | MAC-18 | Auto-updater: plugin, signing key, update host (P7-05) | P2 | PENDING | BLOCKED | **BLOCKED** | Needs signing (MAC-14) and an update host. | MAC-14 | — |
| ● | MAC-19 | OS notifications (P7-04) | P3 | PENDING | NEEDS VERIFICATION | **NEEDS VERIFICATION** | tauri-plugin-notification =2.8.0; edge-triggered notify on sync blocked / uploads failing (src/notify.ts, 3 tests). Not yet seen on screen in the packaged app. | — | — |

## Windows

| C | ID | Task | P | Audit | After exec 1 | Status | Evidence / what remains | Depends on | Decision |
|---|---|---|---|---|---|---|---|---|---|
| ● | WIN-01 | Windows hardware or VM, Windows 11 + Windows 10 (P4-01) | P0 | BLOCKED | BLOCKED | **BLOCKED** | Needs Windows 11 + 10 hardware or VM (D9). | — | Hardware |
|  | WIN-02 | Cross-build: `cargo check`/clippy clean for `x86_64-pc-windows-gnu`; release `.exe` links (P8-10). **Build proof only, not a deliverable.** | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
| ● | WIN-03 | P4-02 compile and run natively; `cargo test` incl. 6 Windows-only smoke tests | P0 | NEEDS VERIFICATION | NEEDS VERIFICATION | **NEEDS VERIFICATION** | Needs Windows hardware (WIN-01) or the Windows CI job (WIN-18). Only cross-compiled (x86_64-pc-windows-gnu) here. | CI-03 or WIN-01 | — |
| ● | WIN-04 | P4-03 single instance (named mutex, focus) | P1 | NEEDS VERIFICATION | NEEDS VERIFICATION | **NEEDS VERIFICATION** | Needs Windows hardware (WIN-01) or the Windows CI job (WIN-18). Only cross-compiled (x86_64-pc-windows-gnu) here. | WIN-01 | — |
| ● | WIN-05 | P4-04 Credential Manager token storage | P0 | NEEDS VERIFICATION | NEEDS VERIFICATION | **NEEDS VERIFICATION** | Needs Windows hardware (WIN-01) or the Windows CI job (WIN-18). Only cross-compiled (x86_64-pc-windows-gnu) here. | WIN-01 | — |
| ● | WIN-06 | P4-05 data folder `%LOCALAPPDATA%` access | P1 | NEEDS VERIFICATION | NEEDS VERIFICATION | **NEEDS VERIFICATION** | Needs Windows hardware (WIN-01) or the Windows CI job (WIN-18). Only cross-compiled (x86_64-pc-windows-gnu) here. | WIN-01 | — |
| ● | WIN-07 | P4-06 NSIS per-user installer, WebView2 bootstrapper | P1 | NEEDS VERIFICATION | NEEDS VERIFICATION | **NEEDS VERIFICATION** | Needs Windows hardware (WIN-01) or the Windows CI job (WIN-18). Only cross-compiled (x86_64-pc-windows-gnu) here. | CI-03 | — |
| ● | WIN-08 | P4-07 CSP/CORS for `http://tauri.localhost` | P0 | NEEDS VERIFICATION | NEEDS VERIFICATION | **NEEDS VERIFICATION** | Needs Windows hardware (WIN-01) or the Windows CI job (WIN-18). Only cross-compiled (x86_64-pc-windows-gnu) here. | WIN-01, AW-03 | — |
| ● | WIN-09 | P5-01 foreground app (exe file name identifier only) | P1 | NEEDS VERIFICATION | NEEDS VERIFICATION | **NEEDS VERIFICATION** | Needs Windows hardware (WIN-01) or the Windows CI job (WIN-18). Only cross-compiled (x86_64-pc-windows-gnu) here. | WIN-01 | — |
| ● | WIN-10 | P5-02 idle, lock, UAC, sleep, user switch, RDP | P1 | NEEDS VERIFICATION | NEEDS VERIFICATION | **NEEDS VERIFICATION** | Needs Windows hardware (WIN-01) or the Windows CI job (WIN-18). Only cross-compiled (x86_64-pc-windows-gnu) here. | WIN-01 | — |
| ● | WIN-11 | P5-03 native verification harness run | P1 | NEEDS VERIFICATION | NEEDS VERIFICATION | **NEEDS VERIFICATION** | Needs Windows hardware (WIN-01) or the Windows CI job (WIN-18). Only cross-compiled (x86_64-pc-windows-gnu) here. | WIN-01 | — |
| ● | WIN-12 | P5-04 browser extension on Windows (Chrome, Edge) | P2 | NEEDS VERIFICATION | NEEDS VERIFICATION | **NEEDS VERIFICATION** | Needs Windows hardware (WIN-01) or the Windows CI job (WIN-18). Only cross-compiled (x86_64-pc-windows-gnu) here. | WIN-01 | — |
| ● | WIN-13 | P6-01 GDI primary-display capture (cursor flicker check) | P1 | NEEDS VERIFICATION | NEEDS VERIFICATION | **NEEDS VERIFICATION** | Needs Windows hardware (WIN-01) or the Windows CI job (WIN-18). Only cross-compiled (x86_64-pc-windows-gnu) here. | WIN-01 | — |
| ● | WIN-14 | P6-02 masks, blur, WebP, checksum; **save succeeds after the F1 fsync fix** | P0 | NEEDS VERIFICATION | NEEDS VERIFICATION | **NEEDS VERIFICATION** | Needs Windows hardware (WIN-01) or the Windows CI job (WIN-18). Only cross-compiled (x86_64-pc-windows-gnu) here. | WIN-01 | — |
| ● | WIN-15 | P6-04 + tray, autostart, exit, resources, no-stealth (checklist #16–24, #27–32) | P1 | NEEDS VERIFICATION | NEEDS VERIFICATION | **NEEDS VERIFICATION** | Needs Windows hardware (WIN-01) or the Windows CI job (WIN-18). Only cross-compiled (x86_64-pc-windows-gnu) here. | WIN-01 | — |
| ● | WIN-16 | HR/Legal: no OS screen-capture prompt on Windows (P6-03) | P1 | BLOCKED | BLOCKED | **BLOCKED** | Needs HR/Legal acceptance (D7). | — | HR/Legal |
| ● | WIN-17 | Windows code-signing (OV/EV or Azure Trusted Signing) (P8-05) | P1 | BLOCKED | BLOCKED | **BLOCKED** | Needs certificate choice (D8). | — | Certificate choice |
| ● | WIN-18 | Windows CI job `windows-desktop` actually run (P8-09) | P0 | BLOCKED | BLOCKED | **BLOCKED** | Needs a commit + private remote (D2). | CI-02 | Git remote |
| ● | WIN-19 | Shipping build is MSVC (GNU cross-build loads WebView2Loader dynamically) | P1 | PENDING | BLOCKED | **BLOCKED** | Needs the Windows CI job (WIN-18); MSVC can't be built on this Mac. | WIN-18 | — |
| ● | WIN-20 | Missing WebView2 → app exits silently; show a message | P2 | PENDING | NEEDS VERIFICATION | **NEEDS VERIFICATION** | src-tauri/src/win/webview2.rs: MessageBoxW with download link when tauri::webview_version() fails; pure function unit-tested; cross-compiles. Not run on Windows without WebView2. | — | — |
| ● | WIN-21 | UWP/Store apps resolve to the real app, not "Application Frame Host" | P3 | PENDING | NEEDS VERIFICATION | **NEEDS VERIFICATION** | win/activity.rs resolves ApplicationFrameHost.exe to the hosted app's exe via EnumChildWindows (pids only); pure selection unit-tested; cross-compiles. Not run on Windows. | — | — |
|  | WIN-22 | ARM64 Windows build | P3 | DEFERRED | DEFERRED | **DEFERRED** | Baseline (not in the 139 cohort); unchanged. | — | — |

## Browser Extension

| C | ID | Task | P | Audit | After exec 1 | Status | Evidence / what remains | Depends on | Decision |
|---|---|---|---|---|---|---|---|---|---|
|  | EXT-01 | Domain-only tracker, gated on policy + notice + clocked in; incognito not allowed | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
| ● | EXT-02 | **[audit confirmed]** `host_permissions` is hard-coded to `http://localhost:4000/*`; needs a per-environment or optional permission requested at Connect (EXT-01 old) | P0 | PENDING | NEEDS VERIFICATION | **NEEDS VERIFICATION** | optional_host_permissions (https + loopback); Connect requests exactly the configured origin; Disconnect removes it; origin helper unit-tested (7/7). No staging API to connect to. | DEP-06 | — |
| ● | EXT-03 | Packaging, icons, distribution (Chrome Web Store unlisted or managed policy) | P2 | PENDING | PARTIAL | **BLOCKED** | No local work left: icons, package script and distribution doc done; needs your distribution-channel choice (Chrome Web Store unlisted vs managed policy) and, for the store, a developer account. | EXT-02 | Distribution channel |
|  | EXT-04 | Firefox / Safari | P3 | DEFERRED | DEFERRED | **DEFERRED** | Baseline (not in the 139 cohort); unchanged. | — | — |

## Security

| C | ID | Task | P | Audit | After exec 1 | Status | Evidence / what remains | Depends on | Decision |
|---|---|---|---|---|---|---|---|---|---|
|  | SEC-01 | Next.js 16.4.3 + dependency patches: **0 critical/high** | P0 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
|  | SEC-02 | `TRUST_PROXY`; per-session rate limit with per-IP ceiling; refresh limits | P0 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
|  | SEC-03 | Dashboard security headers (CSP, frame-ancestors, HSTS) | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
|  | SEC-04 | Website retention requires approval; `wss://` DB URL refused | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
|  | SEC-05 | Super Admin device-revoke guard; 403 messages | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
|  | SEC-06 | Privacy: no keylogging/titles; Windows identifier = exe file name only; whole-image blur enforced server-side | P0 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
|  | SEC-07 | Google OAuth callback design reviewed (single-use state consumed on failure, PKCE, timing-safe binding, no token in responses) | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
| ● | SEC-08 | **[audit]** Re-run the secret scan before the first commit. W0 scanned earlier; new files since then include the Google Drive reports and scripts, and the OneDrive reports contain tenant/site/drive identifiers. | P0 | NEEDS VERIFICATION | DONE | **DONE** | Scan re-run: 0 real secrets (206 hits = field names, fixtures, placeholders). The files holding tenant/site/drive identifiers were moved to Trash by you, so the repo no longer contains them (re-checked: only the fixed leave-type GUID matches). | — | Keep tenant IDs in repo? |
| ● | SEC-09 | Staging `JWT_SECRET` and all secrets only in platform settings; rotation owner (old SEC-09) | P0 | PENDING | BLOCKED | **BLOCKED** | Needs Render/Vercel (DEP-01, DEP-04). render.yaml declares every secret sync:false with no value. | DEP-01, DEP-04 | — |
| ● | SEC-10 | Search staging logs for leaked secrets (old SEC-10) | P1 | PENDING | BLOCKED | **BLOCKED** | Needs staging logs (ST-10/DEP-13). Local suite run's server log had 0 secret matches. | ST-10 | — |
| ● | SEC-11 | **[audit]** Re-confirm containment of the Microsoft app before any new consent (dormant Limited Access would re-activate if the folder scope is re-consented) | P1 | PENDING | DONE | **DONE** | docs/security.md 'Microsoft app re-consent guard': never consent Files.SelectedOperations.Selected / Files.*, prerequisites, post-change probe. | ST-04 | — |
| ● | SEC-12 | **[audit]** Privacy notice, DPIA/consent records and data-retention policy for real employees (monitoring transparency) | P0 | PENDING | BLOCKED | **BLOCKED** | Needs HR/Legal (D7). | MAC-15, WIN-16 | HR/Legal |
| ● | SEC-13 | Policy on admin-issued setup links (account takeover) | P1 | BLOCKED | BLOCKED | **BLOCKED** | Needs setup-link policy (D6). | — | Setup-link policy |
|  | SEC-14 | Encrypt the desktop queue at rest (SQLCipher) | P3 | DEFERRED | DEFERRED | **DEFERRED** | Baseline (not in the 139 cohort); unchanged. | — | — |

## Deployment

| C | ID | Task | P | Audit | After exec 1 | Status | Evidence / what remains | Depends on | Decision |
|---|---|---|---|---|---|---|---|---|---|
| ● | DEP-01 | Render account, always-on plan, exactly one instance (HOST-01) | P0 | BLOCKED | BLOCKED | **BLOCKED** | Your Render account + plan (D4). | — | Render account + plan |
| ● | DEP-02 | Render web service: build/start, `NODE_VERSION=24`, health path, `TRUST_PROXY=1` (HOST-02) | P0 | PENDING | BLOCKED | **BLOCKED** | Needs DEP-01. render.yaml has build/start, NODE_VERSION 24, health path, TRUST_PROXY=1. | DEP-01 | — |
| ● | DEP-03 | **[audit confirmed]** `render.yaml` and `.node-version` absent; add them (HOST-03) | P1 | PENDING | NEEDS VERIFICATION | **NEEDS VERIFICATION** | render.yaml + .node-version present; YAML parses; 1 instance, /api/v1/health, 5 GB disk, secrets sync:false. Blueprint not validated by Render (no account). | — | — |
| ● | DEP-04 | Vercel staging project, root `apps/dashboard` (HOST-04) | P0 | BLOCKED | BLOCKED | **BLOCKED** | Your Vercel account (D4). | — | Vercel account |
| ● | DEP-05 | Build guards for unset `NEXT_PUBLIC_API_URL` / `VITE_DASHBOARD_URL` (HOST-05) | P1 | PENDING | DONE | **DONE** | Dashboard: next build exits 1 with NEXT_PUBLIC_API_URL unset/empty/http (verified builds). Desktop: desktop-config exits 1 without https WORKFOLIO_DASHBOARD_URL; vite release guard; tests in desktop-config.test.ts. | — | — |
| ● | DEP-06 | Domain; `api-staging` and `app-staging` CNAMEs (HOST-06) | P0 | BLOCKED | BLOCKED | **BLOCKED** | Your domain choice (D4). | — | Domain choice |
| ● | DEP-07 | Valid TLS on both hosts (HOST-07) | P0 | PENDING | BLOCKED | **BLOCKED** | Needs DEP-06. | DEP-06 | — |
| ● | DEP-08 | https `CORS_ORIGINS`, `DASHBOARD_URL`; staging `NODE_ENV=production` (HOST-08) | P0 | PENDING | BLOCKED | **BLOCKED** | Needs DEP-07. | DEP-07 | — |
| ● | DEP-09 | First Super Admin via `admin:create` from a trusted machine (HOST-09) | P0 | PENDING | BLOCKED | **BLOCKED** | 2026-11-03: Turso migrated to 0028; Super Admin creation deferred by the user. `admin:create` now refuses a hosted database with pending migrations instead of migrating it. Needs DEP-02 and DB-09. Audit 2026-11-03 (read-only, docs/status/TURSO-DATABASE-READINESS-AUDIT.md): `users` on Turso staging is empty; no Super Admin exists. | DEP-02, DB-09 | — |
| ● | DEP-10 | `docs/deployment.md` aligned with Render/Vercel (HOST-10) | P2 | PENDING | PARTIAL | **BLOCKED** | No local work left: docs/deployment.md describes Render + Vercel + Turso; matching it to a real deployment needs DEP-02 (D4). | DEP-02 | — |
| ● | DEP-11 | Uptime check on `/api/v1/ready` with alerting (MON-01) | P1 | PENDING | BLOCKED | **BLOCKED** | Needs DEP-02 + a monitoring account. Plan written in docs/deployment.md. | DEP-02 | — |
| ● | DEP-12 | Error alerting and log retention (MON-02) | P1 | PENDING | BLOCKED | **BLOCKED** | Needs DEP-02 + log forwarding account. Plan written. | DEP-02 | — |
| ● | DEP-13 | Staging integration suite (12 tests: auth, attendance, activity, screenshots, timelapse, retention, CORS, rate limits…) | P0 | PENDING | PARTIAL | **BLOCKED** | No local work left: staging-suite.mjs (12 checks) passes locally 11 + 1 https-only skip; the criterion is 12/12 on staging (D4 + D1). | DEP-08, ST-10 | — |
| ● | DEP-14 | Production environment: Turso, Render, Vercel, storage (P8-06) | P2 | PENDING | BLOCKED | **BLOCKED** | Needs DEP-13 and accounts. | DEP-13 | — |
| ● | DEP-15 | Pilot and production readiness review (P8-07) | P1 | PENDING | BLOCKED | **BLOCKED** | Needs DEP-13 and your sign-off. | DEP-13 | — |

## CI/CD

| C | ID | Task | P | Audit | After exec 1 | Status | Evidence / what remains | Depends on | Decision |
|---|---|---|---|---|---|---|---|---|---|
| ● | CI-01 | **Commit the working tree in reviewed chunks.** 1 commit exists; 109 modified, 205 untracked files, including migrations 0008–0017 and 0019 (0008–0016 are already applied to Turso). | P0 | BLOCKED | BLOCKED | **BLOCKED** | Needs your commit approval (D2). This task forbids commits. | SEC-08 | Commit approval |
| ● | CI-02 | Private GitHub remote and push | P0 | BLOCKED | BLOCKED | **BLOCKED** | Needs CI-01 + GitHub account. | CI-01 | Account + approval |
| ● | CI-03 | CI workflow (checks, desktop-rust macOS, browser-suites, windows-desktop) authored, YAML parses, **never run** | P0 | NEEDS VERIFICATION | NEEDS VERIFICATION | **NEEDS VERIFICATION** | Every command of the `checks` and `desktop-rust` jobs run locally on the final tree: all green (see execution summary). Criterion is the first green run on GitHub, which needs CI-02. | CI-02 | — |
|  | CI-04 | W0 safety review: inventory, secret scan, commit plan | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
| ● | CI-05 | Branch/PR workflow; protected `main` | P1 | PENDING | BLOCKED | **BLOCKED** | Needs CI-02. | CI-02 | — |
| ● | CI-06 | Track `apps/dashboard/.env.example` (ignored by `apps/dashboard/.gitignore:34`) | P2 | PENDING | PARTIAL | **BLOCKED** | No local work left: the negation rule is in place; the file becomes tracked only with the first commit (D2). | — | — |
| ● | CI-07 | Deploy pipeline: CI → Render/Vercel on `main`, migrations gated by approval | P1 | PENDING | NEEDS VERIFICATION | **NEEDS VERIFICATION** | .github/workflows/deploy-staging.yml: after green CI on main, environment: staging (approval), db:migrate --dry-run then migrate, then Render/Vercel deploy hooks; secrets by name. YAML parses; never run. | CI-03, DEP-02, DEP-04 | — |

## Product Features

| C | ID | Task | P | Audit | After exec 1 | Status | Evidence / what remains | Depends on | Decision |
|---|---|---|---|---|---|---|---|---|---|
|  | W13 | Clock in / clock out | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
|  | W14 | Take a Break | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
|  | W15 | Timesheets and worked time | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
|  | W16 | Live attendance overview | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
| ● | W17 | Expected start, late clock-in, daily report, late email | P1 | PARTIAL | PARTIAL | **BLOCKED** | Local part done: per-person expected start/workdays drive daily report, late flag, alerts and now leave-day counting (Mon–Sat charged 5, Mon–Thu 3; e2e). Only the late EMAIL remains: needs the email provider (D5 / API-09). | API-09 | — |
| ● | W18 | Absence marking | P1 | PARTIAL | DONE | **DONE** | Holidays (0022) labelled HOLIDAY, never ABSENT (holidays.e2e). Browser: 2026-11-01 holiday shows all 4 employees Holiday, nobody Absent; contrast day shows Absent. | W38 | — |
| ● | W19 | Auto clock-in on sign-in | P3 | PENDING | BLOCKED | **BLOCKED** | Product decision D11: is auto clock-in wanted? | — | Product: wanted? |
| ● | W20 | Automatic break on idle | P2 | PENDING | BLOCKED | **BLOCKED** | Product decision D11: is automatic break on idle wanted? | — | Product: wanted? |
| ● | W21 | Configurable idle threshold | P2 | PARTIAL | NEEDS VERIFICATION | **NEEDS VERIFICATION** | Per-person idle threshold (0025) returned by /activity/me; desktop already applies policy. Not run on a real desktop; extension still uses org value. | — | — |
| ● | W22 | Exclude apps from idle | P2 | PENDING | NEEDS VERIFICATION | **NEEDS VERIFICATION** | Org idle-excluded app list in monitoring settings → policy.idleExcludedApps; Rust idle_excluded() + unit test. Not run on real macOS/Windows. | — | — |
|  | W23 | Application usage tracking | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
| ● | F04 | Website tracking | P1 | PARTIAL | PARTIAL | **PARTIAL** | Host permission per environment done (EXT-02, needs staging to verify). Firefox/Safari support is the separate EXT-04 row, which you DEFERRED; until that changes, website tracking stays Chromium-only. | EXT-02 | — |
| ● | W24 | Daily activity timeline | P2 | PARTIAL | PARTIAL | **DONE** | Breaks overlay plus expected-start marker from the effective (per-person or org) schedule via GET /attendance/expected; no window on holidays, non-workdays or with the schedule off. expected-schedule.e2e; verify-schedule: 'Expected start 10:30' on admin /activity and /my/activity, none on the holiday. | — | — |
|  | W25 | Active and idle totals | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
|  | W26 | No keylogging | P0 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
| ● | F05 | Productivity labels and scoring | P1 | PARTIAL | PARTIAL | **DONE** | Per-team label overrides (0027, versioned, no delete): active teams' agreeing label wins, otherwise org label; used by activity summary/timeline/overview and /teams/productivity. Admin 'Labels' card on /teams. team-labels-self-view.e2e; verify-labels: team productive share 20%→60%, non-member unchanged. | — | — |
|  | W27 | Per-employee analytics | P2 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
| ● | F06 | Custom rules and alerts | P2 | PENDING | PARTIAL | **BLOCKED** | Local part done: in-app rules and alerts (browser-verified). Remaining email delivery needs the email provider (D5 / API-09). | API-09 | — |
|  | W28 | Automatic screenshots while clocked in | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
|  | W29 | Configurable screenshot interval | P2 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
| ● | W30 | Capture every display | P3 | PARTIAL | PARTIAL | **BLOCKED** | Capturing every display is a product/privacy decision (more capture than today's primary-display-only design); needs your and HR/Legal's decision before any code (new decision D12). | — | — |
| ● | F02 | Screenshot blur/masking | P2 | NEEDS VERIFICATION | NEEDS VERIFICATION | **NEEDS VERIFICATION** | Unchanged: needs real-capture check (MAC-08). | MAC-08 | — |
|  | W31 | Screenshots page and gallery | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
| ● | F08 | Screenshot access control | P2 | PARTIAL | PARTIAL | **DONE** | Team-head scope (earlier) plus per-person screenshot self-view override (inherit/allow/deny, versioned in employee_tracking_overrides via 0027), enforced server-side on own list/detail/content; admins and heads unchanged. e2e; verify-labels: denied employee sees 0 images, API 403. | W41 | — |
|  | W32 | Screenshot retention and auto-delete | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
|  | W33 | Delete one screenshot immediately | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
| ● | W34 | Cloud screenshot storage | P0 | BLOCKED | BLOCKED | **BLOCKED** | Storage decision D1. | ST-02 | Storage provider |
| ● | F01 | Timelapse videos | P2 | PARTIAL | PARTIAL | **BLOCKED** | Local part done: opt-in automatic daily videos (0028; one video per finished session, deduped, 3-day look-back, keeps an admin queue slot; real FFmpeg produced READY in the browser run). Remaining: durable storage of the MP4 (ST-17 → storage decision D1). | ST-17 | — |
| ● | F09 | Timelapse permissions | P3 | PARTIAL | PARTIAL | **DONE** | Timelapse routes team-scoped for heads (404 outside team, e2e) and a per-member timelapse panel in /my/team/screenshots (browser-verified, verify-teamhead). | W41 | — |
|  | F03 | Excel export for payroll | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
| ● | F12 | Email reports and work summary | P1 | BLOCKED | BLOCKED | **BLOCKED** | Email provider D5. | API-09 | Email provider |
|  | F10 | Leave requests and approval | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
| ● | W35 | Short leave with a limit | P2 | PARTIAL | DONE | **DONE** | Leave types carry a short-leave hours quota per month; short leave counts against it (leave-balances.e2e). Browser: /my/leave shows 4 of 4 h left. | W36 | — |
| ● | W36 | Leave types and balances | P2 | PENDING | DONE | **DONE** | 0021_leave_types (existing requests default to General); balances computed; approval past allowance refused; concurrency-safe; isolation (leave-balances.e2e, 6 tests). Browser: type created, admin balances column, employee sees balance and requests with a type. | — | — |
|  | W37 | Leave summary | P2 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
| ● | W38 | Holiday calendar | P2 | PENDING | DONE | **DONE** | 0022_holidays + /holidays admin API and page (holidays.e2e). Browser: empty state, add, list. | — | — |
| ● | W39 | Holiday import from Excel | P3 | PENDING | PARTIAL | **DONE** | Excel (.xlsx) import parsed in the browser into the existing validated CSV import (no new dependency): 1900/1904 serial dates, ISO and unambiguous d/m text, per-row errors, .xls refused. xlsx-holidays.test 7/7; verify-xlsx 11/11 (real file input, API stored rows). Still to do: a file saved from real Excel. | W38 | — |
| ● | W40 | Teams | P2 | PENDING | DONE | **DONE** | 0024_teams; teams CRUD, members, head (teams.e2e). Browser: empty states, create Support, add 2 members, members column 2. | — | — |
| ● | W41 | Team head role | P2 | PENDING | PARTIAL | **DONE** | Team head (head of an active team) has team-scoped reads on employees, attendance overview/summary/daily, timesheets (+CSV/XLSX export), activity overview, screenshots, timelapse, leave list/detail/summary/balances, and may approve/reject leave of own team members only (never own; 404 outside). 'My team' area under /my shown only to heads. team-head-scope.e2e + teams.e2e; verify-teamhead 27/27. Projects and reports stay org-level by design. | W40 | — |
|  | W42 | Admin role and role changes | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
| ● | W43 | Invite employees by email | P1 | PARTIAL | PARTIAL | **BLOCKED** | Copyable setup link exists; sending invites by email needs the email provider (D5 / API-09). | API-09 | — |
| ● | W44 | Shareable invite link | P3 | PENDING | BLOCKED | **BLOCKED** | Conflicts with setup-link policy (D6). | SEC-13 | Product |
|  | W45 | Admin-only tracking settings | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
|  | F07 | Employee self-service | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
| ● | W46 | Visible mode (window + tray) | P1 | NEEDS VERIFICATION | NEEDS VERIFICATION | **NEEDS VERIFICATION** | Unchanged: needs MAC-09 / WIN-15 runtime. | MAC-09, WIN-15 | — |
|  | W47 | Stealth mode | — | DEFERRED | DEFERRED | **DEFERRED** | Baseline (not in the 139 cohort); unchanged. | — | — |
| ● | W48 | Windows desktop app | P1 | NEEDS VERIFICATION | NEEDS VERIFICATION | **NEEDS VERIFICATION** | Unchanged: 0/32 Windows runtime (WIN-01). | WIN-01 | — |
| ● | W49 | macOS app (signed, Apple silicon + Intel) | P1 | PARTIAL | PARTIAL | **BLOCKED** | Universal build exists (MAC-17); signing needs the Apple Developer ID (D8) and the Intel run needs an Intel Mac. | MAC-13, MAC-17 | — |
| ● | W50 | Linux desktop app | P3 | PENDING | BLOCKED | **BLOCKED** | Product decision D11: Linux wanted? | — | Product: wanted? |
| ● | W51 | Android admin app | P3 | PENDING | BLOCKED | **BLOCKED** | Product decision D11: Android wanted? | — | Product: wanted? |
|  | W52 | Web app (admin) | P1 | DONE | DONE | **DONE** | Baseline (not in the 139 cohort); unchanged. | — | — |
| ● | W53 | HTTPS and encrypted storage | P0 | NEEDS VERIFICATION | NEEDS VERIFICATION | **NEEDS VERIFICATION** | Unchanged: production TLS untested (DEP-07). | DEP-07 | — |
|  | W54 | Plans, billing, trial | — | DEFERRED | DEFERRED | **DEFERRED** | Baseline (not in the 139 cohort); unchanged. | — | — |
|  | W55 | HIPAA BAA | — | DEFERRED | DEFERRED | **DEFERRED** | Baseline (not in the 139 cohort); unchanged. | — | — |
|  | W56 | Self-service company sign-up | — | DEFERRED | DEFERRED | **DEFERRED** | Baseline (not in the 139 cohort); unchanged. | — | — |
|  | W57 | In-app support chat | — | DEFERRED | DEFERRED | **DEFERRED** | Baseline (not in the 139 cohort); unchanged. | — | — |

## Blocking decisions (owner: you)

| Decision | Unblocks |
|---|---|
| D1 Storage provider | ST-02, ST-07, ST-09, ST-10, ST-11, ST-14, ST-15, ST-16, ST-17, ST-18, ST-19, DB-11, DB-12, API-10, W34, AW-04, AW-06, ST-08, ST-12, F01 |
| D2 Commit + private remote | CI-01, CI-02, CI-05, WIN-18, WIN-19, CI-06 |
| D3 Turso staging migrations | DB-07, DB-09, DB-10, DB-15 |
| D4 Hosting accounts + domain | AW-03, EW-06, DEP-01, DEP-02, DEP-04, DEP-06, DEP-07, DEP-08, DEP-09, DEP-11, DEP-12, DEP-14, DEP-15, DB-16, API-12, SEC-09, SEC-10, API-13, DEP-10, DEP-13 |
| Turso account details | DB-13, DB-14, DB-17 |
| D5 Email provider | API-09, F12, W17, F06, W43 |
| D6 Setup-link policy | AW-07, SEC-13, W44 |
| D7 HR/Legal | MAC-15, WIN-16, SEC-12 |
| D8 Code signing | MAC-13, MAC-14, MAC-18, WIN-17, W49 |
| D9 Windows hardware | WIN-01 |
| Intel Mac hardware | MAC-17 |
| D12 Multi-display capture | W30 |
| D13 Extension distribution channel | EXT-03 |
| D10 Devices per employee | API-11 |
| D11 Product scope | W19, W20, W50, W51 |
| Your manual Microsoft action | ST-05 |
