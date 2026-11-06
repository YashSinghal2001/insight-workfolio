# Database operations

How the SQLite/libSQL schema is migrated, backed up, verified and restored. Code lives in
`packages/database/src/migrations.ts`; the production scripts in `deploy/scripts/` (reference:
`deploy/README.md`), the developer/Turso scripts in `apps/api/scripts/`.

**Selected architecture (2026-11-05): one persistent SQLite file on the Hostinger VPS**,
`DATABASE_URL=file:/var/lib/workfolio/db/workfolio.db`, WAL mode, owned by the `workfolio` service user,
backed up nightly with an encrypted copy in the company OneDrive. Turso (hosted libSQL) remains supported
by the code and documented below as the **previous plan**, kept for reference; no production Turso database
exists or is planned.

## Production on the VPS: local SQLite file (selected)

| Topic | How it works | Where |
|---|---|---|
| Location | `file:/var/lib/workfolio/db/workfolio.db` (absolute path, outside the releases, 0700 directory, 0600 file). Production refuses a relative `file:`, `:memory:` and `wss://` | `apps/api/src/config/env.ts` |
| Journal mode | WAL, set **only** by `db:migrate` (every run) and `restore-db.sh`. The production API never changes it; it warns at boot if the file is not in WAL | `packages/database/src/index.ts` `enableWal`, `apps/api/src/cli/migrate.ts` |
| Migrations at boot | `NODE_ENV=production` ⇒ **verify-only** (same as a hosted URL): read-only `migrationStatus()`, refuse to start on pending, unknown or edited ids, foreign keys must be enforced; the file's hash is unchanged by a boot. Development (`NODE_ENV` ≠ production, `file:`) still migrates at boot | `apps/api/src/database/prepare.ts`, `apps/api/test/database-startup.e2e.test.ts` |
| Applying migrations | `deploy.sh <ref> --migrate` (backup → `db:migrate` with the new build → activate → restart) or `deploy.sh --migrate-only` after a restore. Direct form: `cd /opt/workfolio/current/apps/api && node --env-file=/etc/workfolio/api.env dist/cli/migrate.js [--dry-run]` as `workfolio` | `deploy/scripts/deploy.sh` |
| Backups | `backup-db.sh` nightly (02:30 UTC): sqlite3 online backup API → `integrity_check` → gzip → gpg (AES-256) → `/var/backups/workfolio/workfolio-<ts>.db.gz.gpg` (0600, 30 days) → off-site upload. **Never `cp` the live file** (its newest pages may be in `-wal`) | `deploy/scripts/backup-db.sh`, `deploy/README.md` "Backups" |
| Off-site copy | Encrypted file only, into the OneDrive folder `InsightWorkfolio/db-backups` through the API's own connection (`dist/cli/backup-upload.js`); the uploader refuses unencrypted files; off-site deletion only with `ONEDRIVE_BACKUP_KEEP_DAYS` | `apps/api/src/cli/backup-upload.ts` |
| Integrity | every backup copy (`PRAGMA integrity_check` must be `ok`), every restore (before and after installing the file), every rehearsal (`verify-backup.sh`) | `deploy/scripts/lib.sh` `integrity_check` |
| Restore | `restore-db.sh <file> [--yes]` as root: verify copy → stop API → move `.db` + `-wal` + `-shm` aside together → install 0600 → `journal_mode=WAL` → `integrity_check` → `db:migrate --dry-run` (PENDING ⇒ exit 3, API left stopped, run `deploy.sh --migrate-only`) → start → health check. Exact sequence in `deploy/README.md` "Restore" | `deploy/scripts/restore-db.sh` |
| Rehearsal | `verify-backup.sh [file]` on a temporary copy: decrypt, unpack, integrity, row counts, migration dry-run; monthly on the newest local file, quarterly on a copy fetched back from OneDrive | `deploy/scripts/verify-backup.sh`, `deploy/README.md` "Restore rehearsal" |
| Monitoring | `monitor.sh` every 5 min: backup younger than 30 h, last backup run succeeded, disk, readiness | `deploy/scripts/monitor.sh` |
| Dump (SQL text) | `pnpm --filter @workfolio/api db:dump file:/var/lib/workfolio/db/workfolio.db --out <dir>` still works for an inspectable SQL dump; the nightly `.db.gz.gpg` is the restore format | `apps/api/scripts/db-dump.mjs` |

Rules that did not change: forward-only, additive migrations with checksums (below); a schema rollback is a
data restore; one API process.

## Migrations: local vs hosted vs production file (forward-only)

Which path applies is decided by `DATABASE_URL` **and** `NODE_ENV`:

| `DATABASE_URL` / `NODE_ENV` | At API boot | How migrations are applied |
|---|---|---|
| Local `file:` or `:memory:`, `NODE_ENV` ≠ `production` (development, tests) | Applies pending migrations (`migrate()`), WAL on for a file | Automatically at boot, or `pnpm --filter @workfolio/api db:migrate` |
| Absolute `file:`, `NODE_ENV=production` (**the VPS**) | **Never migrates.** Read-only `migrationStatus()`; refuses to start on pending, unknown or edited ids; warns if not WAL | `deploy.sh --migrate` / `--migrate-only`, i.e. `db:migrate` after a backup |
| Hosted: `libsql://` or `https://` (Turso, previous plan) | **Never migrates.** Same read-only check and refusal | Only the explicit `db:migrate` command, dry-run first |

Consequences: deploy order is **backup → migrate → deploy**. A build that carries a new migration fails to
boot until `db:migrate` has run against that database, so starting the API can never change the production
schema by accident.

Rules shared by both paths (`packages/database/src/migrations.ts`):

- Each migration is applied in one transaction together with its `schema_migrations` row (id + SHA-256
  of its statements). It either commits fully or not at all.
- `db:migrate` and the local boot path are **refused** (non-zero exit) when:
  - the code's ids are not unique and ascending;
  - the database lists an id this build does not know (it was migrated by a newer build);
  - an applied migration's statements were edited afterwards (checksum mismatch);
  - a migration fails (the error names it).
- **Forward-only.** Never edit, reorder or delete a migration that has been applied anywhere. To fix
  something, add a new migration. There are no down migrations. A schema rollback is a data restore
  (below), and the previous build can only be redeployed if it knows every applied id.
- Migrations are additive (no destructive DROP / ALTER) unless that is explicitly approved. Note:
  `0019` and `0021` each drop a trigger and recreate a stricter one in the same atomic batch; no data
  is removed, but they are not strictly additive.

## Gap-fill rule (0018 and 0020)

`migrate()` applies every id the database does not yet have, in id order. A **lower** id that appears in
code after a higher one was applied (gap-fill) is therefore applied by the next migration run: at the
next boot for a local database, by the next `db:migrate` for a hosted one (a hosted API refuses to boot
until then). Today `0018` is reserved (timelapse storage, DB-11) and `0020` is proposed (DB-12);
neither is written yet, while `0019_screenshot_blur_policy` is already applied locally.

Turso staging (`workfolio`, aws-ap-south-1) is at `0016` (audit 2026-11-03,
`docs/status/TURSO-DATABASE-READINESS-AUDIT.md`). **10 migrations are pending there: `0017`, `0019`,
`0021`–`0028`.** If it is migrated before `0018`/`0020` are written, those two will later gap-fill.

The consequence: `0018` runs **before** `0019` on a fresh database, but **after** it on any database that
already has `0019` (local dev, and Turso once DB-10 is done). So `0018` must work in both orders:

- it must not depend on anything `0019` creates or changes (`screenshot_policies.blur`,
  `screenshots.blurred`, the rebuilt `screenshots_immutable` trigger, `screenshot_blur_overrides`);
- it must not change anything `0019` touches, so `0019` still applies cleanly after it on a fresh
  database. In particular, it must not drop or recreate `screenshots_immutable`; that belongs in a
  migration numbered after `0019`.

The same applies to `0020` and any id that is below one already applied anywhere. `0020` as described
(widening the `screenshots.storage_provider` CHECK for Google Drive) almost certainly needs a
**`screenshots` table rebuild**: SQLite cannot alter a CHECK, the rebuild interacts with the
`screenshots_immutable` trigger that `0019` recreates, and it is destructive by nature. It needs its
own design and approval before it is written.

`verify:turso` reports a pending id that is **lower** than the latest applied one (a gap-fill candidate)
as a **WARN**, not a FAIL (implemented in this change set); it still has to be applied with `db:migrate`.

Tests: `packages/database/src/migration-order.test.ts` (gap-fill in both orders, unknown id refused,
edited migration refused, a fresh file database applies 0001–0017 + 0019 and a re-run applies nothing).

## Staging vs production separation

- Production is the SQLite file on the VPS (above). The Turso database `workfolio` (org `yashsinghal`,
  aws-ap-south-1) is the **previous plan's staging database**; it is not used by the VPS deployment and
  must not be migrated or written by it. A staging VPS, if ever wanted, is a second server with its own file.
- Previous plan (kept for reference): production would have been a **separate Turso database** (DB-17), never
  `workfolio` promoted in place.
- Each database has its **own tokens**. A staging token must never be able to reach production, and
  the reverse.
- Each environment has its own env file, Render service settings and GitHub environment secrets.
  **Never share or copy env files between staging and production.** The deploy workflow refuses to
  migrate unless the secret URL's host equals `vars.STAGING_DATABASE_HOST`.

## Environment variables and secret handling

- Database credentials are `DATABASE_URL` and `DATABASE_AUTH_TOKEN`. Hosted values live only in
  platform settings (Render env vars, GitHub `staging` environment secrets) and in an operator's env
  file **outside the repository**, mode `600` (e.g. `~/.config/workfolio/staging.env`). Never in
  `apps/api/.env` (the API loads it automatically, and a remote URL there makes every local boot check
  staging).
- Use a **read-only** Turso token (`turso db tokens create <db> --read-only`) for `verify:turso`,
  audits and dumps. Use a **read-write** token only where migrations run (the trusted machine during
  an approved migration, the GitHub `staging` environment) and in Render. Prefer an `--expiration`
  for tokens used by people.
- Never paste a URL with a token, a token, or an env file into chat, tickets, commit messages or logs.
  The scripts redact tokens and print only the host; keep it that way when sharing output.
- Load an env file without echoing it: `node --env-file=<file> …`, `verify:turso <file>`, or
  `db:dump --db-env <file>` (absolute path). Do not `source` env files into your shell: that exports the token
  to every child process.
- Today's staging token is read-write with no expiry and sits in `apps/api/.env.staging` inside the
  repository working tree (git-ignored). Move it outside the repo and rotate it once the Render and
  GitHub secrets exist (audit S2–S4).

## Previous plan (Turso): first staging migration runbook (`workfolio`, 0016 → 0028)

> Kept for reference only. The selected deployment migrates the VPS file through `deploy.sh --migrate`
> (above); nothing below is part of the Hostinger rollout.

Requires approval (D3; DB-09, DB-10, DB-07). Nothing here has been run yet. `<env>` is the staging env
file **outside the repo** (mode 600). Do not start the API against staging before step 7.

1. **Build:** `pnpm build:packages && pnpm --filter @workfolio/api build`.
2. **Baseline (read-only):** `pnpm --filter @workfolio/api verify:turso <env>`. Expect 16 applied
   (0001–0016), 10 pending (0017, 0019, 0021–0028), integrity and foreign-key checks clean.
3. **Dump:** `pnpm --filter @workfolio/api db:dump --db-env <env>` (absolute path). Record the file
   name, table and row counts, and the `schema_migrations` ids (0001–0016).
4. **Restore-verify the dump:** in a scratch directory outside the repo,
   `sqlite3 restored.db < workfolio-<ts>.sql`; write a second env file with
   `DATABASE_URL=file:/absolute/path/restored.db`; run `verify:turso` on it. Expect the same 16
   applied / 10 pending and clean checks. Never point `db:migrate` at this copy by mistake.
5. **Dry run (reads only):** from `apps/api`:
   `node --env-file=<env> dist/cli/migrate.js --dry-run`. Expect "Applied: 16; pending: 10" and no
   UNKNOWN or EDITED lines. Stop on anything else.
6. **Apply (the first write):** from `apps/api`: `node --env-file=<env> dist/cli/migrate.js`. Expect
   `APPLIED` lines for the 10 ids, "Foreign keys enforced." and "Schema version 0028_auto_timelapse".
7. **Post-verify:** `verify:turso <env>`. Expect 26 applied, 0 pending, **51 tables / 65 indexes /
   91 triggers** matching the reference, clean integrity and FK checks.
8. **Idempotency (DB-07):** run step 6 again. Expect "No pending migrations."
9. **If step 6 fails:** the failing migration rolled back atomically; earlier ones in the run stay
   applied. Fix forward with a new migration. If the schema is unusable, restore the step 3 dump into
   a **new** database and repoint; never overwrite `workfolio`.
10. Record the date, the dump file name and the outputs of steps 5–8 in the status report. Delete the
    scratch restore and its env file. Next: create the first Super Admin (`admin:create`, DEP-09);
    Turso staging has no users today.

Later migrations follow the same loop: dump → dry-run → approval → `db:migrate` (the deploy workflow
or a trusted machine) → `verify:turso` → deploy.

## Dump before every migration-bearing deploy (DB-15)

On the VPS this is automatic: `deploy.sh --migrate` runs `backup-db.sh` before `db:migrate` (binary,
integrity-checked, encrypted). The SQL dump below remains the inspectable form and the Turso path of the
previous plan. It is a consistent read-only snapshot taken in one read transaction, with schema and all rows,
`schema_migrations` included.

```sh
pnpm build:packages
# Turso: URL and token are read only from the env file kept outside the repo (mode 600); nothing is
# echoed, process.env is not used, and the token never lands in shell history
pnpm --filter @workfolio/api db:dump --db-env ~/.config/workfolio/staging.env
# Local file database
pnpm --filter @workfolio/api db:dump file:/absolute/path/to.db [--out <dir outside the repo>]
```

- Output: `workfolio-<UTC timestamp>.sql`, mode 600, in `--out`, else `$DUMP_DIR`, else
  `~/insight-workfolio-backups`. The dump contains personal data, so keep it outside the repository and
  delete it once the deploy is confirmed good.
- The script prints the table and row counts and the `schema_migrations` ids. Record the latest id
  in the deploy notes.
- A token is never printed, and a missing `file:` path is refused rather than created.

### Restore a dump

Always restore into a **new** database, never over the live one.

```sh
# Local file
sqlite3 restored.db < workfolio-<ts>.sql
# Turso (new database from the dump file)
turso db create <new-name> --from-dump workfolio-<ts>.sql
```

The dump turns foreign keys off for the load, creates tables and rows, then indexes and finally
triggers, so the append-only and overlap guards do not fire on rows being restored. Check the result
read-only with `pnpm --filter @workfolio/api verify:turso <env-file>`, where the env file sets
`DATABASE_URL` (and the token for Turso) for the **restored** database.

### Local rehearsal record (2026-11-02)

This used a copy of `apps/api/data/dev.db` in a scratch directory. The original file was untouched
(its SHA-256 was the same before and after).

1. `sqlite3 -readonly dev.db ".backup copy.db"`
2. `db:dump file:copy.db --out dumps`: 44 tables, 29 rows, ids 0001–0017 + 0019.
3. `sqlite3 restored.db < dumps/workfolio-….sql`
4. Compared copy and restore: per-table row counts identical; `schema_migrations` (id, checksum,
   applied_at) identical; `sqlite_master` identical; data hash identical; `integrity_check` ok and
   `foreign_key_check` clean on both.
5. `verify:turso` against the restored file: all checks passed (18 applied, 0 pending, schema
   identical to the reference). `migrate()` on the restored file applied nothing.

This rehearses the **procedure**. It is not a Turso rehearsal: a dump of the Turso staging database
has not been taken yet.

## Previous plan: Turso point-in-time restore rehearsal (DB-14)

> Superseded by `deploy/README.md` "Restore rehearsal" for the VPS. Kept for reference.

These steps need the Turso account and CLI, so the owner runs them. Restore into a **new** database
and never overwrite `workfolio`. Turso's CLI flags change between versions, so check them first with
`turso db create --help`.

1. Record the plan and restore window (table below): `turso plan show`, and the plan page in the
   Turso dashboard.
2. Note a target time T inside the window (UTC, for example `2026-11-02T10:00:00Z`) and the latest id
   in `schema_migrations` at that time.
3. Create the restored copy:
   `turso db create workfolio-pitr-<date> --from-db workfolio --timestamp <T>` (same group/location).
4. Create a short-lived token for it only: `turso db tokens create workfolio-pitr-<date> --expiration 1d`.
5. Put `DATABASE_URL=libsql://workfolio-pitr-<date>-<org>.turso.io` and that token in an env file
   **outside the repo** (mode 600). Then run
   `pnpm build:packages && pnpm --filter @workfolio/api verify:turso <that env file>`.
   DB-14 passes when every check passes and the migration ids match what you noted in step 2.
6. Optionally spot-check row counts against the live DB with `turso db shell <db> "SELECT count(*) FROM users"`.
7. Destroy the copy and its env file: `turso db destroy workfolio-pitr-<date>`. Then record the date,
   T, the result and the elapsed time below.

Do not point any API instance at the restored database.

## Previous plan: Turso plan and restore window (DB-13)

> Superseded: on the VPS the restore window is the local retention (`BACKUP_KEEP_DAYS`, 30 nightly files) plus
> the off-site OneDrive copies (`ONEDRIVE_BACKUP_KEEP_DAYS`, unset = kept until removed by hand) plus Hostinger's
> weekly snapshot.

| Field | Value |
|---|---|
| Turso plan | |
| Point-in-time restore window | |
| Database / group / location | `workfolio` / / aws-ap-south-1 |
| Checked on (date, by) | |
| PITR rehearsal (date, target T, result, elapsed time) | |
| Production database (DB-17) and its window, if different | |

DB-13 also asks for the plan and window to be in `docs/deployment.md` ("Backup and restore"). Copy
them there, or link to this table, once they are filled in.
