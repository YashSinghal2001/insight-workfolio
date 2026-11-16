# Multi-device registration with one active sign-in (Phases 3–7, 9–10)

Status: implemented locally, uncommitted, **not deployed, migration not applied anywhere but tests**.

## 1. Model

Four separate things:

| Concept | Where | Notes |
|---|---|---|
| Device registration | `devices` row | Many per employee. One row per (employee, installation). Kept forever (delete refused). |
| Authentication session | `sessions` row | Hashed refresh token, 30-day absolute expiry, WEB or DESKTOP. |
| Active session ownership | `sessions.device_id` on a live row | **At most one per account**, enforced by `UNIQUE INDEX sessions_one_active_device_per_user ON sessions(user_id) WHERE device_id IS NOT NULL AND revoked_at IS NULL`. |
| Revocation history | `account_audit` (resource `DEVICE`) | Who/when/why for revoke, approvals, re-registration, sign-ins, switches, refusals. Append-only. |

Device status shown everywhere: **ACTIVE** (holds the live sign-in), **INACTIVE** (registered, signed out), **REVOKED** (not authorized; may show "re-registration approved"). Inactive ≠ revoked.

Web (dashboard) sessions are never bound to a device and never count: a browser is not a registered device and cannot write device-bound records.

## 2. Database — migration `0031_multi_device_single_session`

Next free id after 0030; no historical migration edited.

- `DROP INDEX devices_one_active_per_employee` — the approved exception to "additive only" (removes a limit, no data).
- `CREATE INDEX devices_identifier` (ownership checks, inventory).
- `devices.reregistration_approved_at`, `devices.reregistration_approved_by`.
- Existing rows, so the new unique index can be built without signing anybody out:
  - expired-but-unrevoked device sessions → `revoked_at = expires_at` (they were already unusable);
  - several live sessions bound at once for one account (repeat sign-ins on one installation) → the most recently used stays bound, the others are **unbound, not revoked**.
- `CREATE UNIQUE INDEX sessions_one_active_device_per_user`.

## 3. Sign-in, switch and logout (server-enforced)

All claims go through `claimDeviceSession()` (`apps/api/src/auth/device-session.ts`), one write transaction:

1. end this account's expired device sessions (they no longer hold the slot);
2. end older sessions on **the same** installation (a repeat sign-in replaces itself);
3. only with `takeover: true`: end the session on the other device (audited `DEVICE_SESSION_TAKEOVER`);
4. bind: insert the new session already bound (login) or bind the existing session (register / older apps) — re-checking inside the transaction that the device is still unrevoked;
5. audit `DEVICE_SESSION_STARTED`.

If another device still holds the sign-in, step 4 violates the unique index, the transaction rolls back, a `DEVICE_SESSION_REJECTED` row is written and the client gets **409 `ACTIVE_ON_ANOTHER_DEVICE`** with the active device's name, OS, last seen and since. No session or token is issued. Two concurrent sign-ins cannot both succeed: the database refuses the second, across processes and restarts.

- `POST /auth/login` (desktop) now takes `installationId` and optional `takeover`:
  - registered + authorized installation → becomes the active device or 409;
  - not yet registered → an unbound session, used only to register (the desktop signs it out again if registration answers 409);
  - revoked, not approved → **403 `DEVICE_REVOKED`** (after the password check; audited);
  - revoked and approved → unbound session to complete re-registration.
- **Takeover ("Switch to this device")**: a separate button shown only after a 409; it resubmits the sign-in form, so it needs the password at that moment, and is audited. It is never implicit.
- **Logout**: revokes the session (refresh and access token stop at once), frees the slot, device becomes INACTIVE, audited `DEVICE_SESSION_ENDED` (`SIGNED_OUT`).
- **Refresh**: unchanged; a revoked or expired session can never be refreshed, so no session resurrection.
- `DevicesService.require()` (every device-bound write) now accepts only the session that is that device's active sign-in; a session bound to another device → 403; another device active → 409.

### Stale-session policy

A missed heartbeat never signs a device out. A sign-in ends only by: logout; the employee's **"Sign out this device"** in the dashboard (My profile → My devices); an admin's **End sign-in**; an explicit password-confirmed **Switch to this device**; revocation; or the 30-day absolute expiry. None of these can leave two active sign-ins. Unsynced records stay on the device and upload at its next sign-in (existing behaviour).

## 4. Registration and revocation

- `POST /devices/register`: idempotent per installation (same record, no duplicate audit). A new installation is recorded even while another device is active (then 409, registered + INACTIVE). A session already bound to device A cannot enroll device B (403).
- An installation still authorized for **another employee** → 409 `DEVICE_OWNED_BY_ANOTHER_EMPLOYEE` (no silent ownership transfer). The other employee's `X-Device-Id` is useless anyway (lookups are per employee).
- **Revoke** (`POST /devices/:id/revoke`, optional `reason`): ends that device's sessions in the same transaction, withdraws any approval, keeps the record, audits actor + reason. Other devices untouched.
- **Re-registration**: `POST /devices/:id/allow-reregistration` (admin) marks a revoked device approved — nothing is reactivated and no old token is restored. The employee must sign in on that computer with their password and register it; that consumes the approval and reuses the same record (history intact). Old installation id or tokens alone never restore access.

## 5. API changes

| Method | Path | Permission | Purpose |
|---|---|---|---|
| POST | `/auth/login` | public | + `installationId`, `takeover` |
| GET | `/devices` | `devices:read` | all devices with employee and status |
| GET | `/devices/:id/history` | `devices:read` | device audit trail |
| POST | `/devices/:id/revoke` | `devices:manage` | + optional `reason` |
| POST | `/devices/:id/allow-reregistration` | `devices:manage` | approve re-registration |
| POST | `/devices/:id/end-session` | `devices:manage` | end sign-in, keep registration |
| POST | `/devices/mine/:id/end-session` | `sessions:own` | employee signs out own device (others' → 404) |
| GET | `/devices/me` | own | status now ACTIVE / INACTIVE / REVOKED / NOT_REGISTERED + `activeDevice` |

`Device` gains `status`, `sessionStartedAt`, `lastLoginAt`, `reregistrationApprovedAt`. `ApiError` gains optional `code` and `details` (passed through by the exception filter only for our own coded errors). New audit actions: `DEVICE_REREGISTRATION_APPROVED`, `DEVICE_REREGISTERED`, `DEVICE_SESSION_STARTED`, `DEVICE_SESSION_ENDED`, `DEVICE_SESSION_TAKEOVER`, `DEVICE_SESSION_REJECTED`.

RBAC follows the existing design: both admin identities hold `devices:read`/`devices:manage`; only a Super Admin manages a Super Admin's devices (revoke, end sign-in, approve); employees cannot list, revoke or manage any device and only see their own.

## 6. Dashboard

- New **Admin → People → Devices** page: per employee — name, email, code, number of registered devices, the device signed in, and a table (device, OS, status, registered, last seen, last sign-in) with **End sign-in**, **Revoke** (reason required in the UI), **Approve re-registration**, **History**.
- Employee detail page: same table and "Signed in on X since …".
- **My profile → My devices** (employee): all own devices, which one is signed in, status badges, **Sign out this device** for the active one. No revoke for employees (policy unchanged).
- Audit page labels for the new actions.

## 7. Desktop

- Sign-in sends the installation id. 409 → message naming the active device and a **Switch to this device (signs the other device out)** button. 403 `DEVICE_REVOKED` → message.
- Registration answering 409 → the provisional sign-in is signed out and the switch is offered.
- Revoked + approved → the register form is shown again; INACTIVE → explains which device is signed in.
- Same code path on Windows and macOS (no per-OS rules).

## 8. Files

API: `auth/device-session.ts` (new), `auth/auth.service.ts`, `auth/auth.controller.ts`, `devices/devices.service.ts`, `devices/devices.controller.ts`, `employees/employees.service.ts`, `common/all-exceptions.filter.ts`.
Database: `migrations.ts` (0031). Shared: `api.ts`, `audit.ts`, `attendance.ts`, `schemas.ts`.
Dashboard: `components/devices.tsx` (new), `(admin)/devices/page.tsx` (new), `(admin)/employees/[id]/page.tsx`, `my/profile/page.tsx`, `components/sidebar.tsx`, `(admin)/audit/page.tsx`.
Desktop: `session.ts`, `main.ts`, `index.html`, `tray-bridge.ts`, `monitoring.ts`, `activity-ui.ts`, `screenshot-ui.ts`.
Tests: see `DEVICE-MANAGEMENT-TEST-RESULTS.md`.

## 9. Limitations

- **Desktop 0.2.0 (already distributed)** does not send the installation id at sign-in. It keeps working and is held to the same rule when it first touches the device (409 on writes), but it cannot show the INACTIVE explanation or the switch button. Ship a new desktop build with this API.
- A desktop sign-in on a not-yet-registered installation gets a short-lived unbound session (web-equivalent rights only; cannot write device-bound records) so it can register; the app signs it out on conflict.
- Re-registration approval does not expire.
- An installation shared by two employees on the same OS user account is now refused for the second employee until an admin revokes it for the first.
- Login rate limits remain in-memory per process (existing ponytail note).
- No physical Windows or macOS verification has been performed.
