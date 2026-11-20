# Production readiness: product-parity release (waves 1–3)

Status: **not deployed.** Written 2026-11-20 by W4-RELEASE-DOCS from `integration/product-parity` (base `main` @
`0493e54`, waves 1–3 merged). Nothing in this document has been run against the VPS. Everything marked
**verified** was checked on a developer Mac in this worktree; everything else is marked **unverified** or is a
procedure to follow. Deploying needs explicit owner approval (tracker P8-02).

Reference: `deploy/README.md` (scripts), `docs/deployment.md`, `docs/database-operations.md`.

## 0. What production runs today (unverified)

`docs/audit/INSIGHT-WORKFOLIO-CURRENT-STATE.md`: production most likely runs `4215c8e` (2026-11-17),
whose last migration is `0032_desktop_updates`. `main` @ `0493e54` adds `0033_notifications`, which is **not
deployed** (the `/notifications` page is a 404 in production). The exact commit can only be read on the server
(`readlink -f /opt/workfolio/current`, tracker P0-05).

Consequence: this release most likely applies **three** migrations (0033, 0034, 0035), not two. Section 1
covers all three; the dry run on a copy (section 3, step 4) prints the real list.

## 1. What changes in production

### 1.1 Features

| Area | Change |
|---|---|
| Shell | Light default theme + toggle, new sidebar/top bar, global date/team filters, settings split into sub-pages, sortable tables, SVG charts |
| Overview | One aggregate endpoint: KPI strip, workload chart, top apps, late/absent/missing clock-out lists, recent screenshots (access-logged), work-hours table, holidays/leave/approvals |
| Live team | `/live-team` card page; "Online" only when the device was seen in the last 5 min |
| Attendance | Tabs Live / Daily / Monthly / Late / Missing clock-outs; `teamId` filter; monthly data + CSV/XLSX export; overtime in monthly rows; admin-initiated corrections (API) |
| Anomalies | Missing clock-out / stale device / long break **flagged only** (nothing is closed or changed) |
| Notifications | Notification rules (type × team) with account recipients, IMMEDIATE / DAILY_DIGEST / OFF; **every rule starts OFF**. Plus, if 0033 is new to production, the role-based notification queue and `/notifications` log from `main` |
| Reports | Report sub-pages (daily, monthly, monthly in/out, late, overtime, summary XLSX), timesheet week grid, scheduled reports page `/reports/scheduled` with kinds WORKED_HOURS / LATE / ABSENT, send time, team scope, provider `graph-delegated` (default stays `none`) |
| Employees | List filters (team, role, OS, app version); profile analytics tab |
| Productivity | `/timeline` Gantt, app-usage analytics on `/activity`, `/risk-users` (computed, no schema), screenshot idle marker, bulk screenshot export (Super Admin, ≤ 200 ids / 200 MB, access-logged) |
| Employee panel | Missing clock-out banner, monthly calendar, team-head late / missing clock-out views |
| Release | `/api/v1/health` returns `version` + `commit`; `/account` shows "API v0.1.0 (abc1234)"; `deploy.sh` writes `release.env` and appends to `/opt/workfolio/deploys.log` |
| Desktop (separate installer, not part of the VPS deploy) | Version reporting no longer depends on the updater; "still clocked in" banner |
| Dependencies | Next.js / eslint-config-next 16.4.3 → 16.4.6 (security patch, `5d9a69c`) |

### 1.2 New API endpoints (all `/api/v1`, `git diff 0493e54..HEAD` of the controllers)

| Method + path | Permission (from the plans; RBAC matrix is W4-SECURITY's) |
|---|---|
| GET `/overview` | `attendance:read-all`, team-scoped; sections obey their own permission |
| GET `/attendance/missing-clock-outs` | `attendance:read-all`, team-scoped |
| GET `/attendance/monthly`, `/attendance/monthly/export`, `/attendance/late` | `attendance:read-all`, team-scoped |
| GET `/attendance/summary-report`, `/attendance/daily/export` | attendance read, team-scoped |
| GET `/employees/:id/analytics` | team-scoped, audited |
| GET `/notifications/rules`, `/notifications/rules/recipient-candidates`; POST `/notifications/rules`; PATCH `/notifications/rules/:id`; PUT `/notifications/rules/:id/recipients` | `settings:manage` |
| GET `/activity/apps`, `/activity/apps/history`, `/activity/risk-users`, `/activity/team-timeline` | `activity:read-all`, team-scoped |
| POST `/screenshots/export` | `screenshots:delete` (Super Admin) |

Additive changes to existing routes: `version`/`commit` on `/health`; optional `employeeId` on
POST `/attendance/corrections`; `teamId` on attendance reads; `kind`, `sendAtLocalTime`, `teamId` on report
schedules and `graph-delegated` in `/reports/provider`; employee list filters; `idle` on gallery items.

Note: **GET `/notifications/rules` writes.** The first time an admin opens `/settings/notifications` the API
inserts the six missing organisation-wide rules, all `OFF` (`changed_by` = that admin). Harmless, but it means the
first page view after the deploy is a database write.

### 1.3 Migrations (all additive; no table rebuild, no UPDATE/DELETE of existing rows)

`0033_notifications` (from `main`, only if production is at schema 0032):
- `CREATE TABLE notification_events` (+ index `notification_events_created`).
- `CREATE TABLE notification_deliveries` (+ indexes `_due`, `_event`).

`0034_notification_rules`:
- `CREATE TABLE notification_rules` (type CHECK six values, mode default `OFF`, digest time default `18:00`,
  timezone, nullable `team_id`), unique index on `(type, coalesce(team_id,''))`, triggers: no delete, `id/type/
  team_id/created_at` immutable.
- `CREATE TABLE notification_rule_recipients` (append-only, accounts only) + partial unique index + no-delete trigger.
- `ALTER TABLE notification_events ADD COLUMN employee_id` (FK, NULL), `local_date` (CHECK, NULL), `occurred_at` (NULL);
  partial index `notification_events_day`.
- `ALTER TABLE notification_deliveries ADD COLUMN rule_id` (FK, NULL).

`0035_report_schedule_kinds`:
- `ALTER TABLE report_schedules ADD COLUMN kind TEXT NOT NULL DEFAULT 'WORKED_HOURS'` (CHECK three values).
- `ADD COLUMN send_at_local_time` (NULL = old behaviour), `ADD COLUMN team_id` (FK, NULL).
- Two triggers refusing a schedule with both `employee_id` and `team_id`.

Existing rows: report schedules become `kind = WORKED_HOURS`, no send time, no team (identical behaviour);
existing notification events/deliveries get NULL in the new columns (verified, section 2).

**Runtime** (verified locally, section 2): 0034 + 0035 on a database with 20,000 notification events, 20,000
deliveries, 20,000 alerts and 50 report schedules: 128–181 ms inside `migrate()`, 250–590 ms for the whole
`db:migrate` command including Node start-up (Apple Silicon Mac, local SSD). 0033 + 0034 + 0035 from schema 0032:
30 ms. The VPS (2 vCPU) is expected to be slower but still well under a few seconds (**unverified**; the dry run on
a production copy in section 3 measures it).

**Lock behaviour** (verified in code): `migrate()` runs each migration as one `db.batch(..., "write")`, which
`@libsql/client` 0.18 opens with `BEGIN IMMEDIATE`: the SQLite write lock is held for that migration only, and the
migration and its `schema_migrations` row commit together or not at all. In WAL mode readers continue. API writes
issued meanwhile wait (5 s busy timeout per pooled connection, `packages/database/src/index.ts`), so with the
sub-second runtime above they are delayed, not failed. `ADD COLUMN` with a CHECK makes SQLite scan the table once
(that is the measured cost; no table is copied).

During `deploy.sh --migrate` the **old** API keeps running on the migrated schema for the seconds between
migration and restart. That is safe for these additive changes (the old code never sets the new columns; the
new triggers only fire when both `employee_id` and `team_id` are set). If the old API restarts in that window it
refuses to start (it sees unknown migrations, section 6) until the new release is active.

## 2. Local migration dry run (done 2026-11-20, developer Mac, synthetic data)

Scripts in the session scratchpad, not in the repository; temp databases deleted after each run.

1. Build a database at the main-branch schema with the repository's own statements and checksums
   (0001–0033 are byte-identical between `0493e54` and this branch: `git diff 0493e54..HEAD --
   packages/database/src/migrations.ts` only appends 0034/0035; the real CLI re-verifies every checksum):

   ```js
   // base.mjs <db> <base id> <repo>
   import { createHash } from "node:crypto";
   const [dbPath, base, repo] = process.argv.slice(2);
   const { createDatabase, enableWal, MIGRATIONS } = await import(`${repo}/packages/database/dist/index.js`);
   const db = createDatabase({ url: `file:${dbPath}` });
   await enableWal(db);
   await db.execute("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), checksum TEXT) STRICT");
   for (const m of MIGRATIONS.filter((m) => m.id <= base)) {
     const sum = createHash("sha256").update(JSON.stringify(m.statements)).digest("hex");
     await db.batch([...m.statements, { sql: "INSERT INTO schema_migrations (id, checksum) VALUES (?, ?)", args: [m.id, sum] }], "write");
   }
   db.close();
   ```

2. Seed synthetic rows with `sqlite3` (FKs on, `example.test` addresses): 500 users, 495 employee profiles,
   10 teams, 50 report schedules (half with an employee) + recipients, 4 alert rules (one per kind), 20,000
   alerts; for the 0033 base also 20,000 `notification_events` + 20,000 `notification_deliveries`.
3. Apply with the repository's CLI (`pnpm --filter @workfolio/api build` first):

   ```bash
   cd apps/api
   DATABASE_URL="file:$TMP/workfolio.db" node dist/cli/migrate.js --dry-run
   DATABASE_URL="file:$TMP/workfolio.db" node dist/cli/migrate.js
   DATABASE_URL="file:$TMP/workfolio.db" node dist/cli/migrate.js   # second run: "No pending migrations."
   ```

Results:

| Base | Dry run | Applied | Time | Rows |
|---|---|---|---|---|
| `0033_notifications` (main) | `PENDING 0034_notification_rules`, `PENDING 0035_report_schedule_kinds` | both, "Foreign keys enforced", schema `0035_report_schedule_kinds` | `migrate()` 128 / 138 / 181 ms (3 runs); CLI 246–589 ms | all counts identical before/after; `report_schedules` original columns hash-identical; 50/50 schedules `WORKED_HOURS`, no send time, no team; 20,000/20,000 events and deliveries with NULL new columns; `notification_rules` empty |
| `0032_desktop_updates` (probable production) | `PENDING` 0033, 0034, 0035 | all three | `migrate()` 30 ms; CLI 259 ms | counts identical; new tables empty |

Both: `PRAGMA integrity_check` = `ok`, `PRAGMA foreign_key_check` empty, second run idempotent. After migrating,
the ids a build that stops at the base schema would see as unknown: `0034_notification_rules,
0035_report_schedule_kinds` (and `0033_notifications` from base 0032), i.e. the old build refuses this file.
`apps/api/test/database-startup.e2e.test.ts` (14/14 pass, run here) covers the refusal at boot.

## 3. Pre-deploy checklist

Do these in order; stop at the first failure.

1. **Owner approval** for the deploy (P8-02) and the open decisions in section 7 that affect it.
2. **Code on the remote.** Agents never push: the owner merges `integration/product-parity` into `main` (after
   W4 verification), pushes, and tags the commit `prod-YYYY-MM-DD[-n]` (consolidation plan §4). `deploy.sh`
   fetches from `WORKFOLIO_REPO_URL`, so an unpushed commit cannot be deployed.
3. **Read the current state** (read-only, on the VPS):
   ```bash
   readlink -f /opt/workfolio/current; cat /opt/workfolio/current/RELEASE_SHA
   sudo -u workfolio sqlite3 /var/lib/workfolio/db/workfolio.db "SELECT max(id) FROM schema_migrations;"
   curl -s http://127.0.0.1:4000/api/v1/health
   diff /etc/caddy/Caddyfile <(git -C /opt/workfolio/repo show <sha>:deploy/caddy/Caddyfile.ip)   # live hotfix vs repo (file is 0644)
   df -h /opt /var
   ```
   Record the old commit and schema version in the deploy record.
4. **hPanel snapshot** of the VPS (Hostinger panel › VPS › Snapshots). Wait until it reports complete.
5. **Fresh backup and its verification** (encrypted + off-site, uses `/etc/workfolio/backup.env`):
   ```bash
   sudo systemctl start workfolio-backup && systemctl status workfolio-backup --no-pager
   ls -1t /var/backups/workfolio/workfolio-*.db.gz* | head -1
   sudo -u workfolio env BACKUP_GPG_PASSPHRASE_FILE=/var/lib/workfolio/secrets/backup-passphrase \
     /opt/workfolio/current/deploy/scripts/verify-backup.sh <that file>      # exit 0 = restorable
   ```
   Note the file name in the deploy record; keep it (and the previous night's) until the deploy is confirmed.
   `deploy.sh --migrate` takes another backup, but it runs `backup-db.sh` without `backup.env`, so that one is a
   local, **unencrypted** `.db.gz` (mode 600) and is not uploaded. The `workfolio-backup` run above is the
   off-site copy.
6. **Build the new release without activating it**, as `workfolio`, with the new script version (the copy of
   `deploy.sh` that writes `release.env` lives in the new commit; the one in `/opt/workfolio/repo` is whatever
   that working tree has checked out):
   ```bash
   sudo -iu workfolio
   git -C /opt/workfolio/repo fetch --prune origin
   git -C /opt/workfolio/repo checkout --detach <sha>
   /opt/workfolio/repo/deploy/scripts/deploy.sh <sha>
   ```
   Expected: build succeeds, then `PENDING 00xx…` lines and `ERROR: pending migrations … The release is built at
   <dir> but NOT activated; nothing was changed`. Production keeps running the old release. The `PENDING` list
   tells you which migrations this deploy applies (expected 0033–0035 or 0034–0035; anything else: stop).
7. **Migration dry run on a COPY of the production database**, with that built release (on the VPS; production
   data does not leave the server):
   ```bash
   R=$(ls -1dt /opt/workfolio/releases/*/ | head -1); R=${R%/}; cat "$R/RELEASE_SHA"    # must be <sha>
   W=$(mktemp -d /var/lib/workfolio/tmp/migration-copy.XXXXXX)
   sqlite3 /var/lib/workfolio/db/workfolio.db ".backup '$W/copy.db'"                 # online, consistent copy
   cd "$R/apps/api"
   DATABASE_URL="file:$W/copy.db" node --env-file=/etc/workfolio/api.env dist/cli/migrate.js --dry-run
   time DATABASE_URL="file:$W/copy.db" node --env-file=/etc/workfolio/api.env dist/cli/migrate.js
   sqlite3 "$W/copy.db" "PRAGMA integrity_check; PRAGMA foreign_key_check;
     SELECT max(id) FROM schema_migrations;
     SELECT kind, count(*) FROM report_schedules GROUP BY kind;
     SELECT count(*) FROM notification_events WHERE employee_id IS NOT NULL;"
   rm -rf "$W"
   ```
   `DATABASE_URL` in the environment wins over the value in `--env-file` (Node does not override existing
   variables; `verify-backup.sh` relies on the same rule), so the live file is never opened by the CLI. Expect:
   `APPLIED` for each pending id, `Foreign keys enforced.`, schema `0035_report_schedule_kinds`,
   `integrity_check` `ok`, no `foreign_key_check` rows, every schedule `WORKED_HOURS`, 0 events with an
   employee. Record the `time` result.

   Alternative on a developer machine (only if the owner accepts production data on that machine; delete the
   copy afterwards): check out `<sha>`, `pnpm install --frozen-lockfile && pnpm build:packages && pnpm --filter
   @workfolio/api build`, then
   ```bash
   W=$(mktemp -d); chmod 700 "$W"
   gpg --batch --pinentry-mode loopback --passphrase-file <passphrase file> --decrypt workfolio-<ts>.db.gz.gpg | gzip -dc > "$W/copy.db"
   sqlite3 "$W/copy.db" "PRAGMA integrity_check;"
   cd apps/api
   DATABASE_URL="file:$W/copy.db" node dist/cli/migrate.js --dry-run
   time DATABASE_URL="file:$W/copy.db" node dist/cli/migrate.js
   rm -rf "$W"
   ```
8. **systemd unit** (needed for `commit` in `/health`, section 4). Install only the API unit, see 4.1.
9. **Env check**: nothing new is required (section 4). Leave `REPORT_MAIL_PROVIDER=none`.
10. Announce a short window (one API restart, seconds; the desktop app retries).

## 4. Environment changes

`git diff 0493e54..HEAD -- apps/api/src/config/env.ts deploy/` (and `4215c8e..0493e54` for the part of `main`
that is probably not deployed yet).

### 4.1 `WORKFOLIO_BUILD_COMMIT` (new, not in `env.ts`; read per request by the health controller)

- `deploy.sh` writes `<release>/release.env` containing `WORKFOLIO_BUILD_COMMIT=<sha>`.
- `deploy/systemd/workfolio-api.service` gains `EnvironmentFile=-/opt/workfolio/current/release.env` (optional:
  missing file = `commit: null`). Only accepted when it matches `^[0-9a-f]{7,40}$`, else `null`.
- The VPS has the old unit until it is reinstalled. The documented path is re-running `install-vps.sh`, **but
  that script also re-installs `/etc/caddy/Caddyfile` from the repository and restarts Caddy and journald**. The
  production Caddyfile was hot-fixed outside `main` (consolidation plan §8). Until the live Caddyfile and the
  repository version are reconciled, install only the API unit:
  ```bash
  sudo install -m 644 /opt/workfolio/repo/deploy/systemd/workfolio-api.service /etc/systemd/system/
  sudo systemd-analyze verify /etc/systemd/system/workfolio-api.service
  sudo systemctl daemon-reload          # takes effect at the API restart done by deploy.sh
  ```
  (Same file content as `install-vps.sh` installs; the unit diff `4215c8e..HEAD` is this one line plus its
  comment.) Doing it before the deploy is harmless: the old release has no `release.env`, so the `-` prefix
  skips it.

### 4.2 `REPORT_MAIL_PROVIDER`

`none` (default, nothing is emailed; runs recorded as "Not emailed: no provider") · `mock` (development and tests;
**refused in production**) · `graph-delegated` (new: sends through the OneDrive connection's delegated
`Mail.Send` token as `MAIL_SENDER`). Boot refuses `graph-delegated` unless the `ONEDRIVE_*` settings are present and
`MAIL_SENDER` equals `ONEDRIVE_ACCOUNT_EMAIL`. **Keep `none` for this deploy**; switching is an owner decision
(section 7).

### 4.3 Nothing else new since `0493e54`

The `env.ts` diff contains only the provider enum and its refine. Since `4215c8e` (if that is what runs):
`INVITATION_MAIL_PROVIDER` gained `graph-delegated` (same rule), and it now also selects the transport for
**notifications** (`docs/notifications.md` §7). With `none`, notification deliveries are recorded as `FAILED`
("No email provider is configured") and nothing is emailed. Check what production has:
`sudo grep -E '^(INVITATION|REPORT)_MAIL_PROVIDER|^MAIL_SENDER' /etc/workfolio/api.env`. If it is
`graph-delegated`, any notification rule switched on will send real email.

Stale text (not changed here, `deploy/**` is W1-RELEASE's): `deploy/env/api.env.example` still says
"Report emails: no provider is integrated yet".

## 5. Deploy steps

As `workfolio`, after section 3 passed:

```bash
/opt/workfolio/repo/deploy/scripts/deploy.sh <sha> --migrate
```

What it does (`deploy/scripts/deploy.sh`): fetch → `git archive <sha>` into a new `releases/<ts>-<sha12>` →
`RELEASE_SHA` + `release.env` → `pnpm install --frozen-lockfile` → build packages, API, dashboard
(`NEXT_PUBLIC_API_URL` from `dashboard.env`) → `db:migrate --dry-run` with the new build → `backup-db.sh`
(local, see 3.5) → `db:migrate` → `current.previous` = old release, `current` = new → restart API →
`healthcheck.sh --no-ready --no-dashboard` → restart dashboard → `healthcheck.sh --no-ready` → append to
`/opt/workfolio/deploys.log` → prune to three releases (never current/previous). Any failure stops the script
with the journal command to run.

It builds a second release directory (the one from step 3.6 stays until pruned). Disk: ≈ 1 GB per release.

Then: copy the `deploys.log` line and the `APPLIED` lines into the deploy record (`docs/releases/DEPLOY-RECORD-TEMPLATE.md`)
and push the `prod-…` tag.

## 6. Smoke tests after the deploy

`$BASE` = the public origin (today `https://189.72.144.117`, single origin with `/api/*` → API; later
`https://api.<domain>` and `https://app.<domain>`).

| # | Check | Expected |
|---|---|---|
| 1 | `curl -s http://127.0.0.1:4000/api/v1/health` and `curl -s $BASE/api/v1/health` | `status "ok"`, `version "0.1.0"`, `commit "<sha>"` (null = unit not reinstalled, 4.1) |
| 2 | `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4000/api/v1/ready` | 200 (503 only if OneDrive is not connected, same as before the deploy) |
| 3 | `/opt/workfolio/current/deploy/scripts/healthcheck.sh` | exit 0 |
| 4 | `sudo -u workfolio sqlite3 /var/lib/workfolio/db/workfolio.db "SELECT max(id) FROM schema_migrations; PRAGMA journal_mode;"` | `0035_report_schedule_kinds`, `wal` |
| 5 | Log in on `$BASE` as an admin | dashboard loads, light theme, new sidebar |
| 6 | Overview `/` | KPI strip and widgets load; no error card |
| 7 | `/attendance`: tabs Live, Daily, Monthly, Late, Missing clock-outs | each loads; Monthly export downloads; with the work schedule off, Late/Absent lists are empty (expected; exact empty-state text not checked here) |
| 8 | `/settings/notifications` | every rule **OFF**; no recipients (first open inserts the six OFF rules, 1.2) |
| 9 | `/reports/scheduled` | provider banner says nothing is emailed (`GET /api/v1/reports/provider` → `none`); existing schedules listed as Worked hours, send time empty |
| 10 | `/desktop-updates` | releases and devices load (installed version "not reported" until desktops run a build with the new reporting) |
| 11 | `/account` | "API v0.1.0 (<sha7>)" |
| 12 | `/notifications` | log page loads (if 0033 was new: empty or only system events) |
| 13 | A desktop clock-in/out by a test account (or watch the next real one in Live) | appears in Live / Daily; no error in `journalctl -u workfolio-api --since -15min` |
| 14 | `journalctl -u workfolio-api -u workfolio-dashboard --since -30min -p warning` | no new errors |
| 15 | Next morning: `systemctl status workfolio-backup`, `monitor.sh` result | nightly backup succeeded at schema 0035 |

Acceptance (roadmap Phase 8): health shows the tagged SHA, no 5xx in 24 h, backups continue.

## 7. Rollback

### 7.1 Claim verified: migrations are forward-only and an old build refuses a newer database

- `packages/database/src/migrations.ts`: there are no down-migrations. `migrate()` throws `Database has
  migrations this build does not know (…); refusing to start` when `schema_migrations` lists an id the build
  does not have; `migrationStatus()` reports such ids as `unknown`.
- `apps/api/src/database/prepare.ts`: in production (`NODE_ENV=production`, verify-only) the API throws the same
  error at boot when `unknown` is not empty, before serving anything. Test:
  `apps/api/test/database-startup.e2e.test.ts` "refuses an unknown or edited migration" (passes here).
- `db:migrate --dry-run` prints `UNKNOWN <id> (applied by a newer build)` and exits 1.

**Consequence:** once 0034/0035 (and 0033) are applied, the previous release **cannot start** on the live database.
`deploy.sh --rollback` alone switches the symlink, restarts the API, the API refuses to start, the health check
fails and the script stops: the API is down. A code rollback after a migration-bearing deploy therefore always
needs the **pre-deploy backup restored**, and every write since the deploy (attendance events, breaks,
corrections, screenshots metadata, activity, audit rows) is lost from the database. Screenshots uploaded to
OneDrive in that window stay in OneDrive but are no longer referenced.

### 7.2 Decision rule

- Problem in the new code, database fine → prefer **fixing forward** (new commit, `deploy.sh <new sha>`): no data loss.
- New release unusable and no quick fix → full rollback (7.3), accepting the data loss above. Record which
  window was lost.
- Deploy failed **before** migration (build or dry-run error) → nothing to roll back; `current` was not switched.
- Migration failed → that migration rolled back as a whole (one transaction); earlier ones in the same run stay
  applied. The old release then refuses to start if any new id was applied: restore (7.3).

### 7.3 Full rollback (code + database)

As root unless noted:

```bash
# 1. restore the pre-deploy backup (stops the API, moves the live files + WAL sidecars to
#    /var/backups/workfolio/pre-restore-<ts>/, installs, sets WAL, integrity check, dry run with the CURRENT
#    (new) release: the old schema shows PENDING ids, so it exits 3 and leaves the API stopped — expected)
BACKUP_GPG_PASSPHRASE_FILE=/var/lib/workfolio/secrets/backup-passphrase \
  /opt/workfolio/current/deploy/scripts/restore-db.sh /var/backups/workfolio/workfolio-<pre-deploy ts>.db.gz.gpg
# 2. switch code back to the previous release and restart both services (as workfolio)
sudo -u workfolio /opt/workfolio/repo/deploy/scripts/deploy.sh --rollback
# 3. checks
curl -s http://127.0.0.1:4000/api/v1/health          # old commit (null if the old release has no release.env)
sudo -u workfolio sqlite3 /var/lib/workfolio/db/workfolio.db "SELECT max(id) FROM schema_migrations;"   # old schema
```

`deploy.sh --rollback` uses `current.previous`; if that link points elsewhere, set `current` by hand to the release
dir recorded in section 3.3 (`ln -sfn /opt/workfolio/releases/<old> /opt/workfolio/current`, restart both units).
Last resort: restore the hPanel snapshot from step 3.4 (loses everything since the snapshot, including logs).

The pre-restore files are kept, so the rolled-back window can be inspected later; re-applying it is manual.

The restore sequence is tested by `selftest.sh` on a developer machine, not on the VPS (**unverified there**).

## 8. Owner decisions still open

From contracts §9 (defaults implemented; the owner may keep or change them):

| Decision | Default in this release |
|---|---|
| Missing clock-out policy | Flag only; no auto clock-out, no desktop auto-correction |
| Admin-initiated correction approval | A different admin approves (no self-approval). A one-admin organisation cannot approve such a correction |
| Email recipients | Accounts only |
| Digest time / zone | 18:00 in `DEFAULT_TIMEZONE`, editable per rule; every rule `OFF` |
| Anomaly thresholds | Constants: workday end = expected start + 8 h + 2 h grace; max shift 14 h; stale device 30 min; long break 2 h |
| Work schedule in production | Unchanged (off). While off, Late / Absent lists, LATE/ABSENT reports, late/absence notifications and the "less working hours" risk trigger produce nothing |

Tracker rows marked Blocked:

| Row | Needs |
|---|---|
| P0-05 Identify the production commit | Read-only SSH (`readlink /opt/workfolio/current`), section 3.3 |
| P0-06 Repository consolidation | Approval of `docs/audit/REPOSITORY-CONSOLIDATION-PLAN.md` (installers WIP, branches, folders) |
| P7-07 Windows desktop verification | Windows CI job (needs a push) or a Windows machine |
| P8-02 Production deployment | Explicit approval |

Other decisions this release touches:

- Which rules to switch on, with which recipients and modes (notifications) — all OFF until decided.
- Report email: switch `REPORT_MAIL_PROVIDER` to `graph-delegated` or not; recipients; HR/Legal approval of
  emailing per-employee figures (`docs/email-reports.md` "Decisions needed").
- Merge `integration/product-parity` → `main`, push, tag `prod-…` (agents do not push).
- Reconcile the live Caddyfile hotfix with `deploy/caddy/Caddyfile.ip` before `install-vps.sh` is re-run.
- Roadmap list: HR/Legal notice wording and retention periods; production domain (certificates, cookies).
- Resolved, no decision needed: Next.js 16.4.3 → 16.4.6 security patch is already in this release.

## 9. Known limitations

From the agent plans (`docs/status/agent-plans/*.md`), the tracker and the docs they cite:

- **Version visibility**: `commit` is `null` until the API unit is reinstalled (4.1) and a release is built by the
  new `deploy.sh`. Desktop installed versions appear only after each desktop installs a build with the new
  reporting (W1-RELEASE; cannot be fixed remotely).
- **Desktop builds** are unsigned (certificates blocked); Windows verified only by `cargo check`, not on Windows.
- **Anomalies are flags**: no session is closed or edited; fixes go through correction requests.
- **Notifications**: a digest missed because the API was down from digest time to local midnight is not sent
  later; OneDrive storage and mail share one Microsoft sign-in (if it expires, mail fails too); with
  `INVITATION_MAIL_PROVIDER=none` deliveries are recorded as FAILED; backup failures are not raised as
  notifications (`docs/notifications.md` §6).
- **Reports**: no backfill of periods before a schedule existed; with provider `none` nothing is emailed.
- **Risk users** are computed from existing alerts + scheduled-hours shortfall; no new data, depends on the work
  schedule.
- **Timeline / idle marker** need activity data: monitoring off, not yet synced or purged → blank / not idle.
- **Bulk screenshot export**: Super Admin only, ≤ 200 screenshots and ≤ 200 MB per export.
- **Live status**: "Online" only when the device was seen within 5 minutes.
- **Single instance**: in-memory locks, rate limits and timers (including the new 60 s notification timer)
  assume one API process (unchanged rule).
- **Tests**: 6 pre-existing time-of-day dependent API test failures (P7-11); `verify:my-panel` 45/46
  (pre-existing desktop-downloads assertion); `verify:web-product` had stale expectations (wave 2 log). W4-E2E
  and W4-SECURITY results are not in this document (running in parallel).
- **Tracker** rows for wave 3 (P6-*) and P4-07 still say Pending although wave 3 is merged and
  `/settings/notifications` exists; update them before relying on the tracker.
- **Not verified on the VPS**: build time, migration time on real data, `install-vps.sh` unit install, restore
  sequence, gpg path of `verify-backup.sh` (gpg is not installed on the developer Mac).
