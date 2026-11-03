# Deployment requirements (Day 9 audit)

**Status (2026-11-03): nothing is deployed, and no host or storage has been verified.** The Turso
staging database exists and passed a read-only audit (at `0016`, 10 migrations pending; not yet used by any API).
Planned hosting: **Render** (API), **Vercel** (dashboard), **Turso** (database). The configuration is
in the repository (`render.yaml`, `.node-version`, `.github/workflows/deploy-staging.yml`) but has never
been run against a real account, so this page describes the plan, not a matched deployment. It is not
a claim that the app is production- or pilot-ready. Step-by-step staging plan: `STAGING-DEPLOYMENT-PLAN.md`.

## What runs where

| Component | Runtime | Notes |
| --- | --- | --- |
| API (`apps/api`) | **Render web service**, Node runtime, **exactly one always-on instance** (`node dist/main.js`) | Node ≥ 24.7 (`NODE_VERSION=24`, `.node-version`): password hashing uses `argon2` from `node:crypto`. Long-lived: in-process timers run retention and report jobs, so a sleeping free instance does not work |
| Dashboard (`apps/dashboard`) | **Vercel** (Next.js) | Uses partial prerendering (`cacheComponents`), so it is **not** a static export. `NEXT_PUBLIC_API_URL` is baked in at build time. `next build` **fails** when it is unset/empty, or not `https://` (plain `http://` only for `localhost`/`127.0.0.1`/`[::1]`, i.e. local builds: `NEXT_PUBLIC_API_URL=http://localhost:4000`). `next dev`/`next start` keep the localhost fallback |
| Database | Turso (libSQL) | Required in production (`DATABASE_URL=libsql://…` + `DATABASE_AUTH_TOKEN`); local SQLite is refused |
| Screenshot storage | Microsoft Graph (dedicated SharePoint site, `Sites.Selected`) | Required in production; see docs/onedrive.md. The OneDrive-folder option was rejected; the provider decision awaits the user's final approval. **BLOCKED: the site does not exist yet** |
| Timelapse encoder | **FFmpeg with libx264** on the API host (separate process, not bundled) | Optional: without it timelapse creation is refused with a clear reason. Videos are a short-lived cache in `TIMELAPSE_DIR` (persistent local disk, owner-only; 24 h). Sizing, licensing (GPL libx264, H.264 patents) and limits: docs/timelapse.md. **Not installed anywhere yet** |
| Desktop app | Signed macOS app; signed Windows NSIS installer (Windows code complete, cross-built only; never run on Windows yet) | See "Desktop distribution" |

Render and Vercel supervise the processes and terminate TLS. The API trusts `X-Forwarded-For`
according to `TRUST_PROXY` (default `loopback`); behind Render's proxy set `TRUST_PROXY=1` (one hop),
otherwise every client shares the proxy's address in the per-IP rate limits (not yet verified on Render).

## Database startup safeguards (shared data layer, 2026-10-30)

What the API does with migrations at boot depends on `DATABASE_URL` (implemented in this change set;
details in docs/database-operations.md "Migrations: local vs hosted"):

- **Local** (`file:` or `:memory:`): applies pending migrations at boot, as before.
- **Hosted** (`libsql://` or `https://`, i.e. Turso, which production requires): **never migrates at
  boot.** It runs a read-only migration-status check and refuses to start when any migration is
  pending. Migrations on a hosted database run only through
  `pnpm --filter @workfolio/api db:migrate` (dry-run first), from the approval-gated deploy workflow or
  a trusted machine with approval. **Deploy order: migrate → deploy.**

In both cases the API refuses to start (non-zero exit, clear log line naming the ids, no secrets) when:
- a migration is pending (hosted only) or fails (local; each migration is one transaction with its
  bookkeeping row; nothing partial);
- an applied migration was edited afterwards (sha256 checksum per migration in `schema_migrations`);
- the database lists a migration this build does not know (it was migrated by a newer build);
- the connection does not enforce foreign keys (`PRAGMA foreign_keys`). On Turso staging this was
  verified ON in the read-only audit of 2026-11-03.
It logs the schema version it runs on. Two `db:migrate` runs (or two local processes) starting together
do not fail: the second sees the migration already applied. Local `file:` databases get a 5 s busy timeout on every pooled
connection. Rollback = redeploy the previous build only if it knows every applied migration (otherwise it
refuses to start by design); data rollback = Turso point-in-time restore.

## Single instance only

Run **exactly one API process** (API-13). On Render this is `numInstances: 1` with **no autoscaling**
(`render.yaml` says so in a comment; never add a `scaling` block, and keep it at 1 in the dashboard).
The persistent disk also limits the service to one instance. These are kept in memory and are not
shared between processes:

- rate limiters (login attempts, screenshot uploads, per-session API limit), so limits would multiply per instance;
- OAuth `state` of the Google Drive connect flow (testing POC), so a callback that lands on another
  instance fails;
- in-process caches (e.g. the Microsoft Graph token);
- per-employee locks that serialize attendance and screenshot writes, so two instances could race
  (e.g. two screenshots closer than the policy spacing);
- scheduled activity and screenshot retention timers, which would run once per instance;
- schema checks at boot (hosted databases are never migrated at boot; `db:migrate` runs separately,
  and two concurrent runners are handled: the second sees the migration already applied).

Scaling out needs a shared store for locks, limits and OAuth state and a single scheduler. Not
needed for the pilot size. Render deploys with a disk stop the old instance before starting the new
one, so each deploy has a short downtime; there is never a moment with two instances.

## Production configuration (checked at boot)

The API validates its environment at start and refuses to run in production with (2026-10-19
tests in `apps/api/test/env.test.ts`):

- local SQLite or `wss://` (`DATABASE_URL` must be `libsql://` or `https://`; Turso staging refuses the
  WebSocket transport);
- missing or short `JWT_SECRET` (at least 32 characters);
- `SCREENSHOT_STORAGE` other than `graph`, missing Graph IDs, or not exactly one Graph credential;
- **`CORS_ORIGINS` unset (the localhost default) or containing anything other than `https://`
  origins and the desktop app origins `tauri://localhost` / `http://tauri.localhost`;**
- **`DASHBOARD_URL` that is not `https://`.**
- `REPORT_MAIL_PROVIDER=mock` (email reports; development only). The default `none` emails nothing.

Website tracking (F04) stays blocked in production unless `WEBSITE_TRACKING_APPROVED=true`. Set it
only after HR/Legal approved the website notice and the texts that still say websites are never
recorded were revised (docs/website-usage.md).

Errors name the variable, never its value. Cookies are `Secure` in production. Every API response
carries `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`
and `X-Frame-Options: DENY`; HSTS on the API domain depends on Render (unverified). The dashboard
sends its own security headers including HSTS (`apps/dashboard/next.config.ts`).

Secrets (`JWT_SECRET`, `DATABASE_AUTH_TOKEN`, `GRAPH_CLIENT_SECRET` or the certificate key file)
live only in the platform's environment settings (Render env vars / Secret Files, GitHub environment
secrets). Never in the repository (`.gitignore` excludes `.env*`, keys and certificates; `render.yaml`
lists them with `sync: false` and no value) or on desktops.

## Backup and restore

- **Production data is in Turso.** Backups are Turso's point-in-time restore, whose window depends
  on the plan. **Not verified:** the staging database `workfolio` exists (audited read-only
  2026-11-03), but its plan and PITR window are not recorded (DB-13, the Turso CLI is not installed),
  no restore was rehearsed (DB-14), no Turso dump has been taken yet, and no production database
  exists (DB-17). Before the pilot: confirm the plan's restore window, and rehearse a restore into a
  separate database.
- **Before every migration-bearing deploy**, from a trusted machine: record the UTC time and run
  `pnpm --filter @workfolio/api db:dump` (`apps/api/scripts/db-dump.mjs`, read-only, writes outside the
  repo; docs/database-operations.md). Only then approve the deploy workflow's migration step.
- Retention purges are permanent in the database; restoring a backup would also restore purged
  rows (docs/security.md).
- Screenshots live in SharePoint: covered by Microsoft 365 retention and the site recycle bin, not
  by the database backup.
- The local development database (`apps/api/data/dev.db`) is not backed up and is not production data.

## Hosting: Render + Vercel + Turso (planned, NOT DEPLOYED)

No account exists yet (DEP-01, DEP-04 blocked). Nothing below has been run; every value is checked
against the code only. The earlier Bluehost VPS option was dropped (no details were ever provided).

### Render: API (`render.yaml`)

| Setting | Value |
| --- | --- |
| Service | Web service, Node runtime, `plan: starter` (paid, always on; free instances sleep and have no disk) |
| Instances | `numInstances: 1`, no autoscaling (see "Single instance only") |
| Root directory | `apps/api` |
| Build | `cd ../.. && corepack enable pnpm && pnpm install --frozen-lockfile --prod=false && pnpm build:packages && pnpm --filter @workfolio/api build` (`--prod=false`: with `NODE_ENV=production` pnpm would skip `@nestjs/cli`) |
| Start | `node dist/main.js`: verifies the schema read-only at boot and refuses to start on a pending, edited or unknown migration. It never migrates Turso; `db:migrate` must run first |
| Health check | `/api/v1/health` (liveness only, no dependencies). **Not** `/api/v1/ready`: it probes the database and the storage provider on every call, and a Turso or Graph blip must not make Render restart the API |
| Persistent disk | `/var/data`, `TIMELAPSE_DIR=/var/data/timelapses` (24 h timelapse cache, docs/timelapse.md). FFmpeg with libx264 is not part of Render's Node runtime: without it timelapse creation is refused (API-12, unverified) |
| Node | `NODE_VERSION=24` and `.node-version` (`24`) |
| Auto-deploy | Off; deploys come from the deploy workflow (below) |
| Custom domain | `api-staging.<domain>` (Render issues TLS) |

Environment (names only; values only in Render):
- fixed in `render.yaml`: `NODE_VERSION`, `NODE_ENV=production`, `TRUST_PROXY=1`, `LOG_LEVEL`,
  `TIMELAPSE_DIR`, `SCREENSHOT_STORAGE=graph`, `GRAPH_PERMANENT_DELETE=false`, `REPORT_MAIL_PROVIDER=none`,
  `WEBSITE_TRACKING_APPROVED=false`, `WEBSITE_RETENTION_APPROVED=false`;
- entered in the dashboard (`sync: false`): `CORS_ORIGINS`, `DASHBOARD_URL`, `GRAPH_FOLDER`,
  `DATABASE_URL`, `DATABASE_AUTH_TOKEN`, `JWT_SECRET`, `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`,
  `GRAPH_SITE_ID`, `GRAPH_DRIVE_ID`, `GRAPH_FOLDER_ID`, and exactly one of `GRAPH_CLIENT_SECRET` or
  `GRAPH_CERT_KEY_PATH` + `GRAPH_CERT_THUMBPRINT` (key as a Render Secret File under `/etc/secrets/`).
- The `GOOGLE_*` variables are not set: Google Drive is a testing POC only.

### Vercel: dashboard

Root directory `apps/dashboard`, framework Next.js, Node 24.x, build `pnpm --filter @workfolio/shared build && next build`.
Variables: `NEXT_PUBLIC_API_URL` (`https://api-staging.<domain>`, public by design), and
`ENABLE_EXPERIMENTAL_COREPACK=1` so the `packageManager` pnpm is used. Custom domain `app-staging.<domain>`
under the **same registrable domain** as the API (`SameSite=Strict` cookies; `*.vercel.app` and
`*.onrender.com` are public suffixes). Preview deployments cannot sign in and must never be added to `CORS_ORIGINS`.

### Turso: database

One database per environment (staging `workfolio`, aws-ap-south-1; production is a separate database,
DB-17), database-scoped tokens per environment, region close to the Render region. Never share env files
or tokens between environments. Run `verify:turso` before the API first connects, and confirm foreign
keys are enforced (see above).

State (read-only audit 2026-11-03, `docs/status/TURSO-DATABASE-READINESS-AUDIT.md`): staging is at
`0016`, **10 migrations pending** (`0017`, `0019`, `0021`–`0028`; `0018` and `0020` reserved, not
written), no Turso dump taken yet, no users (no Super Admin). A hosted API built from the current code
will refuse to start against it until the first migration is applied with the runbook in
docs/database-operations.md ("First staging migration runbook"), which needs approval (D3).

### Deploy pipeline (`.github/workflows/deploy-staging.yml`, never run)

On a push to `main`, after the CI workflow succeeds: one job in the GitHub environment **`staging`**
(configure required reviewers there, so a person approves every run) builds the API, checks that the
secret database URL's host equals the variable `STAGING_DATABASE_HOST` (wrong-database guard; fails if
unset or different), runs `pnpm --filter @workfolio/api db:migrate --dry-run`, then `db:migrate`, then
the read-only `verify:turso` (from an owner-only temp env file in `$RUNNER_TEMP`, deleted afterwards),
then calls the Render and Vercel deploy hooks. Migrate comes before deploy because a hosted API refuses
to boot while a migration is pending. Secrets by name only, on that environment:
`STAGING_DATABASE_URL`, `STAGING_DATABASE_AUTH_TOKEN`, `RENDER_DEPLOY_HOOK_URL`,
`VERCEL_DEPLOY_HOOK_URL`; non-secret variable `STAGING_DATABASE_HOST`. Take the `db:dump` (above)
before approving a run that carries a migration. The hooks build the branch head, not the exact
commit CI checked.

Missing before this workflow can run (none exist yet): a Git remote; the GitHub `staging` environment
with required reviewers, its secrets and the `STAGING_DATABASE_HOST` variable; the Render service and
its deploy hook; the Vercel project and its deploy hook; the Turso CLI for the account owner; the
recorded PITR window (DB-13) and rehearsal (DB-14).

### Monitoring (planned, DEP-11 / DEP-12)

- **Uptime and alerting:** an external monitor polls **`/api/v1/ready`** (database + storage; 503 when
  either fails) every 1–5 min and alerts by email/chat. Render's own health check uses `/api/v1/health`.
- **Errors and logs:** Render keeps service logs for a limited, plan-dependent time; forward them to a
  log service with alerting on `error`-level lines (pino JSON), and watch Vercel's function logs for
  the dashboard. Logs never contain secrets (docs/security.md "Secret-safe logging").
- **Deploys:** a failed boot (migration refusal, env validation) shows as a failed Render deploy.
  With a disk, Render stops the old instance first, so the API is down until a fix or a rollback
  (unverified); check every deploy result.
- None of this exists yet.

### Staging integration suite (DEP-13)

`apps/api/scripts/staging-suite.mjs`: 12 black-box checks over HTTP(S), no dependencies (Node `fetch`).
Run it from a trusted machine after each staging deploy; the criterion for DEP-13 is **12/12 PASS on staging**.

```bash
BASE_API_URL=https://api-staging.<domain> DASHBOARD_URL=https://app-staging.<domain> \
STAGING_ADMIN_EMAIL=… STAGING_ADMIN_PASSWORD=… STAGING_EMPLOYEE_EMAIL=… STAGING_EMPLOYEE_PASSWORD=… \
  pnpm --filter @workfolio/api staging:suite
```

- Checks: 1 health/ready, 2 API security headers, 3 HTTPS (HSTS on API and dashboard, `Secure` cookies,
  dashboard framing protection), 4 CORS for the dashboard origin + foreign-origin 403 (CSRF), 5 auth
  (cookie flags, wrong password, logout revokes), 6 RBAC/isolation, 7 attendance (device, clock in, break,
  clock out), 8 activity (notice consent, upload, summary), 9 screenshots (register, upload, sandboxed admin
  view), 10 timelapse (queued → READY → served → deleted; needs FFmpeg on the API host), 11 retention
  (dry-run previews only, admin-only), 12 login rate limit (429 for a never-existing address; a missing `Retry-After` is printed as a note).
- Accounts: an admin able to manage settings, employees, devices and screenshots, and a **dedicated synthetic
  employee** with no other active device (one active device per employee; the suite registers its own and
  revokes it at the end). Credentials come only from the environment and are never printed.
- Shared database: records are tagged with a run id (`suite-<timestamp>-<id>`). The suite deletes its
  screenshots and timelapse, clocks out, revokes its device, logs out both sessions, and restores the screenshot
  policy if it had to enable it (temporarily at a 60 s interval: the two frames are taken 31 s apart, so a run
  takes about 45 s). Append-only records stay: attendance sessions, one activity interval, consents, audit
  rows, DELETED screenshot rows. No retention purge is ever run.
- Rate limits: each run makes 11 failed logins for a throwaway address plus ~4 real logins; the per-IP login
  limit is 100 per 15 min, so do not loop the suite.
- Exit codes: 0 = 12/12, 1 = a check failed, 2 = configuration missing (nothing contacted), 3 = no failure
  but something skipped (e.g. check 3 on `http://`, check 10 without FFmpeg). Only exit 0 meets DEP-13.

## Desktop distribution

- **macOS:** an Apple Developer ID Application certificate and notarization credentials are needed
  so the app opens without Gatekeeper warnings. **Not available**; no build has been signed.
  Screen Recording permission is granted per signed app identity, so it must be granted again for
  the signed build. See "macOS signing and notarization" below.
- **Windows: implemented, not yet run on Windows.** Cross-compiled and linted on macOS
  (`x86_64-pc-windows-gnu`); tray, single instance, startup and installer config in
  docs/windows.md. Needs a Windows runtime pass, Credential Manager testing, and an Authenticode
  certificate or Azure Trusted Signing ("Windows signing and SmartScreen" below).
- Auto-update: not decided.

### Desktop API URL (build time)

The API URL is compiled into the desktop app; it is public configuration, not a secret, and no
secret is ever embedded in the app. Build a release bundle for a production API with:

```bash
WORKFOLIO_API_URL=https://api.example.com WORKFOLIO_DASHBOARD_URL=https://app.example.com \
  pnpm --filter @workfolio/desktop package   # extra args go to `tauri build`
WORKFOLIO_API_URL=https://api.example.com WORKFOLIO_DASHBOARD_URL=https://app.example.com \
  node apps/desktop/scripts/desktop-config.mjs --print   # dry run
```

- `WORKFOLIO_DASHBOARD_URL` (**required** for release builds, `https://`): the web dashboard URL shown
  to administrators. Only a placeholder API on the reserved `.invalid` TLD (CI test installer) may
  omit it; CI sets `https://app.example.invalid` explicitly anyway.
- `WORKFOLIO_ENV=staging|production` (unset = `production`, exactly `tauri.conf.json`).
  `staging` builds bundle id `com.insightworkfolio.desktop.staging`, product name
  "Insight Workfolio Staging", and a separate keychain / Credential Manager service (the bundle id), so a
  staging and a production install on one machine never share tokens, data directory or installation id.
  A staging build must go through `pnpm package` (the script applies the identity override); a bare
  `tauri build` produces the production identity.

`scripts/desktop-config.mjs` validates the URL, writes a temporary `tauri build --config` override
whose CSP `connect-src` is `'self' ipc: http://ipc.localhost <API origin>` (the dev
`http://localhost:4000` is replaced; nothing broader is added), and passes the normalized URL to
the front end as `VITE_API_URL`. `tauri.conf.json` itself is unchanged.

URL rules (`apps/desktop/src/api-url.ts`): `https://` with any host and an optional path (trailing
`/` removed); no user name/password, query or fragment. Plain `http://` only to `localhost`,
`127.0.0.1` or `[::1]`, and only in **development builds**: `tauri dev` / `vite` and
`tauri build --debug` (the Tauri CLI sets `TAURI_ENV_DEBUG=true`; debug bundles are the ones the
`verify:*-packaged` checks run against `http://localhost:4000`, and they also contain the test
hook, so they are never distributed). **Release builds are https only**: a release
`tauri build` refuses to build without a valid https `VITE_API_URL`, or when it was not started
through `pnpm package` (the CSP would not match). If a bundle is misconfigured anyway, the app
shows the error on the sign-in screen and never contacts any server. The API's `CORS_ORIGINS`
must include the desktop origins (see above).

### macOS bundle, signing and notarization

Bundle settings (`apps/desktop/src-tauri/tauri.conf.json` → `bundle.macOS`): minimum macOS
**14.0** (ScreenCaptureKit screenshot API), **hardened runtime** on, entitlements
`src-tauri/Entitlements.plist` (empty on purpose: no runtime exceptions, **no App Sandbox**, which
Developer ID distribution does not require and which would move the app's data into a container),
category Business. `LSUIElement` is **not** set: the Dock icon is an employee preference applied
at runtime (activation policy). No Info.plist usage-description key is added: the Screen
Recording prompt text is fixed by macOS (no app-supplied text), and Keychain needs none.
`signingIdentity` is `null`, so a build without credentials is unsigned (only the linker's
ad-hoc signature): fine for testing on the build Mac, blocked by Gatekeeper elsewhere.

Needed for a distributable build (none available yet):

1. Apple Developer Program membership (organization) and a **Developer ID Application**
   certificate with its private key in the build Mac's login keychain (or as a base64 `.p12`).
2. Notarization credentials: an **App Store Connect API key** (`.p8`, key ID, issuer ID;
   preferred) or an Apple ID with an app-specific password and the team ID.
3. Build with the Tauri CLI's variables (the script checks they are complete and never prints them):

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: <Company> (<TEAMID>)"
# CI only, certificate not in the keychain:  APPLE_CERTIFICATE=<base64 .p12>  APPLE_CERTIFICATE_PASSWORD=...
export APPLE_API_KEY=<key id> APPLE_API_ISSUER=<issuer uuid> APPLE_API_KEY_PATH=/secure/AuthKey_<id>.p8
#   or: APPLE_ID=<apple id> APPLE_PASSWORD=<app-specific password> APPLE_TEAM_ID=<TEAMID>
WORKFOLIO_API_URL=https://api.example.com pnpm --filter @workfolio/desktop package --bundles app,dmg
```

The Tauri CLI signs with the hardened runtime and entitlements, notarizes the `.app` and staples
it. Then notarize and staple the DMG too (one-time `xcrun notarytool store-credentials
workfolio-notary --key <p8> --key-id <id> --issuer <issuer>` creates a keychain profile):

```bash
DMG=apps/desktop/src-tauri/target/release/bundle/dmg/*.dmg
codesign --sign "$APPLE_SIGNING_IDENTITY" --timestamp $DMG
xcrun notarytool submit $DMG --keychain-profile workfolio-notary --wait
xcrun stapler staple $DMG
spctl -a -vv -t install $DMG          # "accepted, source=Notarized Developer ID"
spctl -a -vv apps/desktop/src-tauri/target/release/bundle/macos/Insight\ Workfolio.app
codesign -dv --verbose=4 apps/desktop/src-tauri/target/release/bundle/macos/Insight\ Workfolio.app   # flags=0x10000(runtime)
```

Universal binary (Apple silicon + Intel): `rustup target add x86_64-apple-darwin`, then add
`--target universal-apple-darwin` to the `package` command. The x86_64 target is not installed
on the current build Mac, so builds so far are Apple silicon only.

Launch at login uses `SMAppService.mainApp` (macOS 13+), which registers the signed `.app` itself;
it appears in System Settings > General > Login Items. An unsigned or moved copy may fail to
register or need approval there; the app shows the error.

### Windows signing and SmartScreen

Installer: NSIS, per user, no admin (`bundle.windows` in `tauri.conf.json`; details in
docs/windows.md "App shell"). Built on Windows (CI `windows-latest`), not on the Mac.
The CI job `windows-desktop` (.github/workflows/ci.yml) runs clippy and `cargo test` on Windows,
including the native smoke tests. It also builds an **unsigned NSIS test installer** against the
placeholder `https://api.example.invalid`, kept as a workflow artifact for 7 days. That installer
can't reach any server; use it to test installing, the tray and uninstalling, never to distribute.
For a real build, run `pnpm package` with the production URL (and signing) on a Windows machine.

**Unsigned (today).** `certificateThumbprint` is `null`, so the installer and exe are unsigned.
Microsoft Defender SmartScreen then shows "Windows protected your PC … unrecognized app" (*More
info › Run anyway*), and some company policies block unsigned installers outright. For testing only.

**Signing options** (`scripts/desktop-config.mjs` `windowsSigningPlan`; a half-configured set is
refused, and the override is merged into the build config):
1. **OV or EV Authenticode certificate** in the Windows certificate store of the build machine
   (since 2023 the private key must be on a hardware token / cloud HSM):
   `WINDOWS_CERTIFICATE_THUMBPRINT=<40-hex SHA-1>` and `WINDOWS_TIMESTAMP_URL=<CA timestamp server>`
   (e.g. `http://timestamp.digicert.com` for DigiCert; add `WINDOWS_TIMESTAMP_TSP=1` if the CA needs
   RFC 3161 TSP, e.g. SSL.com). Tauri runs `signtool` with SHA-256 on the exe and the installer. The
   timestamp is required so signatures stay valid after the certificate expires; `timestampUrl` in
   `tauri.conf.json` stays `""` until a certificate exists.
2. **Azure Trusted Signing** (Microsoft-managed certificate, no token):
   `AZURE_TRUSTED_SIGNING_ENDPOINT`, `_ACCOUNT`, `_PROFILE` and a service principal
   `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`; needs `trusted-signing-cli`
   (`cargo install trusted-signing-cli`) on the build machine. The secret is read from the
   environment, never written to the config. Requires an organization with 3+ years of verifiable
   history (or individual validation) in Azure.

**Reputation.** Since 2024 EV certificates no longer skip SmartScreen: OV, EV and Trusted Signing
all build reputation per certificate/publisher over downloads, so the first releases may still
warn. Keep one signing identity across releases, and for managed rollouts deploy through Intune /
company software distribution (no Mark-of-the-Web, no SmartScreen prompt). Verify a signed build
with `signtool verify /pa /v <file>` and the file's Properties › Digital Signatures tab.

**Status:** BLOCKED on a certificate or an Azure Trusted Signing account (not available).

## Before anything is deployed (approval needed)

1. Render and Vercel accounts and plans (one always-on Render instance with a disk), a domain, and a
   Git remote with the `staging` environment and its secrets.
2. Turso: staging database exists (at `0016`, 10 migrations pending, needs the approved first
   migration); a separate production database and scoped per-environment tokens (DB-16, DB-17).
3. Microsoft 365 tenant setup and a passing `verify:graph` (docs/onedrive.md).
4. HR/Legal: notice wording (including whether the screenshot notice should mention timelapse videos), retention periods, screenshot viewers, app exclusions.
5. Signing certificates.
6. Approval to deploy.
7. If timelapses are wanted: FFmpeg with libx264 on the API host, and acceptance of its licensing.
