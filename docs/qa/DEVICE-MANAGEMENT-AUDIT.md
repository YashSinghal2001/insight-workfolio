# Device management audit (Phases 1–2)

Date: 2026-11-16 · Branch `deploy/hostinger-vps` · Audited at `b7a328e` (contains `03421f8` and migration 0030).
Working tree was clean before this work. Nothing was deployed, migrated, committed or pushed.

## 1. What existed

| Area | Implementation (before) |
|---|---|
| Device record | `devices` (0001): `employee_id`, `device_name`, `platform` (`macos`/`windows`), `device_identifier` = SHA-256 of a random installation UUID kept in the OS credential store (`src-tauri/src/lib.rs: installation_id`), `registered_at`, `last_seen_at`, `revoked_at`. `UNIQUE(employee_id, device_identifier)`. Deletes refused by trigger (0016). Live-state columns (0029). |
| One-device rule | `devices_one_active_per_employee`: partial UNIQUE index on `devices(employee_id) WHERE revoked_at IS NULL` (0002, "MVP policy"). |
| Sessions | `sessions` (0001/0015/0023): hashed refresh token, absolute expiry 30 days, `client` WEB/DESKTOP, `device_id` (0023, bound lazily). |
| Login | `POST /auth/login` — email + password + `client`. No device information. Any number of concurrent desktop sessions. |
| Device binding | `DevicesService.touch()` bound the calling session to the device on register / `GET /devices/me` / every device-bound write, "first device wins", no conflict check. |
| Refresh | Rotation with compare-and-swap; presenting a superseded token revokes the session (`SESSION_REUSE_DETECTED`); revoked/expired/disabled → 401. Sound; kept unchanged. |
| Logout | Revokes the session of the presented refresh token. Not audited. |
| Revoke | `POST /devices/:id/revoke` (`devices:manage` = both admin identities). Sets `revoked_at`, revokes sessions bound to the device in the same transaction, audits `DEVICE_REVOKED`. Only a Super Admin manages a Super Admin's devices. |
| Device-bound writes | Attendance sync/clock actions, activity sync, screenshot register/upload all go through `DevicesService.require()` (desktop session + known, unrevoked installation via `X-Device-Id`). |
| RBAC | `devices:read` / `devices:manage` = ADMIN (Super Admin and IT Admin share them; Super Admin-only list is `screenshots:delete`, `storage:manage`, `roles:manage`). Employees read their own devices via `GET /employees/:id/devices` (others' → 404). |
| Dashboard | Admin employee page: device list + Revoke. My profile: device list ("Active" meant "not revoked"). No device overview. |
| Desktop | Login form → `GET /devices/me` → register form if `NOT_REGISTERED` and no other device; if another device exists: "Ask an administrator to revoke it". |

## 2. Root causes

1. **Second device impossible.** The partial unique index `devices_one_active_per_employee` allows one unrevoked device per employee. `register()` turned the violation into 409 "Another device is already registered. Ask an administrator to revoke it first." The desktop hid the register form whenever `otherActiveDevice` was true.
2. **A revoked computer can never be added again.** `register()` returned 403 for an existing revoked row, and `UNIQUE(employee_id, device_identifier)` stops a new row for the same installation. The installation id lives in the OS credential store and never changes, so that computer was blocked permanently (only a different installation could be enrolled).
3. **"Registered" and "signed in" were the same thing.** There was no notion of an active login: unlimited concurrent desktop sessions per account, bound lazily without any check. "Active" in the UI meant "not revoked".
4. **Logout left no trace** in the audit, and nothing reported which device held the sign-in.

## 3. Things checked and found sound (reused)

- Tokens: refresh tokens stored only as SHA-256; access tokens are 15-min JWTs re-validated against the session row on every request (so revocation is immediate).
- Revocation already ends the device's sessions atomically (API-08).
- `account_audit` is append-only (triggers) and already accepts resource type `DEVICE`.
- Installation ids are never returned or audited.

## 4. Data

- Local `apps/api/data/dev.db`: schema at `0019`, **0 devices**. Nothing to report locally.
- Production (`/var/lib/workfolio/db/workfolio.db` on the VPS): **not inspected** — no shell access from this machine and no authorization to touch production. See `DEVICE-REVOCATION-RESET-REPORT.md` for the read-only query to run there.
