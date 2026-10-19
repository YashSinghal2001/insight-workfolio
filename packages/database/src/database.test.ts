import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatabase, guardViolation, isUniqueViolation, migrate, MIGRATIONS, pingDatabase } from "../dist/index.js";

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

test("attendance guards: one active device, no overlapping sessions or breaks, no silent overwrites", async () => {
  const db = createDatabase({ url: ":memory:" });
  await migrate(db);
  const run = (sql: string, ...args: (string | null)[]) => db.execute({ sql, args });
  const guard = (reason: string) => (e: unknown) => guardViolation(e) === reason;
  await run("INSERT INTO users (id, email, role) VALUES ('u1', 'a@example.com', 'EMPLOYEE')");
  await run("INSERT INTO employee_profiles (id, user_id, employee_code, full_name) VALUES ('e1', 'u1', 'E1', 'A')");
  const device = (id: string, ident: string) =>
    run("INSERT INTO devices (id, employee_id, device_name, platform, device_identifier) VALUES (?, 'e1', 'Mac', 'macos', ?)", id, ident);
  await device("d1", "h1");
  await assert.rejects(device("d2", "h2"), (e) => isUniqueViolation(e), "second active device");
  await run("UPDATE devices SET revoked_at = '2026-10-12T00:00:00.000Z' WHERE id = 'd1'");
  await device("d2", "h2");

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

  await run("INSERT INTO monitoring_consents (id, employee_id, notice_version) VALUES ('c1', 'e1', 'v1')");
  await assert.rejects(run("INSERT INTO monitoring_consents (id, employee_id, notice_version) VALUES ('c2', 'e1', 'v1')"), (e) => isUniqueViolation(e));
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
