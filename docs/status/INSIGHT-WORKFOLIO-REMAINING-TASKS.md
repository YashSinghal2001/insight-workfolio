# Insight Workfolio: Remaining Tasks (2026-11-02)

**120 of the 139 cohort tasks remain unresolved:** 1 PARTIAL, 79 BLOCKED, 40 NEEDS VERIFICATION. No cohort task is PENDING. Updated after Phase 1 (24 PARTIAL tasks). Grouped by area, then priority.

Unique remaining work, counting the six audit overlaps once: 114.

## Admin Web (4)

| P | ID | Task | Status | What remains |
|---|---|---|---|---|
| P0 | AW-03 | Admin web on staging over HTTPS against the real API | BLOCKED | Needs Render + Vercel accounts and a domain (D4: DEP-01, DEP-04, DEP-06). Nothing to do locally. — unblocked by D4 Hosting accounts + domain |
| P1 | AW-04 | Storage connection and status panel (provider, account, last upload, "Connect Google Drive" button if Google is chosen) | BLOCKED | Local part done: Storage card shows provider, status and 'Last upload' (admin-only GET /settings/screenshots, not exposed on public /ready; e2e + browser). Remaining account display and Connect/disconnect against the real provider need the storage decision (D1). — unblocked by D1 Storage provider |
| P1 | AW-06 | Timelapse viewer: durable playback after API restart (today the MP4 lives only in the API host cache) | BLOCKED | No local work left: durable playback needs ST-19 → DB-11 (0018), i.e. the storage decision (D1). — unblocked by D1 Storage provider |
| P1 | AW-07 | Policy and UI for admin-issued setup links (SEC-07: an Admin can mint a link for another user) | BLOCKED | Needs your setup-link policy (D6): who may mint links for whom. — unblocked by D6 Setup-link policy |

## Employee Web (1)

| P | ID | Task | Status | What remains |
|---|---|---|---|---|
| P0 | EW-06 | Employee web on staging over HTTPS | BLOCKED | Needs staging hosts (AW-03 / D4). — unblocked by D4 Hosting accounts + domain |

## API (5)

| P | ID | Task | Status | What remains |
|---|---|---|---|---|
| P1 | API-09 | Email `MailTransport` for setup/invite links and reports (EM-02…04) | BLOCKED | Needs an email provider and sending mailbox (D5). Alerts (F06) already call a no-op sendAlertEmails hook ready for it. — unblocked by D5 Email provider |
| P1 | API-12 | FFmpeg with libx264 on the API host; persistent `TIMELAPSE_DIR` (TL-05) | BLOCKED | Needs the Render service (DEP-01) with FFmpeg + the persistent disk declared in render.yaml. — unblocked by D4 Hosting accounts + domain |
| P1 | API-13 | **[audit]** Single-instance constraint documented and enforced on Render (OAuth state, in-process caches, migration runner assumptions) | BLOCKED | No local work left: the single-instance rule is audited and recorded (render.yaml numInstances: 1, docs/deployment.md); the criterion is the real Render setting (DEP-01, D4). — unblocked by D4 Hosting accounts + domain |
| P2 | API-11 | Multi-device per employee (P3-02…04: index relaxation, clock-event conflict rules, tests) | BLOCKED | Needs the devices-per-employee decision (D10). — unblocked by D10 Devices per employee |
| P3 | API-10 | Google OAuth pending state and connection survive restarts / more than one instance (state is an in-process `Map`) | BLOCKED | Only relevant if Google Drive is chosen (D1). Pending state is still an in-process Map, documented in docs/deployment.md single-instance section. — unblocked by D1 Storage provider |

## Database (11)

| P | ID | Task | Status | What remains |
|---|---|---|---|---|
| P0 | DB-09 | **Apply 0017 to Turso staging.** Turso is at 0016. | DONE | **DONE 2026-11-03** (approved by the user): `db:migrate` applied 0017 with 0019 and 0021–0028 to Turso staging; `verify:turso`: 26 applied, 0 pending, 51 tables / 65 indexes / 91 triggers identical to reference, integrity/quick/FK checks clean (TURSO-DATABASE-IMPLEMENTATION-REPORT.md). Turso migration approval (D3). Turso is at 0016; Audit 2026-11-03 (read-only, docs/status/TURSO-DATABASE-READINESS-AUDIT.md): 10 pending (0017, 0019, 0021–0028), no Turso dump yet. — unblocked by D3 Turso staging migrations |
| P0 | DB-10 | **[audit] Apply 0019 (screenshot blur policy) to Turso staging.** It is not on Turso (Turso is at 0016). | DONE | **DONE 2026-11-03** (approved by the user): 0019 applied to Turso staging with 0017 and 0021–0028; verified as for DB-09 (TURSO-DATABASE-IMPLEMENTATION-REPORT.md). Turso migration approval (D3). NOTE: source now has 0021–0028 too. Audit 2026-11-03 (read-only, docs/status/TURSO-DATABASE-READINESS-AUDIT.md): Turso at 0016, 10 pending (0017, 0019, 0021–0028), no Turso dump yet, no Super Admin. Hosted API boots no longer migrate (they refuse to start while any are pending; this change set), so apply via the runbook in docs/database-operations.md. — unblocked by D3 Turso staging migrations |
| P1 | DB-07 | T2 second migration run applies nothing on Turso | DONE | **DONE 2026-11-03:** a second `db:migrate` on Turso staging printed "No pending migrations." (TURSO-DATABASE-IMPLEMENTATION-REPORT.md). Needs Turso migration approval (D3, after DB-09/DB-10). Locally: migration-order.test.ts proves a second run applies nothing. — unblocked by D3 Turso staging migrations |
| P1 | DB-08 | T4 integrity check and guard/unique error mapping on Turso | NEEDS VERIFICATION | 2026-11-03: integrity_check, quick_check and foreign_key_check clean on Turso at 0028; guard/unique error mapping on Turso still not exercised. Audit 2026-11-03 (read-only, docs/status/TURSO-DATABASE-READINESS-AUDIT.md): `verify:turso` plus `integrity_check`, `quick_check` and `foreign_key_check` ran clean on Turso staging at 0016. Still open: guard/unique error mapping on Turso (needs the migrated schema and the API) and a re-check at 0028. |
| P1 | DB-11 | Migration 0018 (timelapse storage columns, reserved by the Graph session, **not written**) | BLOCKED | 0018 waits on the storage decision (D1). Gap-fill tests now prove a later 0018 applies safely after 0019–0028. — unblocked by D1 Storage provider |
| P1 | DB-12 | **[audit]** Migration 0020: widen `screenshots.storage_provider` CHECK to include `GOOGLE_DRIVE` (not written; required before Google Drive can store screenshots) | BLOCKED | 0020 only if Google Drive is chosen (D1) + migration approval. — unblocked by D1 Storage provider |
| P1 | DB-13 | Turso plan and restore window recorded | BLOCKED | Needs Turso account access to read the plan/PITR window (the `turso` CLI is not installed on the audit machine). docs/database-operations.md has the blank table to fill. — unblocked by Turso account details |
| P1 | DB-14 | T19 point-in-time restore rehearsal into a new database | BLOCKED | Needs Turso account (and DB-13). Owner steps written in docs/database-operations.md. — unblocked by Turso account details |
| P1 | DB-15 | Dump procedure before each migration-bearing deploy | DONE | **DONE 2026-11-03:** first Turso dump `~/insight-workfolio-backups/workfolio-2026-11-03T06-40-01-494Z.sql` (0600, 40 tables, 19 rows, ids 0001–0016) restored into a scratch SQLite file; `verify:turso` on the restore passed and matched Turso (TURSO-DATABASE-IMPLEMENTATION-REPORT.md). No local work left: dump/restore script and docs done and rehearsed on a local copy; the first real Turso dump needs Turso access and the migration approval (D3). Audit 2026-11-03 (read-only, docs/status/TURSO-DATABASE-READINESS-AUDIT.md): no Turso dump exists yet. — unblocked by D3 Turso staging migrations |
| P1 | DB-16 | DB-scoped token stored only in Render | BLOCKED | Needs the Render service (DEP-01). render.yaml declares DATABASE_AUTH_TOKEN as sync:false (no value). Audit 2026-11-03 (read-only, docs/status/TURSO-DATABASE-READINESS-AUDIT.md): the current staging token is read-write with no expiry and sits in apps/api/.env.staging inside the repo tree; move it out and rotate once Render/GitHub secrets exist. — unblocked by D4 Hosting accounts + domain |
| P2 | DB-17 | Separate production Turso database | BLOCKED | Needs pilot sign-off and Turso account. — unblocked by Turso account details |

## Storage (16)

| P | ID | Task | Status | What remains |
|---|---|---|---|---|
| P0 | ST-02 | **Choose the production storage target**: dedicated SharePoint site (`Sites.Selected`), Google Drive (`drive.file`, OAuth), or another provider. The documents disagree: the roadmap keeps "OneDrive folder", the final storage decision says "dedicated SharePoint site", and Google Drive was then prototyped. | BLOCKED | Your storage decision (D1). Recommendation in the (trashed) decision doc: dedicated SharePoint site with Sites.Selected. — unblocked by D1 Storage provider |
| P0 | ST-07 | Dedicated private SharePoint site + `Sites.Selected` `write` grant + boundary tests T5–T8 (OD-24) | BLOCKED | Needs D1 = SharePoint and your approval to create the site and grant. — unblocked by D1 Storage provider |
| P0 | ST-10 | T10 staging end to end: real screenshots land in the target; retention deletes them | BLOCKED | Needs D1 and staging (DEP-01). The staging suite (DEP-13) covers upload/view/delete when it runs. — unblocked by D1 Storage provider |
| P1 | ST-08 | Graph session's paused code: `GRAPH_FOLDER_ID`, folder-ID addressing, chunked `putFile`, `getStream`, `folderIsConfigured()` (uncommitted, tenant-untested) | BLOCKED | No local work left: keep or drop the storage session's Graph code depends on the storage decision (D1); T6/T7 need the chosen site. — unblocked by D1 Storage provider |
| P1 | ST-09 | Storage key layout `Employees/<CODE>/YYYY/MM/DD/<uuid>.webp` (OD-13) | BLOCKED | Needs D1. — unblocked by D1 Storage provider |
| P1 | ST-13 | Google Drive adapter + OAuth (code + PKCE S256, single-use 10-min state, binding cookie, server-side exchange, `drive.file`) | NEEDS VERIFICATION | Unchanged: fake-Google tests pass (in 367/367); real account run needs ST-14. |
| P1 | ST-14 | Google Cloud project, OAuth client, consent screen, test user | BLOCKED | Needs D1 = Google and your Google account. — unblocked by D1 Storage provider |
| P1 | ST-15 | Real Google verification (`verify-google-drive.mjs`) | BLOCKED | Needs ST-14. — unblocked by D1 Storage provider |
| P1 | ST-16 | **[audit]** Google refresh token lives in `GOOGLE_DRIVE_TOKEN_FILE` (0600). On Render the filesystem is ephemeral unless a disk is attached, so the connection is lost on every deploy. | BLOCKED | Only if D1 = Google. — unblocked by D1 Storage provider |
| P1 | ST-17 | Durable timelapse storage: upload MP4, serve/delete from storage, TTL (TL-01…03) | BLOCKED | Needs DB-11 (0018), blocked on D1. — unblocked by D1 Storage provider |
| P1 | ST-18 | Screenshots on Google Drive wired but guarded off until DB-12 | BLOCKED | Needs DB-12 (0020), blocked on D1. — unblocked by D1 Storage provider |
| P1 | ST-19 | Timelapse cloud upload adapter (Google adapter ready; service not wired) | BLOCKED | Needs DB-11 / ST-17. — unblocked by D1 Storage provider |
| P2 | ST-04 | Remove the dormant app `Limited Access` entries on the personal site and the Documents library (OD-23) | NEEDS VERIFICATION | The storage decision doc §7 (read before it was trashed) recorded the Limited Access entries removed on 2026-11-02 by you; not re-checked here (no tenant access). |
| P2 | ST-05 | Revoke Graph Explorer's delegated `Files.ReadWrite` for your account | BLOCKED | Your manual action at myapplications.microsoft.com. — unblocked by Your manual Microsoft action |
| P2 | ST-11 | Purview retention and holds on the storage site confirmed with the tenant admin (OD-19) | BLOCKED | Needs ST-07 and the tenant admin's written confirmation. — unblocked by D1 Storage provider |
| P2 | ST-12 | Microsoft docs updated for the OneDrive rejection (OD-17) | BLOCKED | No local work left: docs/onedrive.md already records the rejection; it becomes final when you approve the storage decision (D1). — unblocked by D1 Storage provider |

## macOS (17)

| P | ID | Task | Status | What remains |
|---|---|---|---|---|
| P1 | MAC-03 | MV-01 automatic app switching (native run, corrected harness) | NEEDS VERIFICATION | Needs a human at the Mac (checklist items in MACOS checklist). Not run in this session. |
| P1 | MAC-04 | MV-02 screenshot skipped while asleep ≥ 60 s | NEEDS VERIFICATION | Needs a human at the Mac (checklist items in MACOS checklist). Not run in this session. |
| P1 | MAC-05 | MV-03 masks on a real capture | NEEDS VERIFICATION | Needs a human at the Mac (checklist items in MACOS checklist). Not run in this session. |
| P1 | MAC-06 | MV-05 lock, sleep, fast-user-switch = unobserved; interval closes at the transition | NEEDS VERIFICATION | Needs a human at the Mac (checklist items in MACOS checklist). Not run in this session. |
| P1 | MAC-08 | MV-07 whole-image blur on a real capture | NEEDS VERIFICATION | Needs a human at the Mac (checklist items in MACOS checklist). Not run in this session. |
| P1 | MAC-09 | MV-08 menu bar, close/reopen, quit confirmation, Dock hide, launch at login | NEEDS VERIFICATION | Needs a human at the Mac (checklist items in MACOS checklist). Not run in this session. |
| P1 | MAC-10 | MV-09 background operation with window hidden; resource use | NEEDS VERIFICATION | Needs a human at the Mac (checklist items in MACOS checklist). Not run in this session. |
| P1 | MAC-12 | P1-07 platform features verified inside the packaged app | NEEDS VERIFICATION | As MAC-11 (Keychain prompt needs a human); plus revoke device/session check. |
| P1 | MAC-13 | Apple Developer ID certificate (P8-01) | BLOCKED | Needs your Apple Developer ID (D8). — unblocked by D8 Code signing |
| P1 | MAC-14 | Notarisation, hardened runtime, entitlements, `minimumSystemVersion` 14 (P8-02) | BLOCKED | Needs MAC-13. — unblocked by D8 Code signing |
| P1 | MAC-15 | HR/Legal: revised screenshot notice wording (blur) | BLOCKED | Needs HR/Legal wording (D7). — unblocked by D7 HR/Legal |
| P1 | MAC-16 | Per-environment bundle identifier and keychain service (P8-03) | NEEDS VERIFICATION | WORKFOLIO_ENV=staging\|production → identifier com.insightworkfolio.desktop.staging, product name, keychain service (compile-time), Windows run-at-sign-in value. desktop-config tests pass. Side-by-side install not done. |
| P2 | MAC-07 | MV-06 App Nap opt-out while recording; no sleep prevention | NEEDS VERIFICATION | Needs a human at the Mac (checklist items in MACOS checklist). Not run in this session. |
| P2 | MAC-11 | MV-04 History, My screenshots, Leave tabs inside the packaged window | NEEDS VERIFICATION | Packaged suites need a Keychain 'Always Allow' click at first sign-in (fresh build cdhash). Steps: api build; tauri build --debug --bundles app; verify:tasks-packaged / export-packaged / websites-packaged. |
| P2 | MAC-17 | Intel / universal build (P8-04) | BLOCKED | No local work left: universal binary built and launched under Rosetta; the criterion needs a real Intel Mac (hardware). — unblocked by Intel Mac hardware |
| P2 | MAC-18 | Auto-updater: plugin, signing key, update host (P7-05) | BLOCKED | Needs signing (MAC-14) and an update host. — unblocked by D8 Code signing |
| P3 | MAC-19 | OS notifications (P7-04) | NEEDS VERIFICATION | tauri-plugin-notification =2.8.0; edge-triggered notify on sync blocked / uploads failing (src/notify.ts, 3 tests). Not yet seen on screen in the packaged app. |

## Windows (20)

| P | ID | Task | Status | What remains |
|---|---|---|---|---|
| P0 | WIN-01 | Windows hardware or VM, Windows 11 + Windows 10 (P4-01) | BLOCKED | Needs Windows 11 + 10 hardware or VM (D9). — unblocked by D9 Windows hardware |
| P0 | WIN-03 | P4-02 compile and run natively; `cargo test` incl. 6 Windows-only smoke tests | NEEDS VERIFICATION | Needs Windows hardware (WIN-01) or the Windows CI job (WIN-18). Only cross-compiled (x86_64-pc-windows-gnu) here. |
| P0 | WIN-05 | P4-04 Credential Manager token storage | NEEDS VERIFICATION | Needs Windows hardware (WIN-01) or the Windows CI job (WIN-18). Only cross-compiled (x86_64-pc-windows-gnu) here. |
| P0 | WIN-08 | P4-07 CSP/CORS for `http://tauri.localhost` | NEEDS VERIFICATION | Needs Windows hardware (WIN-01) or the Windows CI job (WIN-18). Only cross-compiled (x86_64-pc-windows-gnu) here. |
| P0 | WIN-14 | P6-02 masks, blur, WebP, checksum; **save succeeds after the F1 fsync fix** | NEEDS VERIFICATION | Needs Windows hardware (WIN-01) or the Windows CI job (WIN-18). Only cross-compiled (x86_64-pc-windows-gnu) here. |
| P0 | WIN-18 | Windows CI job `windows-desktop` actually run (P8-09) | BLOCKED | Needs a commit + private remote (D2). — unblocked by D2 Commit + private remote |
| P1 | WIN-04 | P4-03 single instance (named mutex, focus) | NEEDS VERIFICATION | Needs Windows hardware (WIN-01) or the Windows CI job (WIN-18). Only cross-compiled (x86_64-pc-windows-gnu) here. |
| P1 | WIN-06 | P4-05 data folder `%LOCALAPPDATA%` access | NEEDS VERIFICATION | Needs Windows hardware (WIN-01) or the Windows CI job (WIN-18). Only cross-compiled (x86_64-pc-windows-gnu) here. |
| P1 | WIN-07 | P4-06 NSIS per-user installer, WebView2 bootstrapper | NEEDS VERIFICATION | Needs Windows hardware (WIN-01) or the Windows CI job (WIN-18). Only cross-compiled (x86_64-pc-windows-gnu) here. |
| P1 | WIN-09 | P5-01 foreground app (exe file name identifier only) | NEEDS VERIFICATION | Needs Windows hardware (WIN-01) or the Windows CI job (WIN-18). Only cross-compiled (x86_64-pc-windows-gnu) here. |
| P1 | WIN-10 | P5-02 idle, lock, UAC, sleep, user switch, RDP | NEEDS VERIFICATION | Needs Windows hardware (WIN-01) or the Windows CI job (WIN-18). Only cross-compiled (x86_64-pc-windows-gnu) here. |
| P1 | WIN-11 | P5-03 native verification harness run | NEEDS VERIFICATION | Needs Windows hardware (WIN-01) or the Windows CI job (WIN-18). Only cross-compiled (x86_64-pc-windows-gnu) here. |
| P1 | WIN-13 | P6-01 GDI primary-display capture (cursor flicker check) | NEEDS VERIFICATION | Needs Windows hardware (WIN-01) or the Windows CI job (WIN-18). Only cross-compiled (x86_64-pc-windows-gnu) here. |
| P1 | WIN-15 | P6-04 + tray, autostart, exit, resources, no-stealth (checklist #16–24, #27–32) | NEEDS VERIFICATION | Needs Windows hardware (WIN-01) or the Windows CI job (WIN-18). Only cross-compiled (x86_64-pc-windows-gnu) here. |
| P1 | WIN-16 | HR/Legal: no OS screen-capture prompt on Windows (P6-03) | BLOCKED | Needs HR/Legal acceptance (D7). — unblocked by D7 HR/Legal |
| P1 | WIN-17 | Windows code-signing (OV/EV or Azure Trusted Signing) (P8-05) | BLOCKED | Needs certificate choice (D8). — unblocked by D8 Code signing |
| P1 | WIN-19 | Shipping build is MSVC (GNU cross-build loads WebView2Loader dynamically) | BLOCKED | Needs the Windows CI job (WIN-18); MSVC can't be built on this Mac. — unblocked by D2 Commit + private remote |
| P2 | WIN-12 | P5-04 browser extension on Windows (Chrome, Edge) | NEEDS VERIFICATION | Needs Windows hardware (WIN-01) or the Windows CI job (WIN-18). Only cross-compiled (x86_64-pc-windows-gnu) here. |
| P2 | WIN-20 | Missing WebView2 → app exits silently; show a message | NEEDS VERIFICATION | src-tauri/src/win/webview2.rs: MessageBoxW with download link when tauri::webview_version() fails; pure function unit-tested; cross-compiles. Not run on Windows without WebView2. |
| P3 | WIN-21 | UWP/Store apps resolve to the real app, not "Application Frame Host" | NEEDS VERIFICATION | win/activity.rs resolves ApplicationFrameHost.exe to the hosted app's exe via EnumChildWindows (pids only); pure selection unit-tested; cross-compiles. Not run on Windows. |

## Browser Extension (2)

| P | ID | Task | Status | What remains |
|---|---|---|---|---|
| P0 | EXT-02 | **[audit confirmed]** `host_permissions` is hard-coded to `http://localhost:4000/*`; needs a per-environment or optional permission requested at Connect (EXT-01 old) | NEEDS VERIFICATION | optional_host_permissions (https + loopback); Connect requests exactly the configured origin; Disconnect removes it; origin helper unit-tested (7/7). No staging API to connect to. |
| P2 | EXT-03 | Packaging, icons, distribution (Chrome Web Store unlisted or managed policy) | BLOCKED | No local work left: icons, package script and distribution doc done; needs your distribution-channel choice (Chrome Web Store unlisted vs managed policy) and, for the store, a developer account. — unblocked by D13 Extension distribution channel |

## Security (4)

| P | ID | Task | Status | What remains |
|---|---|---|---|---|
| P0 | SEC-09 | Staging `JWT_SECRET` and all secrets only in platform settings; rotation owner (old SEC-09) | BLOCKED | Needs Render/Vercel (DEP-01, DEP-04). render.yaml declares every secret sync:false with no value. — unblocked by D4 Hosting accounts + domain |
| P0 | SEC-12 | **[audit]** Privacy notice, DPIA/consent records and data-retention policy for real employees (monitoring transparency) | BLOCKED | Needs HR/Legal (D7). — unblocked by D7 HR/Legal |
| P1 | SEC-10 | Search staging logs for leaked secrets (old SEC-10) | BLOCKED | Needs staging logs (ST-10/DEP-13). Local suite run's server log had 0 secret matches. — unblocked by D4 Hosting accounts + domain |
| P1 | SEC-13 | Policy on admin-issued setup links (account takeover) | BLOCKED | Needs setup-link policy (D6). — unblocked by D6 Setup-link policy |

## Deployment (14)

| P | ID | Task | Status | What remains |
|---|---|---|---|---|
| P0 | DEP-01 | Render account, always-on plan, exactly one instance (HOST-01) | BLOCKED | Your Render account + plan (D4). — unblocked by D4 Hosting accounts + domain |
| P0 | DEP-02 | Render web service: build/start, `NODE_VERSION=24`, health path, `TRUST_PROXY=1` (HOST-02) | BLOCKED | Needs DEP-01. render.yaml has build/start, NODE_VERSION 24, health path, TRUST_PROXY=1. — unblocked by D4 Hosting accounts + domain |
| P0 | DEP-04 | Vercel staging project, root `apps/dashboard` (HOST-04) | BLOCKED | Your Vercel account (D4). — unblocked by D4 Hosting accounts + domain |
| P0 | DEP-06 | Domain; `api-staging` and `app-staging` CNAMEs (HOST-06) | BLOCKED | Your domain choice (D4). — unblocked by D4 Hosting accounts + domain |
| P0 | DEP-07 | Valid TLS on both hosts (HOST-07) | BLOCKED | Needs DEP-06. — unblocked by D4 Hosting accounts + domain |
| P0 | DEP-08 | https `CORS_ORIGINS`, `DASHBOARD_URL`; staging `NODE_ENV=production` (HOST-08) | BLOCKED | Needs DEP-07. — unblocked by D4 Hosting accounts + domain |
| P0 | DEP-09 | First Super Admin via `admin:create` from a trusted machine (HOST-09) | BLOCKED | 2026-11-03: Turso migrated to 0028; Super Admin creation deferred by the user. `admin:create` now refuses a hosted database with pending migrations instead of migrating it. Needs DEP-02 and DB-09. Audit 2026-11-03 (read-only, docs/status/TURSO-DATABASE-READINESS-AUDIT.md): `users` on Turso staging is empty; no Super Admin exists. — unblocked by D4 Hosting accounts + domain |
| P0 | DEP-13 | Staging integration suite (12 tests: auth, attendance, activity, screenshots, timelapse, retention, CORS, rate limits…) | BLOCKED | No local work left: staging-suite.mjs (12 checks) passes locally 11 + 1 https-only skip; the criterion is 12/12 on staging (D4 + D1). — unblocked by D4 Hosting accounts + domain |
| P1 | DEP-03 | **[audit confirmed]** `render.yaml` and `.node-version` absent; add them (HOST-03) | NEEDS VERIFICATION | render.yaml + .node-version present; YAML parses; 1 instance, /api/v1/health, 5 GB disk, secrets sync:false. Blueprint not validated by Render (no account). |
| P1 | DEP-11 | Uptime check on `/api/v1/ready` with alerting (MON-01) | BLOCKED | Needs DEP-02 + a monitoring account. Plan written in docs/deployment.md. — unblocked by D4 Hosting accounts + domain |
| P1 | DEP-12 | Error alerting and log retention (MON-02) | BLOCKED | Needs DEP-02 + log forwarding account. Plan written. — unblocked by D4 Hosting accounts + domain |
| P1 | DEP-15 | Pilot and production readiness review (P8-07) | BLOCKED | Needs DEP-13 and your sign-off. — unblocked by D4 Hosting accounts + domain |
| P2 | DEP-10 | `docs/deployment.md` aligned with Render/Vercel (HOST-10) | BLOCKED | No local work left: docs/deployment.md describes Render + Vercel + Turso; matching it to a real deployment needs DEP-02 (D4). — unblocked by D4 Hosting accounts + domain |
| P2 | DEP-14 | Production environment: Turso, Render, Vercel, storage (P8-06) | BLOCKED | Needs DEP-13 and accounts. — unblocked by D4 Hosting accounts + domain |

## CI/CD (6)

| P | ID | Task | Status | What remains |
|---|---|---|---|---|
| P0 | CI-01 | **Commit the working tree in reviewed chunks.** 1 commit exists; 109 modified, 205 untracked files, including migrations 0008–0017 and 0019 (0008–0016 are already applied to Turso). | BLOCKED | Needs your commit approval (D2). This task forbids commits. — unblocked by D2 Commit + private remote |
| P0 | CI-02 | Private GitHub remote and push | BLOCKED | Needs CI-01 + GitHub account. — unblocked by D2 Commit + private remote |
| P0 | CI-03 | CI workflow (checks, desktop-rust macOS, browser-suites, windows-desktop) authored, YAML parses, **never run** | NEEDS VERIFICATION | Every command of the `checks` and `desktop-rust` jobs run locally on the final tree: all green (see execution summary). Criterion is the first green run on GitHub, which needs CI-02. |
| P1 | CI-05 | Branch/PR workflow; protected `main` | BLOCKED | Needs CI-02. — unblocked by D2 Commit + private remote |
| P1 | CI-07 | Deploy pipeline: CI → Render/Vercel on `main`, migrations gated by approval | NEEDS VERIFICATION | .github/workflows/deploy-staging.yml: after green CI on main, environment: staging (approval), db:migrate --dry-run then migrate, then Render/Vercel deploy hooks; secrets by name. YAML parses; never run. |
| P2 | CI-06 | Track `apps/dashboard/.env.example` (ignored by `apps/dashboard/.gitignore:34`) | BLOCKED | No local work left: the negation rule is in place; the file becomes tracked only with the first commit (D2). — unblocked by D2 Commit + private remote |

## Product Features (20)

| P | ID | Task | Status | What remains |
|---|---|---|---|---|
| P0 | W34 | Cloud screenshot storage | BLOCKED | Storage decision D1. — unblocked by D1 Storage provider |
| P0 | W53 | HTTPS and encrypted storage | NEEDS VERIFICATION | Unchanged: production TLS untested (DEP-07). |
| P1 | F04 | Website tracking | PARTIAL | Host permission per environment done (EXT-02, needs staging to verify). Firefox/Safari support is the separate EXT-04 row, which you DEFERRED; until that changes, website tracking stays Chromium-only. |
| P1 | F12 | Email reports and work summary | BLOCKED | Email provider D5. — unblocked by D5 Email provider |
| P1 | W17 | Expected start, late clock-in, daily report, late email | BLOCKED | Local part done: per-person expected start/workdays drive daily report, late flag, alerts and now leave-day counting (Mon–Sat charged 5, Mon–Thu 3; e2e). Only the late EMAIL remains: needs the email provider (D5 / API-09). — unblocked by D5 Email provider |
| P1 | W43 | Invite employees by email | BLOCKED | Copyable setup link exists; sending invites by email needs the email provider (D5 / API-09). — unblocked by D5 Email provider |
| P1 | W46 | Visible mode (window + tray) | NEEDS VERIFICATION | Unchanged: needs MAC-09 / WIN-15 runtime. |
| P1 | W48 | Windows desktop app | NEEDS VERIFICATION | Unchanged: 0/32 Windows runtime (WIN-01). |
| P1 | W49 | macOS app (signed, Apple silicon + Intel) | BLOCKED | Universal build exists (MAC-17); signing needs the Apple Developer ID (D8) and the Intel run needs an Intel Mac. — unblocked by D8 Code signing |
| P2 | F01 | Timelapse videos | BLOCKED | Local part done: opt-in automatic daily videos (0028; one video per finished session, deduped, 3-day look-back, keeps an admin queue slot; real FFmpeg produced READY in the browser run). Remaining: durable storage of the MP4 (ST-17 → storage decision D1). — unblocked by D1 Storage provider |
| P2 | F02 | Screenshot blur/masking | NEEDS VERIFICATION | Unchanged: needs real-capture check (MAC-08). |
| P2 | F06 | Custom rules and alerts | BLOCKED | Local part done: in-app rules and alerts (browser-verified). Remaining email delivery needs the email provider (D5 / API-09). — unblocked by D5 Email provider |
| P2 | W20 | Automatic break on idle | BLOCKED | Product decision D11: is automatic break on idle wanted? — unblocked by D11 Product scope |
| P2 | W21 | Configurable idle threshold | NEEDS VERIFICATION | Per-person idle threshold (0025) returned by /activity/me; desktop already applies policy. Not run on a real desktop; extension still uses org value. |
| P2 | W22 | Exclude apps from idle | NEEDS VERIFICATION | Org idle-excluded app list in monitoring settings → policy.idleExcludedApps; Rust idle_excluded() + unit test. Not run on real macOS/Windows. |
| P3 | W19 | Auto clock-in on sign-in | BLOCKED | Product decision D11: is auto clock-in wanted? — unblocked by D11 Product scope |
| P3 | W30 | Capture every display | BLOCKED | Capturing every display is a product/privacy decision (more capture than today's primary-display-only design); needs your and HR/Legal's decision before any code (new decision D12). — unblocked by D12 Multi-display capture |
| P3 | W44 | Shareable invite link | BLOCKED | Conflicts with setup-link policy (D6). — unblocked by D6 Setup-link policy |
| P3 | W50 | Linux desktop app | BLOCKED | Product decision D11: Linux wanted? — unblocked by D11 Product scope |
| P3 | W51 | Android admin app | BLOCKED | Product decision D11: Android wanted? — unblocked by D11 Product scope |

