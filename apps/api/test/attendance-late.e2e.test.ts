// GET /attendance/late (W1-ATT-DATA). In-process API, in-memory DB, synthetic people.
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

let app: INestApplication;
let base: string;
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
let admin: string;
let adminId: string;

async function api(path: string) {
  const res = await fetch(`${base}/api/v1${path}`, { headers: { origin: ORIGIN, cookie: admin } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text };
}

type Person = { id: string; device: string };
async function person(code: string, name: string, timezone: string): Promise<Person> {
  const [user, id, device] = [randomUUID(), randomUUID(), randomUUID()];
  await db.execute({ sql: "INSERT INTO users (id, email, role) VALUES (?, ?, 'EMPLOYEE')", args: [user, `${code.toLowerCase()}@example.com`] });
  await db.execute({
    sql: "INSERT INTO employee_profiles (id, user_id, employee_code, full_name, timezone, created_at) VALUES (?, ?, ?, ?, ?, '2023-01-01T00:00:00.000Z')",
    args: [id, user, code, name, timezone],
  });
  await db.execute({ sql: "INSERT INTO devices (id, employee_id, device_identifier, device_name, platform) VALUES (?, ?, ?, 'Mac', 'macos')", args: [device, id, device] });
  return { id, device };
}
const shift = (p: Person, at: string, open = false) =>
  db.execute({
    sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, clock_out_at, status) VALUES (?, ?, ?, ?, ?, ?)",
    args: [randomUUID(), p.id, p.device, at, open ? null : new Date(Date.parse(at) + 3_600_000).toISOString(), open ? "OPEN" : "CLOSED"],
  });

type Late = { employee: { id: string; fullName: string }; date: string; dueLocal: string; firstClockInLocal: string; lateMinutes: number };

let amy: Person, ben: Person, raj: Person;

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
  await db.execute({ sql: "INSERT INTO work_schedule_policies (enabled, expected_start, grace_minutes, workdays, reason, changed_by, effective_at) VALUES (1, '09:00', 10, '12345', 'test policy', ?, '2024-01-01T00:00:00.000Z')", args: [adminId] });
  amy = await person("LATE-A", "Amy Late", "UTC");
  ben = await person("LATE-B", "Ben Late", "UTC");
  raj = await person("LATE-R", "Raj Late", "Asia/Kolkata");
  await shift(amy, "2026-03-02T09:05:00.000Z"); // within grace: not late
  await shift(amy, "2026-03-03T09:45:00.000Z"); // late 45
  await shift(ben, "2026-03-03T09:11:00.000Z"); // late 11 (1 min past grace)
  await shift(ben, "2026-03-04T09:10:00.000Z"); // exactly at the due time: not late
  await shift(raj, "2026-03-03T04:00:00.000Z"); // 09:30 IST: late 30
  await shift(raj, "2026-03-05T05:00:00.000Z", true); // 10:30 IST, still open: late 90
});
after(() => app.close());

test("only late days, newest date first then by employee name; local times; open shifts included", async () => {
  const r = await api("/attendance/late?from=2026-03-01&to=2026-03-31");
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.from, "2026-03-01");
  assert.equal(r.body.to, "2026-03-31");
  assert.deepEqual(
    (r.body.items as Late[]).map((x) => [x.date, x.employee.fullName, x.firstClockInLocal, x.dueLocal, x.lateMinutes]),
    [
      ["2026-03-05", "Raj Late", "10:30", "09:10", 90],
      ["2026-03-03", "Amy Late", "09:45", "09:10", 45],
      ["2026-03-03", "Ben Late", "09:11", "09:10", 11],
      ["2026-03-03", "Raj Late", "09:30", "09:10", 30],
    ],
  );
  assert.equal(r.body.total, 4);
});

test("paging, empty range, range boundary (92 days ok, 93 refused) and validation", async () => {
  const p2 = await api("/attendance/late?from=2026-03-01&to=2026-03-31&page=2&pageSize=3");
  assert.equal(p2.body.items.length, 1);
  assert.equal(p2.body.total, 4);
  assert.equal(p2.body.page, 2);
  const none = await api("/attendance/late?from=2026-02-01&to=2026-02-28");
  assert.deepEqual([none.status, none.body.items, none.body.total], [200, [], 0]);
  assert.equal((await api("/attendance/late?from=2026-01-01&to=2026-04-02")).status, 200, "92 days");
  for (const q of ["from=2026-01-01&to=2026-04-03", "from=2026-03-02&to=2026-03-01", "from=2026-03-01", "from=x&to=y", "from=2026-03-01&to=2026-03-02&pageSize=101", "from=2026-03-01&to=2026-03-02&teamId=1"]) {
    assert.equal((await api(`/attendance/late?${q}`)).status, 400, q);
  }
});
