// Account lifecycle (in-process API, in-memory DB; example.com test accounts only): provisioning through
// one-time setup links, the account audit written in the same transaction as each change, and the role
// safeguards (never zero active administrators or Super Admins, also under concurrent requests).
import "reflect-metadata";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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
const { hashPassword, sha256, verifyPassword } = await import("../dist/auth/crypto.js");
const { AuthService } = await import("../dist/auth/auth.service.js");
const { EmployeesService } = await import("../dist/employees/employees.service.js");
const { RolesService } = await import("../dist/roles/roles.service.js");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "lifecycle password 1";
const H = 60 * 60 * 1000;
let app: INestApplication;
let base: string;
type Rows = { rows: Record<string, unknown>[] };
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<Rows> };

type Opts = { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> };
async function api(path: string, { method = "GET", body, cookie, headers = {} }: Opts = {}) {
  const h: Record<string, string> = { origin: ORIGIN, ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  if (cookie) h.cookie = cookie;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text, res };
}
const cookiesOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const login = (email: string, password = PASSWORD) => api("/auth/login", { method: "POST", body: { email, password } });
async function signIn(email: string, password = PASSWORD) {
  const r = await login(email, password);
  assert.equal(r.status, 200, `${email}: ${r.text}`);
  return cookiesOf(r.res);
}
const setPassword = (token: string, password = PASSWORD) => api("/auth/setup-password", { method: "POST", body: { token, password } });

let n = 0;
/** A signed-in user created directly (no setup link); employees and optionally admins get a profile. */
async function user(title: "SUPER_ADMIN" | "ADMIN" | "EMPLOYEE", withProfile = title === "EMPLOYEE") {
  const id = randomUUID();
  const email = `lc${++n}@example.com`;
  await db.execute({ sql: "INSERT INTO users (id, email, role, admin_title, password_hash) VALUES (?, ?, ?, ?, ?)", args: [id, email, title === "EMPLOYEE" ? "EMPLOYEE" : "ADMIN", title === "EMPLOYEE" ? null : title, await hashPassword(PASSWORD)] });
  let employeeId: string | null = null;
  if (withProfile) {
    employeeId = randomUUID();
    await db.execute({ sql: "INSERT INTO employee_profiles (id, user_id, employee_code, full_name, timezone) VALUES (?, ?, ?, ?, 'UTC')", args: [employeeId, id, `LC-${n}`, `Lifecycle ${n}`] });
  }
  return { id, email, employeeId, cookie: await signIn(email) };
}
type Audit = { action: string; actor_user_id: string | null; target_user_id: string | null; resource_type: string; resource_id: string | null; metadata: string };
const auditOf = async (userId: string): Promise<Audit[]> =>
  (await db.execute({ sql: "SELECT * FROM account_audit WHERE target_user_id = ? ORDER BY rowid", args: [userId] })).rows as unknown as Audit[];
const actions = async (userId: string) => (await auditOf(userId)).map((a) => a.action);
const count = async (sql: string) => Number((await db.execute(sql)).rows[0]!.n);
const activeAdmins = () => count("SELECT count(*) AS n FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE'");
const activeSupers = () => count("SELECT count(*) AS n FROM users WHERE role = 'ADMIN' AND admin_title = 'SUPER_ADMIN' AND status = 'ACTIVE'");
const setStatus = (who: { cookie: string }, employeeId: string, status: "ACTIVE" | "DISABLED") => api(`/employees/${employeeId}/status`, { method: "PATCH", cookie: who.cookie, body: { status } });
const changeRole = (who: { cookie: string }, id: string, platformRole: string) => api(`/roles/users/${id}`, { method: "PATCH", cookie: who.cookie, body: { platformRole, reason: "lifecycle test" } });

let admin: Awaited<ReturnType<typeof user>>;
async function createEmployee(code = `NEW-${++n}`) {
  const r = await api("/employees", { method: "POST", cookie: admin.cookie, body: { email: `new${n}@example.com`, employeeCode: code, fullName: "New Person", timezone: "UTC" } });
  assert.equal(r.status, 201, r.text);
  return r.body as { employee: { id: string; userId: string; email: string; passwordSet: boolean }; setup: { token: string; expiresAt: string } };
}

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  // Every request here comes from 127.0.0.1; the per-IP limits are covered in auth.e2e.test.ts.
  const auth = app.get(AuthService);
  auth.loginByIp.hit = () => true;
  auth.setupByIp.hit = () => true;
  admin = await user("SUPER_ADMIN");
});
after(() => app.close());

describe("provisioning", () => {
  test("create: no password, random 256-bit setup token stored only as sha256, 72 h expiry, audited atomically", async () => {
    const t0 = Date.now();
    const [a, b] = [await createEmployee(), await createEmployee()];
    assert.equal(a.employee.passwordSet, false);
    assert.equal((await db.execute({ sql: "SELECT password_hash FROM users WHERE id = ?", args: [a.employee.userId] })).rows[0]!.password_hash, null, "no default password");
    assert.match(a.setup.token, /^[\w-]{43}$/, "32 random bytes, base64url");
    assert.notEqual(a.setup.token, b.setup.token);
    const rows = (await db.execute({ sql: "SELECT * FROM account_setup_tokens WHERE user_id = ?", args: [a.employee.userId] })).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.token_hash, sha256(a.setup.token));
    assert.ok(!JSON.stringify(rows).includes(a.setup.token), "plaintext token not stored");
    const ttl = Date.parse(a.setup.expiresAt) - t0;
    assert.ok(ttl > 72 * H - 60_000 && ttl <= 72 * H + 60_000, `expires in ${ttl / H} h`);
    assert.equal(rows[0]!.expires_at, a.setup.expiresAt);

    const audit = await auditOf(a.employee.userId);
    assert.deepEqual(audit.map((r) => [r.action, r.actor_user_id, r.resource_type]), [["ACCOUNT_CREATED", admin.id, "ACCOUNT"], ["SETUP_LINK_ISSUED", admin.id, "SETUP_LINK"]]);
    assert.deepEqual(JSON.parse(audit[0]!.metadata), { employeeId: a.employee.id });
    assert.equal(audit[1]!.resource_id, rows[0]!.id, "the link row, not the token");
    const all = JSON.stringify(audit);
    for (const secret of [a.employee.email, a.setup.token, String(rows[0]!.token_hash)]) assert.ok(!all.includes(secret), "no email, token or hash in the audit");
  });

  test("a failed create writes nothing (no account, no link, no audit)", async () => {
    const before = await count("SELECT count(*) AS n FROM account_audit");
    const r = await api("/employees", { method: "POST", cookie: admin.cookie, body: { email: admin.email, employeeCode: "DUP-1", fullName: "Dup", timezone: "UTC" } });
    assert.equal(r.status, 409);
    assert.equal(await count("SELECT count(*) AS n FROM account_audit"), before);
  });

  test("link is single-use, expires, and a reissue invalidates the previous one (audited)", async () => {
    const { employee, setup } = await createEmployee();
    const re = await api(`/employees/${employee.id}/setup-token`, { method: "POST", cookie: admin.cookie });
    assert.equal(re.status, 201, re.text);
    assert.deepEqual(Object.keys(re.body).sort(), ["expiresAt", "token"]);
    assert.equal((await setPassword(setup.token)).status, 400, "the old link is dead");
    assert.equal((await setPassword(re.body.token)).status, 204);
    assert.equal((await setPassword(re.body.token, "another password 2")).status, 400, "single use");
    assert.deepEqual((await actions(employee.userId)).filter((a) => a === "SETUP_LINK_ISSUED").length, 2);

    const expired = await createEmployee();
    await db.execute({ sql: "UPDATE account_setup_tokens SET expires_at = ? WHERE user_id = ?", args: [new Date(Date.now() - 1000).toISOString(), expired.employee.userId] });
    assert.equal((await setPassword(expired.setup.token)).status, 400, "expired");
    assert.equal((await login(expired.employee.email, PASSWORD)).status, 401);
  });

  test("password is stored as Argon2id; setting it again via a new link revokes existing sessions", async () => {
    const { employee, setup } = await createEmployee();
    assert.equal((await setPassword(setup.token)).status, 204);
    const hash = String((await db.execute({ sql: "SELECT password_hash FROM users WHERE id = ?", args: [employee.userId] })).rows[0]!.password_hash);
    assert.match(hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    assert.ok(await verifyPassword(PASSWORD, hash));
    const r = await login(employee.email);
    const cookie = cookiesOf(r.res);
    assert.equal((await api("/auth/me", { cookie })).status, 200);
    const re = await api(`/employees/${employee.id}/setup-token`, { method: "POST", cookie: admin.cookie });
    assert.equal((await api("/auth/me", { cookie })).status, 200, "issuing a link alone signs nobody out");
    assert.equal((await setPassword(re.body.token, "brand new password 3")).status, 204);
    assert.equal((await api("/auth/me", { cookie })).status, 401, "old session revoked");
    assert.equal((await api("/auth/refresh", { method: "POST", cookie })).status, 401, "old refresh token revoked");
    assert.equal((await login(employee.email)).status, 401, "old password no longer works");
    assert.equal((await login(employee.email, "brand new password 3")).status, 200);
  });

  test("disable: sign-in, refresh and live sessions stop, audited with the sessions revoked; enable restores sign-in", async () => {
    const e = await user("EMPLOYEE");
    const second = await signIn(e.email);
    const r = await setStatus(admin, e.employeeId!, "DISABLED");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.accountStatus, "DISABLED");
    for (const cookie of [e.cookie, second]) {
      assert.equal((await api("/auth/me", { cookie })).status, 401);
      assert.equal((await api("/auth/refresh", { method: "POST", cookie })).status, 401);
    }
    assert.equal((await login(e.email)).status, 401);
    assert.equal((await setStatus(admin, e.employeeId!, "DISABLED")).status, 200, "idempotent");
    assert.equal((await setStatus(admin, e.employeeId!, "ACTIVE")).body.accountStatus, "ACTIVE");
    assert.equal((await setStatus(admin, e.employeeId!, "ACTIVE")).status, 200);
    assert.equal((await login(e.email)).status, 200, "re-enabled");
    const audit = await auditOf(e.id);
    assert.deepEqual(audit.map((a) => [a.action, a.actor_user_id]), [["ACCOUNT_DISABLED", admin.id], ["ACCOUNT_ENABLED", admin.id]], "no-ops are not audited");
    assert.deepEqual(JSON.parse(audit[0]!.metadata), { employeeId: e.employeeId, sessionsRevoked: 2 });
  });

  test("update: audit names the changed fields only, never values; a no-op writes nothing", async () => {
    const e = await user("EMPLOYEE");
    const r = await api(`/employees/${e.employeeId}`, { method: "PATCH", cookie: admin.cookie, body: { fullName: "Renamed Person", timezone: "Asia/Kolkata", employeeCode: `LC-${n}` } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.fullName, "Renamed Person");
    const same = await api(`/employees/${e.employeeId}`, { method: "PATCH", cookie: admin.cookie, body: { fullName: "Renamed Person" } });
    assert.equal(same.status, 200);
    await api(`/employees/${e.employeeId}`, { method: "PATCH", cookie: admin.cookie, body: { email: `renamed${n}@example.com` } });
    const audit = await auditOf(e.id);
    assert.deepEqual(audit.map((a) => [a.action, a.actor_user_id, JSON.parse(a.metadata).fields]), [["ACCOUNT_UPDATED", admin.id, "fullName,timezone"], ["ACCOUNT_UPDATED", admin.id, "email"]]);
    assert.ok(!JSON.stringify(audit).includes("Renamed") && !JSON.stringify(audit).includes("Kolkata") && !JSON.stringify(audit).includes("renamed"));
  });

  test("no default or hard-coded password anywhere in the API source", async () => {
    const files: string[] = [];
    const walk = async (dir: string) => {
      for (const d of await readdir(dir, { withFileTypes: true })) {
        if (d.isDirectory()) await walk(join(dir, d.name));
        else files.push(join(dir, d.name));
      }
    };
    await walk(new URL("../src", import.meta.url).pathname);
    for (const f of files) {
      const src = await readFile(f, "utf8");
      assert.doesNotMatch(src, /(default|initial|temp(orary)?)[_ ]?password\s*[:=]/i, f);
      assert.doesNotMatch(src, /password(_hash)?\s*[:=]\s*["'`][^"'`$]{4,}["'`]/i, `${f}: password literal`);
    }
  });

  test("admin:create CLI: no password, setup link only, ACCOUNT_CREATED + SETUP_LINK_ISSUED with actor = server", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wf-cli-"));
    try {
      const url = `file:${join(dir, "cli.db")}`;
      const cli = (...args: string[]) =>
        promisify(execFile)(process.execPath, [new URL("../dist/cli/create-admin.js", import.meta.url).pathname, ...args], {
          cwd: dir, // no .env picked up
          env: { PATH: process.env.PATH, NODE_ENV: "test", DATABASE_URL: url, DASHBOARD_URL: "http://localhost:3000" },
        }).then((r) => ({ code: 0, out: r.stdout }), (e: { code: number; stdout: string }) => ({ code: e.code, out: e.stdout }));
      const first = await cli("--email", "ceo-placeholder@example.com", "--super-admin");
      assert.equal(first.code, 0, first.out);
      const token = /#token=([\w-]+)/.exec(first.out)?.[1];
      assert.ok(token, "prints a one-time link with the token in the fragment");
      assert.equal((await cli("--email", "it-placeholder@example.com")).code, 1, "a second admin needs --additional");
      assert.equal((await cli("--email", "it-placeholder@example.com", "--additional")).code, 0);
      assert.equal((await cli("--email", "ceo-placeholder@example.com")).code, 0, "not set up yet: a fresh link");

      const { createDatabase } = await import("@workfolio/database");
      const cdb = createDatabase({ url });
      try {
        const users = (await cdb.execute("SELECT id, email, admin_title, password_hash FROM users ORDER BY email")).rows;
        assert.deepEqual(users.map((u) => [u.email, u.admin_title, u.password_hash]), [["ceo-placeholder@example.com", "SUPER_ADMIN", null], ["it-placeholder@example.com", "ADMIN", null]]);
        const audit = (await cdb.execute("SELECT a.action, a.actor_user_id, a.metadata, u.email FROM account_audit a JOIN users u ON u.id = a.target_user_id ORDER BY a.rowid")).rows;
        assert.deepEqual(audit.map((a) => [a.email, a.action, a.actor_user_id]), [
          ["ceo-placeholder@example.com", "ACCOUNT_CREATED", null],
          ["ceo-placeholder@example.com", "SETUP_LINK_ISSUED", null],
          ["it-placeholder@example.com", "ACCOUNT_CREATED", null],
          ["it-placeholder@example.com", "SETUP_LINK_ISSUED", null],
          ["ceo-placeholder@example.com", "SETUP_LINK_ISSUED", null],
        ]);
        assert.deepEqual(JSON.parse(String(audit[0]!.metadata)), { via: "cli", identity: "SUPER_ADMIN" });
        assert.deepEqual(JSON.parse(String(audit[2]!.metadata)), { via: "cli", identity: "ADMIN" });
        const links = (await cdb.execute({ sql: "SELECT token_hash, used_at FROM account_setup_tokens WHERE user_id = ? ORDER BY created_at, rowid", args: [users[0]!.id] })).rows;
        assert.equal(links.length, 2);
        assert.equal(links[0]!.token_hash, sha256(token!));
        assert.notEqual(links[0]!.used_at, null, "the rerun invalidated the first link");
      } finally {
        cdb.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("roles and safeguards", () => {
  test("an Admin cannot grant or remove Super Admin; nobody changes their own role; role changes stay out of account_audit", async () => {
    const [s, a, e] = [await user("SUPER_ADMIN"), await user("ADMIN"), await user("EMPLOYEE")];
    assert.equal((await changeRole(a, e.id, "SUPER_ADMIN")).status, 403);
    assert.equal((await changeRole(a, s.id, "ADMIN")).status, 403);
    assert.equal((await changeRole(a, s.id, "EMPLOYEE")).status, 403);
    for (const who of [s, a]) for (const to of ["EMPLOYEE", "ADMIN", "SUPER_ADMIN"]) assert.ok([400, 403].includes((await changeRole(who, who.id, to)).status), `${to}`);
    assert.equal((await changeRole(e, e.id, "ADMIN")).status, 403);
    assert.equal((await changeRole(s, e.id, "ADMIN")).status, 200);
    assert.deepEqual(await actions(e.id), [], "recorded in role_changes, not duplicated into account_audit");
    assert.equal(await count(`SELECT count(*) AS n FROM role_changes WHERE target_user_id = '${e.id}'`), 1);
  });

  test("the last active Super Admin / administrator cannot be disabled through PATCH /employees/:id/status", async () => {
    await db.execute("UPDATE users SET status = 'DISABLED' WHERE role = 'ADMIN'");
    const [s, a] = [await user("SUPER_ADMIN", true), await user("ADMIN", true)];
    // An Admin may not manage a Super Admin account at all (security-hardening.e2e.test.ts); the
    // last-Super-Admin 409 itself is covered under races in the services test below.
    const r = await setStatus(a, s.employeeId!, "DISABLED");
    assert.equal(r.status, 403, r.text);
    assert.match(r.body.message, /Only a Super Admin can manage a Super Admin account/);
    assert.equal((await changeRole(a, s.id, "EMPLOYEE")).status, 403);
    assert.equal((await changeRole(s, a.id, "EMPLOYEE")).status, 200, "another administrator (s) remains");
    assert.equal((await setStatus(s, s.employeeId!, "DISABLED")).status, 400, "never yourself");
    assert.equal(await activeAdmins(), 1);
    assert.equal(await activeSupers(), 1);
    assert.deepEqual(await actions(s.id), [], "refused changes are not audited");
  });

  test("concurrent disables and demotions never leave zero active administrators or Super Admins", async () => {
    for (let round = 0; round < 6; round++) {
      await db.execute("UPDATE users SET status = 'DISABLED' WHERE role = 'ADMIN'");
      // Three administrators who all have employee profiles (so status changes and demotions both apply).
      const [x, y, z] = [await user("SUPER_ADMIN", true), await user(round % 2 ? "SUPER_ADMIN" : "ADMIN", true), await user("ADMIN", true)];
      const results = await Promise.all(
        round % 3 === 0
          ? [setStatus(x, y.employeeId!, "DISABLED"), setStatus(y, z.employeeId!, "DISABLED"), setStatus(z, x.employeeId!, "DISABLED")]
          : round % 3 === 1
            ? [setStatus(x, y.employeeId!, "DISABLED"), changeRole(y, z.id, "EMPLOYEE"), setStatus(z, x.employeeId!, "DISABLED"), changeRole(x, z.id, "EMPLOYEE")]
            : [changeRole(x, y.id, "EMPLOYEE"), setStatus(y, x.employeeId!, "DISABLED"), setStatus(z, y.employeeId!, "DISABLED"), setStatus(x, z.employeeId!, "DISABLED")],
      );
      for (const r of results) assert.ok([200, 401, 403, 409].includes(r.status), `round ${round}: ${r.status} ${r.text}`);
      assert.ok((await activeAdmins()) >= 1, `round ${round}: zero active administrators`);
      assert.ok((await activeSupers()) >= 1, `round ${round}: zero active Super Admins`);
      // Every successful disable has exactly one audit row; refused ones none.
      for (const who of [x, y, z]) {
        const disabled = (await db.execute({ sql: "SELECT status FROM users WHERE id = ?", args: [who.id] })).rows[0]!.status === "DISABLED";
        assert.equal((await actions(who.id)).filter((a) => a === "ACCOUNT_DISABLED").length, disabled ? 1 : 0, `round ${round}`);
      }
    }
  });

  test("concurrent disables/demotions in the services themselves (stale contexts, interleaved reads) stay guarded", async () => {
    // Over HTTP the requests above mostly complete one after another; here every call's reads interleave
    // before any write, so only the guard inside the write statement can stop the last admin going.
    const employees = app.get(EmployeesService);
    const roles = app.get(RolesService);
    const ctx = (u: { id: string; email: string }, platformRole: string) => ({ id: u.id, email: u.email, role: "ADMIN", platformRole, sessionId: "stale" });
    for (let round = 0; round < 6; round++) {
      await db.execute("UPDATE users SET status = 'DISABLED' WHERE role = 'ADMIN'");
      const [x, y] = [await user("SUPER_ADMIN", true), await user(round < 3 ? "SUPER_ADMIN" : "ADMIN", true)];
      const results = await Promise.allSettled(
        round % 2
          ? [employees.setAccountStatus(y.employeeId, "DISABLED", ctx(x, "SUPER_ADMIN")), roles.change(ctx(y, "SUPER_ADMIN"), x.id, "EMPLOYEE", "concurrent test")]
          : [employees.setAccountStatus(y.employeeId, "DISABLED", ctx(x, "SUPER_ADMIN")), employees.setAccountStatus(x.employeeId, "DISABLED", ctx(y, "SUPER_ADMIN"))],
      );
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, `round ${round}: ${JSON.stringify(results.map((r) => r.status === "rejected" ? String(r.reason) : "ok"))}`);
      for (const r of results) if (r.status === "rejected") assert.match(String(r.reason), /last active/);
      assert.equal(await activeAdmins(), 1, `round ${round}`);
      assert.equal(await activeSupers(), 1, `round ${round}`);
    }
  });

  test("spoofed role headers are ignored; employees cannot reach role or employee management", async () => {
    const e = await user("EMPLOYEE");
    const other = await user("EMPLOYEE");
    const spoof = { "x-role": "ADMIN", "x-platform-role": "SUPER_ADMIN", "x-user-id": admin.id, "x-forwarded-user": admin.email };
    const calls: [string, string, unknown?][] = [
      ["GET", "/roles/users"],
      ["GET", "/roles/history"],
      ["PATCH", `/roles/users/${other.id}`, { platformRole: "ADMIN", reason: "spoofed escalation" }],
      ["PATCH", `/roles/users/${e.id}`, { platformRole: "SUPER_ADMIN", reason: "spoofed escalation" }],
      ["GET", "/employees"],
      ["POST", "/employees", { email: "x@example.com", employeeCode: "X-1", fullName: "X", timezone: "UTC" }],
      ["PATCH", `/employees/${other.employeeId}`, { fullName: "Hacked" }],
      ["PATCH", `/employees/${other.employeeId}/status`, { status: "DISABLED" }],
      ["PATCH", `/employees/${e.employeeId}/status`, { status: "DISABLED" }],
      ["POST", `/employees/${other.employeeId}/setup-token`],
    ];
    for (const [method, path, body] of calls) {
      assert.equal((await api(path, { method, body, cookie: e.cookie, headers: spoof })).status, 403, `${method} ${path}`);
    }
    const me = (await api("/auth/me", { cookie: e.cookie, headers: spoof })).body.user;
    assert.deepEqual([me.id, me.role, me.platformRole], [e.id, "EMPLOYEE", "EMPLOYEE"]);
    assert.deepEqual([...(await actions(e.id)), ...(await actions(other.id))], []);
  });
});
