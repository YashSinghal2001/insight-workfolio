import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatabase, enableWal, foreignKeysEnforced, guardViolation, isUniqueViolation, journalMode, migrate, MIGRATIONS, pingDatabase, schemaVersion } from "../dist/index.js";

test("pings an in-memory database", async () => {
  const db = createDatabase({ url: ":memory:" });
  assert.ok((await pingDatabase(db)) >= 0);
  db.close();
});

test("refuses remote URLs without an auth token", () => {
  assert.throws(() => createDatabase({ url: "libsql://example.turso.io" }), /AUTH_TOKEN/);
});

test("migrations apply once and are repeatable", async () => {
  const db = createDatabase({ url: ":memory:" });
  assert.deepEqual(await migrate(db), MIGRATIONS.map((m) => m.id));
  assert.deepEqual(await migrate(db), [], "second run is a no-op");
  const tables = (await db.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).rows.map(
    (r) => r.name,
  );
  for (const t of [
    "users", "employee_profiles", "devices", "sessions", "account_setup_tokens", "schema_migrations",
    "attendance_sessions", "break_sessions", "attendance_events", "attendance_corrections",
    "correction_requests", "monitoring_consents", "activity_intervals",
    "monitoring_notices", "monitoring_policies", "activity_retention_runs",
    "screenshot_policies", "screenshots", "screenshot_access_log", "screenshot_retention_runs",
    "timelapses", "timelapse_access_log", "leave_requests",
    "projects", "project_tasks", "project_members", "task_time_entries", "project_audit",
    "report_schedules", "report_recipients", "report_runs", "report_deliveries", "report_delivery_attempts",
    "website_policies", "website_extension_links", "website_intervals", "website_category_rules", "website_audit", "role_changes", "account_audit",
    "work_schedule_policies", "application_category_rules", "activity_category_audit",
  ]) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  db.close();
});

test("schema constraints: unique email/code, normalized email, valid enums, foreign keys", async () => {
  const db = createDatabase({ url: ":memory:" });
  await migrate(db);
  const user = (id: string, email: string, role = "EMPLOYEE") =>
    db.execute({ sql: "INSERT INTO users (id, email, role) VALUES (?, ?, ?)", args: [id, email, role] });
  const profile = (id: string, userId: string, code: string) =>
    db.execute({
      sql: "INSERT INTO employee_profiles (id, user_id, employee_code, full_name) VALUES (?, ?, ?, 'X')",
      args: [id, userId, code],
    });

  await user("u1", "a@example.com");
  await assert.rejects(user("u2", "a@example.com"), (e) => isUniqueViolation(e, "users.email"));
  await assert.rejects(user("u3", "B@example.com"), /CHECK constraint/, "email must be stored lowercase");
  await assert.rejects(user("u4", "c@example.com", "OWNER"), /CHECK constraint/);

  await user("u5", "d@example.com");
  await profile("p1", "u1", "EMP-1");
  await assert.rejects(profile("p2", "u5", "EMP-1"), (e) => isUniqueViolation(e, "employee_profiles.employee_code"));
  await assert.rejects(profile("p3", "missing-user", "EMP-3"), /FOREIGN KEY/);

  const p = (await db.execute("SELECT timezone, employment_status, created_at FROM employee_profiles")).rows[0]!;
  assert.equal(p.timezone, "Asia/Kolkata");
  assert.equal(p.employment_status, "ACTIVE");
  assert.match(String(p.created_at), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, "UTC ISO-8601");
  db.close();
});

test("attendance guards: one record per installation, no overlapping sessions or breaks, no silent overwrites", async () => {
  const db = createDatabase({ url: ":memory:" });
  await migrate(db);
  const run = (sql: string, ...args: (string | null)[]) => db.execute({ sql, args });
  const guard = (reason: string) => (e: unknown) => guardViolation(e) === reason;
  await run("INSERT INTO users (id, email, role) VALUES ('u1', 'a@example.com', 'EMPLOYEE')");
  await run("INSERT INTO employee_profiles (id, user_id, employee_code, full_name) VALUES ('e1', 'u1', 'E1', 'A')");
  const device = (id: string, ident: string) =>
    run("INSERT INTO devices (id, employee_id, device_name, platform, device_identifier) VALUES (?, 'e1', 'Mac', 'macos', ?)", id, ident);
  await device("d1", "h1");
  // 0031: several devices per employee; still one record per installation.
  await device("d2", "h2");
  await assert.rejects(device("d3", "h1"), (e) => isUniqueViolation(e), "same installation twice");
  await run("UPDATE devices SET revoked_at = '2026-10-12T00:00:00.000Z' WHERE id = 'd1'");

  const session = (id: string, start: string, end: string | null = null) =>
    run(
      "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, clock_out_at, status) VALUES (?, 'e1', 'd2', ?, ?, ?)",
      id, start, end, end ? "CLOSED" : "OPEN",
    );
  await session("s1", "2026-10-12T09:00:00.000Z", "2026-10-12T17:00:00.000Z");
  await assert.rejects(session("s2", "2026-10-12T16:00:00.000Z"), guard("attendance_overlap"));
  await assert.rejects(session("s2", "2026-10-12T08:00:00.000Z", "2026-10-12T09:30:00.000Z"), guard("attendance_overlap"));
  await session("s2", "2026-10-12T17:00:00.000Z"); // back-to-back is fine
  await assert.rejects(session("s3", "2026-10-13T09:00:00.000Z"), guard("attendance_overlap"), "second open session");

  const brk = (id: string, start: string, end: string | null = null) =>
    run(
      "INSERT INTO break_sessions (id, attendance_session_id, started_at, ended_at, status) VALUES (?, ?, ?, ?, ?)",
      id, id.startsWith("x") ? "s1" : "s2", start, end, end ? "CLOSED" : "OPEN",
    );
  await assert.rejects(brk("x1", "2026-10-12T10:00:00.000Z"), guard("break_overlap"), "break in a closed session");
  await assert.rejects(brk("b0", "2026-10-12T16:59:00.000Z"), guard("break_overlap"), "break before clock-in");
  await brk("b1", "2026-10-12T18:00:00.000Z", "2026-10-12T18:30:00.000Z");
  await assert.rejects(brk("b2", "2026-10-12T18:15:00.000Z"), guard("break_overlap"));
  await brk("b2", "2026-10-12T19:00:00.000Z");
  const clockOut = () =>
    run("UPDATE attendance_sessions SET clock_out_at = '2026-10-12T20:00:00.000Z', status = 'CLOSED' WHERE id = 's2'");
  await assert.rejects(clockOut(), guard("break_open"));
  await run("UPDATE break_sessions SET ended_at = '2026-10-12T19:10:00.000Z', status = 'CLOSED' WHERE id = 'b2'");
  await assert.rejects(run("UPDATE break_sessions SET ended_at = '2026-10-12T19:20:00.000Z' WHERE id = 'b2'"), guard("attendance_immutable"));
  await clockOut();
  await assert.rejects(
    run("UPDATE attendance_sessions SET clock_out_at = '2026-10-12T21:00:00.000Z' WHERE id = 's2'"),
    guard("attendance_immutable"),
    "closed sessions cannot be overwritten",
  );

  await run(
    `INSERT INTO attendance_events (id, employee_id, device_id, event_type, occurred_at, received_at, idempotency_key, source, outcome)
     VALUES ('ev1', 'e1', 'd2', 'CLOCK_IN', '2026-10-12T17:00:00.000Z', '2026-10-12T17:00:00.000Z', 'k1', 'ONLINE', 'ACCEPTED')`,
  );
  await assert.rejects(run("UPDATE attendance_events SET outcome = 'REJECTED' WHERE id = 'ev1'"), guard("append_only"));
  await assert.rejects(run("DELETE FROM attendance_events"), guard("append_only"));

  await run("INSERT INTO users (id, email, role) VALUES ('admin', 'b@example.com', 'ADMIN')");
  const correction = (reason: string, approvedBy: string | null = null) =>
    run(
      `INSERT INTO attendance_corrections (id, attendance_session_id, requested_by, approved_by, original_values, corrected_values, reason)
       VALUES (lower(hex(randomblob(8))), 's1', 'admin', ?, '{}', '{"clockOutAt":"x"}', ?)`,
      approvedBy, reason,
    );
  await assert.rejects(correction("  "), /CHECK constraint/, "reason required");
  await assert.rejects(correction("forgot to clock out", "admin"), /CHECK constraint/, "no self-approval");
  await correction("forgot to clock out");
  await assert.rejects(run("UPDATE attendance_corrections SET reason = 'edited'"), guard("append_only"));
  await assert.rejects(run("DELETE FROM attendance_corrections"), guard("append_only"));
  db.close();
});

test("corrections: closed records change only together with a new approved audit row; requests are reviewed once", async () => {
  const db = createDatabase({ url: ":memory:" });
  await migrate(db);
  const run = (sql: string, ...args: (string | null)[]) => db.execute({ sql, args });
  const guard = (reason: string) => (e: unknown) => guardViolation(e) === reason;
  await run("INSERT INTO users (id, email, role) VALUES ('u1', 'a@example.com', 'EMPLOYEE'), ('adm', 'b@example.com', 'ADMIN')");
  await run("INSERT INTO employee_profiles (id, user_id, employee_code, full_name) VALUES ('e1', 'u1', 'E1', 'A')");
  await run("INSERT INTO devices (id, employee_id, device_name, platform, device_identifier) VALUES ('d1', 'e1', 'Mac', 'macos', 'h')");
  // Built the way the app does it: open, break, close.
  await run("INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, status) VALUES ('s1', 'e1', 'd1', '2026-10-12T09:00:00.000Z', 'OPEN')");
  await run(`INSERT INTO break_sessions (id, attendance_session_id, started_at, ended_at, status)
             VALUES ('b1', 's1', '2026-10-12T12:00:00.000Z', '2026-10-12T12:30:00.000Z', 'CLOSED')`);
  await run("UPDATE attendance_sessions SET clock_out_at = '2026-10-12T17:00:00.000Z', status = 'CLOSED' WHERE id = 's1'");
  await run(`INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, clock_out_at, status)
             VALUES ('s2', 'e1', 'd1', '2026-10-13T09:00:00.000Z', '2026-10-13T17:00:00.000Z', 'CLOSED')`);

  const request = (id: string, requestedBy = "u1") =>
    run(`INSERT INTO correction_requests (id, employee_id, requested_by, type, attendance_session_id, proposed, reason)
         VALUES (?, 'e1', ?, 'ATTENDANCE_TIME', 's1', '{"clockOutAt":"2026-10-12T18:00:00.000Z"}', 'Stayed late')`, id, requestedBy);
  const audit = (id: string, session: string, approvedBy: string | null) =>
    run(`INSERT INTO attendance_corrections (id, attendance_session_id, requested_by, approved_by, original_values, corrected_values, reason, request_id)
         VALUES (?, ?, 'u1', ?, '{}', '{}', 'Stayed late', 'r1')`, id, session, approvedBy);
  const setOut = (out: string, correction: string | null) =>
    run("UPDATE attendance_sessions SET clock_out_at = ?, correction_id = ? WHERE id = 's1'", out, correction);

  await request("r1");
  await assert.rejects(setOut("2026-10-12T18:00:00.000Z", null), guard("attendance_immutable"), "no correction");
  await audit("c0", "s1", null);
  await assert.rejects(setOut("2026-10-12T18:00:00.000Z", "c0"), guard("attendance_immutable"), "unapproved correction");
  await audit("cx", "s2", "adm");
  await assert.rejects(setOut("2026-10-12T18:00:00.000Z", "cx"), guard("attendance_immutable"), "correction for another session");
  await audit("c1", "s1", "adm");
  await assert.rejects(setOut("2026-10-13T10:00:00.000Z", "c1"), guard("attendance_overlap"), "still no overlaps");
  await setOut("2026-10-12T18:00:00.000Z", "c1");
  await assert.rejects(setOut("2026-10-12T19:00:00.000Z", "c1"), guard("attendance_immutable"), "one audit row authorizes one change");
  await assert.rejects(
    run("UPDATE break_sessions SET ended_at = '2026-10-12T19:00:00.000Z', correction_id = 'c1' WHERE id = 'b1'"),
    guard("break_overlap"),
    "break must stay inside the session",
  );
  await audit("c2", "s1", "adm");
  await assert.rejects(
    run("UPDATE attendance_sessions SET clock_in_at = '2026-10-12T12:15:00.000Z', correction_id = 'c2' WHERE id = 's1'"),
    guard("break_overlap"),
    "clock-in after a break start",
  );

  const review = (status: string, by: string, why: string | null) =>
    run("UPDATE correction_requests SET status = ?, reviewed_by = ?, reviewed_at = '2026-10-14T00:00:00.000Z', review_reason = ? WHERE id = 'r1'", status, by, why);
  await assert.rejects(review("APPROVED", "u1", "self"), /CHECK constraint/, "reviewer must differ from requester");
  await assert.rejects(review("REJECTED", "adm", null), /CHECK constraint/, "rejection needs a reason");
  await review("APPROVED", "adm", "Confirmed by manager");
  await assert.rejects(review("APPROVED", "adm", "again"), guard("already_reviewed"), "no duplicate approval");
  await assert.rejects(review("REJECTED", "adm", "changed mind"), guard("already_reviewed"));
  await assert.rejects(run("DELETE FROM correction_requests"), guard("append_only"));
  db.close();
});

test("activity: valid kinds/apps only, no overlaps per employee, append-only; consent once per version", async () => {
  const db = createDatabase({ url: ":memory:" });
  await migrate(db);
  const run = (sql: string, ...args: (string | number | null)[]) => db.execute({ sql, args });
  await run("INSERT INTO users (id, email, role) VALUES ('u1', 'a@example.com', 'EMPLOYEE')");
  await run("INSERT INTO employee_profiles (id, user_id, employee_code, full_name) VALUES ('e1', 'u1', 'E1', 'A')");
  await run("INSERT INTO devices (id, employee_id, device_name, platform, device_identifier) VALUES ('d1', 'e1', 'Mac', 'macos', 'h')");
  await run("INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, status) VALUES ('s1', 'e1', 'd1', '2026-10-12T09:00:00.000Z', 'OPEN')");
  let n = 0;
  const add = (kind: string, start: string, end: string, app: string | null, active: number, idle: number) =>
    run(
      `INSERT INTO activity_intervals (id, employee_id, device_id, attendance_session_id, kind, application_identifier, application_name,
         started_at, ended_at, active_seconds, idle_seconds, source, device_started_at, received_at, idempotency_key)
       VALUES (?, 'e1', 'd1', 's1', ?, ?, ?, ?, ?, ?, ?, 'DESKTOP_MACOS', ?, ?, ?)`,
      `a${++n}`, kind, app && `id.${app}`, app, start, end, active, idle, start, end, `k${n}`,
    );
  await add("ACTIVE", "2026-10-12T09:00:00.000Z", "2026-10-12T09:10:00.000Z", "Code", 600, 0);
  await add("IDLE", "2026-10-12T09:10:00.000Z", "2026-10-12T09:20:00.000Z", null, 0, 600);
  await assert.rejects(add("ACTIVE", "2026-10-12T09:05:00.000Z", "2026-10-12T09:06:00.000Z", "Safari", 60, 0), (e) => guardViolation(e) === "activity_overlap");
  await assert.rejects(add("IDLE", "2026-10-12T09:30:00.000Z", "2026-10-12T09:31:00.000Z", "Safari", 0, 60), /CHECK constraint/, "idle carries no app");
  await assert.rejects(add("ACTIVE", "2026-10-12T09:30:00.000Z", "2026-10-12T09:31:00.000Z", null, 60, 0), /CHECK constraint/, "active needs an app");
  await assert.rejects(add("ACTIVE", "2026-10-12T09:31:00.000Z", "2026-10-12T09:30:00.000Z", "Code", 60, 0), /CHECK constraint/, "positive duration");
  await assert.rejects(run("UPDATE activity_intervals SET application_name = 'Other'"), (e) => guardViolation(e) === "append_only");

  const v1 = String((await db.execute("SELECT version FROM monitoring_notices LIMIT 1")).rows[0]!.version); // a published notice (0016)
  await run(`INSERT INTO monitoring_consents (id, employee_id, notice_version) VALUES ('c1', 'e1', '${v1}')`);
  await assert.rejects(run(`INSERT INTO monitoring_consents (id, employee_id, notice_version) VALUES ('c2', 'e1', '${v1}')`), (e) => isUniqueViolation(e));
  await assert.rejects(run("DELETE FROM monitoring_consents"), (e) => guardViolation(e) === "append_only");
  db.close();
});

test("monitoring policy history: seeded notice, constrained settings, append-only; 24 h interval cap; overlap check stays cheap", async () => {
  const db = createDatabase({ url: ":memory:" });
  await migrate(db);
  const run = (sql: string, ...args: (string | number | null)[]) => db.execute({ sql, args });
  const notice = (await run("SELECT title, json_array_length(points) AS n, draft FROM monitoring_notices WHERE version = '2026-10-draft-1'")).rows[0]!;
  assert.deepEqual([notice.title, notice.n, notice.draft], ["Activity monitoring on this computer", 5, 1], "Day 5 notice seeded verbatim");
  await assert.rejects(run("UPDATE monitoring_notices SET title = 'x'"), (e) => guardViolation(e) === "append_only");
  await assert.rejects(run("INSERT INTO monitoring_notices (version, title, points, draft) VALUES ('v2', 't', '[]', 0)"), /CHECK constraint/, "needs points");

  await run("INSERT INTO users (id, email, role) VALUES ('a1', 'admin@example.com', 'ADMIN')");
  const policy = (sample: number, idle: number, retention: number, notice = "2026-10-draft-1") =>
    run(
      `INSERT INTO monitoring_policies (monitoring_enabled, sample_seconds, idle_threshold_seconds, retention_days, retention_approved, notice_version, reason, changed_by)
       VALUES (1, ?, ?, ?, 0, ?, 'test', 'a1')`,
      sample, idle, retention, notice,
    );
  await policy(15, 300, 30);
  await assert.rejects(policy(4, 300, 30), /CHECK constraint/, "sampling too fast");
  await assert.rejects(policy(15, 20, 30), /CHECK constraint/, "idle threshold too short");
  await assert.rejects(policy(60, 90, 30), /CHECK constraint/, "idle threshold below two samples");
  await assert.rejects(policy(15, 300, 3), /CHECK constraint/, "retention too short");
  await assert.rejects(policy(15, 300, 30, "unknown"), /FOREIGN KEY/, "notice must exist");
  await assert.rejects(run("DELETE FROM monitoring_policies"), (e) => guardViolation(e) === "append_only");
  await run("INSERT INTO activity_retention_runs (id, cutoff, retention_days, deleted) VALUES ('r1', '2026-09-01T00:00:00.000Z', 30, 0)");
  await assert.rejects(run("DELETE FROM activity_retention_runs"), (e) => guardViolation(e) === "append_only");

  await run("INSERT INTO users (id, email, role) VALUES ('u1', 'e@example.com', 'EMPLOYEE')");
  await run("INSERT INTO employee_profiles (id, user_id, employee_code, full_name) VALUES ('e1', 'u1', 'E1', 'A')");
  await run("INSERT INTO devices (id, employee_id, device_name, platform, device_identifier) VALUES ('d1', 'e1', 'Mac', 'macos', 'h')");
  await run("INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, status) VALUES ('s1', 'e1', 'd1', '2026-01-01T00:00:00.000Z', 'OPEN')");
  const insert = (id: number, start: number, end: number) => ({
    sql: `INSERT INTO activity_intervals (id, employee_id, device_id, attendance_session_id, kind, application_identifier, application_name,
            started_at, ended_at, active_seconds, idle_seconds, source, device_started_at, received_at, idempotency_key)
          VALUES (?, 'e1', 'd1', 's1', 'ACTIVE', 'id.App', 'App', ?, ?, 1, 0, 'DESKTOP_MACOS', ?, ?, ?)`,
    args: [`i${id}`, new Date(start).toISOString(), new Date(end).toISOString(), new Date(start).toISOString(), new Date(end).toISOString(), `k${id}`],
  });
  const t0 = Date.parse("2026-01-01T00:00:00.000Z");
  await assert.rejects(db.execute(insert(0, t0, t0 + 24 * 3_600_000 + 1)), (e) => guardViolation(e) === "activity_too_long");

  // 20,000 chronological intervals (about two months of heavy app switching).
  const N = 20_000;
  const started = performance.now();
  for (let b = 0; b < N; b += 1000) {
    await db.batch(Array.from({ length: 1000 }, (_, i) => insert(b + i + 1, t0 + (b + i) * 15_000, t0 + (b + i + 1) * 15_000)), "write");
  }
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 10_000, `inserts took ${Math.round(elapsed)} ms`);
  const plan = (await db.execute("EXPLAIN QUERY PLAN SELECT 1 FROM activity_intervals WHERE employee_id = 'e1' AND started_at < 'x' AND ended_at > 'y'")).rows.map((r) => String(r.detail));
  assert.ok(plan.some((d) => d.includes("activity_intervals_employee_ended")), `overlap search uses the end-time index: ${plan}`);
  await assert.rejects(db.execute(insert(N + 1, t0 + 100 * 15_000 + 1, t0 + 100 * 15_000 + 2)), (e) => guardViolation(e) === "activity_overlap", "still detected deep in history");
  db.close();
});

test("screenshots: metadata only, constrained, identity immutable, forward-only status, never deleted; access log append-only", async () => {
  const db = createDatabase({ url: ":memory:" });
  await migrate(db);
  const run = (sql: string, ...args: (string | number | null)[]) => db.execute({ sql, args });
  const notice = (await run("SELECT draft FROM monitoring_notices WHERE version = '2026-10-screenshots-draft-1'")).rows[0];
  assert.equal(notice?.draft, 1, "screenshot notice seeded as a draft");
  await run("INSERT INTO users (id, email, role) VALUES ('a1', 'admin@example.com', 'ADMIN')");
  const policy = (interval: number, quality: number, scope = "PRIMARY_DISPLAY") =>
    run(
      `INSERT INTO screenshot_policies (screenshots_enabled, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
         retention_approved, notice_version, reason, changed_by) VALUES (1, ?, ?, 1920, ?, 30, 0, '2026-10-screenshots-draft-1', 'test', 'a1')`,
      interval, quality, scope,
    );
  await policy(300, 70);
  await assert.rejects(policy(10, 70), /CHECK constraint/, "interval too short");
  await assert.rejects(policy(300, 100), /CHECK constraint/, "quality out of range");
  await assert.rejects(policy(300, 70, "ALL_DISPLAYS"), /CHECK constraint/, "primary display only");
  await assert.rejects(run("UPDATE screenshot_policies SET interval_seconds = 60"), (e) => guardViolation(e) === "append_only");

  await run("INSERT INTO users (id, email, role) VALUES ('u1', 'e@example.com', 'EMPLOYEE')");
  await run("INSERT INTO employee_profiles (id, user_id, employee_code, full_name) VALUES ('e1', 'u1', 'E1', 'A')");
  await run("INSERT INTO devices (id, employee_id, device_name, platform, device_identifier) VALUES ('d1', 'e1', 'Mac', 'macos', 'h')");
  await run("INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, status) VALUES ('s1', 'e1', 'd1', '2026-10-13T09:00:00.000Z', 'OPEN')");
  const shot = (id: string, key: string, mime = "image/webp", size = 1000) =>
    run(
      `INSERT INTO screenshots (id, employee_id, device_id, attendance_session_id, idempotency_key, captured_at, device_captured_at,
         width, height, mime_type, file_size_bytes, checksum, storage_provider, storage_key, upload_status)
       VALUES (?, 'e1', 'd1', 's1', ?, '2026-10-13T10:00:00.000Z', '2026-10-13T10:00:00.000Z', 1920, 1080, ?, ?, ?, 'MICROSOFT_GRAPH', ?, 'REGISTERED')`,
      id, `k-${id}`, mime, size, "a".repeat(64), key,
    );
  await shot("s-1", "screenshots/e1/2026-10/s-1.webp");
  await assert.rejects(shot("s-2", "screenshots/e1/2026-10/s-1.webp"), (e) => isUniqueViolation(e), "storage key unique");
  await assert.rejects(shot("s-3", "k3", "image/png"), /CHECK constraint/, "WebP only");
  await assert.rejects(shot("s-4", "k4", "image/webp", 20 * 1024 * 1024), /CHECK constraint/, "size cap");
  await assert.rejects(run("UPDATE screenshots SET upload_status = 'STORED'"), /CHECK constraint/, "stored needs stored_at");
  await assert.rejects(run("UPDATE screenshots SET checksum = ?", "b".repeat(64)), (e) => guardViolation(e) === "screenshot_immutable");
  await assert.rejects(run("UPDATE screenshots SET captured_at = '2026-10-13T11:00:00.000Z'"), (e) => guardViolation(e) === "screenshot_immutable");
  await run("UPDATE screenshots SET upload_status = 'STORED', stored_at = '2026-10-13T10:00:05.000Z', storage_item_id = 'item'");
  await assert.rejects(run("UPDATE screenshots SET upload_status = 'REGISTERED'"), (e) => guardViolation(e) === "screenshot_transition");
  await assert.rejects(run("UPDATE screenshots SET upload_status = 'DELETED'"), /CHECK constraint/, "deleted needs deleted_at");
  await run("UPDATE screenshots SET upload_status = 'DELETED', deleted_at = '2026-11-13T00:00:00.000Z'");
  await assert.rejects(run("UPDATE screenshots SET upload_status = 'STORED', deleted_at = NULL"), (e) => guardViolation(e) === "screenshot_transition");
  await assert.rejects(run("DELETE FROM screenshots"), (e) => guardViolation(e) === "append_only");

  await run("INSERT INTO screenshot_access_log (id, screenshot_id, user_id) VALUES ('l1', 's-1', 'a1')");
  await run("INSERT INTO screenshot_access_log (id, screenshot_id, user_id, action) VALUES ('l3', 's-1', 'a1', 'THUMBNAIL')");
  await assert.rejects(run("INSERT INTO screenshot_access_log (id, screenshot_id, user_id, action) VALUES ('l4', 's-1', 'a1', 'EXPORT')"), /CHECK constraint/);
  assert.equal((await run("SELECT action FROM screenshot_access_log WHERE id = 'l1'")).rows[0]!.action, "VIEW", "default action");
  assert.equal((await run("SELECT employee_self_view FROM screenshot_policies")).rows[0]!.employee_self_view, 1, "existing policies keep self-view");
  await run("INSERT INTO screenshot_retention_runs (id, cutoff, retention_days, deleted, failed, deletion_mode) VALUES ('r1', 'x', 30, 1, 0, 'RECYCLE_BIN')");
  await assert.rejects(run("INSERT INTO screenshot_retention_runs (id, cutoff, retention_days, deleted, failed, deletion_mode) VALUES ('r2', 'x', 30, 1, 0, 'SHREDDED')"), /CHECK constraint/);
  await assert.rejects(run("DELETE FROM screenshot_retention_runs"), (e) => guardViolation(e) === "append_only");
  await assert.rejects(run("INSERT INTO screenshot_access_log (id, screenshot_id, user_id) VALUES ('l2', 'missing', 'a1')"), /FOREIGN KEY/);
  await assert.rejects(run("DELETE FROM screenshot_access_log"), (e) => guardViolation(e) === "append_only");
  db.close();
});

test("screenshot privacy masks: JSON array of at most 20 per policy, none by default; mask count immutable", async () => {
  const db = createDatabase({ url: ":memory:" });
  await migrate(db);
  const run = (sql: string, ...args: (string | number | null)[]) => db.execute({ sql, args });
  await run("INSERT INTO users (id, email, role) VALUES ('a1', 'admin@example.com', 'ADMIN')");
  const policy = (masks?: string) =>
    run(
      `INSERT INTO screenshot_policies (screenshots_enabled, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
         retention_approved, notice_version, reason, changed_by${masks === undefined ? "" : ", mask_regions"})
       VALUES (1, 300, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, '2026-10-screenshots-draft-1', 'test', 'a1'${masks === undefined ? "" : ", ?"})`,
      ...(masks === undefined ? [] : [masks]),
    );
  await policy();
  assert.equal((await run("SELECT mask_regions FROM screenshot_policies")).rows[0]!.mask_regions, "[]", "default: no masks");
  await policy(JSON.stringify([{ x: 0, y: 0, w: 100, h: 100, label: "Corner" }]));
  for (const bad of ["not json", "{}", '"text"', JSON.stringify(Array.from({ length: 21 }, () => ({})))]) {
    await assert.rejects(policy(bad), /CHECK constraint/, bad);
  }
  await run("INSERT INTO users (id, email, role) VALUES ('u1', 'e@example.com', 'EMPLOYEE')");
  await run("INSERT INTO employee_profiles (id, user_id, employee_code, full_name) VALUES ('e1', 'u1', 'E1', 'A')");
  await run("INSERT INTO devices (id, employee_id, device_name, platform, device_identifier) VALUES ('d1', 'e1', 'Mac', 'macos', 'h')");
  await run("INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, status) VALUES ('s1', 'e1', 'd1', '2026-10-13T09:00:00.000Z', 'OPEN')");
  const shot = (id: string, maskCount: number) =>
    run(
      `INSERT INTO screenshots (id, employee_id, device_id, attendance_session_id, idempotency_key, captured_at, device_captured_at,
         width, height, mime_type, file_size_bytes, checksum, storage_provider, storage_key, upload_status, mask_count)
       VALUES (?, 'e1', 'd1', 's1', ?, '2026-10-13T10:00:00.000Z', '2026-10-13T10:00:00.000Z', 1920, 1080, 'image/webp', 10, ?, 'LOCAL_DEV', ?, 'REGISTERED', ?)`,
      id, id, "a".repeat(64), `k/${id}`, maskCount,
    );
  await shot("m1", 2);
  await assert.rejects(shot("m2", 21), /CHECK constraint/);
  await assert.rejects(shot("m3", -1), /CHECK constraint/);
  await assert.rejects(run("UPDATE screenshots SET mask_count = 0"), (e) => guardViolation(e) === "screenshot_immutable");
  await assert.rejects(run("UPDATE screenshots SET checksum = ?", "b".repeat(64)), (e) => guardViolation(e) === "screenshot_immutable", "old guard kept");
  db.close();
});

test("leave requests: valid dates, portions and times; decided once by someone else (or cancelled by the requester); never deleted", async () => {
  const db = createDatabase({ url: ":memory:" });
  await migrate(db);
  await db.execute("INSERT INTO users (id, email, role) VALUES ('u1', 'e@example.com', 'EMPLOYEE'), ('a1', 'a@example.com', 'ADMIN')");
  await db.execute("INSERT INTO employee_profiles (id, user_id, employee_code, full_name) VALUES ('p1', 'u1', 'EMP-1', 'E')");
  const add = (id: string, start: string, end: string, portion: string, st: string | null = null, et: string | null = null) =>
    db.execute({
      sql: "INSERT INTO leave_requests (id, employee_id, requested_by, start_date, end_date, portion, start_time, end_time) VALUES (?, 'p1', 'u1', ?, ?, ?, ?, ?)",
      args: [id, start, end, portion, st, et],
    });
  await add("l1", "2026-11-02", "2026-11-04", "FULL_DAY");
  await add("l2", "2026-11-05", "2026-11-05", "FIRST_HALF");
  await add("l3", "2026-11-06", "2026-11-06", "SHORT", "14:00", "15:30");
  for (const bad of [
    () => add("x1", "2026-11-04", "2026-11-02", "FULL_DAY"), // reversed
    () => add("x2", "2026-02-30", "2026-02-30", "FULL_DAY"), // not a date
    () => add("x3", "2026-11-05", "2026-11-06", "SECOND_HALF"), // half day over two dates
    () => add("x4", "2026-11-06", "2026-11-06", "SHORT"), // no times
    () => add("x5", "2026-11-06", "2026-11-06", "SHORT", "15:00", "14:00"), // end before start
    () => add("x6", "2026-11-06", "2026-11-06", "SHORT", "24:00", "24:30"), // not a time
    () => add("x7", "2026-11-06", "2026-11-06", "FULL_DAY", "09:00", "10:00"), // times on a full day
    () => add("x8", "2026-11-06", "2026-11-06", "UNPAID"), // no leave types
  ]) await assert.rejects(bad(), /CHECK constraint/);

  const decide = (id: string, status: string, by: string | null) =>
    db.execute({ sql: "UPDATE leave_requests SET status = ?, decided_by = ?, decided_at = '2026-11-01T00:00:00.000Z' WHERE id = ?", args: [status, by, id] });
  await assert.rejects(decide("l1", "APPROVED", "u1"), /CHECK constraint/, "the requester cannot approve");
  await assert.rejects(decide("l1", "CANCELLED", "a1"), /CHECK constraint/, "only the requester cancels");
  await assert.rejects(decide("l1", "APPROVED", null), /CHECK constraint/, "a decision names who made it");
  await decide("l1", "APPROVED", "a1");
  await decide("l2", "CANCELLED", "u1");
  await assert.rejects(decide("l1", "REJECTED", "a1"), (e) => guardViolation(e) === "already_reviewed");
  await assert.rejects(db.execute("UPDATE leave_requests SET end_date = '2026-11-03' WHERE id = 'l3'"), (e) => guardViolation(e) === "already_reviewed", "content is immutable");
  await assert.rejects(db.execute("DELETE FROM leave_requests WHERE id = 'l3'"), (e) => guardViolation(e) === "append_only");
  db.close();
});

test("project time: tasks belong to their project, one running timer per employee, entries end once and are never edited or deleted", async () => {
  const db = createDatabase({ url: ":memory:" });
  await migrate(db);
  await db.batch([
    "INSERT INTO users (id, email, role) VALUES ('u1', 'e@example.com', 'EMPLOYEE'), ('a1', 'a@example.com', 'ADMIN')",
    "INSERT INTO employee_profiles (id, user_id, employee_code, full_name) VALUES ('p1', 'u1', 'EMP-1', 'E')",
    "INSERT INTO devices (id, employee_id, device_identifier, device_name, platform) VALUES ('d1', 'p1', 'x', 'Mac', 'macos')",
    "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, status) VALUES ('s1', 'p1', 'd1', '2026-11-02T09:00:00.000Z', 'OPEN')",
    "INSERT INTO projects (id, code, name, created_by) VALUES ('j1', 'APOLLO', 'Apollo', 'a1'), ('j2', 'ZEUS', 'Zeus', 'a1')",
    "INSERT INTO project_tasks (id, project_id, title, created_by) VALUES ('t1', 'j1', 'Design', 'a1'), ('t2', 'j2', 'Build', 'a1')",
  ], "write");
  await assert.rejects(db.execute("INSERT INTO projects (id, code, name, created_by) VALUES ('j3', 'apollo2', 'x', 'a1')"), /CHECK constraint/);
  await assert.rejects(db.execute("INSERT INTO projects (id, code, name, created_by) VALUES ('j3', 'APOLLO', 'x', 'a1')"), (e) => isUniqueViolation(e));
  const entry = (id: string, task: string, project: string) =>
    db.execute({ sql: "INSERT INTO task_time_entries (id, employee_id, project_id, task_id, attendance_session_id, started_at) VALUES (?, 'p1', ?, ?, 's1', '2026-11-02T10:00:00.000Z')", args: [id, project, task] });
  await assert.rejects(entry("e0", "t2", "j1"), /FOREIGN KEY/, "a task of another project");
  await entry("e1", "t1", "j1");
  await assert.rejects(entry("e2", "t1", "j1"), (e) => isUniqueViolation(e), "one running timer");
  await assert.rejects(db.execute("UPDATE task_time_entries SET ended_at = '2026-11-02T09:00:00.000Z', end_reason = 'STOPPED' WHERE id = 'e1'"), /CHECK constraint/, "no negative time");
  await assert.rejects(db.execute("UPDATE task_time_entries SET ended_at = '2026-11-02T11:00:00.000Z' WHERE id = 'e1'"), /CHECK constraint/, "a reason is required");
  await assert.rejects(db.execute("UPDATE task_time_entries SET started_at = '2026-11-02T08:00:00.000Z' WHERE id = 'e1'"), (e) => guardViolation(e) === "append_only");
  await db.execute("UPDATE task_time_entries SET ended_at = '2026-11-02T11:00:00.000Z', end_reason = 'PAUSED' WHERE id = 'e1'");
  await assert.rejects(db.execute("UPDATE task_time_entries SET ended_at = '2026-11-02T12:00:00.000Z' WHERE id = 'e1'"), (e) => guardViolation(e) === "append_only", "ended once");
  await assert.rejects(db.execute("DELETE FROM task_time_entries WHERE id = 'e1'"), (e) => guardViolation(e) === "append_only");
  await entry("e2", "t1", "j1"); // the previous one ended, so a new one may run

  await db.execute("INSERT INTO project_members (id, project_id, employee_id, assigned_by) VALUES ('m1', 'j1', 'p1', 'a1')");
  await assert.rejects(db.execute("INSERT INTO project_members (id, project_id, employee_id, assigned_by) VALUES ('m2', 'j1', 'p1', 'a1')"), (e) => isUniqueViolation(e));
  await db.execute("UPDATE project_members SET removed_by = 'a1', removed_at = '2026-11-03T00:00:00.000Z' WHERE id = 'm1'");
  await assert.rejects(db.execute("UPDATE project_members SET removed_at = NULL, removed_by = NULL WHERE id = 'm1'"), (e) => guardViolation(e) === "append_only");
  await db.execute("INSERT INTO project_members (id, project_id, employee_id, assigned_by) VALUES ('m2', 'j1', 'p1', 'a1')");
  await assert.rejects(db.execute("DELETE FROM project_members WHERE id = 'm1'"), (e) => guardViolation(e) === "append_only");
  await assert.rejects(db.execute("DELETE FROM projects WHERE id = 'j2'"), (e) => guardViolation(e) === "append_only" || /FOREIGN KEY/.test(String(e)));
  await db.execute("INSERT INTO project_audit (id, project_id, actor_id, action) VALUES ('x1', 'j1', 'a1', 'PROJECT_CREATED')");
  await assert.rejects(db.execute("UPDATE project_audit SET action = 'X' WHERE id = 'x1'"), (e) => guardViolation(e) === "append_only");
  db.close();
});

test("email reports: one run per schedule and period, one delivery per recipient, finished deliveries final, history append-only", async () => {
  const db = createDatabase({ url: ":memory:" });
  await migrate(db);
  await db.batch([
    "INSERT INTO users (id, email, role) VALUES ('a1', 'a@example.com', 'ADMIN')",
    "INSERT INTO report_schedules (id, name, frequency, timezone, created_by) VALUES ('s1', 'Weekly', 'WEEKLY', 'UTC', 'a1')",
    "INSERT INTO report_runs (id, schedule_id, period_from, period_to) VALUES ('r1', 's1', '2026-10-19', '2026-10-25')",
    "INSERT INTO report_deliveries (id, run_id, user_id, email) VALUES ('d1', 'r1', 'a1', 'a@example.com')",
  ], "write");
  await assert.rejects(db.execute("INSERT INTO report_schedules (id, name, frequency, timezone, created_by) VALUES ('s2', 'x', 'HOURLY', 'UTC', 'a1')"), /CHECK constraint/);
  await assert.rejects(db.execute("INSERT INTO report_runs (id, schedule_id, period_from, period_to) VALUES ('r2', 's1', '2026-10-19', '2026-10-25')"), (e) => isUniqueViolation(e), "same period twice");
  await assert.rejects(db.execute("INSERT INTO report_deliveries (id, run_id, user_id, email) VALUES ('d2', 'r1', 'a1', 'a@example.com')"), (e) => isUniqueViolation(e), "same recipient twice");
  await assert.rejects(db.execute("UPDATE report_deliveries SET status = 'MOCKED' WHERE id = 'd1'"), /CHECK constraint/, "a finished status needs finished_at");
  await db.execute("UPDATE report_deliveries SET status = 'MOCKED', provider = 'mock', attempts = 1, finished_at = '2026-10-26T00:00:00.000Z' WHERE id = 'd1'");
  await assert.rejects(db.execute("UPDATE report_deliveries SET status = 'PENDING', finished_at = NULL WHERE id = 'd1'"), (e) => guardViolation(e) === "append_only", "no resend of a finished delivery");
  await db.execute("INSERT INTO report_delivery_attempts (id, delivery_id, attempt, outcome) VALUES ('x1', 'd1', 1, 'MOCKED')");
  await assert.rejects(db.execute("INSERT INTO report_delivery_attempts (id, delivery_id, attempt, outcome) VALUES ('x2', 'd1', 1, 'SENT')"), (e) => isUniqueViolation(e));
  for (const sql of ["UPDATE report_runs SET period_to = '2026-10-26'", "DELETE FROM report_runs", "DELETE FROM report_deliveries", "UPDATE report_delivery_attempts SET outcome = 'SENT'", "DELETE FROM report_schedules"]) {
    await assert.rejects(db.execute(sql), (e) => guardViolation(e) === "append_only", sql);
  }
  db.close();
});

test("website usage: domain-only intervals (no paths, queries, ports or IPs), no overlaps, never edited; policy and audit append-only; draft notice seeded", async () => {
  const db = createDatabase({ url: ":memory:" });
  await migrate(db);
  await db.batch([
    "INSERT INTO users (id, email, role) VALUES ('u1', 'e@example.com', 'EMPLOYEE'), ('a1', 'a@example.com', 'ADMIN')",
    "INSERT INTO employee_profiles (id, user_id, employee_code, full_name) VALUES ('p1', 'u1', 'EMP-1', 'E')",
    "INSERT INTO devices (id, employee_id, device_identifier, device_name, platform) VALUES ('d1', 'p1', 'x', 'Mac', 'macos')",
    "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, status) VALUES ('s1', 'p1', 'd1', '2026-11-02T09:00:00.000Z', 'OPEN')",
    "INSERT INTO website_policies (seq, enabled, retention_days, notice_version, reason, changed_by) VALUES (1, 1, 30, '2026-10-websites-draft-1', 'pilot', 'a1')",
    "INSERT INTO website_extension_links (id, employee_id, label, pairing_code_hash, pairing_expires_at, token_hash, claimed_at) VALUES ('l1', 'p1', 'Chrome', 'h1', '2026-11-02T09:10:00.000Z', 't1', '2026-11-02T09:01:00.000Z')",
  ], "write");
  const notice = (await db.execute("SELECT draft, json_array_length(points) AS n FROM monitoring_notices WHERE version = '2026-10-websites-draft-1'")).rows[0]!;
  assert.deepEqual([Number(notice.draft), Number(notice.n)], [1, 5], "the website notice is a draft");
  const add = (id: string, domain: string, s: string, e: string, ms = 60_000) =>
    db.execute({ sql: "INSERT INTO website_intervals (id, employee_id, link_id, attendance_session_id, policy_seq, client_id, domain, started_at, ended_at, duration_ms, received_at) VALUES (?, 'p1', 'l1', 's1', 1, ?, ?, ?, ?, ?, ?)", args: [id, id, domain, s, e, ms, e] });
  await add("w1", "docs.example.com", "2026-11-02T10:00:00.000Z", "2026-11-02T10:01:00.000Z");
  for (const bad of ["Docs.example.com", "example.com/path", "example.com?q=1", "example.com:443", "user@example.com", "localhost", "a b.com", "x%2f.com"]) {
    await assert.rejects(add(`b-${bad}`, bad, "2026-11-02T11:00:00.000Z", "2026-11-02T11:01:00.000Z"), /CHECK constraint/, bad);
  }
  await assert.rejects(add("w2", "example.com", "2026-11-02T10:00:30.000Z", "2026-11-02T10:02:00.000Z"), (e) => guardViolation(e) === "website_overlap");
  await assert.rejects(add("w3", "example.com", "2026-11-02T12:00:00.000Z", "2026-11-02T12:00:00.500Z", 500), /CHECK constraint/, "at least 1 s");
  await assert.rejects(add("w4", "example.com", "2026-11-02T12:00:00.000Z", "2026-11-02T12:20:00.000Z", 1_200_000), /CHECK constraint/, "at most 15 min");
  await assert.rejects(add("w1", "example.com", "2026-11-02T13:00:00.000Z", "2026-11-02T13:01:00.000Z"), (e) => isUniqueViolation(e), "duplicate client id");
  await assert.rejects(db.execute("UPDATE website_intervals SET domain = 'other.com'"), (e) => guardViolation(e) === "append_only");
  await db.execute("DELETE FROM website_intervals WHERE id = 'w1'"); // retention may delete
  await assert.rejects(db.execute("UPDATE website_policies SET enabled = 0"), (e) => guardViolation(e) === "append_only");
  await assert.rejects(db.execute("INSERT INTO website_policies (enabled, retention_days, notice_version, reason, changed_by) VALUES (1, 400, '2026-10-websites-draft-1', 'x long', 'a1')"), /CHECK constraint/);
  await db.execute("INSERT INTO website_category_rules (id, domain, match, category, created_by) VALUES ('r1', 'example.com', 'SUBDOMAINS', 'NEUTRAL', 'a1')");
  await assert.rejects(db.execute("INSERT INTO website_category_rules (id, domain, match, category, created_by) VALUES ('r2', 'example.com', 'SUBDOMAINS', 'PRODUCTIVE', 'a1')"), (e) => isUniqueViolation(e));
  await assert.rejects(db.execute("INSERT INTO website_category_rules (id, domain, match, category, created_by) VALUES ('r3', 'x.com', 'EXACT', 'BAD', 'a1')"), /CHECK constraint/);
  await db.execute("INSERT INTO website_audit (id, actor_id, action) VALUES ('x1', 'a1', 'RULE_ADDED')");
  await assert.rejects(db.execute("DELETE FROM website_audit"), (e) => guardViolation(e) === "append_only");
  db.close();
});

test("platform roles: admin identity column, existing admins become Admin, role history append-only; category rules keep their rows and allow Unclassified", async () => {
  const db = createDatabase({ url: ":memory:" });
  // Apply up to 0013, add data, then 0014: existing admins and rules survive the change.
  const upTo13 = MIGRATIONS.slice(0, MIGRATIONS.findIndex((m) => m.id === "0014_platform_roles"));
  await db.execute("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))) STRICT");
  for (const m of upTo13) await db.batch([...m.statements, { sql: "INSERT INTO schema_migrations (id) VALUES (?)", args: [m.id] }], "write");
  await db.batch([
    "INSERT INTO users (id, email, role) VALUES ('a1', 'a@example.com', 'ADMIN'), ('u1', 'e@example.com', 'EMPLOYEE')",
    "INSERT INTO website_category_rules (id, domain, match, category, created_by) VALUES ('r1', 'example.com', 'SUBDOMAINS', 'NEUTRAL', 'a1')",
  ], "write");
  assert.deepEqual(await migrate(db), MIGRATIONS.slice(upTo13.length).map((m) => m.id), "0014 and any later migrations");
  const users = (await db.execute("SELECT id, admin_title FROM users ORDER BY id")).rows.map((r) => [r.id, r.admin_title]);
  assert.deepEqual(users, [["a1", "ADMIN"], ["u1", null]], "existing admin is an Admin; employees have no title");
  await assert.rejects(db.execute("UPDATE users SET admin_title = 'CEO' WHERE id = 'a1'"), /CHECK constraint/);
  assert.deepEqual((await db.execute("SELECT domain, category FROM website_category_rules")).rows.map((r) => [r.domain, r.category]), [["example.com", "NEUTRAL"]], "rules kept");
  await db.execute("INSERT INTO website_category_rules (id, domain, match, category, created_by) VALUES ('r2', 'mail.example.com', 'EXACT', 'UNCLASSIFIED', 'a1')");
  await assert.rejects(db.execute("DELETE FROM website_category_rules"), (e) => guardViolation(e) === "append_only", "trigger recreated");
  await assert.rejects(db.execute("INSERT INTO website_category_rules (id, domain, match, category, created_by) VALUES ('r3', 'example.com', 'SUBDOMAINS', 'PRODUCTIVE', 'a1')"), (e) => isUniqueViolation(e), "index recreated");
  await db.execute("INSERT INTO role_changes (id, target_user_id, actor_id, from_role, to_role, reason) VALUES ('c1', 'u1', 'a1', 'EMPLOYEE', 'ADMIN', 'joined IT')");
  await assert.rejects(db.execute("INSERT INTO role_changes (id, target_user_id, actor_id, from_role, to_role, reason) VALUES ('c2', 'a1', 'a1', 'ADMIN', 'EMPLOYEE', 'self')"), /CHECK constraint/, "no self change");
  await assert.rejects(db.execute("UPDATE role_changes SET reason = 'x y z'"), (e) => guardViolation(e) === "append_only");
  db.close();
});

test("account audit (0015): existing sessions survive with unknown client; audit rows append-only, constrained, no foreign keys", async () => {
  const db = createDatabase({ url: ":memory:" });
  // Apply up to 0014 with a live session, then 0015.
  const upTo14 = MIGRATIONS.slice(0, MIGRATIONS.findIndex((m) => m.id === "0015_account_audit"));
  await db.execute("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))) STRICT");
  for (const m of upTo14) await db.batch([...m.statements, { sql: "INSERT INTO schema_migrations (id) VALUES (?)", args: [m.id] }], "write");
  await db.batch([
    "INSERT INTO users (id, email, role) VALUES ('u1', 'e@example.com', 'EMPLOYEE')",
    "INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at) VALUES ('s1', 'u1', 'h1', '2999-01-01T00:00:00.000Z')",
  ], "write");
  assert.deepEqual(await migrate(db), MIGRATIONS.slice(upTo14.length).map((m) => m.id), "0015 and any later migrations");
  assert.deepEqual((await db.execute("SELECT id, client, refreshed_at FROM sessions")).rows.map((r) => [r.id, r.client, r.refreshed_at]), [["s1", null, null]], "existing session kept, client unknown");
  await db.execute("INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, client) VALUES ('s2', 'u1', 'h2', '2999-01-01T00:00:00.000Z', 'DESKTOP')");
  await assert.rejects(db.execute("UPDATE sessions SET client = 'MOBILE' WHERE id = 's2'"), /CHECK constraint/);

  await db.execute("INSERT INTO account_audit (id, actor_user_id, target_user_id, action, resource_type, resource_id, metadata) VALUES ('a1', NULL, 'u1', 'ACCOUNT_CREATED', 'ACCOUNT', 'u1', '{\"via\":\"cli\"}')");
  await db.execute("INSERT INTO account_audit (id, actor_user_id, target_user_id, action, resource_type) VALUES ('a2', 'gone-user', 'u1', 'SESSION_REVOKED', 'SESSION')"); // no FK: history outlives rows
  await assert.rejects(db.execute("INSERT INTO account_audit (id, action, resource_type) VALUES ('a3', 'X', 'ACCOUNT')"), /CHECK constraint/, "action length");
  await assert.rejects(db.execute("INSERT INTO account_audit (id, action, resource_type) VALUES ('a4', 'ACCOUNT_CREATED', 'FILE')"), /CHECK constraint/, "resource type");
  await assert.rejects(db.execute("INSERT INTO account_audit (id, action, resource_type, metadata) VALUES ('a5', 'ACCOUNT_CREATED', 'ACCOUNT', 'not json')"), /CHECK constraint/, "metadata JSON");
  await assert.rejects(db.execute("UPDATE account_audit SET action = 'ACCOUNT_UPDATED'"), (e) => guardViolation(e) === "append_only");
  await assert.rejects(db.execute("DELETE FROM account_audit"), (e) => guardViolation(e) === "append_only");
  assert.equal((await db.execute("SELECT count(*) AS n FROM account_audit")).rows[0]?.n, 2);
  assert.deepEqual(await migrate(db), [], "repeatable");
  db.close();
});

test("migration integrity: checksums stamped and verified, edited or unknown migrations refuse to start, failures name the migration", async () => {
  const db = createDatabase({ url: ":memory:" });
  await migrate(db);
  const sums = (await db.execute("SELECT id, checksum FROM schema_migrations ORDER BY id")).rows;
  assert.equal(sums.length, MIGRATIONS.length);
  assert.ok(sums.every((r) => /^[0-9a-f]{64}$/.test(String(r.checksum))), "every applied migration has a sha256 checksum");
  assert.equal(await schemaVersion(db), MIGRATIONS.at(-1)!.id);
  assert.equal(await foreignKeysEnforced(db), true);

  // Rows from before checksums existed are stamped on first sight, not rejected.
  const first = String(sums[0]!.id);
  await db.execute({ sql: "UPDATE schema_migrations SET checksum = NULL WHERE id = ?", args: [first] });
  assert.deepEqual(await migrate(db), []);
  assert.equal((await db.execute({ sql: "SELECT checksum FROM schema_migrations WHERE id = ?", args: [first] })).rows[0]!.checksum, sums[0]!.checksum);

  // Edited history: the stored checksum no longer matches the code.
  await db.execute({ sql: "UPDATE schema_migrations SET checksum = ? WHERE id = ?", args: ["0".repeat(64), first] });
  await assert.rejects(migrate(db), new RegExp(`Migration ${first} was changed after it was applied`));
  await db.execute({ sql: "UPDATE schema_migrations SET checksum = ? WHERE id = ?", args: [sums[0]!.checksum, first] });

  // A database migrated by a newer build.
  await db.execute("INSERT INTO schema_migrations (id, checksum) VALUES ('9999_future', 'x')");
  await assert.rejects(migrate(db), /does not know \(9999_future\)/);
  db.close();

  // Legacy table without the checksum column (databases created before this change) is upgraded in place.
  const legacy = createDatabase({ url: ":memory:" });
  await legacy.execute("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))) STRICT");
  for (const m of MIGRATIONS.slice(0, 3)) await legacy.batch([...m.statements, { sql: "INSERT INTO schema_migrations (id) VALUES (?)", args: [m.id] }], "write");
  assert.deepEqual(await migrate(legacy), MIGRATIONS.slice(3).map((m) => m.id));
  assert.equal((await legacy.execute("SELECT count(*) AS n FROM schema_migrations WHERE checksum IS NULL")).rows[0]!.n, 0);
  legacy.close();
});

test("concurrent runners on one file database: both succeed, each migration applied once", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "wf-migrate-"));
  try {
    const url = `file:${join(dir, "race.db")}`;
    const a = createDatabase({ url });
    const b = createDatabase({ url });
    const [ra, rb] = await Promise.all([migrate(a), migrate(b)]);
    assert.deepEqual([...ra, ...rb].sort(), MIGRATIONS.map((m) => m.id).sort(), "every migration applied by exactly one runner");
    assert.equal((await a.execute("SELECT count(*) AS n FROM schema_migrations")).rows[0]!.n, MIGRATIONS.length);
    const timeouts = await Promise.all(Array.from({ length: 4 }, () => a.execute("PRAGMA busy_timeout")));
    assert.ok(timeouts.every((r) => Number(Object.values(r.rows[0]!)[0]) === 5000), "busy timeout on every pooled connection");
    a.close();
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("data layer integrity (0016): core records cannot be deleted; consents must name a published notice; indexes exist", async () => {
  const db = createDatabase({ url: ":memory:" });
  await migrate(db);
  await db.batch([
    "INSERT INTO users (id, email, role) VALUES ('u1', 'e@example.com', 'EMPLOYEE'), ('a1', 'a@example.com', 'ADMIN')",
    "INSERT INTO employee_profiles (id, user_id, employee_code, full_name) VALUES ('p1', 'u1', 'E-1', 'X')",
    "INSERT INTO projects (id, code, name, created_by) VALUES ('j1', 'P-1', 'Project', 'a1')",
  ], "write");
  for (const sql of ["DELETE FROM users WHERE id = 'a1'", "DELETE FROM employee_profiles", "DELETE FROM projects", "DELETE FROM devices", "DELETE FROM attendance_sessions"]) {
    // Empty tables also go through the trigger only when a row exists; the populated ones must refuse.
    if (/devices|attendance_sessions/.test(sql)) continue;
    await assert.rejects(db.execute(sql), (e) => guardViolation(e) === "append_only", sql);
  }
  await assert.rejects(db.execute("INSERT INTO monitoring_consents (id, employee_id, notice_version) VALUES ('c1', 'p1', 'no-such-notice')"), (e) => guardViolation(e) === "unknown_notice");
  const notice = String((await db.execute("SELECT version FROM monitoring_notices LIMIT 1")).rows[0]!.version);
  await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version) VALUES ('c2', 'p1', ?)", args: [notice] });
  const indexes = (await db.execute("SELECT name FROM sqlite_master WHERE type = 'index'")).rows.map((r) => String(r.name));
  for (const i of ["screenshots_session", "screenshots_captured", "task_time_entries_started", "activity_intervals_employee_received", "attendance_corrections_request", "timelapses_session"]) assert.ok(indexes.includes(i), i);
  const plan = (await db.execute("EXPLAIN QUERY PLAN SELECT id FROM screenshots WHERE captured_at >= '2026-01-01'")).rows.map((r) => String(r.detail)).join(" ");
  assert.match(plan, /screenshots_captured/, "time filter uses the new index");
  db.close();
});

test("work schedule and application labels (0017): validated append-only schedule; one current rule per kind and value, ended not deleted; audit append-only; re-run is a no-op", async () => {
  const db = createDatabase({ url: ":memory:" });
  await migrate(db);
  assert.deepEqual(await migrate(db), [], "idempotent");
  await db.execute("INSERT INTO users (id, email, role) VALUES ('a1', 'a@example.com', 'ADMIN')");
  const policy = (start: string, grace: number, days: string) =>
    db.execute({ sql: "INSERT INTO work_schedule_policies (enabled, expected_start, grace_minutes, workdays, reason, changed_by) VALUES (1, ?, ?, ?, 'pilot', 'a1')", args: [start, grace, days] });
  await policy("09:30", 15, "12345");
  for (const [start, grace, days] of [["24:00", 0, "1"], ["9:30", 0, "1"], ["09:60", 0, "1"], ["09:00", 241, "1"], ["09:00", -1, "1"], ["09:00", 0, ""], ["09:00", 0, "0"], ["09:00", 0, "8"], ["09:00", 0, "112"], ["09:00", 0, "1,2"], ["09:00", 0, "12345678"]] as const) {
    await assert.rejects(policy(start, grace, days), /CHECK constraint/, `${start} ${grace} ${days}`);
  }
  await assert.rejects(db.execute("INSERT INTO work_schedule_policies (enabled, expected_start, grace_minutes, workdays, reason, changed_by) VALUES (1, '09:00', 0, '1', 'x', 'a1')"), /CHECK constraint/, "reason 3-500");
  await assert.rejects(db.execute("INSERT INTO work_schedule_policies (enabled, expected_start, grace_minutes, workdays, reason, changed_by) VALUES (1, '09:00', 0, '1', 'pilot', 'nobody')"), /FOREIGN KEY/);
  await assert.rejects(db.execute("UPDATE work_schedule_policies SET enabled = 0"), (e) => guardViolation(e) === "append_only");
  await assert.rejects(db.execute("DELETE FROM work_schedule_policies"), (e) => guardViolation(e) === "append_only");

  const rule = (id: string, kind: string, value: string, category = "PRODUCTIVE") =>
    db.execute({ sql: "INSERT INTO application_category_rules (id, match_kind, value, category, created_by) VALUES (?, ?, ?, ?, 'a1')", args: [id, kind, value, category] });
  await rule("r1", "IDENTIFIER", "com.apple.Safari");
  await assert.rejects(rule("r2", "IDENTIFIER", "COM.APPLE.SAFARI"), (e) => isUniqueViolation(e), "case-insensitive");
  await rule("r3", "NAME", "com.apple.Safari"); // other kind
  for (const [kind, value, cat] of [["BUNDLE", "x", "PRODUCTIVE"], ["NAME", "", "PRODUCTIVE"], ["NAME", " Code", "PRODUCTIVE"], ["NAME", "Code", "UNCLASSIFIED"], ["NAME", "x".repeat(256), "NEUTRAL"]]) {
    await assert.rejects(rule(`b-${kind}-${value.length}-${cat}`, kind!, value!, cat), /CHECK constraint/, `${kind} ${value} ${cat}`);
  }
  await db.execute("UPDATE application_category_rules SET category = 'NEUTRAL', updated_at = 'x' WHERE id = 'r1'");
  await assert.rejects(db.execute("UPDATE application_category_rules SET value = 'other' WHERE id = 'r1'"), (e) => guardViolation(e) === "append_only", "identity fixed");
  await assert.rejects(db.execute("UPDATE application_category_rules SET ended_at = 'x' WHERE id = 'r1'"), /CHECK constraint/, "ended needs who");
  await db.execute("UPDATE application_category_rules SET ended_at = 'x', ended_by = 'a1' WHERE id = 'r1'");
  await assert.rejects(db.execute("UPDATE application_category_rules SET category = 'PRODUCTIVE' WHERE id = 'r1'"), (e) => guardViolation(e) === "append_only", "an ended rule is final");
  await rule("r4", "IDENTIFIER", "com.apple.safari"); // allowed again once the old one ended
  await assert.rejects(db.execute("DELETE FROM application_category_rules WHERE id = 'r4'"), (e) => guardViolation(e) === "append_only");

  await db.execute("INSERT INTO activity_category_audit (id, actor_id, action, rule_id, details) VALUES ('x1', 'a1', 'RULE_ADDED', 'r4', '{}')");
  await assert.rejects(db.execute("INSERT INTO activity_category_audit (id, actor_id, action, rule_id) VALUES ('x2', 'a1', 'RULE_EDITED', 'r4')"), /CHECK constraint/);
  await assert.rejects(db.execute("INSERT INTO activity_category_audit (id, actor_id, action, rule_id) VALUES ('x3', 'a1', 'RULE_ADDED', 'nope')"), /FOREIGN KEY/);
  await assert.rejects(db.execute("UPDATE activity_category_audit SET action = 'RULE_REMOVED'"), (e) => guardViolation(e) === "append_only");
  await assert.rejects(db.execute("DELETE FROM activity_category_audit"), (e) => guardViolation(e) === "append_only");
  db.close();
});

test("screenshot blur (0019): policy flag and per-image flag 0/1, off by default; blurred immutable; per-employee overrides validated and append-only; re-run is a no-op", async () => {
  const db = createDatabase({ url: ":memory:" });
  await migrate(db);
  assert.deepEqual(await migrate(db), [], "idempotent");
  const run = (sql: string, ...args: (string | number | null)[]) => db.execute({ sql, args });
  await run("INSERT INTO users (id, email, role) VALUES ('a1', 'admin@example.com', 'ADMIN')");
  const policy = (blur?: number) =>
    run(
      `INSERT INTO screenshot_policies (screenshots_enabled, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
         retention_approved, notice_version, reason, changed_by${blur === undefined ? "" : ", blur"})
       VALUES (1, 300, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, '2026-10-screenshots-draft-1', 'test', 'a1'${blur === undefined ? "" : ", ?"})`,
      ...(blur === undefined ? [] : [blur]),
    );
  await policy();
  assert.equal((await run("SELECT blur FROM screenshot_policies")).rows[0]!.blur, 0, "default: no blur");
  await policy(1);
  await assert.rejects(policy(2), /CHECK constraint/);
  await assert.rejects(run("UPDATE screenshot_policies SET blur = 0"), (e) => guardViolation(e) === "append_only", "policy history still append-only");
  await assert.rejects(run("DELETE FROM screenshot_policies"), (e) => guardViolation(e) === "append_only");

  await run("INSERT INTO users (id, email, role) VALUES ('u1', 'e@example.com', 'EMPLOYEE')");
  await run("INSERT INTO employee_profiles (id, user_id, employee_code, full_name) VALUES ('e1', 'u1', 'E1', 'A')");
  await run("INSERT INTO devices (id, employee_id, device_name, platform, device_identifier) VALUES ('d1', 'e1', 'Mac', 'macos', 'h')");
  await run("INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, status) VALUES ('s1', 'e1', 'd1', '2026-10-13T09:00:00.000Z', 'OPEN')");
  const shot = (id: string, blurred?: number) =>
    run(
      `INSERT INTO screenshots (id, employee_id, device_id, attendance_session_id, idempotency_key, captured_at, device_captured_at,
         width, height, mime_type, file_size_bytes, checksum, storage_provider, storage_key, upload_status${blurred === undefined ? "" : ", blurred"})
       VALUES (?, 'e1', 'd1', 's1', ?, '2026-10-13T10:00:00.000Z', '2026-10-13T10:00:00.000Z', 1920, 1080, 'image/webp', 10, ?, 'LOCAL_DEV', ?, 'REGISTERED'${blurred === undefined ? "" : ", ?"})`,
      id, id, "a".repeat(64), `k/${id}`, ...(blurred === undefined ? [] : [blurred]),
    );
  await shot("b0");
  assert.equal((await run("SELECT blurred FROM screenshots WHERE id = 'b0'")).rows[0]!.blurred, 0, "default: not blurred");
  await shot("b1", 1);
  await assert.rejects(shot("b2", 2), /CHECK constraint/);
  await assert.rejects(run("UPDATE screenshots SET blurred = 0 WHERE id = 'b1'"), (e) => guardViolation(e) === "screenshot_immutable");
  await assert.rejects(run("UPDATE screenshots SET mask_count = 1"), (e) => guardViolation(e) === "screenshot_immutable", "mask guard kept");
  await assert.rejects(run("UPDATE screenshots SET checksum = ?", "b".repeat(64)), (e) => guardViolation(e) === "screenshot_immutable", "old guard kept");
  await run("UPDATE screenshots SET upload_status = 'STORED', stored_at = 'x', storage_item_id = 'i' WHERE id = 'b1'"); // upload state still moves

  const override = (id: string, blur: number | null, reason = "client data", employee = "e1", by = "a1") =>
    run("INSERT INTO screenshot_blur_overrides (id, employee_id, blur, reason, changed_by) VALUES (?, ?, ?, ?, ?)", id, employee, blur, reason, by);
  await override("o1", 1);
  await override("o2", 0);
  await override("o3", null); // cleared: the organisation policy applies
  await assert.rejects(override("o4", 2), /CHECK constraint/);
  await assert.rejects(override("o5", 1, "  x "), /CHECK constraint/, "reason 3-500");
  await assert.rejects(override("o6", 1, "x".repeat(501)), /CHECK constraint/);
  await assert.rejects(override("o7", 1, "client data", "nobody"), /FOREIGN KEY/);
  await assert.rejects(override("o8", 1, "client data", "e1", "nobody"), /FOREIGN KEY/);
  assert.match(String((await run("SELECT effective_at FROM screenshot_blur_overrides WHERE id = 'o1'")).rows[0]!.effective_at), /^\d{4}-\d\d-\d\dT.*Z$/);
  await assert.rejects(run("UPDATE screenshot_blur_overrides SET blur = 1"), (e) => guardViolation(e) === "append_only");
  await assert.rejects(run("DELETE FROM screenshot_blur_overrides"), (e) => guardViolation(e) === "append_only");
  db.close();
});

test("a lower migration id added later (e.g. reserved 0018 after 0019) is applied on the next run", async () => {
  const db = createDatabase({ url: ":memory:" });
  await migrate(db);
  const gap = { id: "0018_test_gap_probe", statements: ["CREATE TABLE gap_probe (x INTEGER) STRICT"] };
  const at = MIGRATIONS.findIndex((m) => m.id > gap.id);
  assert.ok(at > 0 && MIGRATIONS[at]!.id === "0019_screenshot_blur_policy", "0019 follows the gap");
  MIGRATIONS.splice(at, 0, gap);
  try {
    assert.deepEqual(await migrate(db), [gap.id]);
    assert.deepEqual(await migrate(db), []);
    await db.execute("INSERT INTO gap_probe (x) VALUES (1)");
  } finally {
    MIGRATIONS.splice(at, 1);
  }
  db.close();
});

test("enableWal: a file database switches to WAL once and stays there across connections; :memory: is unaffected", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "wf-wal-"));
  try {
    const url = `file:${join(dir, "wal.db")}`;
    let db = createDatabase({ url });
    assert.equal(await journalMode(db), "delete", "libsql's default for a new file");
    assert.equal(await enableWal(db), "wal");
    await migrate(db);
    db.close();
    db = createDatabase({ url });
    assert.equal(await journalMode(db), "wal", "persisted in the file");
    assert.equal(await enableWal(db), "wal", "repeatable");
    assert.ok(await foreignKeysEnforced(db), "foreign keys stay on");
    db.close();
    const mem = createDatabase({ url: ":memory:" });
    assert.equal(await enableWal(mem), "memory");
    mem.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
