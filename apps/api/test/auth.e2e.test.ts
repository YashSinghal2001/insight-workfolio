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
const { hashPassword, verifyPassword } = await import("../dist/auth/crypto.js");

const ORIGIN = "http://localhost:3000";
const ADMIN = { email: "admin@example.com", password: "admin password 123" };
const PASSWORD = "employee password 1";

let app: INestApplication;
let base: string;

type Opts = { method?: string; body?: unknown; cookie?: string; bearer?: string; origin?: string | null };
async function api(path: string, { method = "GET", body, cookie, bearer, origin = ORIGIN }: Opts = {}) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (origin) headers.origin = origin;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text, res };
}

const cookiesOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

async function webLogin(email = ADMIN.email, password = ADMIN.password) {
  const r = await api("/auth/login", { method: "POST", body: { email, password } });
  assert.equal(r.status, 200, r.text);
  return cookiesOf(r.res);
}

async function desktopLogin(email: string, password = PASSWORD) {
  const r = await api("/auth/login", { method: "POST", body: { email, password, client: "desktop" }, origin: "tauri://localhost" });
  assert.equal(r.status, 200, r.text);
  return r.body as { accessToken: string; refreshToken: string; user: { id: string } };
}

/** Creates an employee as admin and completes password setup through the public endpoint. */
async function createEmployee(admin: string, email: string, code: string, fullName = "Test Person") {
  const r = await api("/employees", { method: "POST", cookie: admin, body: { email, employeeCode: code, fullName } });
  assert.equal(r.status, 201, r.text);
  const setup = await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  assert.equal(setup.status, 204, setup.text);
  return r.body.employee as { id: string; userId: string };
}

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  await app.get(DATABASE).execute({
    sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, ?, 'ADMIN', ?)",
    args: [randomUUID(), ADMIN.email, await hashPassword(ADMIN.password)],
  });
});
after(() => app.close());

test("password hashing: Argon2id PHC format, salted, verifies only the right password", async () => {
  const a = await hashPassword("correct horse battery");
  const b = await hashPassword("correct horse battery");
  assert.match(a, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.notEqual(a, b, "unique salt per hash");
  assert.equal(await verifyPassword("correct horse battery", a), true);
  assert.equal(await verifyPassword("wrong horse battery", a), false);
  assert.equal(await verifyPassword("x", "not-a-hash"), false);
});

describe("login", () => {
  test("web login sets HttpOnly SameSite=Strict cookies and returns no tokens in the body", async () => {
    const r = await api("/auth/login", { method: "POST", body: ADMIN });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body), ["user"]);
    assert.equal(r.body.user.role, "ADMIN");
    const cookies = r.res.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    for (const c of cookies) {
      assert.match(c, /HttpOnly/i);
      assert.match(c, /SameSite=Strict/i);
    }
    assert.ok(cookies.some((c) => c.startsWith("wf_refresh=") && c.includes("Path=/api/v1/auth")));
    const me = await api("/auth/me", { cookie: cookiesOf(r.res) });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, ADMIN.email);
    assert.equal(me.body.employee, null);
  });

  test("email is normalized before lookup", async () => {
    await webLogin("  ADMIN@Example.com ", ADMIN.password);
  });

  test("wrong password and unknown email return the same generic 401", async () => {
    const wrong = await api("/auth/login", { method: "POST", body: { email: ADMIN.email, password: "nope nope nope" } });
    const unknown = await api("/auth/login", { method: "POST", body: { email: "ghost@example.com", password: "nope nope nope" } });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.body.message, unknown.body.message);
    assert.equal(wrong.body.message, "Invalid email or password");
  });

  test("login is rate limited per email", async () => {
    const body = { email: "target@example.com", password: "guess guess guess" };
    for (let i = 0; i < 10; i++) assert.equal((await api("/auth/login", { method: "POST", body })).status, 401);
    assert.equal((await api("/auth/login", { method: "POST", body })).status, 429);
  });

  test("request bodies are validated", async () => {
    assert.equal((await api("/auth/login", { method: "POST", body: { email: "x" } })).status, 400);
    assert.equal((await api("/auth/login", { method: "POST", body: { ...ADMIN, client: "cli" } })).status, 400);
  });
});

describe("account setup", () => {
  test("new employees cannot log in until they set a password; setup links are single-use", async () => {
    const admin = await webLogin();
    const r = await api("/employees", {
      method: "POST",
      cookie: admin,
      body: { email: "setup@example.com", employeeCode: "SET-1", fullName: "Setup Person" },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.employee.passwordSet, false);
    assert.equal((await api("/auth/login", { method: "POST", body: { email: "setup@example.com", password: PASSWORD } })).status, 401);

    const weak = await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: "short" } });
    assert.equal(weak.status, 400);
    const ok = await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
    assert.equal(ok.status, 204);
    const again = await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
    assert.equal(again.status, 400, "token is single-use");
    await desktopLogin("setup@example.com");
  });
});

describe("employee management (admin)", () => {
  test("create returns no secrets and rejects duplicate email and employee code", async () => {
    const admin = await webLogin();
    const r = await api("/employees", {
      method: "POST",
      cookie: admin,
      body: { email: "Dup@Example.com", employeeCode: "dup-1", fullName: "Dup One" },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.employee.email, "dup@example.com");
    assert.equal(r.body.employee.employeeCode, "DUP-1");
    assert.equal(r.body.employee.timezone, "Asia/Kolkata");
    assert.ok(!/password_hash|passwordHash|argon2/.test(r.text));

    const dupEmail = await api("/employees", {
      method: "POST",
      cookie: admin,
      body: { email: "DUP@example.com", employeeCode: "DUP-2", fullName: "Dup Two" },
    });
    assert.equal(dupEmail.status, 409);
    assert.match(dupEmail.body.message, /Email/);
    const dupCode = await api("/employees", {
      method: "POST",
      cookie: admin,
      body: { email: "dup2@example.com", employeeCode: "DUP-1", fullName: "Dup Two" },
    });
    assert.equal(dupCode.status, 409);
    assert.match(dupCode.body.message, /Employee code/);
  });

  test("input validation on create, update, ids and pagination", async () => {
    const admin = await webLogin();
    const bad = await api("/employees", { method: "POST", cookie: admin, body: { email: "nope", employeeCode: "!", timezone: "Mars/X" } });
    assert.equal(bad.status, 400);
    assert.ok(Array.isArray(bad.body.message) && bad.body.message.length >= 3);
    assert.equal((await api("/employees/not-a-uuid", { cookie: admin })).status, 400);
    assert.equal((await api(`/employees/${randomUUID()}`, { cookie: admin })).status, 404);
    assert.equal((await api("/employees?pageSize=1000", { cookie: admin })).status, 400);
    const emp = await createEmployee(admin, "val@example.com", "VAL-1");
    const patch = await api(`/employees/${emp.id}`, { method: "PATCH", cookie: admin, body: { role: "ADMIN" } });
    assert.equal(patch.status, 400, "role cannot be changed through employee update");
  });

  test("update details and employment status", async () => {
    const admin = await webLogin();
    const emp = await createEmployee(admin, "upd@example.com", "UPD-1");
    const r = await api(`/employees/${emp.id}`, {
      method: "PATCH",
      cookie: admin,
      body: { fullName: "Updated Name", timezone: "Europe/London", employmentStatus: "ON_LEAVE", email: "upd2@example.com" },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.fullName, "Updated Name");
    assert.equal(r.body.timezone, "Europe/London");
    assert.equal(r.body.employmentStatus, "ON_LEAVE");
    assert.equal(r.body.email, "upd2@example.com");
  });

  test("pagination and search by name, email and employee code", async () => {
    const admin = await webLogin();
    for (let i = 1; i <= 5; i++) {
      const r = await api("/employees", {
        method: "POST",
        cookie: admin,
        body: { email: `page${i}@search.test`, employeeCode: `PG-${i}`, fullName: `Pager ${i}` },
      });
      assert.equal(r.status, 201);
    }
    const p1 = await api("/employees?q=search.test&pageSize=2&page=1", { cookie: admin });
    const p3 = await api("/employees?q=search.test&pageSize=2&page=3", { cookie: admin });
    assert.equal(p1.body.total, 5);
    assert.deepEqual(p1.body.items.map((e: { fullName: string }) => e.fullName), ["Pager 1", "Pager 2"]);
    assert.deepEqual(p3.body.items.map((e: { fullName: string }) => e.fullName), ["Pager 5"]);
    assert.equal((await api("/employees?q=pager%203", { cookie: admin })).body.total, 1, "by name, case-insensitive");
    assert.equal((await api("/employees?q=pg-4", { cookie: admin })).body.items[0].employeeCode, "PG-4");
    assert.equal((await api("/employees?q=%25", { cookie: admin })).body.total, 0, "LIKE wildcards are escaped");
  });
});

describe("RBAC and employee isolation", () => {
  test("unauthenticated requests are rejected", async () => {
    assert.equal((await api("/employees")).status, 401);
    assert.equal((await api("/auth/me")).status, 401);
    assert.equal((await api("/auth/me", { bearer: "garbage.token.value" })).status, 401);
    assert.equal((await api("/health")).status, 200, "health stays public");
  });

  test("employees cannot reach admin endpoints or other employees' records", async () => {
    const admin = await webLogin();
    const alice = await createEmployee(admin, "alice@example.com", "ALC-1", "Alice");
    const bob = await createEmployee(admin, "bob@example.com", "BOB-1", "Bob");
    await app.get(DATABASE).execute({
      sql: "INSERT INTO devices (id, employee_id, device_name, platform, device_identifier) VALUES (?, ?, 'Bob Mac', 'macos', 'hmac')",
      args: [randomUUID(), bob.id],
    });
    const { accessToken } = await desktopLogin("alice@example.com");
    const as = (path: string, o: Opts = {}) => api(path, { bearer: accessToken, ...o });

    assert.equal((await as("/employees")).status, 403);
    assert.equal((await as("/employees", { method: "POST", body: { email: "x@y.z", employeeCode: "XX-1", fullName: "X" } })).status, 403);
    assert.equal((await as(`/employees/${alice.id}`, { method: "PATCH", body: { fullName: "Hacked" } })).status, 403);
    assert.equal((await as(`/employees/${bob.id}/status`, { method: "PATCH", body: { status: "DISABLED" } })).status, 403);

    const own = await as(`/employees/${alice.id}`);
    assert.equal(own.status, 200);
    assert.equal(own.body.fullName, "Alice");
    assert.equal((await as(`/employees/${alice.id}/devices`)).status, 200);

    // Guessed IDs: another employee's record looks exactly like a missing one.
    const other = await as(`/employees/${bob.id}`);
    assert.equal(other.status, 404);
    assert.deepEqual(other.body.message, (await as(`/employees/${randomUUID()}`)).body.message);
    assert.equal((await as(`/employees/${bob.id}/devices`)).status, 404);

    const me = await as("/auth/me");
    assert.equal(me.body.employee.id, alice.id);

    const devices = await api(`/employees/${bob.id}/devices`, { cookie: admin });
    assert.equal(devices.status, 200);
    assert.equal(devices.body[0].deviceName, "Bob Mac");
    assert.ok(!("deviceIdentifier" in devices.body[0]), "device identifier stays server-side");
  });

  test("cookie-authenticated writes from a foreign or missing origin are rejected (CSRF)", async () => {
    const admin = await webLogin();
    const body = { email: "csrf@example.com", employeeCode: "CSRF-1", fullName: "C" };
    assert.equal((await api("/employees", { method: "POST", cookie: admin, body, origin: "https://evil.example" })).status, 403);
    assert.equal((await api("/employees", { method: "POST", cookie: admin, body, origin: null })).status, 403);
  });
});

describe("sessions", () => {
  test("refresh rotates the token; replaying the old one revokes the session", async () => {
    const admin = await webLogin();
    await createEmployee(admin, "rot@example.com", "ROT-1");
    const first = await desktopLogin("rot@example.com");

    const second = await api("/auth/refresh", { method: "POST", body: { refreshToken: first.refreshToken } });
    assert.equal(second.status, 200);
    assert.notEqual(second.body.refreshToken, first.refreshToken);
    assert.equal((await api("/auth/me", { bearer: second.body.accessToken })).status, 200);

    const replay = await api("/auth/refresh", { method: "POST", body: { refreshToken: first.refreshToken } });
    assert.equal(replay.status, 401);
    const afterTheft = await api("/auth/refresh", { method: "POST", body: { refreshToken: second.body.refreshToken } });
    assert.equal(afterTheft.status, 401, "whole session revoked after reuse");
    assert.equal((await api("/auth/me", { bearer: second.body.accessToken })).status, 401);
  });

  test("web refresh uses and rotates the cookie", async () => {
    const cookie = await webLogin();
    const r = await api("/auth/refresh", { method: "POST", cookie });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body), ["user"]);
    assert.notEqual(cookiesOf(r.res), cookie);
  });

  test("logout revokes the session server-side", async () => {
    const admin = await webLogin();
    await createEmployee(admin, "out@example.com", "OUT-1");
    const s = await desktopLogin("out@example.com");
    assert.equal((await api("/auth/logout", { method: "POST", body: { refreshToken: s.refreshToken }, origin: "tauri://localhost" })).status, 204);
    assert.equal((await api("/auth/me", { bearer: s.accessToken })).status, 401, "access token dies with its session");
    assert.equal((await api("/auth/refresh", { method: "POST", body: { refreshToken: s.refreshToken } })).status, 401);

    const web = await webLogin();
    const out = await api("/auth/logout", { method: "POST", cookie: web });
    assert.equal(out.status, 204);
    assert.ok(out.res.headers.getSetCookie().every((c) => /Expires=Thu, 01 Jan 1970/.test(c)), "cookies cleared");
    assert.equal((await api("/auth/me", { cookie: web })).status, 401);
  });

  test("disabling an account rejects login, refresh and live sessions; re-enabling restores login", async () => {
    const admin = await webLogin();
    const emp = await createEmployee(admin, "dis@example.com", "DIS-1");
    const s = await desktopLogin("dis@example.com");

    const off = await api(`/employees/${emp.id}/status`, { method: "PATCH", cookie: admin, body: { status: "DISABLED" } });
    assert.equal(off.status, 200);
    assert.equal(off.body.accountStatus, "DISABLED");
    assert.equal((await api("/auth/me", { bearer: s.accessToken })).status, 401);
    assert.equal((await api("/auth/refresh", { method: "POST", body: { refreshToken: s.refreshToken } })).status, 401);
    const login = await api("/auth/login", { method: "POST", body: { email: "dis@example.com", password: PASSWORD } });
    assert.equal(login.status, 401);
    assert.equal(login.body.message, "Invalid email or password", "no hint that the account is disabled");

    assert.equal((await api(`/employees/${emp.id}/status`, { method: "PATCH", cookie: admin, body: { status: "ACTIVE" } })).status, 200);
    await desktopLogin("dis@example.com");
  });
});
