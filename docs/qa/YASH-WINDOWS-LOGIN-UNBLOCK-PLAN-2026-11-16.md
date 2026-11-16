# Yash Windows login unblock — plan (2026-11-16)

## Verdict

**READY FOR APPROVAL — MINIMAL WINDOWS UNBLOCK**

No code change, no deployment, no migration, no production SQL and no service restart. The only action is on
Yash's Windows laptop: remove the app's installation-id entry from Windows Credential Manager so that the app
creates a new installation id, then sign in and register. The deployed API already supports exactly this path,
and it was rehearsed end-to-end against the deployed code with the production state reproduced.

One deviation from the requested checks, stated up front: this creates **one new device row** for the Windows
laptop. The old revoked Windows row stays as it is (history). That is not a duplicate *authorized* record. Two rows
for one laptop is the cost of using the deployed path instead of changing production data or code (options B/C below).

## 1. Inputs

- Owner-supplied production facts (2026-11-16): latest migration `0029_device_live_state`; 0030/0031 not applied;
  Yash (code 106, yashsinghal@tffdigital.com) has a revoked Mac and a revoked Windows device, both revoked by
  it@tffdigital.com, **zero authorized devices**; `devices_one_active_per_employee` and `devices_no_delete`
  present; one live unbound DESKTOP session for Yash.
- `docs/qa/PRODUCTION-DEVICE-INVENTORY-AUDIT-2026-11-16.md` **does not exist in this repository** (searched the whole
  tree). The facts above are taken from the request, not re-verified here (no shell on the VPS).
- Deployed code: `4d66269` per `docs/status/PROJECT-STATUS-AUDIT-2026-11-16.md` §17 (route/UI fingerprinting,
  high confidence; on-disk SHA not verified). Device and auth code is **identical** in `4d66269` and `b7a328e`
  (`git diff --stat` empty for `devices.service.ts`, `devices.controller.ts`, `auth.service.ts`).

## 2. Inspection (Phase 1)

| # | Question | Finding (deployed `4d66269`) |
|---|---|---|
| 1 | `devices.service.ts` | `register()`: if a row exists for (employee, SHA-256 of installation id) and it is revoked → **403 "This device was revoked by an administrator"**; if no row → INSERT. |
| 2 | Registration endpoint | `POST /api/v1/devices/register` (desktop session, `timesheet:clock`). Idempotent per installation. |
| 3 | Login / binding | Login does not look at devices. A desktop session is bound to a device on register / `GET /devices/me` / any device write (`touch()`: binds only an unbound session to an unrevoked device). |
| 4 | Revocation | `POST /devices/:id/revoke`: sets `revoked_at`, revokes sessions bound to the device, audits once. **No un-revoke endpoint exists.** |
| 5 | Revoked identifiers | Refused forever for that employee: `register()` 403, and `UNIQUE(employee_id, device_identifier)` prevents a second row for the same installation. |
| 6 | Reactivating the existing row safely | Not possible through the deployed application. Only an SQL `UPDATE` (forbidden) or a code hotfix (option B) could do it. |
| 7 | Does the Windows installation id still match the revoked row? | Cannot be read from here. Observable proof: if the Windows app shows **"This device was revoked by an administrator"**, it matches; if it showed the register form, it would not match and registration would simply succeed. |
| 8 | Live unbound DESKTOP session | Harmless. The deployed login enforces nothing about other sessions; an unbound session has no device rights and gets bound only when it makes a device call on an unrevoked device. Rehearsal confirms it stays valid and blocks nothing. |
| 9 | Does the unique index allow one Windows device? | Yes. `devices_one_active_per_employee` only counts **unrevoked** rows; Yash has zero, so exactly one new row is allowed. It also means only **one** device at a time (see §6). |

Windows credential naming (app `lib.rs` + `keyring` 3.6.3 Windows backend `target_name = "{user}.{service}"`):

| Entry | Generic credential target |
|---|---|
| Installation id (remove this one) | `installation-id.com.insightworkfolio.desktop` |
| Refresh token (cleared by Sign out; leave it) | `refresh-token.com.insightworkfolio.desktop` |

A staging build uses service `com.insightworkfolio.desktop.staging`; the production build uses the names above.

## 3. Options considered (Phase 2)

| Option | What | Production impact | Decision |
|---|---|---|---|
| **A. Existing flow: new installation** | Remove the Windows installation-id credential; app generates a new id; sign in; register. | Normal app writes only: one `devices` INSERT + one `DEVICE_REGISTERED` audit row, as for any new employee device. | **Chosen.** Documented deployed behaviour ("the employee can register a new device by signing in on it again"). |
| B. Hotfix: admin un-revoke endpoint | Patch `4d66269` (not HEAD: HEAD carries migration 0030 and unreleased work), build, deploy, restart. | Deploy + restart + new unaudited-by-design code path. | Rejected: more risk and time than A for the same result. |
| C. One-row SQL `UPDATE devices SET revoked_at = NULL …` | Reuse the old Windows row. | Direct production write, needs a hand-written audit row, forbidden by this request's rules. | Rejected. |

## 4. Isolated rehearsal (Phase 4)

A temporary git worktree at `4d66269` (deployed code, schema 0029, both production constraints), built from the
lockfile, in-memory database. Scenario file kept at
`/private/tmp/claude-501/-Users-yashsinghal-Desktop-Projects-workfolio-insight-workfolio/cce77123-0189-422a-b311-791d74e51060/scratchpad/yash-windows-unblock.e2e.test.ts`
(not added to the repository; the worktree was removed afterwards).

Reproduced: IT admin; Yash (106) with Mac registered then revoked by IT, Windows registered then revoked by IT, and a
live unbound desktop session; Suraj and Priyanshi with one authorized device each.

| Check | Result |
|---|---|
| Before: Yash signs in on Windows; old installation `REVOKED`; register 403; clock-in 403 | as in production |
| 1. Yash authenticates on Windows | pass |
| 2. New installation: `NOT_REGISTERED` → register 201 → `ACTIVE`; clock-in 200, clock-out 200 | pass |
| 3. Revoked Mac row and old Windows row byte-identical before/after | pass |
| 4. Suraj and Priyanshi: sign-in, device `ACTIVE`, clock-in 200; their device rows unchanged | pass |
| 5. No duplicate: repeat register of the new installation returns the same id; Yash has 3 rows, exactly 1 authorized | pass |
| 6. All prior audit rows unchanged; exactly one new row (`DEVICE_REGISTERED`) | pass |
| 7. Revoked-device checks: old Windows and old Mac installations still refused (clock-in 403, Mac register 403) | pass |
| Existing unbound session still valid, causes nothing | pass |
| `devices_no_delete` still refuses deletes | pass |
| Deployed limit: a second device while Windows is authorized → 409 | confirmed (expected) |
| Deployed commit's own device/auth suites (`attendance`, `device-sessions`, `devices-audit`, `auth`) | 35/35 pass |

## 5. Plan (Phase 5)

| Item | Value |
|---|---|
| Source files changed | **None** |
| Commit / branch | None. Production stays on what it runs (`4d66269`) |
| Database migration | **None** (0030/0031 not run) |
| Production SQL | **None** |
| Service restart / settings | **None** |
| Backup | Not required: no manual production write. The app writes one row through its normal path. (The nightly backup is not re-verified today; see the status audit §18.) |

### Steps (on Yash's Windows laptop, ~5 minutes)

0. Optional, from the dashboard (Super Admin): open Yash's employee page and confirm both devices show *Revoked*
   and none is active. If one is **not** revoked, stop: step 5 would answer 409 and this plan does not apply.
1. In Insight Workfolio on Windows, click **Sign out** (revokes that session on the server).
2. Quit the app fully: tray icon → **Quit** (not just close the window).
3. Remove **only** the installation-id credential, either way:
   - Control Panel → **Credential Manager** → **Windows Credentials** → *Generic Credentials* → expand
     `installation-id.com.insightworkfolio.desktop` → **Remove**; or
   - Command Prompt: `cmdkey /list | findstr installation-id` (shows the exact target), then
     `cmdkey /delete:installation-id.com.insightworkfolio.desktop`.
   Do not remove other entries.
4. Start Insight Workfolio. Sign in as `yashsinghal@tffdigital.com`.
5. The **Register this device** card appears. Enter a name (e.g. `Yash Windows`) → **Register device**.
6. Clock in, wait a minute, clock out.

### Post-checks

- Windows app: attendance card visible, no "device revoked" banner, sync shows no blocked events.
- Dashboard → Employees → Yash: three devices: the new Windows device with a recent *Last seen*, the old Windows
  and the Mac still *Revoked*.
- Dashboard → Audit (today): one `DEVICE_REGISTERED` for Yash, actor Yash; the earlier `DEVICE_REVOKED` rows by
  it@tffdigital.com still listed.
- Attendance → today: Yash's clock-in/out recorded.
- Suraj / Priyanshi: nothing to do; their next normal sign-in is unaffected.

### Rollback

Dashboard → Yash → **Revoke** on the new Windows device (existing, audited flow). That returns Yash to zero
authorized devices; all rows and history remain. Nothing on the server needs undoing.

## 6. Known consequences and limits

- **One device at a time.** Production still has `devices_one_active_per_employee`. While the Windows laptop is
  authorized, the Mac cannot be registered (409). To test the Mac on the deployed version, IT must revoke the
  Windows device first, and the Mac then needs the same credential reset (macOS Keychain item
  `installation-id`, service `com.insightworkfolio.desktop`). Using both devices without that dance needs the
  multi-device work (migration 0031), which is not part of this unblock.
- Unsynced events the Windows app queued under the **old** installation stay on the laptop and cannot upload (they
  could not upload before either, since that device is revoked). Request corrections for any missing times.
- The two Windows rows (old revoked, new authorized) remain after the multi-device feature is deployed; the old one
  just stays revoked.
- Both devices were revoked by it@tffdigital.com. If that revocation was deliberate (not test cleanup), confirm with
  IT before re-enrolling; this path is allowed by design but undoes the practical effect of their revoke.
- Physical Windows verification of steps 1–6 has **not** been performed; the rehearsal was against the API.
