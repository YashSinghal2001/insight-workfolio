# Employee invitation emails

When an IT Admin or Super Admin creates an employee, the API emails a welcome message from the IT mailbox
(`IT@TFFDigital.com`) with a one-time account activation link. The employee opens it, chooses a password and can
then sign in. No password is ever emailed: the account has none until the employee sets one.

Status (2026-11-18): **implemented and tested locally (mock provider and a fake Microsoft); not active anywhere.**
Real sending needs the Microsoft configuration in section 3 and the rollout in section 4. Until then
`INVITATION_MAIL_PROVIDER=none` (the default) keeps the previous behaviour: the admin receives the link and
hands it over.

## 1. Behaviour

| Step | What happens |
|---|---|
| Create employee (`POST /employees`) | Account, profile, setup token (sha256 only) and an invitation row `PENDING` commit in one transaction. Duplicate email or employee code: 409, nothing created, nothing sent |
| Send | Immediately, in the same request, through the configured provider. Transient failures (HTTP 429, 5xx, network) are retried twice (after 1 s and 4 s) with the same link; a refused recipient or configuration error is not retried |
| Outcome | `SENT` (provider accepted it) or `FAILED` (with a short provider error). The employee always exists exactly once, whatever the email outcome |
| Response | Without email (provider `none`, or `FAILED`): the setup link is returned so the admin can hand it over. After a successful send the admin never sees the link |
| Resend (`POST /employees/:id/invitation`) | Only for an active account without a password. Issues a **new** link (earlier links stop working) and emails it. Refused (409) while another invitation to the same person is being sent or was sent in the last 60 s; the check is inside the write, so two concurrent resends send one email |
| Activation | Unchanged `POST /auth/setup-password`: the token is single-use, expires after 72 hours, works only for the account it was issued for, and is rate-limited per IP |
| Rate limit | 30 invitation emails (create + resend) per admin per 15 minutes; the 31st request is refused with 429 before any account is created |

Statuses shown in the dashboard (Employees list, employee page, after creating):

| Status | Meaning |
|---|---|
| Pending | Being sent, or the send was interrupted (e.g. the API restarted mid-request). Resend after a minute |
| Sent | **Accepted by Microsoft 365 for delivery.** Graph `sendMail` returns no delivery confirmation; delivery to the inbox can only be checked in Exchange message trace |
| Failed | Not sent; the provider error is shown. Resend, or hand over the link shown at creation |
| Accepted | The employee set their password |
| Expired | The link expired (72 h) or was replaced by a newer link |

Security notes:

- The raw token exists only in the request and in the email. The database keeps its sha256; the invitation row,
  the audit log and the application log never contain it. The link carries it in the URL fragment, so it is
  not sent to servers (including link scanners such as Defender Safe Links) and activation needs a POST with the
  new password.
- The employee's name is HTML-escaped in the email (it is admin input).
- `saveToSentItems: false`: no copy of a live link stays in the shared IT mailbox.
- Links use `DASHBOARD_URL`, which must be `https://` in production (enforced at startup).
- RBAC (server-side): `employees:manage` (both admin identities); an IT Admin cannot invite or re-invite a Super
  Admin account; employees and signed-out callers get 403/401.
- Audit (`account_audit`): `ACCOUNT_CREATED`, `SETUP_LINK_ISSUED`, then `INVITATION_SENT` or `INVITATION_FAILED`
  (invitation id, provider, attempts; never the link or the message).

## 2. How mail is sent: two Microsoft Graph modes

**Chosen (owner decision 2026-11-18): delegated `Mail.Send` through the existing OneDrive connection**
(`INVITATION_MAIL_PROVIDER=graph-delegated`). Implemented and tested against a fake Microsoft only; **not
deployed, no real email sent.**

| Mode | How it authenticates | Needs | State |
|---|---|---|---|
| `graph-delegated` | The OneDrive connection of `IT@TFFDigital.com` (authorization code + PKCE, encrypted refresh token, `apps/api/src/storage/onedrive.ts`). `POST /me/sendMail` with that connection's access token, so the sender can only be the signed-in account | Delegated `Mail.Send` on the existing app registration, and one OneDrive reconnect after it is granted | **Chosen** |
| `graph` | App-only client credentials, `POST /users/<MAIL_SENDER>/sendMail`. The right to send comes from Exchange Online RBAC for Applications scoped to the one mailbox; a token carrying any Entra application permission is refused | An Exchange Administrator (section 3b) | Kept, unchanged, unused |

An Entra **application** `Mail.Send` (tenant-wide: the secret could send as any mailbox) is supported by neither
mode and must not be granted.

What `graph-delegated` reuses, and what changes in the OneDrive code:

- No second OAuth flow, token store or credential: `OneDriveService.token()` supplies the access token (cached,
  one refresh at a time, rotated refresh token written back atomically to `ONEDRIVE_TOKEN_FILE`, shared with the
  backup uploader).
- `Mail.Send` is added to the scopes requested at sign-in and refresh **only** when the provider is
  `graph-delegated`. A token that reports `mail.send` is accepted in every mode; any other extra scope is still
  refused.
- On HTTP 401 the transport asks for one fresh token and retries once; a second 401, or a 403, is a permanent
  failure whose message says to grant `Mail.Send` and reconnect OneDrive. 429/5xx/network errors are retried by
  the invitation flow (twice, as before). There is no fallback to another provider: a failed send is `FAILED`
  and the admin gets the hand-over link.
- Invitations are recorded with provider `graph` in both modes (no migration; `0030` is unchanged).

Consequence to accept: whoever holds the encrypted token file, its key and the client secret together can send
mail as `IT@TFFDigital.com` (and nobody else), in addition to reading that account's OneDrive.

## 3. Microsoft configuration required

### 3a. `graph-delegated` (chosen)

Done by an Entra administrator, **only in the order given in section 4** (a build without this change refuses a
token that reports `Mail.Send`, which stops OneDrive storage and the off-site backup).

1. Entra admin center › App registrations › "Insight Workfolio" › API permissions › Add › Microsoft Graph ›
   **Delegated** › `Mail.Send`. Grant admin consent. Resulting list: `Files.ReadWrite`, `Mail.Send`,
   `offline_access`, `openid`, `profile`. No application permission. Follow the SEC-11 re-consent guard in
   `docs/security.md`.
2. No new secret, redirect URI or platform change: the existing Web platform, callback and client secret are used.
3. Confirm `IT@TFFDigital.com` is a mailbox that can send, and that SPF, DKIM and DMARC for `TFFDigital.com` cover
   Microsoft 365, or invitations may land in spam.

### 3b. `graph` (app-only, not used)

Done by an **Exchange Administrator**; do **not** add or consent any API permission in Entra for this mode.

```powershell
New-ServicePrincipal -AppId <client-id> -ObjectId <enterprise-app-object-id> -DisplayName "Insight Workfolio invitations"
New-ManagementScope -Name "Insight Workfolio sender" -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'IT@TFFDigital.com'"
New-ManagementRoleAssignment -App <client-id> -Role "Application Mail.Send" -CustomResourceScope "Insight Workfolio sender"
Test-ServicePrincipalAuthorization -Identity <client-id> -Resource IT@TFFDigital.com   # expect InScope: True
```

([RBAC for Applications in Exchange Online](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac).)
Variables: `INVITATION_MAIL_PROVIDER=graph`, `MAIL_GRAPH_TENANT_ID`, `MAIL_GRAPH_CLIENT_ID`,
`MAIL_GRAPH_CLIENT_SECRET`, `MAIL_SENDER`; the API refuses to start unless all four are set.

## 4. Environment variables and rollout (`graph-delegated`)

| Variable | Value |
|---|---|
| `INVITATION_MAIL_PROVIDER` | `graph-delegated` (`none` = default, admin hands the link over; `mock` = development/tests only, refused in production) |
| `MAIL_SENDER` | `IT@TFFDigital.com`. Must equal `ONEDRIVE_ACCOUNT_EMAIL` (case-insensitive) or the API refuses to start |
| `ONEDRIVE_*` | Already set for storage; all seven are required. No `MAIL_GRAPH_*` value is used |
| `DASHBOARD_URL` | Already set; base of the activation link. Must be `https://` |

`REPORT_MAIL_PROVIDER` is separate: this does not turn on report emails. The same provider and sender also carry
the role-based notifications ([notifications.md](notifications.md)), which additionally need migration
`0033_notifications`.

Production rollout, each step only after the owner's approval. The order keeps OneDrive storage and the nightly
off-site backup working throughout:

1. **Before anything:** confirm the last nightly backup and its off-site copy
   (`systemctl status workfolio-backup`, `backup-upload.js list`) and `/api/v1/ready`.
2. **Deploy the code** with the environment unchanged (`INVITATION_MAIL_PROVIDER` still unset). Migration
   `0030_account_invitations` must be applied (`deploy.sh <sha> --migrate` applies it after a backup if it is
   not). Check `/api/v1/ready` and `backup-upload.js check`. From here on a token reporting `Mail.Send` is tolerated.
3. **Entra:** add delegated `Mail.Send` and grant consent (section 3a). Wait an hour or force a refresh
   (`backup-upload.js check`) and confirm storage is still up.
4. **Environment:** add `INVITATION_MAIL_PROVIDER=graph-delegated` and `MAIL_SENDER=IT@TFFDigital.com` to
   `/etc/workfolio/api.env`. Secrets are not touched. Restart the API. Never do this step before step 3: a
   refresh that asks for an ungranted `Mail.Send` is refused by Microsoft and storage reports "reconnect OneDrive"
   (recovery: finish step 3, or remove the two lines and restart; the stored refresh token is not consumed by a
   refused request).
5. **Reconnect OneDrive** as `IT@TFFDigital.com` (Settings › Microsoft OneDrive › Reconnect) at a time away from
   the 02:30 UTC backup. The new connection replaces the encrypted token file atomically; the backup uploader
   reads the same file on its next run, so both keep sharing one valid refresh token. Do not run
   `backup-upload.js` during the sign-in.
6. **Verify storage:** `/api/v1/ready`, Settings › Microsoft OneDrive status, `backup-upload.js check` (forces a
   refresh through the new token and writes the rotated one back).
7. **Verify mail:** create one test employee with a mailbox you control: status `Sent`, an `INVITATION_SENT`
   audit row, the message arrives from IT@, nothing in Sent Items, the link activates once.
8. **Next morning:** the scheduled off-site backup ran (`journalctl -u workfolio-backup`, `backup-upload.js list`).

Rollback: remove the two lines and restart (invitations fall back to the hand-over link); storage is unaffected.
Removing `Mail.Send` in Entra afterwards is safe with this build in either mode `none` or `graph`.

Troubleshooting (the text is what the invitation shows as its failure reason):

| Message | Meaning and fix |
|---|---|
| `Microsoft Graph refused to send as the connected account (HTTP 403, ErrorAccessDenied)` | The connection's token has no `Mail.Send`: grant it (3a), then reconnect OneDrive (step 5) |
| `No Microsoft token from the OneDrive connection: OneDrive is not connected yet` | Connect OneDrive in Settings |
| `... OneDrive authorization expired or was revoked; reconnect OneDrive` | The refresh token was revoked, expired, or the refresh asked for `Mail.Send` before it was granted (step 4 before step 3) |
| `... carries a scope beyond Files.ReadWrite and Mail.Send` | The app registration holds an extra delegated permission: remove it in Entra. Storage is stopped by the same check |
| `... belongs to another app registration, tenant or account` | The token file is from another account or app: reconnect as `IT@TFFDigital.com` |
| `Microsoft Graph sendMail failed (HTTP 400, ErrorInvalidRecipients)` | Bad recipient address; not retried |
| Boot error naming `INVITATION_MAIL_PROVIDER` | `ONEDRIVE_*` incomplete, or `MAIL_SENDER` is not `ONEDRIVE_ACCOUNT_EMAIL` |

Recommendation before going live: the production `DASHBOARD_URL` is a bare IP address. Activation links to an IP
address from a company mailbox look like phishing and are more likely to be filtered; a DNS name for the dashboard
is advisable first.

## 5. Tests

| Test | Where | Result (2026-11-12) |
|---|---|---|
| Creation sends one email to the right recipient, exact subject, https link with token in the fragment, escaped name, expiry in the employee's time zone, IT contact; no password exists; only the hash stored; token in no table, audit row or log | `apps/api/test/invitations.e2e.test.ts` (mock) | PASS |
| Activation via the emailed link; single use; ACCEPTED; resend refused after activation; made-up token refused | same | PASS |
| Duplicate email (case-insensitive) and invalid email refused with nothing sent | same | PASS |
| Transient retries (3 attempts, one email), FAILED after 3, permanent failure not retried, link returned on failure, audit rows | same | PASS |
| Resend: new link, old link dead, 60 s cooldown, concurrent resends send exactly one email | same | PASS |
| Expiry shown and enforced; disabled account not re-invited | same | PASS |
| RBAC: employee 403 (create, resend, own resend), signed-out 401, IT Admin 403 on a Super Admin account; nothing sent | same | PASS |
| Rate limit: 31st invitation per admin refused, no account created; other admins unaffected | same | PASS |
| Graph transport: client-credentials token, `POST /users/IT%40TFFDigital.com/sendMail`, HTML body, one recipient, `saveToSentItems: false`, token cached; tokens with any application permission refused; 429/5xx/network transient, 4xx permanent, 401 refreshes the token; secret never in errors | same, fake `fetch` (no Microsoft contact) | PASS |
| Delegated transport (2026-11-18): `POST /me/sendMail` with the OneDrive token, payload, 401 → one fresh token and one retry, second 401 and 403 permanent with a reconnect hint, 429/5xx/network transient, no token without a connection, no token or response text in errors; with the real `OneDriveService`: `Mail.Send` requested only in this mode, rotated refresh token persisted, wider token refused, other account refused | same, fake `fetch` (no Microsoft contact) | PASS |
| OneDrive scope policy: `Mail.Send` tolerated, `Files.ReadWrite` still required, other mail and wide scopes refused | `apps/api/test/onedrive.e2e.test.ts` | PASS |
| Configuration validation (incl. `graph-delegated`: OneDrive settings required, `MAIL_SENDER` = OneDrive account) | `apps/api/test/env.test.ts` | PASS |
| Admin UI in Chrome: create → "Invitation sent" (mock labelled as not emailed, no link shown), emailed link activates the account, failure shows reason and hand-over link, resend from the employee page, list badges, "Invitation accepted" | `apps/dashboard/scripts/verify-invitations.mjs` (mock) | PASS 11/11 |

**Not tested (needs the rollout in section 4):** real sending through Microsoft Graph, whether a refresh after
the Entra grant returns `Mail.Send` without a reconnect, actual delivery, spam placement. No email was sent to anyone during development.
