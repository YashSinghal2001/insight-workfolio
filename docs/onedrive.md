# Screenshot storage: Microsoft Graph (SharePoint / OneDrive for Business)

**Status (Day 8): real-tenant verification BLOCKED: no Microsoft 365 credentials were
provided.** The storage interface and the Microsoft Graph adapter
(`apps/api/src/screenshots/storage.ts`) are complete and exercised against a **fake Graph** in
tests (`apps/api/test/graph-storage.test.ts`): secret and certificate credentials, throttling
retry, upload, lookup with SharePoint's QuickXorHash, download, recycle-bin and permanent delete,
site-scope check. It has **not** been run against a real tenant, so it is **not production-ready**
and production stays on `SCREENSHOT_STORAGE` unset/`local`, which the API refuses to start with in
production, until `pnpm --filter @workfolio/api verify:graph` passes against the real site. Development uses the clearly labelled `LOCAL_DEV` adapter (files on the API server's
disk), which the API refuses to start with in production.

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
Errors are reported as "Microsoft Graph upload failed (HTTP 503, serviceNotAvailable)" without
response bodies, tokens or the secret; the desktop sees only "storage unavailable, will retry".

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

## Known gaps

- Not verified against a real tenant (above). Throttling and transient errors (429/502/503/504)
  are retried twice inside one request (honouring `Retry-After`, at most 5 s); beyond that the
  desktop backs off (30 s … 1 h).
- QuickXorHash is implemented from Microsoft's published algorithm and checked against
  hand-computed values; its agreement with SharePoint is confirmed only by `verify:graph` step 4.
  If it ever disagreed, uploads would fail safely (stay queued on desktops), not be marked stored.
- SharePoint recycle bin and versioning keep deleted/replaced files for a while; the retention
  promise must account for that (site settings or a recycle-bin purge step).
