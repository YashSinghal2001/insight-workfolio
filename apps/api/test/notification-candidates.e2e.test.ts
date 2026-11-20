// GET /notifications/rules/recipient-candidates (W2-SETTINGS): exactly the accounts PUT recipients accepts.
// In-process API, in-memory DB, synthetic people.
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
const PASSWORD = "employee password 1";

interface Emp { id: string; userId: string; bearer: string }

let app: INestApplication;
let base: string;
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
let admin: string;
let head: Emp, plain: Emp, it: Emp, gone: Emp, boss: Emp;
let alpha: string, closed: string, adminId: string;

async function api(path: string, { method = "GET", body, cookie, bearer }: { method?: string; body?: unknown; cookie?: string; bearer?: string } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text };
}

async function employee(code: string): Promise<Emp> {
  const email = `${code.toLowerCase()}@example.com`;
  const e = await api("/employees", { method: "POST", cookie: admin, body: { email, employeeCode: code, fullName: `Person ${code}`, timezone: "UTC" } });
  assert.equal(e.status, 201, e.text);
  await api("/auth/setup-password", { method: "POST", body: { token: e.body.setup.token, password: PASSWORD } });
  const login = await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } });
  return { id: e.body.employee.id, userId: e.body.employee.userId, bearer: login.body.accessToken };
}

const cands = async (q = "", auth: { cookie?: string; bearer?: string } = { cookie: admin }) => api(`/notifications/rules/recipient-candidates${q}`, auth);
const ids = (r: { body: { userId: string }[] }) => r.body.map((c) => c.userId).sort();

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  adminId = randomUUID();
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [adminId, await hashPassword(PASSWORD)] });
  const login = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email: "admin@example.com", password: PASSWORD }) });
  admin = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  head = await employee("HEAD");
  plain = await employee("PLAIN");
  it = await employee("IT");
  gone = await employee("GONE");
  boss = await employee("BOSS");
  await db.execute({ sql: "UPDATE users SET role = 'ADMIN' WHERE id IN (?, ?)", args: [it.userId, gone.userId] });
  await db.execute({ sql: "UPDATE users SET role = 'ADMIN', admin_title = 'SUPER_ADMIN' WHERE id = ?", args: [boss.userId] });
  await db.execute({ sql: "UPDATE users SET status = 'DISABLED' WHERE id = ?", args: [gone.userId] });
  alpha = (await api("/teams", { method: "POST", cookie: admin, body: { name: "Alpha", headUserId: head.userId } })).body.id;
  closed = (await api("/teams", { method: "POST", cookie: admin, body: { name: "Closed", headUserId: plain.userId } })).body.id;
  assert.equal((await api(`/teams/${closed}`, { method: "PATCH", cookie: admin, body: { active: false } })).status, 200);
});
after(() => app.close());

test("admin: organisation scope = active admins only (disabled admin excluded), with identity", async () => {
  const r = await cands();
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(ids(r), [adminId, it.userId, boss.userId].sort());
  const by = Object.fromEntries((r.body as { userId: string }[]).map((c) => [c.userId, c])) as Record<string, Record<string, unknown>>;
  assert.deepEqual(by[boss.userId], { userId: boss.userId, fullName: "Person BOSS", email: "boss@example.com", platformRole: "SUPER_ADMIN", teamHead: false });
  assert.equal(by[adminId]!.fullName, null, "admin without an employee profile is listed");
  assert.equal(by[it.userId]!.platformRole, "ADMIN");
});

test("team scope adds that active team's head; an inactive team's head is not added; unknown team 404; bad id 400", async () => {
  const r = await cands(`?teamId=${alpha}`);
  assert.deepEqual(ids(r), [adminId, it.userId, boss.userId, head.userId].sort());
  assert.equal((r.body as { userId: string; teamHead: boolean; platformRole: string }[]).find((c) => c.userId === head.userId)!.teamHead, true);
  assert.deepEqual(ids(await cands(`?teamId=${closed}`)), [adminId, it.userId, boss.userId].sort());
  assert.equal((await cands(`?teamId=${randomUUID()}`)).status, 404);
  assert.equal((await cands("?teamId=nope")).status, 400);
  assert.equal((await cands("?other=1")).status, 400);
});

test("employee 403; team head 403", async () => {
  assert.equal((await cands("", { bearer: plain.bearer })).status, 403);
  assert.equal((await cands(`?teamId=${alpha}`, { bearer: head.bearer })).status, 403);
});

test("the list equals what PUT recipients accepts", async () => {
  const rules = (await api("/notifications/rules", { cookie: admin })).body as { id: string; type: string; teamId: string | null }[];
  const org = rules.find((r) => r.type === "ABSENCE" && r.teamId === null)!;
  const team = (await api("/notifications/rules", { method: "POST", cookie: admin, body: { type: "ABSENCE", teamId: alpha } })).body as { id: string };
  const everyone = [adminId, it.userId, gone.userId, boss.userId, head.userId, plain.userId];
  for (const [rule, q] of [[org.id, ""], [team.id, `?teamId=${alpha}`]] as const) {
    const allowed = ids(await cands(q));
    const put = (userIds: string[]) => api(`/notifications/rules/${rule}/recipients`, { method: "PUT", cookie: admin, body: { userIds } });
    const all = await put(allowed);
    assert.equal(all.status, 200, all.text);
    assert.deepEqual((all.body.recipients as { userId: string }[]).map((x) => x.userId).sort(), allowed);
    for (const u of everyone.filter((x) => !allowed.includes(x))) assert.equal((await put([u])).status, 400, `${q} ${u} refused`);
    await put([]);
  }
});
