// Central email notifications (in-process API, in-memory DB, MOCK provider: nothing is emailed; example.com test
// accounts only). Routing by role, critical incidents to IT and Super Admin independently, retries, dedupe,
// recipient safety, templates, the event producers, the notify CLI and the admin endpoints.
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const { hashPassword } = await import("../dist/auth/crypto.js");
const { AuthService } = await import("../dist/auth/auth.service.js");
const { INVITATION_TRANSPORT } = await import("../dist/employees/invitations.js");
const { MailError } = await import("../dist/reports/mail.js");
const { StorageError } = await import("../dist/screenshots/storage.js");
const { NotificationsService, NOTIFICATION_RETRY, NOTIFICATION_MAX_ATTEMPTS, sanitize } = await import("../dist/notifications/notifications.service.js");
const { EmailService } = await import("../dist/notifications/email.service.js");
const { renderNotification } = await import("../dist/notifications/templates.js");
const { run: notifyCli } = await import("../dist/cli/notify.js");
const { NOTIFICATION_ROUTES, NOTIFICATION_TYPES } = await import("@workfolio/shared");
const { createDatabase } = await import("@workfolio/database");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "notification password 1";
let app: INestApplication;
let base: string;
type Rows = { rows: Record<string, unknown>[] };
let db: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<Rows> };
type Sent = { to: string; subject: string; text: string; html?: string };
let mock: { outbox: Sent[]; send: (m: Sent) => Promise<{ messageId: string }> };
let svc: InstanceType<typeof NotificationsService>;

async function api(path: string, { method = "GET", body, cookie }: { method?: string; body?: unknown; cookie?: string } = {}) {
  const h: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) h["content-type"] = "application/json";
  if (cookie) h.cookie = cookie;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text, res };
}
async function signIn(email: string) {
  const r = await api("/auth/login", { method: "POST", body: { email, password: PASSWORD } });
  assert.equal(r.status, 200, `${email}: ${r.text}`);
  return r.res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
let n = 0;
async function user(title: "SUPER_ADMIN" | "ADMIN" | "EMPLOYEE") {
  const id = randomUUID();
  const email = `note${++n}@example.com`;
  await db.execute({ sql: "INSERT INTO users (id, email, role, admin_title, password_hash) VALUES (?, ?, ?, ?, ?)", args: [id, email, title === "EMPLOYEE" ? "EMPLOYEE" : "ADMIN", title === "EMPLOYEE" ? null : title, await hashPassword(PASSWORD)] });
  await db.execute({ sql: "INSERT INTO employee_profiles (id, user_id, employee_code, full_name, timezone) VALUES (?, ?, ?, ?, 'UTC')", args: [randomUUID(), id, `NOTE-${n}`, `Person ${n}`] });
  return { id, email, cookie: await signIn(email) };
}
type Delivery = { role: string; email: string | null; status: string; attempts: number; error: string | null; sent: string | null };
const deliveries = async (eventId: string): Promise<Delivery[]> =>
  (
    await db.execute({
      sql: `SELECT d.recipient_role, u.email, d.status, d.attempts, d.last_error, d.sent_at FROM notification_deliveries d LEFT JOIN users u ON u.id = d.recipient_user_id
            WHERE d.event_id = ? ORDER BY d.recipient_role, u.email`,
      args: [eventId],
    })
  ).rows.map((r) => ({ role: String(r.recipient_role), email: r.email === null ? null : String(r.email), status: String(r.status), attempts: Number(r.attempts), error: r.last_error === null ? null : String(r.last_error), sent: r.sent_at === null ? null : String(r.sent_at) }));
const brief = (ds: Delivery[]) => ds.map((d) => `${d.role}:${d.email}:${d.status}`);
/** Everything sent since `from`, as "address subject" lines. */
const sentSince = (from: number) => mock.outbox.slice(from).map((m) => m.to).sort();
/** Makes the mock provider fail for chosen addresses until restored. */
function failFor(match: (to: string) => boolean, permanent: boolean) {
  const real = mock.send.bind(mock);
  mock.send = async (m) => {
    if (match(m.to)) throw new MailError(permanent ? "Mock provider rejected the recipient" : "Mock provider temporarily unavailable", permanent);
    return real(m);
  };
  return () => void (mock.send = real);
}

let superAdmin: Awaited<ReturnType<typeof user>>;
let superAdmin2: Awaited<ReturnType<typeof user>>;
let it1: Awaited<ReturnType<typeof user>>;
let it2: Awaited<ReturnType<typeof user>>;
let employee: Awaited<ReturnType<typeof user>>;
let other: Awaited<ReturnType<typeof user>>;
const isIt = (to: string) => [it1.email, it2.email].includes(to);
const isSuper = (to: string) => [superAdmin.email, superAdmin2.email].includes(to);

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
  db = app.get(DATABASE);
  mock = app.get(INVITATION_TRANSPORT);
  svc = app.get(NotificationsService);
  NOTIFICATION_RETRY.backoffMs = [0, 0, 0];
  const auth = app.get(AuthService);
  auth.loginByIp.hit = () => true;
  auth.setupByIp.hit = () => true;
  superAdmin = await user("SUPER_ADMIN");
  superAdmin2 = await user("SUPER_ADMIN");
  it1 = await user("ADMIN");
  it2 = await user("ADMIN");
  employee = await user("EMPLOYEE");
  other = await user("EMPLOYEE");
});
after(() => app?.close());

describe("routing matrix", () => {
  test("the matrix is the approved one, and every critical event goes to BOTH IT and Super Admin", () => {
    const roles = Object.fromEntries(NOTIFICATION_TYPES.map((t) => [t, [...NOTIFICATION_ROUTES[t].roles].join("+")]));
    assert.deepEqual(roles, {
      ACCOUNT_ACTIVATED: "EMPLOYEE",
      PASSWORD_CHANGED: "EMPLOYEE",
      SECURITY_ALERT: "EMPLOYEE+IT",
      DEVICE_ISSUE: "IT",
      SCREENSHOT_FAILURE: "IT",
      BACKUP_FAILURE: "IT+SUPER_ADMIN",
      CRITICAL_FAILURE: "IT+SUPER_ADMIN",
      SECURITY_INCIDENT: "EMPLOYEE+IT+SUPER_ADMIN",
      ONBOARDING_SUMMARY: "IT+SUPER_ADMIN",
      PERIODIC_REPORT: "IT+SUPER_ADMIN",
    });
    for (const t of NOTIFICATION_TYPES) {
      const r = NOTIFICATION_ROUTES[t];
      if (r.severity === "CRITICAL") assert.ok(r.roles.includes("IT") && r.roles.includes("SUPER_ADMIN"), `${t} must reach IT and Super Admin`);
    }
  });

  test("IT operational alert: every active Admin, no Super Admin, no employee", async () => {
    const from = mock.outbox.length;
    const id = (await svc.emit({ type: "DEVICE_ISSUE", description: "A computer could not be registered.", subjectUserId: employee.id }))!;
    assert.deepEqual(brief(await deliveries(id)), [`IT:${it1.email}:PENDING`, `IT:${it2.email}:PENDING`]);
    await svc.deliver();
    assert.deepEqual(brief(await deliveries(id)), [`IT:${it1.email}:SENT`, `IT:${it2.email}:SENT`]);
    assert.deepEqual(sentSince(from), [it1.email, it2.email].sort());
  });

  test("employee notification: only the affected employee, with no incident details", async () => {
    const from = mock.outbox.length;
    const id = (await svc.emit({ type: "PASSWORD_CHANGED", description: "internal detail for staff only", subjectUserId: employee.id }))!;
    await svc.deliver();
    assert.deepEqual(brief(await deliveries(id)), [`EMPLOYEE:${employee.email}:SENT`]);
    assert.deepEqual(sentSince(from), [employee.email]);
    const m = mock.outbox.at(-1)!;
    assert.equal(m.subject, "Your Insight Workfolio password was changed");
    for (const leak of ["internal detail", id, it1.email, superAdmin.email]) assert.ok(!m.text.includes(leak) && !m.html!.includes(leak), `employee mail must not contain ${leak}`);
    assert.match(m.text, /If this was not you, contact IT immediately/);
  });

  test("security alert: the affected employee and IT, not Super Admin; an event about nobody has no employee recipient", async () => {
    const id = (await svc.emit({ type: "SECURITY_ALERT", description: "A session was ended.", subjectUserId: other.id }))!;
    assert.deepEqual(brief(await deliveries(id)), [`EMPLOYEE:${other.email}:PENDING`, `IT:${it1.email}:PENDING`, `IT:${it2.email}:PENDING`]);
    const anonymous = (await svc.emit({ type: "SECURITY_INCIDENT", description: "Incident without an affected account." }))!;
    assert.deepEqual((await deliveries(anonymous)).map((d) => d.role).sort(), ["IT", "IT", "SUPER_ADMIN", "SUPER_ADMIN"]);
    await svc.deliver();
  });
});

describe("critical incidents", () => {
  test("delivered to every IT and every Super Admin account, with incident ID, severity, category, time and dashboard link", async () => {
    const from = mock.outbox.length;
    const id = (await svc.emit({ type: "CRITICAL_FAILURE", description: "The database disk is 98% full." }))!;
    await svc.deliver();
    assert.deepEqual(brief(await deliveries(id)), [`IT:${it1.email}:SENT`, `IT:${it2.email}:SENT`, `SUPER_ADMIN:${superAdmin.email}:SENT`, `SUPER_ADMIN:${superAdmin2.email}:SENT`]);
    assert.deepEqual(sentSince(from), [it1.email, it2.email, superAdmin.email, superAdmin2.email].sort());
    for (const m of mock.outbox.slice(from)) {
      assert.equal(m.subject, "[Critical] Critical system failure: Insight Workfolio");
      for (const part of [`Incident ID: ${id}`, "Severity: Critical", "Category: Critical system failure", "The database disk is 98% full.", `https://workfolio.example.com/notifications?event=${id}`]) assert.ok(m.text.includes(part), part);
      assert.match(m.text, /Time: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
      assert.ok(m.html!.includes(id) && m.html!.includes("Critical"));
    }
  });

  test("IT delivery fails: Super Admin is still told, the IT failure is recorded per recipient", async () => {
    const restore = failFor(isIt, true);
    try {
      const id = (await svc.emit({ type: "BACKUP_FAILURE", description: "Backup did not complete." }))!;
      await svc.deliver();
      const ds = await deliveries(id);
      assert.deepEqual(brief(ds), [`IT:${it1.email}:FAILED`, `IT:${it2.email}:FAILED`, `SUPER_ADMIN:${superAdmin.email}:SENT`, `SUPER_ADMIN:${superAdmin2.email}:SENT`]);
      assert.ok(ds.filter((d) => d.role === "IT").every((d) => d.error === "Mock provider rejected the recipient" && d.sent === null && d.attempts === 1));
    } finally {
      restore();
    }
  });

  test("Super Admin delivery fails: IT is still told, the Super Admin failure is recorded", async () => {
    const restore = failFor(isSuper, true);
    try {
      const id = (await svc.emit({ type: "CRITICAL_FAILURE", description: "API workers are crashing." }))!;
      await svc.deliver();
      assert.deepEqual(brief(await deliveries(id)), [`IT:${it1.email}:SENT`, `IT:${it2.email}:SENT`, `SUPER_ADMIN:${superAdmin.email}:FAILED`, `SUPER_ADMIN:${superAdmin2.email}:FAILED`]);
    } finally {
      restore();
    }
  });

  test("both fail: the incident stays in the database, is never marked sent, and the dashboard shows it; an admin can send again", async () => {
    const restore = failFor(() => true, true);
    let id: string;
    try {
      id = (await svc.emit({ type: "CRITICAL_FAILURE", description: "Mail and storage are both down." }))!;
      await svc.deliver();
    } finally {
      restore();
    }
    const ds = await deliveries(id);
    assert.ok(ds.length === 4 && ds.every((d) => d.status === "FAILED" && d.sent === null));
    const view = await api("/notifications?show=failed", { cookie: it1.cookie });
    assert.equal(view.status, 200, view.text);
    const shown = (view.body.events as { id: string; severity: string; description: string; deliveries: { id: string; status: string; lastError: string; recipient: string }[] }[]).find((e) => e.id === id)!;
    assert.deepEqual([shown.severity, shown.description, shown.deliveries.length], ["CRITICAL", "Mail and storage are both down.", 4]);
    assert.ok(shown.deliveries.every((d) => d.status === "FAILED" && d.lastError));
    assert.ok(view.body.counts.criticalUndelivered >= 1 && view.body.counts.failed >= 4);
    assert.deepEqual([view.body.email.provider, view.body.email.sender, view.body.email.delivers], ["mock", "IT@TFFDigital.com", false]);

    const one = shown.deliveries.find((d) => d.recipient === superAdmin.email)!;
    assert.equal((await api(`/notifications/deliveries/${one.id}/retry`, { method: "POST", cookie: superAdmin.cookie })).status, 204);
    assert.equal((await api(`/notifications/deliveries/${one.id}/retry`, { method: "POST", cookie: superAdmin.cookie })).status, 409, "not failed any more");
    await svc.deliver();
    assert.deepEqual(brief(await deliveries(id)).filter((x) => x.includes(":SENT")), [`SUPER_ADMIN:${superAdmin.email}:SENT`]);
  });

  test("a group with no active account is recorded as a failure, never skipped; the other group still gets it", async () => {
    await db.execute({ sql: "UPDATE users SET status = 'DISABLED' WHERE id IN (?, ?)", args: [it1.id, it2.id] });
    try {
      const id = (await svc.emit({ type: "CRITICAL_FAILURE", description: "No IT account exists." }))!;
      await svc.deliver();
      const ds = await deliveries(id);
      assert.deepEqual(brief(ds), ["IT:null:FAILED", `SUPER_ADMIN:${superAdmin.email}:SENT`, `SUPER_ADMIN:${superAdmin2.email}:SENT`]);
      assert.equal(ds[0]!.error, "No active IT (Admin) account to notify");
    } finally {
      await db.execute({ sql: "UPDATE users SET status = 'ACTIVE' WHERE id IN (?, ?)", args: [it1.id, it2.id] });
    }
  });
});

describe("reliability", () => {
  test("transient failures are retried with the attempt count recorded, then sent; a recipient never gets it twice", async () => {
    const from = mock.outbox.length;
    let failures = 2;
    const real = mock.send.bind(mock);
    mock.send = async (m) => {
      if (m.to === it1.email && failures-- > 0) throw new MailError("Mock provider temporarily unavailable", false);
      return real(m);
    };
    try {
      const id = (await svc.emit({ type: "DEVICE_ISSUE", description: "Retry me." }))!;
      await svc.deliver();
      assert.deepEqual(brief(await deliveries(id)), [`IT:${it1.email}:RETRYING`, `IT:${it2.email}:SENT`]);
      await svc.deliver();
      await svc.deliver();
      const ds = await deliveries(id);
      assert.deepEqual(brief(ds), [`IT:${it1.email}:SENT`, `IT:${it2.email}:SENT`]);
      assert.deepEqual([ds[0]!.attempts, ds[0]!.error, ds[1]!.attempts], [3, null, 1]);
      await svc.deliver();
      assert.deepEqual(sentSince(from), [it1.email, it2.email].sort(), "one email each, whatever the number of passes");
    } finally {
      mock.send = real;
    }
  });

  test("retries are bounded: after the last attempt the delivery is FAILED and is not tried again", async () => {
    const restore = failFor(isIt, false);
    try {
      const id = (await svc.emit({ type: "SCREENSHOT_FAILURE", description: "Storage is down." }))!;
      for (let i = 0; i < NOTIFICATION_MAX_ATTEMPTS + 3; i++) await svc.deliver();
      const ds = await deliveries(id);
      assert.ok(ds.every((d) => d.status === "FAILED" && d.attempts === NOTIFICATION_MAX_ATTEMPTS && d.error === "Mock provider temporarily unavailable"), JSON.stringify(ds));
    } finally {
      restore();
    }
  });

  test("backoff: a retry waits for its time", async () => {
    NOTIFICATION_RETRY.backoffMs = [60_000, 0, 0];
    const restore = failFor(isIt, false);
    let id: string;
    let now: number;
    try {
      id = (await svc.emit({ type: "DEVICE_ISSUE", description: "Wait for it." }))!;
      now = Date.now() + 1_000; // after the rows' own timestamps
      await svc.deliver(now);
    } finally {
      restore();
      NOTIFICATION_RETRY.backoffMs = [0, 0, 0];
    }
    await svc.deliver(now + 30_000);
    assert.ok((await deliveries(id)).every((d) => d.status === "RETRYING" && d.attempts === 1), "not due yet");
    await svc.deliver(now + 61_000);
    assert.ok((await deliveries(id)).every((d) => d.status === "SENT" && d.attempts === 2));
  });

  test("duplicate events (same dedupe key) are recorded and emailed once", async () => {
    const from = mock.outbox.length;
    const key = `storage:${randomUUID()}`;
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => svc.emit({ type: "SCREENSHOT_FAILURE", description: "Storage is down.", dedupeKey: key })));
    assert.equal([a, b, c].filter(Boolean).length, 1, "one event");
    await svc.deliver();
    await svc.deliver();
    assert.deepEqual(sentSince(from), [it1.email, it2.email].sort());
    assert.equal(Number((await db.execute({ sql: "SELECT count(*) AS n FROM notification_events WHERE dedupe_key = ?", args: [key] })).rows[0]!.n), 1);
  });

  test("an interrupted send (left PROCESSING) is picked up again after the stale period, not before", async () => {
    const id = (await svc.emit({ type: "DEVICE_ISSUE", description: "Interrupted." }))!;
    const now = Date.now();
    await db.execute({ sql: "UPDATE notification_deliveries SET status = 'PROCESSING', attempts = 1, updated_at = ? WHERE event_id = ?", args: [new Date(now).toISOString(), id] });
    await svc.deliver(now + 60_000);
    assert.ok((await deliveries(id)).every((d) => d.status === "PROCESSING"));
    await svc.deliver(now + 11 * 60_000);
    assert.ok((await deliveries(id)).every((d) => d.status === "SENT" && d.attempts === 2));
  });

  test("emit never throws into the caller, even when the event cannot be recorded", async () => {
    assert.equal(await svc.emit({ type: "DEVICE_ISSUE", description: "x", subjectUserId: "no-such-user" }), null);
  });
});

describe("recipient safety", () => {
  test("recipients are re-checked at send time: a disabled or re-titled account is not emailed", async () => {
    const from = mock.outbox.length;
    const id = (await svc.emit({ type: "CRITICAL_FAILURE", description: "Recipients change before sending." }))!;
    await db.execute({ sql: "UPDATE users SET status = 'DISABLED' WHERE id = ?", args: [it2.id] });
    await db.execute({ sql: "UPDATE users SET admin_title = 'ADMIN' WHERE id = ?", args: [superAdmin2.id] });
    try {
      await svc.deliver();
      const ds = await deliveries(id);
      assert.deepEqual(brief(ds), [`IT:${it1.email}:SENT`, `IT:${it2.email}:FAILED`, `SUPER_ADMIN:${superAdmin.email}:SENT`, `SUPER_ADMIN:${superAdmin2.email}:FAILED`]);
      assert.match(ds[1]!.error!, /no longer an active IT/);
      assert.match(ds[3]!.error!, /no longer an active Super Admin/);
      assert.deepEqual(sentSince(from), [it1.email, superAdmin.email].sort());
    } finally {
      await db.execute({ sql: "UPDATE users SET status = 'ACTIVE' WHERE id = ?", args: [it2.id] });
      await db.execute({ sql: "UPDATE users SET admin_title = 'SUPER_ADMIN' WHERE id = ?", args: [superAdmin2.id] });
    }
  });

  test("EmailService refuses anything but one valid address and a one-line subject (no header or recipient injection)", async () => {
    const email = app.get(EmailService);
    const from = mock.outbox.length;
    const ok = { to: "someone@example.com", subject: "S", text: "T" };
    for (const to of ["", "not-an-address", "a@example.com, b@example.com", "a@example.com;b@example.com", "a@example.com\r\nBcc: b@example.com", "Name <a@example.com>"]) {
      await assert.rejects(email.send({ ...ok, to }), (e: Error & { permanent: boolean }) => e.permanent && /recipient address is not valid/.test(e.message), to);
    }
    for (const subject of ["", "Hello\r\nBcc: b@example.com", "x".repeat(256)]) {
      await assert.rejects(email.send({ ...ok, subject }), (e: Error & { permanent: boolean }) => e.permanent && /subject is not valid/.test(e.message));
    }
    assert.equal(mock.outbox.length, from, "nothing was sent");
    await email.send(ok);
    assert.equal(mock.outbox.at(-1)!.to, "someone@example.com");
  });

  test("templates escape HTML, and descriptions are reduced to one safe line without token-like strings", () => {
    const secret = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdefghijklmnopqrstuvwxyz0123456789";
    const description = sanitize(`<script>alert("x")</script>\r\nBcc: evil@example.com token=${secret} ${"y".repeat(900)}`);
    assert.ok(description.length <= 500 && !description.includes(secret) && !/[\r\n]/.test(description) && description.includes("[redacted]"));
    assert.equal(sanitize(" \n "), "No details");
    const event = { id: randomUUID(), type: "SECURITY_INCIDENT" as const, severity: "CRITICAL" as const, description, createdAt: "2026-11-18T10:04:42.898Z" };
    const staff = renderNotification({ event, role: "IT", to: "it@example.com", dashboardUrl: "https://workfolio.example.com", sender: "IT@TFFDigital.com" });
    assert.ok(!staff.html!.includes("<script>") && staff.html!.includes("&#60;script&#62;"));
    assert.ok(!/[\r\n]/.test(staff.subject) && staff.text.includes("Time: 2026-11-18 10:04 UTC"));
    const emp = renderNotification({ event, role: "EMPLOYEE", to: "e@example.com", dashboardUrl: "https://workfolio.example.com", sender: "IT@TFFDigital.com" });
    assert.ok(!emp.text.includes("script") && !emp.text.includes(event.id) && !emp.text.includes("/notifications"), "the employee never gets the incident text, id or admin link");
    // every type renders for every role it is routed to, in both formats
    for (const type of NOTIFICATION_TYPES) {
      for (const role of NOTIFICATION_ROUTES[type].roles) {
        const m = renderNotification({ event: { ...event, type, severity: NOTIFICATION_ROUTES[type].severity }, role, to: "x@example.com", dashboardUrl: "https://workfolio.example.com", sender: "IT@TFFDigital.com" });
        assert.ok(m.subject && m.text.includes("https://workfolio.example.com/") && m.html!.startsWith("<!doctype html>") && m.html!.includes('lang="en"'), `${type}/${role}`);
      }
    }
  });

  test("RBAC: employees and signed-out callers cannot read the log or the recipient lists, or re-send anything", async () => {
    assert.equal((await api("/notifications")).status, 401);
    assert.equal((await api("/notifications", { cookie: employee.cookie })).status, 403);
    assert.equal((await api(`/notifications/deliveries/${randomUUID()}/retry`, { method: "POST", cookie: employee.cookie })).status, 403);
    assert.equal((await api(`/notifications/deliveries/${randomUUID()}/retry`, { method: "POST", cookie: it1.cookie })).status, 404);
    assert.equal((await api("/notifications?show=everything", { cookie: it1.cookie })).status, 400);
    const critical = await api("/notifications?show=critical", { cookie: superAdmin.cookie });
    assert.ok(critical.body.events.length && critical.body.events.every((e: { severity: string }) => e.severity === "CRITICAL"));
    for (const leak of ["password", "token", "refresh"]) assert.ok(!critical.text.toLowerCase().includes(leak), leak);
  });
});

describe("event producers", () => {
  test("activation: the employee who set their first password is told; a later reset link is a password-change alert", async () => {
    const created = await api("/employees", { method: "POST", cookie: it1.cookie, body: { email: "joiner@example.com", employeeCode: "JOIN-1", fullName: "New Joiner", timezone: "UTC" } });
    assert.equal(created.status, 201, created.text);
    const token = /#token=([A-Za-z0-9_-]+)/.exec(mock.outbox.at(-1)!.text)![1]!;
    const from = mock.outbox.length;
    assert.equal((await api("/auth/setup-password", { method: "POST", body: { token, password: PASSWORD } })).status, 204);
    await svc.deliver();
    assert.deepEqual(mock.outbox.slice(from).map((m) => [m.to, m.subject]), [["joiner@example.com", "Your Insight Workfolio account is active"]]);

    const link = await api(`/employees/${created.body.employee.id}/setup-token`, { method: "POST", cookie: superAdmin.cookie });
    assert.ok(link.status === 200 || link.status === 201, link.text);
    assert.equal((await api("/auth/setup-password", { method: "POST", body: { token: link.body.token ?? link.body.setup.token, password: `${PASSWORD}!` } })).status, 204);
    await svc.deliver();
    assert.deepEqual([mock.outbox.at(-1)!.to, mock.outbox.at(-1)!.subject], ["joiner@example.com", "Your Insight Workfolio password was changed"]);
  });

  test("a reused refresh token is a security alert to that employee and IT, once", async () => {
    const login = await api("/auth/login", { method: "POST", body: { email: other.email, password: PASSWORD, client: "desktop" } });
    assert.equal(login.status, 200, login.text);
    const refreshToken = login.body.refreshToken as string;
    assert.ok(refreshToken, "the desktop client gets its refresh token in the body");
    assert.equal((await api("/auth/refresh", { method: "POST", body: { refreshToken } })).status, 200);
    const from = mock.outbox.length;
    assert.equal((await api("/auth/refresh", { method: "POST", body: { refreshToken } })).status, 401);
    assert.equal((await api("/auth/refresh", { method: "POST", body: { refreshToken } })).status, 401);
    await svc.deliver();
    assert.deepEqual(sentSince(from), [other.email, it1.email, it2.email].sort());
  });

  test("storage: a failed write tells IT once a day; the probe tells IT after 2 failures and raises a critical incident after 12", async () => {
    const day = Date.UTC(2031, 0, 6, 9);
    const first = await svc.storageFailed("Microsoft Graph upload failed (HTTP 503)", day);
    assert.ok(first);
    assert.equal(await svc.storageFailed("again", day + 3_600_000), null, "same day: no second event");
    assert.deepEqual((await deliveries(first!)).map((d) => d.role), ["IT", "IT"]);

    const internals = svc as unknown as { storage: { stat: () => Promise<unknown> }; config: { get: (k: string) => unknown } };
    const [storage, config] = [internals.storage, internals.config];
    internals.config = { get: (k: string) => (k === "SCREENSHOT_STORAGE" ? "onedrive" : config.get(k)) };
    internals.storage = { stat: () => Promise.reject(new StorageError("OneDrive authorization expired or was revoked; reconnect OneDrive")) };
    const count = async (type: string, key: string) => Number((await db.execute({ sql: "SELECT count(*) AS n FROM notification_events WHERE type = ? AND dedupe_key = ?", args: [type, key] })).rows[0]!.n);
    try {
      const at = Date.UTC(2031, 1, 3, 9);
      await svc.checkStorage(at);
      assert.equal(await count("SCREENSHOT_FAILURE", "storage:2031-02-03"), 0, "one failure is not reported");
      await svc.checkStorage(at);
      assert.equal(await count("SCREENSHOT_FAILURE", "storage:2031-02-03"), 1);
      for (let i = 0; i < 9; i++) await svc.checkStorage(at);
      assert.equal(await count("CRITICAL_FAILURE", "storage-critical:2031-02-03"), 0);
      await svc.checkStorage(at);
      assert.equal(await count("CRITICAL_FAILURE", "storage-critical:2031-02-03"), 1);
      const critical = (await db.execute({ sql: "SELECT id, description FROM notification_events WHERE dedupe_key = ?", args: ["storage-critical:2031-02-03"] })).rows[0]!;
      assert.match(String(critical.description), /unreachable for an hour \(OneDrive authorization expired/);
      assert.deepEqual((await deliveries(String(critical.id))).map((d) => d.role), ["IT", "IT", "SUPER_ADMIN", "SUPER_ADMIN"]);
      internals.storage = { stat: () => Promise.resolve(null) };
      await svc.checkStorage(at);
      internals.storage = { stat: () => Promise.reject(new StorageError("down again")) };
      await svc.checkStorage(at + 86_400_000);
      assert.equal(await count("SCREENSHOT_FAILURE", "storage:2031-02-04"), 0, "the count restarted after a success");
    } finally {
      internals.storage = storage;
      internals.config = config;
    }
    await svc.deliver();
  });

  test("onboarding summary: Mondays only, counts only, to IT and Super Admin, once", async () => {
    const monday = Date.UTC(2026, 10, 23, 8); // Monday 23 Nov 2026
    await db.execute({ sql: "UPDATE users SET created_at = ? WHERE email = 'joiner@example.com'", args: [new Date(monday - 86_400_000).toISOString()] });
    const events = async () => (await db.execute("SELECT id, description FROM notification_events WHERE type = 'ONBOARDING_SUMMARY'")).rows;
    await svc.onboardingSummary(monday - 86_400_000);
    assert.equal((await events()).length, 0, "not on a Sunday");
    await svc.onboardingSummary(monday);
    await svc.onboardingSummary(monday + 3_600_000);
    const [summary, ...rest] = await events();
    assert.equal(rest.length, 0);
    assert.match(String(summary!.description), /^Past 7 days: \d+ employee account\(s\) created, \d+ activated, \d+ awaiting activation, \d+ invitation email\(s\) not sent\.$/);
    assert.ok(!String(summary!.description).includes("joiner"), "no names or addresses");
    assert.deepEqual((await deliveries(String(summary!.id))).map((d) => d.role), ["IT", "IT", "SUPER_ADMIN", "SUPER_ADMIN"]);
    await svc.deliver();
  });

  test("notify CLI (backup timer, monitor): records a critical event for IT and Super Admin in the database, once a day; no recipient can be named", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-notify-cli-"));
    try {
      const env = { NODE_ENV: "test", DATABASE_URL: `file:${join(dir, "cli.db")}`, JWT_SECRET: "x".repeat(40) };
      const lines: string[] = [];
      assert.equal(await notifyCli([], env, (l: string) => lines.push(l)), 2);
      assert.equal(await notifyCli(["employee-invitation", "x"], env, (l: string) => lines.push(l)), 2, "only operational failures");
      assert.equal(await notifyCli(["backup-failure", "gpg", "exited", "2;", "to: evil@example.com"], env, (l: string) => lines.push(l)), 0);
      assert.equal(await notifyCli(["backup-failure", "second run"], env, (l: string) => lines.push(l)), 0);
      assert.match(lines.at(-2)!, /^recorded BACKUP_FAILURE [0-9a-f-]{36}$/);
      assert.equal(lines.at(-1), "already recorded today: BACKUP_FAILURE");
      const file = createDatabase({ url: env.DATABASE_URL });
      try {
        const events = (await file.execute("SELECT type, severity, description FROM notification_events")).rows;
        assert.deepEqual(events.map((e) => [e.type, e.severity, e.description]), [["BACKUP_FAILURE", "CRITICAL", "gpg exited 2; to: evil@example.com"]]);
        const ds = (await file.execute("SELECT recipient_role, recipient_user_id, status, last_error FROM notification_deliveries ORDER BY recipient_role")).rows;
        assert.deepEqual(ds.map((d) => [d.recipient_role, d.recipient_user_id, d.status]), [["IT", null, "FAILED"], ["SUPER_ADMIN", null, "FAILED"]], "an empty database has nobody to tell, and says so");
      } finally {
        file.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
