# Google Drive Storage: Setup (Testing POC)

**Date:** 2026-11-02. **Scope:** a personal Google account's My Drive, for local development and staging tests only. Microsoft Graph (dedicated SharePoint site) remains the authoritative production decision ([INSIGHT-WORKFOLIO-FINAL-STORAGE-DECISION.md](INSIGHT-WORKFOLIO-FINAL-STORAGE-DECISION.md)).

**Status:** implemented and tested against a fake Google only. No OAuth client exists yet, and nothing has been run against real Google.

## 1. What to create in Google Cloud

| Setting | Exact value |
|---|---|
| Project | `Insight Workfolio` (Drive API already enabled) |
| OAuth client type | **Web application** (not "Desktop app": the code exchange happens in the NestJS API with a client secret) |
| Authorized JavaScript origins | **None.** The browser never calls Google APIs; the API does the code exchange. |
| Authorized redirect URI (local development) | `http://localhost:4000/api/v1/storage/google-drive/oauth/callback` |
| Authorized redirect URI (staging) | `https://<staging API host>/api/v1/storage/google-drive/oauth/callback`. The staging API host is still a placeholder (`api-staging.<domain>`) in [STAGING-DEPLOYMENT-PLAN.md](STAGING-DEPLOYMENT-PLAN.md); add this URI once the host is fixed. |
| Scope | `https://www.googleapis.com/auth/drive.file` (nothing else) |

Where these come from in the code:

- **Path:** `GOOGLE_OAUTH_CALLBACK_PATH` in [apps/api/src/config/env.ts](apps/api/src/config/env.ts). The route is `GoogleDriveOAuthController` (`@Controller({ path: "storage/google-drive/oauth", version: "1" })` plus `@Get("callback")`) under the global prefix `api` and URI version `v1`.
- **Port:** `4000` is the API's default `PORT`.
- **Exact match:** the API refuses to start unless `GOOGLE_OAUTH_REDIRECT_URI` ends in exactly this path, with no query or fragment. It must be `https`, except `http://localhost` outside production.

### Steps (Google Cloud Console, project `Insight Workfolio`)

1. **Google Auth Platform → Branding:** app name `Insight Workfolio (testing)`, support email = your address. No logo needed.
2. **Audience:** User type **External** (a personal Gmail account can't use Internal). Publishing status **Testing**. Under *Test users*, add exactly the account you'll connect.
3. **Data Access:** add the scope `.../auth/drive.file`. Add no other Drive scope.
4. **Clients → Create client:**
   - **Type:** Web application.
   - **Name:** `Insight Workfolio API (dev+staging)`.
   - **Authorized JavaScript origins:** leave empty.
   - **Authorized redirect URIs:** the local URI above. Add the staging URI later, once the host exists.
5. Copy the client ID and secret **straight into the server-side env file** (§3). Don't paste them into chat, the repo or a ticket. Google may show the secret only at creation; if it's lost, create a new secret and delete the old one.
6. **Production:** create a **separate** client, ideally in a separate project, with its own token file. Never reuse the staging client or token file. The API refuses a connection file issued to another client ID.

**Known Google limitation (from Google's OAuth documentation; not yet observed here):** for an External app in *Testing* status, refresh tokens for scopes beyond basic profile expire after **7 days**. After that, the adapter reports "authorization expired or was revoked; reconnect" and you repeat §4. Lifting this means publishing the app, which is a separate decision. Check Google's current rules in the console before you do.

## 2. Environment variables (API only)

| Variable | Required | Value |
|---|---|---|
| `SCREENSHOT_STORAGE` | no | `google-drive` routes **screenshots** to Drive. **Currently refused at startup** until the screenshots table accepts `GOOGLE_DRIVE`, which needs a migration that is pending approval (implementation report §5). Leave it `local` (dev) or `graph` (staging) for now. Connecting and the verify script work without it. |
| `GOOGLE_OAUTH_CLIENT_ID` | yes* | The Web application client ID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | yes* | Its secret. Server only; never logged or sent to the dashboard or desktop. |
| `GOOGLE_OAUTH_REDIRECT_URI` | yes* | Exactly the registered URI, e.g. `http://localhost:4000/api/v1/storage/google-drive/oauth/callback` |
| `GOOGLE_DRIVE_TOKEN_FILE` | yes* | Absolute path **outside the repo**, e.g. `/Users/<you>/.config/insight-workfolio/google-drive-token.json`. The connect flow writes the refresh token and folder IDs here (file `0600`, directory `0700`). |
| `GOOGLE_DRIVE_ACCOUNT_EMAIL` | yes* | The only Google account allowed to connect. Any other account's grant is revoked at the callback. |
| `GOOGLE_DRIVE_PERMANENT_DELETE` | no | `false` (default): deletes go to that account's Drive trash (30 days). `true`: permanent. |
| `GOOGLE_DRIVE_VERIFY_UNRELATED_FILE_ID` | no | **Verify script only:** the ID of one of your own files. It is only *read*, and must be refused. |

\* All five are required together. Set none of them to leave Google Drive off. The API refuses to start with a partial set.

## 3. Local setup

1. Create `~/.config/insight-workfolio/google-drive.env` (mode `600`, outside the repo) containing the five variables. Use the same values in the API's environment, either in `apps/api/.env` (git-ignored) or with `node --env-file=…`.
2. Start the API (`pnpm --filter @workfolio/api build && pnpm --filter @workfolio/api start`) and the dashboard.

## 4. Connect the account

1. Sign in to the dashboard **as an admin** in your browser.
2. In the **same browser**, open `http://localhost:4000/api/v1/storage/google-drive/oauth/start`. It only accepts `GET` from a signed-in admin (permission `settings:manage`).
3. Google shows the consent screen for **"See, edit, create and delete only the specific Google Drive files you use with this app"** (`drive.file`). Sign in as `GOOGLE_DRIVE_ACCOUNT_EMAIL` and allow.
4. You land on `<DASHBOARD_URL>/settings?googleDrive=connected`. The page itself doesn't react to this parameter yet; the URL is the signal.
   - `denied`: you declined consent.
   - `failed`: the API log has the reason. Causes: wrong account, wrong scope, expired or reused link, a different browser, or the token file isn't writable.
5. The app creates **its own** folder tree in My Drive: `InsightWorkfolio/Screenshots`, `InsightWorkfolio/Timelapse` and `InsightWorkfolio/TestFiles`.

**About the `InsightWorkfolio/` folder you created by hand:** with `drive.file`, the app **can't see** folders it didn't create, so it won't use, read or change yours. You'll see two folders with the same name. Rename or remove your manual one if you like; the app never touches it. A later reconnect reuses the app's folders while they exist and aren't in the trash.

## 5. Verify against real Google

```bash
pnpm --filter @workfolio/api build
```

```bash
node apps/api/scripts/verify-google-drive.mjs ~/.config/insight-workfolio/google-drive.env
```

```bash
node apps/api/scripts/verify-google-drive.mjs ~/.config/insight-workfolio/google-drive.env --write
```

- **The read-only run:**
  - refreshes the token and confirms the scope is exactly `drive.file`
  - checks the account and that the app's folders exist
  - lists **every item the app can see** and requires each one to be inside its `InsightWorkfolio` folder
  - if `GOOGLE_DRIVE_VERIFY_UNRELATED_FILE_ID` is set, confirms that file is refused
- **`--write` also:**
  - uploads a synthetic random file to `InsightWorkfolio/TestFiles/verify-<uuid>/`
  - reads it back and checks size and SHA-256
  - overwrites it in place
  - does a 12 MiB resumable upload with a streamed read
  - deletes the file and confirms it is inaccessible by ID (404)
  - removes only the items it created
- **Exit codes:** 0 pass · 1 fail · 2 blocked (nothing contacted) · 4 breach.

## 6. Staging notes (decisions pending)

- The token file must survive restarts. Render's Secret Files are read-only, and its normal disk is wiped on every deploy. So either:
  - attach a persistent disk and point `GOOGLE_DRIVE_TOKEN_FILE` at it, or
  - connect locally and upload the resulting token file as a Secret File. A read-only file works until Google rotates or revokes the token.
- Register the staging redirect URI once the staging API host is fixed. The staging API runs with `NODE_ENV=production`, so the URI must be `https`.
