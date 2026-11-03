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
const { DEFAULT_NOTICE_VERSION, localDate } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "employee password 1";
const TZ = "Asia/Kolkata";
const H = 3_600_000;
const M = 60_000;

let app: INestApplication;
let base: string;
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
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

let seq = 0;
async function employee({ consent = true } = {}) {
  const n = ++seq;
  const r = await api("/employees", { method: "POST", cookie: admin, body: { email: `act${n}@example.com`, employeeCode: `ACT-${n}`, fullName: `Activity ${n}`, timezone: TZ } });
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const login = await api("/auth/login", { method: "POST", body: { email: `act${n}@example.com`, password: PASSWORD, client: "desktop" } });
  const e = { id: r.body.employee.id as string, bearer: login.body.accessToken as string, device: randomUUID() };
  await api("/devices/register", { method: "POST", bearer: e.bearer, body: { installationId: e.device, deviceName: "Mac", platform: "macos" } });
  // Acknowledged a day ago: uploads are checked against when the notice was acknowledged.
  if (consent) await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), e.id, DEFAULT_NOTICE_VERSION, iso(Date.now() - 24 * H)] });
  return e;
}
type Emp = Awaited<ReturnType<typeof employee>>;

async function attendance(e: Emp, events: [string, number][]) {
  const r = await api("/attendance/sync", {
    method: "POST", bearer: e.bearer, device: e.device,
    body: { sentAt: iso(Date.now()), events: events.map(([type, at]) => ({ id: randomUUID(), type, occurredAt: iso(at) })) },
  });
  assert.ok(r.body.results.every((x: { status: string }) => x.status === "ACCEPTED"), r.text);
}

type Iv = { id?: string; kind?: "ACTIVE" | "IDLE"; app?: string | null; start: number; end: number };
const interval = ({ id = randomUUID(), kind = "ACTIVE", app = "Code", start, end }: Iv) => ({
  id, kind, startedAt: iso(start), endedAt: iso(end),
  ...(kind === "ACTIVE" ? { applicationIdentifier: `com.example.${app}`, applicationName: app } : { applicationIdentifier: null, applicationName: null }),
});
const upload = (e: Emp, intervals: object[], sentAt = iso(Date.now()), device = e.device) =>
  api("/activity/sync", { method: "POST", bearer: e.bearer, device, body: { sentAt, platform: "macos", intervals } });
const statuses = (r: { body: { results: { status: string }[] } }) => r.body.results.map((x) => x.status);

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

describe("consent and policy", () => {
  test("activity is refused until the current monitoring notice is acknowledged, and never accepted from before it", async () => {
    const e = await employee({ consent: false });
    const me = await api("/activity/me", { bearer: e.bearer });
    assert.deepEqual(me.body.policy, { enabled: true, sampleSeconds: 15, idleThresholdSeconds: 300, idleExcludedApps: [] });
    assert.deepEqual(me.body.consent, { noticeVersion: DEFAULT_NOTICE_VERSION, acknowledgedAt: null });
    assert.equal(me.body.notice.version, DEFAULT_NOTICE_VERSION);
    assert.equal(me.body.notice.points.length, 5, "notice text is served by the API");
    await attendance(e, [["CLOCK_IN", Date.now() - H]]);
    const refused = await upload(e, [interval({ start: Date.now() - 30 * M, end: Date.now() - 29 * M })]);
    assert.equal(refused.status, 403);
    assert.equal((await api("/activity/consent", { method: "POST", bearer: e.bearer, body: { noticeVersion: "old-version" } })).status, 400);
    const ok = await api("/activity/consent", { method: "POST", bearer: e.bearer, body: { noticeVersion: DEFAULT_NOTICE_VERSION } });
    assert.ok(ok.body.consent.acknowledgedAt);
    assert.equal((await api("/activity/consent", { method: "POST", bearer: e.bearer, body: { noticeVersion: DEFAULT_NOTICE_VERSION } })).status, 200, "idempotent");
    const r = await upload(e, [interval({ start: Date.now() - 30 * M, end: Date.now() - 29 * M }), interval({ start: Date.now() - 20_000, end: Date.now() - 5_000 })]);
    assert.deepEqual(statuses(r), ["REJECTED", "ACCEPTED"], r.text);
    assert.match(r.body.results[0].reason, /before the required monitoring notice/);
    const history = await api("/activity/consents", { bearer: e.bearer });
    assert.deepEqual(history.body.items.map((c: { noticeVersion: string }) => c.noticeVersion), [DEFAULT_NOTICE_VERSION], "acknowledged once");
  });
});

describe("activity ingestion", () => {
  test("app switching and idle: per-app totals, idle separate, today and session totals, paginated timeline", async () => {
    const e = await employee();
    const t = Date.now() - 2 * H;
    await attendance(e, [["CLOCK_IN", t]]);
    const r = await upload(e, [
      interval({ app: "Code", start: t, end: t + 60 * M }),
      interval({ app: "Safari", start: t + 60 * M, end: t + 70 * M }),
      interval({ kind: "IDLE", start: t + 70 * M, end: t + 90 * M }),
    ]);
    assert.deepEqual(statuses(r), ["ACCEPTED", "ACCEPTED", "ACCEPTED"], r.text);
    const day = localDate(t, TZ);
    const today = localDate(Date.now(), TZ);
    const s = await api(`/activity/summary?from=${day}&to=${today}`, { bearer: e.bearer });
    assert.equal(s.status, 200, s.text);
    const near = (a: number, b: number) => Math.abs(a - b) < 2_000;
    assert.ok(near(s.body.activeMs, 70 * M) && near(s.body.idleMs, 20 * M), JSON.stringify(s.body));
    assert.deepEqual(s.body.applications.map((a: { applicationName: string }) => a.applicationName), ["Code", "Safari"]);
    assert.ok(s.body.lastReceivedAt && s.body.deviceLastSeenAt);
    const me = await api("/activity/me", { bearer: e.bearer });
    assert.ok(near(me.body.currentSession.activeMs, 70 * M) && near(me.body.currentSession.idleMs, 20 * M));
    const tl = await api(`/activity/timeline?from=${day}&to=${today}&pageSize=2`, { bearer: e.bearer });
    assert.deepEqual([tl.body.total, tl.body.items.length, tl.body.items[0].applicationName], [3, 2, "Code"]);
    assert.ok(!("deviceId" in tl.body.items[0]) && !("device_id" in tl.body.items[0]), "no device identifiers in responses");
  });

  test("duplicate uploads (retries) are idempotent", async () => {
    const e = await employee();
    await attendance(e, [["CLOCK_IN", Date.now() - H]]);
    const batch = [interval({ start: Date.now() - 40 * M, end: Date.now() - 30 * M }), interval({ kind: "IDLE", start: Date.now() - 30 * M, end: Date.now() - 25 * M })];
    assert.deepEqual(statuses(await upload(e, batch)), ["ACCEPTED", "ACCEPTED"]);
    assert.deepEqual(statuses(await upload(e, batch)), ["DUPLICATE", "DUPLICATE"]);
    const n = await db.execute({ sql: "SELECT count(*) AS n FROM activity_intervals WHERE employee_id = ?", args: [e.id] });
    assert.equal(Number(n.rows[0]!.n), 2);
  });

  test("only clocked-in, non-break time is accepted; small edges are trimmed", async () => {
    const e = await employee();
    const t = Date.now() - 5 * H;
    await attendance(e, [["CLOCK_IN", t], ["BREAK_START", t + H], ["BREAK_END", t + 2 * H], ["CLOCK_OUT", t + 3 * H]]);
    const r = await upload(e, [
      interval({ start: t - 30 * M, end: t - 20 * M }), // before clock-in
      interval({ start: t + 70 * M, end: t + 80 * M }), // during the break
      interval({ start: t + 3 * H + 10 * M, end: t + 3 * H + 20 * M }), // after clock-out
      interval({ start: t - 30_000, end: t + 10 * M }), // 30 s before clock-in: trimmed
    ]);
    assert.deepEqual(statuses(r), ["REJECTED", "REJECTED", "REJECTED", "ACCEPTED"], r.text);
    assert.match(r.body.results[1].reason, /outside clocked-in time/);
    const row = await db.execute({ sql: "SELECT started_at FROM activity_intervals WHERE employee_id = ?", args: [e.id] });
    assert.ok(Math.abs(Date.parse(String(row.rows[0]!.started_at)) - t) < 2_000, "trimmed to clock-in");
  });

  test("no time is counted twice: large overlaps rejected, small ones trimmed", async () => {
    const e = await employee();
    const t = Date.now() - 2 * H;
    await attendance(e, [["CLOCK_IN", t]]);
    await upload(e, [interval({ start: t, end: t + 30 * M })]);
    const r = await upload(e, [interval({ app: "Safari", start: t + 10 * M, end: t + 20 * M }), interval({ app: "Mail", start: t + 30 * M - 20_000, end: t + 40 * M })]);
    assert.deepEqual(statuses(r), ["REJECTED", "ACCEPTED"]);
    const s = await api(`/activity/summary?from=${localDate(t, TZ)}&to=${localDate(Date.now(), TZ)}`, { bearer: e.bearer });
    assert.ok(Math.abs(s.body.activeMs - 40 * M) < 2_000, `total ${s.body.activeMs}`);
  });

  test("clock skew: a device 2 h slow is corrected with its send time; raw device time kept", async () => {
    const e = await employee();
    const now = Date.now();
    await attendance(e, [["CLOCK_IN", now - H]]);
    const skew = -2 * H;
    const r = await upload(e, [interval({ start: now - 20 * M + skew, end: now - 10 * M + skew })], iso(now + skew));
    assert.deepEqual(statuses(r), ["ACCEPTED"], r.text);
    const row = (await db.execute({ sql: "SELECT started_at, device_started_at FROM activity_intervals WHERE employee_id = ?", args: [e.id] })).rows[0]!;
    assert.ok(Math.abs(Date.parse(String(row.started_at)) - (now - 20 * M)) < 5_000);
    assert.equal(row.device_started_at, iso(now - 20 * M + skew));
  });

  test("revoked or unknown devices cannot upload", async () => {
    const e = await employee();
    await attendance(e, [["CLOCK_IN", Date.now() - H]]);
    const iv = [interval({ start: Date.now() - 20 * M, end: Date.now() - 10 * M })];
    assert.equal((await upload(e, iv, iso(Date.now()), randomUUID())).status, 403);
    const dev = await api("/devices/me", { bearer: e.bearer, device: e.device });
    await api(`/devices/${dev.body.device.id}/revoke`, { method: "POST", cookie: admin });
    assert.equal((await upload(e, iv)).status, 401, "the device's session is revoked with it (API-08)");
  });

  test("validation: no window titles/URLs/extra fields, bounded batches and ranges", async () => {
    const e = await employee();
    const base = interval({ start: Date.now() - 2 * M, end: Date.now() - M });
    assert.equal((await upload(e, [{ ...base, windowTitle: "Salary review.xlsx" }])).status, 400);
    assert.equal((await upload(e, [{ ...base, url: "https://mail.example.com/inbox" }])).status, 400);
    assert.equal((await upload(e, Array.from({ length: 501 }, () => base))).status, 400, "batch cap");
    const big = await api("/activity/sync", { method: "POST", bearer: e.bearer, device: e.device, body: { pad: "x".repeat(1_100_000) } });
    assert.equal(big.status, 413, "oversized bodies are a client error, not a 500");
    assert.equal((await api("/activity/summary?from=2026-01-01&to=2026-03-01", { bearer: e.bearer })).status, 400);
    assert.equal((await api("/activity/timeline?from=2026-01-02&to=2026-01-01", { bearer: e.bearer })).status, 400);
  });
});

describe("authorization", () => {
  test("employees see only their own activity; admins can filter by employee", async () => {
    const a = await employee();
    const b = await employee();
    await attendance(a, [["CLOCK_IN", Date.now() - H]]);
    await upload(a, [interval({ app: "Secret Project", start: Date.now() - 30 * M, end: Date.now() - 20 * M })]);
    const today = localDate(Date.now(), TZ);
    const q = `from=${today}&to=${today}`;
    assert.equal((await api(`/activity/summary?${q}&employeeId=${a.id}`, { bearer: b.bearer })).status, 404);
    assert.equal((await api(`/activity/timeline?${q}&employeeId=${a.id}`, { bearer: b.bearer })).status, 404);
    const own = await api(`/activity/summary?${q}`, { bearer: b.bearer });
    assert.equal(own.body.activeMs, 0);
    assert.ok(!own.text.includes("Secret Project"));
    const asAdmin = await api(`/activity/summary?${q}&employeeId=${a.id}`, { cookie: admin });
    assert.equal(asAdmin.body.applications[0].applicationName, "Secret Project");
    assert.equal((await api(`/activity/summary?${q}`, { cookie: admin })).status, 403, "admin without profile must pick an employee");
    assert.equal((await api("/activity/me")).status, 401);
    assert.equal((await api("/activity/sync", { method: "POST", cookie: admin, body: {} })).status, 400);
  });
});
