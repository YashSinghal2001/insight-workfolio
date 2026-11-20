// GET /employees filters (W2-SETTINGS): teamId, role (identity), platform, appVersion, and the additive list
// columns (platformRole, teams, platforms, appVersion). In-process API, in-memory DB, synthetic people.
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
let head: Emp, mac: Emp, win: Emp, both: Emp, boss: Emp, it: Emp;
let alpha: string, beta: string, gamma: string;

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

/** A device; with `version`, its update status row (checkedAgo minutes ago). */
async function device(emp: Emp, platform: "macos" | "windows", version?: string, opts: { revoked?: boolean; checkedAgo?: number } = {}) {
  const id = randomUUID();
  await db.execute({
    sql: "INSERT INTO devices (id, employee_id, device_name, platform, device_identifier, revoked_at) VALUES (?, ?, 'PC', ?, ?, ?)",
    args: [id, emp.id, platform, randomUUID(), opts.revoked ? new Date().toISOString() : null],
  });
  if (version) {
    await db.execute({
      sql: "INSERT INTO desktop_update_status (device_id, installed_version, state, last_check_at) VALUES (?, ?, 'UP_TO_DATE', ?)",
      args: [id, version, new Date(Date.now() - (opts.checkedAgo ?? 0) * 60_000).toISOString()],
    });
  }
}

const list = async (query: string, auth: { cookie?: string; bearer?: string } = { cookie: admin }) => {
  const r = await api(`/employees?pageSize=100${query}`, auth);
  return { ...r, codes: r.status === 200 ? (r.body.items as { employeeCode: string }[]).map((e) => e.employeeCode).sort() : [] };
};

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [randomUUID(), await hashPassword(PASSWORD)] });
  const login = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email: "admin@example.com", password: PASSWORD }) });
  admin = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

  head = await employee("HEAD");
  mac = await employee("MAC");
  win = await employee("WIN");
  both = await employee("BOTH");
  boss = await employee("BOSS");
  it = await employee("IT");
  await db.execute({ sql: "UPDATE users SET role = 'ADMIN', admin_title = 'SUPER_ADMIN' WHERE id = ?", args: [boss.userId] });
  await db.execute({ sql: "UPDATE users SET role = 'ADMIN' WHERE id = ?", args: [it.userId] });

  await device(mac, "macos", "0.3.0");
  await device(win, "windows", "0.2.1");
  await device(both, "macos", "0.2.1", { checkedAgo: 60 });
  await device(both, "windows", "0.3.0", { checkedAgo: 5 });
  await device(head, "windows", "0.1.0", { revoked: true }); // revoked: counts for nothing

  alpha = (await api("/teams", { method: "POST", cookie: admin, body: { name: "Alpha", headUserId: head.userId } })).body.id;
  beta = (await api("/teams", { method: "POST", cookie: admin, body: { name: "Beta" } })).body.id;
  gamma = (await api("/teams", { method: "POST", cookie: admin, body: { name: "Gamma" } })).body.id;
  assert.equal((await api(`/teams/${alpha}/members`, { method: "PUT", cookie: admin, body: { employeeIds: [head.id, mac.id, both.id] } })).status, 200);
  assert.equal((await api(`/teams/${beta}/members`, { method: "PUT", cookie: admin, body: { employeeIds: [win.id, both.id] } })).status, 200);
  assert.equal((await api(`/teams/${gamma}/members`, { method: "PUT", cookie: admin, body: { employeeIds: [win.id] } })).status, 200);
  assert.equal((await api(`/teams/${gamma}`, { method: "PATCH", cookie: admin, body: { active: false } })).status, 200);
});
after(() => app.close());

test("no filter: everyone, with the additive columns", async () => {
  const r = await list("");
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.codes, ["BOSS", "BOTH", "HEAD", "IT", "MAC", "WIN"]);
  const by = Object.fromEntries((r.body.items as { employeeCode: string }[]).map((e) => [e.employeeCode, e])) as Record<string, Record<string, unknown>>;
  assert.equal(by.BOSS!.platformRole, "SUPER_ADMIN");
  assert.equal(by.IT!.platformRole, "ADMIN");
  assert.equal(by.MAC!.platformRole, "EMPLOYEE");
  assert.deepEqual(by.BOTH!.teams, [{ id: alpha, name: "Alpha" }, { id: beta, name: "Beta" }]);
  assert.deepEqual(by.WIN!.teams, [{ id: beta, name: "Beta" }], "inactive team Gamma not listed");
  assert.deepEqual(by.BOTH!.platforms, ["macos", "windows"]);
  assert.equal(by.BOTH!.appVersion, "0.3.0", "latest check wins");
  assert.deepEqual(by.HEAD!.platforms, [], "revoked device ignored");
  assert.equal(by.HEAD!.appVersion, null);
  assert.equal(by.BOSS!.appVersion, null);
  // The single-employee read carries the same fields.
  const one = await api(`/employees/${both.id}`, { cookie: admin });
  assert.equal(one.body.appVersion, "0.3.0");
  assert.equal(one.body.teams.length, 2);
});

test("each filter alone", async () => {
  assert.deepEqual((await list(`&teamId=${alpha}`)).codes, ["BOTH", "HEAD", "MAC"]);
  assert.deepEqual((await list(`&teamId=${beta}`)).codes, ["BOTH", "WIN"]);
  assert.deepEqual((await list(`&teamId=${gamma}`)).codes, [], "inactive team: no active members");
  assert.deepEqual((await list("&role=SUPER_ADMIN")).codes, ["BOSS"]);
  assert.deepEqual((await list("&role=ADMIN")).codes, ["IT"]);
  assert.deepEqual((await list("&role=EMPLOYEE")).codes, ["BOTH", "HEAD", "MAC", "WIN"]);
  assert.deepEqual((await list("&platform=macos")).codes, ["BOTH", "MAC"]);
  assert.deepEqual((await list("&platform=windows")).codes, ["BOTH", "WIN"], "HEAD's revoked Windows device does not count");
  // BOTH has 0.2.1 (checked an hour ago) and 0.3.0 (5 min ago): it matches only the shown, latest version.
  assert.deepEqual((await list("&appVersion=0.2.1")).codes, ["WIN"]);
  assert.deepEqual((await list("&appVersion=0.3.0")).codes, ["BOTH", "MAC"]);
  assert.deepEqual((await list("&appVersion=0.1.0")).codes, [], "revoked device's version does not count");
});

test("combinations AND together, with search and pagination totals", async () => {
  assert.deepEqual((await list(`&teamId=${alpha}&platform=windows`)).codes, ["BOTH"]);
  assert.deepEqual((await list(`&teamId=${beta}&appVersion=0.3.0`)).codes, ["BOTH"]);
  assert.deepEqual((await list(`&teamId=${beta}&appVersion=0.2.1`)).codes, ["WIN"]);
  assert.deepEqual((await list("&platform=macos&appVersion=0.3.0&role=EMPLOYEE")).codes, ["BOTH", "MAC"]);
  assert.deepEqual((await list(`&q=win&teamId=${beta}`)).codes, ["WIN"]);
  assert.deepEqual((await list("&role=ADMIN&platform=macos")).codes, []);
  const paged = await api(`/employees?pageSize=1&page=2&teamId=${alpha}`, { cookie: admin });
  assert.equal(paged.body.total, 3);
  assert.equal(paged.body.items.length, 1);
});

test("team head: scope unchanged; own team filter ok; other or unknown team → 404", async () => {
  const self = { bearer: head.bearer };
  assert.deepEqual((await list("", self)).codes, ["BOTH", "HEAD", "MAC"]);
  assert.deepEqual((await list(`&teamId=${alpha}&platform=windows`, self)).codes, ["BOTH"]);
  assert.deepEqual((await list("&platform=windows", self)).codes, ["BOTH"], "never beyond the head's scope");
  // BOTH is in Alpha (headed) and Beta: the head sees only Alpha, in the list and the single read; an admin sees both.
  const mine = (await list("", self)).body.items.find((e: { employeeCode: string }) => e.employeeCode === "BOTH");
  assert.deepEqual(mine.teams, [{ id: alpha, name: "Alpha" }]);
  assert.deepEqual((await api(`/employees/${both.id}`, self)).body.teams, [{ id: alpha, name: "Alpha" }]);
  assert.equal((await api(`/employees/${both.id}`, { cookie: admin })).body.teams.length, 2);
  assert.doesNotMatch((await api("/employees?pageSize=100", self)).text, new RegExp(beta), "no other team id leaks");
  assert.equal((await list(`&teamId=${beta}`, self)).status, 404);
  assert.equal((await list(`&teamId=${randomUUID()}`, self)).status, 404);
  assert.equal((await list(`&teamId=${randomUUID()}`)).status, 404, "admin + unknown team");
});

test("plain employee → 403; validation → 400", async () => {
  assert.equal((await list("", { bearer: mac.bearer })).status, 403);
  for (const bad of ["&teamId=nope", "&role=OWNER", "&role=admin", "&platform=linux", "&appVersion=1.2", "&appVersion=v1.2.3"]) {
    assert.equal((await list(bad)).status, 400, bad);
  }
});
