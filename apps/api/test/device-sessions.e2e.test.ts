// API-08: revoking a device also revokes the sessions used from it (bound on register / heartbeat);
// the user's other sessions, a later device and other users are unaffected.
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL = ":memory:";
process.env.JWT_SECRET = "test-secret-test-secret-test-secret!";

const { AppModule } = await import("../dist/app.module.js");
const { configureApp } = await import("../dist/app.setup.js");
const { DATABASE } = await import("../dist/database/database.module.js");
const { hashPassword } = await import("../dist/auth/crypto.js");

const ORIGIN = "http://localhost:3000";
const ADMIN = { id: randomUUID(), email: "admin@example.com", password: "admin password 123" };
const PASSWORD = "employee password 1";

let app: INestApplication;
let base: string;
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
let adminCookie: string;

type Opts = { method?: string; body?: unknown; cookie?: string; bearer?: string; device?: string };
async function api(path: string, { method = "GET", body, cookie, bearer, device }: Opts = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, "idempotency-key": randomUUID() };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (device) headers["x-device-id"] = device;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text };
}

let seq = 0;
async function employee() {
  const n = ++seq;
  const email = `ds${n}@example.com`;
  const r = await api("/employees", { method: "POST", cookie: adminCookie, body: { email, employeeCode: `DS-${n}`, fullName: `Dev Session ${n}`, timezone: "UTC" } });
  assert.equal(r.status, 201, r.text);
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  return email;
}

/** A desktop login: access + refresh token in the body. */
async function login(email: string) {
  const r = await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } });
  assert.equal(r.status, 200, r.text);
  return { bearer: r.body.accessToken as string, refreshToken: r.body.refreshToken as string, sessionId: String(r.body.refreshToken).split(".")[0]! };
}
type Session = Awaited<ReturnType<typeof login>>;

/** Refreshes (rotating the token in place) and returns the status. */
async function refresh(s: Session) {
  const r = await api("/auth/refresh", { method: "POST", body: { refreshToken: s.refreshToken } });
  if (r.status === 200) Object.assign(s, { bearer: r.body.accessToken, refreshToken: r.body.refreshToken });
  return r.status;
}

const register = (s: Session, installationId: string) =>
  api("/devices/register", { method: "POST", bearer: s.bearer, body: { installationId, deviceName: "Laptop", platform: "macos" } });

const boundTo = async (s: Session) => (await db.execute({ sql: "SELECT device_id FROM sessions WHERE id = ?", args: [s.sessionId] })).rows[0]!.device_id;

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, ?, 'ADMIN', ?)", args: [ADMIN.id, ADMIN.email, await hashPassword(ADMIN.password)] });
  const r = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
  });
  adminCookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
});
after(() => app.close());

test("revoking a device revokes exactly the sessions used from it", async () => {
  const email = await employee();
  const [d1, d2] = [randomUUID(), randomUUID()];

  // S1 registers device 1. S1b, a later sign-in on the same installation (an older app that binds on its
  // heartbeat), becomes that device's sign-in and replaces S1 (0031: one active device sign-in per account).
  const s1 = await login(email);
  const reg1 = await register(s1, d1);
  assert.equal(reg1.status, 201, reg1.text);
  const s1b = await login(email);
  assert.equal((await api("/devices/me", { bearer: s1b.bearer, device: d1 })).body.status, "ACTIVE");
  assert.equal(await refresh(s1), 401, "the replaced sign-in on the same installation is ended");
  // S2: another session of the same user that never used a device (unbound, like a web session).
  // Other: another employee's device session.
  const s2 = await login(email);
  const other = await login(await employee());
  const otherDevice = randomUUID();
  assert.equal((await register(other, otherDevice)).status, 201);
  assert.deepEqual([await boundTo(s1b), await boundTo(s2), await boundTo(other)], [reg1.body.id, null, (await api("/devices/me", { bearer: other.bearer, device: otherDevice })).body.device.id]);
  assert.equal(await refresh(s1b), 200, "refresh keeps the binding");
  assert.equal(await boundTo(s1b), reg1.body.id);
  Object.assign(s1, s1b);

  const revoked = await api(`/devices/${reg1.body.id}/revoke`, { method: "POST", cookie: adminCookie });
  assert.equal(revoked.status, 200, revoked.text);

  assert.equal(await refresh(s1), 401, "the revoked device's refresh token is dead");
  assert.equal(await refresh(s1b), 401);
  assert.equal((await api("/auth/me", { bearer: s1.bearer })).status, 401, "its access token stops at once (sessions are checked per request)");
  assert.equal(await refresh(s2), 200, "the user's other session is unaffected");
  assert.equal(await refresh(other), 200, "other users are unaffected");
  assert.equal((await api("/devices/me", { bearer: other.bearer, device: otherDevice })).body.status, "ACTIVE");

  // Signing in again on the revoked installation works but the device stays revoked (existing semantics).
  const s3 = await login(email);
  assert.equal((await api("/devices/me", { bearer: s3.bearer, device: d1 })).body.status, "REVOKED");
  assert.equal(await boundTo(s3), null, "a revoked device binds nothing");
  assert.equal((await api("/attendance/clock-in", { method: "POST", bearer: s3.bearer, device: d1 })).status, 403);
  assert.equal((await register(s3, d1)).status, 403, "a revoked installation cannot re-register");

  // A new device (S4) can be enrolled; revoking it does not touch S2 either.
  const s4 = await login(email);
  const reg2 = await register(s4, d2);
  assert.equal(reg2.status, 201, reg2.text);
  assert.equal((await api(`/devices/${reg2.body.id}/revoke`, { method: "POST", cookie: adminCookie })).status, 200);
  assert.equal(await refresh(s4), 401);
  assert.equal(await refresh(s2), 200);
  assert.equal(await refresh(s3), 200, "S3 never bound to an active device, so it lives on");
});
