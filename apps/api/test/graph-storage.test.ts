// Microsoft Graph adapter against a fake Graph (no tenant is available; see docs/onedrive.md).
import assert from "node:assert/strict";
import { test } from "node:test";

const { GraphStorage, StorageError, quickXorHash } = await import("../dist/screenshots/storage.js");
const { generateKeyPairSync } = await import("node:crypto");
const { decodeProtectedHeader, jwtVerify } = await import("jose");

const SECRET = "super-secret-client-value";
const cfg = { tenantId: "tenant-1", clientId: "client-1", clientSecret: SECRET, siteId: "contoso.sharepoint.com,site-guid,web-guid", driveId: "b!drive", folder: "Workfolio Screenshots", permanentDelete: false };
const noSleep = async () => {};

/** In-memory drive keyed by item path; records every request. */
function fakeGraph({ failUploads = 0, throttle = 0 } = {}) {
  const files = new Map<string, Uint8Array>();
  const calls: { method: string; url: string; auth: string | null; body?: string }[] = [];
  let tokens = 0;
  let failing = failUploads;
  let throttling = throttle;
  const fetchFn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    calls.push({ method, url, auth: headers.get("authorization"), body: init.body instanceof URLSearchParams ? init.body.toString() : undefined });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://login.microsoftonline.com/")) return json(200, { access_token: `token-${++tokens}`, expires_in: 3600 });
    if (throttling-- > 0) return new Response(JSON.stringify({ error: { code: "activityLimitReached" } }), { status: 429, headers: { "retry-after": "1" } });
    if (url.startsWith("https://graph.microsoft.com/v1.0/sites/")) {
      return url.startsWith(`https://graph.microsoft.com/v1.0/sites/${encodeURIComponent(cfg.siteId)}/drives`) ? json(200, { value: [{ id: "b!other" }, { id: "b!drive" }] }) : json(403, { error: { code: "accessDenied" } });
    }
    const perm = /\/drives\/b!drive\/items\/(.+)\/permanentDelete$/.exec(url);
    if (perm && method === "POST") {
      const path = decodeURIComponent(perm[1]!).replace(/^item:/, "");
      if (!files.delete(path)) return json(404, { error: { code: "itemNotFound" } });
      return new Response(null, { status: 204 });
    }
    const m = /^https:\/\/graph\.microsoft\.com\/v1\.0\/drives\/b!drive\/root:\/(.+?)(:\/content)?(\?.*)?$/.exec(url);
    if (!m) return json(400, { error: { code: "invalidRequest" } });
    const path = decodeURIComponent(m[1]!);
    if (method === "PUT") {
      if (failing-- > 0) return json(503, { error: { code: "serviceNotAvailable", message: `echo ${SECRET}` } });
      files.set(path, new Uint8Array(init.body as Uint8Array));
      return json(201, { id: `item:${path}`, size: files.get(path)!.length, file: { hashes: { quickXorHash: quickXorHash(files.get(path)!) } } });
    }
    const file = files.get(path);
    if (!file) return json(404, { error: { code: "itemNotFound" } });
    if (method === "DELETE") return files.delete(path), new Response(null, { status: 204 });
    if (m[2]) return new Response(file, { status: 200 });
    return json(200, { id: `item:${path}`, size: file.length, file: { hashes: { quickXorHash: quickXorHash(file) } } });
  };
  return { files, calls, fetchFn: fetchFn as typeof fetch, tokens: () => tokens };
}

test("graph adapter: app-only token (cached), encoded paths in the dedicated folder, put/stat/get/delete", async () => {
  const g = fakeGraph();
  const s = new GraphStorage(cfg, g.fetchFn, noSleep);
  assert.equal(s.deletionMode, "RECYCLE_BIN");
  const key = "emp-1/2026-10/shot 1.webp";
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const stored = await s.put(key, bytes);
  assert.deepEqual([stored.itemId, stored.size], ["item:Workfolio Screenshots/emp-1/2026-10/shot 1.webp", 5]);
  assert.equal((await s.stat(key))?.quickXorHash, quickXorHash(bytes), "provider hash returned for confirmation");
  assert.deepEqual([...(await s.get(key))], [1, 2, 3, 4, 5]);
  await s.delete(key);
  assert.equal(await s.stat(key), null, "deleted");
  await s.delete(key); // idempotent
  assert.equal(g.tokens(), 1, "one token for all calls");

  const tokenCall = g.calls[0]!;
  assert.equal(tokenCall.url, "https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token");
  const form = new URLSearchParams(tokenCall.body);
  assert.deepEqual([form.get("grant_type"), form.get("scope"), form.get("client_id")], ["client_credentials", "https://graph.microsoft.com/.default", "client-1"]);
  const put = g.calls.find((c) => c.method === "PUT")!;
  assert.equal(put.url, "https://graph.microsoft.com/v1.0/drives/b!drive/root:/Workfolio%20Screenshots/emp-1/2026-10/shot%201.webp:/content?@microsoft.graph.conflictBehavior=replace");
  assert.equal(put.auth, "Bearer token-1");
  assert.ok(g.calls.every((c) => !c.url.includes(SECRET)), "the secret never appears in a URL");
});

test("graph adapter: failures are StorageErrors without secrets or Graph messages", async () => {
  const g = fakeGraph({ failUploads: 3 }); // the first attempt and both bounded retries fail
  const s = new GraphStorage(cfg, g.fetchFn, noSleep);
  await assert.rejects(s.put("k.webp", new Uint8Array([1])), (e: Error) => {
    assert.ok(e instanceof StorageError);
    assert.equal(e.message, "Microsoft Graph upload failed (HTTP 503, serviceNotAvailable)");
    return !e.message.includes(SECRET);
  });
  assert.equal((await s.put("k.webp", new Uint8Array([1]))).size, 1, "a retry succeeds");

  const down = new GraphStorage(cfg, (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch);
  await assert.rejects(down.stat("k.webp"), /token request failed \(unreachable\)/);
});

test("graph adapter: throttling is retried with Retry-After (bounded), then reported", async () => {
  const waits: number[] = [];
  const sleep = async (ms: number) => void waits.push(ms);
  const g = fakeGraph({ throttle: 2 });
  assert.equal((await new GraphStorage(cfg, g.fetchFn, sleep).put("a.webp", new Uint8Array([1]))).size, 1, "succeeds on the third attempt");
  assert.deepEqual(waits, [1000, 1000]);
  const g2 = fakeGraph({ throttle: 5 });
  await assert.rejects(new GraphStorage(cfg, g2.fetchFn, sleep).put("a.webp", new Uint8Array([1])), /HTTP 429, activityLimitReached/);
});

test("graph adapter: recycle-bin vs permanent deletion; site scope check", async () => {
  const g = fakeGraph();
  const recycle = new GraphStorage(cfg, g.fetchFn, noSleep);
  await recycle.put("x.webp", new Uint8Array([1]));
  await recycle.delete("x.webp");
  assert.equal(g.calls.at(-1)!.method, "DELETE", "default: DELETE (goes to the SharePoint recycle bin)");

  const permanent = new GraphStorage({ ...cfg, permanentDelete: true }, g.fetchFn, noSleep);
  assert.equal(permanent.deletionMode, "PERMANENT");
  await permanent.put("y.webp", new Uint8Array([1]));
  await permanent.delete("y.webp");
  assert.match(g.calls.at(-1)!.url, /\/items\/.+\/permanentDelete$/);
  assert.equal(await permanent.stat("y.webp"), null);
  await permanent.delete("y.webp"); // already gone: no error

  assert.equal(await recycle.driveBelongsToSite(), true);
  const wrongDrive = new GraphStorage({ ...cfg, driveId: "b!elsewhere" }, g.fetchFn, noSleep);
  assert.equal(await wrongDrive.driveBelongsToSite(), false, "a drive outside the configured site is detected");
  const otherSite = new GraphStorage({ ...cfg, siteId: "contoso.sharepoint.com,other,other" }, g.fetchFn, noSleep);
  await assert.rejects(otherSite.driveBelongsToSite(), /HTTP 403, accessDenied/, "Sites.Selected: unrelated sites are denied");
});

test("graph adapter: certificate credential signs a client assertion; exactly one credential required", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const thumbprint = "AB12CD34EF56AB12CD34EF56AB12CD34EF56AB12";
  const g = fakeGraph();
  const noSecret = { ...cfg, clientSecret: undefined };
  const s = new GraphStorage({ ...noSecret, certificate: { privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), thumbprintSha1Hex: thumbprint } }, g.fetchFn, noSleep);
  await s.put("c.webp", new Uint8Array([1]));
  const form = new URLSearchParams(g.calls[0]!.body);
  assert.equal(form.get("client_secret"), null);
  assert.equal(form.get("client_assertion_type"), "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
  const jwt = form.get("client_assertion")!;
  const { payload } = await jwtVerify(jwt, publicKey, { issuer: "client-1", subject: "client-1", audience: "https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token" });
  assert.ok(payload.jti && payload.exp! - payload.nbf! === 600);
  assert.equal(decodeProtectedHeader(jwt).x5t, Buffer.from(thumbprint, "hex").toString("base64url"));

  assert.throws(() => new GraphStorage(noSecret, g.fetchFn), /exactly one/);
  assert.throws(() => new GraphStorage({ ...cfg, certificate: { privateKeyPem: "", thumbprintSha1Hex: thumbprint } }, g.fetchFn), /exactly one/);
});

test("graph adapter: downloads are bounded to the screenshot size cap (declared or streamed)", async () => {
  const { SCREENSHOT_LIMITS } = await import("@workfolio/shared");
  const big = SCREENSHOT_LIMITS.maxBytes + 1;
  for (const declared of [true, false]) {
    let pulled = 0;
    const fetchFn = (async (url: string) => {
      if (String(url).startsWith("https://login.microsoftonline.com/")) return Response.json({ access_token: "t", expires_in: 3600 });
      // No content-length on the streamed case: the cap must hold while reading, not after.
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          pulled += 1024 * 1024;
          c.enqueue(new Uint8Array(1024 * 1024));
        },
      });
      return new Response(body, { status: 200, headers: declared ? { "content-length": String(big) } : {} });
    }) as typeof fetch;
    const s = new GraphStorage(cfg, fetchFn, noSleep);
    await assert.rejects(s.get("emp/2026-10/x.webp"), (e: Error) => e instanceof StorageError && /larger than a screenshot/.test(e.message));
    assert.ok(pulled <= SCREENSHOT_LIMITS.maxBytes + 2 * 1024 * 1024, `stopped reading early (${declared ? "declared" : "streamed"}: ${pulled} bytes)`);
  }
});
