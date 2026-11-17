// Migration 0031: several registered devices per employee, one active sign-in at a time, logout frees it,
// revocation ends only that device, and a revoked device registers again only after admin approval.
// Own file with a file database so the "API restart" case restarts against the same data.
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

const DIR = mkdtempSync(join(tmpdir(), "wf-multi-device-"));
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL = `file:${join(DIR, "api.db")}`;
process.env.JWT_SECRET = "test-secret-test-secret-test-secret!";

const { AppModule } = await import("../dist/app.module.js");
const { configureApp } = await import("../dist/app.setup.js");
const { DATABASE } = await import("../dist/database/database.module.js");
const { AuthService } = await import("../dist/auth/auth.service.js");
const { hashPassword } = await import("../dist/auth/crypto.js");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "employee password 1";
type Db = { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };

let app: INestApplication;
let base: string;
let db: Db;
let superCookie: string; // Super Admin (CEO)
let itCookie: string; // Admin (IT)

async function boot() {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
}

type Opts = { method?: string; body?: unknown; cookie?: string; bearer?: string; device?: string };
async function api(path: string, { method = "GET", body, cookie, bearer, device }: Opts = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, "idempotency-key": randomUUID() };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (device) headers["x-device-id"] = device;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text, res };
}

async function webLogin(email: string) {
  const r = await api("/auth/login", { method: "POST", body: { email, password: PASSWORD } });
  assert.equal(r.status, 200, r.text);
  return r.res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

async function adminUser(email: string, title: "SUPER_ADMIN" | null) {
  const id = randomUUID();
  await db.execute({ sql: "INSERT INTO users (id, email, role, admin_title, password_hash) VALUES (?, ?, 'ADMIN', ?, ?)", args: [id, email, title, await hashPassword(PASSWORD)] });
  return id;
}

let seq = 0;
interface Person {
  email: string;
  userId: string;
  employeeId: string;
}
async function employee(): Promise<Person> {
  const n = ++seq;
  const email = `md${n}@example.com`;
  const r = await api("/employees", { method: "POST", cookie: superCookie, body: { email, employeeCode: `MD-${n}`, fullName: `Multi Device ${n}`, timezone: "UTC" } });
  assert.equal(r.status, 201, r.text);
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  return { email, userId: r.body.employee.userId, employeeId: r.body.employee.id };
}

interface Session {
  bearer: string;
  refreshToken: string;
  sessionId: string;
}
/** Desktop sign-in on an installation. Returns the response; `session` only on 200. */
async function signIn(p: Person, installationId: string, takeover?: boolean) {
  const r = await api("/auth/login", { method: "POST", body: { email: p.email, password: PASSWORD, client: "desktop", installationId, ...(takeover !== undefined && { takeover }) } });
  const session: Session | null = r.status === 200 ? { bearer: r.body.accessToken, refreshToken: r.body.refreshToken, sessionId: String(r.body.refreshToken).split(".")[0]! } : null;
  return { ...r, session };
}
async function mustSignIn(p: Person, installationId: string, takeover?: boolean): Promise<Session> {
  const r = await signIn(p, installationId, takeover);
  assert.equal(r.status, 200, r.text);
  return r.session!;
}
const register = (s: Session, installationId: string, deviceName: string, platform: "macos" | "windows") =>
  api("/devices/register", { method: "POST", bearer: s.bearer, body: { installationId, deviceName, platform } });
const logout = (s: Session) => api("/auth/logout", { method: "POST", body: { refreshToken: s.refreshToken } });
async function refresh(s: Session) {
  const r = await api("/auth/refresh", { method: "POST", body: { refreshToken: s.refreshToken } });
  if (r.status === 200) Object.assign(s, { bearer: r.body.accessToken, refreshToken: r.body.refreshToken });
  return r.status;
}
const devicesOf = async (p: Person) => (await api(`/employees/${p.employeeId}/devices`, { cookie: itCookie })).body as { id: string; deviceName: string; platform: string; status: string }[];
const statusOf = async (p: Person, name: string) => (await devicesOf(p)).find((d) => d.deviceName === name)?.status;
const liveBound = async (p: Person) =>
  Number((await db.execute({ sql: "SELECT count(*) AS n FROM sessions WHERE user_id = ? AND device_id IS NOT NULL AND revoked_at IS NULL", args: [p.userId] })).rows[0]!.n);
const audits = async (p: Person, action: string) => (await db.execute({ sql: "SELECT * FROM account_audit WHERE target_user_id = ? AND action = ? ORDER BY created_at", args: [p.userId, action] })).rows;

/** Mac and Windows registered for one employee; the Mac holds the sign-in. */
async function macAndWindows() {
  const p = await employee();
  const mac = randomUUID();
  const win = randomUUID();
  const macSession = await mustSignIn(p, mac);
  const reg = await register(macSession, mac, "MacBook Air M2", "macos");
  assert.equal(reg.status, 201, reg.text);
  assert.equal(reg.body.status, "ACTIVE");
  // Windows: sign-in on a not-yet-registered installation is allowed only to register it.
  const winBoot = await mustSignIn(p, win);
  const winReg = await register(winBoot, win, "Windows Laptop", "windows");
  assert.equal(winReg.status, 409, "registered, but the Mac holds the sign-in");
  assert.equal(winReg.body.code, "ACTIVE_ON_ANOTHER_DEVICE");
  await logout(winBoot); // what the desktop app does after showing the conflict
  return { p, mac, win, macSession, macId: reg.body.id as string, winId: (await devicesOf(p)).find((d) => d.platform === "windows")!.id };
}

before(async () => {
  await boot();
  await adminUser("ceo@example.com", "SUPER_ADMIN");
  await adminUser("it@example.com", null);
  superCookie = await webLogin("ceo@example.com");
  itCookie = await webLogin("it@example.com");
});
// Every sign-in here comes from 127.0.0.1; the per-IP login limit is not what these tests are about.
beforeEach(() => (app.get(AuthService).loginByIp as unknown as { hits: Map<string, unknown> }).hits.clear());
after(async () => {
  await app.close();
  rmSync(DIR, { recursive: true, force: true });
});

describe("device registration", () => {
  test("first, second and third device, Windows and macOS under one employee; duplicates are idempotent", async () => {
    const { p, mac, macSession, macId } = await macAndWindows();
    const third = randomUUID();
    const s3 = await mustSignIn(p, third);
    assert.equal((await register(s3, third, "Another Laptop", "windows")).status, 409);
    await logout(s3);

    const list = await devicesOf(p);
    assert.equal(list.length, 3, "all three devices stay registered");
    assert.deepEqual(list.map((d) => d.status).sort(), ["ACTIVE", "INACTIVE", "INACTIVE"]);
    assert.equal(list.find((d) => d.status === "ACTIVE")!.id, macId);

    const again = await register(macSession, mac, "MacBook Air M2", "macos");
    assert.equal(again.status, 201);
    assert.equal(again.body.id, macId, "same installation, same record");
    assert.equal((await devicesOf(p)).length, 3, "no duplicate record");
    assert.equal((await audits(p, "DEVICE_REGISTERED")).length, 3);
  });

  test("an installation registered to another employee is refused; their device header is useless", async () => {
    const { mac } = await macAndWindows();
    const other = await employee();
    const s = await mustSignIn(other, mac);
    const r = await register(s, mac, "Shared Mac", "macos");
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "DEVICE_OWNED_BY_ANOTHER_EMPLOYEE");
    assert.equal((await api("/attendance/clock-in", { method: "POST", bearer: s.bearer, device: mac })).status, 403);
    assert.equal((await devicesOf(other)).length, 0);
  });
});

describe("single active sign-in", () => {
  test("Mac active blocks Windows; logout switches; and the reverse", async () => {
    const { p, mac, win, macSession } = await macAndWindows();

    const blocked = await signIn(p, win);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, "ACTIVE_ON_ANOTHER_DEVICE");
    assert.match(blocked.body.message, /MacBook Air M2 \(macOS\)/);
    assert.equal(blocked.body.details.activeDevice.deviceName, "MacBook Air M2");
    assert.equal(blocked.body.details.activeDevice.platform, "macos");
    assert.ok(!blocked.text.includes("refreshToken"), "no session issued");
    assert.equal(await refresh(macSession), 200, "the Mac is not signed out by the attempt");
    assert.equal((await audits(p, "DEVICE_SESSION_REJECTED")).length >= 1, true);

    assert.equal((await logout(macSession)).status, 204);
    assert.equal(await statusOf(p, "MacBook Air M2"), "INACTIVE", "logout keeps the registration");
    assert.equal(await refresh(macSession), 401, "refresh after logout is refused");
    assert.equal((await api("/auth/me", { bearer: macSession.bearer })).status, 401, "access token after logout is refused");

    const winSession = await mustSignIn(p, win);
    assert.equal(await statusOf(p, "Windows Laptop"), "ACTIVE");
    assert.equal((await api("/attendance/clock-in", { method: "POST", bearer: winSession.bearer, device: win })).status, 200);
    assert.equal((await signIn(p, mac)).status, 409, "reverse: Windows active blocks the Mac");

    await logout(winSession);
    const mac2 = await mustSignIn(p, mac);
    assert.equal(await statusOf(p, "MacBook Air M2"), "ACTIVE");
    assert.equal(await statusOf(p, "Windows Laptop"), "INACTIVE");
    assert.equal(await liveBound(p), 1);
    // Device-bound writes from the inactive device are refused even with a fresh unbound session.
    assert.equal((await api("/attendance/clock-out", { method: "POST", bearer: mac2.bearer, device: win })).status, 403);
  });

  test("simultaneous sign-ins on two devices: exactly one wins", async () => {
    const { p, mac, win, macSession } = await macAndWindows();
    await logout(macSession);
    for (let round = 0; round < 4; round++) {
      const results = await Promise.all([signIn(p, mac), signIn(p, win), signIn(p, mac), signIn(p, win)]);
      const won = results.filter((r) => r.status === 200);
      assert.ok(results.every((r) => r.status === 200 || r.status === 409), results.map((r) => r.status).join());
      assert.ok(won.length >= 1);
      // Several winners are only possible on the same installation (each replaces the previous one).
      const winners = new Set(results.flatMap((r, i) => (r.status === 200 ? [i % 2] : [])));
      assert.equal(winners.size, 1, "never two devices");
      assert.equal(await liveBound(p), 1, "one live device sign-in in the database");
      for (const r of won) await logout(r.session!);
    }
  });

  test("a repeat sign-in on the same installation replaces its own previous session", async () => {
    const { p, mac, macSession } = await macAndWindows();
    const again = await mustSignIn(p, mac);
    assert.equal(await refresh(macSession), 401);
    assert.equal(await refresh(again), 200);
    assert.equal(await liveBound(p), 1);
  });

  test("explicit takeover ends the other device's sign-in and is audited; it is never implicit", async () => {
    const { p, win, macSession } = await macAndWindows();
    assert.equal((await signIn(p, win, false)).status, 409);
    const winSession = await mustSignIn(p, win, true);
    assert.equal(await refresh(macSession), 401, "the Mac's refresh token is dead");
    assert.equal((await api("/auth/me", { bearer: macSession.bearer })).status, 401, "and its access token");
    assert.equal(await refresh(winSession), 200);
    assert.equal((await audits(p, "DEVICE_SESSION_TAKEOVER")).length, 1);
  });

  test("stale sign-in recovery: the employee signs the other device out from the web; expiry frees the slot", async () => {
    const { p, mac, win, macId, macSession } = await macAndWindows();
    const web = await webLogin(p.email);
    assert.equal((await api(`/devices/mine/${macId}/end-session`, { method: "POST", cookie: web })).status, 200);
    assert.equal(await refresh(macSession), 401);
    const winSession = await mustSignIn(p, win);

    // A sign-in past its absolute expiry no longer holds the slot.
    await db.execute({ sql: "UPDATE sessions SET expires_at = ? WHERE id = ?", args: [new Date(Date.now() - 1000).toISOString(), winSession.sessionId] });
    await mustSignIn(p, mac);
    const ended = (await db.execute({ sql: "SELECT revoked_at, expires_at FROM sessions WHERE id = ?", args: [winSession.sessionId] })).rows[0]!;
    assert.equal(ended.revoked_at, ended.expires_at, "recorded as ended when it expired");
    assert.equal(await refresh(winSession), 401);
  });

  test("an old app (no installation id at sign-in) is held to the same rule when it binds", async () => {
    const { p, win } = await macAndWindows();
    const legacy = await api("/auth/login", { method: "POST", body: { email: p.email, password: PASSWORD, client: "desktop" } });
    const bearer = legacy.body.accessToken as string;
    assert.equal((await api("/attendance/clock-in", { method: "POST", bearer, device: win })).status, 409);
    const me = await api("/devices/me", { bearer, device: win });
    assert.equal(me.body.status, "INACTIVE");
    assert.equal(me.body.activeDevice.deviceName, "MacBook Air M2");
    assert.equal(await liveBound(p), 1);
  });
});

describe("revocation and re-registration", () => {
  test("revoking the active device ends it at once; the other device is unaffected and can sign in", async () => {
    const { p, mac, win, macId, macSession } = await macAndWindows();
    const r = await api(`/devices/${macId}/revoke`, { method: "POST", cookie: itCookie, body: { reason: "Laptop lost" } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.status, "REVOKED");
    assert.equal(await refresh(macSession), 401, "refresh token after revocation");
    assert.equal((await api("/auth/me", { bearer: macSession.bearer })).status, 401, "access token after revocation");
    assert.equal(await statusOf(p, "Windows Laptop"), "INACTIVE", "other device stays registered");
    await mustSignIn(p, win);

    const again = await signIn(p, mac);
    assert.equal(again.status, 403, "revoked device cannot sign in");
    assert.equal(again.body.code, "DEVICE_REVOKED");
  });

  test("revoking an inactive device leaves the active one signed in", async () => {
    const { p, winId, macSession } = await macAndWindows();
    assert.equal((await api(`/devices/${winId}/revoke`, { method: "POST", cookie: itCookie })).status, 200);
    assert.equal(await refresh(macSession), 200);
    assert.equal(await statusOf(p, "MacBook Air M2"), "ACTIVE");
  });

  test("re-registration needs admin approval, never restores old tokens, and keeps the history", async () => {
    const { p, mac, win, macId, macSession } = await macAndWindows();
    assert.equal((await api(`/devices/${macId}/allow-reregistration`, { method: "POST", cookie: itCookie })).status, 409, "only a revoked device");
    await api(`/devices/${macId}/revoke`, { method: "POST", cookie: superCookie, body: { reason: "Reimaged" } });

    // Not approved yet: a plain (older app) session cannot register it either.
    const legacy = await api("/auth/login", { method: "POST", body: { email: p.email, password: PASSWORD, client: "desktop" } });
    const blocked = await api("/devices/register", { method: "POST", bearer: legacy.body.accessToken, body: { installationId: mac, deviceName: "MacBook Air M2", platform: "macos" } });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, "DEVICE_REVOKED");
    assert.equal((await api("/devices/me", { bearer: legacy.body.accessToken, device: mac })).body.status, "REVOKED", "unapproved stays REVOKED");

    const approved = await api(`/devices/${macId}/allow-reregistration`, { method: "POST", cookie: itCookie });
    assert.equal(approved.status, 200, approved.text);
    assert.equal(approved.body.status, "REVOKED", "approval activates nothing");
    assert.ok(approved.body.reregistrationApprovedAt);
    assert.equal(await refresh(macSession), 401, "old tokens stay dead");

    const s = await mustSignIn(p, mac);
    assert.equal((await api("/attendance/clock-in", { method: "POST", bearer: s.bearer, device: mac })).status, 403, "not authorized until registered again");
    // Older desktop apps show "Register" only on NOT_REGISTERED; the device itself still says REVOKED + approved.
    const me = await api("/devices/me", { bearer: s.bearer, device: mac });
    assert.equal(me.body.status, "NOT_REGISTERED", me.text);
    assert.equal(me.body.device.status, "REVOKED");
    assert.ok(me.body.device.reregistrationApprovedAt);
    const web = await webLogin(p.email);
    assert.equal((await api("/devices/me", { cookie: web, device: mac })).body.status, "REVOKED", "web view unchanged");
    assert.equal((await devicesOf(p)).find((d) => d.id === macId)?.status, "REVOKED", "admin list unchanged until registered");
    const re = await register(s, mac, "MacBook Air M2", "macos");
    assert.equal(re.status, 201, re.text);
    assert.equal(re.body.id, macId, "the same record, history kept");
    assert.equal(re.body.status, "ACTIVE");
    assert.equal(re.body.reregistrationApprovedAt, null, "approval consumed");
    assert.equal(await statusOf(p, "Windows Laptop"), "INACTIVE", "other device unaffected");
    assert.equal((await signIn(p, win)).status, 409);

    const history = (await api(`/devices/${macId}/history`, { cookie: itCookie })).body as { action: string; actorEmail: string | null; reason: string | null }[];
    const actions = history.map((h) => h.action);
    for (const a of ["DEVICE_REGISTERED", "DEVICE_REVOKED", "DEVICE_REREGISTRATION_APPROVED", "DEVICE_REREGISTERED"]) assert.ok(actions.includes(a), a);
    const revoked = history.find((h) => h.action === "DEVICE_REVOKED")!;
    assert.deepEqual([revoked.actorEmail, revoked.reason], ["ceo@example.com", "Reimaged"]);
    // Append-only: the audit rows cannot be erased.
    await assert.rejects(db.execute("DELETE FROM account_audit"), /append_only/);
  });
});

describe("RBAC", () => {
  test("employees see only their own devices and cannot manage any", async () => {
    const a = await macAndWindows();
    const b = await employee();
    const web = await webLogin(b.email);
    assert.equal((await api("/devices", { cookie: web })).status, 403);
    assert.equal((await api(`/devices/${a.macId}/history`, { cookie: web })).status, 403);
    for (const action of ["revoke", "allow-reregistration", "end-session"]) {
      assert.equal((await api(`/devices/${a.macId}/${action}`, { method: "POST", cookie: web })).status, 403, action);
    }
    assert.equal((await api(`/devices/mine/${a.macId}/end-session`, { method: "POST", cookie: web })).status, 404, "another employee's device");
    assert.equal((await api(`/employees/${a.p.employeeId}/devices`, { cookie: web })).status, 404);
    assert.equal(await refresh(a.macSession), 200, "nothing happened to it");
  });

  test("IT Admin manages employee devices; only the Super Admin manages a Super Admin's device", async () => {
    const a = await macAndWindows();
    const list = await api("/devices", { cookie: itCookie });
    assert.equal(list.status, 200);
    assert.ok(list.body.some((d: { id: string; email: string }) => d.id === a.macId && d.email === a.p.email));
    assert.equal((await api(`/devices/${a.macId}/end-session`, { method: "POST", cookie: itCookie })).status, 200);
    assert.equal(await refresh(a.macSession), 401);
    assert.equal(await statusOf(a.p, "MacBook Air M2"), "INACTIVE", "ending a session keeps the registration");

    // A Super Admin with an employee profile and a device.
    const ceo = (await db.execute("SELECT id FROM users WHERE email = 'ceo@example.com'")).rows[0]!.id as string;
    const profile = randomUUID();
    const device = randomUUID();
    await db.execute({ sql: "INSERT INTO employee_profiles (id, user_id, employee_code, full_name) VALUES (?, ?, 'CEO-1', 'CEO')", args: [profile, ceo] });
    await db.execute({ sql: "INSERT INTO devices (id, employee_id, device_name, platform, device_identifier) VALUES (?, ?, 'CEO Mac', 'macos', ?)", args: [device, profile, randomUUID()] });
    for (const action of ["revoke", "end-session"]) {
      assert.equal((await api(`/devices/${device}/${action}`, { method: "POST", cookie: itCookie })).status, 403, action);
    }
    assert.equal((await api(`/devices/${device}/revoke`, { method: "POST", cookie: superCookie })).status, 200);
    assert.equal((await api(`/devices/${device}/allow-reregistration`, { method: "POST", cookie: itCookie })).status, 403);
    assert.equal((await api(`/devices/${device}/allow-reregistration`, { method: "POST", cookie: superCookie })).status, 200);
  });
});

describe("API restart", () => {
  test("an active sign-in survives a restart and still blocks the other device", async () => {
    const { p, mac, win, macSession } = await macAndWindows();
    await app.close();
    await boot();
    superCookie = await webLogin("ceo@example.com");
    itCookie = await webLogin("it@example.com");
    assert.equal(await refresh(macSession), 200, "refresh works after the restart");
    assert.equal((await api("/attendance/clock-in", { method: "POST", bearer: macSession.bearer, device: mac })).status, 200);
    assert.equal((await signIn(p, win)).status, 409);
    await logout(macSession);
    await mustSignIn(p, win);
  });
});
