// OneDrive (delegated, IT storage account) end to end through the API, against a FAKE Microsoft identity
// platform and Graph: no tenant is used. Connect flow, encrypted token file, rotation, restart, screenshots,
// timelapse storage, team folders, status, disconnect. Real-tenant checks: scripts/verify-onedrive.mjs.
import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

const DIR = mkdtempSync(join(tmpdir(), "wf-onedrive-test-"));
const TOKEN_FILE = join(DIR, "secrets", "onedrive.json");
const TENANT = "11111111-2222-3333-4444-555555555555";
const SECRET = "onedrive-client-secret-value";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL = `file:${join(DIR, "test.db")}`;
process.env.JWT_SECRET = "test-secret-test-secret-test-secret!";
process.env.SCREENSHOT_STORAGE = "onedrive";
process.env.TIMELAPSE_DIR = join(DIR, "videos");
process.env.ONEDRIVE_TENANT_ID = TENANT;
process.env.ONEDRIVE_CLIENT_ID = "client-od";
process.env.ONEDRIVE_CLIENT_SECRET = SECRET;
process.env.ONEDRIVE_REDIRECT_URI = "http://localhost:4000/api/v1/storage/onedrive/oauth/callback";
process.env.ONEDRIVE_TOKEN_FILE = TOKEN_FILE;
process.env.ONEDRIVE_TOKEN_KEY = randomBytes(32).toString("base64");
process.env.ONEDRIVE_ACCOUNT_EMAIL = "IT@TFFDigital.com";

// ---- Fake Microsoft ------------------------------------------------------------------------
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idToken = (claims: object) => `${b64({ alg: "none" })}.${b64(claims)}.sig`;
const ms = {
  codes: new Map<string, { account: string; tid: string; scope: string }>(),
  refresh: null as string | null, // the one valid refresh token (rotated on use)
  access: new Set<string>(),
  files: new Map<string, Uint8Array>(),
  sessions: new Map<string, Uint8Array>(),
  folderExists: false,
  subfolders: new Set<string>(), // children of the app folder created by name (id `fld:<name>`)
  calls: [] as { url: string; auth: string | null; body: string }[],
  n: 0,
};
const realFetch = globalThis.fetch;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = String(input);
  if (url.startsWith("http://localhost") || url.startsWith("http://[::1]")) return realFetch(input, init);
  const method = init.method ?? "GET";
  const auth = new Headers(init.headers).get("authorization");
  ms.calls.push({ url, auth, body: init.body instanceof URLSearchParams || typeof init.body === "string" ? init.body.toString() : "" });
  if (url === `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`) {
    const f = init.body as URLSearchParams;
    if (f.get("client_secret") !== SECRET) return json(401, { error: "invalid_client" });
    const issue = (scope: string, account: string, tid: string) => {
      const n = ++ms.n;
      ms.refresh = `rt-${n}`;
      ms.access.add(`at-${n}`);
      return json(200, { access_token: `at-${n}`, expires_in: 3600, refresh_token: ms.refresh, scope, id_token: idToken({ tid, oid: "oid-it", preferred_username: account }) });
    };
    if (f.get("grant_type") === "authorization_code") {
      const c = ms.codes.get(f.get("code")!);
      if (!c || !f.get("code_verifier")) return json(400, { error: "invalid_grant" });
      return issue(c.scope, c.account, c.tid);
    }
    if (f.get("refresh_token") !== ms.refresh) return json(400, { error: "invalid_grant" });
    return issue("Files.ReadWrite openid profile offline_access", "IT@TFFDigital.com", TENANT);
  }
  // Upload session chunks go to the pre-authenticated URL, without Authorization (Graph's rule).
  const up = /^https:\/\/graph\.microsoft\.com\/v1\.0\/__upload\/(.+)$/.exec(url);
  if (up) {
    if (auth) return json(400, { error: { code: "authorizationNotAllowed" } });
    const key = decodeURIComponent(up[1]!);
    if (method === "DELETE") return new Response(null, { status: 204 });
    const [, start, end, total] = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(new Headers(init.headers).get("content-range")!)!.map(Number);
    const prev = ms.sessions.get(key) ?? new Uint8Array();
    if (start !== prev.length) return json(416, { error: { code: "invalidRange" } });
    const next = Buffer.concat([prev, new Uint8Array(init.body as Uint8Array)]);
    if (end + 1 < total!) return ms.sessions.set(key, next), json(202, { nextExpectedRanges: [`${end + 1}-`] });
    ms.sessions.delete(key);
    ms.files.set(key, next);
    return json(201, { id: `item:${key}`, size: next.length });
  }
  const token = auth?.replace(/^Bearer /, "");
  if (!url.startsWith("https://graph.microsoft.com/v1.0/")) return json(400, { error: { code: "unexpectedHost" } });
  if (!token || !ms.access.has(token)) return json(401, { error: { code: "InvalidAuthenticationToken" } });
  const path = url.slice("https://graph.microsoft.com/v1.0".length);
  if (path.startsWith("/me/drive?")) return json(200, { id: "drv-it", driveType: "business", owner: { user: { id: "oid-it" } }, quota: { used: 2048, total: 1099511627776, remaining: 1099511625728 } });
  if (path.startsWith("/me/drive/root:/InsightWorkfolio?")) return ms.folderExists ? json(200, { id: "fld-app", folder: {} }) : json(404, { error: { code: "itemNotFound" } });
  if (path === "/me/drive/root/children" && method === "POST") return (ms.folderExists = true), json(201, { id: "fld-app" });
  if (path.startsWith("/sites") || path.startsWith("/users")) return json(403, { error: { code: "accessDenied" } }); // Files.ReadWrite: no sites, no other users
  // Subfolders of the app folder (the off-site backup folder): create, look up by name, list children.
  if (path === "/drives/drv-it/items/fld-app/children" && method === "POST") {
    const { name } = JSON.parse(String(init.body)) as { name: string };
    if (ms.subfolders.has(name)) return json(409, { error: { code: "nameAlreadyExists" } });
    ms.subfolders.add(name);
    return json(201, { id: `fld:${name}`, folder: {} });
  }
  const sub = /^\/drives\/drv-it\/items\/fld-app:\/([^/:?]+)\?/.exec(path);
  if (sub && method === "GET" && ms.subfolders.has(decodeURIComponent(sub[1]!))) return json(200, { id: `fld:${decodeURIComponent(sub[1]!)}`, folder: {} });
  const children = /^\/drives\/drv-it\/items\/([^/]+)\/children\?/.exec(path);
  if (children && decodeURIComponent(children[1]!).startsWith("fld:")) {
    const prefix = `${decodeURIComponent(children[1]!).slice(4)}/`;
    const value = [...ms.files].filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/")).map(([k, b]) => ({ id: `item:${k}`, name: k.slice(prefix.length), size: b.length }));
    return json(200, { value });
  }
  const m = /^\/drives\/drv-it\/items\/([^/:]+):\/(.+?)(:\/content)?(\?.*)?$/.exec(path);
  const folder = m && decodeURIComponent(m[1]!);
  if (!m || !(folder === "fld-app" || (folder!.startsWith("fld:") && ms.subfolders.has(folder!.slice(4))))) return json(400, { error: { code: "invalidRequest" } });
  const key = (folder === "fld-app" ? "" : `${folder!.slice(4)}/`) + decodeURIComponent(m[2]!);
  const item = (b: Uint8Array) => ({ id: `item:${key}`, size: b.length });
  if (method === "PUT") {
    ms.files.set(key, new Uint8Array(init.body as Uint8Array));
    return json(201, item(ms.files.get(key)!));
  }
  if (method === "POST" && m[3] === undefined && key.endsWith(":/createUploadSession")) {
    return json(200, { uploadUrl: `https://graph.microsoft.com/v1.0/__upload/${encodeURIComponent(key.slice(0, -":/createUploadSession".length))}` });
  }
  const file = ms.files.get(key);
  if (!file) return json(404, { error: { code: "itemNotFound" } });
  if (method === "DELETE") return ms.files.delete(key), new Response(null, { status: 204 });
  if (m[3]) return new Response(file, { status: 200, headers: { "content-length": String(file.length) } });
  return json(200, item(file));
}) as typeof fetch;

const { AppModule } = await import("../dist/app.module.js");
const { configureApp } = await import("../dist/app.setup.js");
const { DATABASE } = await import("../dist/database/database.module.js");
const { hashPassword } = await import("../dist/auth/crypto.js");
const { readOneDriveConnection, scopesAcceptable, oneDriveScopes } = await import("../dist/storage/onedrive.js");
const { SCREENSHOT_STORAGE, ONEDRIVE_AUTH } = await import("../dist/screenshots/storage.js");
const { run: backupUpload } = await import("../dist/cli/backup-upload.js");
const { TimelapseService } = await import("../dist/screenshots/timelapse.service.js");
const { TIMELAPSE_ENCODER } = await import("../dist/screenshots/timelapse-encoder.js");
const { DEFAULT_SCREENSHOT_NOTICE_VERSION } = await import("@workfolio/shared");
const M = 60_000;
const iso = (t: number) => new Date(t).toISOString();
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
/** A structurally valid WebP container (VP8L header); the API never decodes pixels. */
function fakeWebp(width: number, height: number, payload: number): Uint8Array {
  const chunk = 5 + payload;
  const b = new Uint8Array(20 + chunk + (chunk % 2));
  const dv = new DataView(b.buffer);
  b.set(new TextEncoder().encode("RIFF"), 0);
  dv.setUint32(4, b.length - 8, true);
  b.set(new TextEncoder().encode("WEBPVP8L"), 8);
  dv.setUint32(16, chunk, true);
  b[20] = 0x2f;
  dv.setUint32(21, (width - 1) | ((height - 1) << 14), true);
  for (let i = 25; i < b.length; i++) b[i] = (i * 31 + payload) & 0xff;
  return b;
}

const ORIGIN = "http://localhost:3000";
const PASSWORD = "admin password 1";
let app: INestApplication;
let base: string;
type Db = { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
let db: Db;
let admin: string;

type Opts = { method?: string; cookie?: string; body?: unknown; raw?: Uint8Array; bearer?: string; device?: string };
async function api(path: string, { method = "GET", cookie, body, raw, bearer, device }: Opts = {}) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  if (raw) headers["content-type"] = "image/webp";
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (device) headers["x-device-id"] = device;
  const res = await realFetch(`${base}/api/v1${path}`, { method, headers, redirect: "manual", body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  return { status: res.status, text, body: (res.headers.get("content-type") ?? "").includes("json") && text ? JSON.parse(text) : undefined, res };
}

async function start() {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  const login = await api("/auth/login", { method: "POST", body: { email: "admin@example.com", password: PASSWORD } });
  admin = login.res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

/** start → Microsoft (fake) → callback, in one browser (binding cookie); returns the dashboard outcome. */
async function connect(code: string, grant = { account: "it@tffdigital.com", tid: TENANT, scope: "Files.ReadWrite openid profile offline_access" }) {
  const s = await api("/storage/onedrive/oauth/start", { cookie: admin });
  assert.equal(s.status, 302);
  const to = new URL(s.res.headers.get("location")!);
  const binding = s.res.headers.getSetCookie().find((c) => c.startsWith("wf_onedrive_oauth="))!.split(";")[0];
  ms.codes.set(code, grant);
  const cb = await api(`/storage/onedrive/oauth/callback?state=${to.searchParams.get("state")}&code=${code}`, { cookie: binding });
  return { authorizeUrl: to, outcome: new URL(cb.res.headers.get("location")!).searchParams.get("oneDrive") };
}

before(async () => {
  const boot = await NestFactory.create(AppModule, { logger: false });
  await boot.init();
  await boot.get(DATABASE).execute({ sql: "INSERT INTO users (id, email, role, admin_title, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', 'SUPER_ADMIN', ?)", args: [randomUUID(), await hashPassword(PASSWORD)] });
  await boot.close();
  await start();
});
after(async () => {
  await app.close();
  globalThis.fetch = realFetch;
  rmSync(DIR, { recursive: true, force: true });
});

describe("OneDrive (IT storage account, delegated Files.ReadWrite) — MOCKED Microsoft", () => {
  test("scope policy: Files.ReadWrite required, delegated Mail.Send tolerated; anything tenant-wide, site-wide or other mail access is refused", () => {
    assert.ok(scopesAcceptable("Files.ReadWrite openid profile offline_access"));
    assert.ok(scopesAcceptable("https://graph.microsoft.com/Files.ReadWrite https://graph.microsoft.com/User.Read openid"));
    assert.ok(scopesAcceptable("Files.ReadWrite Mail.Send openid profile offline_access"));
    assert.ok(scopesAcceptable("https://graph.microsoft.com/Files.ReadWrite https://graph.microsoft.com/Mail.Send"));
    const bad = ["openid profile", "Mail.Send openid offline_access", "Files.ReadWrite Files.ReadWrite.All", "Files.ReadWrite Sites.Selected", "Files.ReadWrite Sites.ReadWrite.All", "Files.ReadWrite Mail.Read", "Files.ReadWrite Mail.ReadWrite", "Files.ReadWrite Mail.Send.Shared", "Files.ReadWrite Mail.Send User.Read.All", undefined];
    for (const scope of bad) assert.equal(scopesAcceptable(scope), false, String(scope));
    // Mail.Send is requested only for graph-delegated invitations: a refresh naming an ungranted scope would fail.
    assert.equal(oneDriveScopes(false), "offline_access openid profile Files.ReadWrite");
    assert.equal(oneDriveScopes(true), "offline_access openid profile Files.ReadWrite Mail.Send");
  });

  test("before connecting: status says not connected, uploads fail safely, admin-only endpoints", async () => {
    const st = await api("/storage/onedrive/status", { cookie: admin });
    assert.equal(st.status, 200);
    assert.deepEqual([st.body.provider, st.body.configured, st.body.connected, st.body.lastCheckOk], ["MICROSOFT_ONEDRIVE", true, false, false]);
    assert.match(st.body.lastError, /not connected yet/);
    assert.equal((await api("/storage/onedrive/status")).status, 401);
    assert.equal((await api("/storage/onedrive/oauth/start")).status, 401);
    assert.equal((await api("/storage/onedrive/disconnect", { method: "POST" })).status, 401);
    const storage = app.get(SCREENSHOT_STORAGE);
    await assert.rejects(storage.put("screenshots/unassigned/x/2026-11/a.webp", new Uint8Array([1])), /not connected yet/);
  });

  test("connect flow: PKCE + state + browser binding; wrong account, wrong tenant, wide scopes and replays are not kept", async () => {
    const { authorizeUrl } = await connect("wrong-account", { account: "someone@tffdigital.com", tid: TENANT, scope: "Files.ReadWrite openid profile offline_access" });
    assert.equal(authorizeUrl.origin + authorizeUrl.pathname, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`);
    assert.equal(authorizeUrl.searchParams.get("scope"), "offline_access openid profile Files.ReadWrite");
    assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorizeUrl.searchParams.get("login_hint"), "it@tffdigital.com");
    assert.ok(!authorizeUrl.search.includes(SECRET), "the client secret never leaves the server");
    assert.ok(!existsSync(TOKEN_FILE), "another account is not kept");
    assert.equal((await connect("wrong-tenant", { account: "it@tffdigital.com", tid: "other-tenant", scope: "Files.ReadWrite openid offline_access" })).outcome, "failed");
    assert.equal((await connect("wide", { account: "it@tffdigital.com", tid: TENANT, scope: "Files.ReadWrite.All openid offline_access" })).outcome, "failed");
    assert.ok(!existsSync(TOKEN_FILE));
    // No binding cookie (another browser) and a made-up state: refused.
    const s = await api("/storage/onedrive/oauth/start", { cookie: admin });
    const state = new URL(s.res.headers.get("location")!).searchParams.get("state");
    ms.codes.set("stolen", { account: "it@tffdigital.com", tid: TENANT, scope: "Files.ReadWrite" });
    const cb = await api(`/storage/onedrive/oauth/callback?state=${state}&code=stolen`);
    assert.match(cb.res.headers.get("location")!, /oneDrive=failed$/);
    assert.ok(!existsSync(TOKEN_FILE));
  });

  test("connected: encrypted 0600 token file, app folder created, status with quota and team mapping", async () => {
    const { outcome } = await connect("good");
    assert.equal(outcome, "connected");
    assert.equal(statSync(TOKEN_FILE).mode & 0o777, 0o600);
    const raw = readFileSync(TOKEN_FILE);
    assert.ok(!raw.includes(Buffer.from(ms.refresh!)) && !raw.includes(Buffer.from("drv-it")), "refresh token and IDs are encrypted at rest");
    const conn = await readOneDriveConnection(TOKEN_FILE, Buffer.from(process.env.ONEDRIVE_TOKEN_KEY!, "base64"));
    assert.deepEqual([conn.account, conn.driveId, conn.folderId, conn.userId], ["it@tffdigital.com", "drv-it", "fld-app", "oid-it"]);
    await assert.rejects(readOneDriveConnection(TOKEN_FILE, randomBytes(32)), /cannot be decrypted/);

    const adminId = String((await db.execute("SELECT id FROM users WHERE email = 'admin@example.com'")).rows[0]!.id);
    const teams = ["Alpha", "Beta", "Gamma"].map((name) => ({ id: randomUUID(), name }));
    for (const t of teams) await db.execute({ sql: "INSERT INTO teams (id, name, created_by) VALUES (?, ?, ?)", args: [t.id, t.name, adminId] });
    const st = await api("/storage/onedrive/status", { cookie: admin });
    assert.deepEqual([st.body.connected, st.body.account, st.body.lastCheckOk, st.body.rootFolder], [true, "it@tffdigital.com", true, "InsightWorkfolio"]);
    assert.deepEqual(st.body.quota, { usedBytes: 2048, totalBytes: 1099511627776, remainingBytes: 1099511625728 });
    assert.deepEqual(st.body.teams.map((t: { name: string; folder: string }) => [t.name, t.folder]), teams.map((t) => [t.name, `InsightWorkfolio/screenshots/teams/${t.id}`]));
    assert.equal(st.body.unassignedFolder, "InsightWorkfolio/screenshots/unassigned");
    for (const leak of [SECRET, ms.refresh!, "at-", "refreshToken", "accessToken"]) assert.ok(!st.text.includes(leak), `status never shows ${leak}`);
  });

  test("files: upload, stat, download, delete under the app folder only; token refresh rotates and is persisted", async () => {
    const storage = app.get(SCREENSHOT_STORAGE);
    const key = "screenshots/teams/t-1/emp-1/2026-11/test-file.webp";
    const bytes = randomBytes(1000);
    const before = ms.refresh;
    ms.access.clear(); // every access token now rejected (expired/revoked): one fresh token, then success
    const stored = await storage.put(key, bytes);
    assert.equal(stored.size, 1000);
    assert.notEqual(ms.refresh, before, "Microsoft rotated the refresh token");
    const conn = await readOneDriveConnection(TOKEN_FILE, Buffer.from(process.env.ONEDRIVE_TOKEN_KEY!, "base64"));
    assert.equal(conn.refreshToken, ms.refresh, "the rotated refresh token was written back");
    assert.equal((await storage.stat(key)).size, 1000);
    assert.deepEqual(Buffer.from(await storage.get(key)), bytes);
    await storage.delete(key);
    assert.equal(await storage.stat(key), null);
    await storage.delete(key); // idempotent
    const graphCalls = ms.calls.filter((c) => c.url.startsWith("https://graph.microsoft.com/v1.0/drives/"));
    assert.ok(graphCalls.length && graphCalls.every((c) => c.url.startsWith("https://graph.microsoft.com/v1.0/drives/drv-it/items/fld-app:/")), "only the app folder is addressed");
    assert.ok(!ms.calls.some((c) => /\/sites|\/users\//.test(c.url)), "no SharePoint site or other user is ever called");
  });

  test("connection survives an API restart (encrypted file + rotated token)", async () => {
    await app.close();
    ms.access.clear();
    await start();
    const storage = app.get(SCREENSHOT_STORAGE);
    await storage.put("screenshots/unassigned/emp-2/2026-11/after-restart.webp", new Uint8Array([9, 9]));
    assert.deepEqual([...(await storage.get("screenshots/unassigned/emp-2/2026-11/after-restart.webp"))], [9, 9]);
    await storage.delete("screenshots/unassigned/emp-2/2026-11/after-restart.webp");
    assert.equal((await api("/storage/onedrive/status", { cookie: admin })).body.connected, true);
  });

  test("off-site backups (cli/backup-upload): encrypted files only, dedicated folder, size check, shared token, opt-in retention", async () => {
    const lines: string[] = [];
    const upload = (args: string[], extra: Record<string, string> = {}) => backupUpload(args, { ...process.env, ...extra }, (l) => lines.push(l));
    const gpg = (name: string, n = 5000) => {
      const file = join(DIR, name);
      writeFileSync(file, Buffer.concat([Buffer.from([0x8c]), randomBytes(n - 1)])); // OpenPGP symmetric-key packet first
      return file;
    };
    const was = new Map(ms.files);
    // refused: not a backup name, a plain gzip, a .gpg without an OpenPGP packet; nothing is created or uploaded
    writeFileSync(join(DIR, "workfolio-20261105T023000Z.db.gz"), randomBytes(100));
    writeFileSync(join(DIR, "workfolio-20261105T023000Z.db.gz.gpg"), Buffer.from("plain text"));
    writeFileSync(join(DIR, "notes.gpg"), Buffer.from([0x8c, 1, 2]));
    for (const f of ["workfolio-20261105T023000Z.db.gz", "workfolio-20261105T023000Z.db.gz.gpg", "notes.gpg", "missing.db.gz.gpg"]) assert.equal(await upload(["upload", join(DIR, f)]), 2, f);
    assert.equal(await upload(["upload"]), 2);
    assert.equal(await upload(["bogus"]), 2);
    assert.deepEqual([...ms.files.keys()], [...was.keys()]);
    assert.equal(ms.subfolders.size, 0, "a refused upload creates nothing");
    assert.ok(lines.some((l) => l.includes("unencrypted backups never leave the VPS")));

    // check: creates InsightWorkfolio/db-backups once, uploads nothing
    assert.equal(await upload(["check"]), 0);
    assert.deepEqual([...ms.subfolders], ["db-backups"]);
    assert.ok(lines.at(-1)!.includes("it@tffdigital.com") && lines.at(-1)!.includes("InsightWorkfolio/db-backups"));

    // upload: resumable session into the backup folder only; local bytes == remote bytes; the folder is reused
    const a = gpg("workfolio-20261001T023000Z.db.gz.gpg", 12_000);
    assert.equal(await upload(["upload", a]), 0, lines.join("\n"));
    assert.deepEqual(Buffer.from(ms.files.get("db-backups/workfolio-20261001T023000Z.db.gz.gpg")!), readFileSync(a));
    assert.equal(ms.subfolders.size, 1);
    const b = gpg("workfolio-20261105T023000Z.db.gz.gpg.tmp"); // wrong name: refused, even if encrypted
    assert.equal(await upload(["upload", b]), 2);
    const c = gpg(`workfolio-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z.db.gz.gpg`);
    assert.equal(await upload(["upload", c]), 0);
    assert.equal(await upload(["list"]), 0);
    assert.ok(lines.at(-1)!.startsWith("2 off-site backup(s)"));
    const backupCalls = ms.calls.filter((x) => x.url.includes("/drives/drv-it/items/fld%3A"));
    assert.ok(backupCalls.length && backupCalls.every((x) => x.url.includes("/items/fld%3Adb-backups")), "only the backup folder is addressed");
    assert.ok(!ms.calls.some((x) => /fld-app:\/(screenshots|timelapses)/.test(x.url) && x.body.includes("db-backups")), "screenshot and timelapse folders untouched");
    for (const line of lines) for (const leak of [SECRET, ms.refresh!, "at-", process.env.ONEDRIVE_TOKEN_KEY!]) assert.ok(!line.includes(leak), `output never shows ${leak}`);

    // the CLI refreshed and rotated the shared token: the running API follows the file instead of its stale copy
    const auth = app.get(ONEDRIVE_AUTH) as { token: (fresh: boolean) => Promise<string> };
    const conn = await readOneDriveConnection(TOKEN_FILE, Buffer.from(process.env.ONEDRIVE_TOKEN_KEY!, "base64"));
    assert.equal(conn.refreshToken, ms.refresh, "the CLI wrote the rotated token back");
    ms.access.clear();
    assert.ok(ms.access.has(await auth.token(true)), "the API refreshed with the token the CLI left behind");
    await app.get(SCREENSHOT_STORAGE).stat("screenshots/unassigned/e/2026-11/nothing.webp");

    // retention: only with ONEDRIVE_BACKUP_KEEP_DAYS, only backup-named items older than that, never the new one
    const d = gpg(`workfolio-${new Date(Date.now() - 60_000).toISOString().replace(/[-:]/g, "").slice(0, 15)}Z.db.gz.gpg`);
    assert.equal(await upload(["upload", d]), 0);
    assert.ok(ms.files.has("db-backups/workfolio-20261001T023000Z.db.gz.gpg"), "nothing deleted without the setting");
    assert.equal(await upload(["upload", gpg(`workfolio-${new Date(Date.now() - 120_000).toISOString().replace(/[-:]/g, "").slice(0, 15)}Z.db.gz.gpg`)], { ONEDRIVE_BACKUP_KEEP_DAYS: "30" }), 0);
    assert.ok(!ms.files.has("db-backups/workfolio-20261001T023000Z.db.gz.gpg"), "the October backup is older than 30 days");
    assert.equal([...ms.files.keys()].filter((k) => k.startsWith("db-backups/")).length, 3);
    assert.ok(lines.some((l) => l.includes("removed off-site backup older than 30 days")));
    // the backup folder can never be the screenshot or timelapse folder (env validation)
    for (const bad of ["screenshots", "timelapses", "Timelapses"]) await assert.rejects(upload(["check"], { ONEDRIVE_BACKUP_FOLDER: bad }), /screenshot or timelapse folder/);
  });

  test("revoked authorization: clear 'reconnect' error, nothing marked stored; disconnect forgets the connection", async () => {
    const storage = app.get(SCREENSHOT_STORAGE);
    const saved = ms.refresh;
    ms.refresh = "revoked-by-admin";
    ms.access.clear();
    await assert.rejects(storage.put("screenshots/unassigned/e/2026-11/x.webp", new Uint8Array([1])), /expired or was revoked; reconnect OneDrive/);
    const st = await api("/storage/onedrive/status", { cookie: admin });
    assert.deepEqual([st.body.connected, st.body.lastCheckOk], [true, false]);
    assert.match(st.body.lastError, /reconnect OneDrive/);
    ms.refresh = saved;

    assert.equal((await api("/storage/onedrive/disconnect", { method: "POST", cookie: admin })).status, 204);
    assert.ok(!existsSync(TOKEN_FILE));
    assert.equal((await api("/storage/onedrive/status", { cookie: admin })).body.connected, false);
    await assert.rejects(storage.stat("screenshots/x"), /not connected yet/);
    // Reconnecting reuses the existing app folder (no duplicate).
    assert.equal((await connect("again")).outcome, "connected");
    assert.equal(ms.calls.filter((c) => c.url.endsWith("/me/drive/root/children")).length, 1, "folder created once");
  });

  test("through the API: screenshots land in their team folder, cross-team reads are denied, timelapse stored in OneDrive", async () => {
    const adminId = String((await db.execute("SELECT id FROM users WHERE email = 'admin@example.com'")).rows[0]!.id);
    // Screenshots on since two days ago (captures below are 20-30 minutes old).
    await db.execute({
      sql: `INSERT INTO screenshot_policies (screenshots_enabled, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
              retention_approved, notice_version, reason, changed_by, effective_at)
            VALUES (1, 60, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, ?, 'test', ?, ?)`,
      args: [DEFAULT_SCREENSHOT_NOTICE_VERSION, adminId, iso(Date.now() - 2 * 86_400_000)],
    });
    const PW = "employee password 1";
    let n = 0;
    const person = async () => {
      const k = ++n;
      const r = await api("/employees", { method: "POST", cookie: admin, body: { email: `od${k}@example.com`, employeeCode: `OD-${k}`, fullName: `OneDrive ${k}`, timezone: "UTC" } });
      await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PW } });
      const login = await api("/auth/login", { method: "POST", body: { email: `od${k}@example.com`, password: PW, client: "desktop" } });
      const e = { id: r.body.employee.id as string, userId: "", bearer: login.body.accessToken as string, device: randomUUID() };
      e.userId = String((await db.execute({ sql: "SELECT user_id FROM employee_profiles WHERE id = ?", args: [e.id] })).rows[0]!.user_id);
      await api("/devices/register", { method: "POST", bearer: e.bearer, body: { installationId: e.device, deviceName: "Mac", platform: "macos" } });
      await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), e.id, DEFAULT_SCREENSHOT_NOTICE_VERSION, iso(Date.now() - 180 * M)] });
      await api("/attendance/sync", { method: "POST", bearer: e.bearer, device: e.device, body: { sentAt: iso(Date.now()), events: [{ id: randomUUID(), type: "CLOCK_IN", occurredAt: iso(Date.now() - 120 * M) }] } });
      return e;
    };
    const teams = (await db.execute("SELECT id, name FROM teams ORDER BY name")).rows.map((r) => ({ id: String(r.id), name: String(r.name) }));
    const [a, b] = [await person(), await person()];
    await db.execute({ sql: "INSERT INTO team_members (team_id, employee_id, added_by) VALUES (?, ?, ?)", args: [teams[0]!.id, a.id, adminId] });
    await db.execute({ sql: "INSERT INTO team_members (team_id, employee_id, added_by) VALUES (?, ?, ?)", args: [teams[1]!.id, b.id, adminId] });
    const shoot = async (e: typeof a, minutesAgo: number) => {
      const bytes = fakeWebp(1920, 1080, 1000 + minutesAgo);
      const id = randomUUID();
      const meta = { capturedAt: iso(Date.now() - minutesAgo * M), width: 1920, height: 1080, sizeBytes: bytes.length, checksum: sha(bytes), mimeType: "image/webp" };
      const reg = await api("/screenshots/register", { method: "POST", bearer: e.bearer, device: e.device, body: { id, sentAt: iso(Date.now()), ...meta } });
      assert.equal(reg.body.status, "REGISTERED", reg.text);
      const up = await api(`/screenshots/${id}/content`, { method: "PUT", bearer: e.bearer, device: e.device, raw: bytes });
      assert.equal(up.body?.status, "STORED", up.text);
      const row = (await db.execute({ sql: "SELECT id, storage_key, storage_provider, storage_item_id, checksum, file_size_bytes FROM screenshots WHERE idempotency_key = ?", args: [id] })).rows[0]!;
      return { row, bytes };
    };
    const shotsA = [await shoot(a, 30), await shoot(a, 20)];
    const shotB = await shoot(b, 25);
    for (const { row, bytes } of shotsA) {
      assert.ok(String(row.storage_key).startsWith(`screenshots/teams/${teams[0]!.id}/${a.id}/`), String(row.storage_key));
      assert.equal(row.storage_provider, "MICROSOFT_GRAPH");
      assert.equal(row.checksum, sha(ms.files.get(String(row.storage_key))!), "Turso checksum = bytes in OneDrive");
      assert.equal(Number(row.file_size_bytes), bytes.length);
    }
    assert.ok(String(shotB.row.storage_key).startsWith(`screenshots/teams/${teams[1]!.id}/${b.id}/`));

    // Admin reads through the API (bytes come from OneDrive); a team head of team A cannot read team B's file.
    const view = await realFetch(`${base}/api/v1/screenshots/${shotsA[0]!.row.id}/content`, { headers: { origin: ORIGIN, cookie: admin } });
    assert.equal(view.status, 200);
    assert.deepEqual(new Uint8Array(await view.arrayBuffer()), shotsA[0]!.bytes);
    const head = await person();
    await db.execute({ sql: "UPDATE teams SET head_user_id = ? WHERE id = ?", args: [head.userId, teams[0]!.id] });
    const asHead = { origin: ORIGIN, authorization: `Bearer ${head.bearer}` };
    const own = await realFetch(`${base}/api/v1/screenshots/${shotsA[0]!.row.id}/content`, { headers: asHead });
    const other = await realFetch(`${base}/api/v1/screenshots/${shotB.row.id}/content`, { headers: asHead });
    assert.deepEqual([own.status, other.status], [200, 404], "team head: own team readable, other team's file denied");
    const employeeB = await realFetch(`${base}/api/v1/screenshots/${shotsA[0]!.row.id}/content`, { headers: { origin: ORIGIN, authorization: `Bearer ${b.bearer}` } });
    assert.ok([403, 404].includes(employeeB.status), `employee of team B cannot read team A's file (${employeeB.status})`);

    // Timelapse: encoded locally (fake encoder), uploaded to OneDrive with an upload session, streamed back, deleted.
    const service = app.get(TimelapseService);
    const encoder = app.get(TIMELAPSE_ENCODER);
    Object.assign(service, { encoderReason: null });
    encoder.encode = async (frames: AsyncIterable<Uint8Array>, out: string) => {
      const parts: Uint8Array[] = [];
      for await (const f of frames) parts.push(f);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(out, Buffer.concat(parts));
    };
    const session = String((await db.execute({ sql: "SELECT attendance_session_id FROM screenshots WHERE id = ?", args: [shotsA[0]!.row.id] })).rows[0]!.attendance_session_id);
    const created = await api("/timelapses", { method: "POST", cookie: admin, body: { sessionId: session, fps: 4 } });
    assert.equal(created.status, 202, created.text);
    let job = created.body;
    for (let i = 0; i < 200 && ["QUEUED", "RUNNING"].includes(job.status); i++) {
      await new Promise((r) => setTimeout(r, 20));
      job = (await api(`/timelapses/${job.id}`, { cookie: admin })).body;
    }
    assert.equal(job.status, "READY", job.error);
    const videoKey = `timelapses/${a.id}/${job.id}.mp4`;
    assert.equal(sha(ms.files.get(videoKey)!), job.sha256, "the video is in OneDrive and matches its Turso sha256");
    assert.ok(ms.calls.some((c) => c.url.includes("/__upload/")), "uploaded through an upload session");
    const video = await realFetch(`${base}/api/v1/timelapses/${job.id}/content`, { headers: { origin: ORIGIN, cookie: admin } });
    assert.equal(sha(new Uint8Array(await video.arrayBuffer())), job.sha256);
    assert.equal((await api(`/timelapses/${job.id}`, { method: "DELETE", cookie: admin })).status, 204);
    assert.ok(!ms.files.has(videoKey), "deleting the timelapse deletes it from OneDrive");
  });

  test("checksums: Turso metadata and the stored bytes agree after a round trip", async () => {
    const storage = app.get(SCREENSHOT_STORAGE);
    const bytes = randomBytes(4096);
    const sha = createHash("sha256").update(bytes).digest("hex");
    await storage.put("screenshots/unassigned/e/2026-11/sum.webp", bytes);
    assert.equal(createHash("sha256").update(await storage.get("screenshots/unassigned/e/2026-11/sum.webp")).digest("hex"), sha);
    await storage.delete("screenshots/unassigned/e/2026-11/sum.webp");
  });
});
