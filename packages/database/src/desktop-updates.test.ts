// Migration 0032: desktop releases, packages, append-only release history and per-device update status.
// Additive only: existing devices and sessions are untouched.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatabase, migrate, MIGRATIONS } from "../dist/index.js";

test("0032 is additive and enforces release, package and history rules", async () => {
  const db = createDatabase({ url: ":memory:" });
  await db.execute("PRAGMA foreign_keys = ON");
  for (const m of MIGRATIONS.filter((x) => x.id < "0032")) {
    await db.batch([...m.statements], "write");
    await db.execute("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT 'x', checksum TEXT) STRICT");
    await db.execute({ sql: "INSERT INTO schema_migrations (id) VALUES (?)", args: [m.id] });
  }
  await db.execute("INSERT INTO users (id, email, role) VALUES ('u1', 'e@example.com', 'EMPLOYEE')");
  await db.execute("INSERT INTO employee_profiles (id, user_id, employee_code, full_name) VALUES ('p1', 'u1', 'EMP-1', 'E')");
  await db.execute("INSERT INTO devices (id, employee_id, device_name, platform, device_identifier) VALUES ('d1', 'p1', 'Mac', 'macos', 'h1')");
  const before = (await db.execute("SELECT * FROM devices")).rows;

  assert.deepEqual(await migrate(db), ["0032_desktop_updates", "0033_notifications"]);
  assert.deepEqual((await db.execute("SELECT * FROM devices")).rows, before, "devices untouched");

  await db.execute("INSERT INTO desktop_releases (id, version) VALUES ('r1', '0.3.0')");
  await assert.rejects(db.execute("INSERT INTO desktop_releases (id, version) VALUES ('r2', '0.3.0')"), /UNIQUE/);
  await assert.rejects(db.execute("INSERT INTO desktop_releases (id, version, status) VALUES ('r3', '0.3.1', 'LIVE')"), /CHECK/);
  await assert.rejects(db.execute("INSERT INTO desktop_releases (id, version, rollout_percent) VALUES ('r4', '0.3.2', 101)"), /CHECK/);
  await db.execute("INSERT INTO desktop_release_artifacts (release_id, target, url, signature) VALUES ('r1', 'darwin-aarch64', 'https://x/a', 's')");
  await assert.rejects(db.execute("INSERT INTO desktop_release_artifacts (release_id, target, url, signature) VALUES ('r1', 'linux-x86_64', 'https://x/a', 's')"), /CHECK/);
  await assert.rejects(db.execute("INSERT INTO desktop_release_artifacts (release_id, target, url, signature) VALUES ('r1', 'darwin-aarch64', 'https://x/b', 's')"), /UNIQUE|PRIMARY/);
  await db.execute("INSERT INTO desktop_release_events (id, release_id, action) VALUES ('e1', 'r1', 'RELEASE_CREATED')");
  await assert.rejects(db.execute("UPDATE desktop_release_events SET action = 'X_X_X'"), /append_only/);
  await assert.rejects(db.execute("DELETE FROM desktop_release_events"), /append_only/);
  await db.execute("INSERT INTO desktop_update_status (device_id, installed_version, state, last_check_at) VALUES ('d1', '0.2.0', 'UP_TO_DATE', 'now')");
  await assert.rejects(db.execute("INSERT INTO desktop_update_status (device_id, installed_version, state, last_check_at) VALUES ('nope', '0.2.0', 'UP_TO_DATE', 'now')"), /FOREIGN KEY/);
  db.close();
});
