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
  const email = `dev${n}@example.com`;
  const r = await api("/employees", {
    method: "POST",
    cookie: adminCookie,
    body: { email, employeeCode: `DEV-${n}`, fullName: `Device ${n}`, timezone: "UTC" },
  });
  assert.equal(r.status, 201, r.text);
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const login = await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } });
  assert.equal(login.status, 200, login.text);
  const userId = String((await db.execute({ sql: "SELECT user_id FROM employee_profiles WHERE id = ?", args: [r.body.employee.id] })).rows[0]!.user_id);
  return { userId, email, bearer: login.body.accessToken as string, device: randomUUID() };
}

const register = (e: { bearer: string }, installationId: string, deviceName = "Alice's MacBook") =>
  api("/devices/register", { method: "POST", bearer: e.bearer, body: { installationId, deviceName, platform: "macos" } });

const audits = async (action: string, userId: string) =>
  (await db.execute({ sql: "SELECT * FROM account_audit WHERE action = ? AND target_user_id = ? ORDER BY created_at", args: [action, userId] })).rows;

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  await db.execute({
    sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, ?, 'ADMIN', ?)",
    args: [ADMIN.id, ADMIN.email, await hashPassword(ADMIN.password)],
  });
  const r = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
  });
  adminCookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
});
after(() => app.close());

test("device registration and revocation are audited once, with actor, and never leak the installation id", async () => {
  const e = await employee();
  const responses: string[] = [];

  const first = await register(e, e.device);
  assert.equal(first.status, 201, first.text);
  const again = await register(e, e.device);
  assert.equal(again.body.id, first.body.id, "re-register of the same installation is idempotent");
  responses.push(first.text, again.text);

  const reg = await audits("DEVICE_REGISTERED", e.userId);
  assert.equal(reg.length, 1, "registered once, not on idempotent re-register");
  assert.deepEqual(
    [reg[0]!.actor_user_id, reg[0]!.resource_type, reg[0]!.resource_id, JSON.parse(String(reg[0]!.metadata))],
    [e.userId, "DEVICE", first.body.id, { platform: "macos" }],
  );
  assert.ok(!JSON.stringify(reg).includes("Alice"), "user-chosen device name is not audited");

  const second = await register(e, randomUUID());
  assert.equal(second.status, 409, "one active device per employee");
  assert.equal((await audits("DEVICE_REGISTERED", e.userId)).length, 1, "refused device is not audited");

  const denied = await api(`/devices/${first.body.id}/revoke`, { method: "POST", bearer: e.bearer });
  assert.equal(denied.status, 403, "employees cannot revoke");
  assert.equal((await audits("DEVICE_REVOKED", e.userId)).length, 0);

  const revoked = await api(`/devices/${first.body.id}/revoke`, { method: "POST", cookie: adminCookie });
  assert.equal(revoked.status, 200, revoked.text);
  const repeat = await api(`/devices/${first.body.id}/revoke`, { method: "POST", cookie: adminCookie });
  assert.equal(repeat.status, 200, "revocation stays idempotent");
  responses.push(revoked.text, repeat.text);
  const rev = await audits("DEVICE_REVOKED", e.userId);
  assert.equal(rev.length, 1, "repeat revoke changes nothing and is not audited again");
  assert.deepEqual([rev[0]!.actor_user_id, rev[0]!.resource_type, rev[0]!.resource_id], [ADMIN.id, "DEVICE", first.body.id]);

  assert.equal((await api("/devices/00000000-0000-4000-8000-000000000000/revoke", { method: "POST", cookie: adminCookie })).status, 404);

  // The revoked device's session was revoked with it (API-08); a fresh sign-in on that installation
  // is refused by every attendance write.
  assert.equal((await api("/devices/me", { bearer: e.bearer, device: e.device })).status, 401);
  e.bearer = (await api("/auth/login", { method: "POST", body: { email: e.email, password: PASSWORD, client: "desktop" } })).body.accessToken;
  const clockIn = await api("/attendance/clock-in", { method: "POST", bearer: e.bearer, device: e.device });
  assert.equal(clockIn.status, 403, clockIn.text);
  const sync = await api("/attendance/sync", {
    method: "POST",
    bearer: e.bearer,
    device: e.device,
    body: { sentAt: new Date().toISOString(), events: [{ id: randomUUID(), type: "CLOCK_IN", occurredAt: new Date().toISOString() }] },
  });
  assert.equal(sync.status, 403, sync.text);
  const me = await api("/devices/me", { bearer: e.bearer, device: e.device });
  assert.equal(me.body.status, "REVOKED");
  responses.push(clockIn.text, sync.text, me.text);

  for (const text of responses) assert.ok(!text.includes(e.device), "installation id never appears in a response");
  const allAudit = JSON.stringify((await db.execute("SELECT * FROM account_audit")).rows);
  assert.ok(!allAudit.includes(e.device), "installation id never appears in the audit");
  const stored = (await db.execute({ sql: "SELECT device_identifier FROM devices WHERE id = ?", args: [first.body.id] })).rows[0]!;
  assert.notEqual(stored.device_identifier, e.device, "only the hash is stored");
  assert.match(String(stored.device_identifier), /^[0-9a-f]{64}$/);
});

test("concurrent registration of the same installation stays idempotent and is audited once", async () => {
  const e = await employee();
  const results = await Promise.all([register(e, e.device), register(e, e.device), register(e, e.device)]);
  assert.deepEqual(results.map((r) => r.status), [201, 201, 201], results.map((r) => r.text).join("\n"));
  assert.equal(new Set(results.map((r) => r.body.id)).size, 1);
  assert.equal((await audits("DEVICE_REGISTERED", e.userId)).length, 1);
});
