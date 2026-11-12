// F04 website usage (in-process API, in-memory DB, synthetic data). Domain names only, from a paired
// extension token; collection needs the policy on, the website notice acknowledged and an open shift
// without a break. No real browser here: see apps/browser-extension and verify-websites for that.
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
const { WebsitesService } = await import("../dist/websites/websites.service.js");
const { MonitoringSettingsService } = await import("../dist/settings/monitoring-settings.service.js");
const { EmployeesService } = await import("../dist/employees/employees.service.js");
const { DEFAULT_WEBSITE_NOTICE_VERSION, localDate } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "website password 1";
const M = 60_000;
let app: INestApplication;
let base: string;
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
let admin: string;

type Opts = { method?: string; body?: unknown; cookie?: string; bearer?: string; headers?: Record<string, string> };
async function api(path: string, { method = "GET", body, cookie, bearer, headers: extra = {} }: Opts = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, ...extra };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text };
}
const iso = (ms: number) => new Date(ms).toISOString();
const today = () => localDate(Date.now(), "UTC");

let seq = 0;
async function employee() {
  const n = ++seq;
  const email = `web${n}@example.com`;
  const r = await api("/employees", { method: "POST", cookie: admin, body: { email, employeeCode: `WEB-${n}`, fullName: `Web ${n}`, timezone: "UTC" } });
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const bearer = (await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } })).body.accessToken as string;
  const device = randomUUID();
  await api("/devices/register", { method: "POST", bearer, body: { installationId: device, deviceName: "Mac", platform: "macos" } });
  return { id: r.body.employee.id as string, bearer, device };
}
type Emp = Awaited<ReturnType<typeof employee>>;
const attend = (e: Emp, action: string) => api(`/attendance/${action}`, { method: "POST", bearer: e.bearer, headers: { "x-device-id": e.device, "idempotency-key": randomUUID() } });
const policy = (enabled: boolean, retentionDays = 30) => api("/websites/policy", { method: "PUT", cookie: admin, body: { enabled, retentionDays, noticeVersion: DEFAULT_WEBSITE_NOTICE_VERSION, reason: enabled ? "pilot (test)" : "paused (test)" } });
async function pair(e: Emp, label = "Chrome") {
  const code = (await api("/websites/links", { method: "POST", bearer: e.bearer })).body.code as string;
  const r = await api("/websites/extension/pair", { method: "POST", body: { code, label } });
  assert.equal(r.status, 201, r.text);
  return r.body.token as string;
}
const send = (token: string, intervals: object[], sentAt = iso(Date.now())) => api("/websites/extension/intervals", { method: "POST", bearer: token, body: { sentAt, intervals } });
const iv = (domain: string, startAgoS: number, durS: number, now = Date.now()) => ({ id: randomUUID(), domain, startedAt: iso(now - startAgoS * 1000), endedAt: iso(now - (startAgoS - durS) * 1000) });
const stored = async (employeeId: string) => (await db.execute({ sql: "SELECT * FROM website_intervals WHERE employee_id = ? ORDER BY started_at", args: [employeeId] })).rows;
/** Policy on since two hours ago (a direct, backdated row: intervals before a policy started are refused). */
const enabledSince2h = async () =>
  db.execute({ sql: "INSERT INTO website_policies (enabled, retention_days, notice_version, reason, changed_by, effective_at) SELECT 1, 30, ?, 'test: on since 2 h', id, ? FROM users WHERE email = 'admin@example.com'", args: [DEFAULT_WEBSITE_NOTICE_VERSION, iso(Date.now() - 2 * 3_600_000)] });
/** Ready to record: policy on, notice acknowledged, extension paired, clocked in a while ago (synced). */
async function ready() {
  await enabledSince2h();
  const e = await employee();
  await api("/attendance/sync", { method: "POST", bearer: e.bearer, headers: { "x-device-id": e.device }, body: { sentAt: iso(Date.now()), events: [{ id: randomUUID(), type: "CLOCK_IN", occurredAt: iso(Date.now() - 60 * M) }] } });
  await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), e.id, DEFAULT_WEBSITE_NOTICE_VERSION, iso(Date.now() - 59 * M)] });
  return { ...e, token: await pair(e) };
}

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  await db.execute({ sql: "INSERT INTO users (id, email, role, admin_title, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', 'SUPER_ADMIN', ?)", args: [randomUUID(), await hashPassword(PASSWORD)] });
  const login = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email: "admin@example.com", password: PASSWORD }) });
  admin = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
});
after(() => app.close());

describe("website usage", () => {
  test("off by default: nothing can be recorded; the employee is told exactly why", async () => {
    assert.equal((await api("/websites/policy", { cookie: admin })).body.current.enabled, false);
    const e = await employee();
    const token = await pair(e);
    assert.equal((await api("/websites/extension/state", { bearer: token })).body.idleSeconds, 300, "the organization's idle threshold");
    const me = (await api("/websites/me", { bearer: e.bearer })).body;
    assert.equal(me.collecting, false);
    assert.equal(me.notice.draft, true, "the website notice is a draft");
    for (const reason of [/turned off/, /not acknowledged/, /clocked out/]) assert.ok(me.reasons.some((r: string) => reason.test(r)), String(reason));
    assert.equal((await api("/websites/extension/state", { bearer: token })).body.collect, false);
    const r = await send(token, [iv("example.com", 120, 60)]);
    assert.deepEqual(r.body.results.map((x: { status: string; reason: string }) => [x.status, x.reason]), [["REJECTED", "Website tracking is turned off"]]);
    assert.equal((await stored(e.id)).length, 0);
  });

  test("admin-only policy, reports, categories, audit and retention; validated input", async () => {
    const e = await employee();
    for (const [method, path, body] of [
      ["GET", "/websites/policy"], ["PUT", "/websites/policy", { enabled: true, retentionDays: 30, noticeVersion: DEFAULT_WEBSITE_NOTICE_VERSION, reason: "x y z" }],
      ["GET", `/websites/report?from=${today()}&to=${today()}`], ["GET", "/websites/categories"], ["POST", "/websites/categories", { domain: "example.com", match: "EXACT", category: "NEUTRAL" }],
      ["GET", "/websites/audit"], ["POST", "/websites/retention/run"],
    ] as [string, string, object?][]) {
      assert.equal((await api(path, { method, bearer: e.bearer, body })).status, 403, `${method} ${path}`);
      assert.equal((await api(path, { method, body })).status, 401, `${method} ${path} signed out`);
    }
    for (const body of [{ enabled: true, retentionDays: 0 }, { enabled: true, retentionDays: 400 }, { enabled: true, reason: "" }, { enabled: "yes" }, { enabled: true, extra: 1 }]) {
      assert.equal((await api("/websites/policy", { method: "PUT", cookie: admin, body: { retentionDays: 30, noticeVersion: DEFAULT_WEBSITE_NOTICE_VERSION, reason: "valid reason", ...body } })).status, 400, JSON.stringify(body));
    }
    assert.equal((await api("/websites/policy", { method: "PUT", cookie: admin, body: { enabled: true, retentionDays: 30, noticeVersion: "no-such-notice", reason: "valid reason" } })).status, 400);
    assert.equal((await api(`/websites/me/usage?from=${today()}&to=${today()}&employeeId=${e.id}`, { bearer: e.bearer })).status, 400, "own usage only");
  });

  test("recording: domain only, server time, every rule enforced per interval", async () => {
    assert.equal((await policy(true)).status, 200);
    const e = await ready();
    const status = (await api("/websites/me", { bearer: e.bearer })).body;
    assert.deepEqual([status.collecting, status.reasons], [true, []], JSON.stringify(status.reasons));
    assert.deepEqual(status.links.map((l: { label: string }) => l.label), ["Chrome"]);
    const now = Date.now();
    // The browser clock is 1 hour fast: the server corrects with sentAt.
    const fast = 3_600_000;
    const ok = { id: randomUUID(), domain: "WWW.Docs.Example.COM.", startedAt: iso(now - 600_000 + fast), endedAt: iso(now - 540_000 + fast) };
    const bad = [
      ["https://example.com/path?q=1", "Not a website domain"], ["example.com/inbox", "Not a website domain"], ["example.com?q=secret", "Not a website domain"],
      ["192.168.1.10", "Not a website domain"], ["localhost", "Not a website domain"], ["user:pass@example.com", "Not a website domain"],
    ].map(([domain], k) => ({ id: randomUUID(), domain, startedAt: iso(now - 500_000 + k * 2000 + fast), endedAt: iso(now - 499_000 + k * 2000 + fast) }));
    const r = await send(e.token, [ok, ...bad], iso(now + fast));
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.results.map((x: { status: string }) => x.status), ["ACCEPTED", ...bad.map(() => "REJECTED")]);
    const rows = await stored(e.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.domain, "docs.example.com", "normalized: lowercase, no www, no trailing dot");
    assert.ok(Math.abs(Date.parse(String(rows[0]!.started_at)) - (now - 600_000)) < 2000, "start corrected to server time");
    assert.equal(rows[0]!.duration_ms, 60_000);
    assert.ok(!JSON.stringify(rows).match(/path|q=|secret|https|192\.168|pass/), "nothing but the domain is stored");
    const rules = [
      [iv("a.example.com", 300, 0.5), "Invalid duration"], [iv("a.example.com", 3000, 1200), "Invalid duration"], [iv("a.example.com", -60, 30), "In the future"],
      [iv("a.example.com", 26 * 3600, 60), "Too old"], [iv("a.example.com", 59.5 * 60, 10), "Before the website notice was acknowledged"],
    ] as const;
    const res = await send(e.token, rules.map(([x]) => x));
    assert.deepEqual(res.body.results.map((x: { reason: string }) => x.reason), rules.map(([, reason]) => reason));
    // Duplicate (same client id) and overlap.
    assert.equal((await send(e.token, [ok], iso(now + fast))).body.results[0].status, "DUPLICATE");
    assert.match((await send(e.token, [iv("b.example.com", 590, 30, now)])).body.results[0].reason, /Overlaps/);
    // Page titles, URLs or an employee id can't even be sent.
    for (const extra of [{ url: "https://example.com/x" }, { title: "Inbox" }, { employeeId: randomUUID() }]) {
      assert.equal((await send(e.token, [{ ...iv("c.example.com", 200, 10), ...extra }])).status, 400, JSON.stringify(extra));
    }
    assert.equal((await api("/websites/extension/intervals", { method: "POST", bearer: e.token, body: { sentAt: iso(now), intervals: [iv("c.example.com", 200, 10)], employeeId: randomUUID() } })).status, 400);
  });

  test("only while clocked in and not on a break; disabling stops recording and keeps what exists", async () => {
    await policy(true);
    const e = await ready();
    assert.equal((await send(e.token, [iv("before-break.example.com", 120, 60)])).body.results[0].status, "ACCEPTED");
    assert.equal((await attend(e, "break/start")).status, 200);
    assert.equal((await api("/websites/extension/state", { bearer: e.token })).body.collect, false);
    await new Promise((r) => setTimeout(r, 1200));
    assert.match((await send(e.token, [iv("during-break.example.com", 1.1, 1.05)])).body.results[0].reason ?? "", /clocked-in period outside breaks/);
    await attend(e, "break/end");
    await attend(e, "clock-out");
    await new Promise((r) => setTimeout(r, 1200));
    assert.match((await send(e.token, [iv("after-out.example.com", 1.1, 1.05)])).body.results[0].reason ?? "", /clocked-in period/);
    assert.match((await api("/websites/me", { bearer: e.bearer })).body.reasons.join(" "), /clocked out/);
    // Disabled: nothing more is accepted; the existing record stays (no backfill, no silent deletion).
    const f = await ready();
    await policy(false);
    assert.equal((await api("/websites/extension/state", { bearer: f.token })).body.collect, false);
    assert.equal((await send(f.token, [iv("x.example.com", 60, 30)])).body.results[0].status, "REJECTED");
    assert.equal((await stored(e.id)).length, 1);
    await policy(true);
  });

  test("identity and isolation: tokens bound to one employee, revocable; own usage only; codes single-use and expiring", async () => {
    await policy(true);
    const [a, b] = [await ready(), await ready()];
    await send(a.token, [iv("private-a.example.com", 300, 60)]);
    await send(b.token, [iv("b-only.example.com", 300, 60)]);
    const usageB = await api(`/websites/me/usage?from=${today()}&to=${today()}`, { bearer: b.bearer });
    assert.deepEqual(usageB.body.byDomain.map((d: { domain: string }) => d.domain), ["b-only.example.com"]);
    assert.ok(!usageB.text.includes("private-a"));
    const linkA = (await api("/websites/me", { bearer: a.bearer })).body.links[0].id;
    assert.equal((await api(`/websites/links/${linkA}`, { method: "DELETE", bearer: b.bearer })).status, 404, "not B's connection");
    assert.equal((await api(`/websites/links/${linkA}`, { method: "DELETE", bearer: a.bearer })).status, 200);
    assert.equal((await send(a.token, [iv("after-revoke.example.com", 30, 10)])).status, 401, "disconnected token refused");
    assert.equal((await api("/websites/extension/state", { bearer: "x".repeat(43) })).status, 401);
    assert.equal((await api("/websites/extension/state")).status, 401);
    assert.equal((await api("/websites/extension/state", { bearer: a.bearer })).status, 401, "a session token is not an extension token");
    const code = (await api("/websites/links", { method: "POST", bearer: a.bearer })).body.code;
    assert.equal((await api("/websites/extension/pair", { method: "POST", body: { code, label: "Edge" } })).status, 201);
    assert.equal((await api("/websites/extension/pair", { method: "POST", body: { code, label: "Again" } })).status, 400, "single use");
    const old = (await api("/websites/links", { method: "POST", bearer: a.bearer })).body.code;
    await db.execute({ sql: "UPDATE website_extension_links SET pairing_expires_at = ? WHERE claimed_at IS NULL", args: [iso(Date.now() - 1000)] });
    assert.equal((await api("/websites/extension/pair", { method: "POST", body: { code: old, label: "Late" } })).status, 400, "expired");
    // Pairing works from the extension's own origin (no cookies involved); other POSTs keep the origin check.
    const fromExtension = await fetch(`${base}/api/v1/websites/extension/pair`, { method: "POST", headers: { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop", "content-type": "application/json" }, body: JSON.stringify({ code: "ZZZZZZZZ", label: "x" }) });
    assert.equal(fromExtension.status, 400, "reaches validation of the code (not blocked by origin)");
    const csrf = await fetch(`${base}/api/v1/websites/consent`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json", cookie: admin }, body: JSON.stringify({ noticeVersion: "x" }) });
    assert.equal(csrf.status, 403, "cookie-capable requests from other origins are still refused");
    const self = await api("/websites/extension/disconnect", { method: "POST", bearer: b.token });
    assert.equal(self.status, 200);
    assert.equal((await api("/websites/extension/state", { bearer: b.token })).status, 401);
    const hashes = JSON.stringify((await db.execute("SELECT pairing_code_hash, token_hash FROM website_extension_links")).rows);
    assert.ok(!hashes.includes(code) && !hashes.includes(b.token), "only hashes of codes and tokens are stored");
  });

  test("categories: admin rules with documented precedence; unclassified by default; reports and filters; audit", async () => {
    await policy(true);
    const e = await ready();
    const now = Date.now();
    await send(e.token, [iv("docs.example.com", 900, 120, now), iv("mail.example.com", 700, 60, now), iv("play.games.example.com", 600, 30, now), iv("unknown.org", 500, 90, now)]);
    for (const rule of [{ domain: "example.com", match: "SUBDOMAINS", category: "NEUTRAL" }, { domain: "docs.example.com", match: "EXACT", category: "PRODUCTIVE" }, { domain: "games.example.com", match: "SUBDOMAINS", category: "UNPRODUCTIVE" }]) {
      assert.equal((await api("/websites/categories", { method: "POST", cookie: admin, body: rule })).status, 201);
    }
    assert.equal((await api("/websites/categories", { method: "POST", cookie: admin, body: { domain: "Example.com", match: "SUBDOMAINS", category: "PRODUCTIVE" } })).status, 409, "same rule (normalized)");
    assert.equal((await api("/websites/categories", { method: "POST", cookie: admin, body: { domain: "example.com/x", match: "EXACT", category: "PRODUCTIVE" } })).status, 400);
    assert.equal((await api("/websites/categories", { method: "POST", cookie: admin, body: { domain: "x.com", match: "EXACT", category: "GREAT" } })).status, 400);
    const r = (await api(`/websites/report?from=${today()}&to=${today()}&employeeId=${e.id}`, { cookie: admin })).body;
    const cat = Object.fromEntries(r.byDomain.map((d: { domain: string; category: string }) => [d.domain, d.category]));
    assert.deepEqual(cat, { "docs.example.com": "PRODUCTIVE", "mail.example.com": "NEUTRAL", "play.games.example.com": "UNPRODUCTIVE", "unknown.org": "UNCLASSIFIED" }, "exact beats subdomain; longest subdomain rule wins");
    assert.equal(r.totalMs, 300_000);
    assert.equal(r.unclassifiedMs, 90_000);
    assert.equal(r.byEmployee[0].durationMs, 300_000);
    assert.ok(r.acknowledged.count >= 1 && r.acknowledged.of >= r.acknowledged.count);
    assert.ok(!JSON.stringify(r).match(/score|rank|productivity/i), "no scores or rankings");
    const unproductive = (await api(`/websites/report?from=${today()}&to=${today()}&employeeId=${e.id}&category=UNPRODUCTIVE`, { cookie: admin })).body;
    assert.deepEqual(unproductive.byDomain.map((d: { domain: string }) => d.domain), ["play.games.example.com"]);
    const own = (await api(`/websites/me/usage?from=${today()}&to=${today()}`, { bearer: e.bearer })).body;
    assert.equal(own.byDomain.find((d: { domain: string }) => d.domain === "unknown.org").category, "UNCLASSIFIED");
    const rules = (await api("/websites/categories", { cookie: admin })).body;
    const games = rules.find((x: { domain: string }) => x.domain === "games.example.com");
    assert.equal((await api(`/websites/categories/${games.id}`, { method: "PATCH", cookie: admin, body: { category: "NEUTRAL" } })).status, 200);
    assert.equal((await api(`/websites/categories/${games.id}`, { method: "DELETE", cookie: admin })).status, 200);
    assert.equal((await api(`/websites/categories/${games.id}`, { method: "DELETE", cookie: admin })).status, 404);
    const audit = (await api("/websites/audit", { cookie: admin })).body.map((x: { action: string; by: string }) => `${x.action}:${x.by}`);
    for (const a of ["RULE_ADDED:admin@example.com", "RULE_CHANGED:admin@example.com", "RULE_REMOVED:admin@example.com"]) assert.ok(audit.includes(a), a);
    const history = (await api("/websites/policy", { cookie: admin })).body.history;
    assert.ok(history.length >= 3 && history.every((h: { changedBy: string; reason: string }) => h.changedBy === "admin@example.com" && h.reason.length >= 3), "every policy change has who and why");
  });

  test("reports: daily rows per employee and domain, employee counts, domain filter with subdomains; explicit Unclassified rules; notification status", async () => {
    const [a, b] = [await ready(), await ready()];
    const now = Date.now();
    await send(a.token, [iv("wiki.corp-example.com", 900, 60, now), iv("chat.corp-example.com", 800, 30, now), iv("elsewhere.net", 700, 20, now)]);
    await send(b.token, [iv("wiki.corp-example.com", 900, 40, now)]);
    const t = today();
    const r = (await api(`/websites/report?from=${t}&to=${t}&domain=corp-example.com`, { cookie: admin })).body;
    assert.deepEqual(r.byDomain.map((d: { domain: string; employees: number }) => [d.domain, d.employees]), [["wiki.corp-example.com", 2], ["chat.corp-example.com", 1]], "domain filter covers subdomains only");
    assert.equal(r.employeesWithActivity, 2);
    assert.deepEqual(r.rows.filter((x: { employee: { id: string } }) => x.employee.id === a.id).map((x: { date: string; domain: string; durationMs: number }) => [x.date, x.domain, x.durationMs]).sort(), [[t, "chat.corp-example.com", 30_000], [t, "wiki.corp-example.com", 60_000]]);
    assert.equal((await api(`/websites/report?from=${t}&to=${t}&domain=example.com/x`, { cookie: admin })).status, 400);
    // New rules start Unclassified; an explicit Unclassified exact rule overrides a broader rule.
    const added = await api("/websites/categories", { method: "POST", cookie: admin, body: { domain: "corp-example.com", match: "SUBDOMAINS" } });
    assert.equal(added.body.find((x: { domain: string }) => x.domain === "corp-example.com").category, "UNCLASSIFIED");
    const rule = added.body.find((x: { domain: string }) => x.domain === "corp-example.com");
    await api(`/websites/categories/${rule.id}`, { method: "PATCH", cookie: admin, body: { category: "PRODUCTIVE" } });
    await api("/websites/categories", { method: "POST", cookie: admin, body: { domain: "chat.corp-example.com", match: "EXACT", category: "UNCLASSIFIED" } });
    const cats = Object.fromEntries((await api(`/websites/report?from=${t}&to=${t}&domain=corp-example.com`, { cookie: admin })).body.byDomain.map((d: { domain: string; category: string }) => [d.domain, d.category]));
    assert.deepEqual(cats, { "wiki.corp-example.com": "PRODUCTIVE", "chat.corp-example.com": "UNCLASSIFIED" });
    const own = (await api(`/websites/me/usage?from=${t}&to=${t}`, { bearer: a.bearer })).body;
    assert.ok(own.rows.every((x: Record<string, unknown>) => !("employee" in x)) && own.byDomain.every((x: Record<string, unknown>) => !("employees" in x)), "own usage has no other-employee fields");
    const notes = (await api("/websites/notifications", { cookie: admin })).body;
    const mine = notes.employees.find((x: { employee: { id: string } }) => x.employee.id === a.id);
    assert.ok(mine.acknowledgedAt && mine.connectedBrowsers === 1);
    assert.ok(notes.employees.some((x: { acknowledgedAt: string | null }) => x.acknowledgedAt === null), "employees who have not acknowledged are listed as such");
    assert.equal((await api("/websites/notifications", { bearer: a.bearer })).status, 403);
  });

  test("retention deletes only expired records and is audited", async () => {
    await policy(true, 30);
    const e = await ready();
    await send(e.token, [iv("recent.example.com", 120, 60)]);
    const link = String((await db.execute({ sql: "SELECT link_id, attendance_session_id, policy_seq FROM website_intervals WHERE employee_id = ?", args: [e.id] })).rows[0]!.link_id);
    const meta = (await db.execute({ sql: "SELECT attendance_session_id AS s, policy_seq AS p FROM website_intervals WHERE employee_id = ?", args: [e.id] })).rows[0]!;
    const old = Date.now() - 40 * 86_400_000;
    await db.execute({ sql: "INSERT INTO website_intervals (id, employee_id, link_id, attendance_session_id, policy_seq, client_id, domain, started_at, ended_at, duration_ms, received_at) VALUES (?, ?, ?, ?, ?, ?, 'old.example.com', ?, ?, 60000, ?)", args: [randomUUID(), e.id, link, meta.s, meta.p, randomUUID(), iso(old), iso(old + 60_000), iso(old + 60_000)] });
    assert.equal((await api("/websites/retention/run", { method: "POST", cookie: admin })).status, 400, "explicit confirmation");
    assert.equal((await stored(e.id)).length, 2, "nothing deleted without confirmation");
    const r = await api("/websites/retention/run", { method: "POST", cookie: admin, body: { confirm: true } });
    assert.equal(r.status, 200);
    assert.ok(r.body.deleted >= 1);
    assert.deepEqual((await stored(e.id)).map((x) => x.domain), ["recent.example.com"]);
    const run = (await api("/websites/audit", { cookie: admin })).body.find((x: { action: string }) => x.action === "RETENTION_RUN");
    assert.equal(run.details.retentionDays, 30);
  });

  test("scheduled retention deletes nothing until the operator approved it (WEBSITE_RETENTION_APPROVED)", async () => {
    await policy(true, 30);
    const e = await ready();
    await send(e.token, [iv("kept.example.com", 120, 60)]);
    const meta = (await db.execute({ sql: "SELECT link_id AS l, attendance_session_id AS s, policy_seq AS p FROM website_intervals WHERE employee_id = ?", args: [e.id] })).rows[0]!;
    const old = Date.now() - 40 * 86_400_000;
    await db.execute({ sql: "INSERT INTO website_intervals (id, employee_id, link_id, attendance_session_id, policy_seq, client_id, domain, started_at, ended_at, duration_ms, received_at) VALUES (?, ?, ?, ?, ?, ?, 'expired.example.com', ?, ?, 60000, ?)", args: [randomUUID(), e.id, meta.l, meta.s, meta.p, randomUUID(), iso(old), iso(old + 60_000), iso(old + 60_000)] });
    const service = (env: Record<string, unknown>) => new WebsitesService(db, app.get(EmployeesService), { get: (k: string) => env[k] }, app.get(MonitoringSettingsService));
    const domains = async () => (await stored(e.id)).map((x) => x.domain).sort();

    assert.equal(await app.get(WebsitesService).scheduledRetention(), false, "default: not approved");
    assert.equal(await service({ NODE_ENV: "production", WEBSITE_RETENTION_APPROVED: true, WEBSITE_TRACKING_APPROVED: false }).scheduledRetention(), false, "production also needs tracking approval");
    assert.deepEqual(await domains(), ["expired.example.com", "kept.example.com"], "nothing deleted while unapproved");

    assert.equal(await service({ NODE_ENV: "production", WEBSITE_RETENTION_APPROVED: true, WEBSITE_TRACKING_APPROVED: true }).scheduledRetention(), true);
    assert.deepEqual(await domains(), ["kept.example.com"], "approved: only expired intervals are purged");
    const run = (await api("/websites/audit", { cookie: admin })).body.find((x: { action: string; by: string | null }) => x.action === "RETENTION_RUN" && x.by === null);
    assert.ok(run, "the scheduled run is audited with no actor");
  });

  test("production gate: with NODE_ENV=production and no operator approval, nothing is collected even with the policy on", async () => {
    await policy(true);
    const e = await ready();
    const prod = new WebsitesService(db, app.get(EmployeesService), { get: (k: string) => ({ NODE_ENV: "production", WEBSITE_TRACKING_APPROVED: false })[k as "NODE_ENV"] }, app.get(MonitoringSettingsService));
    assert.equal((await prod.policy()).productionApproved, false);
    const link = { id: String((await db.execute({ sql: "SELECT id FROM website_extension_links WHERE employee_id = ? AND revoked_at IS NULL", args: [e.id] })).rows[0]!.id), employeeId: e.id };
    assert.equal((await prod.extensionState(link)).collect, false);
    assert.match((await prod.submit(link, { sentAt: iso(Date.now()), intervals: [iv("prod.example.com", 120, 60)] })).results[0].reason, /not approved/);
    const approved = new WebsitesService(db, app.get(EmployeesService), { get: (k: string) => ({ NODE_ENV: "production", WEBSITE_TRACKING_APPROVED: true })[k as "NODE_ENV"] }, app.get(MonitoringSettingsService));
    assert.equal((await approved.extensionState(link)).collect, true, "only the operator's approval flag lifts it");
  });

  test("rate limits: uploads per connected browser, pairing attempts per address", async () => {
    await policy(true);
    const e = await ready();
    let limited = 0;
    for (let i = 0; i < 125; i++) if ((await send(e.token, [iv("bad domain", 10, 5)])).status === 429) limited++;
    assert.ok(limited >= 1, "upload limit reached");
    let pairLimited = false;
    for (let i = 0; i < 25 && !pairLimited; i++) pairLimited = (await api("/websites/extension/pair", { method: "POST", body: { code: "ZZZZZZZZ", label: "x" } })).status === 429;
    assert.ok(pairLimited, "pairing attempts limited");
  });
});
