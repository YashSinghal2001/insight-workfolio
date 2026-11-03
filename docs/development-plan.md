# Development plan

10 working days to an accelerated MVP → controlled testing → 30-day employee pilot.

| Day | Focus | Status |
| --- | --- | --- |
| 1 | Monorepo foundation: API health/readiness, dashboard shell, desktop shell, shared packages, security docs | **Done** |
| 2 | Schema + migrations, email/password auth, sessions, RBAC, employee management API, dashboard sign-in and employee admin, desktop sign-in, admin bootstrap CLI | **Done** |
| 3 | Device registration (random installation ID), attendance state machine + API, desktop attendance UI with offline SQLite queue and sync, admin attendance overview | **Done** |
| 4 | Configurable attendance policy, timesheet engine (daily/weekly, overtime, incomplete shifts), history with date ranges, correction request/approval workflow with audit trail, dashboard timesheets and corrections, desktop history and corrections, reliability hardening | **Done** |
| 5 | Transparent activity monitoring on macOS (foreground app + idle, consent-gated, attendance-driven), offline activity queue and sync, activity API and dashboard page | **Done** (except: targeted native run of the 2026-10-19 automatic-switch idle fix not yet conclusive; see checklist item 8) |
| 6 | Activity accuracy review (midpoint app switches, unobserved gaps, batched ingestion), server-controlled monitoring settings with history, server-hosted notice versions and consent history, approval-gated activity retention with dry run, activity reports (weekly, observed vs unobserved, freshness, warnings), dashboard Settings, native verification harness, Windows collector plan | **Partial** (native lock/sleep verification pending) |
| 7 | Consent-gated screenshot engine on macOS (ScreenCaptureKit, primary display, WebP), durable local screenshot queue, screenshot policy and notice, metadata API with brokered upload and storage confirmation, storage adapter interface with dev-only local adapter and Microsoft Graph adapter scaffold, access log, approval-gated screenshot retention | **Partial** (Graph not verified against a tenant; lock/sleep capture checks need a person) |
| 8 | Admin screenshot gallery with secure viewer and real counts, self-view policy, access audit actions, hardened image delivery, Graph adapter completion (site scope, certificate auth, QuickXorHash confirmation, recycle-bin vs permanent delete, throttling retry, `verify:graph`), retention run log, single-instance desktop, privacy safeguards review, master checklist | **Partial** (real Graph BLOCKED on credentials; lock/sleep native checks need a person) |
| 9 | Production-readiness audit: local Git baseline and ignore rules, production config enforcement, API response headers, desktop file permissions, deployment/backup/hosting requirements. Still open: real Graph verification, signing, hosting, Turso, Windows | **Partial** (started 2026-10-19; external inputs below) |
| 10 | Hardening, end-to-end testing, pilot readiness review | |

Day 2 delivered most of the original Day 3 scope (auth, RBAC, dashboard sign-in) and the
desktop sign-in from Day 4, so later days shift forward.

## Day 9 progress (2026-10-19)

**Tracker:** item 8 (automatic foreground-switch idle overcount) stays **PARTIAL**: regression tests
pass, `pnpm build` succeeded on 2026-10-19, the new-build `verify:native` passed 8/8 with none
skipped. The exact automatic-switch + idle-threshold case is covered by deterministic tests only, not
natively: the targeted runs gave INCONCLUSIVE twice and one FAIL caused by the harness accepting
idle from before clock-in (docs/audit-report.md §5). Harness corrected 2026-10-27 (input after
monitoring start required, otherwise INCONCLUSIVE); a new native run is still needed.

**Done, with evidence:**
- **Local Git:** none existed. `.gitignore` reviewed and fixed (its `data/*.db*` pattern was
  anchored to the root and did not match `apps/api/data/dev.db`); added keys/certificates and
  unanchored database and screenshot patterns. `git init -b main`; the 170 files from
  `git add --dry-run` were reviewed and scanned for keys/tokens (none found), staged by explicit
  list, and committed as `0534823`. No remote, nothing pushed.
- **Production config:** the API now also refuses to boot in production with localhost or plain-http
  `CORS_ORIGINS` (including the unset default) or a non-https `DASHBOARD_URL`. Checked by
  `apps/api/test/env.test.ts` and by starting the built API with `NODE_ENV=production`: exit 1, the
  five failing variables named, no values printed.
- **API headers:** every response sends `Cache-Control: no-store` (desktop login/refresh bodies
  carry tokens and were cacheable), `nosniff`, `no-referrer`, `X-Frame-Options: DENY`.
  Screenshot image headers unchanged. Test in `health.e2e.test.ts`.
- **Desktop files:** the queue database and its WAL/SHM files were 0644 (inside a 0700 folder);
  now 0600 on open. Rust test `queue_files_are_owner_only`.
- **Audit, no change needed:** argon2id passwords; HttpOnly SameSite=Strict cookies, Secure in
  production; CSRF check on cookie requests; RBAC + ownership checks; zod validation with
  whitelisting; 1 MB JSON / 10 MB screenshot body caps; login and screenshot rate limits; error
  envelope without stack traces or query strings; atomic per-migration batches.
- **Documented:** docs/deployment.md (runtime, single-instance limits, config checks, backups,
  Bluehost checks to run, signing, Windows gaps).

**Commands run:** `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm build`,
`pnpm test`: all exit 0 (shared 27, database 9, desktop TS 21, desktop Rust 41 + 1 ignored
benchmark, API 88, dashboard smoke). `pnpm --filter @workfolio/api verify:graph`: BLOCKED (exit 2,
nothing contacted).

**Partial / limitations:** single API instance only (in-memory locks, rate limits, timers);
desktop data not encrypted at rest; the new production checks have run in tests and a local boot,
not on a real host.

**Blocked, with the input needed:**
- Microsoft Graph: tenant, Entra app with `Sites.Selected` + site grant, site ID, drive ID,
  certificate or secret on the API host, then `verify:graph` (docs/onedrive.md).
- Hosting: Bluehost VPS SSH access and the outputs listed in docs/deployment.md (OS, Node ≥ 24.7,
  root, systemd), DNS names, approval to deploy.
- Turso: database URL and scoped token; then a restore rehearsal.
- Signing: Apple Developer ID + notarization credentials; Windows Authenticode certificate.
- Windows: a Windows machine (collector, screenshots, single-instance, Credential Manager, packaging).
- HR/Legal: notice wording; activity and screenshot retention periods.
- Git remote: an approved repository.

**Manual checks still required:** `verify:screenshots` with the Mac asleep for at least 60 s;
`verify:graph` and an end-to-end staging run once Graph exists; a restore rehearsal once Turso exists.

## Day 9 prerequisites (historical)

1. **Approve Day 8.**
2. **Microsoft 365 (still blocking real storage):** dedicated SharePoint site, Entra app with
   `Sites.Selected` + admin consent + `write` grant on that site, site ID, drive ID, and a
   certificate (preferred) or client secret delivered to the API host. Then run
   `pnpm --filter @workfolio/api verify:graph` (docs/onedrive.md).
3. **A person at the Mac for ~20 minutes** to run `verify:native` and `verify:screenshots` with the
   lock and sleep steps (docs/master-checklist.md). Permission to lock and sleep the Mac is needed;
   I will not do it unasked.
4. **HR/Legal:** activity and screenshot notice wording, retention periods (then approve), who may
   view screenshots, employee self-view, app exclusions (masking is not implemented), and whether
   deleted screenshots may stay in the SharePoint recycle bin.
5. **Signing:** Apple Developer ID certificate (+ notarization credentials); Windows code-signing
   certificate and a Windows machine.
6. Still open: Turso, Git remote, hosting.

## Day 8 prerequisites (historical)

1. **Approve Day 7**, and run `pnpm --filter @workfolio/desktop verify:screenshots` and
   `verify:native` once with a person at the Mac (lock and sleep steps) to close the native gaps.
2. **Microsoft 365 (blocking for real storage):** dedicated SharePoint site, Entra app
   registration with `Sites.Selected` (Application) + admin consent, `write` grant on that one
   site, the drive ID, and a client secret delivered to the API's secret store (docs/onedrive.md).
   No new paid subscription is needed for this.
3. **HR/Legal:** screenshot notice wording (publish as a new version), interval, retention
   period (then approve it), who may view screenshots, whether employees may view their own,
   and whether any apps must be excluded from screenshots (masking is not implemented).
4. Still open: activity notice and retention approval, Windows machine, Turso, signing, Git remote, hosting.

## Day 7 prerequisites (historical)

1. **Approve Day 6**, and run `pnpm --filter @workfolio/desktop verify:native` once on the Mac
   (the lock and sleep steps need a person: about 5 minutes) to close the native verification gap.
2. **HR/Legal:** monitoring notice text (publish it as a new version in Settings), activity
   retention period (then tick "retention approved" with the decision as the reason).
3. **Microsoft 365:** Entra app registration with `Sites.Selected` on a dedicated SharePoint
   site, the site/library to store screenshots in, and screenshot frequency/retention/access rules.
4. **Windows machine** for the Windows collector (plan in docs/windows.md).
5. Still open: Turso dev database, code-signing certificates, Git remote, hosting.

## Day 6 prerequisites (historical)

1. **Approve Day 5**, including the monitoring defaults (15 s sampling, 5 min idle, locked
   screen = idle, app name + bundle ID only, no websites) and the draft notice wording.
2. **HR/Legal:** final monitoring notice text, activity data retention period, and how to
   handle an employee who does not acknowledge the notice.
3. **A Windows 10/11 machine** for the Windows collector (foreground process via
   `GetForegroundWindow`/`GetWindowThreadProcessId`, idle via `GetLastInputInfo`) and the
   pending Windows verification of Days 2–5.
4. Turso dev database, code-signing certificates, Git remote (still open).

## Day 5 prerequisites (historical)

1. **Approve Day 4**, including the attendance policy defaults (Monday weeks, 8 h scheduled
   day, overtime reported only, forgotten clock-outs need a correction, missing shifts
   attributed to the employee's latest device) and the correction rules (employee requests,
   a different admin decides, reason required both ways).
2. **Consent text** from Legal/HR for the in-app acknowledgement (blocks the pilot).
3. **Turso:** a dev database URL and scoped token to verify migrations 0001–0003 remotely.
4. **Timesheet export format** (CSV columns / payroll system), if export is wanted.
5. **Windows test machine**; **code-signing certificates** (also unblocks queue encryption
   and removes Keychain prompts after updates); FileVault/BitLocker policy for pilot devices.
6. Still open from Day 1: Microsoft 365 app registration, hosting details, Git remote.

## Day 4 prerequisites (historical)

1. **Approve Day 3**, including: one active device per employee; breaks must be ended before
   clock-out (no auto-close); offline events older than 7 days need a correction.
2. **Correction policy:** who may request and approve corrections (two-person rule is built
   into the schema), and whether employees can request their own.
3. **Timesheet rules:** week start, overtime thresholds, how a midnight-crossing shift is
   attributed (currently: the local date of clock-in), forgotten clock-outs.
4. **Consent text** from Legal/HR for the in-app acknowledgement.
5. **Windows test machine**, Turso dev database, and the open Day 1 items (M365 app
   registration, hosting, code signing, Git remote).

## Day 3 prerequisites (historical)

1. **Approve Day 2** and decide whether the setup-link flow (no admin-set passwords) is
   acceptable for the pilot, or whether Microsoft Entra SSO should replace it before then.
2. **Device identity:** confirm that an HMAC of the OS machine ID (macOS `IOPlatformUUID`,
   Windows `MachineGuid`) is acceptable under the monitoring policy, and how many devices
   each employee may register.
3. **Clock-in rules:** working-hours window, overnight shifts, break handling, and whether
   admins may edit time entries (and if so, audited).
4. **Turso:** a free-tier dev database URL and a scoped token (local SQLite works until then).
5. **Windows test machine** (or CI runner) to verify the desktop build and Credential
   Manager storage. Windows compatibility has not been tested yet.
6. Still open from Day 1: Microsoft 365 app registration (needed by Day 7), hosting details,
   legal/HR monitoring policy, code-signing certificates, Git remote.

## Day 2 prerequisites (historical)

Decisions and access needed from the business before or during Day 2:

1. **Turso:** create (or approve creating) a free-tier Turso database for development and
   provide `DATABASE_URL` + a scoped `DATABASE_AUTH_TOKEN`. Local SQLite works until then.
2. **Data model sign-off:** employee fields, timezone handling, and what defines a "session".
3. **Authentication approach:** Microsoft Entra ID (SSO with the existing Microsoft 365
   tenant, recommended since Graph is already required) vs. email/password.
4. **Microsoft 365:** an admin who can create an Entra app registration and grant
   `Sites.Selected` to a dedicated SharePoint site (needed by Day 7, request early).
5. **Hosting:** Bluehost VPS details (OS, Node.js support, root access, TLS) to confirm
   compatibility, or approval for an alternative host.
6. **Legal/HR:** start the monitoring policy and consent text (see docs/security.md); it must
   be ready before the pilot.
7. **Code signing:** Apple Developer ID and a Windows code-signing certificate are needed for
   Day 9 distribution without OS warnings.
8. **Git remote:** approval and a repository to push to.
