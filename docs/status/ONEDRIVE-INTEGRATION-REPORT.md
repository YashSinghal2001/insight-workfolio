# OneDrive (IT@TFFDigital.com) integration report

Date: 2026-11-03. Scope: Microsoft 365 OneDrive of the dedicated IT storage account as Insight Workfolio's
file store, with Turso as the database. Nothing was committed, pushed or deployed. No Microsoft setting,
permission, consent or app registration was changed. No Turso data was written and no migration was applied.

**Bottom line: IMPLEMENTED and TESTED against a fake Microsoft only. NOT connected to the real account, so
NOT production-ready.** The remaining steps are Microsoft 365 setup that needs your approval (§8).

## 1. Inspection findings

| Item | Finding |
| --- | --- |
| Storage abstraction | `FileStorage` (`apps/api/src/screenshots/storage.ts`): put / putFile (chunked) / stat / get / getStream / delete; adapters LocalDev, GraphStorage (app-only, SharePoint `Sites.Selected`), GoogleDriveStorage (testing POC). **Extended, not duplicated:** GraphStorage gained a delegated mode. |
| Earlier Microsoft grants | `Files.SelectedOperations.Selected` folder grant: probe failed (Limited Access leaked), **rolled back 2026-11-02**. The old app keeps `Sites.Selected` consent only; two dormant Limited Access entries remain (manual cleanup still open, docs/onedrive.md). **Not reused.** SEC-11: never re-consent that permission on that app. |
| Three teams | **None exist in Workfolio.** Staging Turso: 0 teams, 0 members, 0 users, 0 screenshots, 0 timelapses (read-only count). Local `dev.db` is at migration 0019, before teams existed (0024), so it has no teams table (read-only; hash unchanged). Your Microsoft 365 account (the project owner's work account) belongs to **one** Microsoft Team, "TFF Digital" (Team ID redacted): not three, and not Workfolio teams. **The three names and IDs cannot be reported: please tell me where they live.** The mapping is automatic for any team, so nothing needs reconfiguring once they exist. |
| Settings UI | Settings › Storage (read-only probe) existed. **Settings › Microsoft OneDrive** was added. |
| Migrations 0018 / 0020 | Reserved placeholders with no content (no file, no SQL). Untouched. Screenshot rows already accept `MICROSOFT_GRAPH`, which the OneDrive mode records, so **no migration is needed**. |
| Screenshot / timelapse architecture | Desktop queues offline and uploads bytes through the API only. The API verifies the bytes and the provider's confirmation before a row is marked STORED; retention deletes through storage. Timelapses were previously a cache on the API host's disk; **they now go to storage**. |

## 2. Implemented (code)

| Area | What | Files |
| --- | --- | --- |
| Auth | Delegated OAuth 2.0 auth code + PKCE + single-use state + browser-binding cookie; confidential client. Only `ONEDRIVE_ACCOUNT_EMAIL` in `ONEDRIVE_TENANT_ID` is kept; any scope beyond the allow-list (`Files.ReadWrite`, `openid`, `profile`, `email`, `offline_access`, `User.Read`) is refused. | `apps/api/src/storage/onedrive.ts` |
| Token store | Refresh token kept only in `ONEDRIVE_TOKEN_FILE` (0600), AES-256-GCM encrypted with `ONEDRIVE_TOKEN_KEY`. Rotated token written back atomically; one refresh at a time; a refresh racing a disconnect never resurrects it. | same |
| Status / disconnect | `GET /storage/onedrive/status` (settings:manage): account, connected, live check, quota, last upload, last check, team folder mapping; never a token. `POST /storage/onedrive/disconnect` deletes the token file. | same |
| Storage | `SCREENSHOT_STORAGE=onedrive` uses GraphStorage with delegated tokens and the connected drive and app folder. 401 triggers one fresh token; 429/5xx retried; chunked upload sessions; bounded downloads. | `storage.ts`, `app.module.ts` |
| Team separation | Keys: `screenshots/teams/<team id>/<employee id>/<yyyy-mm>/<id>.webp`, `screenshots/unassigned/...`. The team is the earliest membership at registration; the key is immutable after that. Authorization is still enforced by the API (admin / team-head scope / self). | `storage.ts`, `screenshots.service.ts` |
| Timelapses | Encoded locally, then `putFile` to storage at `timelapses/<employee id>/<id>.mp4`. Size is confirmed before READY; the video streams back through the API and is deleted from storage on expiry, deletion or replacement. A storage outage leaves it to the next sweep. | `timelapse.service.ts` |
| Config | `ONEDRIVE_*` variables, validated: all or none, https callback in production, 32-byte key, absolute token path, email. | `config/env.ts`, `.env.example` |
| Dashboard | Settings › Microsoft OneDrive: provider, connected account, status, usage, team mapping, last upload, last check, Connect/Reconnect, Disconnect (with confirmation). | `apps/dashboard/src/app/(admin)/settings/page.tsx` |
| Real-account verifier | `pnpm --filter @workfolio/api verify:onedrive <env> [--write --teams a,b,c]`. Read-only part: token refresh, drive identity, quota, isolation probes. Write part: per-team-folder upload, hash, download, delete, then list, an 11 MiB chunked upload, and cleanup. Exits 2 (blocked) when not configured or not connected. | `apps/api/scripts/verify-onedrive.mjs` |
| Docs | docs/onedrive.md (new mode + setup), docs/timelapse.md | |

The following were not built:
- **A generic "authorized file uploads" feature.** Workfolio has no general file-upload feature today. `FileStorage` can host one, but it needs a files table, i.e. a new migration.
- **A `list` operation in FileStorage.** The app never lists files; the verifier lists through Graph instead.

## 3. Test results

All tests ran locally against a **fake** Microsoft identity platform and Graph. No real tenant was involved.

| Test | Result |
| --- | --- |
| API suite | **414 / 414 pass** (adds onedrive.e2e 9 tests, env test, team-folder test; timelapse/delete tests updated for storage) |
| Dashboard | typecheck, lint, build + smoke (35 routes) pass |
| Workspace typecheck + lint (incl. desktop clippy) | pass |
| Connect flow: PKCE, S256, login_hint, secret never in URL | pass (mocked) |
| Wrong account / wrong tenant / `Files.ReadWrite.All` / no binding cookie | refused, nothing kept (mocked) |
| Token file encrypted, 0600; wrong key refused | pass |
| Upload, stat, download, delete (idempotent); only the app folder addressed | pass (mocked) |
| Token refresh with rotation persisted; 401 then fresh token | pass (mocked) |
| Connection survives API restart | pass (mocked: new app instance, same encrypted file) |
| Revoked authorization: clear "reconnect" error, nothing marked stored | pass (mocked) |
| Disconnect, then reconnect reuses the folder (no duplicate) | pass (mocked) |
| Screenshots through the real API, in team folders; Turso checksum = bytes in "OneDrive" | pass (mocked) |
| Cross-team: team head of A reads A (200), B's file denied (404); B's employee cannot read A | pass |
| Timelapse through the API: upload session, sha256 = Turso, streamed back, deleted from storage | pass (mocked) |
| No SharePoint site or other-user endpoint is ever called | pass (mocked) |
| **Real Microsoft:** auth, restart, upload/download/list/delete, 3 team mappings, isolation probes, refresh | **NOT RUN** (blocked on §8) |

## 4. Answers to the final checklist

1. **Authentication:** delegated OAuth 2.0 authorization code + PKCE (confidential client). Scopes: `Files.ReadWrite`, `offline_access`, `openid`, `profile`. No application permissions, no `Sites.*`, no `*.All`, no admin consent for tenant-wide access. Microsoft Learn: the permission reference lists `Files.ReadWrite` as the signed-in user's files with admin consent "No"; `site-post-permissions` needs `Sites.FullControl.All` to grant a site.
2. **Storage location:** `IT@TFFDigital.com`'s OneDrive (tffdigital-my.sharepoint.com), folder `/InsightWorkfolio` (created at connect).
3. **Three teams:** not found (§1). Folder per team = `InsightWorkfolio/screenshots/teams/<team id>`; no team = `.../screenshots/unassigned`; videos = `InsightWorkfolio/timelapses/<employee id>`.
4. **Operations:** connect, status, folder creation, upload (simple and chunked), download (bounded, streamed), stat, delete (recycle bin by default), refresh, disconnect. Listing exists only in the verifier.
5. **Tests:** §3. Every pass is against a fake Microsoft; real-account tests have not been run.
6. **Isolation:** API-level cross-team denial passes. The scope allow-list is enforced. Real isolation probes (`/sites/root`, `/users`, `sharedWithMe`, `/me/insights/shared`) are written into the verifier but not yet run.
7. **Migrations:** none needed for this feature. Two optional improvements would need new migration 0029 (not written; your approval required):
   - (a) `account_audit.resource_type` gains `STORAGE`, so connect and disconnect are audit rows in Turso; today they are only in the server log.
   - (b) `timelapses.storage_key`, so videos can live in team folders; today they are per employee.
8. **Manual Microsoft 365 setup:** §5.
9. **Survives restart:** yes, by design: encrypted file plus rotation. Tested with the fake; not yet on the real account.
10. **Production-ready:** **no.** Code complete; real-account verification and the deployment config are pending.

## 5. Remaining manual setup (each needs your approval; none purchases anything)

1. **New Entra app registration** "Insight Workfolio OneDrive":
   - single tenant, Web platform;
   - redirect URI `https://<API host>/api/v1/storage/onedrive/oauth/callback`, plus `http://localhost:4000/...` for a local first test;
   - a client secret with an expiry.

   Use a new registration so the old app with dormant Limited Access entries is never touched (SEC-11).
2. **Delegated permissions:** `Files.ReadWrite`, `offline_access`, `openid`, `profile`. Admin consent only if TFF's tenant blocks user consent, and then for exactly these.
3. **Optional:** set *Assignment required* = Yes on the enterprise app, assigned only to IT@TFFDigital.com.
4. **API environment:** `SCREENSHOT_STORAGE=onedrive` and `ONEDRIVE_*`. The token file goes on the persistent disk, e.g. `/var/data/secrets/onedrive.json`. `render.yaml` was **not changed** (it still says `graph`).
5. **Connect:** sign in as IT@ in Settings › Microsoft OneDrive, then run `verify:onedrive` (read-only first, then `--write --teams …`).
6. **Account hygiene for IT@:** MFA on; no mailbox or Teams use beyond IT. If an admin resets its password or revokes its sessions, reconnect. An unused refresh token lapses after the default 90 days.
7. **Still open from before:** clean up the dormant Limited Access entries and the extra permissions on the old app (docs/onedrive.md).

## 6. Known limits

- Single API instance: pending sign-in states and the token file are per host, which matches the current Render plan.
- The 90-day refresh-token lifetime is reset by use; status checks and uploads keep it alive.
- `GRAPH_PERMANENT_DELETE=true` with delegated `Files.ReadWrite` has not been verified. The default is the OneDrive recycle bin, where files are recoverable for up to 93 days.
- Rows stored before a key-layout change keep their old keys: keys are immutable by design.
