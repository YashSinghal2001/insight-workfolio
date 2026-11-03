// Migration 0024 (teams): existing employees keep working with no team; teams are never deleted;
// membership rows are added or removed, never changed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatabase, guardViolation, isUniqueViolation, migrate, MIGRATIONS } from "../dist/index.js";

test("0024 leaves existing employees without a team and their data untouched", async () => {
  const db = createDatabase({ url: ":memory:" });
  // Apply everything before 0024 by hand, as an older build would have.
  for (const m of MIGRATIONS.filter((x) => x.id < "0024")) {
    await db.batch([...m.statements], "write");
    await db.execute("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT 'x', checksum TEXT) STRICT");
    await db.execute({ sql: "INSERT INTO schema_migrations (id) VALUES (?)", args: [m.id] });
  }
  await db.execute("INSERT INTO users (id, email, role) VALUES ('u1', 'e@example.com', 'EMPLOYEE'), ('a1', 'a@example.com', 'ADMIN')");
  await db.execute("INSERT INTO employee_profiles (id, user_id, employee_code, full_name) VALUES ('p1', 'u1', 'EMP-1', 'E')");

  assert.ok((await migrate(db)).includes("0024_teams"));
  assert.equal((await db.execute("SELECT count(*) AS n FROM team_members")).rows[0]!.n, 0);
  assert.deepEqual({ ...(await db.execute("SELECT id, employee_code, full_name FROM employee_profiles")).rows[0] }, { id: "p1", employee_code: "EMP-1", full_name: "E" });
  // Profiles still update as before (no new constraint on employee_profiles).
  await db.execute("UPDATE employee_profiles SET full_name = 'E2' WHERE id = 'p1'");
  db.close();
});

test("teams: unique trimmed names, never deleted; memberships unique, FK-checked, never updated", async () => {
  const db = createDatabase({ url: ":memory:" });
  await migrate(db);
  await db.execute("INSERT INTO users (id, email, role) VALUES ('u1', 'e@example.com', 'EMPLOYEE'), ('a1', 'a@example.com', 'ADMIN')");
  await db.execute("INSERT INTO employee_profiles (id, user_id, employee_code, full_name) VALUES ('p1', 'u1', 'EMP-1', 'E')");
  const team = (id: string, name: string, head: string | null = null) =>
    db.execute({ sql: "INSERT INTO teams (id, name, head_user_id, created_by) VALUES (?, ?, ?, 'a1')", args: [id, name, head] });
  await team("t1", "Sales", "u1");
  await team("t2", "Support");
  await assert.rejects(team("t3", "sales"), (e) => isUniqueViolation(e, "teams.name"), "names are unique, any case");
  await assert.rejects(team("t4", " Ops"), /CHECK constraint/);
  await assert.rejects(team("t5", ""), /CHECK constraint/);
  await assert.rejects(team("t6", "Ops", "nobody"), /FOREIGN KEY/);
  await assert.rejects(db.execute("DELETE FROM teams WHERE id = 't1'"), (e) => guardViolation(e) === "append_only");
  await db.execute("UPDATE teams SET name = 'Sales EU', active = 0, head_user_id = NULL WHERE id = 't1'");

  const member = (teamId: string, emp: string) => db.execute({ sql: "INSERT INTO team_members (team_id, employee_id, added_by) VALUES (?, ?, 'a1')", args: [teamId, emp] });
  await member("t1", "p1");
  await member("t2", "p1"); // several teams per employee
  await assert.rejects(member("t1", "p1"), /UNIQUE|PRIMARY KEY/);
  await assert.rejects(member("t1", "missing"), /FOREIGN KEY/);
  await assert.rejects(db.execute("UPDATE team_members SET team_id = 't2' WHERE team_id = 't1'"), (e) => guardViolation(e) === "append_only");
  await db.execute("DELETE FROM team_members WHERE team_id = 't1' AND employee_id = 'p1'");
  db.close();
});
