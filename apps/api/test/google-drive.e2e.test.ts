// Google Drive storage (TESTING POC) against a FAKE Google (no real account is contacted): OAuth state, PKCE and
// browser binding, token refresh and revocation, upload/download, resumable upload, streaming, checksums,
// delete, folder creation, retries, key validation, env rules, the provider guard and the verify script.
import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

const TMP = mkdtempSync(join(tmpdir(), "wf-gdrive-test-"));
const TOKEN_FILE = join(TMP, "secrets", "google-drive.json");
const CLIENT_ID = "test-client.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-test-client-secret";
const REDIRECT_URI = "http://localhost:4000/api/v1/storage/google-drive/oauth/callback";
const ACCOUNT = "owner@example.com";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL = ":memory:";
process.env.JWT_SECRET = "test-secret-test-secret-test-secret!";
process.env.SCREENSHOT_STORAGE = "local";
process.env.SCREENSHOT_LOCAL_DIR = join(TMP, "shots");
process.env.GOOGLE_OAUTH_CLIENT_ID = CLIENT_ID;
process.env.GOOGLE_OAUTH_CLIENT_SECRET = CLIENT_SECRET;
process.env.GOOGLE_OAUTH_REDIRECT_URI = REDIRECT_URI;
process.env.GOOGLE_DRIVE_TOKEN_FILE = TOKEN_FILE;
process.env.GOOGLE_DRIVE_ACCOUNT_EMAIL = "Owner@Example.com";

const { AppModule } = await import("../dist/app.module.js");
const { configureApp } = await import("../dist/app.setup.js");
const { DATABASE } = await import("../dist/database/database.module.js");
const { hashPassword } = await import("../dist/auth/crypto.js");
const { validateEnv, GOOGLE_OAUTH_CALLBACK_PATH } = await import("../dist/config/env.js");
const { StorageError, LocalDevStorage, screenshotStorageProvider } = await import("../dist/screenshots/storage.js");
const { GoogleDriveStorage, DriveClient, setUpFolders, readConnection, writeConnection, DRIVE_FILE_SCOPE } = await import("../dist/storage/google-drive-storage.js");
const { GoogleDriveOAuthService, BINDING_COOKIE, STATE_TTL_MS } = await import("../dist/storage/google-drive-oauth.js");
const { run: verifyRun } = await import("../scripts/verify-google-drive.mjs");

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const FOLDER = "application/vnd.google-apps.folder";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const md5 = (b: Uint8Array) => createHash("md5").update(b).digest("hex");
const noSleep = async () => {};

type Item = { id: string; name: string; parents: string[]; mimeType: string; content: Buffer; trashed: boolean };
type Rule = { match: (method: string, url: URL) => boolean; respond: () => Response };
const res = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers } });

/** In-memory Google: token endpoint, revoke, and the Drive v3 calls the adapter makes. */
class FakeGoogle {
  items = new Map<string, Item>();
  tokens = new Set<string>();
  refreshTokens = new Set<string>(["1//refresh-good"]);
  sessions = new Map<string, { target?: string; meta?: { name: string; parents: string[] }; total: number; data: Buffer }>();
  calls: { method: string; url: string; auth: string | null; body: string }[] = [];
  queries: string[] = [];
  revoked: string[] = [];
  cancelled: string[] = [];
  rules: Rule[] = [];
  account = ACCOUNT;
  scope = DRIVE_FILE_SCOPE;
  grantRefresh = true;
  omitSha256 = false;
  corruptSha256 = false;
  partialChunkOnce = false;
  challenge?: string;
  private n = 0;

  id(kind = "item") {
    return `${kind}-${String(++this.n).padStart(6, "0")}`;
  }
  /** One-shot canned response for the first matching request. */
  once(match: Rule["match"], respond: Rule["respond"]) {
    this.rules.push({ match, respond });
  }
  token() {
    const t = `ya29.at-${this.id("t")}`;
    this.tokens.add(t);
    return t;
  }
  meta(i: Item) {
    if (i.mimeType === FOLDER) return { id: i.id, name: i.name, mimeType: i.mimeType, parents: i.parents, trashed: i.trashed };
    return {
      id: i.id,
      name: i.name,
      mimeType: i.mimeType,
      parents: i.parents,
      trashed: i.trashed,
      size: String(i.content.length),
      md5Checksum: md5(i.content),
      ...(this.omitSha256 ? {} : { sha256Checksum: this.corruptSha256 ? "0".repeat(64) : sha(i.content) }),
    };
  }
  remove(id: string) {
    this.items.delete(id);
    for (const c of [...this.items.values()].filter((i) => i.parents.includes(id))) this.remove(c.id);
  }
  store(name: string, parents: string[], content: Buffer, id?: string) {
    const item = id ? { ...this.items.get(id)!, content } : { id: this.id(), name, parents, mimeType: "application/octet-stream", content, trashed: false };
    this.items.set(item.id, item);
    return item;
  }

  fetchFn = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const b = init.body;
    const body = b === undefined || b === null ? Buffer.alloc(0) : typeof b === "string" || b instanceof URLSearchParams ? Buffer.from(String(b)) : Buffer.from(b as Uint8Array);
    this.calls.push({ method, url: url.href, auth: headers.get("authorization"), body: body.toString("latin1") });
    const rule = this.rules.findIndex((r) => r.match(method, url));
    if (rule >= 0) return this.rules.splice(rule, 1)[0]!.respond();

    if (url.href === TOKEN_URL) return this.tokenEndpoint(new URLSearchParams(body.toString()));
    if (url.href === REVOKE_URL) {
      this.revoked.push(new URLSearchParams(body.toString()).get("token")!);
      return res(200, {});
    }
    assert.equal(url.host, "www.googleapis.com", `unexpected host ${url.host}`);
    const upload = url.searchParams.get("upload_id");
    if (upload) return this.sessionChunk(method, upload, headers, body);
    const bearer = headers.get("authorization")?.replace(/^Bearer /, "");
    if (!bearer || !this.tokens.has(bearer)) return res(401, { error: { code: 401, status: "UNAUTHENTICATED", message: "Request had invalid authentication credentials." } });

    const path = url.pathname;
    if (path === "/drive/v3/about") return res(200, { user: { emailAddress: this.account } });
    if (path === "/drive/v3/files" && method === "GET") return this.list(url.searchParams.get("q")!);
    if (path === "/drive/v3/files" && method === "POST") {
      const m = JSON.parse(body.toString()) as { name: string; mimeType: string; parents?: string[] };
      const item = { id: this.id("fold"), name: m.name, parents: m.parents ?? ["my-drive-root"], mimeType: m.mimeType, content: Buffer.alloc(0), trashed: false };
      this.items.set(item.id, item);
      return res(200, { id: item.id });
    }
    const one = /^\/drive\/v3\/files\/([\w-]+)$/.exec(path);
    if (one) {
      const item = this.items.get(one[1]!);
      if (!item) return res(404, { error: { code: 404, errors: [{ reason: "notFound" }], message: `File not found: ${one[1]}` } });
      if (method === "DELETE") {
        this.remove(item.id);
        return new Response(null, { status: 204 });
      }
      if (method === "PATCH") Object.assign(item, JSON.parse(body.toString()));
      if (url.searchParams.get("alt") === "media") return new Response(item.content, { status: 200, headers: { "content-length": String(item.content.length) } });
      return res(200, this.meta(item));
    }
    if (path.startsWith("/upload/drive/v3/files")) return this.upload(method, url, headers, body);
    throw new Error(`fake Google: unhandled ${method} ${url.href}`);
  };

  tokenEndpoint(form: URLSearchParams): Response {
    if (form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== CLIENT_SECRET) return res(401, { error: "invalid_client" });
    if (form.get("grant_type") === "refresh_token") {
      if (!this.refreshTokens.has(form.get("refresh_token")!)) return res(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
      return res(200, { access_token: this.token(), expires_in: 3599, scope: this.scope, token_type: "Bearer" });
    }
    const verifier = form.get("code_verifier") ?? "";
    const pkceOk = createHash("sha256").update(verifier).digest("base64url") === this.challenge;
    if (form.get("code") !== "good-code" || !pkceOk || form.get("redirect_uri") !== REDIRECT_URI) return res(400, { error: "invalid_grant" });
    const refresh = `1//refresh-${this.id("r")}`;
    this.refreshTokens.add(refresh);
    return res(200, { access_token: this.token(), expires_in: 3599, scope: this.scope, token_type: "Bearer", ...(this.grantRefresh ? { refresh_token: refresh } : {}) });
  }

  list(q: string): Response {
    this.queries.push(q);
    const parent = /'([^']+)' in parents/.exec(q)?.[1];
    const name = /name = '([^']+)'/.exec(q)?.[1];
    const files = [...this.items.values()].filter(
      (i) =>
        !i.trashed &&
        (!parent || i.parents.includes(parent)) &&
        (!name || i.name === name) &&
        (!q.includes(`mimeType = '${FOLDER}'`) || i.mimeType === FOLDER) &&
        (!q.includes(`mimeType != '${FOLDER}'`) || i.mimeType !== FOLDER),
    );
    return res(200, { files: files.map((i) => this.meta(i)) });
  }

  upload(method: string, url: URL, headers: Headers, body: Buffer): Response {
    const target = /^\/upload\/drive\/v3\/files\/([\w-]+)$/.exec(url.pathname)?.[1];
    const type = url.searchParams.get("uploadType");
    if (type === "media" && method === "PATCH" && target) return res(200, this.meta(this.store("", [], body, target)));
    if (type === "multipart" && method === "POST") {
      const boundary = /boundary=(.+)$/.exec(headers.get("content-type")!)![1]!;
      const parts = body.toString("latin1").split(`--${boundary}`);
      const part = (p: string) => p.slice(p.indexOf("\r\n\r\n") + 4, -2);
      const m = JSON.parse(part(parts[1]!)) as { name: string; parents: string[] };
      return res(200, this.meta(this.store(m.name, m.parents, Buffer.from(part(parts[2]!), "latin1"))));
    }
    if (type === "resumable") {
      const sid = this.id("s");
      this.sessions.set(sid, { target, meta: target ? undefined : JSON.parse(body.toString()), total: Number(headers.get("x-upload-content-length")), data: Buffer.alloc(0) });
      return new Response(null, { status: 200, headers: { location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${sid}` } });
    }
    throw new Error(`fake Google: unhandled upload ${method} ${url.href}`);
  }

  sessionChunk(method: string, sid: string, headers: Headers, body: Buffer): Response {
    const s = this.sessions.get(sid);
    if (!s) return res(404, { error: { errors: [{ reason: "notFound" }] } });
    if (method === "DELETE") {
      this.cancelled.push(sid);
      this.sessions.delete(sid);
      return new Response(null, { status: 499 });
    }
    const [, start, , total] = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers.get("content-range")!)!.map(Number) as number[];
    assert.equal(total, s.total);
    assert.equal(start, s.data.length, "chunk must start where Google's Range said");
    const take = this.partialChunkOnce ? Math.floor(body.length / 2) : body.length;
    this.partialChunkOnce = false;
    s.data = Buffer.concat([s.data, body.subarray(0, take)]);
    if (s.data.length < s.total) return new Response(null, { status: 308, headers: s.data.length ? { range: `bytes=0-${s.data.length - 1}` } : {} });
    this.sessions.delete(sid);
    return res(200, this.meta(this.store(s.meta?.name ?? "", s.meta?.parents ?? [], s.data, s.target)));
  }
}

const cfg = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, tokenFile: TOKEN_FILE, account: ACCOUNT, permanentDelete: false };

/** A fake Google with a connected account: folders created through the real setUpFolders, connection file written. */
async function connected(tokenFile = TOKEN_FILE) {
  const g = new FakeGoogle();
  const t = g.token();
  const folders = await setUpFolders(new DriveClient(async () => t, g.fetchFn, noSleep));
  await writeConnection(tokenFile, { clientId: CLIENT_ID, account: ACCOUNT, refreshToken: "1//refresh-good", folders, connectedAt: new Date().toISOString() });
  return { g, folders };
}
const drive = (g: FakeGoogle, extra: Partial<typeof cfg> = {}, opts: Record<string, unknown> = {}) =>
  new GoogleDriveStorage({ ...cfg, ...extra }, "Screenshots", { fetchFn: g.fetchFn, sleep: noSleep, ...opts });

describe("Google Drive adapter (MOCKED Google)", () => {
  test("folders: connect creates InsightWorkfolio/{Screenshots,Timelapse,TestFiles}; reused when live, recreated when one is trashed", async () => {
    const { g, folders } = await connected();
    const root = g.items.get(folders.root)!;
    assert.equal(root.name, "InsightWorkfolio");
    assert.deepEqual(root.parents, ["my-drive-root"]);
    for (const area of ["Screenshots", "Timelapse", "TestFiles"] as const) assert.deepEqual([g.items.get(folders[area])!.name, g.items.get(folders[area])!.parents], [area, [folders.root]]);
    const client = new DriveClient(async () => [...g.tokens][0]!, g.fetchFn, noSleep);
    assert.deepEqual(await setUpFolders(client, folders), folders, "all live: reused");
    g.items.get(folders.Timelapse)!.trashed = true;
    const again = await setUpFolders(client, folders);
    assert.notEqual(again.root, folders.root, "one trashed: a fresh tree");
    assert.ok(!g.queries.some((q) => q.includes("name = 'InsightWorkfolio'")), "never searches the Drive for the root folder by name");
  });

  test("upload and download: nested folders created once, encoded multipart, verified checksum, overwrite keeps the item ID", async () => {
    const { g, folders } = await connected();
    const s = drive(g);
    const a = randomBytes(3000);
    const key = `${randomUUID()}/2026-11/${randomUUID()}.webp`;
    const item = await s.put(key, a);
    assert.equal(item.size, a.length);
    assert.equal(item.sha256, sha(a));
    const [emp, month] = key.split("/");
    const empFolder = [...g.items.values()].find((i) => i.name === emp)!;
    assert.deepEqual(empFolder.parents, [folders.Screenshots], "first segment is a folder inside Screenshots");
    assert.equal([...g.items.values()].find((i) => i.name === month)!.parents[0], empFolder.id);
    assert.deepEqual(Buffer.from(await s.get(key)), a);
    const b = randomBytes(1234);
    const replaced = await s.put(key, b);
    assert.equal(replaced.itemId, item.itemId, "overwrite = media update of the same file");
    assert.deepEqual(Buffer.from(await s.get(key)), b);
    assert.equal(g.calls.filter((c) => c.method === "POST" && c.url.includes("/drive/v3/files?fields=id")).length, 4 + 2, "4 connect folders + 2 key folders, no duplicates");
    assert.ok(g.calls.filter((c) => c.url.startsWith("https://www.googleapis.com/")).every((c) => c.auth?.startsWith("Bearer ya29.")), "every Drive call is authenticated");
    assert.ok(!g.calls.some((c) => c.url.includes(CLIENT_SECRET) || c.url.includes("refresh")), "no secret or refresh token in any URL");
  });

  test("metadata verification: a size or SHA-256 mismatch fails the upload; MD5 is used when Drive gives no SHA-256", async () => {
    const { g } = await connected();
    const s = drive(g);
    const data = randomBytes(500);
    g.corruptSha256 = true;
    await assert.rejects(s.put("emp/x.webp", data), /checksum mismatch/);
    g.corruptSha256 = false;
    g.omitSha256 = true;
    const item = await s.put("emp/y.webp", data);
    assert.equal(item.sha256, undefined);
    assert.equal((await s.stat("emp/y.webp"))?.size, 500);
    g.once((m, u) => m === "POST" && u.searchParams.get("uploadType") === "multipart", () => res(200, { id: "item-999999", size: "499", md5Checksum: md5(data) }));
    await assert.rejects(s.put("emp/z.webp", data), /size or checksum mismatch/);
    assert.equal(await s.stat("emp/missing.webp"), null);
    assert.equal(await s.stat("nofolder/x.webp"), null);
    assert.ok(![...g.items.values()].some((i) => i.name === "nofolder"), "lookups never create folders");
  });

  test("resumable upload: chunks follow Google's Range (partial receipt resumed), 308 handled, checksum verified, existing file updated in place", async () => {
    const { g } = await connected();
    const s = drive(g, {}, { chunkBytes: 256 * 1024 });
    const path = join(TMP, "big.bin");
    const big = randomBytes(700 * 1024); // 3 chunks of 256 KiB
    writeFileSync(path, big);
    g.partialChunkOnce = true; // Google keeps only half of the first chunk
    const item = await s.putFile("tl/video.mp4", path);
    assert.equal(item.size, big.length);
    assert.equal(item.sha256, sha(big));
    const puts = g.calls.filter((c) => c.method === "PUT");
    assert.equal(puts.length, 4, "3 chunks + the resent half");
    assert.deepEqual(Buffer.from(await s.get("tl/video.mp4", big.length)), big);
    const again = await s.putFile("tl/video.mp4", path);
    assert.equal(again.itemId, item.itemId, "re-upload updates the same file");
    const init = g.calls.filter((c) => c.url.includes("uploadType=resumable") && !c.url.includes("upload_id"));
    assert.deepEqual(init.map((c) => c.method), ["POST", "PATCH"]);
  });

  test("resumable upload: a failing chunk cancels the session; a session URL off Google's upload endpoint is refused", async () => {
    const { g } = await connected();
    const s = drive(g, {}, { chunkBytes: 256 * 1024 });
    const path = join(TMP, "mid.bin");
    writeFileSync(path, randomBytes(600 * 1024));
    g.once((m, u) => m === "PUT" && !!u.searchParams.get("upload_id"), () => res(400, { error: { errors: [{ reason: "badContent" }] } }));
    await assert.rejects(s.putFile("tl/a.mp4", path), (e: Error) => e instanceof StorageError && /HTTP 400, badContent/.test(e.message));
    assert.equal(g.cancelled.length, 1, "session cancelled");
    g.once((m, u) => u.searchParams.get("uploadType") === "resumable" && !u.searchParams.get("upload_id"), () => new Response(null, { status: 200, headers: { location: "https://evil.example/upload" } }));
    await assert.rejects(s.putFile("tl/b.mp4", path), /upload session failed \(invalid response\)/);
    assert.ok(!g.calls.some((c) => c.url.startsWith("https://evil.example")), "the token never goes to a foreign session URL");
  });

  test("streaming: getStream yields the bytes, bounded by maxBytes (declared or sent)", async () => {
    const { g } = await connected();
    const s = drive(g);
    const data = randomBytes(64 * 1024);
    await s.put("tl/s.mp4", data);
    const { stream, size } = await s.getStream("tl/s.mp4", data.length);
    assert.equal(size, data.length);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c);
    assert.deepEqual(Buffer.concat(chunks), data);
    await assert.rejects(s.getStream("tl/s.mp4", data.length - 1), /larger than allowed/);
    await assert.rejects(s.get("tl/s.mp4", 10), /larger than allowed/);
    // Drive declares a small size but sends more: cut off at maxBytes.
    g.once((_, u) => u.searchParams.get("alt") === "media", () => new Response(randomBytes(data.length + 100), { status: 200 }));
    await assert.rejects(s.get("tl/s.mp4", data.length), /larger than allowed/);
    await assert.rejects(s.get("tl/none.mp4"), /File not found in storage/);
  });

  test("delete: trash by default (idempotent), permanent delete when configured", async () => {
    const { g } = await connected();
    const s = drive(g);
    assert.equal(s.deletionMode, "RECYCLE_BIN");
    const item = await s.put("emp/d.webp", randomBytes(10));
    await s.delete("emp/d.webp");
    assert.equal(g.items.get(item.itemId)!.trashed, true, "in the trash");
    assert.equal(await s.stat("emp/d.webp"), null);
    await s.delete("emp/d.webp"); // idempotent
    const p = drive(g, { permanentDelete: true });
    assert.equal(p.deletionMode, "PERMANENT");
    const gone = await p.put("emp/e.webp", randomBytes(10));
    await p.delete("emp/e.webp");
    assert.equal(g.items.has(gone.itemId), false);
    assert.ok(g.calls.some((c) => c.method === "DELETE" && c.url.endsWith(`/files/${gone.itemId}`)));
  });

  test("folder lookup: concurrent first uploads into one new folder create it once", async () => {
    const { g } = await connected();
    const s = drive(g);
    await Promise.all(Array.from({ length: 5 }, (_, i) => s.put(`emp9/2026-11/f${i}.webp`, randomBytes(20))));
    assert.equal([...g.items.values()].filter((i) => i.name === "emp9").length, 1);
    assert.equal([...g.items.values()].filter((i) => i.name === "2026-11").length, 1);
  });

  test("rate limits: 429 (Retry-After), 5xx and 403 rateLimitExceeded are retried (bounded); other 403s are not", async () => {
    const { g } = await connected();
    const waits: number[] = [];
    const s = drive(g, {}, { sleep: async (ms: number) => void waits.push(ms) });
    await s.put("emp/r.webp", randomBytes(10));
    const isLookup = (m: string, u: URL) => m === "GET" && u.pathname === "/drive/v3/files";
    g.once(isLookup, () => res(429, { error: { errors: [{ reason: "rateLimitExceeded" }] } }, { "retry-after": "2" }));
    g.once(isLookup, () => res(403, { error: { errors: [{ reason: "userRateLimitExceeded" }] } }));
    assert.equal((await s.stat("emp/r.webp"))?.size, 10);
    assert.deepEqual(waits, [2000, 1000]);
    for (let i = 0; i < 3; i++) g.once(isLookup, () => res(503, { error: { status: "UNAVAILABLE" } }, { "retry-after": "60" }));
    await assert.rejects(s.stat("emp/r.webp"), /HTTP 503, UNAVAILABLE/);
    assert.ok(waits.slice(2).every((w) => w <= 5000), "waits are capped");
    g.once(isLookup, () => res(403, { error: { errors: [{ reason: "insufficientFilePermissions" }], message: "secret-ish echo" } }));
    await assert.rejects(s.stat("emp/r.webp"), (e: Error) => /HTTP 403, insufficientFilePermissions/.test(e.message) && !e.message.includes("echo"));
  });

  test("auth: a 401 refreshes once and retries; a revoked grant asks to reconnect; wrong or missing connections are refused", async () => {
    const { g } = await connected();
    const s = drive(g);
    await s.put("emp/a.webp", randomBytes(10));
    g.tokens.clear(); // access token expired early
    assert.equal((await s.stat("emp/a.webp"))?.size, 10);
    g.tokens.clear();
    g.refreshTokens.clear(); // user revoked access
    await assert.rejects(s.stat("emp/a.webp"), (e: Error) => e instanceof StorageError && /expired or was revoked; reconnect/.test(e.message) && !e.message.includes("1//"));
    g.refreshTokens.add("1//refresh-good");
    g.scope = `${DRIVE_FILE_SCOPE} https://www.googleapis.com/auth/drive`;
    await assert.rejects(drive(g).stat("emp/a.webp"), /scope other than drive.file/);
    g.scope = DRIVE_FILE_SCOPE;
    await assert.rejects(drive(g, { clientId: "prod-client.apps.googleusercontent.com" }).stat("emp/a.webp"), /another OAuth client or account/);
    await assert.rejects(drive(g, { tokenFile: join(TMP, "nope.json") }).stat("emp/a.webp"), /not connected yet/);
    const persistent401 = drive(g);
    await persistent401.stat("emp/a.webp");
    g.once((m, u) => u.pathname === "/drive/v3/files", () => res(401, {}));
    g.once((m, u) => u.pathname === "/drive/v3/files", () => res(401, {}));
    await assert.rejects(persistent401.stat("emp/a.webp"), /HTTP 401/);
  });

  test("keys: traversal, separators, quotes and hidden names are refused before any request", async () => {
    const { g } = await connected();
    const s = drive(g);
    const before = g.calls.length;
    for (const key of ["../x.webp", "a/../b.webp", "a//b.webp", ".hidden", "a/.b", "a'b/c.webp", "a\\b", "a/b c", "", "1/2/3/4/5/6/7/8/9"]) {
      await assert.rejects(s.put(key, randomBytes(1)), /Invalid storage key/, key);
      await assert.rejects(s.stat(key), /Invalid storage key/, key);
    }
    assert.equal(g.calls.length, before);
  });

  test("errors and timeouts carry no secret, token or Google message", async () => {
    const { g } = await connected();
    const slow = drive(g, {}, { timeoutMs: 20, fetchFn: (u: string, i: RequestInit) => (String(u).includes("oauth2") ? g.fetchFn(u, i) : new Promise((_, rej) => i.signal!.addEventListener("abort", () => rej(i.signal!.reason)))) });
    await assert.rejects(slow.stat("emp/a.webp"), /timed out/);
    g.once((_, u) => u.href === TOKEN_URL, () => res(500, { error: "server_error", error_description: `bad ${CLIENT_SECRET}` }));
    await assert.rejects(drive(g).stat("emp/a.webp"), (e: Error) => e.message === "Google token request failed (server_error)");
  });

  test("connection file: 0600 in a 0700 directory; malformed content is an error, not a silent reconnect", async () => {
    const file = join(TMP, "perm", "c.json");
    await connected(file);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(TMP, "perm")).mode & 0o777, 0o700);
    await writeFile(file, "{not json");
    await assert.rejects(readConnection(file), /malformed/);
    await writeFile(file, JSON.stringify({ clientId: "c", account: "a", refreshToken: "r", connectedAt: "x", folders: { root: "../../etc" } }));
    await assert.rejects(readConnection(file), /malformed/);
    assert.equal(await readConnection(join(TMP, "perm", "missing.json")), null);
  });
});

describe("verify-google-drive script (MOCKED Google)", () => {
  test("blocked without configuration or connection; nothing contacted", async () => {
    const lines: string[] = [];
    const fetchFn = () => assert.fail("must not contact anything");
    assert.equal(await verifyRun([], { fetchFn, log: (l: string) => lines.push(l) }), 2);
    const env = join(TMP, "verify-empty.env");
    writeFileSync(env, "GOOGLE_OAUTH_CLIENT_ID=x\n");
    assert.equal(await verifyRun([env], { fetchFn, log: (l: string) => lines.push(l) }), 2);
    writeFileSync(env, `GOOGLE_OAUTH_CLIENT_ID=${CLIENT_ID}\nGOOGLE_OAUTH_CLIENT_SECRET=${CLIENT_SECRET}\nGOOGLE_DRIVE_TOKEN_FILE=${join(TMP, "none.json")}\nGOOGLE_DRIVE_ACCOUNT_EMAIL=${ACCOUNT}\n`);
    assert.equal(await verifyRun([env], { fetchFn, log: (l: string) => lines.push(l) }), 2);
    assert.match(lines.at(-1)!, /not connected yet/);
  });

  test("--write passes end to end, cleans up only its own items, never prints secrets; a foreign visible item is a BREACH", async () => {
    const file = join(TMP, "verify-conn.json");
    const { g, folders } = await connected(file);
    const personal = { id: "personal-000001", name: "taxes.pdf", parents: ["my-drive-root"], mimeType: "application/pdf", content: Buffer.from("x"), trashed: false };
    const env = join(TMP, "verify.env");
    writeFileSync(env, `GOOGLE_OAUTH_CLIENT_ID=${CLIENT_ID}\nGOOGLE_OAUTH_CLIENT_SECRET=${CLIENT_SECRET}\nGOOGLE_DRIVE_TOKEN_FILE=${file}\nGOOGLE_DRIVE_ACCOUNT_EMAIL=${ACCOUNT}\nGOOGLE_DRIVE_VERIFY_UNRELATED_FILE_ID=${personal.id}\n`);
    const before = new Set(g.items.keys());
    const lines: string[] = [];
    const code = await verifyRun([env, "--write"], { fetchFn: g.fetchFn, sleep: noSleep, chunkBytes: 4 * 1024 * 1024, log: (l: string) => lines.push(l) });
    assert.equal(code, 0, lines.join("\n"));
    assert.ok(lines.some((l) => l.startsWith("PASS   6. Deleted file is inaccessible")));
    assert.ok(lines.some((l) => /A file you named is not accessible\s+HTTP 404/.test(l)));
    assert.deepEqual(new Set(g.items.keys()), before, "only its own items were created and removed");
    assert.ok(!lines.join("\n").match(/GOCSPX|1\/\/refresh|ya29\./), "no secret or token printed");
    assert.ok(g.items.has(folders.TestFiles));
    g.items.set(personal.id, personal); // drive.file would never show this: if it does, access is too broad
    const breach: string[] = [];
    assert.equal(await verifyRun([env], { fetchFn: g.fetchFn, sleep: noSleep, log: (l: string) => breach.push(l) }), 4);
    assert.ok(breach.some((l) => l.startsWith("BREACH") && l.includes("outside InsightWorkfolio")));
  });
});

describe("environment rules", () => {
  const prod = {
    NODE_ENV: "production",
    DATABASE_URL: "libsql://db-org.turso.io",
    JWT_SECRET: "x".repeat(40),
    CORS_ORIGINS: "https://app.example.com",
    DASHBOARD_URL: "https://app.example.com",
    SCREENSHOT_STORAGE: "google-drive",
    GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    GOOGLE_OAUTH_REDIRECT_URI: "https://api.example.com/api/v1/storage/google-drive/oauth/callback",
    GOOGLE_DRIVE_TOKEN_FILE: "/etc/secrets/google-drive.json",
    GOOGLE_DRIVE_ACCOUNT_EMAIL: ACCOUNT,
  };
  const fails = (env: Record<string, string>, re: RegExp) => assert.throws(() => validateEnv(env), re);

  test("google-drive needs all five Google values; production accepts it, still refuses local", () => {
    assert.equal(validateEnv(prod).SCREENSHOT_STORAGE, "google-drive");
    assert.equal(GOOGLE_OAUTH_CALLBACK_PATH, "/api/v1/storage/google-drive/oauth/callback");
    for (const k of ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REDIRECT_URI", "GOOGLE_DRIVE_TOKEN_FILE", "GOOGLE_DRIVE_ACCOUNT_EMAIL"]) {
      fails({ ...prod, [k]: "" }, /all required for Google Drive/);
    }
    fails({ ...prod, SCREENSHOT_STORAGE: "local" }, /local storage is for development only/);
    fails({ NODE_ENV: "development", GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID }, /all required for Google Drive/);
    assert.equal(validateEnv({ NODE_ENV: "development" }).GOOGLE_OAUTH_CLIENT_ID, undefined, "not configured: nothing required");
  });

  test("redirect URI: exactly the callback path; https (http only for localhost outside production); no query", () => {
    const uri = (v: string) => ({ ...prod, GOOGLE_OAUTH_REDIRECT_URI: v });
    fails(uri("https://api.example.com/api/v1/storage/google-drive/oauth/callback/"), /GOOGLE_OAUTH_REDIRECT_URI/);
    fails(uri("https://api.example.com/oauth/callback"), /GOOGLE_OAUTH_REDIRECT_URI/);
    fails(uri("https://api.example.com/api/v1/storage/google-drive/oauth/callback?next=https://evil.example"), /GOOGLE_OAUTH_REDIRECT_URI/);
    fails(uri("http://api.example.com/api/v1/storage/google-drive/oauth/callback"), /GOOGLE_OAUTH_REDIRECT_URI/);
    fails(uri(REDIRECT_URI), /GOOGLE_OAUTH_REDIRECT_URI/); // localhost http in production
    fails(uri("not a url"), /GOOGLE_OAUTH_REDIRECT_URI/);
    const dev = { ...prod, NODE_ENV: "development", DATABASE_URL: "file:./x.db", GOOGLE_OAUTH_REDIRECT_URI: REDIRECT_URI };
    assert.equal(validateEnv(dev).GOOGLE_OAUTH_REDIRECT_URI, REDIRECT_URI);
    fails({ ...dev, GOOGLE_DRIVE_TOKEN_FILE: "data/google.json" }, /absolute path/);
    fails({ ...dev, GOOGLE_DRIVE_ACCOUNT_EMAIL: "not-an-email" }, /email/);
    assert.equal(validateEnv({ ...dev, GOOGLE_DRIVE_ACCOUNT_EMAIL: " Owner@Example.COM " }).GOOGLE_DRIVE_ACCOUNT_EMAIL, ACCOUNT);
  });
});

describe("OAuth flow and routes (MOCKED Google)", () => {
  let app: INestApplication;
  let base: string;
  let admin: string;
  let employee: string;
  let oauth: InstanceType<typeof GoogleDriveOAuthService>;
  let g: FakeGoogle;
  const call = (path: string, cookie?: string) => fetch(`${base}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
  /** Admin starts; returns the Google URL params and the binding cookie (as the browser would hold it). */
  async function start() {
    const r = await call("/api/v1/storage/google-drive/oauth/start", admin);
    assert.equal(r.status, 302);
    const google = new URL(r.headers.get("location")!);
    const set = r.headers.getSetCookie().find((c) => c.startsWith(`${BINDING_COOKIE}=`))!;
    g.challenge = google.searchParams.get("code_challenge")!;
    return { google, set, cookie: set.split(";")[0]!, state: google.searchParams.get("state")! };
  }
  const callback = (q: Record<string, string>, cookie?: string) => call(`${GOOGLE_OAUTH_CALLBACK_PATH}?${new URLSearchParams(q)}`, cookie);
  const outcome = (r: Response) => new URL(r.headers.get("location")!).searchParams.get("googleDrive");

  before(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(0);
    base = (await app.getUrl()).replace("[::1]", "localhost");
    const db = app.get(DATABASE);
    const login = async (email: string, role: string) => {
      await db.execute({ sql: "INSERT INTO users (id, email, role, admin_title, password_hash) VALUES (?, ?, ?, ?, ?)", args: [randomUUID(), email, role, role === "ADMIN" ? "SUPER_ADMIN" : null, await hashPassword("pass phrase 123")] }); // connecting storage is Super Admin-only
      const r = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify({ email, password: "pass phrase 123" }) });
      return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    };
    admin = await login("admin@example.com", "ADMIN");
    employee = await login("emp@example.com", "EMPLOYEE");
    oauth = app.get(GoogleDriveOAuthService);
  });
  after(async () => {
    await app.close();
    rmSync(TMP, { recursive: true, force: true });
  });
  const fresh = () => {
    g = new FakeGoogle();
    oauth.fetchFn = g.fetchFn;
    rmSync(TOKEN_FILE, { force: true });
  };

  test("start: admins only; redirects to Google with drive.file, offline, consent, PKCE S256 and a state; binding cookie is HttpOnly, Lax, callback-scoped", async () => {
    fresh();
    assert.equal((await call("/api/v1/storage/google-drive/oauth/start")).status, 401);
    assert.equal((await call("/api/v1/storage/google-drive/oauth/start", employee)).status, 403);
    const { google, set } = await start();
    assert.equal(`${google.origin}${google.pathname}`, "https://accounts.google.com/o/oauth2/v2/auth");
    const p = Object.fromEntries(google.searchParams);
    assert.equal(p.scope, DRIVE_FILE_SCOPE, "only drive.file");
    assert.deepEqual([p.client_id, p.redirect_uri, p.response_type, p.access_type, p.prompt, p.code_challenge_method], [CLIENT_ID, REDIRECT_URI, "code", "offline", "consent", "S256"]);
    assert.ok(p.state!.length >= 43 && p.code_challenge!.length >= 43);
    assert.ok(!google.href.includes(CLIENT_SECRET), "the secret never reaches the browser");
    assert.match(set, /HttpOnly/);
    assert.match(set, /SameSite=Lax/);
    assert.match(set, new RegExp(`Path=${GOOGLE_OAUTH_CALLBACK_PATH.replace(/\//g, "\\/")}`));
  });

  test("callback: valid state + same browser connects; refresh token only in the 0600 token file; state is single use", async () => {
    fresh();
    const { state, cookie } = await start();
    const r = await callback({ state, code: "good-code", scope: DRIVE_FILE_SCOPE }, cookie);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "http://localhost:3000/settings?googleDrive=connected");
    assert.match(r.headers.getSetCookie().join(), new RegExp(`${BINDING_COOKIE}=;`), "binding cookie cleared");
    const conn = JSON.parse(await readFile(TOKEN_FILE, "utf8"));
    assert.equal(conn.clientId, CLIENT_ID);
    assert.equal(conn.account, ACCOUNT);
    assert.match(conn.refreshToken, /^1\/\/refresh-/);
    assert.equal(statSync(TOKEN_FILE).mode & 0o777, 0o600);
    assert.equal(g.items.get(conn.folders.root)!.name, "InsightWorkfolio");
    const body = await r.text();
    assert.ok(!body.includes(conn.refreshToken) && !r.headers.get("location")!.includes("refresh"), "no token in the response");
    const exchange = g.calls.find((c) => c.url === TOKEN_URL)!;
    assert.match(exchange.body, /code_verifier=/, "PKCE verifier sent server-side");
    assert.equal(outcome(await callback({ state, code: "good-code" }, cookie)), "failed", "replay refused");
    // The connected token file drives the adapter: a reconnect keeps the same folders.
    const s = new GoogleDriveStorage({ ...cfg }, "TestFiles", { fetchFn: g.fetchFn, sleep: noSleep });
    await s.put("x/ok.bin", randomBytes(10));
    const second = await start();
    assert.equal(outcome(await callback({ state: second.state, code: "good-code" }, second.cookie)), "connected");
    assert.deepEqual(JSON.parse(await readFile(TOKEN_FILE, "utf8")).folders, conn.folders, "reconnect reuses the live folders");
  });

  test("callback: unknown, expired, other-browser and cookie-less states are refused, and a refused state is burnt", async () => {
    fresh();
    const exchanges = () => g.calls.filter((c) => c.url === TOKEN_URL).length;
    assert.equal(outcome(await callback({ state: "forged", code: "good-code" })), "failed");
    const a = await start();
    assert.equal(outcome(await callback({ state: a.state, code: "good-code" })), "failed", "no cookie");
    assert.equal(outcome(await callback({ state: a.state, code: "good-code" }, a.cookie)), "failed", "burnt by the failed attempt");
    const b = await start();
    assert.equal(outcome(await callback({ state: b.state, code: "good-code" }, `${BINDING_COOKIE}=another-browsers-value`)), "failed");
    const c = await start();
    const realNow = Date.now;
    Date.now = () => realNow() + STATE_TTL_MS + 1;
    try {
      assert.equal(outcome(await callback({ state: c.state, code: "good-code" }, c.cookie)), "failed", "expired");
    } finally {
      Date.now = realNow;
    }
    assert.equal(exchanges(), 0, "no code was exchanged");
    assert.throws(() => statSync(TOKEN_FILE));
  });

  test("callback: consent denied, a wrong account, a broader scope or no refresh token never leave a connection; foreign grants are revoked", async () => {
    fresh();
    const d = await start();
    assert.equal(outcome(await callback({ state: d.state, error: "access_denied" }, d.cookie)), "denied");
    g.account = "someone.else@example.com";
    const w = await start();
    assert.equal(outcome(await callback({ state: w.state, code: "good-code" }, w.cookie)), "failed");
    assert.equal(g.revoked.length, 1);
    g.account = ACCOUNT;
    g.scope = `${DRIVE_FILE_SCOPE} https://www.googleapis.com/auth/drive`;
    const s = await start();
    assert.equal(outcome(await callback({ state: s.state, code: "good-code" }, s.cookie)), "failed");
    assert.equal(g.revoked.length, 2);
    g.scope = DRIVE_FILE_SCOPE;
    g.grantRefresh = false;
    const n = await start();
    assert.equal(outcome(await callback({ state: n.state, code: "good-code" }, n.cookie)), "failed");
    const bad = await start();
    g.grantRefresh = true;
    assert.equal(outcome(await callback({ state: bad.state, code: "wrong-code" }, bad.cookie)), "failed");
    assert.throws(() => statSync(TOKEN_FILE), "nothing was written");
    assert.ok(g.items.size === 0, "no folders were created");
  });

  test("provider: SCREENSHOT_STORAGE=google-drive refuses to start until the schema accepts GOOGLE_DRIVE; local and graph unchanged", async () => {
    const real = app.get(DATABASE);
    const config = (kind: string) => ({ get: (k: string) => (k === "SCREENSHOT_STORAGE" ? kind : k === "SCREENSHOT_LOCAL_DIR" ? join(TMP, "shots") : k === "GOOGLE_DRIVE_PERMANENT_DELETE" ? false : process.env[k] === "Owner@Example.com" ? ACCOUNT : process.env[k]) });
    const factory = (screenshotStorageProvider as { useFactory: (c: unknown, d: unknown) => Promise<unknown> }).useFactory;
    await assert.rejects(factory(config("google-drive"), real), /does not accept GOOGLE_DRIVE yet \(migration pending approval\)/);
    const migrated = { execute: async () => ({ rows: [{ sql: "CREATE TABLE screenshots (storage_provider TEXT CHECK (storage_provider IN ('LOCAL_DEV', 'MICROSOFT_GRAPH', 'GOOGLE_DRIVE')))" }] }) };
    const s = await factory(config("google-drive"), migrated);
    assert.ok(s instanceof GoogleDriveStorage);
    assert.equal((s as { provider: string }).provider, "GOOGLE_DRIVE");
    assert.ok((await factory(config("local"), real)) instanceof LocalDevStorage);
  });
});
