// Invitation emails in the admin UI (docs/invitations.md): a throwaway API (temporary file DB, MOCK email
// provider: nothing is emailed) on :4111, the dashboard dev server on :3111, headless Chrome over CDP on :9411.
// An IT Admin creates an employee in the dashboard; the invitation status is shown, the emailed link (read from
// the mock outbox) activates the account; a failed invitation shows the hand-over link and is resent from the
// employee's page. example.com addresses only.
// Run after `pnpm --filter @workfolio/api build`; needs Google Chrome (macOS path).
// Usage: node apps/dashboard/scripts/verify-invitations.mjs [out-dir]
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const ROOT = resolve(import.meta.dirname, "../../..");
const API_PORT = 4111, WEB_PORT = 3111, CDP_PORT = 9411;
const WEB = `http://localhost:${WEB_PORT}`;
const OUT = process.argv[2] ?? mkdtempSync(join(tmpdir(), "wf-verify-invitations-"));
const RUN = join(OUT, "run");
rmSync(RUN, { recursive: true, force: true });
mkdirSync(join(RUN, "shots"), { recursive: true });
Object.assign(process.env, {
  NODE_ENV: "development", LOG_LEVEL: "warn", PORT: String(API_PORT),
  DATABASE_URL: `file:${join(RUN, "invitations.db")}`,
  JWT_SECRET: "invitations-check-secret-0123456789",
  SCREENSHOT_STORAGE: "local", SCREENSHOT_LOCAL_DIR: join(RUN, "shots"),
  CORS_ORIGINS: WEB, DASHBOARD_URL: WEB,
  INVITATION_MAIL_PROVIDER: "mock", MAIL_SENDER: "IT@TFFDigital.com",
});
const results = [];
const check = (name, ok, detail = "") => (results.push({ name, ok }), console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = [];

try {
  // ---- API -------------------------------------------------------------------------------------
  const dist = (p) => import(`${ROOT}/apps/api/dist/${p}`);
  const req = createRequire(`${ROOT}/apps/api/package.json`);
  req("reflect-metadata");
  const { NestFactory } = req("@nestjs/core");
  const { AppModule } = await dist("app.module.js");
  const { configureApp } = await dist("app.setup.js");
  const { DATABASE } = await dist("database/database.module.js");
  const { hashPassword } = await dist("auth/crypto.js");
  const { INVITATION_TRANSPORT, INVITATION_RETRY } = await dist("employees/invitations.js");
  const app = await NestFactory.create(AppModule, { logger: ["error"] });
  configureApp(app);
  await app.listen(API_PORT);
  cleanup.push(() => app.close());
  const db = app.get(DATABASE);
  const mock = app.get(INVITATION_TRANSPORT);
  INVITATION_RETRY.delaysMs = [0, 0];
  const PASSWORD = "invitation check admin password 1";
  await db.execute({ sql: "INSERT INTO users (id, email, role, admin_title, password_hash) VALUES (?, 'it-admin@example.com', 'ADMIN', 'ADMIN', ?)", args: [randomUUID(), await hashPassword(PASSWORD)] });

  // ---- Dashboard + Chrome ------------------------------------------------------------------------
  const dash = spawn("pnpm", ["exec", "next", "dev", "--port", String(WEB_PORT)], {
    cwd: `${ROOT}/apps/dashboard`, stdio: "ignore", detached: true,
    env: { ...process.env, NODE_ENV: "development", NEXT_PUBLIC_API_URL: `http://localhost:${API_PORT}` },
  });
  cleanup.push(() => { try { process.kill(-dash.pid, "SIGTERM"); } catch {} });
  let up = false;
  for (let i = 0; i < 300 && !up; i++) {
    up = await fetch(`${WEB}/login`).then((r) => r.ok, () => false);
    if (!up) await sleep(500);
  }
  assert.ok(up, "next dev did not serve /login");
  const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(RUN, "chrome")}`, "--window-size=1280,1000", "--no-first-run", "about:blank"], { stdio: "ignore" });
  cleanup.push(() => chrome.kill("SIGKILL"));
  let target;
  for (let i = 0; i < 150 && !target; i++) {
    await sleep(200);
    target = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json(), () => null);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  cleanup.unshift(() => ws.close());
  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (!msg.id || !pending.has(msg.id)) return;
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  });
  const cdp = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result))); ws.send(JSON.stringify({ id, method, params })); });
  const js = async (expr) => {
    const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor = async (expr, label, ms = 60_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) if (await js(expr).catch(() => false)) return true;
    throw new Error(`timed out waiting for ${label}`);
  };
  const shot = async (name) => writeFileSync(join(OUT, name), Buffer.from((await cdp("Page.captureScreenshot", { format: "png" })).data, "base64"));
  const text = () => js("document.querySelector('main')?.innerText ?? ''");
  const hydrated = (sel) => `(() => { const f = document.querySelector(${JSON.stringify(sel)}); return !!f && Object.keys(f).some((k) => k.startsWith('__react')); })()`;
  const fill = (values) => js(`(() => {
    const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
    for (const [k, v] of Object.entries(${JSON.stringify(values)})) set(document.querySelector(k), v);
    document.querySelector('main form, form').requestSubmit(); return true; })()`);
  const go = async (path, ready) => {
    await cdp("Page.navigate", { url: `${WEB}${path}` });
    await waitFor(ready, path);
  };
  await cdp("Page.enable");
  await cdp("Runtime.enable");

  await go("/login", hydrated("form"));
  await fill({ "input[type=email], input[name=email]": "it-admin@example.com", "input[type=password]": PASSWORD });
  await waitFor(`location.pathname !== "/login"`, "sign-in");

  // 1) Create: the invitation goes out and its status is shown; no hand-over link.
  const createInUi = async (fullName, email, code) => {
    await go("/employees/new", hydrated("main form"));
    await fill({ "input[name=fullName]": fullName, "input[name=email]": email, "input[name=employeeCode]": code });
    await waitFor(`!!document.querySelector('[data-testid=invitation-status]')`, `invitation status for ${email}`);
  };
  await createInUi("Asha Synthetic", "asha@example.com", "INV-1");
  let t = await text();
  check("created: 'Invitation sent' to the recipient, sent time shown", /Invitation sent/.test(t) && t.includes("asha@example.com") && /\(UTC\)|\(Asia\/Kolkata\)/.test(t), t.replace(/\s+/g, " ").slice(0, 200));
  check("created: mock provider is labelled as not emailed; delivery not claimed", /Mock provider \(development\): nothing was emailed/.test(t) && /delivery to the inbox is not confirmed/.test(t));
  check("created: no setup link handed to the admin when the email went out", !(await js("!!document.querySelector('input[aria-label=\"Setup link\"]')")));
  check("exactly one email, to the new employee, with the subject", mock.outbox.length === 1 && mock.outbox[0].to === "asha@example.com" && mock.outbox[0].subject === "Welcome to Insight Workfolio — Activate Your Account");
  await shot("1-created-invitation-sent.png");

  // 2) The employee opens the emailed link and sets a password.
  const link = /(http\S+#token=[A-Za-z0-9_-]+)/.exec(mock.outbox[0].text)[1];
  check("emailed link points at this dashboard's setup page", link.startsWith(`${WEB}/setup-password#token=`));
  await cdp("Page.navigate", { url: "about:blank" });
  await cdp("Page.navigate", { url: link });
  await waitFor(hydrated("form button[type=submit]"), "setup form");
  await sleep(800);
  await fill({ "input[name=password]": "asha chose this password", "input[name=confirm]": "asha chose this password" });
  await waitFor(`document.body.innerText.includes("Password set.")`, "password set", 15_000);
  const asha = await fetch(`http://localhost:${API_PORT}/api/v1/auth/login`, { method: "POST", headers: { origin: WEB, "content-type": "application/json" }, body: JSON.stringify({ email: "asha@example.com", password: "asha chose this password" }) });
  check("the employee signs in with the password they chose", asha.status === 200, `HTTP ${asha.status}`);

  // 3) A failed invitation: the admin sees why and gets the link; then resends from the profile page.
  await go("/login", hydrated("form"));
  await fill({ "input[type=email], input[name=email]": "it-admin@example.com", "input[type=password]": PASSWORD });
  await waitFor(`location.pathname !== "/login"`, "sign-in again");
  mock.failNext("transient", 3);
  await createInUi("Ravi Synthetic", "ravi@example.com", "INV-2");
  t = await text();
  check("failed: 'Invitation failed' with attempts and the provider error", /Invitation failed/.test(t) && /Not sent after 3 attempts: Mock provider temporarily unavailable/.test(t), t.replace(/\s+/g, " ").slice(0, 240));
  check("failed: the hand-over setup link is shown instead", await js("!!document.querySelector('input[aria-label=\"Setup link\"]')"));
  await shot("2-created-invitation-failed.png");
  const ravi = await db.execute("SELECT p.id FROM employee_profiles p JOIN users u ON u.id = p.user_id WHERE u.email = 'ravi@example.com'");
  await go(`/employees/${ravi.rows[0].id}?tab=edit`, `[...document.querySelectorAll('button')].some((b) => b.textContent === "Resend invitation")`);
  // Other mail (e.g. Asha's "account is active" notification) may already be in the outbox: count from here.
  const sentBefore = mock.outbox.length;
  await js(`[...document.querySelectorAll('button')].find((b) => b.textContent === "Resend invitation").click()`);
  await waitFor(`!!document.querySelector('dialog[open]')`, "confirm dialog");
  await js(`[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === "Resend invitation").click()`);
  await waitFor(`document.body.innerText.includes("Invitation resent.") && document.querySelector('[data-testid=invitation-status]')?.dataset.status === "SENT"`, "resent");
  check("resend from the employee page: status becomes 'Invitation sent', one more email", mock.outbox.length === sentBefore + 1 && mock.outbox.at(-1).to === "ravi@example.com" && mock.outbox.at(-1).subject === "Welcome to Insight Workfolio — Activate Your Account", mock.outbox.map((m) => `${m.to}: ${m.subject}`).join(" | "));
  await shot("3-resent.png");

  // 4) Employees list and the accepted invitation.
  await go("/employees", `document.querySelectorAll('table tbody tr').length >= 2`);
  check("list: pending employee shows the invitation badge; the activated one does not", (await js(`(() => { const row = [...document.querySelectorAll('tbody tr')].find((r) => r.innerText.includes("ravi@example.com")); return row?.innerText.includes("Invitation sent") ?? false; })()`)) && (await js(`(() => { const row = [...document.querySelectorAll('tbody tr')].find((r) => r.innerText.includes("asha@example.com")); return !!row && !row.innerText.includes("Invitation"); })()`)));
  const ashaId = (await db.execute("SELECT p.id FROM employee_profiles p JOIN users u ON u.id = p.user_id WHERE u.email = 'asha@example.com'")).rows[0].id;
  await go(`/employees/${ashaId}?tab=edit`, `!!document.querySelector('[data-testid=invitation-status]')`);
  check("accepted: 'Invitation accepted' and no resend button", (await js(`document.querySelector('[data-testid=invitation-status]').dataset.status`)) === "ACCEPTED" && !(await js(`[...document.querySelectorAll('button')].some((b) => b.textContent === "Resend invitation")`)));
  await shot("4-accepted.png");
} catch (err) {
  check("run completed", false, err?.stack ?? String(err));
} finally {
  for (const fn of cleanup.reverse()) await Promise.resolve().then(fn).catch(() => {});
  await sleep(500);
  rmSync(RUN, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${OUT}`);
process.exit(failed.length ? 1 : 0);
