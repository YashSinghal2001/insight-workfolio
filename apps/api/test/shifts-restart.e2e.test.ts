// Automatic clock-out survives an API restart: a deadline that passed while the API was down is processed
// by the startup sweep of the next process, at the deadline (not the restart time). Own file: the API reads
// DATABASE_URL once at import, so the file URL must be set first.
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { NestFactory } from "@nestjs/core";

const DIR = mkdtempSync(join(tmpdir(), "wf-shift-restart-"));
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL = `file:${join(DIR, "api.db")}`;
process.env.JWT_SECRET = "test-secret-test-secret-test-secret!";

const { AppModule } = await import("../dist/app.module.js");
const { DATABASE } = await import("../dist/database/database.module.js");
const { AutoClockOutService } = await import("../dist/shifts/auto-clock-out.service.js");
after(() => rmSync(DIR, { recursive: true, force: true }));

const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
type Db = { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };

test("deadline passes while the API is down: the next process clocks out at the deadline on startup", async () => {
  const end = Math.floor((Date.now() - 2 * H) / 60_000) * 60_000;
  const hm = (ms: number) => iso(ms).slice(11, 16);
  const ids = { admin: randomUUID(), user: randomUUID(), emp: randomUUID(), device: randomUUID(), session: randomUUID() };

  // First process: an employee clocked in with a shift whose deadline (end + 60 min) is still ahead... then it stops.
  const first = await NestFactory.create(AppModule, { logger: false });
  await first.init();
  const db1: Db = first.get(DATABASE);
  await db1.execute({ sql: "INSERT INTO users (id, email, role, admin_title, password_hash) VALUES (?, 'r-admin@example.com', 'ADMIN', 'SUPER_ADMIN', 'x')", args: [ids.admin] });
  await db1.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'r-emp@example.com', 'EMPLOYEE', 'x')", args: [ids.user] });
  await db1.execute({ sql: "INSERT INTO employee_profiles (id, user_id, employee_code, full_name, timezone) VALUES (?, ?, 'R-1', 'Restart', 'UTC')", args: [ids.emp, ids.user] });
  await db1.execute({ sql: "INSERT INTO devices (id, employee_id, device_identifier, device_name, platform) VALUES (?, ?, ?, 'Mac', 'macos')", args: [ids.device, ids.emp, randomUUID()] });
  await db1.execute({ sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, status) VALUES (?, ?, ?, ?, 'OPEN')", args: [ids.session, ids.emp, ids.device, iso(end - 7 * H)] });
  await db1.execute({
    sql: "INSERT INTO employee_shifts (employee_id, start_time, end_time, timezone, grace_minutes, auto_clock_out, workdays, updated_by, updated_at) VALUES (?, ?, ?, 'UTC', 60, 1, '1234567', ?, ?)",
    args: [ids.emp, hm(end - 8 * H), hm(end), ids.admin, iso(end - 10 * H)],
  });
  await first.close(); // "downtime": nothing ran at the deadline

  // Second process over the same database: its startup sweep (the production start path) catches up.
  const second = await NestFactory.create(AppModule, { logger: false });
  await second.init();
  const worker = second.get(AutoClockOutService);
  try {
    worker.start();
    const db2: Db = second.get(DATABASE);
    let row: Record<string, unknown> | undefined;
    for (let i = 0; i < 100 && row?.status !== "CLOSED"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      row = (await db2.execute({ sql: "SELECT status, clock_out_at FROM attendance_sessions WHERE id = ?", args: [ids.session] })).rows[0];
    }
    assert.deepEqual([row?.status, row?.clock_out_at], ["CLOSED", iso(end + H)], "closed at the deadline, not the restart time");
    assert.equal((await db2.execute({ sql: "SELECT count(*) AS n FROM auto_clock_outs WHERE attendance_session_id = ?", args: [ids.session] })).rows[0]!.n, 1);
    assert.equal(await worker.sweep(), 0, "a second run does nothing");
  } finally {
    await second.close();
  }
});
