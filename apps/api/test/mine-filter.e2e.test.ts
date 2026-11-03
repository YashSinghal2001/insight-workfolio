// P2.1 `mine` filter on GET /leave and GET /attendance/corrections: the caller's own profile, taken from
// the session (never from the client), for employees and for administrators who have a profile.
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
const { hashPassword } = await import("../dist/auth/crypto.js");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "mine filter password 1";
let app: INestApplication;
let base: string;
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };

async function api(path: string, { method = "GET", body, cookie }: { method?: string; body?: unknown; cookie?: string } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text };
}
let n = 0;
type Who = { id: string; employeeId: string | null; cookie: string };
async function user(title: "SUPER_ADMIN" | "ADMIN" | "EMPLOYEE", withProfile = true): Promise<Who> {
  const id = randomUUID();
  const email = `mine${++n}@example.com`;
  await db.execute({ sql: "INSERT INTO users (id, email, role, admin_title, password_hash) VALUES (?, ?, ?, ?, ?)", args: [id, email, title === "EMPLOYEE" ? "EMPLOYEE" : "ADMIN", title === "EMPLOYEE" ? null : title, await hashPassword(PASSWORD)] });
  let employeeId: string | null = null;
  if (withProfile) {
    employeeId = randomUUID();
    await db.execute({ sql: "INSERT INTO employee_profiles (id, user_id, employee_code, full_name, timezone) VALUES (?, ?, ?, ?, 'UTC')", args: [employeeId, id, `MF-${n}`, `Mine ${n}`] });
  }
  const res = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
  assert.equal(res.status, 200);
  return { id, employeeId, cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
}
/** Two leave requests (one pending, one cancelled) and two correction requests per profile. */
async function seed(who: Who, day: number) {
  for (const d of [day, day + 1]) {
    const date = `2027-01-${String(d).padStart(2, "0")}`;
    const r = await api("/leave", { method: "POST", cookie: who.cookie, body: { startDate: date, endDate: date, portion: "FULL_DAY" } });
    assert.equal(r.status, 201, r.text);
    if (d !== day) assert.equal((await api(`/leave/${r.body.id}/cancel`, { method: "POST", cookie: who.cookie })).status, 200);
    await db.execute({
      sql: "INSERT INTO correction_requests (id, employee_id, requested_by, type, proposed, reason) VALUES (?, ?, ?, 'MISSING_CLOCK_IN', ?, 'Forgot to clock in')",
      args: [randomUUID(), who.employeeId, who.id, JSON.stringify({ clockInAt: `${date}T09:00:00.000Z` })],
    });
  }
}
const ids = (body: { items: { employee: { id: string } }[] }) => [...new Set(body.items.map((r) => r.employee.id))];

let superAdmin: Who, admin: Who, employee: Who, other: Who, bare: Who;
before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  [superAdmin, admin, employee, other, bare] = [await user("SUPER_ADMIN"), await user("ADMIN"), await user("EMPLOYEE"), await user("EMPLOYEE"), await user("ADMIN", false)];
  for (const [i, who] of [superAdmin, admin, employee, other].entries()) await seed(who, 1 + i * 3);
});
after(() => app.close());

for (const [label, path] of [["leave", "/leave"], ["corrections", "/attendance/corrections"]] as const) {
  describe(`${label}: mine`, () => {
    test("Super Admin and Admin with a profile get only their own rows with mine=true", async () => {
      for (const who of [superAdmin, admin]) {
        const r = await api(`${path}?mine=true&pageSize=100`, { cookie: who.cookie });
        assert.equal(r.status, 200, r.text);
        assert.deepEqual(ids(r.body), [who.employeeId]);
        assert.equal(r.body.total, 2);
        const pending = await api(`${path}?mine=true&status=PENDING`, { cookie: who.cookie });
        assert.deepEqual(ids(pending.body), [who.employeeId]);
        assert.equal(pending.body.total, label === "leave" ? 1 : 2, "combines with status");
      }
    });

    test("without mine (or mine=false) the admin list stays organisation-wide; employeeId still selects one employee", async () => {
      for (const q of ["", "?mine=false"]) {
        const r = await api(`${path}${q}${q ? "&" : "?"}pageSize=100`, { cookie: admin.cookie });
        assert.deepEqual(ids(r.body).sort(), [superAdmin, admin, employee, other].map((w) => w.employeeId).sort());
      }
      assert.deepEqual(ids((await api(`${path}?employeeId=${other.employeeId}`, { cookie: admin.cookie })).body), [other.employeeId]);
    });

    test("employees: unchanged, with or without mine, always their own", async () => {
      for (const q of ["", "?mine=true", "?mine=false"]) {
        const r = await api(`${path}${q}`, { cookie: employee.cookie });
        assert.equal(r.status, 200, r.text);
        assert.deepEqual(ids(r.body), [employee.employeeId]);
      }
      assert.equal((await api(`${path}?employeeId=${other.employeeId}`, { cookie: employee.cookie })).status, 404, "another employee: not found");
    });

    test("mine=true with employeeId is rejected (400), even with the caller's own id; bad values too", async () => {
      for (const who of [admin, employee]) {
        for (const id of [who.employeeId, other.employeeId]) {
          assert.equal((await api(`${path}?mine=true&employeeId=${id}`, { cookie: who.cookie })).status, 400);
        }
      }
      for (const v of ["1", "yes", "TRUE", ""]) assert.equal((await api(`${path}?mine=${v}`, { cookie: admin.cookie })).status, 400, v);
    });

    test("an administrator without a profile gets the usual no-profile error; the client cannot pick another profile", async () => {
      const r = await api(`${path}?mine=true`, { cookie: bare.cookie });
      assert.equal(r.status, 403);
      assert.match(r.body.message, /no employee profile/);
      assert.equal((await api(path, { cookie: bare.cookie })).status, 200, "the org-wide list still works");
      // Unknown parameters naming someone else are ignored; the session decides.
      const spoof = await api(`${path}?mine=true&userId=${other.id}&employee=${other.employeeId}`, { cookie: admin.cookie });
      assert.deepEqual(ids(spoof.body), [admin.employeeId]);
    });
  });
}
