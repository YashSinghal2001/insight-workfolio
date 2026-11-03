# Provisioning the initial accounts

How to create the first three kinds of account securely: the **Super Admin** (CEO), the **IT
Admin**, and **employees**. No account exists until someone runs these steps; nothing is seeded,
and there is **no default password** anywhere (tested: `account-lifecycle.e2e.test.ts` scans the API
source and checks every new account has `password_hash IS NULL`).

Placeholders: `<super-admin-email>`, `<it-admin-email>`, `<employee-email>`, `<employee-code>`.
Use the real company addresses only when you actually run the commands.

## How a setup link works (verified by tests)

| Property | Implementation | Test |
| --- | --- | --- |
| Random | 32 bytes from `crypto.randomBytes`, base64url (43 chars) | two links differ, format checked |
| Stored hashed | only `sha256(token)` in `account_setup_tokens.token_hash`; the plaintext is returned once | stored row = sha256, plaintext absent |
| Expires | 72 h (`SETUP_TOKEN_TTL_MS`) | expiry ≈ now + 72 h; an expired link is refused |
| Single use | consumed in the same transaction that sets the password | second use → 400 |
| Reissue invalidates | a new link marks every earlier unused link used | old link → 400, new one works |
| Password hashing | Argon2id (m=19 MiB, t=2, p=1), PHC string | `$argon2id$v=19$m=19456,t=2,p=1$…`, verifies |
| Sessions revoked | setting a password revokes all of the account's sessions | old cookie and refresh token → 401 |
| Not in logs or servers | link carries the token in the URL fragment (`/setup-password#token=…`), never sent to servers; request logs drop query strings and bodies | — |

Disabled accounts cannot sign in or refresh, and their live sessions stop at once; re-enabling
restores sign-in (tested).

## 1. Super Admin (CEO)

Run once, on the server, with the production environment (same `DATABASE_URL`,
`DATABASE_AUTH_TOKEN`, `DASHBOARD_URL` as the API):

```bash
pnpm build:packages && pnpm --filter @workfolio/api build
pnpm --filter @workfolio/api admin:create --email <super-admin-email> --super-admin
```

- Creates the account with role `ADMIN`, title `SUPER_ADMIN`, **no password**, and prints a one-time
  link valid for 72 h. Nothing is written to log files.
- **Who opens the link:** the Super Admin themself. The operator hands it over in person (or the
  Super Admin runs the command); never via chat, email or tickets.
- If the link expires or is lost before a password is set, re-run the same command: it issues a
  fresh link and the old one stops working. Once a password is set, re-running does nothing.

## 2. IT Admin

```bash
pnpm --filter @workfolio/api admin:create --email <it-admin-email> --additional
```

- `--additional` is required because an admin now exists (the tool refuses otherwise).
- Creates an Admin (same permissions as the Super Admin, but cannot grant or remove Super Admin).
- **Who opens the link:** the IT Admin themself, delivered as above.
- Alternative: create the IT Admin as an employee from the dashboard (step 3) and have the Super
  Admin promote them on **Roles** (reason required; recorded in the role history). That gives them an
  employee profile too.

## 3. Employees (dashboard)

1. Sign in as an admin → **Employees** → **Add employee** (`<employee-email>`, full name,
   `<employee-code>`, time zone).
2. The dashboard shows the one-time setup link **once**. Deliver it in person or over a trusted
   company channel; **the employee opens it** and chooses a password (12–128 characters).
3. Lost link or password reset: employee page → **New setup link** (earlier links stop working).
   Setting the new password signs the employee out everywhere.

## What is audited

All in `account_audit` (append-only, see [audit.md](audit.md)), written in the **same transaction**
as the change, so there is never a change without its row or the reverse. Metadata holds ids, counts
and field names only: no email, password, token, hash or field values.

| Event | Action | Actor | Metadata |
| --- | --- | --- | --- |
| `admin:create` creates an admin | `ACCOUNT_CREATED` | server (null) | `{ via: "cli", identity: "SUPER_ADMIN" \| "ADMIN" }` |
| `admin:create` prints a link (new or re-run) | `SETUP_LINK_ISSUED` | server (null) | `{ expiresAt }` |
| Admin adds an employee | `ACCOUNT_CREATED` + `SETUP_LINK_ISSUED` | the admin | `{ employeeId }`, `{ expiresAt }` |
| Admin edits an employee | `ACCOUNT_UPDATED` (only if something changed) | the admin | `{ employeeId, fields: "fullName,timezone" }` |
| Admin disables an account | `ACCOUNT_DISABLED` | the admin | `{ employeeId, sessionsRevoked }` |
| Admin re-enables an account | `ACCOUNT_ENABLED` | the admin | `{ employeeId }` |
| Admin issues a new setup link | `SETUP_LINK_ISSUED` | the admin | `{ expiresAt }` |
| Password set through a link | `PASSWORD_SET` | the account | `{ sessionsRevoked }` |

Role changes are recorded in `role_changes` (who, from, to, reason), not duplicated here. No-ops (same
status, unchanged fields) and refused changes write nothing.

## How to verify afterwards

1. Super Admin signs in → `GET /api/v1/auth/me` returns `platformRole: "SUPER_ADMIN"` (the **Roles**
   page lists the identity of every account).
2. IT Admin signs in → `platformRole: "ADMIN"`. On **Roles**, they cannot grant or remove Super Admin (403).
3. An employee signs in to the dashboard → redirected to `/my`; admin routes return 403.
4. **Audit** page (source *Account*): one `ACCOUNT_CREATED` and at least one `SETUP_LINK_ISSUED` per
   account (actor *System* for the two CLI accounts, the admin for employees), and one `PASSWORD_SET`
   per account that completed setup.
5. Old links: opening a superseded or used link shows "invalid or has expired".
6. Safeguards: the last active Super Admin cannot be demoted or disabled (409), nobody can change
   their own role or disable themself.

## Notes and limits

- An admin **without** an employee profile has no employee page, so the dashboard cannot issue them
  a new link; before their first password, re-run `admin:create`; afterwards a password reset needs
  an employee profile (or a CLI step not built yet).
- The CLI's actor is recorded as the server (null); who ran it is outside the application (shell
  access to the server).
