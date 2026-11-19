# macOS physical QA: multi-device registration and single active sign-in (2026-11-16)

> Public repository: no real employee, email, password, token or production device appears here. All accounts
> are synthetic (`*@qa.invalid`) in a throwaway QA database.

## Verdict

**MACOS MULTI-DEVICE QA PARTIAL**

Every macOS test that was executed passed (35 PASS, 0 FAIL). The verdict is PARTIAL, not PASS, because:

1. **No physical Windows machine took part.** It cannot reach a QA API on this Mac: debug builds allow plain
   `http` only to `localhost`, and release builds require `https`. Phase 8 was run against a **simulated Windows
   client** at the API level, using the same endpoints and payloads as the app. Those rows are marked
   PASS (simulated).
2. The Mac app was a **debug, unsigned** build with a QA identity, not a signed/notarized release build. Release
   Keychain ACL and Gatekeeper behaviour are untested.
3. UI actions (typing, Sign in, Register, Sign out, Switch to this device) were driven through the app's built-in
   debug harness (`WF_E2E_SCRIPT`). It submits the real forms in the real webview, which uses the real Keychain and
   IPC, but no human mouse clicks were involved. A reboot was not tested.

## 1. Environment

| Item | Value |
|---|---|
| Hardware | Apple M2, model `Mac14,2` (MacBook Air M2), 16 GB |
| macOS | 27.2 (build 26B123) |
| Branch / HEAD | `deploy/hostinger-vps` @ `d38cd053883d25f70ea690026fa9d6a495ebad14` (working tree clean before and after) |
| Feature commit | `a097b63b5a39a64911e87f7ccae060aa2b44d398`, an ancestor of HEAD. HEAD adds only one doc file on top |
| Desktop app | `@workfolio/desktop` **0.2.0** (version not bumped by the feature), Tauri 2, `tauri build --debug --bundles app` |
| QA app identity | bundle id `com.insightworkfolio.desktop.qa`, product "Insight Workfolio QA", Keychain service `com.insightworkfolio.desktop.qa` (compiled via `WORKFOLIO_KEYCHAIN_SERVICE`; confirmed with `strings` on the binary) |
| QA API | HEAD `apps/api` build, `NODE_ENV=development`, `127.0.0.1:4000`, clean `env -i` environment (no repo `.env`, no staging file) |
| QA database | new SQLite file in the session scratchpad. Migrations 0001 → **0031_multi_device_single_session** applied at boot **to that file only** |
| Screenshot storage | `local`, scratch directory. Stayed empty |
| QA dashboard | `apps/dashboard` dev server on `localhost:3000`, `NEXT_PUBLIC_API_URL=http://localhost:4000` |
| Accounts | `qa-admin@qa.invalid` (Admin), `qa-employee@qa.invalid` / `QA-001` (employee). Random passwords kept only in the scratchpad |

Production was not touched. There was no deployment, no production API call, no production migration and no
production record change. The production Keychain items' modification dates were identical before and after
the run (§4).

## 2. Code review (Phase 1)

- Installation ID: `installation_id()` (`apps/desktop/src-tauri/src/lib.rs`) reads Keychain account
  `installation-id` under the compiled service. On `NoEntry` it creates a random UUIDv4 once. No hardware
  identifiers are used. The server stores only `sha256(installationId)` (`devices.device_identifier`). This was
  verified: `f8078f02…` → `cedf609b…`.
- Refresh token: Keychain account `refresh-token`, same service. The access token is kept in memory only. Logout
  deletes `refresh-token` and never touches `installation-id`.
- Sign-in: `POST /auth/login` with `installationId`. A 409 `ACTIVE_ON_ANOTHER_DEVICE` reveals a separate
  **Switch to this device** submit button. Only that button sends `takeover: true` (`main.ts`).
- Server: `claimDeviceSession()` runs in one transaction, guarded by the unique partial index
  `sessions_one_active_device_per_user`. The active device is decided by `revoked_at` / `expires_at` only, and
  `last_seen_at` (heartbeat) never ends a session.

## 3. Results

Legend: PASS = executed and met expectation. PASS (simulated) = executed against the simulated Windows client.
BLOCKED = not executable here.

### Phase 3: registration

| # | Test | Result | Evidence |
|---|---|---|---|
| 3.1 | Launch app | PASS | Login view, `v0.2.0`, QA installation ID created in Keychain at 16:54:35Z |
| 3.2 | Sign in (unregistered installation) | PASS | Signed in, **Register this device** form shown, unbound DESKTOP session |
| 3.3 | Register | PASS | `DEVICE_REGISTERED {platform: macos}` + `DEVICE_SESSION_STARTED`. Attendance card visible |
| 3.4 | Device in admin Devices | PASS | Dashboard → Devices: "QA MacBook Air M2 · macOS · Active · signed in", registered 22:24 IST |
| 3.5 | Name / platform / time / status | PASS | DB: `macos`, `registered_at 16:54:55Z`. "My devices" API: status ACTIVE |
| 3.6 | Quit and reopen | PASS | Session restored on relaunch (refresh rotated), signed-in view |
| 3.7 | Same installation ID | PASS | `f8078f02-…` on every launch (14 launches) |
| 3.8 | No duplicate | PASS | 1 device row |

### Phase 4: logout and login

| # | Test | Result | Evidence |
|---|---|---|---|
| 4.1 | Sign out | PASS | Session `7a4248b1` revoked 16:55:39Z, `DEVICE_SESSION_ENDED {cause: SIGNED_OUT}`, Keychain `refresh-token` deleted |
| 4.2 | Registration kept | PASS | Device row unchanged, not revoked |
| 4.3–4.4 | Sign in again reuses record | PASS | New session `d6f59084` bound to the same device `a4465f36`. No register form |
| 4.5 | Active session is the Mac | PASS | 1 live bound session → `a4465f36` |
| 4.6 | Old token rejected | PASS | Pre-logout refresh token replayed from inside the app → **401** |

### Phase 5: Keychain

| # | Test | Result | Evidence |
|---|---|---|---|
| 5.1 | Installation ID persists across restarts | PASS | See 3.7 |
| 5.2 | Logout keeps device identity | PASS | QA `installation-id` mdat unchanged (16:54:35Z) after 2 logouts. Only `refresh-token` removed |
| 5.3 | Revoked device can't silently restore | PASS | See 6.6–6.7 |
| 5.4 | Re-registration needs approval + password | PASS | See Phase 7 |
| 5.5 | No unrelated items removed | PASS | Only the two exact QA items were read (metadata only, no secrets). Production items unchanged (§4) |
| 5.6 | Uninstall / reinstall | PASS (documented) | A fresh copy of the bundle launched from another folder: same installation ID, **session restored without sign-in**, same device record. Deleting the app does **not** delete Keychain items, so a reinstall is the same device, and a revoked device stays revoked after reinstall. Only deleting the `installation-id` item creates a new device identity (see Bug 1) |

### Phase 6: revocation

| # | Test | Result | Evidence |
|---|---|---|---|
| 6.1–6.2 | Revoke from QA Admin Dashboard | PASS | Reason entered in modal → "Device revoked. Other devices are unaffected." |
| 6.3 | Status Revoked | PASS | Badge "Revoked". DB `revoked_at 16:56:55.117Z`. Audit `DEVICE_REVOKED` with reason |
| 6.4 | Active session ends | PASS | Session `d6f59084` `revoked_at` = same instant |
| 6.5 | Protected requests rejected | PASS | App's stored refresh token → 401 at relaunch. A revoked active device's old access token → `/auth/me` 401, `/attendance/sync` 401, refresh 401 (run on the simulated Windows device, 9.1) |
| 6.6 | Restart app | PASS | "Your session has ended. Please sign in again.", Keychain token cleared |
| 6.7 | No silent reactivation | PASS | Password sign-in → **403 `DEVICE_REVOKED`**: "This device was revoked by an administrator…". No session issued. `DEVICE_SESSION_REJECTED {cause: DEVICE_REVOKED}` |

### Phase 7: re-registration

| # | Test | Result | Evidence |
|---|---|---|---|
| 7.1 | Approve in dashboard | PASS | Modal "Nothing is reactivated now and no old sign-in is restored" → badge "Revoked · re-registration approved" |
| 7.2 | Approval audited | PASS | `DEVICE_REREGISTRATION_APPROVED` 16:57:31Z |
| 7.3 | Approval alone restores nothing | PASS | App relaunch after approval: still login view, no token |
| 7.4 | Sign in + register | PASS | Password sign-in → register form → register → ACTIVE |
| 7.5 | Authorised | PASS | `DEVICE_REREGISTERED {platform: macos}`, `revoked_at` and `reregistration_approved_at` cleared (approval consumed) |
| 7.6 | History preserved | PASS | Full trail kept: REGISTERED → SESSION_STARTED → ENDED → STARTED → REVOKED (reason) → REJECTED → REREGISTRATION_APPROVED → REREGISTERED → STARTED |
| 7.7 | No duplicate | PASS | Still device `a4465f36` only |

### Phase 8: cross-device switching (Windows **simulated**)

The Mac side is the real app. The Windows side is `win.mjs`: separate installation ID, `platform: windows`, origin
`http://tauri.localhost`, the same requests the Windows app sends.

| # | Test | Result | Evidence |
|---|---|---|---|
| 8.1–8.2 | Mac signed in and active | PASS | 1 live bound session → Mac |
| 8.3–8.4 | Windows sign-in → conflict | PASS (simulated) | New installation: login 200 (unbound) → register **409 `ACTIVE_ON_ANOTHER_DEVICE`** "…signed in on QA MacBook Air M2 (macOS)…", device recorded INACTIVE. App-equivalent sign-out. Next login → 409 with `activeDevice` details |
| — | Switch with wrong password | PASS (simulated) | 401, Mac stays active |
| 8.5–8.6 | Switch to this device + password | PASS (simulated) | `takeover: true` → 200. `DEVICE_SESSION_TAKEOVER` audited |
| 8.7 | Mac session invalid | PASS | Mac session `revoked_at` = takeover instant. Mac app relaunch → "Your session has ended", token cleared |
| 8.8 | Windows active | PASS (simulated) | `/devices/me` → ACTIVE |
| 8.9 | Windows logout | PASS (simulated) | 204. Old access token → 401, old refresh → 401 |
| 8.10 | Mac signs in again | PASS | Plain sign-in, no conflict, ACTIVE |
| 8.11 | Reverse switch (Mac UI) | PASS | Windows took over. Then on the Mac: plain sign-in showed "…signed in on QA Windows PC (simulated) (Windows)…" **and the Switch button**. Pressing it signed the Mac in. Windows' access and refresh tokens → **401** immediately |
| 8.x | Physical Windows | **BLOCKED** | No route from a Windows build to a local QA API (http only to loopback in debug, https only in release). Needs an https QA/staging API |

### Phase 9: security

| # | Test | Result | Evidence |
|---|---|---|---|
| 9.1 | Revoked installation can't reuse tokens | PASS | Windows active → admin revoke → its old access token `/auth/me` 401, `/attendance/sync` 401, refresh 401 |
| 9.2 | Unapproved registration rejected | PASS | Revoked Windows: desktop login 403 `DEVICE_REVOKED`. `POST /devices/register` from a web session → 403. Employee self-approve → 403. Device stays revoked |
| 9.3 | Logout invalidates sessions | PASS | 4.6, 8.9, final logout (401) |
| 9.4 | Missed heartbeat doesn't log out | PASS (code + observation) | Active check uses only `revoked_at` / `expires_at` (`device-session.ts`). The Mac session survived every app-closed gap (no heartbeats) until an explicit action ended it. Gaps were minutes long, not hours |
| 9.5 | Simultaneous sign-ins | PASS | 20 parallel plain sign-ins (10 Mac, 10 Windows): 5×200 (Mac, each replacing itself), 5×409, 10×**429** (login rate limit). **1** live bound session. 10 parallel takeovers from both → all 200, still **1** live bound session |
| 9.6 | History / audit intact | PASS | No audit rows deleted or changed. Device table rows never deleted |
| 9.7 | Platforms distinguished | PASS | `macos` / `windows` on rows. Conflict messages say "(macOS)" / "(Windows)". "My devices" lists both |
| — | Web session unaffected by switching | PASS | Employee web session stayed live throughout |

### Excluded and not tested (as instructed)

Active/idle, breaks, screenshots, activity, keyboard/mouse, attendance, timelapse. Nobody clocked in. QA DB after
the run: `activity_intervals 0`, `screenshots 0`, `attendance_events 0`, `timelapses 0`. The screenshot directory
is empty.

## 4. Keychain findings

| Item (service / account) | Before | After | Notes |
|---|---|---|---|
| `com.insightworkfolio.desktop` / `installation-id` (production) | mdat 2026-10-12 17:52:42Z | **unchanged** | not read, not written |
| `com.insightworkfolio.desktop` / `refresh-token` (production) | mdat 2026-11-16 14:44:56Z | **unchanged** | not read, not written |
| `com.insightworkfolio.desktop.qa` / `installation-id` | absent | created 16:54:35Z, never modified | left in place (harmless QA identity) |
| `com.insightworkfolio.desktop.qa` / `refresh-token` | absent | absent (signed out at the end) | written/rotated/deleted by the app during tests |

No Keychain permission prompt appeared, including for the relocated "reinstalled" bundle.

To remove the QA identity later, delete only that item:
`security delete-generic-password -s com.insightworkfolio.desktop.qa -a installation-id`.

## 5. Bugs and findings

**1. A new installation registers as an authorized device without admin approval** (security / policy; confirms
readiness blocker 5).
Repro: with device A active, sign in from a never-seen installation ID and `POST /devices/register` → the row
is created as authorized (`DEVICE_REGISTERED`). The response is 409 only because A holds the session. After
A signs out, the new device signs in freely. On macOS this also means deleting the `installation-id` Keychain item
(or a different macOS user account) produces a fresh, unapproved but authorized device next to a revoked one.
Revocation is per installation, not per computer. This needs the owner's decision: accept, or make new devices
start PENDING.

**2. Debug and dev builds share the production Keychain service and app-data identifier** (developer safety).
`KEYCHAIN_SERVICE` falls back to `com.insightworkfolio.desktop` unless `WORKFOLIO_KEYCHAIN_SERVICE` is set. The
bundle identifier is the production one unless overridden. On a Mac that also runs the production app,
`pnpm tauri dev` or `verify:*` scripts (their header says "the app's saved sign-in and installation ID are
replaced") will overwrite the production refresh token and installation ID and share the production SQLite queue.
Running the dev app could therefore register this Mac in a test DB under its production identity, or sign the
production app out. Not executed (to avoid harm). Found by code review, and avoided here with a QA identity.
Suggested fix: default debug builds to a `.dev` service and identifier.

**3. Desktop version not bumped.** The feature build still reports `v0.2.0`, the same as the distributed build
without the switch UI. Users and support cannot tell them apart (readiness blocker 3).

**4. Login rate limit under bursts.** 10 of 20 simultaneous sign-ins got 429. This is expected protection, not a
defect, but a burst from one IP can lock a user out for the window.

**5. Repository hygiene (not part of this feature).** HEAD `d38cd05` adds
`docs/qa/YASH-WINDOWS-LOGIN-UNBLOCK-PLAN-2026-11-16.md`, which contains 2 email addresses. The readiness doc
said to exclude or redact this file. The commit is on `origin/deploy/hostinger-vps` and `origin/main`, and the
repository is **public**. Not changed here (no commit/push permitted). The owner should redact it and consider
history rewriting.

## 6. Logs and evidence

Kept in the session scratchpad, which is not durable: `api.log`, `dashboard.log`, `build.log`, per-step app
snapshots `p3-*.json` … `p9-*.json` and `final-logout.json`, the Phase 9 output `p9.json`, and harness scripts
`app.mjs` (real app driver), `win.mjs` (simulated Windows), `phase9.mjs`, `state.sh` (read-only DB view),
`seed.mjs`. Dashboard screenshots: Devices page Active, after Revoke, and after approval.

## 7. To reach PASS

1. Run Phase 8 with a physical Windows machine against an **https** QA/staging API (`WORKFOLIO_ENV=staging`
   builds on both machines, so each has its own Keychain/Credential Manager service).
2. Repeat Phases 3–7 once on a signed release build (`pnpm package`, staging identity), including a reboot.
3. Decide on Bug 1.
