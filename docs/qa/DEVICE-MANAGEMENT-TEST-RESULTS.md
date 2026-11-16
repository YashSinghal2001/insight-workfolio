# Device management — test results (Phases 11–12)

Run 2026-11-16 on macOS (arm64), locally, against in-memory and temporary file databases. **No physical
Windows or macOS end-to-end verification was performed**; the desktop results are the app's TypeScript
client tests and its Rust unit tests. Production was not touched.

## 1. Regression (whole repository)

| Command | Result |
|---|---|
| `pnpm -r lint` (ESLint everywhere + `cargo clippy -D warnings`) | pass |
| `pnpm typecheck` | pass (after one fix in the new desktop test) |
| API `pnpm test` (Nest build + `node --test`) | **509 / 509** |
| `packages/database` | **50 / 50** |
| `packages/shared` | **76 / 76** |
| Desktop `node --test` | **86 / 86** |
| Desktop `cargo test` | **104 passed**, 1 ignored (pre-existing) |
| Browser extension | **7 / 7** |
| Dashboard `next build` + smoke | pass, **35 routes** (includes new `/devices`) |

Invitation tests, migration 0030 and the 0.2.0 Windows QA code were not modified and pass.

## 2. New tests

### `apps/api/test/multi-device-session.e2e.test.ts` (14 tests, file database)

| Area | Covered |
|---|---|
| Registration | first / second / third device; Windows + macOS under one employee; duplicate registration idempotent (same id, one audit row); installation owned by another employee → 409 `DEVICE_OWNED_BY_ANOTHER_EMPLOYEE`, their device header refused |
| Single sign-in | Mac active → Windows sign-in 409 `ACTIVE_ON_ANOTHER_DEVICE` naming "MacBook Air M2 (macOS)", no token issued, Mac unaffected; Mac logout → Mac INACTIVE, refresh 401, access token 401; Windows sign-in OK and can clock in; reverse direction (Windows active blocks Mac); Windows logout → Mac sign-in OK; inactive device's writes refused |
| Race | 4 rounds × 4 simultaneous sign-ins across two devices: never two devices, exactly one live device session in the database |
| Same device | repeat sign-in on one installation replaces its own previous session |
| Switch | `takeover: false` → 409; `takeover: true` → other device's refresh and access tokens dead, audited once |
| Stale recovery | employee signs the other device out from the web (`/devices/mine/:id/end-session`); an expired sign-in no longer holds the slot and is recorded as ended at its expiry |
| Old desktop app | sign-in without installation id: device writes 409, `/devices/me` INACTIVE with the active device, still one live session |
| Revocation | revoke active device (refresh 401, access 401, other device stays registered and can sign in, revoked device sign-in 403 `DEVICE_REVOKED`); revoke inactive device (active one unaffected) |
| Re-registration | approval on a non-revoked device 409; unapproved re-registration 403; approval activates nothing and restores no token; sign-in + register reuses the same record, approval consumed; other device unaffected; history shows registered / revoked (actor + reason) / approved / registered again; audit rows cannot be deleted |
| RBAC | employee: list/history/revoke/approve/end → 403, another employee's device via `mine` → 404, other employee's device list → 404; IT Admin lists and ends sessions; IT Admin cannot revoke / end / approve a Super Admin's device (403), Super Admin can |
| API restart | active sign-in survives a restart: refresh works, clock-in works, other device still 409, logout then switch works |

### `packages/database/src/multi-device.test.ts`

Migration 0031 on pre-existing data: device and audit rows untouched, revoked device kept; duplicate live
bound sessions → newest stays bound, others unbound (not revoked); expired bound session → ended at its
expiry; web session untouched; several devices per employee now allowed, still one record per
installation; a second live device session for an account is refused by the database (insert and update);
allowed again once the first ends.

### `apps/desktop/test/device-login.test.ts`

Sign-in sends the installation id; `takeover` only when chosen; session persisted; a 409 stores no token
and exposes `code` + active device; logout forgets the token even offline.

## 3. Existing tests updated (old one-device semantics)

| Test | Change |
|---|---|
| `attendance.e2e` "registration …" | new response fields; a session bound to one device cannot enroll another (403) instead of "one device per employee" (409) |
| `devices-audit.e2e` | same 409 → 403 |
| `device-sessions.e2e` | a second sign-in on the same installation now replaces the first |
| `security-hardening.e2e` "device revoked while its request runs" | the race is now injected into the binding transaction (where the check moved) |
| `project-time-multi-instance.e2e` | one desktop session used against two API instances (two concurrent device sessions of one employee no longer exist) |
| `verify-turso-script` | "pending only after the latest" fixture moved to 0031 |
| database `migration-status`, `auto-timelapse`, `database`, `session-device` | 0031 in the migration lists, index count 66 → 67, several devices allowed |

## 4. Cross-platform scenario matrix (spec §11)

Exercised through the API with `platform: macos` and `platform: windows` devices (same rules for both):

| # | Scenario | Result |
|---|---|---|
| 1 | Mac registered, Mac active | pass |
| 2 | Windows registered while Mac active | pass (registered, INACTIVE) |
| 3 | Windows sign-in blocked | pass (409) |
| 4 | Mac logout | pass |
| 5 | Windows sign-in | pass |
| 6 | Windows logout | pass |
| 7 | Mac sign-in | pass |
| 8 | Revoke Windows | pass (revoke tests) |
| 9 | Windows refused until re-registration approved | pass |
| 10 | Windows re-registration succeeds | pass (re-registration test, run on the Mac record; same code path) |
| 11 | Other devices unaffected | pass |
| — | Reverse order | pass |

Physical devices: **not done.** To do on real machines with a new desktop build: steps 1–11 on one
MacBook + one Windows laptop, plus quitting the app (not logging out) and checking the dashboard's
"Sign out this device".
