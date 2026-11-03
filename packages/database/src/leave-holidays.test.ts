// Migrations 0021 (leave types) and 0022 (holidays): existing requests get the default type; the type
// is fixed once set; types are never deleted; one holiday per valid date.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatabase, guardViolation, isUniqueViolation, migrate, MIGRATIONS } from "../dist/index.js";

const GENERAL = "00000000-0000-4000-8000-000000000001";

test("0021 backfills existing leave requests (pending and decided) with the default type", async () => {
  const db = createDatabase({ url: ":memory:" });
  // Apply everything before 0021 by hand, as an older build would have (checksums are stamped by migrate()).
  for (const m of MIGRATIONS.filter((x) => x.id < "0021")) {
    await db.batch([...m.statements], "write");
    await db.execute("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT 'x', checksum TEXT) STRICT");
    await db.execute({ sql: "INSERT INTO schema_migrations (id) VALUES (?)", args: [m.id] });
  }
  await db.execute("INSERT INTO users (id, email, role) VALUES ('u1', 'e@example.com', 'EMPLOYEE'), ('a1', 'a@example.com', 'ADMIN')");
  await db.execute("INSERT INTO employee_profiles (id, user_id, employee_code, full_name) VALUES ('p1', 'u1', 'EMP-1', 'E')");
  await db.execute("INSERT INTO leave_requests (id, employee_id, requested_by, start_date, end_date, portion) VALUES ('old1', 'p1', 'u1', '2026-11-02', '2026-11-02', 'FULL_DAY'), ('old2', 'p1', 'u1', '2026-11-03', '2026-11-03', 'FULL_DAY')");
  await db.execute("UPDATE leave_requests SET status = 'APPROVED', decided_by = 'a1', decided_at = '2026-11-01T00:00:00.000Z' WHERE id = 'old2'");

  assert.deepEqual(await migrate(db), MIGRATIONS.filter((x) => x.id >= "0021").map((x) => x.id));
  const rows = (await db.execute("SELECT id, leave_type_id, status FROM leave_requests ORDER BY id")).rows;
  assert.deepEqual(rows.map((r) => [r.id, r.leave_type_id, r.status]), [["old1", GENERAL, "PENDING"], ["old2", GENERAL, "APPROVED"]]);
  const general = (await db.execute("SELECT name, paid, yearly_allowance_days, short_hours_per_month, active FROM leave_types")).rows;
  assert.deepEqual({ ...general[0] }, { name: "General", paid: 0, yearly_allowance_days: null, short_hours_per_month: null, active: 1 });
  db.close();
});

test("leave types: valid limits, unique names, never deleted; a request's type is set on insert and never changes", async () => {
  const db = createDatabase({ url: ":memory:" });
  await migrate(db);
  await db.execute("INSERT INTO users (id, email, role) VALUES ('u1', 'e@example.com', 'EMPLOYEE'), ('a1', 'a@example.com', 'ADMIN')");
  await db.execute("INSERT INTO employee_profiles (id, user_id, employee_code, full_name) VALUES ('p1', 'u1', 'EMP-1', 'E')");
  const type = (id: string, name: string, allowance: number | null = 10, hours: number | null = null) =>
    db.execute({ sql: "INSERT INTO leave_types (id, name, paid, yearly_allowance_days, short_hours_per_month) VALUES (?, ?, 1, ?, ?)", args: [id, name, allowance, hours] });
  await type("t1", "Annual", 20.5, 4);
  await assert.rejects(type("t2", "annual"), (e) => isUniqueViolation(e, "leave_types.name"), "names are unique, any case");
  await assert.rejects(type("t3", "Neg", -1), /CHECK constraint/);
  await assert.rejects(type("t4", "Long", 400), /CHECK constraint/);
  await assert.rejects(type("t5", "  "), /CHECK constraint/);
  await assert.rejects(db.execute("DELETE FROM leave_types WHERE id = 't1'"), (e) => guardViolation(e) === "append_only");

  // A raw insert with no type (as before 0021) gets the default, even when inserted already decided.
  await db.execute("INSERT INTO leave_requests (id, employee_id, requested_by, start_date, end_date, portion, status, decided_by, decided_at) VALUES ('r1', 'p1', 'u1', '2026-11-02', '2026-11-02', 'FULL_DAY', 'APPROVED', 'a1', '2026-11-01T00:00:00.000Z')");
  await db.execute("INSERT INTO leave_requests (id, employee_id, requested_by, start_date, end_date, portion, leave_type_id) VALUES ('r2', 'p1', 'u1', '2026-11-03', '2026-11-03', 'FULL_DAY', 't1')");
  assert.deepEqual((await db.execute("SELECT leave_type_id FROM leave_requests ORDER BY id")).rows.map((r) => r.leave_type_id), [GENERAL, "t1"]);
  await assert.rejects(db.execute(`UPDATE leave_requests SET leave_type_id = '${GENERAL}' WHERE id = 'r2'`), (e) => guardViolation(e) === "already_reviewed", "type is fixed while pending");
  await assert.rejects(db.execute("UPDATE leave_requests SET leave_type_id = 't1' WHERE id = 'r1'"), (e) => guardViolation(e) === "already_reviewed");
  await assert.rejects(db.execute("INSERT INTO leave_requests (id, employee_id, requested_by, start_date, end_date, portion, leave_type_id) VALUES ('r3', 'p1', 'u1', '2026-11-04', '2026-11-04', 'FULL_DAY', 'missing')"), /FOREIGN KEY/);
  db.close();
});

test("holidays: one per valid date, named", async () => {
  const db = createDatabase({ url: ":memory:" });
  await migrate(db);
  await db.execute("INSERT INTO users (id, email, role) VALUES ('a1', 'a@example.com', 'ADMIN')");
  const add = (id: string, date: string, name = "Holiday") => db.execute({ sql: "INSERT INTO holidays (id, date, name, created_by) VALUES (?, ?, ?, 'a1')", args: [id, date, name] });
  await add("h1", "2026-12-25");
  await assert.rejects(add("h2", "2026-12-25"), (e) => isUniqueViolation(e, "holidays.date"));
  await assert.rejects(add("h3", "2026-02-30"), /CHECK constraint/);
  await assert.rejects(add("h4", "2026-12-26", " "), /CHECK constraint/);
  await assert.rejects(db.execute("INSERT INTO holidays (id, date, name, created_by) VALUES ('h5', '2026-12-27', 'X', 'nobody')"), /FOREIGN KEY/);
  db.close();
});
