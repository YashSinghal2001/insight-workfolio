# Insight Workfolio: Execution Summary (2026-11-02)

The 139 unresolved tasks from the audit's master checklist were executed in three waves of sub-agents (wave 1 by the earlier session `1c1c7812`, which ended mid-wave; waves 2–3 by this session). Every claimed completion was re-verified on the final tree. Nothing was committed, pushed, deployed or migrated outside local temp databases, and no external account was touched.

Companion reports in this folder:
- `INSIGHT-WORKFOLIO-MASTER-PENDING-TASKS.md`: all 202 rows with previous and new status.
- `INSIGHT-WORKFOLIO-COMPLETED-TASKS.md`
- `INSIGHT-WORKFOLIO-BLOCKED-TASKS.md`
- `INSIGHT-WORKFOLIO-REMAINING-TASKS.md`

## 1. Initial unresolved task count

**139** (15 PARTIAL, 59 PENDING, 31 BLOCKED, 34 NEEDS VERIFICATION), reconciled row by row from the 202-row checklist. The 63 baseline rows (51 DONE, 12 DEFERRED) are kept separate and were not re-opened.

## Final count (139-task cohort)

| Status | Task count |
|---|---:|
| Newly DONE | 13 |
| PARTIAL | 24 |
| BLOCKED | 62 |
| NEEDS VERIFICATION | 40 |
| PENDING | 0 |
| DEFERRED | 0 |
| **Total original tasks processed** | **139** |

- **DONE from the 139:** 13 (9.4 %).
- **Unresolved:** 126.
- **Unique unresolved work:** 120, counting the six audit overlaps once (W34/ST-02, F12/API-09, W48/Windows, W49/MAC-17, W53/DEP-07, W46/MAC-09).
- **Why PENDING fell to 0:** every PENDING row was either worked on (now DONE, PARTIAL or NEEDS VERIFICATION) or traced to a named decision or account it cannot proceed without (now BLOCKED). The 59 PENDING rows split into 9 DONE, 11 PARTIAL, 31 BLOCKED and 8 NEEDS VERIFICATION. Of the other rows: 15 PARTIAL → 2 DONE, 12 PARTIAL, 1 NV; 31 BLOCKED → 30 BLOCKED, 1 NV (ST-04); 34 NV → 2 DONE, 30 NV, 1 PARTIAL (API-13), 1 BLOCKED (DB-07).

## 2. Newly completed tasks (13)

AW-05, EW-05, API-06, API-07, API-08, DEP-05, SEC-08, SEC-11, W18, W35, W36, W38, W40. Details and evidence: `INSIGHT-WORKFOLIO-COMPLETED-TASKS.md`.

## 3. Previously completed tasks that were verified

The 51 baseline DONE rows were not re-opened one by one. Their automated evidence was re-run as part of the full suite on the final tree, and all of it passes (section 9). DB-01's evidence is stronger: `migration-order.test.ts` adds 5 gap-fill, unknown-id and checksum tests.

## 4. Tasks still unresolved (126)

Listed by area and priority, with what remains for each: `INSIGHT-WORKFOLIO-REMAINING-TASKS.md`.

## 5. Blocked tasks (62) and reasons

| Blocker | Tasks |
|---|---:|
| D4 Hosting accounts + domain (Render, Vercel, DNS, monitoring) | 17 |
| D1 Storage provider decision | 15 |
| D2 Commit + private GitHub remote | 5 |
| D8 Code signing (Apple, Windows) | 4 |
| D11 Product scope (auto clock-in, idle break, Linux, Android) | 4 |
| D3 Turso staging migration approval | 3 |
| Turso account details (plan, PITR, production DB) | 3 |
| D6 Setup-link policy | 3 |
| D7 HR/Legal | 3 |
| D5 Email provider | 2 |
| D9 Windows hardware | 1 |
| D10 Devices per employee | 1 |
| Your manual Microsoft action (Graph Explorer consent) | 1 |

## 6. Partially completed (24)

AW-04, AW-06, API-13, DB-15, ST-08, ST-12, MAC-17, EXT-03, DEP-10, DEP-13, CI-06, W17, F04, W24, F05, F06, W30, F08, F01, F09, W39, W41, W43, W49.

## 7. Needing verification (40)

| Group | Tasks | Needs |
|---|---|---|
| macOS runtime | MAC-03…MAC-12, MAC-16, MAC-19, F02, W46 | You at the Mac (~2 h checklist). MAC-11/12 need one Keychain "Always Allow". |
| Windows runtime | WIN-03…WIN-15, WIN-20, WIN-21, W48 | Windows hardware or the CI job |
| Other | EXT-02, W21, W22 | Real browser / desktop |
| Other | DB-08 | Read-only Turso check |
| Other | ST-04 | Tenant re-check |
| Other | ST-13 | Real Google account |
| Other | DEP-03 | Render blueprint |
| Other | CI-03, CI-07 | First GitHub run |
| Other | W53 | Production TLS |

## 8. Deferred

None from the cohort. The 12 baseline DEFERRED rows are unchanged.

## 9. Tests executed and results (final tree)

| Suite | Result | Audit baseline |
|---|---|---|
| `@workfolio/shared` | 67 / 67 | 60 |
| `@workfolio/database` | 37 / 37 | 22 |
| `@workfolio/api` e2e | 367 / 367 | 343 |
| Desktop TS (`node --test`) | 66 / 66 | 61 |
| Desktop Rust `cargo test` (macOS) | 94 passed, 1 ignored | 91 + 1 |
| Browser extension | 7 / 7 | 6 |
| Dashboard `zoned-time` | 2 / 2 | — |
| Dashboard smoke (`next build` + routes) | PASS, 35 routes | 32 |

**Total automated:** 640 passed, 0 failed (was 583).

| Browser / runtime check | Result | Where |
|---|---|---|
| `verify-wave2.mjs` | 55 / 55 | Headless Chrome, `next dev` and production `next start` |
| `verify-setup-password.mjs` | 14 / 14 dev, 14 / 14 production | Headless Chrome |
| `verify-gallery.mjs` | 18 / 18 | Headless Chrome |
| `staging-suite.mjs` | 11 pass, 1 skip (https-only), 0 fail | Local API (not staging) |
| Universal macOS `.app` | Launched under Rosetta (x86_64 translated) | This Mac |
| Flaky 12,000-interval test | 3 / 3 after the keep-alive fix | — |

**Not run:**
- macOS packaged / native checklists (need you at the Mac).
- Windows runtime (no hardware).
- Turso, Google, Microsoft, Render, Vercel, GitHub Actions (no external contact allowed).

## 10. Build, typecheck and lint

- `pnpm build:packages`: OK.
- `pnpm -r typecheck` and `pnpm -r lint` (eslint and `cargo clippy -D warnings`): clean.
- `cargo clippy --all-targets --target x86_64-pc-windows-gnu -D warnings`: clean.
- The commands of the CI `checks` and `desktop-rust` jobs were all run locally on the final tree and are green.

## 11. Security findings

- **Secrets:** 0 real secrets. The scan's 226 hits are all field names, env references, fixture passwords and placeholders. No Microsoft tenant, site or drive identifiers remain in the repo (the reports holding them are in your Trash).
- **`pnpm audit`:** 0 critical/high. There are 3 moderate and 2 low advisories, all in dev tooling (`fast-uri` via `@nestjs/cli`, `minimatch` via eslint), unchanged from the audit.
- **API-08 behaviour change:** a revoked device's own session is now revoked, so its requests get 401 (it was 403). The desktop shows "session ended", then REVOKED after the next sign-in. This needs a desktop runtime check.
- **Boot-time migrations:** source now holds 0017, 0019 and 0021–0028 that Turso staging (at 0016) does not have. Since 2026-11-03 a hosted API no longer migrates at boot: it refuses to start while any are pending (docs/database-operations.md). Apply them deliberately under D3 with `db:migrate`. Migration numbers 0021–0028 were assigned during execution, and 0018/0020 stay reserved.
- **Team heads:** team-head access is opt-in per route (`@TeamScoped`) and limited to four read permissions. Writes stay role-only. Side effect: a team head can read, but not act on, their team's correction requests (documented in `docs/teams.md`).
- **Finding, not fixed:** the login, setup and refresh limiters return 429 without `Retry-After` (the API-wide limiter does set it). Low impact.
- **Unknown author of the `setup-password/page.tsx` change:** the change is verified correct in dev and production, but its author is still unidentified.

## 12. Files modified

133 source files changed or were created since the audit, across waves 1–3. They are listed below. Root reports were moved to `~/.Trash/workfolio-md/` by your separate cleanup session, not by this execution.

`git status` at the end: 116 modified, 179 untracked entries (directories collapsed). At the start of this session it was 111 modified and 195 untracked; untracked fell because of that cleanup.

- **CI and deployment:** `.github/workflows/ci.yml`, `.github/workflows/deploy-staging.yml`, `.node-version`, `render.yaml`
- **API:**
  - Scripts and package: `apps/api/package.json`, `scripts/db-dump.mjs`, `scripts/staging-suite.mjs`
  - Activity: `src/activity/activity.controller.ts`, `src/activity/activity.service.ts`
  - Alerts: `src/alerts/alerts.controller.ts`, `src/alerts/alerts.service.ts`
  - App: `src/app.module.ts`, `src/app.setup.ts`
  - Attendance: `src/attendance/attendance.controller.ts`, `src/attendance/attendance.service.ts`
  - Auth: `src/auth/auth.guard.ts`, `src/auth/auth.service.ts`
  - Common: `src/common/scope.ts`
  - Devices: `src/devices/devices.service.ts`
  - Employees: `src/employees/employees.controller.ts`, `src/employees/employees.service.ts`
  - Health: `src/health/health.controller.ts`
  - Holidays: `src/holidays/holidays.controller.ts`, `src/holidays/holidays.service.ts`
  - Leave: `src/leave/leave.controller.ts`, `src/leave/leave.service.ts`
  - Schedule: `src/schedule/schedule.service.ts`
  - Screenshots: `src/screenshots/screenshots.controller.ts`, `src/screenshots/screenshots.service.ts`, `src/screenshots/timelapse.controller.ts`, `src/screenshots/timelapse.service.ts`
  - Settings: `src/settings/employee-tracking.controller.ts`, `src/settings/monitoring-settings.service.ts`
  - Teams: `src/teams/teams.controller.ts`, `src/teams/teams.service.ts`
  - Tests in `test/`:
    - activity: `activity-policy`, `activity`
    - alerts: `alerts`
    - attendance: `attendance`
    - devices: `device-sessions`, `devices-audit`
    - health: `health`
    - holidays and leave: `holidays`, `leave-balances`
    - per-person settings and schedule: `person-overrides`, `schedule`
    - screenshots: `screenshots-gallery`, `screenshots`
    - security: `security-hardening`
    - teams: `teams`
- **Browser extension:** `apps/browser-extension/{manifest.json, package.json, popup.js, tracker.js, tracker.test.mjs, scripts/make-icons.py, scripts/package.mjs, icons/icon{16,32,48,128}.png}`
- **Dashboard:**
  - Config: `apps/dashboard/{.gitignore, next.config.ts, package.json}`
  - Scripts: `scripts/{smoke.mjs, verify-setup-password.mjs, verify-wave2.mjs}`
  - Admin pages: `src/app/(admin)/{activity, alerts, attendance, employees/[id], holidays, screenshots, teams}/page.tsx`
  - Admin leave: `src/app/(admin)/leave/{page, leave-types, leave-balances}.tsx`
  - Admin settings: `src/app/(admin)/settings/{page, schedule/page}.tsx`
  - Employee pages: `src/app/my/{activity, leave}/page.tsx`
  - Components: `src/components/{breaks-overlay, sidebar, tracking-overrides}.tsx`
  - Lib: `src/lib/zoned-time.{ts,test.mjs}`
- **Desktop:**
  - Scripts and config: `apps/desktop/{scripts/desktop-config.mjs, vite.config.ts}`
  - Front end: `src/{activity-ui, main, notify, screenshot-ui}.ts`
  - Tests: `test/{desktop-config, notify}.test.ts`
  - Tauri: `src-tauri/{Cargo.toml, Cargo.lock, capabilities/default.json}`
  - Rust: `src-tauri/src/{activity, collector, lib, prefs}.rs`, `src-tauri/src/win/{activity, mod, webview2}.rs`
- **Docs:** `docs/{alerts, database-operations, deployment, onedrive, security, teams, website-usage, windows}.md`
- **Database:**
  - Migrations: `packages/database/src/migrations.ts` (0021–0026)
  - Tests: `packages/database/src/{alerts, leave-holidays, migration-order, person-overrides, session-device, teams}.test.ts`
- **Shared:** `packages/shared/src/{activity, alerts, api, holidays, index, leave, roles, schedule, screenshots, teams}.ts` and the tests `{leave, leave-balances, schedule, teams}.test.ts`

New local migrations:

| Id | Purpose |
|---|---|
| 0021 | Leave types |
| 0022 | Holidays |
| 0023 | Session ↔ device |
| 0024 | Teams |
| 0025 | Per-person overrides |
| 0026 | Alert rules |

They were applied only to temporary test databases. `apps/api/data/dev.db` was never written.

## 13. Remaining external dependencies

D1 storage provider, D2 commit and remote, D3 Turso migrations, D4 Render, Vercel and domain, D5 email provider, D6 setup-link policy, D7 HR/Legal, D8 signing, D9 Windows hardware, D10 devices per employee, D11 product scope, Turso account details, and your manual Microsoft step. Exact unblock actions are in `INSIGHT-WORKFOLIO-BLOCKED-TASKS.md`.

## 14. Recommended next actions

1. **D2:** approve committing in reviewed chunks and create the private remote. The first push runs CI, including Windows (CI-03, WIN-18, WIN-03).
2. **You at the Mac (~2 h):** run the macOS checklist. Click "Always Allow" once for the packaged suites (MAC-03…12, MAC-16, MAC-19, F02, W46, W21/W22 on macOS).
3. **D1 storage decision.** It unblocks 15 rows.
4. **D3:** approve Turso staging migrations (dump first, then 0017–0026 except the reserved 0018/0020).
5. **D4 hosting.** Then run `pnpm --filter @workfolio/api staging:suite` against staging (DEP-13).
6. **D6 setup-link policy and D7 HR/Legal.** Both are prerequisites for a real-employee pilot.
7. **Product follow-ups that need no decision:**
   - Team-head dashboard UI and the remaining team scopes (W41).
   - Expected-start window on the timeline (W24).
   - Per-team labels (F05).
   - Per-person self-view switch (F08).
   - Per-person workdays in leave counting (W17).
   - `Retry-After` on auth 429s.
