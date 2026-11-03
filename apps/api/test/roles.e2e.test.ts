// Finalized roles (in-process API, in-memory DB): Super Admin (CEO) and Admin (IT) have the same
// permissions; employees only their own data. Safeguards against self-lockout, escalation and losing
// the last administrator; every change in the role history.
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
const { RolesService } = await import("../dist/roles/roles.service.js");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "role password 1";
let app: INestApplication;
let base: string;
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };

async function api(path: string, { method = "GET", body, cookie, headers = {} }: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
  const h: Record<string, string> = { origin: ORIGIN, ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  if (cookie) h.cookie = cookie;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text };
}
const login = async (email: string) => {
  const res = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
  assert.equal(res.status, 200, email);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
};
let n = 0;
/** A user; employees and (optionally) admins get an employee profile. */
async function user(title: "SUPER_ADMIN" | "ADMIN" | "EMPLOYEE", withProfile = title === "EMPLOYEE") {
  const id = randomUUID();
  const email = `r${++n}@example.com`;
  await db.execute({ sql: "INSERT INTO users (id, email, role, admin_title, password_hash) VALUES (?, ?, ?, ?, ?)", args: [id, email, title === "EMPLOYEE" ? "EMPLOYEE" : "ADMIN", title === "EMPLOYEE" ? null : title, await hashPassword(PASSWORD)] });
  let employeeId: string | null = null;
  if (withProfile) {
    employeeId = randomUUID();
    await db.execute({ sql: "INSERT INTO employee_profiles (id, user_id, employee_code, full_name, timezone) VALUES (?, ?, ?, ?, 'UTC')", args: [employeeId, id, `RL-${n}`, `Role ${n}`] });
  }
  return { id, email, employeeId, cookie: await login(email) };
}
const change = (who: { cookie: string }, id: string, platformRole: string, reason = "role change (test)") => api(`/roles/users/${id}`, { method: "PATCH", cookie: who.cookie, body: { platformRole, reason } });

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
});
after(() => app.close());

describe("roles", () => {
  test("identities: Super Admin, Admin and Employee are reported by the server", async () => {
    const [s, a, e] = [await user("SUPER_ADMIN"), await user("ADMIN"), await user("EMPLOYEE")];
    for (const [who, role, platformRole] of [[s, "ADMIN", "SUPER_ADMIN"], [a, "ADMIN", "ADMIN"], [e, "EMPLOYEE", "EMPLOYEE"]] as const) {
      const me = (await api("/auth/me", { cookie: who.cookie })).body.user;
      assert.deepEqual([me.role, me.platformRole], [role, platformRole]);
    }
  });

  test("Super Admin and Admin have exactly the same access; employees get none of it (server-side)", async () => {
    const [s, a, e] = [await user("SUPER_ADMIN"), await user("ADMIN"), await user("EMPLOYEE")];
    const routes = [
      "/employees", "/roles/users", "/roles/history", "/websites/policy", "/websites/categories", "/websites/audit", "/websites/notifications",
      "/websites/report?from=2026-10-01&to=2026-10-07", "/projects", "/projects/summary?from=2026-10-01&to=2026-10-07", "/leave", "/reports/schedules",
      "/settings/monitoring", "/settings/screenshots", "/attendance/timesheets?from=2026-10-01&to=2026-10-07", "/activity/retention",
    ];
    for (const path of routes) {
      const [rs, ra, re] = [await api(path, { cookie: s.cookie }), await api(path, { cookie: a.cookie }), await api(path, { cookie: e.cookie, headers: { "x-role": "ADMIN", "x-platform-role": "SUPER_ADMIN" } })];
      assert.equal(rs.status, ra.status, `${path}: Super Admin ${rs.status} vs Admin ${ra.status}`);
      assert.ok(rs.status < 400, `${path}: ${rs.status} ${rs.text.slice(0, 80)}`);
      assert.ok(re.status === 403 || (path === "/leave" && re.status === 200), `${path}: employee ${re.status}`);
    }
    // /leave is open to employees but scoped to their own requests.
    assert.ok((await api("/leave", { cookie: e.cookie })).body.items.every((r: { employee: { id: string } }) => r.employee.id === e.employeeId));
  });

  test("role changes: promotion is immediate and recorded; only a Super Admin manages the Super Admin role; no self-change", async () => {
    const [s, a, e] = [await user("SUPER_ADMIN"), await user("ADMIN"), await user("EMPLOYEE")];
    assert.equal((await api("/employees", { cookie: e.cookie })).status, 403);
    const up = await change(a, e.id, "ADMIN", "Joined the IT team");
    assert.equal(up.status, 200, up.text);
    assert.equal(up.body.platformRole, "ADMIN");
    assert.equal((await api("/employees", { cookie: e.cookie })).status, 200, "the existing session now has admin access (role read from the database)");
    assert.equal((await change(a, e.id, "SUPER_ADMIN")).status, 403, "an Admin cannot grant Super Admin");
    assert.equal((await change(a, s.id, "ADMIN")).status, 403, "an Admin cannot remove a Super Admin");
    assert.equal((await change(s, e.id, "SUPER_ADMIN", "Acting CEO")).status, 200, "a Super Admin can");
    for (const who of [s, a]) assert.match((await change(who, who.id, "EMPLOYEE")).body.message, /your own role/);
    assert.equal((await change(a, s.id, "EMPLOYEE")).status, 403);
    assert.equal((await change(s, a.id, "EMPLOYEE")).status, 400, "an admin without an employee profile cannot become an employee");
    assert.equal((await change(s, e.id, "SUPER_ADMIN")).status, 400, "already has it");
    for (const body of [{ platformRole: "OWNER", reason: "x y z" }, { platformRole: "ADMIN" }, { platformRole: "ADMIN", reason: "x" }, { platformRole: "ADMIN", reason: "valid reason", extra: 1 }]) {
      assert.equal((await api(`/roles/users/${e.id}`, { method: "PATCH", cookie: s.cookie, body })).status, 400, JSON.stringify(body));
    }
    assert.equal((await change(s, randomUUID(), "ADMIN")).status, 404);
    const emp = await user("EMPLOYEE");
    assert.equal((await change(emp, emp.id, "ADMIN")).status, 403, "employees cannot reach role management");
    assert.equal((await change(emp, e.id, "EMPLOYEE")).status, 403);
    assert.equal((await api(`/employees/${emp.employeeId}`, { method: "PATCH", cookie: s.cookie, body: { role: "ADMIN" } })).status, 400, "no role field on employee updates");
    const history = (await api("/roles/history", { cookie: a.cookie })).body;
    const mine = history.filter((h: { target: { id: string } }) => h.target.id === e.id).map((h: { from: string; to: string; by: { email: string }; reason: string }) => `${h.from}>${h.to} by ${h.by.email}: ${h.reason}`);
    assert.deepEqual(mine, [`ADMIN>SUPER_ADMIN by ${s.email}: Acting CEO`, `EMPLOYEE>ADMIN by ${a.email}: Joined the IT team`]);
  });

  test("never zero administrators or Super Admins, even when two demote each other at the same moment", async () => {
    await db.execute("UPDATE users SET status = 'DISABLED' WHERE role = 'ADMIN'"); // only the two below are active admins now
    const [a1, a2] = [await user("ADMIN", true), await user("ADMIN", true)];
    const both = await Promise.all([change(a1, a2.id, "EMPLOYEE"), change(a2, a1.id, "EMPLOYEE")]);
    // The loser is refused either at sign-in check (already demoted: 403) or by the guard inside the UPDATE (409).
    assert.equal(both.filter((r) => r.status === 200).length, 1, JSON.stringify(both.map((r) => r.body)));
    assert.ok(both.some((r) => r.status === 403 || r.status === 409));
    assert.equal(Number((await db.execute("SELECT count(*) AS n FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE'")).rows[0]!.n), 1);
    // The in-statement guard itself: an actor authenticated just before being demoted (stale context).
    const roles = app.get(RolesService);
    const [winner, loser] = both[0]!.status === 200 ? [a1, a2] : [a2, a1];
    await assert.rejects(roles.change({ id: loser.id, email: loser.email, role: "ADMIN", platformRole: "ADMIN", sessionId: "x" }, winner.id, "EMPLOYEE", "stale context"), /last active administrator/);
    await db.execute("UPDATE users SET status = 'DISABLED' WHERE role = 'ADMIN'");
    const [s1, s2] = [await user("SUPER_ADMIN", true), await user("SUPER_ADMIN", true)];
    const supers = await Promise.all([change(s1, s2.id, "ADMIN"), change(s2, s1.id, "ADMIN")]);
    assert.equal(supers.filter((r) => r.status === 200).length, 1, JSON.stringify(supers.map((r) => r.body)));
    assert.equal(Number((await db.execute("SELECT count(*) AS n FROM users WHERE admin_title = 'SUPER_ADMIN' AND role = 'ADMIN' AND status = 'ACTIVE'")).rows[0]!.n), 1);
    const [sw, sl] = supers[0]!.status === 200 ? [s1, s2] : [s2, s1];
    await assert.rejects(roles.change({ id: sl.id, email: sl.email, role: "ADMIN", platformRole: "SUPER_ADMIN", sessionId: "x" }, sw.id, "ADMIN", "stale context"), /last active Super Admin/);
  });

  test("disabling accounts: never yourself, never the last administrator", async () => {
    const [s, a] = [await user("SUPER_ADMIN", true), await user("ADMIN", true)];
    assert.equal((await api(`/employees/${s.employeeId}/status`, { method: "PATCH", cookie: s.cookie, body: { status: "DISABLED" } })).status, 400, "not yourself");
    await db.execute({ sql: "UPDATE users SET status = 'DISABLED' WHERE role = 'ADMIN' AND id NOT IN (?, ?)", args: [s.id, a.id] });
    assert.equal((await api(`/employees/${a.employeeId}/status`, { method: "PATCH", cookie: s.cookie, body: { status: "DISABLED" } })).status, 200, "another admin remains (the Super Admin)");
    assert.equal((await api("/employees", { cookie: a.cookie })).status, 401, "disabled: signed out");
  });
});
