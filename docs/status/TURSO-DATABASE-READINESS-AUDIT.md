# Turso Database Readiness Audit (Phase 1, read-only)

- **Date:** 2026-11-03
- **Scope:** `packages/database`, `apps/api` database integration, `apps/api/.env.staging`, Turso database `workfolio` (staging)
- **Mode:** Read-only. Nothing was written to Turso. No migration was run (not even `db:migrate --dry-run`). No repository file was changed except this report. No secret value appears here.

> **Update 2026-11-03 (implementation, see `TURSO-DATABASE-IMPLEMENTATION-REPORT.md`):** re-verified the same day: Turso is still at 0016 with 10 pending. Since then:
> - **Fixed:** inconsistencies 1–3 and risk S8. Hosted API startup and `admin:create` no longer migrate; they refuse to start while migrations are pending. `verify-turso` now WARNs on gap-fill.
> - **Section 7, backup:** now **VERIFIED**. A dump was taken and restore-verified (`~/insight-workfolio-backups/workfolio-2026-11-03T06-40-01-494Z.sql`).
> - **`db:dump`:** now accepts `--db-env <file>`.
> - **Migration:** after user approval, Turso staging was migrated 0016 → 0028 the same day and verified: 26 applied, 0 pending, 51/65/91, all checks clean.
> - **Still open:** S2–S4 (token location, scope and rotation) and the PITR window.

Status legend: **VERIFIED** · **IMPLEMENTED BUT UNVERIFIED** · **MISSING** · **BLOCKED** · **REQUIRES APPROVAL**

---

## 1. Executive summary

| Area | Status | One-line finding |
|---|---|---|
| Turso connectivity | VERIFIED | `SELECT 1` succeeded in 403 ms against `workfolio-yashsinghal.aws-ap-south-1.turso.io` |
| Region / identity | VERIFIED | The hostname is database `workfolio`, org `yashsinghal`, region `aws-ap-south-1` (Mumbai) |
| Remote schema health | VERIFIED | 39 app tables, 53 indexes, 73 triggers, 0 views. Identical to a reference migrated to 0016. `integrity_check`, `quick_check` and `foreign_key_check` are clean |
| Remote migration state | VERIFIED | **Applied 0001–0016** (16 rows, all checksums stamped and matching). **Pending: 10 migrations** (0017, 0019, 0021–0028) |
| Remote data | VERIFIED | **Schema populated, data empty.** The only rows are the 3 `monitoring_notices` that migrations seed (and 16 `schema_migrations` rows). There are no users, so no Super Admin exists yet |
| Foreign keys | VERIFIED | `foreign_keys = 1` on 10 separate reads and inside a read transaction |
| Pending migrations apply cleanly | VERIFIED (local rehearsal) | On an in-memory copy of the 0016 schema, all 10 applied in 11 ms. A re-run applied 0. The integrity and FK checks were clean |
| Backup | MISSING | No Turso dump exists yet (`~/insight-workfolio-backups` does not exist). The tooling exists and was rehearsed locally |
| Turso plan / PITR window | BLOCKED | Needs the Turso account or CLI. The `turso` CLI is not installed on this machine |
| Applying migrations | REQUIRES APPROVAL | Decision D3 / tasks DB-09 and DB-10 |
| Biggest risk | — | **Any API boot pointed at Turso applies all 10 pending migrations automatically** (`DatabaseModule` calls `migrate()`). An unreviewed staging boot *is* the first migration |

Bottom line: the staging database is correctly provisioned, reachable, healthy, in the intended region, and safe to migrate. It is waiting only on a backup and an explicit migration approval. Because it holds no business data, the risk of this first migration is low, but the process (dump, approve, migrate, verify) should still be followed so it is proven before real data exists.

---

## 2. Remote database identity and connection status

| Check | Result | Status |
|---|---|---|
| URL scheme | `libsql://` (HTTP transport on Node; `wss://` is deliberately refused) | VERIFIED |
| Host | `workfolio-yashsinghal.aws-ap-south-1.turso.io` | VERIFIED |
| Database name | `workfolio` | VERIFIED (from hostname) |
| Region | `aws-ap-south-1` = Mumbai | VERIFIED (from hostname); group/plan not checked (needs the CLI) |
| URL hygiene | No path, no query string, no embedded credentials | VERIFIED |
| Connectivity | `SELECT 1` OK, 403 ms | VERIFIED |
| SQLite version (server) | 3.47.0 (local `@libsql/client` engine: 3.45.1) | VERIFIED |
| Journal / encoding | WAL / UTF-8 | VERIFIED |
| Size | 168 pages × 4096 B ≈ 0.7 MB | VERIFIED |
| `user_version` | 0 (unused; the app tracks versions in `schema_migrations`) | VERIFIED |
| Foreign keys | ON on every read and inside a transaction | VERIFIED |
| Auth token | Present (348 chars), EdDSA JWT. Claims are `a: rw` (**read-write**), with an `id` claim (appears database-scoped). **No `exp` (never expires).** Issued 2026-11-01 | VERIFIED (claim names only) |
| Server version function | `libsql_server_version()` is not available | n/a |

**Method:** I first ran the repo's own read-only verifier, `node apps/api/scripts/verify-turso.mjs apps/api/.env.staging`, after reviewing its source (SELECTs and read-only PRAGMAs only). Then I ran a scratch script in a single **read transaction** that does SELECTs and pragma table-valued functions only. That script reads row counts, `schema_migrations` and the presence of columns and objects.

---

## 3. Actual remote schema and migration state

### 3.1 `schema_migrations` (remote)

| id | applied_at (UTC) | checksum |
|---|---|---|
| 0001_auth_and_employees … 0016_data_layer_integrity (16 rows) | 2026-11-01 08:57:28.827 → 08:57:30.789 | all stamped; all match this build |

There are no unknown ids and no edited (checksum mismatch) migrations. Applied ids form a contiguous prefix of the code's list.

### 3.2 Objects

- 39 app tables plus `schema_migrations` (40 total), 53 app indexes plus SQLite autoindexes, 73 triggers, 0 views.
- No provider-internal objects (`libsql_*`, `_litestream*`, `_cf_*`) were found.
- The schema object names are **identical** to an in-memory reference migrated to 0001–0016. There are no extra or missing objects.

### 3.3 Absence check for everything 0017+ creates (confirms nothing was half-applied)

All absent on remote:
- **Tables:** `work_schedule_policies`, `application_category_rules`, `activity_category_audit`, `screenshot_blur_overrides`, `leave_types`, `holidays`, `teams`, `team_members`, `employee_tracking_overrides`, `alert_rules`, `alerts`, `team_application_category_rules`
- **Indexes:** `attendance_sessions_clock_in`, `sessions_device`
- **Trigger:** `leave_requests_default_type`
- **Columns:** `screenshot_policies.blur`, `screenshots.blurred`, `leave_requests.leave_type_id`, `sessions.device_id`, `monitoring_policies.idle_excluded_apps`, `screenshot_policies.auto_timelapse`, `timelapses.automatic`

Present, as 0015 expects: `sessions.client` and `sessions.refreshed_at`. The `screenshots_immutable` and `leave_requests_decide_once` triggers are still in their pre-0019 and pre-0021 form.

### 3.4 Data

| Table | Rows |
|---|---|
| `schema_migrations` | 16 |
| `monitoring_notices` | 3 (draft notices seeded by migrations 0005, 0006, 0013) |
| every other table (38) | 0 |

**The remote schema is populated (at 0016), but it holds no business data.**

### 3.5 Local dev DB, for contrast

`apps/api/data/dev.db` is at **0001–0017 + 0019** (18 ids). It is behind the code (0021–0028 missing) and ahead of Turso. Each environment is at a different version. That is expected, but note it.

---

## 4. Repository database architecture

| Component | Location | Status | Notes |
|---|---|---|---|
| Client factory | `packages/database/src/index.ts` `createDatabase()` | VERIFIED | `@libsql/client` 0.18.0 (pinned). It requires a token for non-`file:` URLs. For `file:` URLs it creates the directory and sets a 5 s busy timeout. The token is dropped for local URLs |
| Ping / FK helpers | `pingDatabase()`, `foreignKeysEnforced()` | VERIFIED | Used by readiness and boot |
| Error mapping | `isUniqueViolation()`, `guardViolation()` | IMPLEMENTED BUT UNVERIFIED (not exercised in this audit) | They map trigger `RAISE(ABORT, …)` names to typed errors |
| Schema definition | `packages/database/src/migrations.ts` (`MIGRATIONS`, 26 entries) | VERIFIED | Raw SQL, `STRICT` tables, append-only triggers, no ORM |
| Migration runner | `migrate()` in the same file | VERIFIED (by code read and local rehearsal) | Checks that ids are ascending, refuses unknown ids and checksum mismatches, and stamps NULL checksums. Each migration runs as one `batch(..., "write")` together with its bookkeeping row, so it is atomic. It tolerates a concurrent runner |
| Tracking table | `schema_migrations(id, applied_at, checksum)` STRICT | VERIFIED on remote | |
| Build output | `packages/database/dist` | VERIFIED | It contains all 26 ids, matching `src` |
| Migrate CLI | `apps/api/src/cli/migrate.ts` (`db:migrate [--dry-run]`) | IMPLEMENTED BUT UNVERIFIED against Turso (deliberately not run) | `--dry-run` only reads |
| Read-only verifier | `apps/api/scripts/verify-turso.mjs` | VERIFIED (run in this audit) | It reads the env file only, never `process.env` |
| Dump script | `apps/api/scripts/db-dump.mjs` | IMPLEMENTED BUT UNVERIFIED on Turso | Rehearsed on a local copy on 2026-11-02 (`docs/database-operations.md`) |
| Env loading (API) | `ConfigModule.forRoot({ validate: validateEnv })`, which reads `apps/api/.env` if present | VERIFIED | `.env` does not exist, so the API defaults to `file:./data/dev.db`. `.env.staging` is **never auto-loaded** |
| Env validation | `apps/api/src/config/env.ts` | VERIFIED | In production, `DATABASE_URL` must be `libsql://` or `https://`, and local SQLite is refused |

### Inconsistencies found

1. **Boot-time migration vs. approval gate.** `DatabaseModule` runs `migrate()` on every start. The deploy workflow and docs assume migrations are applied by an approved `db:migrate` step *before* the API deploy. That only holds if nobody boots the API against Turso first. A local `NODE_ENV=development` run with the staging URL exported would migrate staging immediately.
2. **`migrate()` is not read-only even when nothing is pending.** It runs `CREATE TABLE IF NOT EXISTS schema_migrations`, may run `ALTER TABLE … ADD COLUMN checksum`, and stamps NULL checksums. On remote, all of these are currently no-ops, but it is still a write-capable call.
3. **`verify-turso.mjs` gap check vs. the gap-fill design.** The verifier fails when an applied set is not a prefix of the code's list (`gaps`). Once 0018 or 0020 is written, a Turso DB migrated to 0028 will report `FAIL … missing before later ones: 0018` until `migrate()` gap-fills it. That is a false alarm by design. The verifier should treat lower pending ids as a warning, not a failure.
4. **The comment says "additive only", but 0019 and 0021 use `DROP TRIGGER`.** Each drop is immediately followed by a stricter re-creation in the same atomic batch. No data is destroyed, but these migrations are not strictly additive.
5. **Stale task notes.** `INSIGHT-WORKFOLIO-BLOCKED-TASKS.md` DB-10 mentions pending "0021–0026". The code now goes up to **0028**.
6. **Engine version skew.** Turso runs SQLite 3.47.0 and the local/test client runs 3.45.1. None of the pending SQL uses post-3.45 features, so this is low risk.

---

## 5. Migration-by-migration impact assessment

All 10 are **pending on remote** (confirmed by sections 3.1 and 3.3). There are no conflicts with the remote schema: every object they create is absent, and every object they alter or drop exists in the expected form. Rehearsal: on an in-memory DB at exactly the 0016 schema, they applied in 11 ms, a second run applied 0, `integrity_check` was ok and `foreign_key_check` was empty.

"Safe to rerun" means: the runner skips ids already recorded, and each migration's statements plus its bookkeeping row commit atomically. A failed migration leaves nothing behind, so a retry is clean. The raw statements themselves are **not** idempotent (plain `CREATE TABLE` and `ALTER`). They are only safe through `migrate()`.

| Migration | Creates | Alters | Indexes / constraints | FK implications | Destructive? | Data change | Depends on | Remote conflict |
|---|---|---|---|---|---|---|---|---|
| **0017_work_schedule_and_app_categories** | `work_schedule_policies`, `application_category_rules`, `activity_category_audit` | — | `attendance_sessions_clock_in`; partial unique index `application_category_rules_current`; append-only and immutable triggers; CHECKs on time, workdays and category | → `users` (RESTRICT); audit → rules | No | None | 0001 (users), 0002 (attendance_sessions) | None |
| **0018** | *reserved, not written* (timelapse storage, DB-11) | | | | | | Must not depend on or alter 0019 objects (gap-fill rule) | n/a |
| **0019_screenshot_blur_policy** | `screenshot_blur_overrides` | `screenshot_policies` + `blur INTEGER NOT NULL DEFAULT 0`; `screenshots` + `blurred INTEGER NOT NULL DEFAULT 0`; **DROP + re-CREATE trigger `screenshots_immutable`** (adds `blurred` to the protected columns) | 2 indexes, append-only triggers | → `employee_profiles`, `users` | Trigger replaced only; no data loss | Existing rows get 0 (remote: 0 rows) | 0006 and 0009 (`screenshots`, `mask_count`, previous trigger) | None; the trigger exists in its 0009 form |
| **0020** | *reserved, not written* (widen `screenshots.storage_provider` CHECK for Google Drive, DB-12; only if D1 picks Drive) | | | | Likely a **table rebuild** (SQLite cannot alter a CHECK); needs its own approval | | | n/a |
| **0021_leave_types** | `leave_types` (+ seed row `General`, unpaid) | `leave_requests` + `leave_type_id` FK; **DROP + re-CREATE `leave_requests_decide_once`**; new AFTER INSERT trigger `leave_requests_default_type` | `leave_requests_type` index; NOCASE unique name | → `leave_types` RESTRICT; `leave_types.created_by` → users | Trigger replaced only | **INSERT** 1 seed row; **UPDATE** all `leave_requests` (remote: 0 rows) | 0010 (`leave_requests`, previous trigger) | None |
| **0022_holidays** | `holidays` | — | UNIQUE `date`, date CHECK | → `users` | No | None | 0001 | None |
| **0023_session_device** | — | `sessions` + `device_id` FK (nullable, no default, which the FK requires) | Partial index `sessions_device` | → `devices` RESTRICT; devices are already undeletable (0016) | No | None | 0001, 0002, 0015 | None |
| **0024_teams** | `teams`, `team_members` | — | `teams_head`, `team_members_employee`; no-delete and immutable triggers | → `users`, `employee_profiles`, `teams` | No | None | 0001 | None |
| **0025_person_overrides** | `employee_tracking_overrides` | `monitoring_policies` + `idle_excluded_apps TEXT NOT NULL DEFAULT '[]'` with JSON CHECK | index + append-only triggers | → `employee_profiles`, `users` | No | Existing policy rows get `'[]'` (remote: 0) | 0004/0005 (`monitoring_policies`), 0001 | None |
| **0026_alert_rules** | `alert_rules`, `alerts` | — | Kind-specific CHECKs; UNIQUE(rule, employee, date); acknowledge-once trigger | → `users`, `employee_profiles`, `alert_rules` | No | None | 0001 | None |
| **0027_team_labels_self_view** | `team_application_category_rules` | `employee_tracking_overrides` + `screenshot_self_view` | Partial unique index; immutable and no-delete triggers | → `teams`, `users` | No | None | **0024, 0025** | None |
| **0028_auto_timelapse** | — | `screenshot_policies` + `auto_timelapse`; `timelapses` + `automatic` (both NOT NULL DEFAULT 0) | CHECK (0, 1) | — | No | Defaults on existing rows (remote: 0) | 0006, 0008, (0019 is the same table) | None |

**Ordering:** a straight run applies 0017 → 0019 → 0021 → … → 0028. Intra-set dependencies: 0027 needs 0024 and 0025. 0021 replaces 0010's trigger. 0019 replaces 0009's trigger.

**Gap-fill:** if 0018 or 0020 is written *after* Turso reaches 0028, it applies out of order on the next boot. `migration-order.test.ts` covers this pattern. 0020 as described (CHECK widening) will almost certainly need a `screenshots` table rebuild. That is destructive by nature, interacts with the `screenshots_immutable` trigger that 0019 rebuilds, and needs separate design and approval.

---

## 6. Application-to-Turso integration status

Path: **Next.js dashboard → (HTTPS `NEXT_PUBLIC_API_URL`) → NestJS API → `@workfolio/database` → Turso**

| Concern | Finding | Status |
|---|---|---|
| Dashboard isolation | The dashboard and desktop never import `@workfolio/database` or `libsql`, and read no `DATABASE_*` variables. The package is marked server-only. The dashboard knows only `NEXT_PUBLIC_API_URL` | VERIFIED (grep) |
| Connection init | A single client is created in the `DATABASE` provider factory (global module) at boot | VERIFIED (code) |
| Authentication | Bearer token via `authToken`. It is required for remote URLs (throws otherwise) and dropped for `file:` URLs | VERIFIED (code + live connect) |
| Boot sequence | `createDatabase` → **`migrate()`** → FK check (refuses to start if FK is off) → logs the schema version | VERIFIED (code); **never booted against Turso** |
| Query execution | `db.execute` with parameterized `args` throughout the services | IMPLEMENTED BUT UNVERIFIED on Turso |
| Transactions | No interactive `transaction()` in services. Multi-statement writes use `db.batch(..., "write")` (81 call sites across 20 files), which is atomic on libSQL. Integrity is enforced by triggers and constraints in the database, not by app-level locks | VERIFIED (code); IMPLEMENTED BUT UNVERIFIED on Turso |
| Client lifecycle / pooling | One HTTP client per process, closed in `onApplicationShutdown`. No pool tuning is needed for remote (stateless HTTP). Local files get a 5 s busy timeout | VERIFIED (code) |
| Request timeouts | There is no per-query timeout for remote calls. Only `/ready` wraps its ping in a 2 s race | Gap (low) |
| Error handling | A boot failure is fatal (a failed, edited or unknown migration, or FK off). `/ready` hides error details from clients and logs them server-side. The migrate CLI redacts the token from errors | VERIFIED (code) |
| Health endpoints | `/api/v1/health` (liveness, no DB) and `/api/v1/ready` (DB ping and storage stat, 503 on failure) | IMPLEMENTED BUT UNVERIFIED on Turso |
| Local vs remote separation | The API reads only `apps/api/.env` (absent), defaulting to `file:./data/dev.db`. Staging values live only in `.env.staging`, which nothing loads automatically. Production refuses a `file:` URL | VERIFIED |
| Deploy wiring | `render.yaml` (not deployed): `DATABASE_URL` and `DATABASE_AUTH_TOKEN` use `sync:false`, single instance, migrations at boot. `deploy-staging.yml` runs dry-run → migrate → Render hook, behind the `staging` environment approval. **No git remote, Render service or GitHub secrets exist yet** | BLOCKED |
| End-to-end through the API | Not exercised. Starting the API against Turso was out of scope and would migrate it | BLOCKED (by design for this phase) |

---

## 7. Backup and recovery readiness

| Item | Finding | Status |
|---|---|---|
| Existing backup of Turso | None. `~/insight-workfolio-backups` does not exist, and no dump is recorded in the docs | MISSING |
| Can a backup be generated pre-migration? | Yes. `db:dump` takes a consistent single-read-transaction logical dump (schema, all rows, `schema_migrations`), mode 600, outside the repo. It needs `DATABASE_URL` and `DATABASE_AUTH_TOKEN` exported in the shell (it does not take an env-file argument) | IMPLEMENTED BUT UNVERIFIED on Turso (rehearsed locally 2026-11-02) |
| Restoration | Always into a **new** database: `sqlite3 new.db < dump.sql`, or `turso db create <new> --from-dump dump.sql`. Triggers are created last so guards don't fire on restore | IMPLEMENTED BUT UNVERIFIED on Turso |
| Integrity verification | `verify-turso.mjs <env-file>` against the restored DB (integrity, FK, schema vs. reference, migration ids). Compare row counts against the dump output | IMPLEMENTED (tool VERIFIED today on the live DB) |
| Turso PITR | Plan and window not recorded (DB-13). Rehearsal not done (DB-14). Needs the Turso CLI or dashboard | BLOCKED |
| Per-migration rollback | **There are no down migrations (forward-only by design).** A rollback is a restore into a new database plus repointing `DATABASE_URL`. The previous build cannot run against a migrated DB, because it refuses unknown ids. Hand-written inverse SQL is not advisable: `ALTER TABLE DROP COLUMN` fails for FK or indexed columns (`leave_type_id`, `device_id`), and 0019 and 0021 replaced triggers | Rollback strategy = restore |
| Practical rollback today | The remote holds only seed rows, so the cheapest fallback for this first migration is restoring the pre-migration dump into a new database, or recreating the database and replaying 0001–0016. The real risk is low now, but the dump → restore → verify loop should be proven before real data arrives | REQUIRES APPROVAL (to take the first Turso dump) |

---

## 8. Security observations

| # | Observation | Severity | Status |
|---|---|---|---|
| S1 | `.env.staging` is git-ignored (`.gitignore:10 .env.*`), mode `-rw-------` (0600), owned by the user. Only `.env.example` files are tracked | — | VERIFIED |
| S2 | `.env.staging` contains only `DATABASE_URL` and `DATABASE_AUTH_TOKEN` (436 B). It sits **inside the repo working tree**, while `docs/database-operations.md` advises keeping DB env files outside the repo. It is ignored, but an `rsync`, `zip`, or `git add -f` would include it | Low | Recommend moving it outside the repo |
| S3 | The token is **read-write with no expiry**. Every read-only audit uses a write-capable credential | Medium | Recommend: a `--read-only` token for audits and verification, a short `--expiration` for CI, and storing the rw token only in Render and GitHub `staging` secrets (DB-16) |
| S4 | The token issued 2026-11-01 has lived on a laptop disk since then. Rotate it once Render and GitHub secrets exist | Low | REQUIRES APPROVAL |
| S5 | The scripts redact the token (exact match and a JWT regex) from output, and the env validator never prints values. This audit printed only claim *names* and the hostname | — | VERIFIED |
| S6 | Production config refuses a `file:` URL and `wss://`, and requires `JWT_SECRET` | — | VERIFIED (code) |
| S7 | `db:dump` output contains personal data. It is written 0600 to a 0700 directory outside the repo | — | VERIFIED (code) |
| S8 | **Boot-time `migrate()`** means anyone with the rw token and the API code can change the staging schema by running the server. The approval gate is procedural, not technical | Medium | See plan step 1 |

---

## 9. Blockers and unresolved questions

| # | Item | Type | Owner |
|---|---|---|---|
| B1 | Approval to apply 0017, 0019 and 0021–0028 to Turso staging (D3 / DB-09 / DB-10) | REQUIRES APPROVAL | Owner |
| B2 | Approval to take the first Turso dump (it contains personal data, though today only seed rows) | REQUIRES APPROVAL | Owner |
| B3 | Turso plan, PITR window and group not recorded. The `turso` CLI is not installed here (DB-13, DB-14) | BLOCKED | Account owner |
| B4 | No git remote, Render service or GitHub `staging` environment and secrets, so the CI migration path cannot run (DEP-01, DB-16) | BLOCKED | Owner |
| B5 | No Super Admin on Turso (`users` is empty). `admin:create` must run after migration (DEP-09) | Sequenced after B1 | Owner |
| Q1 | Should the first Turso migration go through `db:migrate` from this machine (fastest) or wait for the CI path (the designed gate)? | Decision | Owner |
| Q2 | Should 0018 and 0020 be written *before* migrating Turso? Then they apply in order instead of by gap-fill. Doing so blocks the migration on the storage decision D1; not waiting is safe (gap-fill is tested) | Decision | Owner |
| Q3 | Should boot-time `migrate()` stay as is, or should hosted environments get a "verify only, refuse if pending" mode? | Decision | Owner |
| Q4 | Is `workfolio` staging only, with a separate production DB (DB-17), or will it become production? | Decision | Owner |
| Q5 | Should the token be rotated to a read-only one for audits plus a scoped rw one for deploys? | Decision | Owner |

---

## 10. Recommended step-by-step implementation plan

Nothing below has been done. Each step that writes is marked.

**Phase 2: prepare (no writes to Turso)**
1. *(code, optional, REQUIRES APPROVAL)* Decide Q3. Minimum safe option: an env flag such as `DATABASE_MIGRATE_ON_BOOT=false` for hosted environments, so the API refuses to start if migrations are pending instead of applying them. Until then, **do not start the API with the staging URL**.
2. *(code, small)* Make `verify-turso.mjs` report lower pending ids (gap-fill candidates) as WARN, not FAIL (inconsistency 3). Update the stale DB-10 note (0021–0026 → 0021–0028).
3. Run `pnpm --filter @workfolio/database test` and `pnpm --filter @workfolio/api test` on the current tree. They were not run in this audit because they rebuild `dist`.
4. *(account owner)* Install the Turso CLI. Record plan, group, location and PITR window in `docs/database-operations.md` (DB-13).
5. *(account owner, optional now)* Create a `--read-only` token for verification, and move `.env.staging` outside the repo (S2, S3).

**Phase 3: migrate staging (REQUIRES APPROVAL B1 and B2)**

6. **Baseline:** `node apps/api/scripts/verify-turso.mjs <env-file>`. Expect: applied 16, pending 10, all checks pass.
7. **Backup:** export the two variables in the shell from the env file (do not echo them), then run `pnpm --filter @workfolio/api db:dump`. Record the file name, table and row counts, and `schema_migrations` ids (expect 0001–0016, 19 rows).
8. **Verify the backup:** `sqlite3 /tmp-scratch/restored.db < dump.sql`, then `verify-turso` against `file:` that copy. Expect 16 applied and the checks passing.
9. **Dry run:** `pnpm --filter @workfolio/api build && (cd apps/api && node --env-file=<env-file> dist/cli/migrate.js --dry-run)`. Expect "Applied: 16; pending: 10" with no UNKNOWN or EDITED lines.
10. **Apply** *(the first write)*: the same command without `--dry-run`. Expect `APPLIED` lines for the 10 ids, "Foreign keys enforced." and "Schema version 0028_auto_timelapse".
11. **Post-verify:** `verify-turso` should show 26 applied, 0 pending, 51 tables / 65 indexes / 91 triggers matching the reference, and clean integrity and FK checks. Re-running `db:migrate` should print "No pending migrations." (DB-07).
12. **Rollback trigger:** if step 10 fails, the failing migration rolled back atomically. Fix forward with a new migration. If the schema is unusable, restore the step 7 dump into a **new** database and repoint. Never overwrite `workfolio`.

**Phase 4: complete integration**

13. Create the first Super Admin: `admin:create` from a trusted machine against Turso (DEP-09).
14. Boot the API locally against staging once, with the staging env and non-production storage. Confirm the "Schema version 0028" log, `/api/v1/ready` → database `up`, then a login and one write and read round-trip from the dashboard.
15. Provision Render (`render.yaml`) and the GitHub `staging` environment with required reviewers and secrets (`STAGING_DATABASE_URL`, `STAGING_DATABASE_AUTH_TOKEN`, deploy hooks). The rw token lives only there (DB-16). Rotate the laptop token (S4).
16. Run the PITR rehearsal into a new database (DB-14) and record the result.
17. Thereafter, every migration-bearing deploy goes: dump → CI dry-run → approval → migrate → deploy hook → `verify-turso`.

---

## Answers

**A. Is Turso actually connected to the intended Workfolio environment?**
Yes, for staging. `.env.staging` points to `workfolio-yashsinghal.aws-ap-south-1.turso.io` (database `workfolio`, Mumbai). The connection, the token and foreign keys were VERIFIED live. Nothing has connected the *application* (API) to it yet: `apps/api/.env` does not exist and no Render service exists.

**B. Is the remote schema empty or populated?**
The schema is populated (0001–0016: 39 tables, 53 indexes, 73 triggers, healthy). The data is empty: only the 3 seeded monitoring notices and the 16 migration rows. No users.

**C. Which migrations are genuinely pending?**
Exactly 10: `0017_work_schedule_and_app_categories`, `0019_screenshot_blur_policy`, `0021_leave_types`, `0022_holidays`, `0023_session_device`, `0024_teams`, `0025_person_overrides`, `0026_alert_rules`, `0027_team_labels_self_view`, `0028_auto_timelapse`. 0018 and 0020 are reserved and not written. None of the 10 is partially applied, and all applied cleanly on a local copy of the remote schema.

**D. Can the application safely use this database?**
Technically yes: the schema is healthy, FK is enforced, and the pending migrations apply cleanly. It is not yet safe *operationally*. The current build would silently apply 10 unreviewed migrations on first boot, there is no backup, and there is no admin user. Clear B1 and B2 and follow steps 6–13 first.

**E. What must happen before the first migration?**
(1) Explicit approval (D3). (2) A Turso dump taken and restore-verified (steps 7–8). (3) A `verify-turso` baseline and a `db:migrate --dry-run` matching "16 applied / 10 pending". (4) Nobody starts the API against staging before then. Recommended: package and API tests green on the current tree, plus the PITR window recorded.

**F. What exact steps will complete the database integration?**
Section 10, steps 6 → 17: baseline verify, dump and verify dump, dry run, apply, post-verify and idempotency re-run, create the Super Admin, a one-time local API smoke test against staging (`/ready`, login, a write), Render plus GitHub `staging` secrets with token rotation, a PITR rehearsal, then the standard dump → approve → migrate → deploy → verify loop for every future migration.

---

### Commands run in this audit (all read-only)

- `git status`, `ls`, `stat`, `git check-ignore`, `grep`, `sed`: inspection only
- Env inspection that printed key names, value lengths, URL host and JWT claim *names* only
- `node apps/api/scripts/verify-turso.mjs apps/api/.env.staging` (repo verifier; SELECTs and read-only PRAGMAs)
- A scratch script in one remote **read** transaction: version and pragma reads, `schema_migrations`, `count(*)` per table, existence checks in `sqlite_master` / `pragma_table_info`
- A local in-memory rehearsal of 0017–0028 (`:memory:`; no file and no remote touched)
- `sqlite3 -readonly apps/api/data/dev.db` to read the local migration ids

Not run, deliberately: `db:migrate` (including `--dry-run`), `db:dump`, the API server, the package test suites (they rebuild `dist`), and any `turso` CLI command (not installed).
