// Migration 0023 (API-08): existing sessions survive unbound; device_id must name a real device that is never deleted.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatabase, guardViolation, migrate, MIGRATIONS } from "../dist/index.js";

test("0023 keeps existing sessions (unbound) and links new ones to real devices only", async () => {
  const db = createDatabase({ url: ":memory:" });
  await db.execute("PRAGMA foreign_keys = ON");
  // Apply everything before 0023 by hand, as an older build would have (checksums are stamped by migrate()).
  for (const m of MIGRATIONS.filter((x) => x.id < "0023")) {
    await db.batch([...m.statements], "write");
    await db.execute("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT 'x', checksum TEXT) STRICT");
    await db.execute({ sql: "INSERT INTO schema_migrations (id) VALUES (?)", args: [m.id] });
  }
  await db.execute("INSERT INTO users (id, email, role) VALUES ('u1', 'e@example.com', 'EMPLOYEE')");
  await db.execute("INSERT INTO employee_profiles (id, user_id, employee_code, full_name) VALUES ('p1', 'u1', 'EMP-1', 'E')");
  await db.execute("INSERT INTO devices (id, employee_id, device_name, platform, device_identifier) VALUES ('d1', 'p1', 'Mac', 'macos', 'h1')");
  await db.execute("INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, client) VALUES ('s1', 'u1', 'x1', '2099-01-01', 'DESKTOP'), ('s2', 'u1', 'x2', '2099-01-01', 'WEB')");

  assert.deepEqual(await migrate(db), MIGRATIONS.filter((x) => x.id >= "0023").map((x) => x.id));
  const rows = (await db.execute("SELECT id, user_id, refresh_token_hash, client, revoked_at, device_id FROM sessions ORDER BY id")).rows;
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { id: "s1", user_id: "u1", refresh_token_hash: "x1", client: "DESKTOP", revoked_at: null, device_id: null },
    { id: "s2", user_id: "u1", refresh_token_hash: "x2", client: "WEB", revoked_at: null, device_id: null },
  ]);

  await assert.rejects(db.execute("UPDATE sessions SET device_id = 'missing' WHERE id = 's2'"), /FOREIGN KEY/);
  await db.execute("UPDATE sessions SET device_id = 'd1' WHERE id = 's1'");
  await assert.rejects(db.execute("DELETE FROM devices WHERE id = 'd1'"), (e) => guardViolation(e) === "append_only");
  const plan = (await db.execute("EXPLAIN QUERY PLAN UPDATE sessions SET revoked_at = 'now' WHERE device_id = 'd1' AND revoked_at IS NULL")).rows;
  assert.ok(JSON.stringify(plan).includes("sessions_device"), "revocation by device uses the index");
  db.close();
});
