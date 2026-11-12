// QA round 2 (independent of the implementers' tests): role separation, unauthenticated sweep over every
// route, forged / expired tokens, local storage-key traversal, audited reads, employee attempts on
// screenshot settings, live-status abuse, attendance timeline edges (DST, ties, pagination).
// Tests marked `todo` assert the behaviour the brief asks for and FAIL today: each names a reported defect.
// In-memory database, local storage in a temp dir; nothing external.
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { SignJWT, UnsecuredJWT, decodeJwt } from "jose";

const STORAGE_DIR = mkdtempSync(join(tmpdir(), "wf-qa2-shots-"));
const VIDEO_DIR = mkdtempSync(join(tmpdir(), "wf-qa2-videos-"));
const SECRET = "qa-round2-secret-qa-round2-secret-0123";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL = ":memory:";
process.env.JWT_SECRET = SECRET;
process.env.SCREENSHOT_STORAGE = "local";
process.env.SCREENSHOT_LOCAL_DIR = STORAGE_DIR;
process.env.TIMELAPSE_DIR = VIDEO_DIR;

const { AppModule } = await import("../dist/app.module.js");
const { configureApp } = await import("../dist/app.setup.js");
const { DATABASE } = await import("../dist/database/database.module.js");
const { hashPassword } = await import("../dist/auth/crypto.js");
const { LocalDevStorage } = await import("../dist/screenshots/storage.js");
const { DEFAULT_NOTICE_VERSION, DEFAULT_SCREENSHOT_NOTICE_VERSION } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "employee password 1";
const M = 60_000;
type Db = { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };

let app: INestApplication;
let base: string;
let db: Db;
let superAdmin: string; // cookies
let itAdmin: string;
let superId: string;

type Opts = { method?: string; body?: unknown; raw?: Uint8Array; cookie?: string; bearer?: string; device?: string; key?: string; headers?: Record<string, string> };
async function api(path: string, { method = "GET", body, raw, cookie, bearer, device, key, headers: extra }: Opts = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, ...extra };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (raw) headers["content-type"] = "image/webp";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (device) headers["x-device-id"] = device;
  if (key) headers["idempotency-key"] = key;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: "manual" });
  const text = await res.text();
  return { status: res.status, body: text && (res.headers.get("content-type") ?? "").includes("json") ? JSON.parse(text) : undefined, text };
}
const iso = (ms: number) => new Date(ms).toISOString();
const one = async (sql: string, args: unknown[] = []) => (await db.execute({ sql, args })).rows[0];
const count = async (sql: string, args: unknown[] = []) => Number((await one(sql, args))!.n);
const cookieOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const webLogin = (email: string) => fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });

async function adminUser(email: string, title: "SUPER_ADMIN" | "ADMIN") {
  const id = randomUUID();
  await db.execute({ sql: "INSERT INTO users (id, email, role, admin_title, password_hash) VALUES (?, ?, 'ADMIN', ?, ?)", args: [id, email, title, await hashPassword(PASSWORD)] });
  return { id, cookie: cookieOf(await webLogin(email)) };
}

let seq = 0;
let passwordHash: string | undefined;
/** An employee signed in on the desktop (bearer + refresh token) and the web (cookie), with a registered device. */
async function employee({ timezone = "UTC", consent = true } = {}) {
  const n = ++seq;
  const email = `qa${n}@example.com`;
  const r = await api("/employees", { method: "POST", cookie: itAdmin, body: { email, employeeCode: `QA-${n}`, fullName: `QA ${n}`, timezone } });
  assert.equal(r.status, 201, r.text);
  // Password set directly: POST /auth/setup-password is limited to 20 per IP per 15 minutes (covered in sessions.e2e.test.ts).
  await db.execute({ sql: "UPDATE users SET password_hash = ? WHERE id = ?", args: [(passwordHash ??= await hashPassword(PASSWORD)), r.body.employee.userId] });
  const desktop = await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } });
  const e = {
    id: r.body.employee.id as string, userId: r.body.employee.userId as string, email,
    bearer: desktop.body.accessToken as string, refreshToken: desktop.body.refreshToken as string,
    cookie: cookieOf(await webLogin(email)), device: randomUUID(), deviceId: "",
  };
  const reg = await api("/devices/register", { method: "POST", bearer: e.bearer, body: { installationId: e.device, deviceName: "Mac", platform: "macos" } });
  assert.equal(reg.status, 201, reg.text);
  e.deviceId = reg.body.id;
  if (consent) await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), e.id, DEFAULT_NOTICE_VERSION, iso(Date.now() - 3 * 86_400_000)] });
  return e;
}
type Emp = Awaited<ReturnType<typeof employee>>;

const act = (e: Emp, action: "clock-in" | "clock-out" | "break/start" | "break/end") => api(`/attendance/${action}`, { method: "POST", bearer: e.bearer, device: e.device, key: randomUUID() });
const syncBody = (current: unknown) => ({ sentAt: iso(Date.now()), platform: "macos", intervals: [], current });
const report = (e: Emp, current: unknown) => api("/activity/sync", { method: "POST", bearer: e.bearer, device: e.device, body: syncBody(current) });
const overviewRow = async (e: Emp) => {
  const r = await api("/attendance/overview?pageSize=100", { cookie: itAdmin });
  assert.equal(r.status, 200, r.text);
  return r.body.items.find((x: { employeeId: string }) => x.employeeId === e.id);
};
const deviceRow = (e: Emp) => one("SELECT activity_state, activity_state_since, activity_state_at, screenshot_state FROM devices WHERE id = ?", [e.deviceId]);
async function team(head: Emp, members: Emp[]) {
  const id = randomUUID();
  await db.execute({ sql: "INSERT INTO teams (id, name, head_user_id, created_by) VALUES (?, ?, ?, ?)", args: [id, `Team ${id.slice(0, 8)}`, head.userId, superId] });
  for (const m of members) await db.execute({ sql: "INSERT INTO team_members (team_id, employee_id, added_by) VALUES (?, ?, ?)", args: [id, m.id, superId] });
}
const auditCount = (targetUserId: string) => count("SELECT count(*) AS n FROM account_audit WHERE target_user_id = ? AND action LIKE 'EMPLOYEE_%'", [targetUserId]);
/** A closed session inserted directly (the triggers allow open -> closed only). */
async function closedSession(e: Emp, id: string, inAt: string, outAt: string) {
  await db.execute({ sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, status) VALUES (?, ?, ?, ?, 'OPEN')", args: [id, e.id, e.deviceId, inAt] });
  await db.execute({ sql: "UPDATE attendance_sessions SET clock_out_at = ?, status = 'CLOSED' WHERE id = ?", args: [outAt, id] });
}

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  const s = await adminUser("qa-ceo@example.com", "SUPER_ADMIN");
  [superAdmin, superId] = [s.cookie, s.id];
  itAdmin = (await adminUser("qa-it@example.com", "ADMIN")).cookie;
});
after(async () => {
  await app.close();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
  rmSync(VIDEO_DIR, { recursive: true, force: true });
});

// ---- 1. Role separation -----------------------------------------------------------------------

describe("role separation: Super Admin-only actions", () => {
  let head: Emp, member: Emp, plain: Emp;
  before(async () => {
    [head, member, plain] = [await employee(), await employee(), await employee()];
    await team(head, [member]);
  });
  const reason = { reason: "Captured a private document" };
  const superOnly = (): [string, string, unknown][] => [
    ["DELETE", `/screenshots/${randomUUID()}`, reason],
    ["POST", "/screenshots/retention/run", { confirm: true }],
    ["POST", "/activity/retention/run", { confirm: true }],
    ["DELETE", `/timelapses/${randomUUID()}`, undefined],
    ["GET", "/storage/onedrive/oauth/start", undefined],
    ["POST", "/storage/onedrive/disconnect", undefined],
    ["GET", "/storage/google-drive/oauth/start", undefined],
    ["GET", "/roles/users", undefined],
    ["GET", "/roles/history", undefined],
    ["PATCH", `/roles/users/${randomUUID()}`, { platformRole: "ADMIN", reason: "Joined the IT team" }],
  ];

  test("IT Admin, team head and employee get 403 on every Super Admin-only route; the Super Admin gets past the guard", async () => {
    for (const [method, path, body] of superOnly()) {
      for (const [who, cookie] of [["IT Admin", itAdmin], ["team head", head.cookie], ["employee", plain.cookie]] as const) {
        const r = await api(path, { method, body, cookie });
        assert.equal(r.status, 403, `${who} ${method} ${path}: ${r.status} ${r.text.slice(0, 100)}`);
      }
      const s = await api(path, { method, body, cookie: superAdmin });
      assert.ok(s.status !== 401 && s.status !== 403, `Super Admin ${method} ${path}: ${s.status}`);
    }
  });

  test("headers and body fields cannot raise an IT Admin to Super Admin", async () => {
    const spoof = { "x-role": "SUPER_ADMIN", "x-platform-role": "SUPER_ADMIN", "x-admin-title": "SUPER_ADMIN", "x-user-role": "SUPER_ADMIN" };
    for (const [method, path, body] of superOnly()) {
      assert.equal((await api(path, { method, body, cookie: itAdmin, headers: spoof })).status, 403, `${method} ${path}`);
    }
    assert.equal((await api("/auth/me", { cookie: itAdmin, headers: spoof })).body.user.platformRole, "ADMIN");
  });

  test("an IT Admin cannot change a role through any other route (employee create / update)", async () => {
    const roleOf = async (userId: string) => {
      const r = (await one("SELECT role, admin_title FROM users WHERE id = ?", [userId]))!;
      return [r.role, r.admin_title];
    };
    assert.equal((await api(`/roles/users/${plain.userId}`, { method: "PATCH", cookie: itAdmin, body: { platformRole: "ADMIN", reason: "Joined the IT team" } })).status, 403);
    for (const extra of [{ role: "ADMIN" }, { platformRole: "SUPER_ADMIN" }, { adminTitle: "SUPER_ADMIN" }, { admin_title: "SUPER_ADMIN" }]) {
      const r = await api(`/employees/${plain.id}`, { method: "PATCH", cookie: itAdmin, body: { fullName: "QA Renamed", ...extra } });
      assert.ok(r.status === 400 || r.status === 200, `${JSON.stringify(extra)}: ${r.status}`);
      assert.deepEqual(await roleOf(plain.userId), ["EMPLOYEE", null], JSON.stringify(extra));
    }
    const created = await api("/employees", { method: "POST", cookie: itAdmin, body: { email: "qa-sneaky@example.com", employeeCode: "QA-SNEAKY", fullName: "Sneaky", timezone: "UTC", role: "ADMIN", platformRole: "SUPER_ADMIN" } });
    if (created.status === 201) assert.deepEqual(await roleOf(created.body.employee.userId), ["EMPLOYEE", null]);
    else assert.equal(created.status, 400);
    assert.equal(await count("SELECT count(*) AS n FROM users WHERE admin_title = 'SUPER_ADMIN'"), 1, "still exactly the one Super Admin");
  });

  test("a real screenshot and timelapse survive an IT Admin's and a team head's delete; the Super Admin's delete stores the reason", async () => {
    const sessionId = randomUUID();
    await closedSession(member, sessionId, iso(Date.now() - 120 * M), iso(Date.now() - 60 * M));
    const shot = randomUUID();
    await db.execute({
      sql: `INSERT INTO screenshots (id, employee_id, device_id, attendance_session_id, idempotency_key, captured_at, device_captured_at, width, height, mime_type,
              file_size_bytes, checksum, storage_provider, storage_key, upload_status, mask_count, blurred)
            VALUES (?, ?, ?, ?, ?, ?, ?, 10, 10, 'image/webp', 100, ?, 'LOCAL_DEV', ?, 'REGISTERED', 0, 0)`,
      args: [shot, member.id, member.deviceId, sessionId, randomUUID(), iso(Date.now() - 90 * M), iso(Date.now() - 90 * M), "0".repeat(64), `screenshots/unassigned/${member.id}/${shot}.webp`],
    });
    for (const cookie of [itAdmin, head.cookie, member.cookie]) {
      assert.equal((await api(`/screenshots/${shot}`, { method: "DELETE", cookie, body: reason })).status, 403);
    }
    assert.equal((await one("SELECT upload_status FROM screenshots WHERE id = ?", [shot]))!.upload_status, "REGISTERED");
    const done = await api(`/screenshots/${shot}`, { method: "DELETE", cookie: superAdmin, body: reason });
    assert.equal(done.status, 200, done.text);
    const row = (await one("SELECT upload_status, deleted_by, deleted_reason FROM screenshots WHERE id = ?", [shot]))!;
    assert.deepEqual([row.upload_status, row.deleted_by, row.deleted_reason], ["DELETED", superId, reason.reason]);
  });

  // DEFECT 1: screenshots:delete can be bypassed. settings:manage (IT Admin) may lower retentionDays and set
  // retentionApproved; the scheduled purge (screenshots.service.ts scheduledRetention) then deletes for them, with deleted_by NULL.
  test("an IT Admin cannot make the scheduled purge delete screenshots by changing retention settings", async () => {
    const current = (await api("/settings/screenshots", { cookie: superAdmin })).body.effective;
    const body = {
      enabled: current.enabled, intervalSeconds: current.intervalSeconds, webpQuality: current.webpQuality, maxDimension: current.maxDimension,
      captureScope: current.captureScope, maskRegions: current.maskRegions, blur: current.blur, noticeVersion: DEFAULT_SCREENSHOT_NOTICE_VERSION,
      employeeSelfView: current.employeeSelfView, autoTimelapse: current.autoTimelapse, retentionDays: 7, retentionApproved: true, reason: "shorter retention",
    };
    const r = await api("/settings/screenshots", { method: "PUT", cookie: itAdmin, body });
    assert.equal(r.status, 403, `IT Admin changed retention to 7 days, approved: ${r.status} ${r.text.slice(0, 160)}`);
  });

  // DEFECT 2: the third purge route was left on websites:manage.
  test("POST /websites/retention/run is Super Admin-only like the other two purges", async () => {
    assert.equal((await api("/websites/retention/run", { method: "POST", cookie: itAdmin, body: { confirm: true } })).status, 403);
  });
});

// ---- 2. Unauthenticated sweep -------------------------------------------------------------------

describe("unauthenticated requests", () => {
  const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "ALL", "OPTIONS", "HEAD", "SEARCH"];
  const joinPath = (...parts: string[]) => "/" + parts.flatMap((p) => p.split("/")).filter(Boolean).join("/");
  function routes() {
    const out: { method: string; path: string; isPublic: boolean }[] = [];
    for (const ctrl of Reflect.getMetadata("controllers", AppModule) as (new (...a: never[]) => unknown)[]) {
      const prefix = [Reflect.getMetadata("path", ctrl) ?? ""].flat()[0] as string;
      const classPublic = Reflect.getMetadata("auth:public", ctrl) === true;
      const proto = ctrl.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === "constructor" || typeof handler !== "function") continue;
        const method = Reflect.getMetadata("method", handler);
        if (method === undefined) continue;
        for (const path of [Reflect.getMetadata("path", handler) ?? ""].flat() as string[]) {
          out.push({ method: METHODS[method]!, path: joinPath(prefix, path).replace(/:[A-Za-z]+/g, () => randomUUID()), isPublic: Reflect.getMetadata("auth:public", handler) === true || classPublic });
        }
      }
    }
    return out;
  }

  test("every non-public route answers 401 over HTTP without credentials, with a garbage bearer, and with a garbage cookie", async () => {
    const all = routes();
    const guarded = all.filter((r) => !r.isPublic);
    assert.ok(guarded.length > 120, `expected the whole API, found ${guarded.length} guarded routes`);
    assert.equal(all.length - guarded.length, 12, "the public allow-list (route-permissions.test.ts) is 12 routes");
    const failures: string[] = [];
    for (const r of guarded) {
      const body = r.method === "GET" ? undefined : {};
      for (const [label, creds] of [["none", {}], ["bearer", { bearer: "not.a.token" }], ["cookie", { cookie: "wf_access=not.a.token" }]] as const) {
        const res = await api(r.path, { method: r.method, body, ...creds });
        if (res.status !== 401) failures.push(`${r.method} ${r.path} [${label}] -> ${res.status}`);
      }
    }
    assert.deepEqual(failures, []);
  });

  test("a cookie-less state-changing request from a foreign origin is refused before authentication (403), never served", async () => {
    const res = await fetch(`${base}/api/v1/employees`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 403);
  });
});

// ---- 3. Tokens ------------------------------------------------------------------------------------

describe("access tokens and session expiry", () => {
  const key = new TextEncoder().encode(SECRET);
  const sign = (claims: Record<string, unknown>, opts: { sub?: string; secret?: Uint8Array; iss?: string; aud?: string; exp?: number | string } = {}) => {
    let jwt = new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuer(opts.iss ?? "insight-workfolio").setAudience(opts.aud ?? "insight-workfolio-api").setIssuedAt().setExpirationTime(opts.exp ?? "5m");
    if (opts.sub) jwt = jwt.setSubject(opts.sub);
    return jwt.sign(opts.secret ?? key);
  };
  const me = async (bearer: string) => (await api("/auth/me", { bearer })).status;

  test("forged, expired and re-targeted tokens are 401; only a correctly signed live one is served", async () => {
    const [a, b] = [await employee(), await employee()];
    const real = decodeJwt(a.bearer);
    const other = decodeJwt(b.bearer);
    assert.equal(typeof real.sid, "string");
    assert.equal(await me(a.bearer), 200, "control: the issued token works");
    assert.equal(await me(await sign({ sid: real.sid }, { sub: real.sub })), 200, "control: the test signs like the server");

    assert.equal(await me(await sign({ sid: real.sid }, { sub: real.sub, secret: new TextEncoder().encode("another-secret-another-secret-0000") })), 401, "wrong key");
    assert.equal(await me(await sign({ sid: real.sid }, { sub: real.sub, exp: Math.floor(Date.now() / 1000) - 60 })), 401, "expired");
    assert.equal(await me(await sign({ sid: real.sid }, { sub: real.sub, aud: "someone-else" })), 401, "wrong audience");
    assert.equal(await me(await sign({ sid: real.sid }, { sub: real.sub, iss: "someone-else" })), 401, "wrong issuer");
    assert.equal(await me(await sign({}, { sub: real.sub })), 401, "no session id");
    assert.equal(await me(await sign({ sid: real.sid })), 401, "no subject");
    assert.equal(await me(await sign({ sid: other.sid }, { sub: real.sub })), 401, "another user's session id");
    assert.equal(await me(await sign({ sid: real.sid }, { sub: superId })), 401, "an employee's session with an admin's user id");
    assert.equal(await me(await sign({ sid: real.sid, role: "ADMIN", platformRole: "SUPER_ADMIN" }, { sub: real.sub })), 200, "extra claims are ignored…");
    assert.equal((await api("/roles/users", { bearer: await sign({ sid: real.sid, role: "ADMIN", platformRole: "SUPER_ADMIN" }, { sub: real.sub }) })).status, 403, "…and grant nothing: the role comes from the database");

    const unsigned = new UnsecuredJWT({ sid: real.sid }).setSubject(real.sub!).setIssuer("insight-workfolio").setAudience("insight-workfolio-api").setExpirationTime("5m").encode();
    assert.equal(await me(unsigned), 401, "alg none");
    const [h, p, s] = a.bearer.split(".") as [string, string, string];
    const tamperedPayload = Buffer.from(JSON.stringify({ ...real, sub: superId })).toString("base64url");
    assert.equal(await me(`${h}.${tamperedPayload}.${s}`), 401, "payload changed, signature kept");
    assert.equal(await me(`${h}.${p}.${s.slice(0, -2)}AA`), 401, "signature changed");
    assert.equal(await me(`${h}.${p}.`), 401, "signature removed");
  });

  test("an expired session: the still-valid access token and the refresh token both stop working", async () => {
    const e = await employee();
    const { sid } = decodeJwt(e.bearer);
    assert.equal(await me(e.bearer), 200);
    await db.execute({ sql: "UPDATE sessions SET expires_at = ? WHERE id = ?", args: [iso(Date.now() - 1000), sid] });
    assert.equal(await me(e.bearer), 401, "access token of an expired session");
    assert.equal((await api("/auth/refresh", { method: "POST", body: { refreshToken: e.refreshToken } })).status, 401, "refresh of an expired session");
    assert.equal((await api("/activity/sync", { method: "POST", bearer: e.bearer, device: e.device, body: syncBody({ state: "ACTIVE", since: iso(Date.now()) }) })).status, 401);
  });

  test("a revoked session and a disabled account are refused at once (no waiting for the token to expire)", async () => {
    const [a, b] = [await employee(), await employee()];
    await db.execute({ sql: "UPDATE sessions SET revoked_at = ? WHERE id = ?", args: [iso(Date.now()), decodeJwt(a.bearer).sid] });
    assert.equal(await me(a.bearer), 401);
    assert.equal((await api(`/employees/${b.id}/status`, { method: "PATCH", cookie: itAdmin, body: { status: "DISABLED" } })).status, 200);
    assert.equal(await me(b.bearer), 401);
    assert.equal((await api("/auth/refresh", { method: "POST", body: { refreshToken: b.refreshToken } })).status, 401);
  });
});

// ---- 4. Local storage keys ------------------------------------------------------------------------

describe("local storage adapter: keys cannot leave the storage root", () => {
  test("traversal, absolute and sibling-prefix keys are refused by every operation; nothing is written outside", async () => {
    const root = mkdtempSync(join(tmpdir(), "wf-qa2-root-"));
    const storage = new LocalDevStorage(root);
    const data = new Uint8Array([1, 2, 3]);
    const outsideBefore = readdirSync(dirname(root)).filter((n) => n.startsWith(basename(root))).sort();
    const hostile = ["../escape.webp", "../../escape.webp", "screenshots/../../escape.webp", "/etc/wf-qa2-escape", `../${basename(root)}-evil/x.webp`, "", ".", "screenshots/../.."];
    try {
      for (const key of hostile) {
        for (const [op, run] of [["put", () => storage.put(key, data)], ["get", () => storage.get(key)], ["stat", () => storage.stat(key)], ["delete", () => storage.delete(key)]] as const) {
          await assert.rejects(async () => run(), /Invalid storage key/, `${op}(${JSON.stringify(key)})`);
        }
      }
      assert.ok(!existsSync(join(dirname(root), "escape.webp")) && !existsSync("/etc/wf-qa2-escape") && !existsSync(`${root}-evil`));
      assert.deepEqual(readdirSync(dirname(root)).filter((n) => n.startsWith(basename(root))).sort(), outsideBefore);
      // Control: an ordinary key works and stays inside the root.
      await storage.put("screenshots/unassigned/a/b.webp", data);
      assert.ok(existsSync(join(root, "screenshots/unassigned/a/b.webp")));
      assert.deepEqual([...(await storage.get("screenshots/unassigned/a/b.webp"))], [1, 2, 3]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(`${root}-evil`, { recursive: true, force: true });
    }
  });

  test("the API never takes a storage key from a client: register and content requests with key-like fields are refused", async () => {
    const e = await employee();
    const r = await api("/screenshots/register", { method: "POST", bearer: e.bearer, device: e.device, body: { id: randomUUID(), capturedAt: iso(Date.now()), sentAt: iso(Date.now()), width: 10, height: 10, sizeBytes: 10, checksum: "0".repeat(64), mimeType: "image/webp", storageKey: "../../etc/passwd" } });
    assert.equal(r.status, 400, r.text);
    for (const id of ["..%2F..%2Fetc%2Fpasswd", "%2e%2e", "not-a-uuid"]) {
      assert.ok([400, 404].includes((await api(`/screenshots/${id}/content`, { cookie: superAdmin })).status), id);
    }
  });
});

// ---- 5. Audited reads --------------------------------------------------------------------------------

describe("audit rows for reads of another employee", () => {
  let e: Emp, other: Emp;
  const day = iso(Date.now()).slice(0, 10);
  before(async () => {
    [e, other] = [await employee(), await employee()];
  });
  const reads = () => [`/screenshots?employeeId=${e.id}&from=${day}&to=${day}`, `/screenshots/gallery?employeeId=${e.id}&from=${day}&to=${day}`, `/activity/timeline?employeeId=${e.id}&from=${day}&to=${day}`, `/attendance/timeline?employeeId=${e.id}&date=${day}`];

  test("a served read writes exactly one row naming actor and target; refused, invalid and own reads write none", async () => {
    const start = await auditCount(e.userId);
    for (const path of reads()) {
      assert.ok([403, 404].includes((await api(path, { cookie: other.cookie })).status), `another employee: ${path}`);
      assert.equal((await api(path)).status, 401, `signed out: ${path}`);
      assert.equal((await api(`${path}&page=0`, { cookie: itAdmin })).status, 400, `invalid: ${path}`);
    }
    assert.equal((await api(`/screenshots?from=${day}&to=${day}`, { cookie: e.cookie })).status, 200);
    assert.equal((await api(`/activity/timeline?from=${day}&to=${day}`, { cookie: e.cookie })).status, 200);
    assert.equal((await api(`/attendance/timeline?date=${day}`, { cookie: e.cookie })).status, 200);
    assert.equal(await auditCount(e.userId), start, "nothing so far");

    let n = start;
    for (const cookie of [itAdmin, superAdmin]) {
      for (const path of reads()) {
        assert.equal((await api(path, { cookie })).status, 200, path);
        assert.equal(await auditCount(e.userId), ++n, `one row for ${path}`);
      }
    }
    const rows = (await db.execute({ sql: "SELECT actor_user_id, target_user_id, action FROM account_audit WHERE target_user_id = ? AND action LIKE 'EMPLOYEE_%' ORDER BY rowid", args: [e.userId] })).rows;
    assert.ok(rows.every((r) => r.actor_user_id !== e.userId && r.target_user_id === e.userId));
    assert.deepEqual([...new Set(rows.map((r) => r.action))].sort(), ["EMPLOYEE_ACTIVITY_TIMELINE_VIEWED", "EMPLOYEE_ATTENDANCE_TIMELINE_VIEWED", "EMPLOYEE_SCREENSHOTS_VIEWED"]);
  });

  test("the read-audit rows are append-only", async () => {
    await assert.rejects(db.execute({ sql: "UPDATE account_audit SET actor_user_id = ? WHERE target_user_id = ?", args: [e.userId, e.userId] }));
    await assert.rejects(db.execute({ sql: "DELETE FROM account_audit WHERE target_user_id = ?", args: [e.userId] }));
  });

  // DEFECT 5 (residual gap): the same data is readable, unaudited, through sibling routes.
  test("the other per-employee reads by an admin are audited too", async () => {
    const unaudited: string[] = [];
    for (const path of [`/activity/summary?employeeId=${e.id}&from=${day}&to=${day}`, `/attendance/history?employeeId=${e.id}`, `/attendance/timesheet?employeeId=${e.id}&from=${day}&to=${day}`, `/attendance/export?employeeId=${e.id}&from=${day}&to=${day}`]) {
      const n = await count("SELECT count(*) AS n FROM account_audit WHERE target_user_id = ?", [e.userId]);
      const r = await api(path, { cookie: itAdmin });
      assert.equal(r.status, 200, `${path}: ${r.text.slice(0, 120)}`);
      if ((await count("SELECT count(*) AS n FROM account_audit WHERE target_user_id = ?", [e.userId])) === n) unaudited.push(path.split("?")[0]!);
    }
    assert.deepEqual(unaudited, []);
  });
});

// ---- 6. Employees and screenshot settings / uploads -------------------------------------------------

describe("employees (and team heads) cannot change screenshot settings or touch another device's upload", () => {
  let a: Emp, b: Emp, head: Emp;
  before(async () => {
    [a, b, head] = [await employee(), await employee(), await employee()];
    await team(head, [a]);
  });

  test("settings, blur overrides, per-person tracking overrides and monitoring settings: 403 for an employee and a team head, nothing written", async () => {
    const before = await Promise.all(["screenshot_policies", "screenshot_blur_overrides", "employee_tracking_overrides", "monitoring_policies"].map((t) => count(`SELECT count(*) AS n FROM ${t}`)));
    const attempts: [string, string, unknown][] = [
      ["GET", "/settings/screenshots", undefined],
      ["PUT", "/settings/screenshots", { enabled: false, intervalSeconds: 300, webpQuality: 70, maxDimension: 1920, captureScope: "PRIMARY_DISPLAY", retentionDays: 30, retentionApproved: false, noticeVersion: DEFAULT_SCREENSHOT_NOTICE_VERSION, employeeSelfView: true, reason: "mine" }],
      ["GET", `/settings/screenshots/blur-overrides?employeeId=${a.id}`, undefined],
      ["PUT", `/settings/screenshots/blur-overrides/${a.id}`, { blur: true, reason: "hide my screen" }],
      ["GET", `/settings/employees/${a.id}/tracking`, undefined],
      ["PUT", `/settings/employees/${a.id}/tracking`, { expectedStart: null, workdays: null, idleThresholdSeconds: null, screenshotSelfView: true, reason: "let me see" }],
      ["GET", "/settings/monitoring", undefined],
      ["GET", "/screenshots/retention", undefined],
    ];
    for (const [method, path, body] of attempts) {
      for (const [who, creds] of [["employee (web)", { cookie: a.cookie }], ["employee (desktop)", { bearer: a.bearer }], ["team head", { cookie: head.cookie }]] as const) {
        const r = await api(path, { method, body, ...creds });
        assert.equal(r.status, 403, `${who} ${method} ${path}: ${r.status}`);
      }
    }
    const after = await Promise.all(["screenshot_policies", "screenshot_blur_overrides", "employee_tracking_overrides", "monitoring_policies"].map((t) => count(`SELECT count(*) AS n FROM ${t}`)));
    assert.deepEqual(after, before);
  });

  test("an upload onto another employee's registration is 404 and stores nothing; a browser session cannot register or upload at all", async () => {
    const sessionId = randomUUID();
    await db.execute({ sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, status) VALUES (?, ?, ?, ?, 'OPEN')", args: [sessionId, a.id, a.deviceId, iso(Date.now() - 30 * M)] });
    const [rowId, clientId] = [randomUUID(), randomUUID()];
    const key = `screenshots/unassigned/${a.id}/${rowId}.webp`;
    await db.execute({
      sql: `INSERT INTO screenshots (id, employee_id, device_id, attendance_session_id, idempotency_key, captured_at, device_captured_at, width, height, mime_type,
              file_size_bytes, checksum, storage_provider, storage_key, upload_status, mask_count, blurred)
            VALUES (?, ?, ?, ?, ?, ?, ?, 10, 10, 'image/webp', 4, ?, 'LOCAL_DEV', ?, 'REGISTERED', 0, 0)`,
      args: [rowId, a.id, a.deviceId, sessionId, clientId, iso(Date.now() - 10 * M), iso(Date.now() - 10 * M), "0".repeat(64), key],
    });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    // B, from B's own desktop and device, using A's client id and then A's row id.
    for (const id of [clientId, rowId]) {
      assert.equal((await api(`/screenshots/${id}/content`, { method: "PUT", bearer: b.bearer, device: b.device, raw: bytes })).status, 404, "another employee's registration");
    }
    // B's token with A's installation id: the device is not B's.
    assert.equal((await api(`/screenshots/${clientId}/content`, { method: "PUT", bearer: b.bearer, device: a.device, raw: bytes })).status, 403);
    // A's browser session (cookie), even with A's real installation id.
    assert.equal((await api(`/screenshots/${clientId}/content`, { method: "PUT", cookie: a.cookie, device: a.device, raw: bytes })).status, 403);
    assert.equal((await api("/screenshots/register", { method: "POST", cookie: a.cookie, device: a.device, body: { id: randomUUID(), capturedAt: iso(Date.now()), sentAt: iso(Date.now()), width: 10, height: 10, sizeBytes: 10, checksum: "0".repeat(64), mimeType: "image/webp" } })).status, 403);
    const row = (await one("SELECT upload_status, stored_at FROM screenshots WHERE id = ?", [rowId]))!;
    assert.deepEqual([row.upload_status, row.stored_at], ["REGISTERED", null]);
    assert.ok(!existsSync(join(STORAGE_DIR, key)));
    // B cannot read A's row either (metadata or bytes); A's own team head and admins can see the metadata.
    assert.equal((await api(`/screenshots/${rowId}`, { cookie: b.cookie })).status, 404);
    assert.equal((await api(`/screenshots/${rowId}/content`, { cookie: b.cookie })).status, 404);
    assert.equal((await api(`/screenshots/${rowId}`, { cookie: head.cookie })).status, 200);
  });

  test("screenshot registration is rejected while the policy is off and before the screenshot notice is acknowledged", async () => {
    assert.equal((await act(b, "clock-in")).status, 200);
    const register = () => api("/screenshots/register", { method: "POST", bearer: b.bearer, device: b.device, body: { id: randomUUID(), capturedAt: iso(Date.now() - 1000), sentAt: iso(Date.now()), width: 10, height: 10, sizeBytes: 10, checksum: "0".repeat(64), mimeType: "image/webp" } });
    const off = await register();
    assert.deepEqual([off.status, off.body.status], [200, "REJECTED"], off.text);
    assert.match(off.body.reason, /turned off/);
    // Policy on (this in-memory database only); the ACTIVITY notice acknowledgement must not count as screenshot consent.
    await db.execute({
      sql: `INSERT INTO screenshot_policies (screenshots_enabled, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
              retention_approved, notice_version, reason, changed_by, effective_at) VALUES (1, 300, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, ?, 'qa', ?, ?)`,
      args: [DEFAULT_SCREENSHOT_NOTICE_VERSION, superId, iso(Date.now() - 20 * M)],
    });
    const noConsent = await register();
    assert.deepEqual([noConsent.status, noConsent.body.status], [200, "REJECTED"], noConsent.text);
    assert.match(noConsent.body.reason, /notice/);
    assert.equal(await count("SELECT count(*) AS n FROM screenshots WHERE employee_id = ?", [b.id]), 0);
    await db.execute({ sql: "INSERT INTO screenshot_policies (screenshots_enabled, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days, retention_approved, notice_version, reason, changed_by) VALUES (0, 300, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, ?, 'qa off', ?)", args: [DEFAULT_SCREENSHOT_NOTICE_VERSION, superId] });
    assert.equal((await act(b, "clock-out")).status, 200);
  });
});

// ---- 7. Live status abuse ---------------------------------------------------------------------------

describe("live status cannot be forged beyond the caller's own, clocked-in, consented device", () => {
  test("a browser session cannot post a report; unknown fields (an employee or device id) are refused", async () => {
    const e = await employee();
    assert.equal((await act(e, "clock-in")).status, 200);
    const body = syncBody({ state: "ACTIVE", since: iso(Date.now()) });
    assert.equal((await api("/activity/sync", { method: "POST", cookie: e.cookie, device: e.device, body })).status, 403, "cookie session with the real installation id");
    assert.equal((await deviceRow(e))!.activity_state, null);
    for (const extra of [{ employeeId: randomUUID() }, { deviceId: randomUUID() }, { reportedAt: iso(Date.now() + 10 * M) }]) {
      assert.equal((await report(e, { state: "ACTIVE", since: iso(Date.now()), ...extra })).status, 400, JSON.stringify(extra));
      assert.equal((await api("/activity/sync", { method: "POST", bearer: e.bearer, device: e.device, body: { ...body, ...extra } })).status, 400, JSON.stringify(extra));
    }
    assert.equal((await deviceRow(e))!.activity_state, null);
  });

  test("one employee's report never touches another employee; another employee's installation id is refused", async () => {
    const [a, b] = [await employee(), await employee()];
    assert.equal((await act(a, "clock-in")).status, 200);
    assert.equal((await act(b, "clock-in")).status, 200);
    assert.equal((await api("/activity/sync", { method: "POST", bearer: a.bearer, device: b.device, body: syncBody({ state: "ACTIVE", since: iso(Date.now()) }) })).status, 403);
    assert.equal((await report(a, { state: "ACTIVE", since: iso(Date.now()) })).status, 200);
    assert.equal((await deviceRow(a))!.activity_state, "ACTIVE");
    assert.equal((await deviceRow(b))!.activity_state, null);
    assert.equal((await overviewRow(b)).liveStatus, "UNKNOWN");
  });

  test("never ACTIVE when not clocked in, on a break, after clock-out, or after the device is revoked", async () => {
    const e = await employee();
    const claim = () => report(e, { state: "ACTIVE", since: iso(Date.now() - M) });
    assert.equal((await claim()).status, 200);
    assert.equal((await overviewRow(e)).liveStatus, "NOT_CLOCKED_IN");

    assert.equal((await act(e, "clock-in")).status, 200);
    assert.equal((await claim()).status, 200);
    assert.equal((await overviewRow(e)).liveStatus, "ACTIVE", "control");
    assert.equal((await act(e, "break/start")).status, 200);
    assert.equal((await claim()).status, 200);
    assert.equal((await overviewRow(e)).liveStatus, "ON_BREAK");
    assert.equal((await api("/activity/me", { bearer: e.bearer })).body.liveStatus, "ON_BREAK");
    assert.equal((await act(e, "break/end")).status, 200);
    // The report sent during the break predates the working stretch: not believed afterwards.
    assert.equal((await overviewRow(e)).liveStatus, "UNKNOWN", "a report from before the break ended is not carried over");

    assert.equal((await claim()).status, 200);
    assert.equal((await act(e, "clock-out")).status, 200);
    assert.equal((await deviceRow(e))!.activity_state, null, "cleared at clock-out");
    assert.equal((await claim()).status, 200);
    assert.equal((await deviceRow(e))!.activity_state, null, "and not accepted again while clocked out");
    assert.equal((await overviewRow(e)).liveStatus, "NOT_CLOCKED_IN");

    assert.equal((await act(e, "clock-in")).status, 200);
    assert.equal((await claim()).status, 200);
    assert.equal((await overviewRow(e)).liveStatus, "ACTIVE", "control");
    assert.equal((await api(`/devices/${e.deviceId}/revoke`, { method: "POST", cookie: itAdmin })).status, 200);
    assert.notEqual((await overviewRow(e)).liveStatus, "ACTIVE", "a revoked device's last report is not shown");
    assert.ok([401, 403].includes((await claim()).status), "and it cannot report again");
  });

  test("`since` is bounded: never before the working stretch, never in the future", async () => {
    const e = await employee();
    assert.equal((await act(e, "clock-in")).status, 200);
    const clockIn = Date.parse((await overviewRow(e)).session.clockInAt);
    assert.equal((await report(e, { state: "ACTIVE", since: "2001-01-01T00:00:00.000Z" })).status, 200);
    let row = await overviewRow(e);
    assert.equal(row.liveStatus, "ACTIVE");
    assert.ok(Date.parse(row.liveSince) >= clockIn, `active since ${row.liveSince}, clocked in ${iso(clockIn)}`);
    assert.equal((await report(e, { state: "IDLE", since: iso(Date.now() + 60 * M) })).status, 200);
    row = await overviewRow(e);
    assert.ok(Date.parse(row.liveSince) <= Date.now() + 1000, row.liveSince);
  });

  test("monitoring switched off, or a newer notice not yet acknowledged: the report is not stored and a stale one expires", async () => {
    const e = await employee();
    assert.equal((await act(e, "clock-in")).status, 200);
    assert.equal((await report(e, { state: "ACTIVE", since: iso(Date.now()) })).status, 200);
    assert.equal((await deviceRow(e))!.activity_state, "ACTIVE");
    const before = (await deviceRow(e))!.activity_state_at;
    const current = (await api("/settings/monitoring", { cookie: itAdmin })).body.effective;
    const off = await api("/settings/monitoring", { method: "PUT", cookie: itAdmin, body: { enabled: false, sampleSeconds: current.sampleSeconds, idleThresholdSeconds: current.idleThresholdSeconds, retentionDays: current.retentionDays, retentionApproved: current.retentionApproved, noticeVersion: current.noticeVersion, reason: "qa: off" } });
    assert.equal(off.status, 200, off.text);
    try {
      assert.equal((await report(e, { state: "IDLE", since: iso(Date.now()) })).status, 200);
      const row = (await deviceRow(e))!;
      assert.deepEqual([row.activity_state, row.activity_state_at], ["ACTIVE", before], "not updated while monitoring is off");
      // The value left behind is only believed for LIVE_STATUS_STALE_MS.
      await db.execute({ sql: "UPDATE devices SET activity_state_at = ? WHERE id = ?", args: [iso(Date.now() - 4 * M), e.deviceId] });
      assert.equal((await overviewRow(e)).liveStatus, "UNKNOWN");
    } finally {
      const on = await api("/settings/monitoring", { method: "PUT", cookie: itAdmin, body: { enabled: current.enabled, sampleSeconds: current.sampleSeconds, idleThresholdSeconds: current.idleThresholdSeconds, retentionDays: current.retentionDays, retentionApproved: current.retentionApproved, noticeVersion: current.noticeVersion, reason: "qa: restore" } });
      assert.equal(on.status, 200, on.text);
    }
  });

  // DEFECT 3: with monitoring switched off the last ACTIVE report is still displayed until it goes stale.
  test("switching monitoring off stops showing ACTIVE/IDLE at once", async () => {
    const e = await employee();
    assert.equal((await act(e, "clock-in")).status, 200);
    assert.equal((await report(e, { state: "ACTIVE", since: iso(Date.now()) })).status, 200);
    const current = (await api("/settings/monitoring", { cookie: itAdmin })).body.effective;
    const put = (enabled: boolean) => api("/settings/monitoring", { method: "PUT", cookie: itAdmin, body: { enabled, sampleSeconds: current.sampleSeconds, idleThresholdSeconds: current.idleThresholdSeconds, retentionDays: current.retentionDays, retentionApproved: current.retentionApproved, noticeVersion: current.noticeVersion, reason: "qa" } });
    assert.equal((await put(false)).status, 200);
    try {
      assert.equal((await overviewRow(e)).liveStatus, "UNKNOWN");
    } finally {
      await put(current.enabled);
    }
  });
});

// ---- 8. Attendance timeline edges ------------------------------------------------------------------

describe("GET /attendance/timeline: day bounds across DST, ties, pagination", () => {
  const ids = (items: { id: string }[]) => items.map((i) => i.id);

  test("America/New_York: a 23-hour and a 25-hour local day include exactly the records inside them", async () => {
    const e = await employee({ timezone: "America/New_York" });
    const pair = (id: string, at: string) => closedSession(e, id, at, iso(Date.parse(at) + 500));
    // Spring forward 2026-03-08: the local day is 05:00Z -> 04:00Z next day (23 h).
    await pair("ny-mar7-last", "2026-03-08T04:59:59.000Z");
    await pair("ny-mar8-first", "2026-03-08T05:00:00.000Z");
    await pair("ny-mar8-last", "2026-03-09T03:59:59.000Z");
    await pair("ny-mar9-first", "2026-03-09T04:00:00.000Z");
    // Fall back 2026-11-01: the local day is 04:00Z -> 05:00Z next day (25 h).
    await pair("ny-oct31-last", "2026-11-01T03:59:59.000Z");
    await pair("ny-nov1-first", "2026-11-01T04:00:00.000Z");
    await pair("ny-nov1-last", "2026-11-02T04:59:59.000Z");
    await pair("ny-nov2-first", "2026-11-02T05:00:00.000Z");
    const day = async (date: string) => {
      const r = await api(`/attendance/timeline?date=${date}`, { bearer: e.bearer });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.timezone, "America/New_York");
      return ids(r.body.items).filter((i) => i.startsWith("CLOCK_IN:")).map((i) => i.slice(9));
    };
    assert.deepEqual(await day("2026-03-07"), ["ny-mar7-last"]);
    assert.deepEqual(await day("2026-03-08"), ["ny-mar8-first", "ny-mar8-last"]);
    assert.deepEqual(await day("2026-03-09"), ["ny-mar9-first"]);
    assert.deepEqual(await day("2026-10-31"), ["ny-oct31-last"]);
    assert.deepEqual(await day("2026-11-01"), ["ny-nov1-first", "ny-nov1-last"]);
    assert.deepEqual(await day("2026-11-02"), ["ny-nov2-first"]);
  });

  test("pagination: pages of one reassemble the whole day in order, no repeats, no gaps; past the end is empty", async () => {
    const e = await employee();
    const t0 = Date.parse("2026-06-10T08:00:00.000Z");
    for (let k = 0; k < 6; k++) await closedSession(e, `pg-${k}`, iso(t0 + k * 10 * M), iso(t0 + k * 10 * M + 5 * M));
    const whole = await api("/attendance/timeline?date=2026-06-10&pageSize=200", { bearer: e.bearer });
    assert.equal(whole.body.total, 12);
    assert.deepEqual(whole.body.items.map((i: { at: string }) => i.at), [...whole.body.items.map((i: { at: string }) => i.at)].sort(), "chronological");
    const paged: string[] = [];
    for (let page = 1; page <= 12; page++) {
      const r = await api(`/attendance/timeline?date=2026-06-10&pageSize=1&page=${page}`, { bearer: e.bearer });
      assert.deepEqual([r.status, r.body.total, r.body.items.length], [200, 12, 1]);
      paged.push(r.body.items[0].id);
    }
    assert.deepEqual(paged, ids(whole.body.items));
    assert.equal(new Set(paged).size, 12);
    assert.deepEqual((await api("/attendance/timeline?date=2026-06-10&pageSize=5&page=4", { bearer: e.bearer })).body.items, []);
    for (const bad of ["page=0", "pageSize=0", "pageSize=201", "date=2026-13-01", "date=10-06-2026", "bogus=1"]) {
      assert.equal((await api(`/attendance/timeline?${bad}`, { bearer: e.bearer })).status, 400, bad);
    }
  });

  test("records sharing an instant come back in the same order on every request and page size", async () => {
    const e = await employee();
    const t = "2026-06-11T09:00:00.000Z";
    await closedSession(e, "tie-a", "2026-06-11T08:00:00.000Z", t);
    await db.execute({ sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, status) VALUES ('tie-b', ?, ?, ?, 'OPEN')", args: [e.id, e.deviceId, "2026-06-11T09:00:00.001Z"] });
    await db.execute({ sql: "INSERT INTO break_sessions (id, attendance_session_id, started_at, ended_at, status) VALUES ('tie-br', 'tie-b', '2026-06-11T09:00:00.001Z', '2026-06-11T09:10:00.000Z', 'CLOSED')", args: [] });
    await db.execute({ sql: "UPDATE attendance_sessions SET clock_out_at = '2026-06-11T09:10:00.000Z', status = 'CLOSED' WHERE id = 'tie-b'", args: [] });
    const first = ids((await api("/attendance/timeline?date=2026-06-11", { bearer: e.bearer })).body.items);
    assert.deepEqual(first, ["CLOCK_IN:tie-a", "CLOCK_OUT:tie-a", "CLOCK_IN:tie-b", "BREAK:tie-br", "CLOCK_OUT:tie-b"], "clock-in before the break that starts with it; clock-out after the break that ends with it");
    for (let k = 0; k < 3; k++) assert.deepEqual(ids((await api("/attendance/timeline?date=2026-06-11", { bearer: e.bearer })).body.items), first);
    const byTwo = [1, 2, 3].map((page) => api(`/attendance/timeline?date=2026-06-11&pageSize=2&page=${page}`, { bearer: e.bearer }));
    assert.deepEqual((await Promise.all(byTwo)).flatMap((r) => ids(r.body.items)), first);
  });

  // DEFECT 4: rank sorts every CLOCK_IN before every CLOCK_OUT at the same instant, so a shift that ends exactly
  // when the next begins is listed as "clock in, clock out" in the wrong order.
  test("a clock-out and the next clock-in at the same instant are listed in that order", async () => {
    const e = await employee();
    const t = "2026-06-12T09:00:00.000Z";
    await closedSession(e, "edge-a", "2026-06-12T08:00:00.000Z", t);
    await closedSession(e, "edge-b", t, "2026-06-12T10:00:00.000Z");
    const got = ids((await api("/attendance/timeline?date=2026-06-12", { bearer: e.bearer })).body.items);
    assert.deepEqual(got, ["CLOCK_IN:edge-a", "CLOCK_OUT:edge-a", "CLOCK_IN:edge-b", "CLOCK_OUT:edge-b"]);
  });

  test("access: both admin identities and the team head read it (audited); another employee and an out-of-team head get 404", async () => {
    const [e, head, stranger] = [await employee(), await employee(), await employee()];
    await team(head, [e]);
    const path = `/attendance/timeline?employeeId=${e.id}`;
    for (const cookie of [superAdmin, itAdmin, head.cookie, e.cookie]) assert.equal((await api(path, { cookie })).status, 200);
    assert.equal(await auditCount(e.userId), 3, "three other readers, own read not audited");
    for (const who of [stranger, head]) assert.equal((await api(`/attendance/timeline?employeeId=${who === head ? stranger.id : e.id}`, { cookie: who.cookie })).status, 404);
    assert.equal(await auditCount(e.userId), 3);
    assert.equal(await auditCount(stranger.userId), 0);
  });
});
