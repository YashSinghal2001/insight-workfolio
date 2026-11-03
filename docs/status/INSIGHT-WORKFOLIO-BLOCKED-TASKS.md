# Insight Workfolio: Blocked Tasks (2026-11-02)

**79 cohort tasks are BLOCKED.** Each waits on something only you (or a named third party) can provide. They are grouped by the decision that unblocks them; one decision often unblocks many rows.

## D1 Storage provider (20 tasks)

- **Who provides it:** You (business decision); then your Microsoft tenant admin (SharePoint) or your Google account (Drive)
- **Your approval required:** Yes
- **Exact action to unblock:** Approve one provider in writing. SharePoint: create the private site, grant Sites.Selected write to the app on that site only, run boundary tests T5–T8, then write 0018. Google: create the OAuth client/consent screen/test user, approve migration 0020, give the token a persistent home, run verify-google-drive.mjs.

| ID | Task | P | Exact reason | Safe local work already done |
|---|---|---|---|---|
| ST-02 | **Choose the production storage target**: dedicated SharePoint site (`Sites.Selected`), Google Drive (`drive.file`, OAuth), or another provider. The documents disagree: the roadmap keeps "OneDrive folder", the final storage decision says "dedicated SharePoint site", and Google Drive was then prototyped. | P0 | Your storage decision (D1). Recommendation in the (trashed) decision doc: dedicated SharePoint site with Sites.Selected. | — |
| ST-07 | Dedicated private SharePoint site + `Sites.Selected` `write` grant + boundary tests T5–T8 (OD-24) | P0 | Needs D1 = SharePoint and your approval to create the site and grant. | — |
| ST-09 | Storage key layout `Employees/<CODE>/YYYY/MM/DD/<uuid>.webp` (OD-13) | P1 | Needs D1. | — |
| ST-10 | T10 staging end to end: real screenshots land in the target; retention deletes them | P0 | Needs D1 and staging (DEP-01). The staging suite (DEP-13) covers upload/view/delete when it runs. | staging suite covers it |
| ST-11 | Purview retention and holds on the storage site confirmed with the tenant admin (OD-19) | P2 | Needs ST-07 and the tenant admin's written confirmation. | — |
| ST-14 | Google Cloud project, OAuth client, consent screen, test user | P1 | Needs D1 = Google and your Google account. | — |
| ST-15 | Real Google verification (`verify-google-drive.mjs`) | P1 | Needs ST-14. | — |
| ST-16 | **[audit]** Google refresh token lives in `GOOGLE_DRIVE_TOKEN_FILE` (0600). On Render the filesystem is ephemeral unless a disk is attached, so the connection is lost on every deploy. | P1 | Only if D1 = Google. | — |
| ST-17 | Durable timelapse storage: upload MP4, serve/delete from storage, TTL (TL-01…03) | P1 | Needs DB-11 (0018), blocked on D1. | — |
| ST-18 | Screenshots on Google Drive wired but guarded off until DB-12 | P1 | Needs DB-12 (0020), blocked on D1. | — |
| ST-19 | Timelapse cloud upload adapter (Google adapter ready; service not wired) | P1 | Needs DB-11 / ST-17. | — |
| DB-11 | Migration 0018 (timelapse storage columns, reserved by the Graph session, **not written**) | P1 | 0018 waits on the storage decision (D1). Gap-fill tests now prove a later 0018 applies safely after 0019–0028. | gap-fill tests for a later 0018 |
| DB-12 | **[audit]** Migration 0020: widen `screenshots.storage_provider` CHECK to include `GOOGLE_DRIVE` (not written; required before Google Drive can store screenshots) | P1 | 0020 only if Google Drive is chosen (D1) + migration approval. | — |
| API-10 | Google OAuth pending state and connection survive restarts / more than one instance (state is an in-process `Map`) | P3 | Only relevant if Google Drive is chosen (D1). Pending state is still an in-process Map, documented in docs/deployment.md single-instance section. | — |
| W34 | Cloud screenshot storage | P0 | Storage decision D1. | — |
| AW-04 | Storage connection and status panel (provider, account, last upload, "Connect Google Drive" button if Google is chosen) | P1 | Local part done: Storage card shows provider, status and 'Last upload' (admin-only GET /settings/screenshots, not exposed on public /ready; e2e + browser). Remaining account display and Connect/disconnect against the real provider need the storage decision (D1). | storage card with provider, status, last upload |
| AW-06 | Timelapse viewer: durable playback after API restart (today the MP4 lives only in the API host cache) | P1 | No local work left: durable playback needs ST-19 → DB-11 (0018), i.e. the storage decision (D1). | — |
| ST-08 | Graph session's paused code: `GRAPH_FOLDER_ID`, folder-ID addressing, chunked `putFile`, `getStream`, `folderIsConfigured()` (uncommitted, tenant-untested) | P1 | No local work left: keep or drop the storage session's Graph code depends on the storage decision (D1); T6/T7 need the chosen site. | — |
| ST-12 | Microsoft docs updated for the OneDrive rejection (OD-17) | P2 | No local work left: docs/onedrive.md already records the rejection; it becomes final when you approve the storage decision (D1). | docs/onedrive.md updated |
| F01 | Timelapse videos | P2 | Local part done: opt-in automatic daily videos (0028; one video per finished session, deduped, 3-day look-back, keeps an admin queue slot; real FFmpeg produced READY in the browser run). Remaining: durable storage of the MP4 (ST-17 → storage decision D1). | automatic daily videos (0028) |

## D2 Commit + private remote (6 tasks)

- **Who provides it:** You (repo owner) and a GitHub account
- **Your approval required:** Yes
- **Exact action to unblock:** Approve committing the working tree in reviewed chunks (W0 plan), create a private GitHub repo, push main, protect main; the first push runs CI incl. the windows-desktop job (WIN-18) and the MSVC build (WIN-19).

| ID | Task | P | Exact reason | Safe local work already done |
|---|---|---|---|---|
| CI-01 | **Commit the working tree in reviewed chunks.** 1 commit exists; 109 modified, 205 untracked files, including migrations 0008–0017 and 0019 (0008–0016 are already applied to Turso). | P0 | Needs your commit approval (D2). This task forbids commits. | — |
| CI-02 | Private GitHub remote and push | P0 | Needs CI-01 + GitHub account. | — |
| CI-05 | Branch/PR workflow; protected `main` | P1 | Needs CI-02. | — |
| WIN-18 | Windows CI job `windows-desktop` actually run (P8-09) | P0 | Needs a commit + private remote (D2). | — |
| WIN-19 | Shipping build is MSVC (GNU cross-build loads WebView2Loader dynamically) | P1 | Needs the Windows CI job (WIN-18); MSVC can't be built on this Mac. | — |
| CI-06 | Track `apps/dashboard/.env.example` (ignored by `apps/dashboard/.gitignore:34`) | P2 | No local work left: the negation rule is in place; the file becomes tracked only with the first commit (D2). | gitignore negation |

## D3 Turso staging migrations (4 tasks)

- **Who provides it:** You (approval) with Turso account access
- **Your approval required:** Yes
- **Exact action to unblock:** After D2: take a db:dump of Turso staging, run `db:migrate --dry-run`, then `db:migrate` (now 0017, 0019 and 0021–0028: 10 pending, Turso at 0016), run it a second time (expect 0 applied), then verify:turso (expect 26 applied, 0 pending). Step-by-step: "First staging migration runbook" in docs/database-operations.md. Migration numbers 0021–0028 were assigned during execution and need your confirmation.

| ID | Task | P | Exact reason | Safe local work already done |
|---|---|---|---|---|
| DB-07 | T2 second migration run applies nothing on Turso | P1 | **DONE 2026-11-03:** a second `db:migrate` on Turso staging printed "No pending migrations." (TURSO-DATABASE-IMPLEMENTATION-REPORT.md). Needs Turso migration approval (D3, after DB-09/DB-10). Locally: migration-order.test.ts proves a second run applies nothing. | migration-order.test.ts |
| DB-09 | **Apply 0017 to Turso staging.** Turso is at 0016. | P0 | **DONE 2026-11-03** (approved by the user): `db:migrate` applied 0017 with 0019 and 0021–0028 to Turso staging; `verify:turso`: 26 applied, 0 pending, 51 tables / 65 indexes / 91 triggers identical to reference, integrity/quick/FK checks clean (TURSO-DATABASE-IMPLEMENTATION-REPORT.md). Turso migration approval (D3). Turso is at 0016; Audit 2026-11-03 (read-only, docs/status/TURSO-DATABASE-READINESS-AUDIT.md): 10 pending (0017, 0019, 0021–0028), no Turso dump yet. | — |
| DB-10 | **[audit] Apply 0019 (screenshot blur policy) to Turso staging.** It is not on Turso (Turso is at 0016). | P0 | **DONE 2026-11-03** (approved by the user): 0019 applied to Turso staging with 0017 and 0021–0028; verified as for DB-09 (TURSO-DATABASE-IMPLEMENTATION-REPORT.md). Turso migration approval (D3). NOTE: source now has 0021–0028 too. Audit 2026-11-03 (read-only, docs/status/TURSO-DATABASE-READINESS-AUDIT.md): Turso at 0016, 10 pending (0017, 0019, 0021–0028), no Turso dump yet, no Super Admin. Hosted API boots no longer migrate (they refuse to start while any are pending; this change set), so apply via the runbook in docs/database-operations.md. | gap-fill tests |
| DB-15 | Dump procedure before each migration-bearing deploy | P1 | **DONE 2026-11-03:** first Turso dump `~/insight-workfolio-backups/workfolio-2026-11-03T06-40-01-494Z.sql` (0600, 40 tables, 19 rows, ids 0001–0016) restored into a scratch SQLite file; `verify:turso` on the restore passed and matched Turso (TURSO-DATABASE-IMPLEMENTATION-REPORT.md). No local work left: dump/restore script and docs done and rehearsed on a local copy; the first real Turso dump needs Turso access and the migration approval (D3). Audit 2026-11-03 (read-only, docs/status/TURSO-DATABASE-READINESS-AUDIT.md): no Turso dump exists yet. | dump script, local rehearsal |

## D4 Hosting accounts + domain (20 tasks)

- **Who provides it:** You: Render account + paid plan, Vercel account, a domain you control; monitoring/log accounts for DEP-11/12
- **Your approval required:** Yes
- **Exact action to unblock:** Create the Render service from render.yaml (1 instance, disk, FFmpeg for timelapse), the Vercel project (root apps/dashboard), api-staging/app-staging CNAMEs; set secrets in the platforms only; create the first Super Admin; run `pnpm --filter @workfolio/api staging:suite`.

| ID | Task | P | Exact reason | Safe local work already done |
|---|---|---|---|---|
| AW-03 | Admin web on staging over HTTPS against the real API | P0 | Needs Render + Vercel accounts and a domain (D4: DEP-01, DEP-04, DEP-06). Nothing to do locally. | staging suite ready (DEP-13) |
| EW-06 | Employee web on staging over HTTPS | P0 | Needs staging hosts (AW-03 / D4). | — |
| DEP-01 | Render account, always-on plan, exactly one instance (HOST-01) | P0 | Your Render account + plan (D4). | — |
| DEP-02 | Render web service: build/start, `NODE_VERSION=24`, health path, `TRUST_PROXY=1` (HOST-02) | P0 | Needs DEP-01. render.yaml has build/start, NODE_VERSION 24, health path, TRUST_PROXY=1. | render.yaml |
| DEP-04 | Vercel staging project, root `apps/dashboard` (HOST-04) | P0 | Your Vercel account (D4). | — |
| DEP-06 | Domain; `api-staging` and `app-staging` CNAMEs (HOST-06) | P0 | Your domain choice (D4). | — |
| DEP-07 | Valid TLS on both hosts (HOST-07) | P0 | Needs DEP-06. | — |
| DEP-08 | https `CORS_ORIGINS`, `DASHBOARD_URL`; staging `NODE_ENV=production` (HOST-08) | P0 | Needs DEP-07. | — |
| DEP-09 | First Super Admin via `admin:create` from a trusted machine (HOST-09) | P0 | 2026-11-03: Turso migrated to 0028; Super Admin creation deferred by the user. `admin:create` now refuses a hosted database with pending migrations instead of migrating it. Needs DEP-02 and DB-09. Audit 2026-11-03 (read-only, docs/status/TURSO-DATABASE-READINESS-AUDIT.md): `users` on Turso staging is empty; no Super Admin exists. | — |
| DEP-11 | Uptime check on `/api/v1/ready` with alerting (MON-01) | P1 | Needs DEP-02 + a monitoring account. Plan written in docs/deployment.md. | monitoring plan in docs/deployment.md |
| DEP-12 | Error alerting and log retention (MON-02) | P1 | Needs DEP-02 + log forwarding account. Plan written. | monitoring plan |
| DEP-14 | Production environment: Turso, Render, Vercel, storage (P8-06) | P2 | Needs DEP-13 and accounts. | — |
| DEP-15 | Pilot and production readiness review (P8-07) | P1 | Needs DEP-13 and your sign-off. | — |
| DB-16 | DB-scoped token stored only in Render | P1 | Needs the Render service (DEP-01). render.yaml declares DATABASE_AUTH_TOKEN as sync:false (no value). Audit 2026-11-03 (read-only, docs/status/TURSO-DATABASE-READINESS-AUDIT.md): the current staging token is read-write with no expiry and sits in apps/api/.env.staging inside the repo tree; move it out and rotate once Render/GitHub secrets exist. | render.yaml sync:false |
| API-12 | FFmpeg with libx264 on the API host; persistent `TIMELAPSE_DIR` (TL-05) | P1 | Needs the Render service (DEP-01) with FFmpeg + the persistent disk declared in render.yaml. | render.yaml disk + TIMELAPSE_DIR |
| SEC-09 | Staging `JWT_SECRET` and all secrets only in platform settings; rotation owner (old SEC-09) | P0 | Needs Render/Vercel (DEP-01, DEP-04). render.yaml declares every secret sync:false with no value. | render.yaml secrets sync:false |
| SEC-10 | Search staging logs for leaked secrets (old SEC-10) | P1 | Needs staging logs (ST-10/DEP-13). Local suite run's server log had 0 secret matches. | local suite log scan clean |
| API-13 | **[audit]** Single-instance constraint documented and enforced on Render (OAuth state, in-process caches, migration runner assumptions) | P1 | No local work left: the single-instance rule is audited and recorded (render.yaml numInstances: 1, docs/deployment.md); the criterion is the real Render setting (DEP-01, D4). | render.yaml + docs |
| DEP-10 | `docs/deployment.md` aligned with Render/Vercel (HOST-10) | P2 | No local work left: docs/deployment.md describes Render + Vercel + Turso; matching it to a real deployment needs DEP-02 (D4). | docs/deployment.md |
| DEP-13 | Staging integration suite (12 tests: auth, attendance, activity, screenshots, timelapse, retention, CORS, rate limits…) | P0 | No local work left: staging-suite.mjs (12 checks) passes locally 11 + 1 https-only skip; the criterion is 12/12 on staging (D4 + D1). | staging suite, local 11 + 1 skip |

## Turso account details (3 tasks)

- **Who provides it:** You (Turso account owner)
- **Your approval required:** No approval, needs account access
- **Exact action to unblock:** Fill the plan / PITR window table in docs/database-operations.md, run the 7-step restore rehearsal written there; create the production DB after pilot sign-off.

| ID | Task | P | Exact reason | Safe local work already done |
|---|---|---|---|---|
| DB-13 | Turso plan and restore window recorded | P1 | Needs Turso account access to read the plan/PITR window (the `turso` CLI is not installed on the audit machine). docs/database-operations.md has the blank table to fill. | docs/database-operations.md template |
| DB-14 | T19 point-in-time restore rehearsal into a new database | P1 | Needs Turso account (and DB-13). Owner steps written in docs/database-operations.md. | rehearsal steps written |
| DB-17 | Separate production Turso database | P2 | Needs pilot sign-off and Turso account. | — |

## D5 Email provider (5 tasks)

- **Who provides it:** You: choose provider and sending mailbox
- **Your approval required:** Yes
- **Exact action to unblock:** Pick a provider (e.g. Microsoft 365 SMTP / Graph sendMail, SES, Postmark); then implement MailTransport and wire setup links, reports and the alerts hook (sendAlertEmails).

| ID | Task | P | Exact reason | Safe local work already done |
|---|---|---|---|---|
| API-09 | Email `MailTransport` for setup/invite links and reports (EM-02…04) | P1 | Needs an email provider and sending mailbox (D5). Alerts (F06) already call a no-op sendAlertEmails hook ready for it. | alerts email hook |
| F12 | Email reports and work summary | P1 | Email provider D5. | — |
| W17 | Expected start, late clock-in, daily report, late email | P1 | Local part done: per-person expected start/workdays drive daily report, late flag, alerts and now leave-day counting (Mon–Sat charged 5, Mon–Thu 3; e2e). Only the late EMAIL remains: needs the email provider (D5 / API-09). | per-person schedule + leave workdays |
| F06 | Custom rules and alerts | P2 | Local part done: in-app rules and alerts (browser-verified). Remaining email delivery needs the email provider (D5 / API-09). | in-app rules and alerts |
| W43 | Invite employees by email | P1 | Copyable setup link exists; sending invites by email needs the email provider (D5 / API-09). | — |

## D6 Setup-link policy (3 tasks)

- **Who provides it:** You (security policy)
- **Your approval required:** Yes
- **Exact action to unblock:** Decide who may mint setup links for whom (recommended: only Super Admin for Admins, Admins for Employees, single-use 48 h); then enforce in employees.service.ts and the UI.

| ID | Task | P | Exact reason | Safe local work already done |
|---|---|---|---|---|
| AW-07 | Policy and UI for admin-issued setup links (SEC-07: an Admin can mint a link for another user) | P1 | Needs your setup-link policy (D6): who may mint links for whom. | — |
| SEC-13 | Policy on admin-issued setup links (account takeover) | P1 | Needs setup-link policy (D6). | — |
| W44 | Shareable invite link | P3 | Conflicts with setup-link policy (D6). | — |

## D7 HR/Legal (3 tasks)

- **Who provides it:** HR/Legal
- **Your approval required:** Yes
- **Exact action to unblock:** Approve the screenshot notice wording (blur), accept Windows' lack of an OS capture prompt, set retention periods and complete the DPIA / consent records.

| ID | Task | P | Exact reason | Safe local work already done |
|---|---|---|---|---|
| MAC-15 | HR/Legal: revised screenshot notice wording (blur) | P1 | Needs HR/Legal wording (D7). | — |
| WIN-16 | HR/Legal: no OS screen-capture prompt on Windows (P6-03) | P1 | Needs HR/Legal acceptance (D7). | — |
| SEC-12 | **[audit]** Privacy notice, DPIA/consent records and data-retention policy for real employees (monitoring transparency) | P0 | Needs HR/Legal (D7). | — |

## D8 Code signing (5 tasks)

- **Who provides it:** You: Apple Developer Program membership; Windows OV/EV certificate or Azure Trusted Signing
- **Your approval required:** Yes (purchase)
- **Exact action to unblock:** Obtain the Developer ID certificate, then notarise with hardened runtime; choose the Windows signing route; then add the updater signing key and update host.

| ID | Task | P | Exact reason | Safe local work already done |
|---|---|---|---|---|
| MAC-13 | Apple Developer ID certificate (P8-01) | P1 | Needs your Apple Developer ID (D8). | — |
| MAC-14 | Notarisation, hardened runtime, entitlements, `minimumSystemVersion` 14 (P8-02) | P1 | Needs MAC-13. | — |
| MAC-18 | Auto-updater: plugin, signing key, update host (P7-05) | P2 | Needs signing (MAC-14) and an update host. | — |
| WIN-17 | Windows code-signing (OV/EV or Azure Trusted Signing) (P8-05) | P1 | Needs certificate choice (D8). | — |
| W49 | macOS app (signed, Apple silicon + Intel) | P1 | Universal build exists (MAC-17); signing needs the Apple Developer ID (D8) and the Intel run needs an Intel Mac. | universal build |

## D9 Windows hardware (1 tasks)

- **Who provides it:** You: a Windows 11 and a Windows 10 machine or VM
- **Your approval required:** No
- **Exact action to unblock:** Provide the machines; then run the 32-item checklist (WIN-03…15, WIN-12, WIN-20/21, W48).

| ID | Task | P | Exact reason | Safe local work already done |
|---|---|---|---|---|
| WIN-01 | Windows hardware or VM, Windows 11 + Windows 10 (P4-01) | P0 | Needs Windows 11 + 10 hardware or VM (D9). | — |

## Intel Mac hardware (1 tasks)

- **Who provides it:** You: access to any Intel Mac (macOS 14+)
- **Your approval required:** No
- **Exact action to unblock:** Copy the universal Insight Workfolio.app to an Intel Mac, open it (right-click → Open while unsigned), sign in, clock in and confirm activity and a screenshot upload.

| ID | Task | P | Exact reason | Safe local work already done |
|---|---|---|---|---|
| MAC-17 | Intel / universal build (P8-04) | P2 | No local work left: universal binary built and launched under Rosetta; the criterion needs a real Intel Mac (hardware). | universal build, Rosetta launch |

## D12 Multi-display capture (1 tasks)

- **Who provides it:** You with HR/Legal (privacy decision)
- **Your approval required:** Yes
- **Exact action to unblock:** Decide whether capturing every display (not only the primary) is wanted and acceptable under the employee notice; if yes, it becomes a desktop task (ScreenCaptureKit + Windows GDI) needing macOS/Windows runtime checks.

| ID | Task | P | Exact reason | Safe local work already done |
|---|---|---|---|---|
| W30 | Capture every display | P3 | Capturing every display is a product/privacy decision (more capture than today's primary-display-only design); needs your and HR/Legal's decision before any code (new decision D12). | — |

## D13 Extension distribution channel (1 tasks)

- **Who provides it:** You (and a Chrome Web Store developer account if that channel is chosen)
- **Your approval required:** Yes
- **Exact action to unblock:** Choose unlisted Chrome Web Store or managed policy (ExtensionInstallForcelist); then publish the zip from `pnpm --filter browser-extension package` and install it from that channel.

| ID | Task | P | Exact reason | Safe local work already done |
|---|---|---|---|---|
| EXT-03 | Packaging, icons, distribution (Chrome Web Store unlisted or managed policy) | P2 | No local work left: icons, package script and distribution doc done; needs your distribution-channel choice (Chrome Web Store unlisted vs managed policy) and, for the store, a developer account. | icons, zip, distribution doc |

## D10 Devices per employee (1 tasks)

- **Who provides it:** You (product decision)
- **Your approval required:** Yes
- **Exact action to unblock:** Decide whether an employee may have more than one active device; then relax the index and add conflict rules.

| ID | Task | P | Exact reason | Safe local work already done |
|---|---|---|---|---|
| API-11 | Multi-device per employee (P3-02…04: index relaxation, clock-event conflict rules, tests) | P2 | Needs the devices-per-employee decision (D10). | — |

## D11 Product scope (4 tasks)

- **Who provides it:** You (product decision)
- **Your approval required:** Yes
- **Exact action to unblock:** Decide whether auto clock-in, automatic idle break, a Linux app and an Android admin app are wanted.

| ID | Task | P | Exact reason | Safe local work already done |
|---|---|---|---|---|
| W19 | Auto clock-in on sign-in | P3 | Product decision D11: is auto clock-in wanted? | — |
| W20 | Automatic break on idle | P2 | Product decision D11: is automatic break on idle wanted? | — |
| W50 | Linux desktop app | P3 | Product decision D11: Linux wanted? | — |
| W51 | Android admin app | P3 | Product decision D11: Android wanted? | — |

## Your manual Microsoft action (1 tasks)

- **Who provides it:** You (signed in to your Microsoft account)
- **Your approval required:** No
- **Exact action to unblock:** Revoke Graph Explorer's delegated Files.ReadWrite at myapplications.microsoft.com.

| ID | Task | P | Exact reason | Safe local work already done |
|---|---|---|---|---|
| ST-05 | Revoke Graph Explorer's delegated `Files.ReadWrite` for your account | P2 | Your manual action at myapplications.microsoft.com. | — |

