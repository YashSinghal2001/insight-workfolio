# Employee invitation emails

When an IT Admin or Super Admin creates an employee, the API emails a welcome message from the IT mailbox
(`IT@TFFDigital.com`) with a one-time account activation link. The employee opens it, chooses a password and can
then sign in. No password is ever emailed: the account has none until the employee sets one.

Status (2026-11-12): **implemented and tested locally with a mock provider; not active anywhere.** Real sending
needs the Microsoft configuration in section 3, done by a Microsoft 365 administrator, and the environment
variables in section 4. Until then `INVITATION_MAIL_PROVIDER=none` (the default) keeps the previous behaviour:
the admin receives the link and hands it over.

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

## 2. Can the existing Microsoft app send mail?

**Not today.** The existing "Insight Workfolio" registration (state recorded 2026-11-11; not re-checked in the
portal for this change) has only delegated `Files.ReadWrite`, `offline_access`, `openid`, `profile`, used by the
OneDrive connection of `IT@TFFDigital.com`. It has no `Mail.Send` of any kind. OneDrive permissions do not
authorise sending mail.

Ways to add sending, and why the implementation uses app-only with Exchange scoping:

| Option | Effect | Verdict |
|---|---|---|
| Add **delegated** `Mail.Send` to the existing app | Microsoft lists every consented delegated scope in the app's tokens. The OneDrive code refuses any token with a scope beyond `Files.ReadWrite` (`apps/api/src/storage/onedrive.ts`, `scopesAcceptable`), so **OneDrive storage and the nightly off-site backup would stop**. Would also need a second sign-in flow and token store | Not used |
| Add **application** `Mail.Send` in Entra with admin consent | Tenant-wide: the app's secret could send as **any** mailbox in the tenant. Exchange scoping does not narrow an Entra grant (the grants are additive) | Refused by the code: a token carrying any application permission is not used |
| **Exchange Online RBAC for Applications**: role "Application Mail.Send" assigned to the app's service principal with a management scope containing only `IT@TFFDigital.com` | App-only token with no Entra application permission; Exchange allows sending as that one mailbox only. No change to the app's Entra permissions, so OneDrive's delegated tokens are unaffected | **Implemented** |

The scoped option can use the existing registration (same tenant ID, client ID and secret). Consequence to accept:
that client secret, which today is useless without the encrypted OneDrive token file, would on its own be able to
send mail as `IT@TFFDigital.com`. A dedicated registration would isolate rotation and revocation but not reduce
what its own secret can do; creating one needs your approval and was not done.

## 3. Microsoft configuration required (administrator approval)

Done by an **Exchange Administrator** (and an Entra admin only for the object ID lookup). Nothing here was done
by this change.

1. Confirm `IT@TFFDigital.com` is a mailbox that can send (licensed user mailbox or shared mailbox).
2. Entra admin center › Enterprise applications › "Insight Workfolio" (the existing registration, or a dedicated
   one if you choose that): note the **Application (client) ID** and the enterprise application's **Object ID**.
   Do **not** add or consent any API permission. Follow the SEC-11 re-consent guard in `docs/security.md` before
   touching the registration at all.
3. Exchange Online PowerShell (`Connect-ExchangeOnline` as an Exchange Administrator):

   ```powershell
   New-ServicePrincipal -AppId <client-id> -ObjectId <enterprise-app-object-id> -DisplayName "Insight Workfolio invitations"
   New-ManagementScope -Name "Insight Workfolio sender" -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'IT@TFFDigital.com'"
   New-ManagementRoleAssignment -App <client-id> -Role "Application Mail.Send" -CustomResourceScope "Insight Workfolio sender"
   ```

4. Verify the scope (expect `InScope: True` for the IT mailbox and `False` for any other mailbox):

   ```powershell
   Test-ServicePrincipalAuthorization -Identity <client-id> -Resource IT@TFFDigital.com
   Test-ServicePrincipalAuthorization -Identity <client-id> -Resource <any-other-mailbox>
   ```

5. Mail authentication for `TFFDigital.com` (SPF, DKIM, DMARC) should already cover Microsoft 365; confirm, or
   invitations may land in spam.

Check Microsoft's current documentation for these cmdlets at setup time
([RBAC for Applications in Exchange Online](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac)).

## 4. Environment variables (API host, never committed)

| Variable | Value |
|---|---|
| `INVITATION_MAIL_PROVIDER` | `graph` (`none` = default, admin hands the link over; `mock` = development/tests only, refused in production) |
| `MAIL_GRAPH_TENANT_ID` | Directory (tenant) ID |
| `MAIL_GRAPH_CLIENT_ID` | Application (client) ID from step 2 |
| `MAIL_GRAPH_CLIENT_SECRET` | That app's client secret. Typed by the owner into the server's environment file only; never into chat, a ticket or the repository |
| `MAIL_SENDER` | `IT@TFFDigital.com` (sender and the support address named in the email) |
| `DASHBOARD_URL` | Already set; base of the activation link. Must be `https://` |

The API refuses to start with `graph` unless all four `MAIL_*` values are set. `REPORT_MAIL_PROVIDER` is separate:
this does not turn on report emails.

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
| Configuration validation | `apps/api/test/env.test.ts` | PASS |
| Admin UI in Chrome: create → "Invitation sent" (mock labelled as not emailed, no link shown), emailed link activates the account, failure shows reason and hand-over link, resend from the employee page, list badges, "Invitation accepted" | `apps/dashboard/scripts/verify-invitations.mjs` (mock) | PASS 11/11 |

**Not tested (blocked on section 3):** real sending through Microsoft Graph, the Exchange mailbox scope, actual
delivery, spam placement. No email was sent to anyone during development.
