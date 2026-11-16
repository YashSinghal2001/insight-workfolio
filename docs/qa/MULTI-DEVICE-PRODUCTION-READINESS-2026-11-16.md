# Multi-device + single active sign-in: production readiness (2026-11-16)

> Public repository: this file names no employee, email, device id or production inventory. Employees are
> "the owner's account" (two revoked devices) and "employees A and B" (one active Windows device each).

## Verdict

**NOT READY FOR PRODUCTION**

The code and migration passed every automated and rehearsal gate available here (below). The verdict is
"not ready" because these release gates are still open: the rehearsal was not run on a restored copy of the real
database, nothing is committed or pushed, there is no new desktop build, nothing has been tested on a physical
Mac or Windows machine, and one revocation policy question needs the owner's decision. The blockers are in §6.
Each one has a concrete next step.

## 1. What was inspected (source, not summaries)

| Area | Files | State |
|---|---|---|
| Migration `0030_account_invitations` | `packages/database/src/migrations.ts` | **Committed** in `b7a328e` (invitations; not device-related). Not deployed. |
| Migration `0031_multi_device_single_session` | same | **Uncommitted.** Drops `devices_one_active_per_employee`, adds `devices_identifier`, `reregistration_approved_at/_by`, closes expired-unrevoked bound sessions, unbinds (does not revoke) older duplicate bound sessions, creates `UNIQUE sessions_one_active_device_per_user`. |
| API | `auth/device-session.ts` (new), `auth/auth.service.ts`, `auth/auth.controller.ts`, `devices/devices.service.ts`, `devices/devices.controller.ts`, `employees/employees.service.ts`, `common/all-exceptions.filter.ts` | Uncommitted |
| Shared | `api.ts`, `audit.ts`, `attendance.ts`, `schemas.ts` | Uncommitted |
| Dashboard | `components/devices.tsx`, `(admin)/devices/page.tsx` (new), employee detail, my profile, sidebar, audit labels | Uncommitted |
| Desktop | `session.ts`, `main.ts`, `index.html`, `tray-bridge.ts`, `monitoring.ts`, `activity-ui.ts`, `screenshot-ui.ts` | Uncommitted; **version still 0.2.0** |

Deployed: `4d66269` (per the status audit). A deploy of this feature also ships `03421f8` and `b7a328e` (58 files
since `4d66269`). The invitation mail provider defaults to `none`, so HEAD boots on the existing `api.env` and
needs no new settings.

## 2. Automated gates (HEAD + uncommitted work)

| Gate | Result |
|---|---|
| `pnpm typecheck` (all 6 packages) | pass |
| `pnpm lint` (incl. `cargo clippy -D warnings`) | pass |
| `pnpm -r test` | **728/728 pass**: API 509, desktop 86, shared 76, database 50, extension 7 |

## 3. Production-shaped rehearsal (isolated; **not** a restored production copy)

There is no copy of the production database on this machine, and I have no access to the VPS. As the closest
substitute, I built the **deployed commit `4d66269`** in a throwaway worktree and seeded a file database through
its real API at schema `0029`, with both production constraints present:

- Employee A: one Windows device; three desktop sign-ins on it (one expired but not revoked, one orphaned live session, one current live session), with attendance, activity and screenshot rows.
- Employee B: one Windows device, one live bound session, with history.
- The owner's account: Mac registered, used and revoked by IT. Windows registered, used and revoked by IT. One **live unbound DESKTOP session** and one live web session.

I then backed it up the same way `backup-db.sh` does, migrated it with HEAD, and ran HEAD's API against it.
Scripts and output (in the session scratchpad, which is not durable):
`/private/tmp/claude-501/-Users-yashsinghal-Desktop-Projects-workfolio-insight-workfolio/cf9fc59e-2a7d-465e-8078-f455c1bb8dfc/scratchpad/rehearsal/`
(`seed-deployed.mjs`, `rehearse-head.mjs`, `rehearsal-result.txt`).

**Result: 45 pass, 0 fail, 1 finding.**

| # | Check | Result |
|---|---|---|
| A1 | Online `.backup` copy, `integrity_check` = ok | pass |
| A2–A4 | Dry run: exactly 0030, 0031 pending; applied in order; re-run is a no-op | pass |
| A5 | `integrity_check` ok, `foreign_key_check` empty after migration | pass |
| A6 | devices, attendance_sessions/events, activity_intervals, screenshots, account_audit, users, employee_profiles, monitoring_consents: **every pre-existing row and column byte-identical** | pass |
| A7–A8 | New columns NULL on existing rows; old one-device index gone; single-session index present; `devices_no_delete` still refuses deletes | pass |
| A9 | Only the already-expired bound session was closed (`revoked_at = expires_at`) | pass |
| A10 | Employee A's older duplicate bound session was **unbound, not revoked**; the newest stays bound | pass |
| A11–A12 | Employee B's session and the owner's unbound DESKTOP session untouched; ≤ 1 live bound session per account | pass |
| B1–B3 | Employees A and B on the **0.2.0 app**: refresh works, device ACTIVE, attendance accepted (not signed out) | pass |
| B4 | The owner's pre-existing unbound session: still valid, sees REVOKED, cannot write (403) | pass |
| B5–B6 | Revoked, unapproved Mac/Windows: new app gets 403 `DEVICE_REVOKED` after the password check; old app cannot register | pass |
| B7 | An employee cannot approve their own re-registration | pass |
| B8 | IT approves Windows → sign-in → register reuses the **same** record → ACTIVE → clock-in | pass |
| B9–B10 | IT approves Mac → registers while Windows is active → 409, Mac INACTIVE but registered; Mac sign-in 409 names Windows | pass |
| B11 | Takeover with the wrong password → 401; Windows stays active | pass |
| B12–B13 | Windows logout → Mac signs in; Mac logout → Windows signs in. The Mac can clock out a shift opened on Windows | pass |
| B14 | Password-confirmed switch: the previous device's access and refresh tokens fail **immediately**; audited `DEVICE_SESSION_TAKEOVER` | pass |
| B15 | 20 simultaneous sign-ins from both devices: all 200s from one device, the rest 409, exactly one live bound session | pass |
| B16 | 10 simultaneous takeovers from both devices: still exactly one live bound session | pass |
| B17–B18 | Unbound and web sessions survive all switching; employees A and B unaffected | pass |
| B19–B20 | All 15 pre-migration audit rows identical; admin inventory shows both devices; history shows revoke → approve → re-register | pass |
| B21 | Revoking the active device ends its session at once; the other device can sign in; the revoked one needs approval again | pass |
| B22 | API restart: the active sign-in persists and still blocks | pass |
| C1 | HEAD boots verify-only (production mode) on the migrated database | pass |
| C2 | **The deployed build refuses the migrated database** ("migrations this build does not know") | pass, which means `deploy.sh --rollback` alone does not work |
| C3 | Restoring the pre-migration backup: integrity ok, deployed build boots, all data identical | pass |
| F1 | **Finding:** a brand-new installation id registers as a new, authorized device **without admin approval** | see blocker 5 |

### Unbound DESKTOP session: behaviour

0031 does not touch it. It stays valid with web-equivalent rights. It cannot write device-bound records, sees
REVOKED for a revoked installation, and is never counted as the active sign-in. Takeovers and logouts on other
devices leave it alone. It ends at its 30-day expiry, at sign-out, or when the password is reset. One subtlety:
if the app that holds it is upgraded in place and its installation was approved for re-registration, that session
can complete registration without a fresh password entry, because it came from an earlier password sign-in.
This is acceptable, but it is the one path where "explicit password" is not literal.

## 4. Platform compatibility

| Scenario | Covered by | Needs a physical device |
|---|---|---|
| Registration, login/logout, switching, revocation, re-registration, token invalidation, concurrency, API restart | API e2e (`multi-device-session.e2e.test.ts`) + rehearsal | No (server-enforced; same code path on both OSes) |
| Desktop client: sends the installation id, takeover only on an explicit click, refusal keeps no token, logout forgets the token even offline | `apps/desktop/test/device-login.test.ts` (unit) | No |
| Credential storage (Windows Credential Manager / macOS Keychain) for the installation id and refresh token | — | **Yes, both** |
| App restart / reboot keeps the sign-in; tray Quit + relaunch | — | **Yes, both** |
| 409 screen + "Switch to this device" button, INACTIVE banner, re-register form after approval | — | **Yes, both** |
| API outage → offline banner → recovery, queued events upload after reconnect | existing offline tests (unit) | **Yes, both** (real network loss) |
| Takeover while the other machine is online: it gets 401 and shows the sign-in screen | — | **Yes** (Mac + Windows together) |
| 0.2.0 app against the new API | rehearsal B1–B3, e2e "old app" | Recommended once on Windows (employees A and B run it) |

A new desktop build sent to the **old** API is harmless: the deployed `loginSchema` is a non-strict `z.object`
and drops `installationId` and `takeover`, so the build behaves like 0.2.0. Still, deploy the API first.

## 5. Controlled release plan (to run once the blockers are cleared)

**Deployment commit:** none exists yet. Proposal: one commit on `deploy/hostinger-vps` on top of `b7a328e` with
the 43 changed and new paths **except** `docs/qa/YASH-WINDOWS-LOGIN-UNBLOCK-PLAN-2026-11-16.md`, which contains
employee emails. Leave that file out, or redact it first. The deploy ref is that commit's SHA, and it must be
pushed (`deploy.sh` fetches from `origin`).

**Migration order:** `0030_account_invitations` → `0031_multi_device_single_session`. `migrate()` applies them in
id order, each in one transaction with its `schema_migrations` row.

**Component order:** (1) API + dashboard together with `deploy.sh <sha> --migrate`. The new dashboard needs the
new device endpoints. (2) Desktop build (version bumped, e.g. 0.3.0), Windows via the CI installer workflow, macOS
built locally, installed on the owner's two machines only. (3) Employees A and B can stay on 0.2.0 and upgrade
later.

**Before the window (on the VPS, read-only):**
1. `deploy/scripts/verify-backup.sh` on the newest nightly backup: integrity, row counts, migration dry run shows PENDING 0030/0031.
2. **Rehearse on the real data:** decrypt last night's backup into a temporary directory (as `verify-backup.sh` does), then run `node dist/cli/migrate.js` from a HEAD build with `DATABASE_URL=file:<temp copy>`, plus `PRAGMA integrity_check` and `PRAGMA foreign_key_check`. Compare `devices` and `account_audit` before and after, and count live bound sessions per user (expect ≤ 1). Delete the temporary copy afterwards.
3. `db:migrate --dry-run` against production: `Applied: 29; PENDING 0030, 0031` and nothing else.

**Window (quiet hour; ask the two employees to clock out first):**
1. `deploy.sh <sha> --migrate`: build → `backup-db.sh` (verified, encrypted, kept 30 days) → `db:migrate` → switch `current` → restart the API and dashboard → health check.
2. Record the backup file name it printed. That file is the rollback point.

**Post-deployment checks:**
- `healthcheck.sh`; `db:migrate --dry-run` → nothing pending; API log shows `Schema version 0031_multi_device_single_session`.
- Dashboard → People → Devices: employees A and B each have 1 device ACTIVE or INACTIVE (not REVOKED); the owner has 2 REVOKED.
- Employees A and B: next clock-in on 0.2.0 accepted.
- Audit page: no unexpected `DEVICE_SESSION_REJECTED` for A or B.

**Rollback (forward-only schema; there are no down migrations):**
- `deploy.sh --rollback` **alone fails**: the old build refuses a database containing 0030/0031 (rehearsal C2).
- Real rollback: `deploy.sh --rollback` (code), then `restore-db.sh <pre-migration backup> --yes` (data), as root. This loses every write made after the backup (attendance, activity, screenshot metadata), so decide within minutes or export the post-deploy rows first. Rehearsed as C3.
- To roll forward instead (preferred for small defects): fix and redeploy. 0031 is already applied, so no new data migration is needed.

**The owner's re-registration (after the deploy and the new desktop build):**
1. A Super Admin or IT admin opens Dashboard → People → Devices → the owner's **Windows** device → **Approve re-registration**.
2. On Windows, install the new build over 0.2.0 (keep the credential entries, so the same installation id and the same device record are reused). Sign out if signed in, then sign in with the password → the **Register this device** form appears → register → ACTIVE.
3. Admin approves the **Mac** the same way. On the Mac, install the new build and sign in → message "signed in on Windows" + **Switch to this device**. Either sign out on Windows first, or click Switch, which needs the password.
4. Check: the dashboard shows the owner with 2 devices (one ACTIVE, one INACTIVE), and history shows REVOKED → REREGISTRATION_APPROVED → REREGISTERED for each.
5. Do **not** wipe the credential store (the old "minimal unblock" approach). It would create a third device row.

## 6. Remaining blockers

| # | Blocker | Evidence | To clear |
|---|---|---|---|
| 1 | Migration not tested on a **restored copy of the real production database** | No backup copy on this machine and no VPS access. The rehearsal used a production-shaped database seeded by the deployed code (§3) | Run step 2 of "Before the window" on the VPS and compare with §3 |
| 2 | **Nothing committed or pushed**, so there is no deployable ref | `git status`: 32 modified + 11 untracked. `deploy.sh` builds from `origin` | Owner approves the commit (excluding the email-bearing doc) and the push |
| 3 | **No new desktop build.** Without it the owner cannot use the outcome: 0.2.0 shows only a "revoked" banner for an approved device (it offers registration only on NOT_REGISTERED) and has no switch button | `apps/desktop/package.json` and `tauri.conf.json` are both still `0.2.0`; `main.ts` diff | Bump the version; build the Windows installer (CI) and the macOS app |
| 4 | **No physical Mac or Windows verification** | §4 rows marked "Yes". The implementation doc §9 says the same | Run those rows on both machines with the new build against production after step 1 of the window, or against a staging API first |
| 5 | **Revocation is per installation, not per computer** (requirement 9) | Rehearsal F1: a fresh installation id → `register` creates an authorized device row with no approval. Before 0031 the one-device cap limited this to one authorized device; after 0031 there is no limit. It is visible in the inventory and audited as `DEVICE_REGISTERED` | Owner decision: (a) accept and document, with IT watching new registrations, or (b) add "new devices start PENDING until an admin approves", a code change plus tests |
| 6 | Public-repo hygiene | `docs/qa/YASH-WINDOWS-LOGIN-UNBLOCK-PLAN-2026-11-16.md` contains employee emails. The repo is PUBLIC (`gh repo view`) | Exclude it from the commit or redact it |

Not blockers, but on record: the referenced `PRODUCTION-DEVICE-INVENTORY-AUDIT-2026-11-16.md` does not exist
in this repository (keep it out; it would be inventory). The production facts above come from the request and
were not re-verified here. Re-registration approval does not expire. Login rate limits are per process and in memory.
