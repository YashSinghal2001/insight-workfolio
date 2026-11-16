// Migration 0031: several devices per employee, at most one live device-bound session per account.
// Existing rows survive: no device or audit row is touched, no live session is revoked.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatabase, migrate, MIGRATIONS } from "../dist/index.js";

test("0031 keeps existing data, allows many devices and enforces one live device sign-in", async () => {
  const db = createDatabase({ url: ":memory:" });
  await db.execute("PRAGMA foreign_keys = ON");
  for (const m of MIGRATIONS.filter((x) => x.id < "0031")) {
    await db.batch([...m.statements], "write");
    await db.execute("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT 'x', checksum TEXT) STRICT");
    await db.execute({ sql: "INSERT INTO schema_migrations (id) VALUES (?)", args: [m.id] });
  }
  await db.execute("INSERT INTO users (id, email, role) VALUES ('u1', 'e@example.com', 'EMPLOYEE')");
  await db.execute("INSERT INTO employee_profiles (id, user_id, employee_code, full_name) VALUES ('p1', 'u1', 'EMP-1', 'E')");
  await db.execute("INSERT INTO devices (id, employee_id, device_name, platform, device_identifier, revoked_at) VALUES ('old', 'p1', 'Old', 'windows', 'h0', '2026-01-01')");
  await db.execute("INSERT INTO devices (id, employee_id, device_name, platform, device_identifier) VALUES ('d1', 'p1', 'Mac', 'macos', 'h1')");
  // Before 0031 the old index allowed only one unrevoked device.
  await assert.rejects(db.execute("INSERT INTO devices (id, employee_id, device_name, platform, device_identifier) VALUES ('d2', 'p1', 'PC', 'windows', 'h2')"), /UNIQUE/);
  // Two live sessions bound to d1 (repeat sign-ins), one expired bound session, one web session.
  await db.execute(`INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, client, device_id, created_at, refreshed_at) VALUES
    ('s-old', 'u1', 'x1', '2099-01-01', 'DESKTOP', 'd1', '2026-10-01', '2026-10-02'),
    ('s-new', 'u1', 'x2', '2099-01-01', 'DESKTOP', 'd1', '2026-10-01', '2026-11-01'),
    ('s-exp', 'u1', 'x3', '2026-01-01', 'DESKTOP', 'd1', '2025-12-01', NULL),
    ('s-web', 'u1', 'x4', '2099-01-01', 'WEB', NULL, '2026-10-01', NULL)`);
  await db.execute("INSERT INTO account_audit (id, actor_user_id, target_user_id, action, resource_type, resource_id) VALUES ('a1', 'admin', 'u1', 'DEVICE_REVOKED', 'DEVICE', 'old')");

  assert.deepEqual(await migrate(db), MIGRATIONS.filter((x) => x.id >= "0031").map((x) => x.id));

  const sessions = Object.fromEntries((await db.execute("SELECT id, device_id, revoked_at FROM sessions")).rows.map((r) => [r.id, { device: r.device_id, revoked: r.revoked_at }]));
  assert.deepEqual(sessions, {
    "s-old": { device: null, revoked: null }, // unbound, still signed in
    "s-new": { device: "d1", revoked: null }, // most recently used keeps the device
    "s-exp": { device: "d1", revoked: "2026-01-01" }, // ended when it expired
    "s-web": { device: null, revoked: null },
  });
  assert.equal(Number((await db.execute("SELECT count(*) AS n FROM devices")).rows[0]!.n), 2, "no device row touched");
  assert.equal((await db.execute("SELECT revoked_at FROM devices WHERE id = 'old'")).rows[0]!.revoked_at, "2026-01-01");
  assert.equal(Number((await db.execute("SELECT count(*) AS n FROM account_audit")).rows[0]!.n), 1, "audit kept");

  // Many devices now; still one record per installation per employee.
  await db.execute("INSERT INTO devices (id, employee_id, device_name, platform, device_identifier) VALUES ('d2', 'p1', 'PC', 'windows', 'h2'), ('d3', 'p1', 'PC 2', 'windows', 'h3')");
  await assert.rejects(db.execute("INSERT INTO devices (id, employee_id, device_name, platform, device_identifier) VALUES ('d4', 'p1', 'Dup', 'macos', 'h1')"), /UNIQUE/);

  // A second live device sign-in for the account is impossible, whatever the device.
  await assert.rejects(db.execute("INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, client, device_id) VALUES ('s2', 'u1', 'y', '2099-01-01', 'DESKTOP', 'd2')"), /UNIQUE constraint failed: sessions.user_id/);
  await assert.rejects(db.execute("UPDATE sessions SET device_id = 'd3' WHERE id = 's-web'"), /UNIQUE/);
  // Once it ends (logout / revoke), another device may hold it.
  await db.execute("UPDATE sessions SET revoked_at = '2026-11-16' WHERE id = 's-new'");
  await db.execute("INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, client, device_id) VALUES ('s2', 'u1', 'y', '2099-01-01', 'DESKTOP', 'd2')");
  db.close();
});
