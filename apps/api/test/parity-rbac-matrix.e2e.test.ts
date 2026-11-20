// W4-SECURITY: one RBAC / scoping / privacy matrix over every read route added or changed in waves 1–3
// (docs/status/agent-plans/W4-SECURITY.md §1). Synthetic people; in-process API, in-memory DB.
// Per route: unauthenticated 401 · employee 403 · team head of A 200 without any team-B data · head ?teamId=A 200 ·
// head ?teamId=B 404 · admin 200 (team-B data present, so the leak check is live) · admin unknown team 404 · Super Admin 200.
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
const { addDays, localDate, zonedToUtc } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "matrix password 1";
const TZ = "UTC";
const D = localDate(Date.now(), TZ);
const FROM = addDays(D, -6);
const MONTH = D.slice(0, 7);
const iso = (ms: number) => new Date(ms).toISOString();
const at = (date: string, hm: string) => Date.parse(zonedToUtc(`${date}T${hm}`, TZ));
/** Things no response or export may ever contain. */
const LEAVE_REASON = "PRIVATE-LEAVE-REASON-W4";
const STORAGE_KEY = "secret-storage-prefix";
const APP = "com.matrix.editor";

type Db = { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
let app: INestApplication;
let base: string;
let db: Db;
let hash: string;

interface Person { id: string | null; userId: string; email: string; code: string; name: string; device: string | null; cookie: string }
const who: Record<"superAdmin" | "admin" | "head" | "employee" | "a2" | "b1", Person> = {} as never;
let teamA: string;
let teamB: string;
const TEAM_B_NAME = "Bravo Squad";

async function api(path: string, cookie?: string, init: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (cookie) headers.cookie = cookie;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}/api/v1${path}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const type = res.headers.get("content-type") ?? "";
  const text = type.includes("spreadsheetml") || type.includes("zip") ? "" : await res.text();
  if (!text) await res.body?.cancel().catch(() => {});
  return { status: res.status, text };
}
async function login(email: string) {
  const res = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
  assert.equal(res.status, 200, await res.clone().text());
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

async function person(key: keyof typeof who, name: string, code: string, opts: { role?: "ADMIN" | "EMPLOYEE"; title?: "SUPER_ADMIN" | "ADMIN"; profile?: boolean } = {}) {
  const userId = randomUUID();
  const email = `${code.toLowerCase()}@example.com`;
  const role = opts.role ?? "EMPLOYEE";
  await db.execute({ sql: "INSERT INTO users (id, email, role, admin_title, password_hash) VALUES (?, ?, ?, ?, ?)", args: [userId, email, role, role === "ADMIN" ? (opts.title ?? "ADMIN") : null, hash] });
  let id: string | null = null;
  let device: string | null = null;
  if (opts.profile !== false) {
    id = randomUUID();
    await db.execute({ sql: "INSERT INTO employee_profiles (id, user_id, employee_code, full_name, timezone, created_at) VALUES (?, ?, ?, ?, ?, '2020-01-01T00:00:00.000Z')", args: [id, userId, code, name, TZ] });
    device = randomUUID();
    await db.execute({ sql: "INSERT INTO devices (id, employee_id, device_name, platform, device_identifier, last_seen_at) VALUES (?, ?, 'Mac', 'macos', ?, ?)", args: [device, id, randomUUID(), iso(Date.now())] });
  }
  who[key] = { id, userId, email, code, name, device, cookie: await login(email) };
}

/** A closed shift with activity and a stored screenshot today, an open shift since yesterday, approved leave with a reason. */
async function activity(p: Person) {
  const shift = async (start: number, end: number | null) => {
    const sid = randomUUID();
    await db.execute({ sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, status) VALUES (?, ?, ?, ?, 'OPEN')", args: [sid, p.id, p.device, iso(start)] });
    if (end !== null) await db.execute({ sql: "UPDATE attendance_sessions SET clock_out_at = ?, status = 'CLOSED' WHERE id = ?", args: [iso(end), sid] });
    return sid;
  };
  const yesterday = addDays(D, -1);
  const sid = await shift(at(yesterday, "09:00"), at(yesterday, "12:00"));
  await shift(at(yesterday, "13:00"), null); // still open since yesterday: a missing clock-out
  const [s, e] = [at(yesterday, "09:30"), at(yesterday, "10:30")];
  await db.execute({
    sql: `INSERT INTO activity_intervals (id, employee_id, device_id, attendance_session_id, kind, application_identifier, application_name, started_at, ended_at,
            active_seconds, idle_seconds, source, device_started_at, received_at, idempotency_key) VALUES (?, ?, ?, ?, 'ACTIVE', ?, 'Editor', ?, ?, 3600, 0, 'DESKTOP_MACOS', ?, ?, ?)`,
    args: [randomUUID(), p.id, p.device, sid, APP, iso(s), iso(e), iso(s), iso(e), randomUUID()],
  });
  const shot = randomUUID();
  await db.execute({
    sql: `INSERT INTO screenshots (id, employee_id, device_id, attendance_session_id, idempotency_key, captured_at, device_captured_at, width, height,
            mime_type, file_size_bytes, checksum, storage_provider, storage_key, upload_status, stored_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 100, 100, 'image/webp', 100, ?, 'MICROSOFT_GRAPH', ?, 'STORED', ?)`,
    args: [shot, p.id, p.device, sid, randomUUID(), iso(s + 60_000), iso(s + 60_000), "a".repeat(64), `${STORAGE_KEY}/${shot}`, iso(s + 60_000)],
  });
  await db.execute({
    sql: `INSERT INTO leave_requests (id, employee_id, requested_by, start_date, end_date, portion, reason, status, decided_by, decided_at)
          VALUES (?, ?, ?, ?, ?, 'FULL_DAY', ?, 'APPROVED', ?, ?)`,
    args: [randomUUID(), p.id, p.userId, addDays(D, 2), addDays(D, 2), LEAVE_REASON, who.superAdmin.userId, iso(Date.now())],
  });
  return shot;
}

let shotA = "";
let shotB = "";
before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  hash = await hashPassword(PASSWORD);
  await person("superAdmin", "Sierra Super", "SEC-SA", { role: "ADMIN", title: "SUPER_ADMIN" });
  await person("admin", "India Admin", "SEC-AD", { role: "ADMIN", title: "ADMIN", profile: false });
  await person("head", "Hotel Head", "SEC-HD");
  await person("employee", "Alpha Member", "SEC-A1");
  await person("a2", "Alpha Second", "SEC-A2");
  await person("b1", "Bravo Person", "SEC-B1");
  teamA = randomUUID();
  teamB = randomUUID();
  const sa = who.superAdmin.userId;
  await db.execute({ sql: "INSERT INTO teams (id, name, head_user_id, created_by) VALUES (?, 'Alpha Squad', ?, ?)", args: [teamA, who.head.userId, sa] });
  await db.execute({ sql: "INSERT INTO teams (id, name, head_user_id, created_by) VALUES (?, ?, NULL, ?)", args: [teamB, TEAM_B_NAME, sa] });
  for (const [t, p] of [[teamA, who.employee], [teamA, who.a2], [teamB, who.b1]] as const) {
    await db.execute({ sql: "INSERT INTO team_members (team_id, employee_id, added_by) VALUES (?, ?, ?)", args: [t, p.id, sa] });
  }
  shotA = await activity(who.employee);
  await activity(who.a2);
  shotB = await activity(who.b1);
  // The head's login cookie was issued before the team existed; teamHead is read per request, so it applies now.
});
after(() => app.close());

/** Team-B identifiers a team head of A must never see. */
const teamBMarkers = () => [who.b1.id!, who.b1.name, who.b1.code, who.b1.email, teamB, TEAM_B_NAME];
function assertPrivate(route: string, text: string, { emails = false } = {}) {
  assert.ok(!text.includes(LEAVE_REASON), `${route}: leave reason exposed`);
  assert.ok(!text.includes(STORAGE_KEY), `${route}: storage key exposed`);
  if (!emails) assert.ok(!text.includes("@example.com"), `${route}: email exposed`);
}

interface ReadRoute {
  path: string;
  /** Accepts ?teamId= (contract §4). */
  team: boolean;
  /** Binary file: status checks only. */
  binary?: boolean;
  /** The route lists accounts by design (emails allowed). */
  emails?: boolean;
  /** Admin's response must show team-B data (proves the leak check can fail). */
  adminSeesB?: boolean;
}
const join = (path: string, extra: string) => (extra ? `${path}${path.includes("?") ? "&" : "?"}${extra}` : path);
const READS: ReadRoute[] = [
  { path: `/overview?date=${D}`, team: true, adminSeesB: true },
  { path: "/attendance/missing-clock-outs", team: true, adminSeesB: true },
  { path: `/attendance/monthly?month=${MONTH}`, team: true, adminSeesB: true },
  { path: `/attendance/monthly/export?month=${MONTH}&format=csv`, team: true, adminSeesB: true },
  { path: `/attendance/monthly/export?month=${MONTH}&format=xlsx`, team: true, binary: true },
  { path: `/attendance/late?from=${FROM}&to=${D}`, team: true },
  { path: "/attendance/overview", team: true, adminSeesB: true },
  { path: `/attendance/summary?date=${D}`, team: true },
  { path: `/attendance/timesheets?from=${FROM}&to=${D}`, team: true, adminSeesB: true },
  { path: `/attendance/timesheets/export?from=${FROM}&to=${D}&format=csv`, team: true, adminSeesB: true },
  { path: `/attendance/daily?date=${D}`, team: true, adminSeesB: true },
  { path: `/attendance/daily/export?date=${D}&tab=worked&format=csv`, team: true },
  { path: `/attendance/summary-report?from=${FROM}&to=${D}`, team: true, adminSeesB: true },
  { path: `/attendance/summary-report?from=${FROM}&to=${D}&format=xlsx`, team: true, binary: true },
  { path: "/employees", team: true, emails: true, adminSeesB: true },
  { path: `/activity/apps?from=${FROM}&to=${D}`, team: true, adminSeesB: true },
  { path: `/activity/apps/history?from=${FROM}&to=${D}&app=${APP}`, team: true, adminSeesB: true },
  { path: `/activity/risk-users?from=${FROM}&to=${D}`, team: true },
  { path: `/activity/team-timeline?date=${addDays(D, -1)}`, team: true, adminSeesB: true },
];

describe("team-scoped reads (waves 1–3)", () => {
  for (const r of READS) {
    test(r.path, async () => {
      assert.equal((await api(r.path)).status, 401, "unauthenticated");
      assert.equal((await api(r.path, who.employee.cookie)).status, 403, "plain employee");

      const head = await api(r.path, who.head.cookie);
      assert.equal(head.status, 200, `team head: ${head.text}`);
      for (const m of teamBMarkers()) assert.ok(!head.text.includes(m), `team head sees team-B data (${m})`);
      assertPrivate(r.path, head.text, { emails: r.emails });

      const sa = await api(r.path, who.superAdmin.cookie);
      assert.equal(sa.status, 200, `super admin: ${sa.text}`);
      assertPrivate(r.path, sa.text, { emails: r.emails });

      const admin = await api(r.path, who.admin.cookie);
      assert.equal(admin.status, 200, `admin: ${admin.text}`);
      assertPrivate(r.path, admin.text, { emails: r.emails });
      if (r.adminSeesB) assert.ok(admin.text.includes(who.b1.id!) || admin.text.includes(who.b1.code), "admin sees team B (leak check is live)");
      if (r.adminSeesB && !r.binary) assert.ok(head.text.includes(who.employee.code) || head.text.includes(who.employee.id!), "head sees their own team");

      if (!r.team) return;
      const inTeam = await api(join(r.path, `teamId=${teamA}`), who.head.cookie);
      assert.equal(inTeam.status, 200, `head, own team: ${inTeam.text}`);
      for (const m of teamBMarkers()) assert.ok(!inTeam.text.includes(m), `team head ?teamId=A sees team-B data (${m})`);
      assert.equal((await api(join(r.path, `teamId=${teamB}`), who.head.cookie)).status, 404, "head, other team");
      assert.equal((await api(join(r.path, `teamId=${randomUUID()}`), who.admin.cookie)).status, 404, "admin, unknown team");
      assert.equal((await api(join(r.path, "teamId=not-a-uuid"), who.admin.cookie)).status, 400, "teamId validation");
      const bOnly = await api(join(r.path, `teamId=${teamB}`), who.admin.cookie);
      assert.equal(bOnly.status, 200, bOnly.text);
      if (!r.binary) assert.ok(!bOnly.text.includes(who.employee.code), "admin ?teamId=B shows no team-A row");
    });
  }

  test("per-employee analytics: head reads a member, 404 outside the team; employee 403; never another team's name", async () => {
    const path = (id: string) => `/employees/${id}/analytics?from=${FROM}&to=${D}`;
    assert.equal((await api(path(who.b1.id!))).status, 401);
    assert.equal((await api(path(who.b1.id!), who.employee.cookie)).status, 403);
    assert.equal((await api(path(who.employee.id!), who.employee.cookie)).status, 403, "own analytics stay an admin/head view");
    assert.equal((await api(path(who.b1.id!), who.head.cookie)).status, 404);
    assert.equal((await api(path(randomUUID()), who.admin.cookie)).status, 404);
    const ok = await api(path(who.employee.id!), who.head.cookie);
    assert.equal(ok.status, 200, ok.text);
    assertPrivate("analytics", ok.text);
    // b1 is also put in team A's sibling team below: the head must still see only Alpha.
    await db.execute({ sql: "INSERT INTO team_members (team_id, employee_id, added_by) VALUES (?, ?, ?)", args: [teamB, who.employee.id, who.superAdmin.userId] });
    try {
      for (const p of [path(who.employee.id!), `/employees/${who.employee.id}`, "/employees"]) {
        const r = await api(p, who.head.cookie);
        assert.equal(r.status, 200, r.text);
        assert.ok(!r.text.includes(TEAM_B_NAME) && !r.text.includes(teamB), `${p}: head sees a member's other team`);
      }
      assert.ok((await api(path(who.employee.id!), who.admin.cookie)).text.includes(TEAM_B_NAME), "admins see every team");
    } finally {
      await db.execute({ sql: "DELETE FROM team_members WHERE team_id = ? AND employee_id = ?", args: [teamB, who.employee.id] });
    }
  });

  test("validation: ranges, page sizes, months, dates (400, never a slow unbounded read)", async () => {
    const tooLong = addDays(D, -92);
    for (const p of [
      `/attendance/late?from=${tooLong}&to=${D}`,
      `/attendance/summary-report?from=${tooLong}&to=${D}`,
      `/activity/risk-users?from=${tooLong}&to=${D}`,
      `/activity/apps?from=${addDays(D, -31)}&to=${D}`,
      `/employees/${who.employee.id}/analytics?from=${tooLong}&to=${D}`,
      `/attendance/monthly?month=${MONTH}&pageSize=101`,
      `/attendance/late?from=${FROM}&to=${D}&pageSize=101`,
      `/activity/team-timeline?date=${D}&pageSize=101`,
      `/attendance/summary-report?from=${FROM}&to=${D}&pageSize=101`,
      "/attendance/monthly?month=2026-13",
      "/attendance/monthly/export?month=2026-1&format=csv",
      `/attendance/daily/export?date=${D}&tab=everything`,
      "/overview?date=2026-02-30",
      `/activity/apps/history?from=${FROM}&to=${D}&app=${"x".repeat(301)}`,
      `/attendance/late?from=${D}&to=${FROM}`,
    ]) {
      assert.equal((await api(p, who.admin.cookie)).status, 400, p);
    }
  });
});

describe("Super Admin only actions", () => {
  test("Admin, team head and employee are refused; Super Admin passes the permission check", async () => {
    const release = randomUUID();
    await db.execute({ sql: "INSERT INTO desktop_releases (id, version, created_by) VALUES (?, '9.9.9', ?)", args: [release, who.superAdmin.userId] });
    const actions: { path: string; method: string; body?: unknown }[] = [
      { path: "/screenshots/export", method: "POST", body: { ids: [shotA] } },
      { path: `/screenshots/${shotB}`, method: "DELETE", body: { reason: "Synthetic delete reason" } },
      { path: "/roles/users", method: "GET" },
      { path: "/roles/history", method: "GET" },
      { path: "/storage/onedrive/disconnect", method: "POST" },
      { path: `/desktop-updates/releases/${release}/status`, method: "POST", body: { status: "PUBLISHED" } },
    ];
    for (const a of actions) {
      const label = `${a.method} ${a.path}`;
      assert.equal((await api(a.path, undefined, a)).status, 401, `${label}: unauthenticated`);
      for (const k of ["admin", "head", "employee"] as const) assert.equal((await api(a.path, who[k].cookie, a)).status, 403, `${label}: ${k}`);
    }
    // Super Admin: past the permission check (the outcome depends on storage/packages, never 401/403).
    for (const a of actions.filter((x) => x.method !== "DELETE" && !x.path.startsWith("/storage"))) {
      const r = await api(a.path, who.superAdmin.cookie, a);
      assert.ok(![401, 403].includes(r.status), `${a.method} ${a.path}: super admin got ${r.status} ${r.text}`);
      assertPrivate(a.path, r.text, { emails: a.path.startsWith("/roles") });
    }
  });

  test("admin-only settings routes: team head and employee 403", async () => {
    for (const p of ["/notifications/rules", "/notifications/rules/recipient-candidates", `/notifications/rules/recipient-candidates?teamId=${teamA}`, "/reports/schedules"]) {
      for (const k of ["head", "employee"] as const) assert.equal((await api(p, who[k].cookie)).status, 403, `${p}: ${k}`);
      assert.equal((await api(p, who.admin.cookie)).status, 200, p);
    }
    assert.equal((await api(`/notifications/rules/recipient-candidates?teamId=${randomUUID()}`, who.admin.cookie)).status, 404);
  });
});

describe("own-scope corrections", () => {
  const body = (employeeId?: string) => ({
    type: "MISSING_CLOCK_IN",
    clockInAt: iso(at(addDays(D, -5), "09:00")),
    clockOutAt: iso(at(addDays(D, -5), "17:00")),
    reason: "Synthetic forgot to clock in",
    ...(employeeId && { employeeId }),
  });

  test("an employee or team head cannot request a correction for someone else (404)", async () => {
    assert.equal((await api("/attendance/corrections", who.employee.cookie, { method: "POST", body: body(who.b1.id!) })).status, 404);
    assert.equal((await api("/attendance/corrections", who.head.cookie, { method: "POST", body: body(who.employee.id!) })).status, 404, "heads are not reviewers");
    const own = await api("/attendance/corrections", who.employee.cookie, { method: "POST", body: body() });
    assert.equal(own.status, 201, own.text);
    assertPrivate("corrections", (await api("/attendance/corrections", who.employee.cookie)).text, { emails: true });
    const list = await api("/attendance/corrections", who.employee.cookie);
    assert.ok(!list.text.includes(who.b1.code), "employee list shows only their own requests");
  });

  test("a correction requested on an admin's behalf cannot be approved by that admin (no self-approval)", async () => {
    const r = await api("/attendance/corrections", who.admin.cookie, { method: "POST", body: body(who.superAdmin.id!) });
    assert.equal(r.status, 201, r.text);
    const id = JSON.parse(r.text).id;
    const self = await api(`/attendance/corrections/${id}/approve`, who.superAdmin.cookie, { method: "POST", body: { reason: "Looks right to me" } });
    assert.equal(self.status, 403, self.text);
    assert.equal((await api(`/attendance/corrections/${id}/approve`, who.admin.cookie, { method: "POST", body: { reason: "Looks right" } })).status, 403, "requester");
    const pending = await api(`/attendance/corrections/${id}`, who.admin.cookie);
    assert.equal(JSON.parse(pending.text).status, "PENDING");
  });
});
