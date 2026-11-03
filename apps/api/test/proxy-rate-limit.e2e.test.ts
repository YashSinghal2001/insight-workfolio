// TRUST_PROXY (req.ip from X-Forwarded-For only when the hop is trusted), the global per-IP API limit
// and the refresh-token limits (in-process API, in-memory DB, example.com accounts, documentation IPs).
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL = ":memory:";
process.env.JWT_SECRET = "test-secret-test-secret-test-secret!";
process.env.TRUST_PROXY = "1"; // as behind Render's proxy
process.env.API_RATE_LIMIT_PER_MINUTE = "5"; // 5/min per session, 50/min per IP; off outside production unless set

const { AppModule } = await import("../dist/app.module.js");
const { configureApp } = await import("../dist/app.setup.js");
const { DATABASE } = await import("../dist/database/database.module.js");
const { hashPassword, RateLimiter } = await import("../dist/auth/crypto.js");
const { AuthService } = await import("../dist/auth/auth.service.js");
const { validateEnv } = await import("../dist/config/env.js");

const PASSWORD = "proxy password 1";
let app: INestApplication;
let base: string;
let auth: InstanceType<typeof AuthService>;
let seen: string[] = [];

let ipSeq = 0;
/** A fresh documentation-range client address, so the per-IP ceiling (50/min) never trips by accident. */
const ip = () => `198.51.100.${++ipSeq}`;

async function api(path: string, { method = "GET", body, xff = ip(), cookie, bearer }: { method?: string; body?: unknown; xff?: string | null; cookie?: string; bearer?: string } = {}) {
  const headers: Record<string, string> = { origin: "http://localhost:3000" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (xff) headers["x-forwarded-for"] = xff;
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, res };
}
/** The address the login limiter was keyed by, i.e. req.ip. */
async function reqIp(xff: string | null) {
  seen = [];
  await api("/auth/login", { method: "POST", body: { email: "nobody@example.com", password: "wrong password" }, xff });
  assert.equal(seen.length, 1);
  return seen[0]!;
}

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  auth = app.get(AuthService);
  auth.loginByIp.hit = (key: string) => (seen.push(key), true);
  auth.loginByEmail.hit = () => true;
  const db = app.get(DATABASE) as { execute: (q: { sql: string; args: unknown[] }) => Promise<unknown> };
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'proxy@example.com', 'EMPLOYEE', ?)", args: [randomUUID(), await hashPassword(PASSWORD)] });
});
after(() => app.close());

test("TRUST_PROXY=1: req.ip is the address the trusted proxy appended; client-supplied entries to its left are ignored", async () => {
  assert.equal(await reqIp("203.0.113.7"), "203.0.113.7");
  assert.equal(await reqIp("192.0.2.66, 203.0.113.8"), "203.0.113.8", "a spoofed leftmost entry is not the client");
  // Exactly one hop is trusted (the "loopback" default would also skip a loopback entry): proves TRUST_PROXY is applied.
  assert.equal(await reqIp("203.0.113.11, 127.0.0.1"), "127.0.0.1");
  assert.match(await reqIp(null), /127\.0\.0\.1|::1/);
});

test("an untrusted peer's X-Forwarded-For is ignored", async () => {
  const http = app.getHttpAdapter().getInstance();
  try {
    http.set("trust proxy", validateEnv({ TRUST_PROXY: "10.0.0.0/8" }).TRUST_PROXY); // the test client (loopback) is not trusted
    assert.match(await reqIp("203.0.113.9"), /127\.0\.0\.1|::1/);
    http.set("trust proxy", validateEnv({}).TRUST_PROXY); // the default: a local reverse proxy is trusted
    assert.equal(await reqIp("203.0.113.10"), "203.0.113.10");
    assert.equal(await reqIp("203.0.113.12, 127.0.0.1"), "203.0.113.12");
  } finally {
    http.set("trust proxy", 1);
  }
});

test("authenticated traffic is limited per session (not per IP), with 429 + Retry-After", async () => {
  const login = async () => (await api("/auth/login", { method: "POST", body: { email: "proxy@example.com", password: PASSWORD, client: "desktop" } })).body.accessToken as string;
  const token = await login();
  // Every request from a different IP: the bucket is the session.
  for (let i = 0; i < 5; i++) assert.equal((await api("/auth/me", { bearer: token })).status, 200);
  const blocked = await api("/auth/me", { bearer: token });
  assert.equal(blocked.status, 429);
  const retry = Number(blocked.res.headers.get("retry-after"));
  assert.ok(retry >= 1 && retry <= 60, `retry-after ${retry}`);
  assert.equal(blocked.body.statusCode, 429);
  // Same office IP, another session (another employee): unaffected.
  const office = "203.0.113.40";
  assert.equal((await api("/auth/me", { bearer: await login(), xff: office })).status, 200);
});

test("per-IP abuse ceiling (10x the session limit) on all requests; health and readiness are never limited", async () => {
  const client = "203.0.113.50";
  for (let i = 0; i < 50; i++) assert.equal((await api("/auth/me", { xff: client })).status, 401);
  const blocked = await api("/auth/me", { xff: client });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.res.headers.get("retry-after")) >= 1);
  assert.equal(blocked.body.error, "Too Many Requests");
  assert.equal((await api("/auth/me", { xff: "203.0.113.51" })).status, 401, "another client is unaffected");
  assert.equal((await api("/health", { xff: client })).status, 200);
  assert.notEqual((await api("/ready", { xff: client })).status, 429);
});

test("refresh is limited per session and per IP; a limited web refresh keeps its cookies", async () => {
  const [bySession, byIp] = [auth.refreshBySession, auth.refreshByIp];
  const login = async () => (await api("/auth/login", { method: "POST", body: { email: "proxy@example.com", password: PASSWORD, client: "desktop" } })).body.refreshToken as string;
  const refresh = (refreshToken: string, xff = ip()) => api("/auth/refresh", { method: "POST", body: { refreshToken }, xff });
  try {
    Object.assign(auth, { refreshBySession: new RateLimiter(1, 60_000) });
    const first = await refresh(await login());
    assert.equal(first.status, 200);
    assert.equal((await refresh(first.body.refreshToken)).status, 429, "same session, new IP: session limit");
    assert.equal((await refresh(await login())).status, 200, "another session is unaffected");

    Object.assign(auth, { refreshBySession: bySession, refreshByIp: new RateLimiter(1, 60_000) });
    const office = "203.0.113.60";
    assert.equal((await refresh(await login(), office)).status, 200);
    assert.equal((await refresh(await login(), office)).status, 429, "same IP, other session: IP limit");
    assert.equal((await refresh(await login())).status, 200, "another IP is unaffected");

    // Web: refresh token in the cookie. A 429 must not clear it (the session is still valid).
    const web = await api("/auth/refresh", { method: "POST", body: {}, xff: office, cookie: `wf_refresh=${await login()}` });
    assert.equal(web.status, 429);
    assert.deepEqual(web.res.headers.getSetCookie(), []);
  } finally {
    Object.assign(auth, { refreshBySession: bySession, refreshByIp: byIp });
  }
});
