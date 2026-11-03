// Migration 0026 (F06 alert rules): additive on an existing database; parameters match the rule kind;
// one alert per rule, employee and date; an alert is acknowledged once and otherwise never changes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatabase, guardViolation, isUniqueViolation, migrate, MIGRATIONS } from "../dist/index.js";

test("0026 applies to an existing database and leaves its data unchanged", async () => {
  const db = createDatabase({ url: ":memory:" });
  for (const m of MIGRATIONS.filter((x) => x.id < "0026")) {
    await db.batch([...m.statements], "write");
    await db.execute("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT 'x', checksum TEXT) STRICT");
    await db.execute({ sql: "INSERT INTO schema_migrations (id) VALUES (?)", args: [m.id] });
  }
  await db.execute("INSERT INTO users (id, email, role) VALUES ('u1', 'e@example.com', 'EMPLOYEE'), ('a1', 'a@example.com', 'ADMIN')");
  await db.execute("INSERT INTO employee_profiles (id, user_id, employee_code, full_name) VALUES ('p1', 'u1', 'EMP-1', 'E')");
  await db.execute("INSERT INTO holidays (id, date, name, created_by) VALUES ('h1', '2026-12-25', 'Christmas', 'a1')");
  const before = async () => (await db.execute("SELECT (SELECT count(*) FROM users) AS u, (SELECT count(*) FROM employee_profiles) AS p, (SELECT name FROM holidays) AS h")).rows.map((r) => ({ ...r }));
  const snapshot = await before();

  assert.deepEqual(await migrate(db), MIGRATIONS.filter((x) => x.id >= "0026").map((x) => x.id));
  assert.deepEqual(await before(), snapshot);
  assert.equal(Number((await db.execute("SELECT count(*) AS n FROM alert_rules")).rows[0]!.n), 0);
  db.close();
});

test("alert rules and alerts: kind parameters, one per (rule, employee, date), acknowledge once", async () => {
  const db = createDatabase({ url: ":memory:" });
  await migrate(db);
  await db.execute("INSERT INTO users (id, email, role) VALUES ('u1', 'e@example.com', 'EMPLOYEE'), ('a1', 'a@example.com', 'ADMIN')");
  await db.execute("INSERT INTO employee_profiles (id, user_id, employee_code, full_name) VALUES ('p1', 'u1', 'EMP-1', 'E')");
  const rule = (id: string, kind: string, threshold: number | null, atTime: string | null) =>
    db.execute({ sql: "INSERT INTO alert_rules (id, name, kind, threshold, at_time, created_by) VALUES (?, 'R', ?, ?, ?, 'a1')", args: [id, kind, threshold, atTime] });
  await rule("r1", "LATE_CLOCK_IN", null, null);
  await rule("r2", "NOT_CLOCKED_IN_BY", null, "10:00");
  await rule("r3", "IDLE_SHARE_ABOVE", 50, null);
  await rule("r4", "NO_ACTIVITY_FOR", 30, null);
  for (const [kind, threshold, atTime] of [["LATE_CLOCK_IN", 5, null], ["NOT_CLOCKED_IN_BY", null, null], ["NOT_CLOCKED_IN_BY", null, "25:00"], ["IDLE_SHARE_ABOVE", 100, null], ["NO_ACTIVITY_FOR", 4, null], ["OTHER", null, null]] as const) {
    await assert.rejects(rule("bad", kind, threshold, atTime), /CHECK constraint/, `${kind} ${threshold} ${atTime}`);
  }

  const alert = (id: string, date = "2026-03-03") => db.execute({ sql: "INSERT INTO alerts (id, rule_id, employee_id, date, detail) VALUES (?, 'r1', 'p1', ?, 'Late')", args: [id, date] });
  await alert("x1");
  await assert.rejects(alert("x2"), (e) => isUniqueViolation(e));
  await alert("x3", "2026-03-04");
  await assert.rejects(alert("x4", "2026-02-30"), /CHECK constraint/);
  await assert.rejects(db.execute("UPDATE alerts SET detail = 'Changed' WHERE id = 'x1'"), (e) => guardViolation(e) === "already_reviewed");
  await assert.rejects(db.execute("UPDATE alerts SET acknowledged_by = 'a1' WHERE id = 'x1'"), /CHECK constraint/, "who and when together");
  await db.execute("UPDATE alerts SET acknowledged_by = 'a1', acknowledged_at = '2026-03-03T12:00:00.000Z' WHERE id = 'x1'");
  await assert.rejects(db.execute("UPDATE alerts SET acknowledged_at = '2026-03-04T12:00:00.000Z' WHERE id = 'x1'"), (e) => guardViolation(e) === "already_reviewed");
  await assert.rejects(db.execute("DELETE FROM alert_rules WHERE id = 'r1'"), /FOREIGN KEY/, "alerts are removed first, explicitly");
  db.close();
});
