# Screenshot storage: Microsoft Graph (SharePoint / OneDrive for Business)

## Mode `SCREENSHOT_STORAGE=onedrive`: the IT storage account's OneDrive (2026-11-03)

**Status: connected in production since 2026-11-11** to the real `IT@TFFDigital.com` account, for the off-site
database backups only; screenshots and timelapses are still off (no policy enables them). Verified on the real
account: sign-in, token encryption at rest, refresh-token rotation and persistence, readiness, upload, hash match,
download and restore rehearsal. One isolation probe (`/me/insights/shared`) answers 200 with an empty list; accepted
by the owner as PARTIAL with restrictions (keep the account storage-only). Evidence:
[status/HOSTINGER-VPS-IMPLEMENTATION-STATUS.md](status/HOSTINGER-VPS-IMPLEMENTATION-STATUS.md) §9 to §15. Earlier
report (fake Microsoft only): [status/ONEDRIVE-INTEGRATION-REPORT.md](status/ONEDRIVE-INTEGRATION-REPORT.md).

- **Auth:** delegated OAuth 2.0 authorization code + PKCE, confidential client (secret on the API only).
  The IT account signs in once; the app gets **`Files.ReadWrite` + `offline_access`** (+ `openid profile`
  for the sign-in name). That is the account's own files only: no SharePoint sites, no other users, nothing
  shared with it, no application permission, no admin consent for tenant-wide access, no site or folder grant.
  A token reporting any other scope (e.g. `*.All`, `Sites.*`) is refused; another account or tenant is refused.
- **Tokens:** the refresh token is kept only in `ONEDRIVE_TOKEN_FILE` (persistent disk, 0600), AES-256-GCM
  encrypted with `ONEDRIVE_TOKEN_KEY`. Microsoft rotates it on every refresh; the new one is written back
  atomically, so the connection survives restarts. Access tokens live in memory (refreshed 5 minutes
  before expiry, and once on a 401). Revoked or expired: uploads fail as "reconnect OneDrive" (desktops keep
  their queue), the dashboard shows "Needs attention".
- **Layout** (all under `ONEDRIVE_ROOT_FOLDER`, default `InsightWorkfolio`, created at connect):
  `screenshots/teams/<team id>/<employee id>/<yyyy-mm>/<id>.webp`, `screenshots/unassigned/...` (no team),
  `timelapses/<employee id>/<id>.mp4`. Folders are IDs, never names. Access is enforced by the API (admin,
  team-head scope, the employee), never by folder permissions; nothing is shared or linked.
- **Same adapter:** `GraphStorage` in delegated mode (rows record `MICROSOFT_GRAPH`; no migration needed).
- **Database backups (2026-11-05):** the nightly, gpg-encrypted database backup is uploaded into
  `<ONEDRIVE_ROOT_FOLDER>/<ONEDRIVE_BACKUP_FOLDER>` (default `db-backups`, a sibling of `screenshots/` and
  `timelapses/`, never inside them) by `apps/api/src/cli/backup-upload.ts`, a short-lived process started by
  the VPS backup timer that reuses this connection (same token file, same scope). Both processes re-read the
  token file before every refresh, so the rotated refresh token is followed by whichever process did not
  rotate it. The uploader refuses unencrypted files and deletes nothing unless `ONEDRIVE_BACKUP_KEEP_DAYS` is
  set (then older backups go to the recycle bin). Details: `deploy/README.md` "Backups".
- **Dashboard:** Settings › Microsoft OneDrive: account, status, usage, team folders, last upload, last
  check, Connect/Reconnect, Disconnect. No token or secret is ever sent to the dashboard or desktops.
- **Verify on the real account** (after connecting): `pnpm --filter @workfolio/api verify:onedrive <env-file>`
  (read-only: token refresh, drive, isolation probes), then with `--write --teams <id,id,id>`.

### Microsoft 365 setup for this mode (needs approval; no new subscription)

1. **New** Entra app registration (not the Sites.Selected app: see the SEC-11 guard below): single tenant,
   platform **Web**, redirect URI `https://<API host>/api/v1/storage/onedrive/oauth/callback`
   (and `http://localhost:4000/...` for a local test), a client secret.
2. API permissions: Microsoft Graph **delegated** `Files.ReadWrite`, `offline_access`, `openid`, `profile`.
   No application permissions. If the tenant blocks user consent, an admin consents to exactly these.
3. Optional hardening: Enterprise app › Properties › *Assignment required* = Yes, assign only `IT@TFFDigital.com`.
4. Set the `ONEDRIVE_*` variables on the API, then an admin opens Settings › Microsoft OneDrive › Connect
   and signs in as `IT@TFFDigital.com`.

---

The rest of this page describes the earlier **app-only SharePoint mode** (`SCREENSHOT_STORAGE=graph`).

**Status: Microsoft Graph storage is NOT verified against a real tenant.** No Microsoft 365
credentials were provided. The storage interface (`FileStorage`) and the Microsoft Graph adapter
(`apps/api/src/screenshots/storage.ts`) are complete and exercised only against a **fake (mocked)
Graph** in tests (`apps/api/test/graph-storage.test.ts`): secret and certificate credentials,
throttling retry, 401 re-authentication, request timeouts, malformed responses, upload, lookup
with SharePoint's QuickXorHash, download, recycle-bin and permanent delete, site-scope check.

So it is **not production-ready**. In production the API refuses to start unless
`SCREENSHOT_STORAGE=graph` (local storage is development-only), so a production deployment with
screenshots is blocked until `pnpm --filter @workfolio/api verify:graph` passes against the real
site. Development and tests use the clearly labelled `LOCAL_DEV` adapter (files on the API
server's disk, directory forced to 0700 on POSIX).

## Provider decision and the rejected OneDrive-folder option (2026-11-02)

**Decision: pending the user's final approval.** The authoritative conclusion is
[INSIGHT-WORKFOLIO-FINAL-STORAGE-DECISION.md](../INSIGHT-WORKFOLIO-FINAL-STORAGE-DECISION.md) (a
**dedicated SharePoint site** with a `Sites.Selected` site grant, as described below), confirmed by
[STORAGE-RECOMMENDATION-AND-ROADMAP.md](../STORAGE-RECOMMENDATION-AND-ROADMAP.md). Google Drive was
built only as a testing prototype (`SCREENSHOT_STORAGE=google-drive`, GOOGLE-DRIVE-STORAGE-SETUP.md) and
is not a production option. Those documents hold the reasoning; this page does not restate it.

- **Rejected: a folder in a personal OneDrive** (`Files.SelectedOperations.Selected` with a folder-level
  `write` grant). The T5 boundary probe failed: SharePoint added **Limited Access** role assignments for
  the app on the OneDrive site and its `Documents` library, so the app could read site, drive and root
  metadata outside the folder. Those entries are not removed when the folder grant is deleted.
- **Rollback executed (2026-11-02, approved by the user):** the folder grant was deleted, admin consent
  for `Files.SelectedOperations.Selected` was revoked, and the final app-only probe returned **403 on
  14/14 checks** (token roles: `Sites.Selected` only). The app has no OneDrive access. The two Limited
  Access entries still exist but are **dormant**.
- **Remaining manual cleanup (the user, optional but recommended):**
  1. remove the app's dormant Limited Access entries from the OneDrive site and its `Documents` library
     (as the site owner; the steps are in the decision document §6);
  2. revoke Graph Explorer's delegated `Files.ReadWrite` consent for the account used for the grant;
  3. remove the unconsented `Files.SelectedOperations.Selected` and the unused `User.Read` permissions
     from the app registration, leaving only `Sites.Selected`.

> **Guard (SEC-11): never re-consent `Files.SelectedOperations.Selected` for this app.** The dormant
> Limited Access entries would re-activate immediately, without any new grant (observed on 2026-11-02),
> and expose the OneDrive's metadata again. Any future consent change on this app needs a fresh
> app-only probe showing 403 outside the target before and after.

## Flow

1. The desktop captures, encodes WebP and queues the file locally (it never holds storage credentials).
2. `POST /api/v1/screenshots/register` — metadata only (time, size, dimensions, SHA-256). The API
   checks device, policy, consent, attendance and spacing, and assigns a server-generated
   storage key `<employee uuid>/<yyyy-mm>/<random uuid>.webp` (no names or content).
3. `PUT /api/v1/screenshots/:id/content` — the bytes, through the API. The API verifies size,
   WebP header, dimensions and checksum, uploads to Graph, then **looks the file up again** and
   compares the size and SharePoint's own content hash (QuickXorHash, the hash OneDrive for
   Business/SharePoint expose; they do not offer SHA-256) with the hash of the received bytes. Only then is the row `STORED` and the desktop told so (this is the
   "complete" step; the desktop never asserts completion itself).
4. Viewing: `GET /api/v1/screenshots/:id/content` streams the bytes through the API to an admin
   or the employee it belongs to, with `Cache-Control: no-store`; every view is written to
   `screenshot_access_log`. No sharing links or public URLs are created; Graph's short-lived
   download redirect is followed by the API and never reaches a browser. Downloads are bounded: more than
   10 MB (declared or streamed) is refused without buffering it, then size, WebP header and the
   registered size are checked before any byte is sent.
5. Retention: once approved in Settings, expired files are deleted through Graph and the
   metadata row is kept, marked `DELETED` with who/when; each run is recorded with its deletion
   mode. **Default `GRAPH_PERMANENT_DELETE=false`: files go to the site recycle bin** (first stage,
   then second stage; up to 93 days in total) and are recoverable there, so a deletion is not
   permanent until the bin is emptied. `true` uses `permanentDelete` (bypasses the recycle bin).
   Either way, **Microsoft 365 retention policies or holds** on the site (Purview) can keep a copy in
   the Preservation Hold Library; the app cannot see or override those. Ask the tenant admin which apply.

## Microsoft 365 setup (needs a tenant admin; no new paid subscriptions)

Use a **company-owned SharePoint site**, never a personal OneDrive account.

1. **Site and library:** create a dedicated SharePoint site (e.g. "Workfolio Screenshots") with
   no members beyond the IT owners. Its default "Documents" library holds the files in a folder
   (`GRAPH_FOLDER`, default "Workfolio Screenshots"). Do not share the site with staff.
2. **App registration** (Entra ID › App registrations › New): single tenant, no redirect URI.
   Preferred credential: a **certificate** (upload the public certificate; keep the PKCS#8 private
   key file only on the API server: `GRAPH_CERT_KEY_PATH` + the SHA-1 thumbprint Entra shows,
   `GRAPH_CERT_THUMBPRINT`). Alternatively a **client secret** (`GRAPH_CLIENT_SECRET`). Exactly one
   must be set. Keep either only in the API's secret store, never in the repository or on desktops.
3. **API permission: `Sites.Selected` (Application)** for Microsoft Graph, then "Grant admin
   consent". This permission alone gives access to **no** site.
4. **Grant the app write access to the one site** (a tenant admin, e.g. with Graph Explorer or
   PowerShell):
   ```http
   POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions
   { "roles": ["write"], "grantedToIdentities": [{ "application": { "id": "<client id>", "displayName": "Insight Workfolio" } }] }
   ```
   Do **not** grant `Files.ReadWrite.All` or `Sites.ReadWrite.All` (tenant-wide).
5. **Site ID and drive ID:** `GET https://graph.microsoft.com/v1.0/sites/{hostname}:/sites/{path}`
   → `id` (`GRAPH_SITE_ID`, format `host,siteCollectionId,webId`); then
   `GET https://graph.microsoft.com/v1.0/sites/{site-id}/drives` → the `id` of the "Documents"
   library → `GRAPH_DRIVE_ID`. The API checks that the drive belongs to that site (`verify:graph`).

## API environment

| Variable | Meaning |
| --- | --- |
| `SCREENSHOT_STORAGE` | `graph` (required in production) or `local` (development only) |
| `GRAPH_TENANT_ID` | Directory (tenant) ID |
| `GRAPH_CLIENT_ID` | Application (client) ID |
| `GRAPH_CLIENT_SECRET` | Client secret value (server only; never logged, never sent to desktops) |
| `GRAPH_CERT_KEY_PATH`, `GRAPH_CERT_THUMBPRINT` | Certificate credential instead of a secret (PKCS#8 key file path, SHA-1 thumbprint) |
| `GRAPH_SITE_ID` | Graph site ID of the dedicated screenshot site |
| `GRAPH_DRIVE_ID` | Drive ID of the dedicated library |
| `GRAPH_PERMANENT_DELETE` | `false` (default): retention deletes go to the recycle bin; `true`: `permanentDelete` |
| `GRAPH_FOLDER` | Folder inside the library (default `Workfolio Screenshots`) |
| `SCREENSHOT_LOCAL_DIR` | Development storage directory (default `./data/screenshots`) |

Graph calls used: client-credentials token (`login.microsoftonline.com/{tenant}/oauth2/v2.0/token`,
scope `https://graph.microsoft.com/.default`, cached until 5 minutes before expiry), simple
upload `PUT /drives/{id}/root:/{path}:/content` (files up to 250 MB; screenshots are capped at
10 MB), lookup `GET /drives/{id}/root:/{path}`, download `…:/content`, delete `DELETE /drives/{id}/root:/{path}`.
Every token and Graph request (including reading the body) is aborted after 30 s. A 401 is retried
once with a fresh token. Errors (HTTP status, timeout, unreachable, or a body that is not valid JSON)
are reported as "Microsoft Graph upload failed (HTTP 503, serviceNotAvailable)" without response
bodies, tokens or the secret; the desktop sees only "storage unavailable, will retry" (HTTP 502).

Each screenshot row records the provider it was stored with. A row stored with another provider
(dev/staging after switching `SCREENSHOT_STORAGE`) is not readable on this server (HTTP 409) and is
skipped by retention (never marked deleted while its file still exists elsewhere).

## Verification (before calling it production-ready)

```bash
# apps/api/.env (never committed) or the shell: GRAPH_* as above
pnpm --filter @workfolio/api build && pnpm --filter @workfolio/api verify:graph
```

Uses only a synthetic 1×1 WebP in a `verify-<uuid>` folder and deletes it. Checks, each PASS/FAIL:
1. server-side token; 2. the drive belongs to `GRAPH_SITE_ID`; 3. upload; 4. returned item id,
size and QuickXorHash match; 5. download and SHA-256 match; 6. re-upload to the same key replaces in
place; 7. a simulated 503 is retried and recovers; 8. delete; 9. the file is gone from the
library (and where it went: recycle bin or permanent); 10. the tenant root site is **not**
readable (proves `Sites.Selected`, not tenant-wide access). Without credentials it prints
`BLOCKED` and contacts nothing (exit code 2).

Then, end to end on staging: set `SCREENSHOT_STORAGE=graph`, run
`pnpm --filter @workfolio/desktop verify:screenshots`, open the dashboard gallery, confirm the
files in the SharePoint folder, approve a short retention on staging and run a purge, and check
the site recycle bin. Rotate the credential and confirm the API works after a restart.

## Remaining Graph work

- **Real-tenant `verify:graph` run** (above) and the staging end-to-end check. Until then Graph is
  verified only against a fake.
- **`permanentDelete` permission:** confirm on the real site that `Sites.Selected` with `write`
  allows `POST /items/{id}/permanentDelete` (it may need `fullcontrol` on the site); until then keep
  `GRAPH_PERMANENT_DELETE=false` (recycle bin).
- **Upload sessions for files > 250 MB:** only simple upload is implemented (screenshots are capped
  at 10 MB). Any future, larger file kind needs `createUploadSession` with chunked uploads.
- **Startup diagnostic:** call `driveBelongsToSite()` at API start (log a clear error when the drive
  is not in `GRAPH_SITE_ID`); today it runs only in `verify:graph`.

## Known gaps

- Not verified against a real tenant (above). Throttling and transient errors (429/502/503/504)
  are retried twice inside one request (honouring `Retry-After`, at most 5 s); beyond that the
  desktop backs off (30 s … 1 h).
- QuickXorHash is implemented from Microsoft's published algorithm and checked against
  hand-computed values; its agreement with SharePoint is confirmed only by `verify:graph` step 4.
  If it ever disagreed, uploads would fail safely (stay queued on desktops), not be marked stored.
- SharePoint recycle bin and versioning keep deleted/replaced files for a while; the retention
  promise must account for that (site settings or a recycle-bin purge step).
