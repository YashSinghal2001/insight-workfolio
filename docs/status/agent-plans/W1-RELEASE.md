# W1-RELEASE plan — build version visibility, desktop update telemetry, still-clocked-in banner

Branch `agent/w1-release`. Contracts: `docs/IMPLEMENTATION-CONTRACTS.md` (ownership row W1-RELEASE).

## 1. Version on /health + deploy record

- `apps/api/src/health/health.controller.ts`: `GET /api/v1/health` adds `version` (read once from
  `apps/api/package.json`) and `commit` (`process.env.WORKFOLIO_BUILD_COMMIT`, only if `/^[0-9a-f]{7,40}$/`, else
  `null`; read per request). `HealthResponse` in `packages/shared/src/api.ts` gets both fields (additive).
- `deploy/scripts/deploy.sh` writes `<release>/release.env` (`WORKFOLIO_BUILD_COMMIT=<sha>`) next to the existing
  `RELEASE_SHA`, and appends one line per deploy / rollback to `$WORKFOLIO_ROOT/deploys.log`
  (time, action, commit, ref, migrate flag, operator).
- `deploy/systemd/workfolio-api.service`: `EnvironmentFile=-/opt/workfolio/current/release.env` after `api.env`
  (optional `-`: releases built before this change simply report `commit: null`). Takes effect after the owner
  re-runs `install-vps.sh` (installs units + daemon-reload). No /etc env file is edited by any script.
- Dashboard `/account`: a "Server" row "API v0.1.0 (abc1234)" from `/health`; loading / error text, never blanks.
- Docs: `docs/deployment.md` "Which commit is deployed".

## 2. Desktop update telemetry — root cause

Trace: desktop `updates-ui.ts` → `POST /desktop-updates/status` (`updates:report`) → `desktop_update_status` →
`GET /desktop-updates/devices` → `/desktop-updates` page (`installedVersion`, `state`).

API, DB and page are consistent (covered by `desktop-updates.e2e.test.ts`). The break is in the app: the **only**
caller of the report is the updater flow (`checkNow` → `send`), and `checkNow`/`start` return immediately when
`updatesEnabled` is false. `updatesEnabled` is true only for builds made with `WORKFOLIO_UPDATER_PUBKEY`; every
installed build (0.1.0/0.2.0 predate the feature, 0.2.1 release notes: "In-app updates: Off in this build") has
it false, so no installation has ever reported → every device "Installed: unknown / Not reported".

Fix (desktop, root): version reporting no longer depends on the updater. A build without the updater asks the
public manifest endpoint itself (`GET /desktop-updates/manifest/{darwin|windows}/{arch}/{version}`, same as the
plugin) on sign-in and reports `installedVersion` with `UP_TO_DATE` (204) or `AVAILABLE` + `availableVersion`
(newer version offered). No schema change (state CHECK unchanged). Rust `app_info` adds `arch`
(`std::env::consts::ARCH`). Also covers the start-up race (`enter()` before `app_info` resolved). Existing
installs start reporting only after they install a build with this fix (cannot be fixed remotely).

## 3. Desktop "still clocked in" banner

Pure `staleClockInSince(projection, timeZone, now)` in `apps/desktop/src/sync.ts`: open session and
(`missingClockOut()` from shared, employee zone) or open > 14 h → clock-in instant, else null. `main.ts`
renders `#att-stale` (notice) "You are still clocked in since <local date/time>. Clock out, then request a
correction of the real end time." Flag only: no auto clock-out/correction.

## 4. Verification

Desktop typecheck, eslint, `node --test`; `cargo clippy -D warnings`, `cargo test` (shared target dir, disk
check first); Windows `cargo check` only if a Windows target is already installed, else "CI-only".

## Tests

- `apps/api/test/health.e2e.test.ts`: version = package version; commit valid (7 and 40 hex), missing → null,
  invalid (uppercase, too short, injection text, 41 chars) → null; no other new fields.
- `apps/api/test/desktop-updates.e2e.test.ts`: regression — a non-updater build's report (`UP_TO_DATE`, then
  `AVAILABLE`) shows on `/desktop-updates/devices` with its installed version; unregistered installation → 403.
- `apps/desktop/test/updates.test.ts`: `manifestPath`, `manualStatus` (204, newer, same/older, garbage),
  regression: `reportNow`/`start` report when the updater is off (source check).
- `apps/desktop/test/stale-clock-in.test.ts`: IST, America/New_York, DST day (2026-03-08 / 2026-11-01), 14 h
  boundary, closed session, clocked-out projection, unsynced clock-in.

## Acceptance

`/health` shows version + commit on a release deployed with the new script; `/account` shows it; a new desktop
build without the updater appears with its version on `/desktop-updates`; banner shown exactly under the rule;
all gates green (known time-of-day failures listed only).
