// Day 6: server-controlled monitoring settings, consent versions, retention, reporting and scale.
// Own app instance (own in-memory database): settings are global, so they must not leak into other tests.
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL = ":memory:";
process.env.JWT_SECRET = "test-secret-test-secret-test-secret!";

const { AppModule } = await import("../dist/app.module.js");
const { configureApp } = await import("../dist/app.setup.js");
const { DATABASE } = await import("../dist/database/database.module.js");
const { hashPassword } = await import("../dist/auth/crypto.js");
const { DEFAULT_MONITORING_SETTINGS, DEFAULT_NOTICE_VERSION, addDays, localDate, summarizeActivity, weekStart } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "employee password 1";
const TZ = "Asia/Kolkata";
const D = 86_400_000;
const H = 3_600_000;
const M = 60_000;

let app: INestApplication;
let base: string;
type Db = {
  execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }>;
  batch: (q: { sql: string; args: unknown[] }[], mode: "write") => Promise<unknown>;
};
let db: Db;
let admin: string;

type Opts = { method?: string; body?: unknown; cookie?: string; bearer?: string; device?: string };
async function api(path: string, { method = "GET", body, cookie, bearer, device }: Opts = {}) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (device) headers["x-device-id"] = device;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text, res };
}
const iso = (ms: number) => new Date(ms).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
async function employee({ consentAgo = D as number | null, platform = "macos" } = {}) {
  const n = ++seq;
  const r = await api("/employees", { method: "POST", cookie: admin, body: { email: `pol${n}@example.com`, employeeCode: `POL-${n}`, fullName: `Policy ${n}`, timezone: TZ } });
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const login = await api("/auth/login", { method: "POST", body: { email: `pol${n}@example.com`, password: PASSWORD, client: "desktop" } });
  const e = { id: r.body.employee.id as string, bearer: login.body.accessToken as string, device: randomUUID() };
  await api("/devices/register", { method: "POST", bearer: e.bearer, body: { installationId: e.device, deviceName: "Mac", platform } });
  if (consentAgo !== null) await consent(e.id, DEFAULT_NOTICE_VERSION, Date.now() - consentAgo);
  return e;
}
type Emp = Awaited<ReturnType<typeof employee>>;
const consent = (employeeId: string, version: string, at: number) =>
  db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), employeeId, version, iso(at)] });

async function attendance(e: Emp, events: [string, number][]) {
  const r = await api("/attendance/sync", {
    method: "POST", bearer: e.bearer, device: e.device,
    body: { sentAt: iso(Date.now()), events: events.map(([type, at]) => ({ id: randomUUID(), type, occurredAt: iso(at) })) },
  });
  assert.ok(r.body.results.every((x: { status: string }) => x.status === "ACCEPTED"), r.text);
}
const interval = ({ id = randomUUID(), kind = "ACTIVE", app = "Code", start, end }: { id?: string; kind?: string; app?: string; start: number; end: number }) => ({
  id, kind, startedAt: iso(start), endedAt: iso(end),
  ...(kind === "ACTIVE" ? { applicationIdentifier: `com.example.${app}`, applicationName: app } : { applicationIdentifier: null, applicationName: null }),
});
const upload = (e: Emp, intervals: object[]) =>
  api("/activity/sync", { method: "POST", bearer: e.bearer, device: e.device, body: { sentAt: iso(Date.now()), platform: "macos", intervals } });
const statuses = (r: { body: { results: { status: string }[] } }) => r.body.results.map((x) => x.status);
const settings = (patch: object) => api("/settings/monitoring", { method: "PUT", cookie: admin, body: { ...DEFAULT_MONITORING_SETTINGS, reason: "test", ...patch } });

/** Seeds intervals directly (bypassing the offline limit), with their own closed session. */
async function seed(e: Emp, start: number, count: number, { step = 15_000, receivedAt = Date.now(), kinds = ["ACTIVE"] as string[], apps = ["Code"] } = {}) {
  const { rows } = await db.execute({ sql: "SELECT id FROM devices WHERE employee_id = ? AND revoked_at IS NULL", args: [e.id] });
  const session = randomUUID();
  await db.execute({
    sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, clock_out_at, status) VALUES (?, ?, ?, ?, ?, 'CLOSED')",
    args: [session, e.id, rows[0]!.id, iso(start), iso(start + count * step)],
  });
  const all: { kind: string; app: string | null; start: number; end: number }[] = [];
  for (let b = 0; b < count; b += 1000) {
    const stmts = [];
    for (let i = b; i < Math.min(count, b + 1000); i++) {
      const kind = kinds[i % kinds.length]!;
      const app = kind === "ACTIVE" ? apps[i % apps.length]! : null;
      const s = start + i * step;
      all.push({ kind, app, start: s, end: s + step });
      stmts.push({
        sql: `INSERT INTO activity_intervals (id, employee_id, device_id, attendance_session_id, kind, application_identifier, application_name,
                started_at, ended_at, active_seconds, idle_seconds, source, device_started_at, received_at, idempotency_key)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DESKTOP_MACOS', ?, ?, ?)`,
        args: [randomUUID(), e.id, rows[0]!.id, session, kind, app && `com.example.${app}`, app, iso(s), iso(s + step),
          kind === "ACTIVE" ? step / 1000 : 0, kind === "IDLE" ? step / 1000 : 0, iso(s), iso(receivedAt), randomUUID()],
      });
    }
    await db.batch(stmts, "write");
  }
  return all;
}

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [randomUUID(), await hashPassword(PASSWORD)] });
  const r = await api("/auth/login", { method: "POST", body: { email: "admin@example.com", password: PASSWORD } });
  admin = r.res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
});
after(() => app.close());

describe("monitoring settings", () => {
  test("admin-only, validated, append-only history with reason; desktops receive the new policy", async () => {
    const e = await employee();
    assert.equal((await api("/settings/monitoring", { bearer: e.bearer })).status, 403, "employees cannot read settings");
    assert.equal((await settings({}).then(() => api("/settings/monitoring", { method: "PUT", bearer: e.bearer, body: { ...DEFAULT_MONITORING_SETTINGS, reason: "x" } }))).status, 403);

    const initial = await api("/settings/monitoring", { cookie: admin });
    assert.equal(initial.status, 200);
    assert.ok(initial.body.notices.some((n: { version: string }) => n.version === DEFAULT_NOTICE_VERSION), "seeded activity notice listed");
    for (const [patch, field] of [
      [{ sampleSeconds: 2 }, "sampleSeconds"], [{ idleThresholdSeconds: 10 }, "idleThresholdSeconds"],
      [{ sampleSeconds: 60, idleThresholdSeconds: 90 }, "idleThresholdSeconds"], [{ retentionDays: 3 }, "retentionDays"],
      [{ noticeVersion: "missing" }, "noticeVersion"], [{ reason: "" }, "reason"], [{ captureWindowTitles: true }, "body"],
    ] as const) {
      const r = await settings(patch);
      assert.equal(r.status, 400, JSON.stringify(patch));
      assert.ok(JSON.stringify(r.body).includes(field), `${field}: ${r.text}`);
    }
    // Retention shorter than the offline limit (7 days) would purge freshly accepted offline uploads.
    assert.equal((await settings({ retentionDays: 7 })).status, 200);

    const changed = await settings({ sampleSeconds: 30, idleThresholdSeconds: 600, reason: "Lower sampling for the pilot" });
    assert.equal(changed.status, 200, changed.text);
    assert.deepEqual([changed.body.effective.sampleSeconds, changed.body.effective.idleThresholdSeconds, changed.body.effective.reason], [30, 600, "Lower sampling for the pilot"]);
    assert.equal(changed.body.effective.changedBy.email, "admin@example.com");
    assert.ok(changed.body.history.length >= 3, "every change is kept");
    const me = await api("/activity/me", { bearer: e.bearer });
    assert.deepEqual(me.body.policy, { enabled: true, sampleSeconds: 30, idleThresholdSeconds: 600 });
    await settings({});
  });

  test("monitoring switched off: nothing recorded after the switch is accepted, earlier activity still is", async () => {
    const e = await employee();
    await attendance(e, [["CLOCK_IN", Date.now() - H]]);
    const before = interval({ start: Date.now() - 20 * M, end: Date.now() - 10 * M });
    const off = Date.now();
    assert.equal((await settings({ enabled: false, reason: "Paused pending review" })).status, 200);
    assert.equal((await api("/activity/me", { bearer: e.bearer })).body.policy.enabled, false, "the desktop learns it is off");
    await sleep(1_200);
    const r = await upload(e, [before, interval({ app: "Mail", start: off + 50, end: Date.now() - 20 })]);
    assert.deepEqual(statuses(r), ["ACCEPTED", "REJECTED"], r.text);
    assert.match(r.body.results[1].reason, /turned off/);
    const report = await api(`/activity/summary?employeeId=${e.id}&from=${localDate(Date.now(), TZ)}&to=${localDate(Date.now(), TZ)}`, { cookie: admin });
    assert.ok(report.body.warnings.some((w: { code: string }) => w.code === "MONITORING_DISABLED"));
    await settings({});
  });

  test("notice version change: the new notice must be acknowledged; history keeps every acknowledgement", async () => {
    const e = await employee();
    const other = await employee();
    await attendance(e, [["CLOCK_IN", Date.now() - H]]);
    const v2 = { version: `2026-11-v2-${randomUUID().slice(0, 8)}`, title: "Activity monitoring (v2)", points: ["We record the foreground application while you are clocked in."], draft: false };
    assert.equal((await api("/settings/monitoring/notices", { method: "POST", bearer: e.bearer, body: v2 })).status, 403);
    assert.equal((await api("/settings/monitoring/notices", { method: "POST", cookie: admin, body: v2 })).status, 201);
    assert.equal((await api("/settings/monitoring/notices", { method: "POST", cookie: admin, body: { ...v2, title: "Edited" } })).status, 409, "notices are never edited");
    const underV1 = interval({ start: Date.now() - 20 * M, end: Date.now() - 10 * M });
    const switched = Date.now();
    assert.equal((await settings({ noticeVersion: v2.version })).status, 200);

    const me = await api("/activity/me", { bearer: e.bearer });
    assert.deepEqual([me.body.notice.version, me.body.notice.title, me.body.consent.acknowledgedAt], [v2.version, v2.title, null], "monitoring stops until acknowledged");
    await sleep(1_200);
    const r = await upload(e, [underV1, interval({ app: "Mail", start: switched + 50, end: Date.now() - 20 })]);
    assert.deepEqual(statuses(r), ["ACCEPTED", "REJECTED"], r.text);
    assert.match(r.body.results[1].reason, new RegExp(v2.version));

    assert.equal((await api("/activity/consent", { method: "POST", bearer: e.bearer, body: { noticeVersion: DEFAULT_NOTICE_VERSION } })).status, 400, "old notice no longer accepted");
    assert.ok((await api("/activity/consent", { method: "POST", bearer: e.bearer, body: { noticeVersion: v2.version } })).body.consent.acknowledgedAt);
    await sleep(1_100);
    assert.deepEqual(statuses(await upload(e, [interval({ app: "Notes", start: Date.now() - 1_050, end: Date.now() - 10 })])), ["ACCEPTED"]);
    const history = await api(`/activity/consents?employeeId=${e.id}`, { cookie: admin });
    assert.deepEqual(history.body.items.map((c: { noticeVersion: string }) => c.noticeVersion), [v2.version, DEFAULT_NOTICE_VERSION]);
    assert.equal((await api(`/activity/consents?employeeId=${e.id}`, { bearer: other.bearer })).status, 404, "no cross-employee access");
    await settings({});
  });
});

describe("retention", () => {
  test("dry run counts only; purge refused until approved; then deletes only expired activity, recorded", async () => {
    const e = await employee();
    const old = await seed(e, Date.now() - 40 * D, 120);
    await seed(e, Date.now() - 2 * D, 10);
    const total = Number((await db.execute("SELECT count(*) AS n FROM activity_intervals")).rows[0]!.n);
    assert.equal((await api("/activity/retention", { bearer: e.bearer })).status, 403);

    const preview = await api("/activity/retention", { cookie: admin });
    assert.equal(preview.status, 200);
    assert.deepEqual([preview.body.retentionDays, preview.body.approved, preview.body.eligibleIntervals, preview.body.eligibleEmployees], [30, false, old.length, 1]);
    assert.equal(Number((await db.execute("SELECT count(*) AS n FROM activity_intervals")).rows[0]!.n), total, "dry run deleted nothing");

    const refused = await api("/activity/retention/run", { method: "POST", cookie: admin, body: { confirm: true } });
    assert.equal(refused.status, 409);
    assert.equal((await api("/activity/retention/run", { method: "POST", cookie: admin, body: {} })).status, 400, "explicit confirmation");

    assert.equal((await settings({ retentionApproved: true, reason: "Approved by HR on 2026-10-13 (test)" })).status, 200);
    const ran = await api("/activity/retention/run", { method: "POST", cookie: admin, body: { confirm: true } });
    assert.equal(ran.status, 200, ran.text);
    assert.equal(ran.body.eligibleIntervals, 0);
    assert.equal(ran.body.runs[0].deleted, old.length);
    assert.equal(ran.body.runs[0].triggeredBy.email, "admin@example.com");
    assert.equal(Number((await db.execute("SELECT count(*) AS n FROM activity_intervals")).rows[0]!.n), total - old.length, "recent activity kept");
    assert.equal(Number((await db.execute({ sql: "SELECT count(*) AS n FROM attendance_sessions WHERE employee_id = ?", args: [e.id] })).rows[0]!.n), 2, "attendance untouched");
    await settings({});
  });
});

describe("reporting", () => {
  test("daily and weekly totals, clocked-in vs observed vs unobserved time, warnings", async () => {
    const e = await employee({ consentAgo: 7 * D });
    const today = localDate(Date.now(), TZ);
    // Three days ago: 2 h shift (2 × 1 h), only 50 min observed (30 Code + 10 Safari + 10 idle).
    const t = Date.now() - 3 * D;
    await attendance(e, [["CLOCK_IN", t], ["CLOCK_OUT", t + 2 * H]]);
    const r = await upload(e, [
      interval({ app: "Code", start: t, end: t + 30 * M }),
      interval({ app: "Safari", start: t + 30 * M, end: t + 40 * M }),
      interval({ kind: "IDLE", start: t + 40 * M, end: t + 50 * M }),
    ]);
    assert.deepEqual(statuses(r), ["ACCEPTED", "ACCEPTED", "ACCEPTED"], r.text);
    const from = addDays(today, -9);
    const s = await api(`/activity/summary?employeeId=${e.id}&from=${from}&to=${today}`, { cookie: admin });
    assert.equal(s.status, 200, s.text);
    const near = (a: number, b: number) => Math.abs(a - b) < 2_000;
    assert.equal(s.body.days.length, 10, "every day in the range");
    assert.ok(near(s.body.activeMs, 40 * M) && near(s.body.idleMs, 10 * M) && near(s.body.clockedInMs, 2 * H) && near(s.body.unobservedMs, 70 * M), JSON.stringify(s.body));
    const day = s.body.days.find((d: { date: string }) => d.date === localDate(t, TZ)) ?? s.body.days.find((d: { clockedInMs: number }) => d.clockedInMs > 0);
    assert.ok(day.clockedInMs > 0);
    assert.equal(s.body.days.reduce((n: number, d: { activeMs: number }) => n + d.activeMs, 0), s.body.activeMs, "days add up");
    assert.deepEqual(s.body.weeks.map((w: { weekStart: string }) => w.weekStart), [...new Set(s.body.days.map((d: { date: string }) => weekStart(d.date, 1)))]);
    assert.equal(s.body.weeks.reduce((n: number, w: { clockedInMs: number }) => n + w.clockedInMs, 0), s.body.clockedInMs, "weeks add up");
    assert.ok(s.body.warnings.some((w: { code: string; message: string }) => w.code === "UNOBSERVED_TIME" && /not counted as active or idle/.test(w.message)));
    assert.equal(s.body.freshness, "CURRENT");
    assert.deepEqual(s.body.applications.map((a: { applicationName: string }) => a.applicationName), ["Code", "Safari"]);
  });

  test("stale sync, missing consent and Windows devices are flagged", async () => {
    const e = await employee();
    await attendance(e, [["CLOCK_IN", Date.now() - 2 * H]]);
    await upload(e, [interval({ start: Date.now() - 2 * H, end: Date.now() - 110 * M })]);
    // The last upload happened an hour ago (rewritten directly: received_at is server-set).
    await db.execute({ sql: "DELETE FROM activity_intervals WHERE employee_id = ?", args: [e.id] });
    await seed(e, Date.now() - 3 * D, 4, { receivedAt: Date.now() - H });
    const today = localDate(Date.now(), TZ);
    const s = await api(`/activity/summary?employeeId=${e.id}&from=${today}&to=${today}`, { cookie: admin });
    assert.equal(s.body.freshness, "STALE");
    assert.ok(s.body.warnings.some((w: { code: string; message: string }) => w.code === "STALE_SYNC" && /60 min/.test(w.message)), s.text);

    const w = await employee({ consentAgo: null, platform: "windows" });
    const ws = await api(`/activity/summary?employeeId=${w.id}&from=${today}&to=${today}`, { cookie: admin });
    assert.deepEqual(ws.body.warnings.map((x: { code: string }) => x.code).sort(), ["NO_CONSENT", "UNSUPPORTED_PLATFORM"]);
    assert.equal(ws.body.freshness, "NO_DATA");
    assert.equal(ws.body.consent.acknowledgedAt, null);
  });

  test("large dataset: 12,000 intervals; SQL totals match the reference aggregation; pagination walks every row once", async () => {
    const e = await employee();
    const start = Date.parse(`${addDays(localDate(Date.now(), TZ), -6)}T00:00:00.000Z`) - 5.5 * H + 7_000; // crosses local midnights
    const rows = await seed(e, start, 12_000, { step: 37_000, kinds: ["ACTIVE", "ACTIVE", "IDLE"], apps: ["Code", "Safari", "Mail", "Slack", "Terminal"] });
    const from = localDate(start, TZ);
    const to = localDate(Date.now(), TZ);
    const t0 = performance.now();
    const s = await api(`/activity/summary?employeeId=${e.id}&from=${from}&to=${to}`, { cookie: admin });
    const elapsed = performance.now() - t0;
    assert.equal(s.status, 200, s.text);
    assert.ok(elapsed < 3_000, `summary took ${Math.round(elapsed)} ms`);
    const ref = summarizeActivity(
      rows.map((r) => ({ kind: r.kind as "ACTIVE", applicationIdentifier: r.app && `com.example.${r.app}`, applicationName: r.app, startedAt: iso(r.start), endedAt: iso(r.end) })),
      { from, to, timeZone: TZ },
    );
    assert.deepEqual([s.body.activeMs, s.body.idleMs], [ref.activeMs, ref.idleMs]);
    assert.deepEqual(
      Object.fromEntries(s.body.applications.map((a: { applicationName: string; activeMs: number }) => [a.applicationName, a.activeMs])),
      Object.fromEntries(ref.applications.map((a) => [a.applicationName, a.activeMs])),
    );
    for (const d of ref.days) {
      const got = s.body.days.find((x: { date: string }) => x.date === d.date);
      assert.deepEqual([got.activeMs, got.idleMs], [d.activeMs, d.idleMs], d.date);
    }

    const ids = new Set<string>();
    let last = "";
    for (let page = 1; ; page++) {
      const p = await api(`/activity/timeline?employeeId=${e.id}&from=${from}&to=${to}&page=${page}&pageSize=200`, { cookie: admin });
      assert.equal(p.status, 200);
      for (const i of p.body.items) {
        assert.ok(i.startedAt >= last, "chronological");
        last = i.startedAt;
        ids.add(i.id);
      }
      if (page * 200 >= p.body.total) {
        assert.equal(p.body.total, rows.length);
        break;
      }
    }
    assert.equal(ids.size, rows.length, "no row skipped or repeated");
    assert.equal((await api(`/activity/timeline?employeeId=${e.id}&from=${from}&to=${to}&pageSize=201`, { cookie: admin })).status, 400, "page size cap");
  });
});

describe("ingestion reliability", () => {
  test("a full 500-interval batch, duplicates inside a batch, and concurrent overlapping uploads never double count", async () => {
    const e = await employee();
    const t = Date.now() - 4 * H;
    await attendance(e, [["CLOCK_IN", t]]);
    const batch = Array.from({ length: 500 }, (_, i) => interval({ app: i % 2 ? "Code" : "Safari", start: t + i * 15_000, end: t + (i + 1) * 15_000 }));
    const t0 = performance.now();
    const r = await upload(e, [...batch.slice(0, 499), batch[0]!]);
    assert.ok(performance.now() - t0 < 3_000, "batched writes");
    assert.deepEqual(new Set(statuses(r)), new Set(["ACCEPTED", "DUPLICATE"]));
    assert.equal(statuses(r).filter((x) => x === "DUPLICATE").length, 1, "same id twice in one batch");

    // Two uploads at once: one retries the last interval, the other is a different recording of the same minute.
    const retry = upload(e, [batch[499]!]);
    const rival = upload(e, [interval({ app: "Mail", start: t + 499 * 15_000, end: t + 500 * 15_000 })]);
    const [a, b] = await Promise.all([retry, rival]);
    assert.deepEqual([...statuses(a), ...statuses(b)].sort(), ["ACCEPTED", "REJECTED"]);
    // A genuine sub-second interval (input resumed just before a break) is kept, not mistaken for an overlap.
    const short = await upload(e, [interval({ app: "Chrome", start: t + 500 * 15_000 + 10_000, end: t + 500 * 15_000 + 10_877 })]);
    assert.deepEqual(statuses(short), ["ACCEPTED"], short.text);
    const overlaps = await db.execute({
      sql: `SELECT count(*) AS n FROM activity_intervals x JOIN activity_intervals y
            ON x.employee_id = y.employee_id AND x.id < y.id AND x.started_at < y.ended_at AND x.ended_at > y.started_at WHERE x.employee_id = ?`,
      args: [e.id],
    });
    assert.equal(Number(overlaps.rows[0]!.n), 0);
    const today = localDate(Date.now(), TZ);
    const s = await api(`/activity/summary?from=${localDate(t, TZ)}&to=${today}`, { bearer: e.bearer });
    // Within the per-request clock-skew correction (a few ms); a double count would add 15 s.
    assert.ok(Math.abs(s.body.activeMs - 500 * 15_000 - 877) < 1_000, `observed time counted once: ${s.body.activeMs}`);
  });
});
