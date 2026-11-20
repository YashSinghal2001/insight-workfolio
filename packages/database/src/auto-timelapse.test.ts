// Migration 0028 (F01 automatic daily timelapses): existing screenshot policy versions and timelapse
// jobs survive unchanged, with the setting off and every existing job marked manual.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatabase, migrate, MIGRATIONS } from "../dist/index.js";

test("0028 keeps existing screenshot policies (auto off) and timelapses (manual); values are checked", async () => {
  const db = createDatabase({ url: ":memory:" });
  for (const m of MIGRATIONS.filter((x) => x.id < "0028")) {
    await db.batch([...m.statements], "write");
    await db.execute("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT 'x', checksum TEXT) STRICT");
    await db.execute({ sql: "INSERT INTO schema_migrations (id) VALUES (?)", args: [m.id] });
  }
  await db.execute("INSERT INTO users (id, email, role) VALUES ('u1', 'e@example.com', 'EMPLOYEE'), ('a1', 'a@example.com', 'ADMIN')");
  await db.execute("INSERT INTO employee_profiles (id, user_id, employee_code, full_name) VALUES ('p1', 'u1', 'EMP-1', 'E')");
  await db.execute("INSERT INTO devices (id, employee_id, device_name, platform, device_identifier) VALUES ('d1', 'p1', 'Mac', 'macos', 'h')");
  await db.execute("INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, clock_out_at, status) VALUES ('s1', 'p1', 'd1', '2026-10-12T09:00:00.000Z', '2026-10-12T17:00:00.000Z', 'CLOSED')");
  await db.execute(`INSERT INTO screenshot_policies (screenshots_enabled, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
    retention_approved, notice_version, reason, changed_by) VALUES (1, 300, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, '2026-10-screenshots-draft-1', 'before 0028', 'a1')`);
  await db.execute("INSERT INTO timelapses (id, employee_id, attendance_session_id, requested_by, fps, status, frames_total) VALUES ('t1', 'p1', 's1', 'a1', 8, 'QUEUED', 10)");

  assert.deepEqual(await migrate(db), ["0028_auto_timelapse", "0029_device_live_state", "0030_account_invitations", "0031_multi_device_single_session", "0032_desktop_updates", "0033_notifications", "0035_report_schedule_kinds"]);
  const p = (await db.execute("SELECT interval_seconds, reason, auto_timelapse FROM screenshot_policies")).rows;
  assert.deepEqual(p.map((r) => ({ ...r })), [{ interval_seconds: 300, reason: "before 0028", auto_timelapse: 0 }]);
  const t = (await db.execute("SELECT id, status, frames_total, automatic FROM timelapses")).rows;
  assert.deepEqual(t.map((r) => ({ ...r })), [{ id: "t1", status: "QUEUED", frames_total: 10, automatic: 0 }]);

  await assert.rejects(db.execute("UPDATE timelapses SET automatic = 2 WHERE id = 't1'"), /CHECK constraint/);
  await assert.rejects(
    db.execute(`INSERT INTO screenshot_policies (screenshots_enabled, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
      retention_approved, notice_version, reason, changed_by, auto_timelapse) VALUES (1, 300, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, '2026-10-screenshots-draft-1', 'x', 'a1', 5)`),
    /CHECK constraint/,
  );
  db.close();
});
