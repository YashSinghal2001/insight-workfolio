// Security hardening (in-process API, in-memory DB; example.com test accounts only): Super Admin accounts
// are managed by Super Admins only, a disabled account's browser extension stops at once, website
// retention needs explicit confirmation, LIKE wildcards in the domain filter, the login limiter order and
// key cap, the error envelope's `error` name, the screenshot-only raw body parser, and device revocation
// racing a request.
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL = ":memory:";
process.env.JWT_SECRET = "test-secret-test-secret-test-secret!";

const { AppModule } = await import("../dist/app.module.js");
const { configureApp } = await import("../dist/app.setup.js");
const { DATABASE } = await import("../dist/database/database.module.js");
const { hashPassword, RateLimiter, sha256 } = await import("../dist/auth/crypto.js");
const { AuthService } = await import("../dist/auth/auth.service.js");
const { WebsitesService } = await import("../dist/websites/websites.service.js");
const { DEFAULT_WEBSITE_NOTICE_VERSION, localDate } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "hardening password 1";
let app: INestApplication;
let base: string;
type Rows = { rows: Record<string, unknown>[] };
type Db = { execute: (q: string | { sql: string; args: unknown[] }) => Promise<Rows> };
let db: Db;
let auth: InstanceType<typeof AuthService>;

type Opts = { method?: string; body?: unknown; raw?: Uint8Array; contentType?: string; cookie?: string; bearer?: string; headers?: Record<string, string> };
async function api(path: string, { method = "GET", body, raw, contentType, cookie, bearer, headers = {} }: Opts = {}) {
  const h: Record<string, string> = { origin: ORIGIN, ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  if (contentType) h["content-type"] = contentType;
  if (cookie) h.cookie = cookie;
  if (bearer) h.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text, res };
}
const iso = (ms: number) => new Date(ms).toISOString();
const count = async (sql: string, args: unknown[] = []) => Number((await db.execute({ sql, args })).rows[0]!.n);

let n = 0;
/** A signed-in user created directly; employees and optionally admins get a profile. */
async function user(title: "SUPER_ADMIN" | "ADMIN" | "EMPLOYEE", withProfile = true) {
  const id = randomUUID();
  const email = `sh${++n}@example.com`;
  await db.execute({ sql: "INSERT INTO users (id, email, role, admin_title, password_hash) VALUES (?, ?, ?, ?, ?)", args: [id, email, title === "EMPLOYEE" ? "EMPLOYEE" : "ADMIN", title === "EMPLOYEE" ? null : title, await hashPassword(PASSWORD)] });
  const employeeId = randomUUID();
  if (withProfile) await db.execute({ sql: "INSERT INTO employee_profiles (id, user_id, employee_code, full_name, timezone) VALUES (?, ?, ?, ?, 'UTC')", args: [employeeId, id, `SH-${n}`, `Hardening ${n}`] });
  const r = await api("/auth/login", { method: "POST", body: { email, password: PASSWORD } });
  assert.equal(r.status, 200, r.text);
  return { id, email, employeeId, cookie: r.res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
}

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  auth = app.get(AuthService);
  auth.loginByIp.hit = () => true; // every request comes from 127.0.0.1; the limiter test sets its own
  auth.loginByEmail.hit = () => true;
});
after(() => app.close());

describe("Super Admin accounts are managed by Super Admins only", () => {
  const audits = (userId: string) => count("SELECT count(*) AS n FROM account_audit WHERE target_user_id = ?", [userId]);

  test("an Admin cannot revoke a Super Admin's device; a Super Admin can", async () => {
    const [s, s2, a] = [await user("SUPER_ADMIN"), await user("SUPER_ADMIN"), await user("ADMIN")];
    const deviceId = randomUUID();
    await db.execute({ sql: "INSERT INTO devices (id, employee_id, device_name, platform, device_identifier) VALUES (?, ?, 'Mac', 'macos', ?)", args: [deviceId, s.employeeId, sha256(randomUUID())] });
    const denied = await api(`/devices/${deviceId}/revoke`, { method: "POST", cookie: a.cookie });
    assert.equal(denied.status, 403, denied.text);
    assert.match(denied.body.message, /Only a Super Admin/);
    assert.equal(await count("SELECT count(*) AS n FROM devices WHERE id = ? AND revoked_at IS NULL", [deviceId]), 1, "still active");
    const ok = await api(`/devices/${deviceId}/revoke`, { method: "POST", cookie: s2.cookie });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(await count("SELECT count(*) AS n FROM devices WHERE id = ? AND revoked_at IS NOT NULL", [deviceId]), 1);
  });

  test("an Admin cannot reissue a setup link for, change the email of, or disable a Super Admin", async () => {
    const [, s, a] = [await user("SUPER_ADMIN"), await user("SUPER_ADMIN"), await user("ADMIN")]; // two supers: disabling one would otherwise be allowed
    const token = await api(`/employees/${s.employeeId}/setup-token`, { method: "POST", cookie: a.cookie });
    assert.equal(token.status, 403, token.text);
    assert.equal(token.body.message, "Only a Super Admin can manage a Super Admin account");
    assert.equal(token.body.token, undefined);
    assert.equal(await count("SELECT count(*) AS n FROM account_setup_tokens WHERE user_id = ?", [s.id]), 0, "no setup link stored");
    const email = await api(`/employees/${s.employeeId}`, { method: "PATCH", cookie: a.cookie, body: { email: "taken-over@example.com" } });
    assert.equal(email.status, 403, email.text);
    assert.equal((await api(`/employees/${s.employeeId}`, { method: "PATCH", cookie: a.cookie, body: { fullName: "Renamed" } })).status, 403);
    assert.equal((await api(`/employees/${s.employeeId}/status`, { method: "PATCH", cookie: a.cookie, body: { status: "DISABLED" } })).status, 403);
    const row = (await db.execute({ sql: "SELECT u.email, u.status, p.full_name FROM users u JOIN employee_profiles p ON p.user_id = u.id WHERE u.id = ?", args: [s.id] })).rows[0]!;
    assert.deepEqual([row.email, row.status, row.full_name], [s.email, "ACTIVE", `Hardening ${n - 1}`]);
    assert.equal(await audits(s.id), 0, "refused changes are not audited");
  });

  test("a Super Admin can manage another Super Admin; an Admin can manage another Admin and employees", async () => {
    const [s1, s2, a1, a2, e] = [await user("SUPER_ADMIN"), await user("SUPER_ADMIN"), await user("ADMIN"), await user("ADMIN"), await user("EMPLOYEE")];
    assert.equal((await api(`/employees/${s2.employeeId}/setup-token`, { method: "POST", cookie: s1.cookie })).status, 201);
    assert.equal((await api(`/employees/${s2.employeeId}`, { method: "PATCH", cookie: s1.cookie, body: { email: `moved${n}@example.com` } })).status, 200);
    assert.equal((await api(`/employees/${s2.employeeId}/status`, { method: "PATCH", cookie: s1.cookie, body: { status: "DISABLED" } })).status, 200);
    assert.equal((await api(`/employees/${s2.employeeId}/status`, { method: "PATCH", cookie: s1.cookie, body: { status: "ACTIVE" } })).status, 200);
    for (const target of [a2, e]) {
      assert.equal((await api(`/employees/${target.employeeId}/setup-token`, { method: "POST", cookie: a1.cookie })).status, 201);
      assert.equal((await api(`/employees/${target.employeeId}`, { method: "PATCH", cookie: a1.cookie, body: { fullName: "Renamed by admin" } })).status, 200);
      assert.equal((await api(`/employees/${target.employeeId}/status`, { method: "PATCH", cookie: a1.cookie, body: { status: "DISABLED" } })).status, 200);
    }
  });

  test("a promotion between an Admin's read and write is still caught by the guard inside the write", async () => {
    const [a, target] = [await user("ADMIN"), await user("ADMIN")];
    const real = db.execute.bind(db);
    db.execute = async (q) => {
      // Promote the target just after the pre-check read, before the batch.
      if (typeof q === "object" && q.sql.startsWith("SELECT NOT EXISTS")) {
        const r = await real(q);
        await real({ sql: "UPDATE users SET admin_title = 'SUPER_ADMIN' WHERE id = ?", args: [target.id] });
        return r;
      }
      return real(q);
    };
    try {
      assert.equal((await api(`/employees/${target.employeeId}`, { method: "PATCH", cookie: a.cookie, body: { email: `late${n}@example.com` } })).status, 403);
    } finally {
      db.execute = real;
    }
    assert.equal((await db.execute({ sql: "SELECT email FROM users WHERE id = ?", args: [target.id] })).rows[0]!.email, target.email);
    assert.equal(await audits(target.id), 0);
  });
});

/** A browser link connected directly in the DB (token known to the test). */
async function connectExtension(employeeId: string) {
  const token = randomBytes(32).toString("base64url");
  const id = randomUUID();
  await db.execute({
    sql: "INSERT INTO website_extension_links (id, employee_id, label, pairing_code_hash, pairing_expires_at, token_hash, claimed_at) VALUES (?, ?, 'Chrome', ?, ?, ?, ?)",
    args: [id, employeeId, sha256(randomUUID()), iso(Date.now() + 60_000), sha256(token), iso(Date.now())],
  });
  return { id, token };
}

describe("websites", () => {
  test("disabling an account revokes its browser-extension links; the extension gets 401", async () => {
    const [admin, e] = [await user("SUPER_ADMIN"), await user("EMPLOYEE")];
    const link = await connectExtension(e.employeeId);
    assert.equal((await api("/websites/extension/state", { bearer: link.token })).status, 200);
    assert.equal((await api(`/employees/${e.employeeId}/status`, { method: "PATCH", cookie: admin.cookie, body: { status: "DISABLED" } })).status, 200);
    assert.equal((await api("/websites/extension/state", { bearer: link.token })).status, 401);
    assert.equal((await api("/websites/extension/intervals", { method: "POST", bearer: link.token, body: { sentAt: iso(Date.now()), intervals: [{ id: randomUUID(), domain: "example.com", startedAt: iso(Date.now() - 60_000), endedAt: iso(Date.now()) }] } })).status, 401);
    const row = (await db.execute({ sql: "SELECT revoked_at, revoked_by FROM website_extension_links WHERE id = ?", args: [link.id] })).rows[0]!;
    assert.notEqual(row.revoked_at, null);
    assert.equal(row.revoked_by, admin.id);
  });

  test("a disabled account's extension is refused even if its link was not revoked", async () => {
    const e = await user("EMPLOYEE");
    const link = await connectExtension(e.employeeId);
    await db.execute({ sql: "UPDATE users SET status = 'DISABLED' WHERE id = ?", args: [e.id] });
    assert.equal((await api("/websites/extension/state", { bearer: link.token })).status, 401);
  });

  test("retention needs { confirm: true }", async () => {
    const admin = await user("SUPER_ADMIN"); // purge runs are Super Admin-only
    for (const body of [undefined, {}, { confirm: false }, { confirm: true, extra: 1 }]) {
      assert.equal((await api("/websites/retention/run", { method: "POST", cookie: admin.cookie, body })).status, 400, JSON.stringify(body));
    }
    assert.equal(await count("SELECT count(*) AS n FROM website_audit WHERE action = 'RETENTION_RUN'"), 0, "nothing ran");
    assert.equal((await api("/websites/retention/run", { method: "POST", cookie: admin.cookie, body: { confirm: true } })).status, 200);
  });

  test("the report's domain filter treats LIKE wildcards literally", async () => {
    const [admin, e] = [await user("ADMIN"), await user("EMPLOYEE")];
    const link = await connectExtension(e.employeeId);
    const device = randomUUID();
    const session = randomUUID();
    const now = Date.now();
    await db.execute({ sql: "INSERT INTO devices (id, employee_id, device_name, platform, device_identifier) VALUES (?, ?, 'Mac', 'macos', ?)", args: [device, e.employeeId, sha256(device)] });
    await db.execute({ sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, status) VALUES (?, ?, ?, ?, 'OPEN')", args: [session, e.employeeId, device, iso(now - 3_600_000)] });
    await db.execute({ sql: "INSERT INTO website_policies (enabled, retention_days, notice_version, reason, changed_by) VALUES (1, 30, ?, 'test policy', ?)", args: [DEFAULT_WEBSITE_NOTICE_VERSION, admin.id] });
    await db.execute({
      sql: "INSERT INTO website_intervals (id, employee_id, link_id, attendance_session_id, policy_seq, client_id, domain, started_at, ended_at, duration_ms, received_at) VALUES (?, ?, ?, ?, (SELECT max(seq) FROM website_policies), ?, 'docs.example.com', ?, ?, 60000, ?)",
      args: [randomUUID(), e.employeeId, link.id, session, randomUUID(), iso(now - 120_000), iso(now - 60_000), iso(now - 60_000)],
    });
    const websites = app.get(WebsitesService);
    const day = localDate(now, "UTC");
    assert.equal((await websites.report(day, day, e.employeeId, undefined, "example.com")).totalMs, 60_000, "a real suffix matches");
    // The HTTP filter is normalized (no '_' or '%'); the service must still not treat them as wildcards.
    for (const pattern of ["e_ample.com", "%.com", "exa%"]) {
      assert.equal((await websites.report(day, day, e.employeeId, undefined, pattern)).totalMs, 0, pattern);
    }
  });
});

describe("login rate limits", () => {
  test("an IP over its limit gets 429 before the attempt counts against the email", async () => {
    const victim = await user("EMPLOYEE");
    const [ip, email] = [auth.loginByIp, auth.loginByEmail];
    try {
      Object.assign(auth, { loginByIp: new RateLimiter(1, 60_000), loginByEmail: new RateLimiter(1, 60_000) });
      assert.equal((await api("/auth/login", { method: "POST", body: { email: "someone-else@example.com", password: "wrong password 1" } })).status, 401);
      const blocked = await api("/auth/login", { method: "POST", body: { email: victim.email, password: "wrong password 1" } });
      assert.equal(blocked.status, 429);
      assert.equal(blocked.body.error, "Too Many Requests", "named from the status, not the exception class");
      Object.assign(auth, { loginByIp: new RateLimiter(1, 60_000) }); // e.g. the window passed for the IP
      assert.equal((await api("/auth/login", { method: "POST", body: { email: victim.email, password: PASSWORD } })).status, 200, "the blocked attempt did not use the victim's email budget");
    } finally {
      Object.assign(auth, { loginByIp: ip, loginByEmail: email });
    }
  });

  test("RateLimiter tracks at most maxKeys keys, evicting the oldest", () => {
    const rl = new RateLimiter(1, 60_000, 3);
    const size = () => (rl as unknown as { hits: Map<string, unknown> }).hits.size;
    for (const k of ["a", "b", "c", "d", "e"]) assert.equal(rl.hit(k), true);
    assert.equal(size(), 3);
    assert.equal(rl.hit("e"), false, "a live key keeps its count");
    assert.equal(rl.hit("a"), true, "the oldest key was evicted");
    assert.equal(size(), 3);
  });
});

describe("error envelope and body parsing", () => {
  test("`error` is the HTTP status name for body-parser errors", async () => {
    const malformed = await api("/auth/login", { method: "POST", raw: new TextEncoder().encode("{"), contentType: "application/json" });
    assert.deepEqual([malformed.status, malformed.body.error], [400, "Bad Request"]);
    const big = await api("/auth/login", { method: "POST", raw: new TextEncoder().encode(JSON.stringify({ email: "x".repeat(1_100_000) })), contentType: "application/json" });
    assert.deepEqual([big.status, big.body.error], [413, "Payload Too Large"], "1 MB JSON cap");
    assert.deepEqual(Object.keys(big.body).filter((k) => !["error", "message", "path", "requestId", "statusCode", "timestamp"].includes(k)), [], "ApiError shape only");
  });

  test("raw WebP bodies are read only for PUT /screenshots/:id/content", async () => {
    // 11 MB is over the screenshot limit: buffered by a global raw parser it would be a 413 before auth.
    const webp = new Uint8Array(11 * 1024 * 1024);
    for (const [method, path] of [["PUT", "/websites/policy"], ["POST", "/auth/login"], ["POST", `/screenshots/${randomUUID()}/content`]] as const) {
      const r = await api(path, { method, raw: webp, contentType: "image/webp" });
      assert.notEqual(r.status, 413, `${method} ${path}: ${r.text}`);
    }
    const upload = await api(`/screenshots/${randomUUID()}/content`, { method: "PUT", raw: webp, contentType: "image/webp" });
    assert.equal(upload.status, 413, "the upload route still parses (and caps) WebP bodies");
  });
});

describe("devices", () => {
  test("a device revoked while its request runs gets 403, not an empty 200", async () => {
    const e = await user("EMPLOYEE");
    const installationId = randomUUID();
    const device = { installationId, deviceName: "Mac", platform: "macos" };
    // A browser (cookie) session cannot register a device or write device-bound records with a made-up installation id.
    assert.equal((await api("/devices/register", { method: "POST", cookie: e.cookie, body: device })).status, 403);
    assert.equal((await api("/attendance/clock-in", { method: "POST", cookie: e.cookie, headers: { "x-device-id": installationId, "idempotency-key": randomUUID() } })).status, 403);
    assert.equal(await count("SELECT count(*) AS n FROM devices WHERE employee_id = ?", [e.employeeId]), 0);
    const desktop = await api("/auth/login", { method: "POST", body: { email: e.email, password: PASSWORD, client: "desktop" } });
    const reg = await api("/devices/register", { method: "POST", bearer: desktop.body.accessToken, body: device });
    assert.equal(reg.status, 201, reg.text);
    assert.equal((await api("/attendance/clock-in", { method: "POST", cookie: e.cookie, headers: { "x-device-id": installationId, "idempotency-key": randomUUID() } })).status, 403, "still not from the browser, even with a real installation id");
    // The last-seen update runs in a batch with the session binding (API-08).
    const anyDb = db as unknown as { batch: (s: { sql: string }[], mode: string) => Promise<unknown> };
    const real = db.execute.bind(db);
    const realBatch = anyDb.batch.bind(db);
    anyDb.batch = async (stmts, mode) => {
      if (stmts[0]?.sql.trimStart().startsWith("UPDATE devices SET last_seen_at")) {
        await real({ sql: "UPDATE devices SET revoked_at = ? WHERE id = ?", args: [iso(Date.now()), reg.body.id] });
      }
      return realBatch(stmts, mode);
    };
    try {
      const me = await api("/devices/me", { cookie: e.cookie, headers: { "x-device-id": installationId } });
      assert.equal(me.status, 403, me.text);
    } finally {
      anyDb.batch = realBatch;
    }
  });
});
