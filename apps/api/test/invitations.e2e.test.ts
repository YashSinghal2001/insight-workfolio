// Employee invitation emails (in-process API, in-memory DB, MOCK provider: nothing is emailed; example.com
// test accounts only). Plus the Microsoft Graph transport against a fake fetch (no Microsoft contact).
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
process.env.INVITATION_MAIL_PROVIDER = "mock";
process.env.MAIL_SENDER = "IT@TFFDigital.com";
process.env.DASHBOARD_URL = "https://workfolio.example.com";

const { AppModule } = await import("../dist/app.module.js");
const { configureApp } = await import("../dist/app.setup.js");
const { DATABASE } = await import("../dist/database/database.module.js");
const { hashPassword, sha256 } = await import("../dist/auth/crypto.js");
const { AuthService } = await import("../dist/auth/auth.service.js");
const { INVITATION_TRANSPORT, INVITATION_RETRY, INVITATION_SUBJECT, GraphMailTransport, DelegatedGraphMailTransport } = await import("../dist/employees/invitations.js");
const { OneDriveService, writeOneDriveConnection, readOneDriveConnection } = await import("../dist/storage/onedrive.js");
const { StorageError } = await import("../dist/screenshots/storage.js");
type MailError = Error & { permanent: boolean };

const ORIGIN = "http://localhost:3000";
const PASSWORD = "invitation password 1";
let app: INestApplication;
let base: string;
type Rows = { rows: Record<string, unknown>[] };
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<Rows> };
type Sent = { to: string; subject: string; text: string; html?: string };
let mock: { outbox: Sent[]; failNext: (k: "transient" | "permanent", n?: number) => void };

async function api(path: string, { method = "GET", body, cookie }: { method?: string; body?: unknown; cookie?: string } = {}) {
  const h: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) h["content-type"] = "application/json";
  if (cookie) h.cookie = cookie;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text, res };
}
async function signIn(email: string, password = PASSWORD) {
  const r = await api("/auth/login", { method: "POST", body: { email, password } });
  assert.equal(r.status, 200, `${email}: ${r.text}`);
  return r.res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
let n = 0;
async function user(title: "SUPER_ADMIN" | "ADMIN" | "EMPLOYEE") {
  const id = randomUUID();
  const email = `inv${++n}@example.com`;
  await db.execute({ sql: "INSERT INTO users (id, email, role, admin_title, password_hash) VALUES (?, ?, ?, ?, ?)", args: [id, email, title === "EMPLOYEE" ? "EMPLOYEE" : "ADMIN", title === "EMPLOYEE" ? null : title, await hashPassword(PASSWORD)] });
  const employeeId = randomUUID();
  await db.execute({ sql: "INSERT INTO employee_profiles (id, user_id, employee_code, full_name, timezone) VALUES (?, ?, ?, ?, 'UTC')", args: [employeeId, id, `INV-${n}`, `Person ${n}`] });
  return { id, email, employeeId, cookie: await signIn(email) };
}
type Invitation = { id: string; status: string; recipient: string; provider: string; attempts: number; sentAt: string | null; lastError: string | null; expiresAt: string };
type Created = { employee: { id: string; userId: string; email: string; passwordSet: boolean; invitation: Invitation | null }; setup?: { token: string; expiresAt: string } };
const create = (who: { cookie: string }, over: Record<string, string> = {}) =>
  api("/employees", { method: "POST", cookie: who.cookie, body: { email: `new${++n}@example.com`, employeeCode: `NEW-${n}`, fullName: "New Person", timezone: "Asia/Kolkata", ...over } });
const resend = (who: { cookie: string }, employeeId: string) => api(`/employees/${employeeId}/invitation`, { method: "POST", cookie: who.cookie });
const tokenOf = (m: Sent) => /#token=([A-Za-z0-9_-]+)/.exec(m.text)![1]!;
const actions = async (userId: string) =>
  (await db.execute({ sql: "SELECT action FROM account_audit WHERE target_user_id = ? ORDER BY rowid", args: [userId] })).rows.map((r) => String(r.action));
const setPassword = (token: string) => api("/auth/setup-password", { method: "POST", body: { token, password: PASSWORD } });

let superAdmin: Awaited<ReturnType<typeof user>>;
let itAdmin: Awaited<ReturnType<typeof user>>;

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  mock = app.get(INVITATION_TRANSPORT);
  INVITATION_RETRY.delaysMs = [0, 0];
  const auth = app.get(AuthService);
  auth.loginByIp.hit = () => true;
  auth.setupByIp.hit = () => true;
  superAdmin = await user("SUPER_ADMIN");
  itAdmin = await user("ADMIN");
});
after(() => app?.close());

describe("invitation emails", () => {
  test("creating an employee emails one invitation from the IT mailbox: escaped name, https link, expiry, no password", async () => {
    const before = mock.outbox.length;
    const r = await create(itAdmin, { fullName: `Asha <b>"O'Neil"</b> & Co` });
    assert.equal(r.status, 201, r.text);
    const c = r.body as Created;
    assert.equal(c.setup, undefined, "the admin never sees the link once it was emailed");
    const inv = c.employee.invitation!;
    assert.deepEqual([inv.status, inv.recipient, inv.provider, inv.attempts, inv.lastError], ["SENT", c.employee.email, "mock", 1, null]);
    assert.ok(inv.sentAt);

    assert.equal(mock.outbox.length, before + 1);
    const m = mock.outbox.at(-1)!;
    assert.equal(m.to, c.employee.email);
    assert.equal(m.subject, INVITATION_SUBJECT);
    assert.equal(m.subject, "Welcome to Insight Workfolio — Activate Your Account");
    const token = tokenOf(m);
    assert.ok(m.text.includes(`https://workfolio.example.com/setup-password#token=${token}`), "https link, token in the fragment");
    assert.ok(m.html!.includes(`href="https://workfolio.example.com/setup-password#token=${token}"`));
    assert.ok(m.html!.includes("Asha &#60;b&#62;&#34;O&#39;Neil&#34;&#60;/b&#62; &#38; Co"), "name is HTML-escaped");
    assert.ok(!m.html!.includes("<b>"), "no admin-supplied markup in the email");
    assert.match(m.text, /expires on .+\(Asia\/Kolkata\)/, "expiry in the employee's time zone");
    for (const body of [m.text, m.html!]) assert.ok(body.includes("IT@TFFDigital.com"), "support contact");
    // No password exists to email: the account has none until the employee chooses one.
    const pw = await db.execute({ sql: "SELECT password_hash FROM users WHERE id = ?", args: [c.employee.userId] });
    assert.equal(pw.rows[0]!.password_hash, null);
    assert.doesNotMatch(m.text + m.html, /password (is|=)|(temporary|initial|default) password/i, "no password in the email");

    // Only the hash is stored; the raw token is in no table, audit row or invitation row.
    const stored = await db.execute({ sql: "SELECT token_hash FROM account_setup_tokens WHERE user_id = ? AND used_at IS NULL", args: [c.employee.userId] });
    assert.deepEqual(stored.rows.map((x) => x.token_hash), [sha256(token)]);
    for (const table of ["account_invitations", "account_audit"]) {
      const dump = JSON.stringify((await db.execute(`SELECT * FROM ${table}`)).rows);
      assert.ok(!dump.includes(token), `${table} never holds the token`);
    }
    assert.deepEqual(await actions(c.employee.userId), ["ACCOUNT_CREATED", "SETUP_LINK_ISSUED", "INVITATION_SENT"]);
    const audit = (await db.execute({ sql: "SELECT actor_user_id, metadata FROM account_audit WHERE target_user_id = ? AND action = 'INVITATION_SENT'", args: [c.employee.userId] })).rows[0]!;
    assert.equal(audit.actor_user_id, itAdmin.id);
    assert.deepEqual(JSON.parse(String(audit.metadata)), { invitationId: inv.id, provider: "mock", attempts: 1 });
  });

  test("the emailed link activates only that account, once; then the invitation reads ACCEPTED and resend is refused", async () => {
    const c = (await create(superAdmin)).body as Created;
    const token = tokenOf(mock.outbox.at(-1)!);
    assert.equal((await setPassword(token)).status, 204);
    assert.equal((await setPassword(token)).status, 400, "single use");
    const e = (await api(`/employees/${c.employee.id}`, { cookie: superAdmin.cookie })).body as Created["employee"];
    assert.equal(e.passwordSet, true);
    assert.equal(e.invitation!.status, "ACCEPTED");
    await signIn(c.employee.email); // the employee can now sign in
    const again = await resend(superAdmin, c.employee.id);
    assert.equal(again.status, 409, again.text);
    assert.match(again.body.message, /already activated/);
    assert.equal((await setPassword("x".repeat(43))).status, 400, "a made-up token activates nothing");
  });

  test("duplicate or invalid employees are refused before anything is sent", async () => {
    const first = (await create(itAdmin)).body as Created;
    const sent = mock.outbox.length;
    const dupEmail = await create(itAdmin, { email: first.employee.email.toUpperCase() });
    assert.equal(dupEmail.status, 409, dupEmail.text);
    const invalid = await create(itAdmin, { email: "not-an-email" });
    assert.equal(invalid.status, 400, invalid.text);
    assert.equal(mock.outbox.length, sent, "no email for a refused employee");
    const rows = await db.execute({ sql: "SELECT count(*) AS n FROM users WHERE lower(email) = lower(?)", args: [first.employee.email] });
    assert.equal(Number(rows.rows[0]!.n), 1, "no duplicate account");
  });

  test("transient provider failures are retried with the same link; giving up keeps the one account, records FAILED and returns the link", async () => {
    mock.failNext("transient", 2);
    const sent = mock.outbox.length;
    const ok = (await create(itAdmin)).body as Created;
    assert.deepEqual([ok.employee.invitation!.status, ok.employee.invitation!.attempts], ["SENT", 3]);
    assert.equal(mock.outbox.length, sent + 1, "one email despite three attempts");

    mock.failNext("transient", 3);
    const r = await create(itAdmin);
    assert.equal(r.status, 201, "the account is created even though the email failed");
    const failed = r.body as Created;
    assert.deepEqual([failed.employee.invitation!.status, failed.employee.invitation!.attempts], ["FAILED", 3]);
    assert.match(failed.employee.invitation!.lastError!, /temporarily unavailable/);
    assert.ok(failed.setup?.token, "no email went out: the admin gets the link to hand over");
    assert.deepEqual(await actions(failed.employee.userId), ["ACCOUNT_CREATED", "SETUP_LINK_ISSUED", "INVITATION_FAILED"]);

    mock.failNext("permanent");
    const perm = (await create(itAdmin)).body as Created;
    assert.deepEqual([perm.employee.invitation!.status, perm.employee.invitation!.attempts], ["FAILED", 1], "a refused recipient is not retried");
  });

  test("resend issues a fresh link (the old one stops working), once per minute, and concurrent resends send one email", async () => {
    mock.failNext("permanent");
    const c = (await create(itAdmin)).body as Created;
    const oldToken = c.setup!.token;
    const sent = mock.outbox.length;
    const r = await resend(itAdmin, c.employee.id);
    assert.equal(r.status, 201, r.text);
    assert.equal((r.body as Created).setup, undefined);
    assert.equal((r.body as Created).employee.invitation!.status, "SENT");
    assert.equal(mock.outbox.length, sent + 1);
    const again = await resend(itAdmin, c.employee.id);
    assert.equal(again.status, 409, "cooldown: no accidental duplicate");
    assert.equal(mock.outbox.length, sent + 1);
    assert.equal((await setPassword(oldToken)).status, 400, "the replaced link no longer works");

    mock.failNext("permanent");
    const d = (await create(itAdmin)).body as Created;
    const before = mock.outbox.length;
    const both = await Promise.all([resend(itAdmin, d.employee.id), resend(superAdmin, d.employee.id)]);
    assert.deepEqual(both.map((x) => x.status).sort(), [201, 409]);
    assert.equal(mock.outbox.length, before + 1, "exactly one email");
    assert.equal((await setPassword(tokenOf(mock.outbox.at(-1)!))).status, 204, "the link that went out works");
    assert.deepEqual((await actions(d.employee.userId)).filter((a) => a.startsWith("INVITATION")), ["INVITATION_FAILED", "INVITATION_SENT"]);
  });

  test("an expired link reads EXPIRED and activates nothing; a disabled account gets no invitation", async () => {
    const c = (await create(itAdmin)).body as Created;
    const token = tokenOf(mock.outbox.at(-1)!);
    await db.execute({ sql: "UPDATE account_setup_tokens SET expires_at = ? WHERE token_hash = ?", args: [new Date(Date.now() - 1000).toISOString(), sha256(token)] });
    const e = (await api(`/employees/${c.employee.id}`, { cookie: itAdmin.cookie })).body as Created["employee"];
    assert.equal(e.invitation!.status, "EXPIRED");
    assert.equal((await setPassword(token)).status, 400);

    await api(`/employees/${c.employee.id}/status`, { method: "PATCH", cookie: itAdmin.cookie, body: { status: "DISABLED" } });
    const r = await resend(itAdmin, c.employee.id);
    assert.equal(r.status, 409, r.text);
    assert.match(r.body.message, /disabled/);
  });

  test("RBAC: employees, signed-out callers and IT Admins on a Super Admin account are refused server-side", async () => {
    const emp = await user("EMPLOYEE");
    const target = (await create(itAdmin)).body as Created;
    const sent = mock.outbox.length;
    assert.equal((await create(emp)).status, 403);
    assert.equal((await resend(emp, target.employee.id)).status, 403);
    assert.equal((await resend(emp, emp.employeeId)).status, 403, "not even for themselves");
    assert.equal((await api(`/employees/${target.employee.id}/invitation`, { method: "POST" })).status, 401);
    // A Super Admin account that never activated: only a Super Admin may re-invite it.
    const saId = randomUUID();
    const saProfile = randomUUID();
    await db.execute({ sql: "INSERT INTO users (id, email, role, admin_title) VALUES (?, 'pending-sa@example.com', 'ADMIN', 'SUPER_ADMIN')", args: [saId] });
    await db.execute({ sql: "INSERT INTO employee_profiles (id, user_id, employee_code, full_name, timezone) VALUES (?, ?, 'SA-P', 'Pending SA', 'UTC')", args: [saProfile, saId] });
    assert.equal((await resend(itAdmin, saProfile)).status, 403);
    assert.equal(mock.outbox.length, sent, "nothing sent by a refused request");
    assert.equal((await resend(superAdmin, saProfile)).status, 201);
  });

  test("one admin can send at most 30 invitations per 15 minutes; the 31st creates no account", async () => {
    const busy = await user("ADMIN");
    for (let i = 0; i < 30; i++) assert.equal((await create(busy)).status, 201);
    const r = await create(busy, { email: "over-limit@example.com" });
    assert.equal(r.status, 429, r.text);
    const rows = await db.execute("SELECT count(*) AS n FROM users WHERE email = 'over-limit@example.com'");
    assert.equal(Number(rows.rows[0]!.n), 0);
    assert.equal((await create(itAdmin)).status, 201, "other admins are unaffected");
  });
});

describe("Microsoft Graph transport (fake fetch, nothing contacts Microsoft)", () => {
  const cfg = { tenantId: "tenant-1", clientId: "client-1", clientSecret: "s3cret-value", sender: "IT@TFFDigital.com" };
  const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
  const message = { to: "new@example.com", subject: "S", text: "T", html: "<p>H</p>" };
  type Call = { url: string; init: RequestInit };
  function fake(responses: (Response | Error)[]) {
    const calls: Call[] = [];
    const fn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const r = responses.shift()!;
      if (r instanceof Error) throw r;
      return r;
    }) as unknown as typeof fetch;
    return { calls, fn };
  }
  // Exchange RBAC for Applications: Entra holds no application permission, so the token carries no `roles`.
  const tokenOk = (roles?: string[]) => Response.json({ access_token: jwt(roles ? { roles } : {}), expires_in: 3600 });

  test("client-credentials token, then sendMail as the IT mailbox with HTML, one recipient, no Sent Items copy; token reused", async () => {
    const f = fake([tokenOk(), new Response(null, { status: 202, headers: { "request-id": "req-1" } }), new Response(null, { status: 202 })]);
    const t = new GraphMailTransport(cfg, f.fn);
    assert.deepEqual(await t.send(message), { messageId: "req-1" });
    await t.send(message);
    assert.equal(f.calls.length, 3, "one token request for two sends");
    assert.equal(f.calls[0]!.url, "https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token");
    const form = new URLSearchParams(String(f.calls[0]!.init.body));
    assert.deepEqual([form.get("grant_type"), form.get("scope"), form.get("client_id")], ["client_credentials", "https://graph.microsoft.com/.default", "client-1"]);
    assert.equal(f.calls[1]!.url, "https://graph.microsoft.com/v1.0/users/IT%40TFFDigital.com/sendMail");
    const sent = JSON.parse(String(f.calls[1]!.init.body));
    assert.deepEqual(sent, { message: { subject: "S", body: { contentType: "HTML", content: "<p>H</p>" }, toRecipients: [{ emailAddress: { address: "new@example.com" } }] }, saveToSentItems: false });
    assert.match(String((f.calls[1]!.init.headers as Record<string, string>).authorization), /^Bearer /);
  });

  test("refuses a token with any tenant-wide application permission, incl. an unscoped Entra Mail.Send (permanent, nothing sent)", async () => {
    for (const roles of [["Mail.Send"], ["Mail.Send", "Files.ReadWrite.All"], ["Mail.ReadWrite"]]) {
      const f = fake([tokenOk(roles)]);
      await assert.rejects(new GraphMailTransport(cfg, f.fn).send(message), (e: MailError) => e.permanent && /tenant-wide application permissions/.test(e.message));
      assert.equal(f.calls.length, 1, "sendMail never called");
    }
    const empty = fake([tokenOk([]), new Response(null, { status: 202 })]);
    await new GraphMailTransport(cfg, empty.fn).send(message);
    assert.equal(empty.calls.length, 2, "an empty roles claim is the scoped setup too");
  });

  test("classifies failures: 429/5xx/network transient, 4xx permanent, 401 drops the cached token; no secret in errors", async () => {
    const cases: [Response | Error, boolean][] = [
      [new Response(null, { status: 429 }), false],
      [new Response(null, { status: 503 }), false],
      [new TypeError("fetch failed"), false],
      [Response.json({ error: { code: "ErrorInvalidRecipients" } }, { status: 400 }), true],
      [Response.json({ error: { code: "ErrorAccessDenied" } }, { status: 403 }), true],
    ];
    for (const [res, permanent] of cases) {
      const f = fake([tokenOk(), res]);
      await assert.rejects(new GraphMailTransport(cfg, f.fn).send(message), (e: MailError) => {
        assert.equal(e.permanent, permanent, e.message);
        assert.ok(!e.message.includes(cfg.clientSecret));
        return true;
      });
    }
    const f = fake([tokenOk(), new Response(null, { status: 401 }), tokenOk(), new Response(null, { status: 202 })]);
    const t = new GraphMailTransport(cfg, f.fn);
    await assert.rejects(t.send(message), (e: MailError) => !e.permanent);
    await t.send(message);
    assert.equal(f.calls.filter((c) => c.url.includes("/token")).length, 2, "a fresh token after 401");
    const bad = fake([Response.json({ error: "invalid_client" }, { status: 401 })]);
    await assert.rejects(new GraphMailTransport(cfg, bad.fn).send(message), (e: MailError) => e.permanent && /invalid_client/.test(e.message));
  });
});

describe("Microsoft Graph DELEGATED transport (fake fetch and fake OneDrive connection, nothing contacts Microsoft)", () => {
  const message = { to: "new@example.com", subject: "S", text: "T", html: "<p>H</p>" };
  type Call = { url: string; init: RequestInit };
  function fake(responses: (Response | Error)[]) {
    const calls: Call[] = [];
    const fn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const r = responses.shift()!;
      if (r instanceof Error) throw r;
      return r;
    }) as unknown as typeof fetch;
    return { calls, fn };
  }
  /** Stands in for OneDriveService.token: records `fresh`, hands out the queued tokens (or throws the queued error). */
  function auth(...tokens: (string | Error)[]) {
    const asked: boolean[] = [];
    return {
      asked,
      token: async (fresh: boolean) => {
        asked.push(fresh);
        const t = tokens.shift()!;
        if (t instanceof Error) throw t;
        return t;
      },
    };
  }
  const bearer = (c: Call) => (c.init.headers as Record<string, string>).authorization;
  const noLeak = (e: MailError, ...tokens: string[]) => tokens.every((t) => !e.message.includes(t));

  test("POST /me/sendMail with the OneDrive connection's token: HTML, one recipient, no Sent Items copy, recorded as graph", async () => {
    const f = fake([new Response(null, { status: 202, headers: { "request-id": "req-9" } })]);
    const a = auth("at-cached");
    const t = new DelegatedGraphMailTransport(a, f.fn);
    assert.deepEqual([t.name, t.delivers], ["graph", true]);
    assert.deepEqual(await t.send(message), { messageId: "req-9" });
    assert.deepEqual(a.asked, [false], "the cached token, no forced refresh");
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.url, "https://graph.microsoft.com/v1.0/me/sendMail", "/me: only the signed-in account can be the sender");
    assert.equal(bearer(f.calls[0]!), "Bearer at-cached");
    assert.deepEqual(JSON.parse(String(f.calls[0]!.init.body)), { message: { subject: "S", body: { contentType: "HTML", content: "<p>H</p>" }, toRecipients: [{ emailAddress: { address: "new@example.com" } }] }, saveToSentItems: false });
  });

  test("401: one fresh token and one retry; a second 401 is a permanent failure, never a loop", async () => {
    const ok = fake([new Response(null, { status: 401 }), new Response(null, { status: 202 })]);
    const a = auth("at-stale", "at-fresh");
    await new DelegatedGraphMailTransport(a, ok.fn).send(message);
    assert.deepEqual(a.asked, [false, true]);
    assert.deepEqual(ok.calls.map(bearer), ["Bearer at-stale", "Bearer at-fresh"]);

    const twice = fake([new Response(null, { status: 401 }), Response.json({ error: { code: "InvalidAuthenticationToken", message: "at-fresh is bad" } }, { status: 401 }), new Response(null, { status: 202 })]);
    const b = auth("at-stale", "at-fresh", "at-third");
    await assert.rejects(new DelegatedGraphMailTransport(b, twice.fn).send(message), (e: MailError) => e.permanent && /HTTP 401, InvalidAuthenticationToken/.test(e.message) && /reconnect OneDrive/.test(e.message) && noLeak(e, "at-stale", "at-fresh"));
    assert.deepEqual([twice.calls.length, b.asked.length], [2, 2], "exactly two attempts");
  });

  test("failures: 403 says to grant Mail.Send and reconnect; 429/5xx/network transient; 4xx permanent; no token or response text in errors", async () => {
    const cases: [Response | Error, boolean, RegExp][] = [
      [Response.json({ error: { code: "ErrorAccessDenied", message: "secret detail at-1" } }, { status: 403 }), true, /HTTP 403, ErrorAccessDenied\); grant delegated Mail\.Send to the app, then reconnect OneDrive/],
      [new Response(null, { status: 429 }), false, /HTTP 429/],
      [new Response(null, { status: 503 }), false, /HTTP 503/],
      [new TypeError("fetch failed at-1"), false, /could not be reached/],
      [Response.json({ error: { code: "ErrorInvalidRecipients" } }, { status: 400 }), true, /HTTP 400, ErrorInvalidRecipients/],
      [Response.json({ error: { code: "not a code; <script>" } }, { status: 400 }), true, /HTTP 400\)$/],
    ];
    for (const [res, permanent, text] of cases) {
      const f = fake([res]);
      await assert.rejects(new DelegatedGraphMailTransport(auth("at-1"), f.fn).send(message), (e: MailError) => {
        assert.equal(e.permanent, permanent, e.message);
        assert.match(e.message, text);
        assert.ok(noLeak(e, "at-1", "secret detail"), e.message);
        return true;
      });
    }
  });

  test("no usable token: not connected / revoked is permanent, an unreachable Microsoft is transient, an empty token is never sent", async () => {
    const cases: [string | Error, boolean, RegExp][] = [
      [new StorageError("OneDrive is not connected yet; an administrator connects it in Settings › Storage"), true, /not connected yet/],
      [new StorageError("OneDrive authorization expired or was revoked; reconnect OneDrive"), true, /reconnect OneDrive/],
      [new StorageError("OneDrive token carries a scope beyond Files.ReadWrite and Mail.Send; refusing to use it"), true, /refusing to use it/],
      [new StorageError("Microsoft token request failed (timed out)"), false, /timed out/],
      [new StorageError("Microsoft token request failed (unreachable)"), false, /unreachable/],
      [new Error("boom with rt-secret"), true, /unexpected error/],
      ["", true, /No Microsoft token/],
    ];
    for (const [token, permanent, text] of cases) {
      const f = fake([]);
      await assert.rejects(new DelegatedGraphMailTransport(auth(token), f.fn).send(message), (e: MailError) => e.permanent === permanent && text.test(e.message) && noLeak(e, "rt-secret"));
      assert.equal(f.calls.length, 0, "sendMail never called without a token");
    }
  });

  test("with the real OneDriveService: sign-in and refresh request Mail.Send only for graph-delegated; the rotated refresh token is persisted; a wider token is refused", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "wf-delegated-mail-"));
    try {
      const key = Buffer.alloc(32, 9);
      const env = (provider: string): Record<string, string> => ({
        ONEDRIVE_TENANT_ID: "tenant-1",
        ONEDRIVE_CLIENT_ID: "client-1",
        ONEDRIVE_CLIENT_SECRET: "s3cret-value",
        ONEDRIVE_REDIRECT_URI: "https://api.example.com/api/v1/storage/onedrive/oauth/callback",
        ONEDRIVE_TOKEN_FILE: join(dir, "onedrive.json"),
        ONEDRIVE_TOKEN_KEY: key.toString("base64"),
        ONEDRIVE_ACCOUNT_EMAIL: "it@tffdigital.com",
        ONEDRIVE_ROOT_FOLDER: "InsightWorkfolio",
        INVITATION_MAIL_PROVIDER: provider,
      });
      const service = (provider: string) => new OneDriveService({ get: (k: string) => env(provider)[k] } as never);
      const scopeOf = (url: string) => new URL(url).searchParams.get("scope");
      assert.equal(scopeOf(service("none").begin("u").url), "offline_access openid profile Files.ReadWrite");
      assert.equal(scopeOf(service("graph-delegated").begin("u").url), "offline_access openid profile Files.ReadWrite Mail.Send");

      const connection = { tenantId: "tenant-1", clientId: "client-1", account: "it@tffdigital.com", userId: "oid-it", driveId: "drv", folderId: "fld", refreshToken: "rt-old", connectedAt: new Date().toISOString() };
      await writeOneDriveConnection(env("x").ONEDRIVE_TOKEN_FILE!, key, connection);
      const od = service("graph-delegated");
      const f = fake([
        Response.json({ access_token: "at-mail", expires_in: 3600, refresh_token: "rt-new", scope: "Files.ReadWrite Mail.Send openid profile" }),
        new Response(null, { status: 202 }),
        new Response(null, { status: 202 }),
      ]);
      od.fetchFn = f.fn;
      const t = new DelegatedGraphMailTransport(od, f.fn);
      await t.send(message);
      await t.send(message);
      assert.equal(f.calls.length, 3, "one refresh for two sends");
      const form = f.calls[0]!.init.body as URLSearchParams;
      assert.deepEqual([form.get("grant_type"), form.get("refresh_token"), form.get("scope")], ["refresh_token", "rt-old", "offline_access openid profile Files.ReadWrite Mail.Send"]);
      assert.deepEqual([f.calls[1]!.url, bearer(f.calls[1]!)], ["https://graph.microsoft.com/v1.0/me/sendMail", "Bearer at-mail"]);
      assert.equal((await readOneDriveConnection(env("x").ONEDRIVE_TOKEN_FILE!, key))!.refreshToken, "rt-new", "rotation written back to the shared encrypted file");

      // storage-only configuration: the refresh does not ask for Mail.Send, yet tolerates a token that reports it
      const plain = service("none");
      const g = fake([Response.json({ access_token: "at-2", expires_in: 3600, refresh_token: "rt-3", scope: "Files.ReadWrite Mail.Send openid" })]);
      plain.fetchFn = g.fn;
      assert.equal(await plain.token(false), "at-2");
      assert.equal((g.calls[0]!.init.body as URLSearchParams).get("scope"), "offline_access openid profile Files.ReadWrite");

      // a token wider than Files.ReadWrite + Mail.Send is not used and nothing is sent
      const wide = service("graph-delegated");
      const h = fake([Response.json({ access_token: "at-wide", expires_in: 3600, refresh_token: "rt-4", scope: "Files.ReadWrite Mail.Send Mail.ReadWrite" })]);
      wide.fetchFn = h.fn;
      await assert.rejects(new DelegatedGraphMailTransport(wide, h.fn).send(message), (e: MailError) => e.permanent && /scope beyond Files\.ReadWrite and Mail\.Send/.test(e.message) && noLeak(e, "at-wide", "rt-4"));
      assert.equal(h.calls.length, 1, "sendMail never called");

      // the connection of another account is never used to send
      await writeOneDriveConnection(env("x").ONEDRIVE_TOKEN_FILE!, key, { ...connection, account: "someone@tffdigital.com" });
      const other = service("graph-delegated");
      const i = fake([]);
      other.fetchFn = i.fn;
      await assert.rejects(new DelegatedGraphMailTransport(other, i.fn).send(message), (e: MailError) => e.permanent && /another app registration, tenant or account/.test(e.message));
      assert.equal(i.calls.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
