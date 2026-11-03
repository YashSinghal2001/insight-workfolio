# Turso Database Implementation Report

- **Date:** 2026-11-03
- **Baseline:** `docs/status/TURSO-DATABASE-READINESS-AUDIT.md`
- **Status:** Phases A–H and J are complete. The user approved the migration in Phase F. The user deferred Phase I (Super Admin), which leaves the API's write path untested (see section 7).

Status legend: **VERIFIED** · **IMPLEMENTED BUT UNVERIFIED** · **MISSING** · **BLOCKED** · **REQUIRES APPROVAL**

---

## 1. How the work was split

| Agent | Scope | Files it owned |
|---|---|---|
| Lead | Orchestration, the shared `migrationStatus()` contract, `admin:create` fix, URL hardening, backup and restore, all Turso access, reports | `packages/database/src/{migrations,index}.ts` (contract only), `apps/api/src/cli/create-admin.ts`, `apps/api/src/config/env.ts` (URL rule), `docs/status/TURSO-*.md` |
| 1: Migrations | Review of all 26 migrations, `migrationStatus` tests, verifier gap-fill fix | `packages/database/src/migration-status.test.ts`, `apps/api/scripts/verify-turso.mjs`, `apps/api/test/verify-turso-script.test.ts` |
| 2: Security and ops | Credentials, redaction, dump script, PITR and token plan | `apps/api/scripts/db-dump.mjs` |
| 3: API integration | Hosted startup policy, migrate CLI, env, lifecycle | `apps/api/src/database/*`, `apps/api/src/cli/migrate.ts`, `apps/api/test/database-startup.e2e.test.ts`, `apps/api/test/env.test.ts` |
| 4: Testing | Full suites, live local API boot, CLI checks | one test appended to `database-startup.e2e.test.ts` |
| 5: Docs and deploy | Operations docs, deployment docs, workflow, render.yaml, trackers | `docs/database-operations.md`, `docs/deployment.md`, `.github/workflows/deploy-staging.yml`, `render.yaml`, `apps/api/.env.example`, three status trackers |

No two agents edited the same file. The lead made the cross-cutting follow-ups after each owning agent had finished.

**Only the lead contacted Turso, and only with read-only operations:** `verify-turso`, the dump, `db:migrate --dry-run`, and the hosted startup check.

---

## 2. What changed

### Migration policy (audit risk S8 / Q3): VERIFIED
- **`apps/api/src/database/prepare.ts` (new):**
  - `isHostedDatabaseUrl(url)`: hosted means any URL other than `file:` or `:memory:`.
  - `prepareDatabase(db, hosted)`.
  - **Hosted:** it calls only the read-only `migrationStatus()` and **never `migrate()`**. It refuses to start on pending, unknown or edited migrations, with a non-secret message that names the ids and points to `db:migrate`.
  - **Local:** it still migrates at boot, as before.
  - **Both:** it refuses to start if foreign keys are off.
- **`database.module.ts`:** uses `prepareDatabase`, closes the client when startup fails, and redacts the token from the error.
- **`cli/create-admin.ts`:** used to call `migrate()` unconditionally, which was a second hidden migration path. It now goes through `prepareDatabase` too.
- **`cli/migrate.ts`:** this is the only command that applies migrations to hosted databases.
  - `--dry-run` now uses `migrationStatus()`.
  - Both modes print `Target: <host>` first, never the token.
- **Live check against staging (read-only):** hosted startup refused with "Hosted database has 10 pending migration(s) (0017_…, …)". Nothing was written; `verify-turso` afterwards still showed 16 applied.

### Database package
- **`migrationStatus(db)`** returns `{applied, pending, unknown, edited}` using SELECTs only. It never creates the bookkeeping table and never stamps checksums. Agent 1 fixed one bug: an old `schema_migrations` table with no `checksum` column made it throw.
- **The 10 pending migrations were rehearsed on 0016 data** (users, sessions, leave, screenshots, timelapses):
  - Defaults and backfills are correct: leave requests get the `General` type, the new flags are 0, and `idle_excluded_apps` is `[]`.
  - The 0019 and 0021 trigger replacements behave correctly.
  - Counts are 51 tables, 65 indexes and 91 triggers.
  - No compatibility problems were found.

### Verifier
- `verify-turso.mjs` now treats a pending id below the latest applied id (gap-fill, for 0018 and 0020 if they are written later) as **WARN, exit 0**. Unknown and edited migrations still FAIL.
- The old `slice(0, done.size)` logic, which miscounted when unknown ids were present, is removed.

### Dump script (`db-dump.mjs`), from Agent 2
- **Fixed a real bug:** without `--out`, a positional URL was silently ignored and `DATABASE_URL` was dumped instead.
- **New `--db-env <file>`:** the URL and token come only from that file, never from `process.env`.
- **Before contacting anything:** it accepts only `libsql://`, `https://` or an existing `file:` URL, and refuses query strings and credentials in the URL.
- **Errors:** connection errors are now redacted, using the JWT and `authToken=` patterns.
- **Output:**
  - The file is written only after every read succeeds.
  - An output directory inside the repo is refused, and a loose existing directory gets a warning.
  - It refuses schemas it cannot dump faithfully (AUTOINCREMENT, virtual or WITHOUT ROWID tables; this schema has none).

### URL hardening (lead, from Agent 2's F5 and F6)
- **`env.ts`, in every environment:** a remote `DATABASE_URL` must have no credentials or query string, and plaintext `http://` is allowed only to a loopback address. This stops a token from riding inside the URL or travelling in clear.
- **`deploy-staging.yml`:** the wrong-database guard also refuses non-`libsql`/`https` schemes and URLs containing `?` or `@`.

### Docs and deploy (Agent 5, plus lead edits)
- **`docs/database-operations.md`:**
  - local vs hosted policy table
  - gap-fill section updated (0021–0028; 0020 likely needs a table rebuild and its own approval)
  - first staging migration runbook
  - staging vs production separation
  - secret handling
  - `db:dump --db-env` usage
- **`docs/deployment.md`:** aligned with the hosted policy. It also fixes a stale claim that `wss://` is allowed.
- **`deploy-staging.yml`:**
  - wrong-database guard, which checks the host against the non-secret `vars.STAGING_DATABASE_HOST`
  - read-only `verify:turso` step after migrating, using a temporary env file with mode 600
  - environment approval kept
  - migrate still runs before the deploy hooks
- **`render.yaml`, `.env.example`:** comments match the policy.
- **Trackers (BLOCKED, REMAINING, MASTER-PENDING, EXECUTION-SUMMARY, PARTIAL-REPORT):** "0021–0026" corrected to "0021–0028", and the "a staging API would apply them at boot" claims updated. **No status was changed to DONE.**

---

## 3. Tests (final code, run by the lead after every change)

| Suite | Result |
|---|---|
| `pnpm --filter @workfolio/database test` | **48 / 48 pass**, 0 fail |
| `pnpm --filter @workfolio/shared test` (Agent 4) | **69 / 69 pass** |
| `pnpm --filter @workfolio/api test` (nest build + node --test) | **403 / 403 pass**, 73 suites, 0 fail, 0 skipped |
| `pnpm -r typecheck` (Agent 4) and `pnpm --filter @workfolio/api typecheck` (lead) | clean |
| `pnpm --filter @workfolio/api lint`, `pnpm --filter @workfolio/database lint` | clean |

New coverage:
- **`migrationStatus`:** no writes; 0016 → exactly 10 pending; unknown, edited and NULL checksums; pre-checksum table; 0016+data → 0028 at 51/65/91; re-run applies nothing.
- **Hosted startup:**
  - With pending migrations or on an empty database: refuses, and the file is byte-identical afterwards.
  - Fully migrated: starts without writing.
  - Unknown or edited migrations: refuses.
  - Foreign keys off: refuses.
  - Unreachable database: the token is never shown.
  - Both CLIs against an unreachable host: exit non-zero, and the token is never shown.
- **Verifier:**
  - Gap: WARN, exit 0.
  - Unknown or edited migrations: exit 1.
  - Missing file: exit 2, and no file is created.
  - The token is never printed.
- **Env:**
  - Production refuses an unset `DATABASE_URL`, `file:` and `:memory:`.
  - Every environment refuses credentials or a query string in the URL, and non-loopback `http://`.
- **Live local boot (Agent 4, scratch file database):** migrations are applied and the log shows schema version 0028. `/health` returned 200 and `/ready` returned 200. SIGTERM shut down cleanly (exit 143, port released).

**Working tree:** 308 → 312 entries, the 4 new being `prepare.ts` and three test files. All pre-existing changes are preserved. `apps/api/data/dev.db` SHA-256 is `fbee612e…92f80` before and after. The `dist` directories were rebuilt by the build and test commands; the originals are backed up in the session scratchpad.

---

## 4. Backup and restore: VERIFIED (logical dump)

| Item | Result |
|---|---|
| Dump | `~/insight-workfolio-backups/workfolio-2026-11-03T06-40-01-494Z.sql` |
| Taken | 2026-11-03 06:40:01 UTC, read-only, one read transaction |
| Contents | 40 tables, 19 rows, `schema_migrations` 0001–0016 |
| Permissions | file `-rw-------`, directory `drwx------`, outside the repo, on a FileVault disk |
| SHA-256 | `98fe30eb50e076a9dcd2d763ece56427acec6e196ea210fe3ed4ba9c35907bb1` |
| Restore | Into a scratch SQLite file (never into Turso) |
| Restored copy vs Turso | `verify-turso` passed: 16 applied, 10 pending, 39 tables / 53 indexes / 73 triggers identical to the reference, `integrity_check`, `quick_check` and `foreign_key_check` clean. Row counts match (16 migrations, 3 notices with the same versions). |
| Full rehearsal on a copy of the restore | `migrate()` applied exactly the 10 ids; a re-run applied none; `verify-turso`: 26 applied, 0 pending, 51 / 65 / 91 identical to the reference, all checks clean |
| Turso plan and PITR window | **BLOCKED.** The `turso` CLI is not installed and the account hasn't been checked (DB-13, DB-14) |

---

## 5. Phase F: migration approval gate (approved by the user on 2026-11-03)

| Item | Value |
|---|---|
| Database | `workfolio` at `workfolio-yashsinghal.aws-ap-south-1.turso.io` (Mumbai), re-verified today |
| Applied | 0001–0016 (16 rows, checksums match) |
| Pending | 0017, 0019, 0021, 0022, 0023, 0024, 0025, 0026, 0027, 0028 (10) |
| Dry run | `Target: workfolio-yashsinghal…turso.io (dry run)`, `Applied: 16; pending: 10`, "Dry run: nothing was written." |
| Backup | Above, restore-verified |
| Schema changes | +12 tables, +12 indexes, +18 triggers, 8 added columns |
| Data writes | 0021 inserts 1 seed row (`leave_types` 'General') and updates `leave_requests` (0 rows on remote) |
| Risky operations | 0019 and 0021 each `DROP` and re-`CREATE` one trigger inside the same atomic batch. Nothing drops a table or column. |
| Expected result | 26 applied, 0 pending, 51 tables / 65 indexes / 91 triggers, integrity and FK checks clean |
| Rollback | Forward-only. Each migration is atomic, so a failure rolls back that migration only. For full recovery, restore the dump above into a **new** Turso database and repoint. `workfolio` is never overwritten. |
| Command | `cd apps/api && node --env-file=.env.staging dist/cli/migrate.js` |

## 6. Phases G–J: results

### G. Migration: VERIFIED
- **Dry run immediately before:** `Applied: 16; pending: 10`, no UNKNOWN or EDITED lines.
- **Apply** (`node --env-file=.env.staging dist/cli/migrate.js`):
  - It printed `APPLIED` for exactly 0017, 0019, 0021, 0022, 0023, 0024, 0025, 0026, 0027 and 0028.
  - "Foreign keys enforced.", "Schema version 0028_auto_timelapse".
  - 0018 and 0020 were not created.

### H. Post-migration verification: VERIFIED
- **`verify-turso` (read-only):** every check passes.
  - Connectivity: 560 ms.
  - `foreign_keys = 1` on every read and inside a transaction.
  - **Applied 26, pending 0, latest 0028_auto_timelapse.**
  - **51 tables, 65 indexes, 91 triggers, 0 views, identical to the reference.**
  - `integrity_check`, `quick_check` and `foreign_key_check` are clean.
- **Checksums:** none unstamped and none mismatched (the edited check passes).
- **Second `db:migrate`:** "No pending migrations." (DB-07, idempotent).
- **Data after migrating:** `leave_types` = [General, unpaid] (the 0021 seed), `users` 0, `monitoring_notices` 3, `schema_migrations` 26.
- **Hosted startup check:** `prepareDatabase(hosted)` now returns `0028_auto_timelapse`.

### I. Super Admin: DEFERRED by the user
`users` is empty. When approved, run from `apps/api` in your own terminal, not through the assistant, because the one-time link is a credential:

```
node --env-file=<staging env> dist/cli/create-admin.js --email <you> --super-admin
```

The link points at `DASHBOARD_URL`. The staging env file does not set it, so it defaults to `http://localhost:3000`: run the dashboard locally against this API to open it. Open the printed link to set the password. The command refuses if any migration is pending, and it refuses a second admin unless `--additional` is passed.

### J. API connected to Turso staging (local boot, `NODE_ENV=development`, local screenshot storage): VERIFIED for the read path

| Check | Result |
|---|---|
| Startup | Logs "Schema version 0028_auto_timelapse" with **no "Applied migrations" line** (hosted mode, verify only), then "Nest application successfully started" |
| `GET /api/v1/health` | 200 `{"status":"ok"}` |
| `GET /api/v1/ready` | 200, database `up` (134 ms), storage `up` (LOCAL_DEV) |
| Protected route without auth | `GET /api/v1/employees` → 401 |
| Login against Turso | Without `Origin`: 403 "Request origin not allowed" (CSRF guard, working as designed). With `Origin: http://localhost:3000` and an unknown user: 401 "Invalid email or password" (it read from Turso) |
| Shutdown | SIGTERM: the process exited and port 4566 was released, on both runs |
| Secrets in logs | 0 JWT-shaped strings in either API log |
| Side effects | Row counts for every table, taken before and after both boots, are identical (`leave_types` 1, `monitoring_notices` 3, `schema_migrations` 26) |
| Write round-trip through the API | **Not done.** Every write endpoint needs an authenticated admin, and admin creation was deferred. Atomic `batch` writes against Turso were exercised by `db:migrate` itself (10 atomic batches) |

## 7. Remaining items

| Item | Status | Needs |
|---|---|---|
| Super Admin on staging (DEP-09), then admin login and an authenticated write/read round-trip through the API | REQUIRES APPROVAL | Your go-ahead and email; you run `admin:create` yourself |
| Turso plan and PITR window (DB-13); PITR rehearsal into a new database (DB-14) | BLOCKED | Turso account / CLI (not installed here) |
| Read-only verification token; scoped deploy token with expiry; rotate the current rw no-expiry token; move `.env.staging` out of the repo (S2–S4, DB-16) | REQUIRES APPROVAL | Turso account and your decision |
| Guard/unique error mapping exercised on Turso (DB-08 remainder) | IMPLEMENTED BUT UNVERIFIED | An admin account (write endpoints) |
| Git remote, GitHub `staging` environment, secrets and `vars.STAGING_DATABASE_HOST`, Render service, deploy hooks | BLOCKED | External resources (approval) |
| Workflow hardening: RO token for dry-run and verify, SHA-pinned actions, `?ref=` on the Render hook, dump confirmation before approval (Agent 2's F10, F12, F13) | REQUIRES APPROVAL | Low risk; the workflow has never run |
| Separate production Turso database (DB-17) | BLOCKED | Pilot sign-off |
| Optional: no per-query timeout on remote calls (a hung Turso call blocks a request or startup) | Known gap | Design decision |
| Reserved migrations 0018 and 0020 | BLOCKED | Storage decision (D1). 0020 likely needs a table rebuild and its own approval |
