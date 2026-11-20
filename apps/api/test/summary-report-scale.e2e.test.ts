// Scale: ≥ 40k shifts over 92 days through the summary report and the org timesheet export (chunked reads, W2-REPORTS).
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
const PEOPLE = 450;
const DAYS = 92;
const RANGE = "from=2025-01-01&to=2025-04-02"; // 92 days
let app: INestApplication;
let base: string;
let admin: string;

const api = async (path: string) => {
  const res = await fetch(`${base}/api/v1${path}`, { headers: { origin: ORIGIN, cookie: admin } });
  const text = await res.text();
  return { status: res.status, text, body: (res.headers.get("content-type") ?? "").includes("json") ? JSON.parse(text) : undefined, headers: res.headers };
};

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  const db = app.get(DATABASE) as { execute: (q: { sql: string; args: unknown[] }) => Promise<unknown>; batch: (q: { sql: string; args: unknown[] }[], m: string) => Promise<unknown> };
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [randomUUID(), await hashPassword("admin password 1")] });
  const login = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email: "admin@example.com", password: "admin password 1" }) });
  admin = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const start = Date.parse("2025-01-01T00:00:00.000Z");
  for (let i = 0; i < PEOPLE; i++) {
    const [user, id, device] = [randomUUID(), randomUUID(), randomUUID()];
    const tz = ["UTC", "Asia/Kolkata", "America/New_York"][i % 3]!;
    const stmts = [
      { sql: "INSERT INTO users (id, email, role) VALUES (?, ?, 'EMPLOYEE')", args: [user, `scale${i}@example.com`] },
      { sql: "INSERT INTO employee_profiles (id, user_id, employee_code, full_name, timezone, created_at) VALUES (?, ?, ?, ?, ?, '2024-01-01T00:00:00.000Z')", args: [id, user, `SC-${String(i).padStart(3, "0")}`, `Scale ${i}`, tz] },
      { sql: "INSERT INTO devices (id, employee_id, device_identifier, device_name, platform) VALUES (?, ?, ?, 'Mac', 'macos')", args: [device, id, device] },
    ];
    for (let d = 0; d < DAYS; d++) {
      const sid = randomUUID();
      const at = start + d * 86_400_000 + 12 * 3_600_000;
      stmts.push({ sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, status) VALUES (?, ?, ?, ?, 'OPEN')", args: [sid, id, device, new Date(at).toISOString()] });
      if (d % 10 === 0) stmts.push({ sql: "INSERT INTO break_sessions (id, attendance_session_id, started_at, ended_at, status) VALUES (?, ?, ?, ?, 'CLOSED')", args: [randomUUID(), sid, new Date(at + 3_600_000).toISOString(), new Date(at + 3_600_000 + 1_830_000).toISOString()] });
      stmts.push({ sql: "UPDATE attendance_sessions SET clock_out_at = ?, status = 'CLOSED' WHERE id = ?", args: [new Date(at + 8 * 3_600_000 + 17_000).toISOString(), sid] });
    }
    await db.batch(stmts, "write");
  }
});
after(() => app.close());

test(`${PEOPLE * DAYS} shifts, 92 days: summary report (JSON + XLSX) and org export answer 200; totals equal the timesheets`, async (t) => {
  let t0 = performance.now();
  const r = await api(`/attendance/summary-report?${RANGE}&pageSize=100&page=2`);
  t.diagnostic(`summary JSON: ${(performance.now() - t0).toFixed(0)} ms`);
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.equal(r.body.total, PEOPLE);
  assert.equal(r.body.items.length, 100);
  let sum = 0;
  for (let page = 1; page <= Math.ceil(PEOPLE / 100); page++) {
    const s = await api(`/attendance/timesheets?${RANGE}&pageSize=100&page=${page}`);
    assert.equal(s.status, 200, s.text.slice(0, 300));
    for (const row of s.body.items as { totals: { netMs: number } }[]) sum += Math.floor(row.totals.netMs / 60_000);
  }
  assert.equal(r.body.totals.workedMinutes, sum, "to the minute");
  assert.equal(r.body.totals.workedDays, PEOPLE * DAYS);
  t0 = performance.now();
  const x = await api(`/attendance/summary-report?${RANGE}&format=xlsx`);
  t.diagnostic(`summary XLSX: ${(performance.now() - t0).toFixed(0)} ms`);
  assert.equal(x.status, 200);
  t0 = performance.now();
  const csv = await api(`/attendance/timesheets/export?${RANGE}`);
  t.diagnostic(`org CSV export: ${(performance.now() - t0).toFixed(0)} ms`);
  assert.equal(csv.status, 200, csv.text.slice(0, 300));
  assert.equal(Number(csv.headers.get("x-export-rows")), PEOPLE * DAYS);
});
