import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatabase, migrate, migrationStatus, MIGRATIONS } from "../dist/index.js";

type Db = ReturnType<typeof createDatabase>;
const ids = MIGRATIONS.map((m) => m.id);
const PENDING_AFTER_0016 = [
  "0017_work_schedule_and_app_categories", "0019_screenshot_blur_policy", "0021_leave_types", "0022_holidays", "0023_session_device",
  "0024_teams", "0025_person_overrides", "0026_alert_rules", "0027_team_labels_self_view", "0028_auto_timelapse",
  "0029_device_live_state", "0030_account_invitations", "0031_multi_device_single_session",
];

/** A database migrated by a build that ended at 0016 (staging today). MIGRATIONS is restored afterwards. */
async function at0016(): Promise<Db> {
  assert.equal(MIGRATIONS[15]!.id, "0016_data_layer_integrity");
  const db = createDatabase({ url: ":memory:" });
  const rest = MIGRATIONS.splice(16);
  try {
    await migrate(db);
  } finally {
    MIGRATIONS.push(...rest);
  }
  return db;
}

/** Everything a write could touch: schema, bookkeeping rows, and this connection's row-change counter. */
const snapshot = async (db: Db) => {
  const master = (await db.execute("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")).rows.map((r) => JSON.stringify(r));
  const hasTable = master.some((m) => m.includes('"name":"schema_migrations"'));
  const rows = hasTable ? (await db.execute("SELECT * FROM schema_migrations ORDER BY id")).rows.map((r) => JSON.stringify(r)) : [];
  const changes = Number((await db.execute("SELECT total_changes() AS n")).rows[0]!.n);
  return { master, rows, changes };
};

const counts = async (db: Db) =>
  Object.fromEntries(
    (await db.execute("SELECT type, count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' GROUP BY type")).rows.map((r) => [String(r.type), Number(r.n)]),
  );

const healthy = async (db: Db) => {
  assert.equal(String((await db.execute("PRAGMA integrity_check")).rows[0]!.integrity_check), "ok");
  assert.equal((await db.execute("PRAGMA foreign_key_check")).rows.length, 0);
};

test("fresh database: everything pending and nothing is created", async () => {
  const db = createDatabase({ url: ":memory:" });
  const before = await snapshot(db);
  assert.deepEqual(await migrationStatus(db), { applied: [], pending: ids, unknown: [], edited: [] });
  assert.deepEqual(await snapshot(db), before);
  assert.equal(before.master.length, 0, "no schema_migrations table created");
  db.close();
});

test("database at 0016: exactly the 13 later ids are pending", async () => {
  const db = await at0016();
  const status = await migrationStatus(db);
  assert.deepEqual(status.applied, ids.slice(0, 16));
  assert.deepEqual(status.pending, PENDING_AFTER_0016);
  assert.deepEqual([status.unknown, status.edited], [[], []]);
  db.close();
});

test("fully migrated: nothing pending", async () => {
  const db = createDatabase({ url: ":memory:" });
  await migrate(db);
  assert.deepEqual(await migrationStatus(db), { applied: ids, pending: [], unknown: [], edited: [] });
  db.close();
});

test("unknown id, edited checksum and NULL checksum; no writes", async () => {
  const db = createDatabase({ url: ":memory:" });
  await migrate(db);
  await db.execute("INSERT INTO schema_migrations (id, checksum) VALUES ('9999_from_a_newer_build', 'abc')");
  await db.execute("UPDATE schema_migrations SET checksum = 'edited' WHERE id = '0022_holidays'");
  await db.execute("UPDATE schema_migrations SET checksum = NULL WHERE id = '0003_correction_workflow'");
  const before = await snapshot(db);
  const status = await migrationStatus(db);
  assert.deepEqual(status.unknown, ["9999_from_a_newer_build"]);
  assert.deepEqual(status.edited, ["0022_holidays"], "a NULL checksum (pre-checksum row) is not an edit");
  assert.deepEqual(status.applied, ids);
  assert.deepEqual(status.pending, []);
  assert.deepEqual(await snapshot(db), before, "NULL checksum left unstamped; nothing written");
  db.close();
});

test("gap: a lower id missing below applied ones is reported pending", async () => {
  const db = createDatabase({ url: ":memory:" });
  await migrate(db);
  await db.execute("DELETE FROM schema_migrations WHERE id = '0022_holidays'"); // bookkeeping only
  const status = await migrationStatus(db);
  assert.deepEqual(status.pending, ["0022_holidays"]);
  assert.equal(status.applied.at(-1), ids.at(-1));
  db.close();
});

test("schema_migrations from before checksums (no checksum column): read, not edited", async () => {
  const db = createDatabase({ url: ":memory:" });
  await db.execute("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
  await db.execute("INSERT INTO schema_migrations (id, applied_at) VALUES ('0001_auth_and_employees', 'x')");
  const before = await snapshot(db);
  const status = await migrationStatus(db);
  assert.deepEqual([status.applied, status.edited, status.unknown], [["0001_auth_and_employees"], [], []]);
  assert.deepEqual(await snapshot(db), before);
  db.close();
});

test("0016 with data -> migrate applies exactly the 13, re-run none; defaults, integrity, 52/67/91", async () => {
  const db = await at0016();
  const q = (sql: string, args: (string | number)[] = []) => db.execute({ sql, args });
  const notice = String((await db.execute("SELECT version FROM monitoring_notices LIMIT 1")).rows[0]!.version);
  await q("INSERT INTO users (id, email, role, admin_title) VALUES ('a', 'admin@example.com', 'ADMIN', 'SUPER_ADMIN'), ('u', 'emp@example.com', 'EMPLOYEE', NULL)");
  await q("INSERT INTO employee_profiles (id, user_id, employee_code, full_name) VALUES ('e', 'u', 'EMP-1', 'Emp')");
  await q("INSERT INTO devices (id, employee_id, device_name, platform, device_identifier) VALUES ('d', 'e', 'Mac', 'macos', 'dev-1')");
  await q("INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, client) VALUES ('s', 'u', 'h1', '2027-01-01T00:00:00.000Z', 'DESKTOP')");
  await q("INSERT INTO leave_requests (id, employee_id, requested_by, start_date, end_date, portion) VALUES ('l1', 'e', 'u', '2026-11-10', '2026-11-10', 'FULL_DAY'), ('l2', 'e', 'u', '2026-11-11', '2026-11-11', 'FULL_DAY')");
  await q("UPDATE leave_requests SET status = 'APPROVED', decided_by = 'a', decided_at = '2026-11-02T00:00:00.000Z' WHERE id = 'l2'");
  await q(`INSERT INTO screenshot_policies (screenshots_enabled, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days, retention_approved, notice_version, reason, changed_by)
           VALUES (1, 300, 70, 1920, 'PRIMARY_DISPLAY', 30, 1, ?, 'initial', 'a')`, [notice]);
  await q(`INSERT INTO monitoring_policies (monitoring_enabled, sample_seconds, idle_threshold_seconds, retention_days, retention_approved, notice_version, reason, changed_by)
           VALUES (1, 30, 300, 30, 1, ?, 'initial', 'a')`, [notice]);
  await q("INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, status) VALUES ('as', 'e', 'd', '2026-11-02T09:00:00.000Z', 'OPEN')");
  await q(`INSERT INTO screenshots (id, employee_id, device_id, attendance_session_id, idempotency_key, captured_at, device_captured_at, width, height, mime_type,
           file_size_bytes, checksum, storage_provider, storage_key, upload_status, stored_at)
           VALUES ('sc', 'e', 'd', 'as', 'k1', '2026-11-02T09:05:00.000Z', '2026-11-02T09:05:00.000Z', 100, 100, 'image/webp', 10, ?, 'LOCAL_DEV', 'key1', 'STORED', '2026-11-02T09:05:01.000Z')`, ["a".repeat(64)]);
  await q("INSERT INTO timelapses (id, employee_id, attendance_session_id, requested_by, fps, status, frames_total) VALUES ('t', 'e', 'as', 'a', 10, 'QUEUED', 1)");

  assert.deepEqual(await migrate(db), PENDING_AFTER_0016);
  assert.deepEqual(await migrate(db), []);
  assert.deepEqual((await migrationStatus(db)).pending, []);

  const one = async (sql: string) => ({ ...(await db.execute(sql)).rows[0] });
  const general = "00000000-0000-4000-8000-000000000001";
  assert.deepEqual((await db.execute("SELECT leave_type_id FROM leave_requests ORDER BY id")).rows.map((r) => r.leave_type_id), [general, general], "backfilled, decided row included");
  assert.deepEqual(await one("SELECT blur, auto_timelapse FROM screenshot_policies"), { blur: 0, auto_timelapse: 0 });
  assert.deepEqual(await one("SELECT blurred FROM screenshots"), { blurred: 0 });
  assert.deepEqual(await one("SELECT automatic FROM timelapses"), { automatic: 0 });
  // 0029: no live report and no delete reason on existing rows; the new values are checked.
  assert.deepEqual(await one("SELECT activity_state, activity_state_since, activity_state_at, screenshot_state, screenshot_state_at FROM devices"),
    { activity_state: null, activity_state_since: null, activity_state_at: null, screenshot_state: null, screenshot_state_at: null });
  assert.deepEqual(await one("SELECT deleted_reason FROM screenshots"), { deleted_reason: null });
  await assert.rejects(q("UPDATE devices SET activity_state = 'TYPING'"), /CHECK/);
  await assert.rejects(q("UPDATE devices SET screenshot_state = 'BROKEN'"), /CHECK/);
  await q("UPDATE devices SET activity_state = 'IDLE', screenshot_state = 'PERMISSION_DENIED'");
  assert.deepEqual(await one("SELECT idle_excluded_apps FROM monitoring_policies"), { idle_excluded_apps: "[]" });
  assert.deepEqual(await one("SELECT device_id FROM sessions"), { device_id: null });

  // 0021: the AFTER INSERT default passes leave_requests_decide_once, even for a row inserted decided;
  // a decided row stays frozen and a type never goes back to NULL.
  await q("INSERT INTO leave_requests (id, employee_id, requested_by, start_date, end_date, portion, status, decided_by, decided_at) VALUES ('l3', 'e', 'u', '2026-11-12', '2026-11-12', 'FULL_DAY', 'APPROVED', 'a', '2026-11-03T00:00:00.000Z')");
  assert.deepEqual(await one("SELECT leave_type_id FROM leave_requests WHERE id = 'l3'"), { leave_type_id: general });
  await assert.rejects(q("UPDATE leave_requests SET reason = 'changed' WHERE id = 'l2'"), /already_reviewed/);
  await assert.rejects(q("UPDATE leave_requests SET leave_type_id = NULL WHERE id = 'l1'"), /already_reviewed/);
  await q("UPDATE leave_requests SET status = 'APPROVED', decided_by = 'a', decided_at = '2026-11-03T00:00:00.000Z' WHERE id = 'l1'");
  // 0019: blurred joined the immutable screenshot columns.
  await assert.rejects(q("UPDATE screenshots SET blurred = 1"), /screenshot_immutable/);

  await healthy(db);
  assert.deepEqual(await counts(db), { table: 52, index: 67, trigger: 91 });
  db.close();
});

test("0016 reference counts: 39 tables, 53 indexes, 73 triggers", async () => {
  const db = await at0016();
  assert.deepEqual(await counts(db), { table: 39, index: 53, trigger: 73 });
  await healthy(db);
  db.close();
});
