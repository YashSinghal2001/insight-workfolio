// Migration 0025 (per-person overrides, idle-excluded apps): existing monitoring policies survive with
// an empty exclusion list; overrides are append-only, validated, and NULL means "inherit".
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatabase, guardViolation, migrate, MIGRATIONS } from "../dist/index.js";

test("0025 keeps existing monitoring policy versions (no exclusions) and adds an empty override history", async () => {
  const db = createDatabase({ url: ":memory:" });
  for (const m of MIGRATIONS.filter((x) => x.id < "0025")) {
    await db.batch([...m.statements], "write");
    await db.execute("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT 'x', checksum TEXT) STRICT");
    await db.execute({ sql: "INSERT INTO schema_migrations (id) VALUES (?)", args: [m.id] });
  }
  await db.execute("INSERT INTO users (id, email, role) VALUES ('a1', 'a@example.com', 'ADMIN')");
  const notice = (await db.execute("SELECT version FROM monitoring_notices LIMIT 1")).rows[0]?.version ?? "2026-10-draft-1";
  await db.execute({
    sql: `INSERT INTO monitoring_policies (monitoring_enabled, sample_seconds, idle_threshold_seconds, retention_days, retention_approved, notice_version, reason, changed_by)
          VALUES (1, 20, 600, 30, 0, ?, 'before 0025', 'a1')`,
    args: [notice],
  });
  await db.execute("INSERT INTO work_schedule_policies (enabled, expected_start, grace_minutes, workdays, reason, changed_by) VALUES (1, '09:00', 10, '12345', 'before 0025', 'a1')");

  const applied = await migrate(db);
  assert.ok(applied.includes("0025_person_overrides"));
  const p = (await db.execute("SELECT sample_seconds, idle_threshold_seconds, reason, idle_excluded_apps FROM monitoring_policies")).rows;
  assert.deepEqual(p.map((r) => ({ ...r })), [{ sample_seconds: 20, idle_threshold_seconds: 600, reason: "before 0025", idle_excluded_apps: "[]" }]);
  assert.equal((await db.execute("SELECT count(*) AS n FROM work_schedule_policies")).rows[0]!.n, 1);
  assert.equal((await db.execute("SELECT count(*) AS n FROM employee_tracking_overrides")).rows[0]!.n, 0, "no overrides = everyone inherits");
  db.close();
});

test("employee_tracking_overrides: NULL = inherit, values validated, append-only; exclusion list must be a JSON array", async () => {
  const db = createDatabase({ url: ":memory:" });
  await migrate(db);
  await db.execute("INSERT INTO users (id, email, role) VALUES ('u1', 'e@example.com', 'EMPLOYEE'), ('a1', 'a@example.com', 'ADMIN')");
  await db.execute("INSERT INTO employee_profiles (id, user_id, employee_code, full_name) VALUES ('p1', 'u1', 'EMP-1', 'E')");
  const add = (id: string, start: string | null, days: string | null, idle: number | null, emp = "p1") =>
    db.execute({ sql: "INSERT INTO employee_tracking_overrides (id, employee_id, expected_start, workdays, idle_threshold_seconds, reason, changed_by) VALUES (?, ?, ?, ?, ?, 'test', 'a1')", args: [id, emp, start, days, idle] });
  await add("o1", "10:30", "1234", 900);
  await add("o2", null, null, null);
  for (const [start, days, idle] of [["24:00", null, null], [null, "1123", null], [null, "8", null], [null, null, 10], [null, null, 4000]] as const) {
    await assert.rejects(add(`bad-${start}-${days}-${idle}`, start, days, idle), /CHECK constraint/, `${start} ${days} ${idle}`);
  }
  await assert.rejects(add("o3", null, null, 60, "missing"), /FOREIGN KEY/);
  await assert.rejects(db.execute("UPDATE employee_tracking_overrides SET idle_threshold_seconds = 60"), (e) => guardViolation(e) === "append_only");
  await assert.rejects(db.execute("DELETE FROM employee_tracking_overrides"), (e) => guardViolation(e) === "append_only");
  const notice = (await db.execute("SELECT version FROM monitoring_notices LIMIT 1")).rows[0]!.version;
  const policy = (apps: string) =>
    db.execute({
      sql: `INSERT INTO monitoring_policies (monitoring_enabled, sample_seconds, idle_threshold_seconds, retention_days, retention_approved, notice_version, reason, changed_by, idle_excluded_apps)
            VALUES (1, 15, 300, 30, 0, ?, 'test', 'a1', ?)`,
      args: [notice, apps],
    });
  await policy('["us.zoom.xos","Teams.exe"]');
  await assert.rejects(policy('{"a":1}'), /CHECK constraint/);
  await assert.rejects(policy("not json"), /CHECK constraint/);
  db.close();
});
