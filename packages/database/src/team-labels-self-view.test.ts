// Migration 0027 (F05 per-team labels, F08 per-person screenshot self-view): existing tracking overrides
// survive and inherit the self-view switch (NULL); team label rows are validated and only ever ended.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatabase, guardViolation, migrate, MIGRATIONS } from "../dist/index.js";

test("0027 keeps existing tracking overrides (self-view inherits) and teams; no team labels yet", async () => {
  const db = createDatabase({ url: ":memory:" });
  for (const m of MIGRATIONS.filter((x) => x.id < "0027")) {
    await db.batch([...m.statements], "write");
    await db.execute("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT 'x', checksum TEXT) STRICT");
    await db.execute({ sql: "INSERT INTO schema_migrations (id) VALUES (?)", args: [m.id] });
  }
  await db.execute("INSERT INTO users (id, email, role) VALUES ('u1', 'e@example.com', 'EMPLOYEE'), ('a1', 'a@example.com', 'ADMIN')");
  await db.execute("INSERT INTO employee_profiles (id, user_id, employee_code, full_name) VALUES ('p1', 'u1', 'EMP-1', 'E')");
  await db.execute("INSERT INTO employee_tracking_overrides (id, employee_id, expected_start, workdays, idle_threshold_seconds, reason, changed_by) VALUES ('o1', 'p1', '10:00', '12345', 900, 'before 0027', 'a1')");
  await db.execute("INSERT INTO teams (id, name, created_by) VALUES ('t1', 'Alpha', 'a1')");
  await db.execute("INSERT INTO team_members (team_id, employee_id, added_by) VALUES ('t1', 'p1', 'a1')");
  await db.execute("INSERT INTO application_category_rules (id, match_kind, value, category, created_by) VALUES ('r1', 'NAME', 'Slack', 'NEUTRAL', 'a1')");

  assert.ok((await migrate(db)).includes("0027_team_labels_self_view"));
  const o = (await db.execute("SELECT expected_start, workdays, idle_threshold_seconds, reason, screenshot_self_view FROM employee_tracking_overrides")).rows;
  assert.deepEqual(o.map((r) => ({ ...r })), [{ expected_start: "10:00", workdays: "12345", idle_threshold_seconds: 900, reason: "before 0027", screenshot_self_view: null }]);
  assert.equal((await db.execute("SELECT count(*) AS n FROM team_members")).rows[0]!.n, 1);
  assert.equal((await db.execute("SELECT category FROM application_category_rules")).rows[0]!.category, "NEUTRAL");
  assert.equal((await db.execute("SELECT count(*) AS n FROM team_application_category_rules")).rows[0]!.n, 0, "no team labels = organisation labels apply");
  db.close();
});

test("team labels: validated, one current per team/kind/value, only ending allowed; self-view override checked", async () => {
  const db = createDatabase({ url: ":memory:" });
  await migrate(db);
  await db.execute("INSERT INTO users (id, email, role) VALUES ('u1', 'e@example.com', 'EMPLOYEE'), ('a1', 'a@example.com', 'ADMIN')");
  await db.execute("INSERT INTO employee_profiles (id, user_id, employee_code, full_name) VALUES ('p1', 'u1', 'EMP-1', 'E')");
  await db.execute("INSERT INTO teams (id, name, created_by) VALUES ('t1', 'Alpha', 'a1'), ('t2', 'Beta', 'a1')");
  const add = (id: string, team: string, value: string, category = "PRODUCTIVE", kind = "NAME") =>
    db.execute({ sql: "INSERT INTO team_application_category_rules (id, team_id, match_kind, value, category, created_by) VALUES (?, ?, ?, ?, ?, 'a1')", args: [id, team, kind, value, category] });
  await add("l1", "t1", "Slack");
  await add("l2", "t2", "slack", "UNPRODUCTIVE"); // another team: allowed
  await assert.rejects(add("l3", "t1", "SLACK"), /UNIQUE/);
  await assert.rejects(add("l4", "t1", "X", "GREAT"), /CHECK constraint/);
  await assert.rejects(add("l5", "t1", " X"), /CHECK constraint/);
  await assert.rejects(add("l6", "missing", "X"), /FOREIGN KEY/);
  await assert.rejects(db.execute("UPDATE team_application_category_rules SET category = 'NEUTRAL' WHERE id = 'l1'"), (e) => guardViolation(e) === "append_only");
  await assert.rejects(db.execute("DELETE FROM team_application_category_rules"), (e) => guardViolation(e) === "append_only");
  await db.execute("UPDATE team_application_category_rules SET ended_at = 'now', ended_by = 'a1' WHERE id = 'l1'");
  await assert.rejects(db.execute("UPDATE team_application_category_rules SET ended_at = 'later' WHERE id = 'l1'"), (e) => guardViolation(e) === "append_only");
  await add("l7", "t1", "Slack", "NEUTRAL"); // the ended row no longer blocks a new current one

  const override = (id: string, v: number | null) =>
    db.execute({ sql: "INSERT INTO employee_tracking_overrides (id, employee_id, reason, changed_by, screenshot_self_view) VALUES (?, 'p1', 'test', 'a1', ?)", args: [id, v] });
  await override("o1", 0);
  await override("o2", 1);
  await override("o3", null);
  await assert.rejects(override("o4", 2), /CHECK constraint/);
  db.close();
});
