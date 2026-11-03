// Own sign-in sessions (in-process API, in-memory DB): list, revoke one, revoke others, sign out
// everywhere. Ownership from the authenticated context; every revocation audited atomically.
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
const { hashPassword, sha256 } = await import("../dist/auth/crypto.js");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "session password 1";
let app: INestApplication;
let base: string;
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };

type Opts = { method?: string; body?: unknown; cookie?: string; bearer?: string; origin?: string | null };
async function api(path: string, { method = "GET", body, cookie, bearer, origin = ORIGIN }: Opts = {}) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (origin) headers.origin = origin;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text, res };
}
const cookiesOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const cleared = (res: Response) => {
  const set = res.headers.getSetCookie();
  return set.length === 2 && set.every((c) => /Expires=Thu, 01 Jan 1970/.test(c));
};

let n = 0;
async function user(role: "ADMIN" | "EMPLOYEE") {
  const id = randomUUID();
  const email = `s${++n}@example.com`;
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, ?, ?, ?)", args: [id, email, role, await hashPassword(PASSWORD)] });
  if (role === "EMPLOYEE") {
    await db.execute({ sql: "INSERT INTO employee_profiles (id, user_id, employee_code, full_name, timezone) VALUES (?, ?, ?, ?, 'UTC')", args: [randomUUID(), id, `SS-${n}`, `Session ${n}`] });
  }
  return { id, email };
}
async function web(email: string) {
  const r = await api("/auth/login", { method: "POST", body: { email, password: PASSWORD } });
  assert.equal(r.status, 200, r.text);
  const cookie = cookiesOf(r.res);
  const list = await api("/auth/sessions", { cookie });
  const id = (list.body as { id: string; current: boolean }[]).find((s) => s.current)!.id;
  return { cookie, id };
}
async function desktop(email: string) {
  const r = await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" }, origin: "tauri://localhost" });
  assert.equal(r.status, 200, r.text);
  const t = r.body as { accessToken: string; refreshToken: string };
  return { ...t, id: t.refreshToken.split(".")[0]! };
}
const refresh = (refreshToken: string) => api("/auth/refresh", { method: "POST", body: { refreshToken } });
const audits = async (action: string, target: string) =>
  (await db.execute({ sql: "SELECT * FROM account_audit WHERE action = ? AND target_user_id = ? ORDER BY created_at", args: [action, target] })).rows;

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
});
after(() => app.close());

describe("own sessions", () => {
  test("list: only the caller's live sessions, newest first, client recorded, current flagged, no secrets", async () => {
    const [emp, admin] = [await user("EMPLOYEE"), await user("ADMIN")];
    const w = await web(emp.email);
    const d1 = await desktop(emp.email);
    const d2 = await desktop(emp.email);
    const other = await web(admin.email);
    assert.equal((await api("/auth/sessions", { origin: null })).status, 401);

    const r = await api("/auth/sessions", { cookie: w.cookie });
    assert.equal(r.status, 200, r.text);
    const list = r.body as { id: string; client: string; createdAt: string; current: boolean }[];
    assert.deepEqual(list.map((s) => s.id), [d2.id, d1.id, w.id], "newest first, nobody else's");
    assert.deepEqual(list.map((s) => s.client), ["DESKTOP", "DESKTOP", "WEB"]);
    assert.deepEqual(list.map((s) => s.current), [false, false, true]);
    for (const s of list) assert.deepEqual(Object.keys(s).sort(), ["client", "createdAt", "current", "expiresAt", "id", "refreshedAt"]);
    for (const secret of [d1.refreshToken, d1.accessToken, sha256(d1.refreshToken), "hash", "token"]) assert.ok(!r.text.includes(secret));

    // Desktop bearer sees the same sessions with its own one flagged; refreshedAt follows rotation.
    assert.equal((await refresh(d1.refreshToken)).status, 200);
    const fromDesktop = (await api("/auth/sessions", { bearer: d2.accessToken, origin: null })).body as { id: string; current: boolean; refreshedAt: string | null }[];
    assert.deepEqual(fromDesktop.filter((s) => s.current).map((s) => s.id), [d2.id]);
    assert.ok(fromDesktop.find((s) => s.id === d1.id)!.refreshedAt, "refreshed_at set on rotation");
    assert.equal(fromDesktop.find((s) => s.id === d2.id)!.refreshedAt, null);

    // An admin (no employee profile) uses the same endpoint and sees only their own.
    const mine = (await api("/auth/sessions", { cookie: other.cookie })).body as { id: string }[];
    assert.deepEqual(mine.map((s) => s.id), [other.id]);
  });

  test("revoke one: own session dies (access and refresh); someone else's or unknown is 404 and untouched", async () => {
    const [emp, admin] = [await user("EMPLOYEE"), await user("ADMIN")];
    const w = await web(emp.email);
    const d1 = await desktop(emp.email);
    const d2 = await desktop(emp.email);
    const a = await web(admin.email);

    const r = await api(`/auth/sessions/${d1.id}`, { method: "DELETE", cookie: w.cookie });
    assert.equal(r.status, 204, r.text);
    assert.equal(r.res.headers.getSetCookie().length, 0, "not the current session: cookies untouched");
    assert.equal((await api("/auth/me", { bearer: d1.accessToken, origin: null })).status, 401);
    assert.equal((await refresh(d1.refreshToken)).status, 401);
    assert.equal((await api(`/auth/sessions/${d1.id}`, { method: "DELETE", cookie: w.cookie })).status, 404, "already revoked");

    assert.equal((await api(`/auth/sessions/${d2.id}`, { method: "DELETE", cookie: a.cookie })).status, 404, "another user's session");
    assert.equal((await api(`/auth/sessions/${randomUUID()}`, { method: "DELETE", cookie: a.cookie })).status, 404);
    assert.equal((await api("/auth/sessions/not-a-uuid", { method: "DELETE", cookie: a.cookie })).status, 400);
    assert.equal((await api("/auth/me", { bearer: d2.accessToken, origin: null })).status, 200, "still valid");

    const rows = await audits("SESSION_REVOKED", emp.id);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0]!.actor_user_id, rows[0]!.resource_type, rows[0]!.resource_id, rows[0]!.metadata], [emp.id, "SESSION", d1.id, "{}"]);
    assert.equal((await audits("SESSION_REVOKED", admin.id)).length, 0);

    // Desktop revoking its own current session over bearer signs itself out.
    assert.equal((await api(`/auth/sessions/${d2.id}`, { method: "DELETE", bearer: d2.accessToken, origin: null })).status, 204);
    assert.equal((await api("/auth/me", { bearer: d2.accessToken, origin: null })).status, 401);
  });

  test("revoking the current web session clears the cookies", async () => {
    const emp = await user("EMPLOYEE");
    const w = await web(emp.email);
    const r = await api(`/auth/sessions/${w.id}`, { method: "DELETE", cookie: w.cookie });
    assert.equal(r.status, 204);
    assert.ok(cleared(r.res), "cookies cleared");
    assert.equal((await api("/auth/me", { cookie: w.cookie })).status, 401);
  });

  test("concurrent revocation of the same session: exactly one 204, one audit row", async () => {
    const emp = await user("EMPLOYEE");
    const w = await web(emp.email);
    const d = await desktop(emp.email);
    const all = await Promise.all(Array.from({ length: 5 }, () => api(`/auth/sessions/${d.id}`, { method: "DELETE", cookie: w.cookie })));
    assert.deepEqual(all.map((r) => r.status).sort(), [204, 404, 404, 404, 404]);
    assert.equal((await audits("SESSION_REVOKED", emp.id)).length, 1);
  });

  test("revoke others: every other live session dies, the current one stays; audited with the count", async () => {
    const [emp, admin] = [await user("EMPLOYEE"), await user("ADMIN")];
    const w = await web(emp.email);
    const [d1, d2] = [await desktop(emp.email), await desktop(emp.email)];
    const a = await desktop(admin.email);

    const r = await api("/auth/sessions/revoke-others", { method: "POST", cookie: w.cookie });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body, { revoked: 2 });
    assert.equal(r.res.headers.getSetCookie().length, 0);
    assert.equal((await api("/auth/me", { cookie: w.cookie })).status, 200);
    for (const d of [d1, d2]) {
      assert.equal((await api("/auth/me", { bearer: d.accessToken, origin: null })).status, 401);
      assert.equal((await refresh(d.refreshToken)).status, 401);
    }
    assert.equal((await api("/auth/me", { bearer: a.accessToken, origin: null })).status, 200, "other users unaffected");

    assert.deepEqual((await api("/auth/sessions/revoke-others", { method: "POST", cookie: w.cookie })).body, { revoked: 0 });
    const rows = await audits("SESSIONS_REVOKED_OTHERS", emp.id);
    assert.equal(rows.length, 1, "nothing revoked: no audit row");
    assert.deepEqual([rows[0]!.actor_user_id, rows[0]!.resource_type, JSON.parse(String(rows[0]!.metadata))], [emp.id, "SESSION", { count: 2 }]);

    // Admins can use it too (desktop bearer, no origin needed).
    const ad2 = await desktop(admin.email);
    assert.deepEqual((await api("/auth/sessions/revoke-others", { method: "POST", bearer: ad2.accessToken, origin: null })).body, { revoked: 1 });
    assert.equal((await api("/auth/me", { bearer: a.accessToken, origin: null })).status, 401);
  });

  test("sign out everywhere: all sessions including the current one; cookies cleared; audited", async () => {
    const emp = await user("EMPLOYEE");
    const w = await web(emp.email);
    const d = await desktop(emp.email);
    const r = await api("/auth/sessions/revoke-all", { method: "POST", cookie: w.cookie });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body, { revoked: 2 });
    assert.ok(cleared(r.res));
    assert.equal((await api("/auth/me", { cookie: w.cookie })).status, 401);
    assert.equal((await api("/auth/me", { bearer: d.accessToken, origin: null })).status, 401);
    assert.equal((await refresh(d.refreshToken)).status, 401);
    const rows = await audits("SESSIONS_REVOKED_ALL", emp.id);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0]!.actor_user_id, JSON.parse(String(rows[0]!.metadata))], [emp.id, { count: 2 }]);
  });

  test("refresh: reuse revokes and is audited once; a revoked session's tokens stay rejected", async () => {
    const emp = await user("EMPLOYEE");
    const d = await desktop(emp.email);
    const rotated = await refresh(d.refreshToken);
    assert.equal(rotated.status, 200);
    assert.equal((await refresh(d.refreshToken)).status, 401, "reuse of the superseded token");
    assert.equal((await refresh(rotated.body.refreshToken)).status, 401, "session revoked by reuse");
    assert.equal((await refresh(d.refreshToken)).status, 401, "still rejected after revocation");
    const rows = await audits("SESSION_REUSE_DETECTED", emp.id);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0]!.actor_user_id, rows[0]!.resource_type, rows[0]!.resource_id, rows[0]!.metadata], [null, "SESSION", d.id, "{}"]);

    // Revoked through the endpoint: neither the current nor a superseded refresh token works, and no reuse row.
    const w = await web(emp.email);
    const d2 = await desktop(emp.email);
    const r2 = await refresh(d2.refreshToken);
    assert.equal((await api(`/auth/sessions/${d2.id}`, { method: "DELETE", cookie: w.cookie })).status, 204);
    assert.equal((await refresh(r2.body.refreshToken)).status, 401);
    assert.equal((await refresh(d2.refreshToken)).status, 401);
    assert.equal((await audits("SESSION_REUSE_DETECTED", emp.id)).length, 1);
  });

  test("CSRF: cookie-authenticated revocations need an allowed origin", async () => {
    const emp = await user("EMPLOYEE");
    const w = await web(emp.email);
    const d = await desktop(emp.email);
    for (const origin of [null, "https://evil.example"]) {
      assert.equal((await api(`/auth/sessions/${d.id}`, { method: "DELETE", cookie: w.cookie, origin })).status, 403);
      assert.equal((await api("/auth/sessions/revoke-others", { method: "POST", cookie: w.cookie, origin })).status, 403);
      assert.equal((await api("/auth/sessions/revoke-all", { method: "POST", cookie: w.cookie, origin })).status, 403);
    }
    assert.equal((await api("/auth/me", { bearer: d.accessToken, origin: null })).status, 200);
    assert.equal((await api("/auth/me", { cookie: w.cookie })).status, 200);
  });

  test("password setup is audited with the number of sessions it signed out", async () => {
    const emp = await user("EMPLOYEE");
    const d = await desktop(emp.email);
    const token = `setup-${randomUUID()}`;
    const linkId = randomUUID();
    await db.execute({ sql: "INSERT INTO account_setup_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)", args: [linkId, emp.id, sha256(token), new Date(Date.now() + 3_600_000).toISOString()] });
    const r = await api("/auth/setup-password", { method: "POST", body: { token, password: "a brand new password 1" } });
    assert.equal(r.status, 204, r.text);
    assert.equal((await api("/auth/me", { bearer: d.accessToken, origin: null })).status, 401);
    assert.equal((await api("/auth/setup-password", { method: "POST", body: { token, password: "a brand new password 2" } })).status, 400, "single use");
    const rows = await audits("PASSWORD_SET", emp.id);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0]!.actor_user_id, rows[0]!.resource_type, rows[0]!.resource_id, JSON.parse(String(rows[0]!.metadata))], [emp.id, "SETUP_LINK", linkId, { sessionsRevoked: 1 }]);
  });

  test("no audit row carries a secret", async () => {
    const rows = (await db.execute("SELECT metadata FROM account_audit")).rows;
    assert.ok(rows.length > 0);
    for (const r of rows) for (const k of Object.keys(JSON.parse(String(r.metadata)))) assert.ok(["count", "sessionsRevoked"].includes(k), k);
  });
});
