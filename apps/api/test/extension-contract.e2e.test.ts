// Contract between the browser extension (apps/browser-extension) and the API: the extension's own
// Tracker produces the intervals, sent the way background.js sends them, through pair → state →
// intervals → disconnect against an in-process API (in-memory DB, synthetic data).
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
// @ts-expect-error plain JS module without type declarations
import { apiBaseOf, BATCH_MAX, hostOf, Tracker } from "../../browser-extension/tracker.js";

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL = ":memory:";
process.env.JWT_SECRET = "test-secret-test-secret-test-secret!";

const { AppModule } = await import("../dist/app.module.js");
const { configureApp } = await import("../dist/app.setup.js");
const { DATABASE } = await import("../dist/database/database.module.js");
const { hashPassword } = await import("../dist/auth/crypto.js");
const { DEFAULT_WEBSITE_NOTICE_VERSION, WEBSITE_BATCH_MAX } = await import("@workfolio/shared");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "extension password 1";
const M = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
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

/** Exactly what background.js / popup.js do: `${apiBase}/api/v1/websites/extension/${path}` with the bearer token. */
async function extension(apiBase: string, path: string, token: string | null, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${apiBase}/api/v1/websites/extension/${path}`, { method: body === undefined && path === "state" ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text };
}

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [randomUUID(), await hashPassword(PASSWORD)] });
  const login = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email: "admin@example.com", password: PASSWORD }) });
  admin = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
});
after(() => app.close());

test("extension contract: pair → state → a full batch from the real Tracker → disconnect", async () => {
  assert.equal(BATCH_MAX, WEBSITE_BATCH_MAX, "the extension's batch size is the server's maximum");

  // Ready to record: policy on (backdated), an employee clocked in an hour ago who acknowledged the notice.
  await db.execute({ sql: "INSERT INTO website_policies (enabled, retention_days, notice_version, reason, changed_by, effective_at) SELECT 1, 30, ?, 'test: on', id, ? FROM users WHERE email = 'admin@example.com'", args: [DEFAULT_WEBSITE_NOTICE_VERSION, iso(Date.now() - 2 * 3_600_000)] });
  const created = await api("/employees", { method: "POST", cookie: admin, body: { email: "ext@example.com", employeeCode: "EXT-1", fullName: "Ext One", timezone: "UTC" } });
  assert.equal(created.status, 201, created.text);
  await api("/auth/setup-password", { method: "POST", body: { token: created.body.setup.token, password: PASSWORD } });
  const bearer = (await api("/auth/login", { method: "POST", body: { email: "ext@example.com", password: PASSWORD, client: "desktop" } })).body.accessToken as string;
  const device = randomUUID();
  await api("/devices/register", { method: "POST", bearer, body: { installationId: device, deviceName: "Mac", platform: "macos" } });
  await api("/attendance/sync", { method: "POST", bearer, headers: { "x-device-id": device }, body: { sentAt: iso(Date.now()), events: [{ id: randomUUID(), type: "CLOCK_IN", occurredAt: iso(Date.now() - 60 * M) }] } });
  await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), created.body.employee.id, DEFAULT_WEBSITE_NOTICE_VERSION, iso(Date.now() - 59 * M)] });

  // Popup: the server address passes the extension's URL rule, then pair with the one-time code.
  const apiBase = apiBaseOf(`${base}/`) as string;
  const code = (await api("/websites/links", { method: "POST", bearer })).body.code as string;
  const paired = await extension(apiBase, "pair", null, { code, label: "Chrome" });
  assert.equal(paired.status, 201, paired.text);
  assert.equal(typeof paired.body.token, "string");
  assert.deepEqual(paired.body.employee, { fullName: "Ext One", employeeCode: "EXT-1" });
  const token = paired.body.token as string;

  // Background: state decides whether to record and sets the tracker's limits.
  const state = await extension(apiBase, "state", token);
  assert.equal(state.status, 200, state.text);
  assert.equal(state.body.collect, true, JSON.stringify(state.body.reasons));
  assert.ok(Array.isArray(state.body.reasons));
  assert.equal(typeof state.body.intervalMaxSeconds, "number");
  assert.equal(typeof state.body.idleSeconds, "number");
  const tracker = new Tracker();
  tracker.maxMs = Math.min(300, state.body.intervalMaxSeconds) * 1000; // as background.js

  // A different site every 20 s for BATCH_MAX visits, starting 50 minutes ago; then nothing eligible.
  const t0 = Date.now() - 50 * M;
  const intervals: { id: string; domain: string; startedAt: string; endedAt: string }[] = [];
  for (let i = 0; i <= BATCH_MAX; i++) intervals.push(...tracker.observe(i < BATCH_MAX ? hostOf(`https://site${i}.example.com/private/path?q=secret#x`) : null, t0 + i * 20_000));
  assert.equal(intervals.length, BATCH_MAX);
  assert.ok(intervals.every((i) => !/[/?#]/.test(i.domain)), "domains only");

  const batch = intervals.slice(0, BATCH_MAX);
  const sent = await extension(apiBase, "intervals", token, { sentAt: iso(Date.now()), intervals: batch });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.results.length, BATCH_MAX);
  for (const [k, r] of (sent.body.results as { id: string; status: string; reason?: string }[]).entries()) {
    assert.equal(r.id, batch[k]!.id);
    assert.equal(r.status, "ACCEPTED", r.reason);
  }
  const retry = await extension(apiBase, "intervals", token, { sentAt: iso(Date.now()), intervals: batch });
  assert.ok(retry.body.results.every((r: { status: string }) => r.status === "DUPLICATE"), "a retry is final, not re-stored");

  // One more than the extension ever sends is refused (4xx: background.js keeps the queue and shows an error).
  const extra = { id: randomUUID(), domain: "late.example.com", startedAt: iso(Date.now() - 5 * M), endedAt: iso(Date.now() - 4 * M) };
  assert.equal((await extension(apiBase, "intervals", token, { sentAt: iso(Date.now()), intervals: [...batch, extra] })).status, 400);

  // Popup "Disconnect": the token stops working; background.js treats 401 as disconnected.
  const gone = await extension(apiBase, "disconnect", token, undefined);
  assert.ok(gone.status >= 200 && gone.status < 300, gone.text);
  assert.equal((await extension(apiBase, "state", token)).status, 401);
  assert.equal((await extension(apiBase, "intervals", token, { sentAt: iso(Date.now()), intervals: [extra] })).status, 401);
});
