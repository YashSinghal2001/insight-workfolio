// Setup-link check (EW-05) in `next dev`, where React StrictMode runs effects twice: a throwaway API
// (temporary file DB) on :4107, the dashboard dev server on :3107, headless Chrome over CDP on :9407.
// An admin creates an employee through the API and the setup link is opened as the employee would.
// Checks: the password can be set, the fragment (token) is gone from the address bar and from the
// tab's history, the token is single-use, and a link without a token shows the warning.
// Run after `pnpm --filter @workfolio/api build`; needs Google Chrome (macOS path).
// Usage: node apps/dashboard/scripts/verify-setup-password.mjs [out-dir]
// Production build: `NEXT_PUBLIC_API_URL=http://localhost:4107 next build`, then run with VERIFY_MODE=start
// (serves the build with `next start` instead of `next dev`).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const ROOT = resolve(import.meta.dirname, "../../..");
const API_PORT = 4107, WEB_PORT = 3107, CDP_PORT = 9407;
const WEB = `http://localhost:${WEB_PORT}`;
const MODE = process.env.VERIFY_MODE === "start" ? "start" : "dev";
/** PNG screenshots land here; the database and Chrome profile are deleted at the end. */
const OUT = process.argv[2] ?? mkdtempSync(join(tmpdir(), "wf-verify-setup-password-"));
const RUN = join(OUT, "run");
rmSync(RUN, { recursive: true, force: true });
mkdirSync(join(RUN, "shots"), { recursive: true });
Object.assign(process.env, {
  NODE_ENV: "development", LOG_LEVEL: "warn", PORT: String(API_PORT),
  DATABASE_URL: `file:${join(RUN, "setup.db")}`,
  JWT_SECRET: "setup-password-check-secret-0123456789",
  SCREENSHOT_STORAGE: "local", SCREENSHOT_LOCAL_DIR: join(RUN, "shots"),
  CORS_ORIGINS: WEB, DASHBOARD_URL: WEB,
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
  const { setupLink } = await dist("auth/setup-token.js");
  const app = await NestFactory.create(AppModule, { logger: ["error", "warn"] });
  configureApp(app);
  await app.listen(API_PORT);
  cleanup.push(() => app.close());
  const db = app.get(DATABASE);
  const api = async (path, { method = "GET", body, cookie } = {}) => {
    const headers = { origin: WEB };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (cookie) headers.cookie = cookie;
    const res = await fetch(`http://localhost:${API_PORT}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text && (res.headers.get("content-type") ?? "").includes("json") ? JSON.parse(text) : undefined, res };
  };

  const ADMIN_PASSWORD = "setup check admin password 1";
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [randomUUID(), await hashPassword(ADMIN_PASSWORD)] });
  const login = await api("/auth/login", { method: "POST", body: { email: "admin@example.com", password: ADMIN_PASSWORD } });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const adminCookie = login.res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const created = await api("/employees", { method: "POST", cookie: adminCookie, body: { email: "newhire@example.com", employeeCode: "SET-1", fullName: "New Hire Synthetic", timezone: "Asia/Kolkata" } });
  check("admin created an employee and received a one-time setup token", created.status === 201 && !!created.body?.setup?.token, `HTTP ${created.status}`);
  const token = created.body.setup.token;
  const link = setupLink(WEB, token);
  check("setup link carries the token in the fragment", link === `${WEB}/setup-password#token=${token}`);

  // ---- Dashboard (dev server: StrictMode) ---------------------------------------------------------
  const dash = spawn("pnpm", ["exec", "next", MODE, "--port", String(WEB_PORT)], {
    cwd: `${ROOT}/apps/dashboard`, stdio: "ignore", detached: true,
    env: { ...process.env, NODE_ENV: MODE === "dev" ? "development" : "production", NEXT_PUBLIC_API_URL: `http://localhost:${API_PORT}` },
  });
  cleanup.push(() => { try { process.kill(-dash.pid, "SIGTERM"); } catch {} });
  let up = false;
  for (let i = 0; i < 300 && !up; i++) {
    up = await fetch(`${WEB}/setup-password`).then((r) => r.ok, () => false);
    if (!up) await sleep(500);
  }
  assert.ok(up, `next ${MODE} did not serve /setup-password`);
  check(`dashboard served by next ${MODE}`, true);

  // ---- Chrome ----------------------------------------------------------------------------------
  const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(RUN, "chrome")}`, "--window-size=1280,900", "--no-first-run", "about:blank"], { stdio: "ignore" });
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
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  // Records every history.replaceState call with the fragment seen at that moment.
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `window.__replaced = []; const rs = history.replaceState.bind(history);
    history.replaceState = (...a) => (window.__replaced.push({ hash: location.hash, url: String(a[2] ?? ""), fromPage: /SetupPasswordPage|setup-password.page/i.test(new Error().stack ?? "") }), rs(...a));` });

  /** Navigates and waits for React to hydrate the form (the submit button gets a fiber). */
  const open = async (url) => {
    // Via about:blank: from /setup-password, a link that differs only in its fragment would be a
    // same-document navigation (no reload, no fresh mount).
    await cdp("Page.navigate", { url: "about:blank" });
    await waitFor(`location.href === "about:blank"`, "about:blank");
    await cdp("Page.navigate", { url });
    await waitFor(`(() => { const b = document.querySelector('form button[type=submit]'); return !!b && Object.keys(b).some((k) => k.startsWith('__reactFiber')); })()`, `hydrated form at ${url}`);
    await sleep(800); // let both StrictMode effect runs and any re-render settle
  };
  const WARNING = "Open the full setup link you were given";
  const state = () => js(`({ href: location.href, hash: location.hash, warning: document.body.innerText.includes(${JSON.stringify(WARNING)}), disabled: document.querySelector('form button[type=submit]')?.disabled ?? null, replaced: window.__replaced })`);
  const navHistory = async () => (await cdp("Page.getNavigationHistory")).entries.map((e) => e.url);

  // 1) The real link.
  await open(link);
  let s = await state();
  check("fragment stripped from the address bar", s.hash === "" && !s.href.includes("token") && s.href === `${WEB}/setup-password`, s.href);
  let hist = await navHistory();
  check("token absent from the tab's history entries", hist.every((u) => !u.includes("token")), JSON.stringify(hist));
  check("no warning and submit enabled after StrictMode's double effect", !s.warning && s.disabled === false, `warning=${s.warning} disabled=${s.disabled}`);
  // Next's router wraps history.replaceState and makes its own calls too; the page's calls are told apart by the call stack.
  // A production build minifies the page's function names, so there the page's call is the one that dropped the token from the URL.
  const ours = MODE === "dev" ? s.replaced.filter((r) => r.fromPage) : s.replaced.filter((r) => r.hash.startsWith("#token=") && !r.url.includes("token"));
  check("page cleared the fragment exactly once (StrictMode's second effect run skipped)", ours.length === 1 && ours[0].hash.startsWith("#token="),
    JSON.stringify(s.replaced.map((r) => ({ hash: r.hash.slice(0, 7), url: r.url.replace(/token=[^&]+/, "token=…"), fromPage: r.fromPage }))));
  await shot("1-link-opened.png");

  const PASSWORD = "a brand new employee password";
  const submit = (pw, confirm = pw) => js(`(() => {
    const set = (n, v) => { const i = document.querySelector('input[name=' + n + ']'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, v); i.dispatchEvent(new Event('input', { bubbles: true })); };
    set('password', ${JSON.stringify(pw)}); set('confirm', ${JSON.stringify(confirm)});
    document.querySelector('form button[type=submit]').click(); return true; })()`);
  await submit(PASSWORD);
  await waitFor(`document.body.innerText.includes("Password set.")`, "success notice", 15_000);
  const text = await js("document.querySelector('main').innerText");
  check("password set; new success wording shown", /Use it to sign in to the Insight Workfolio desktop app/.test(text) && /web panel/.test(text), text.replace(/\s+/g, " ").slice(0, 160));
  check("success notice links to /login", await js(`document.querySelector('main a[href="/login"]')?.textContent === "web panel"`));
  await shot("2-password-set.png");
  const empLogin = await api("/auth/login", { method: "POST", body: { email: "newhire@example.com", password: PASSWORD } });
  check("employee can sign in with the new password", empLogin.status === 200, `HTTP ${empLogin.status}`);

  // 2) The same link again: the token is single-use.
  await open(link);
  await submit("another password for reuse");
  await waitFor(`!!document.querySelector('main [role=alert], main .text-danger') || /invalid|expired|used/i.test(document.querySelector('main').innerText)`, "reuse error", 15_000);
  const reuse = await js("document.querySelector('main').innerText");
  check("reusing the link is refused", !reuse.includes("Password set."), reuse.replace(/\s+/g, " ").slice(0, 160));
  await shot("3-link-reused.png");

  // 3) No token: plain path, empty fragment, fragment without a token value.
  for (const [label, url] of [["no fragment", `${WEB}/setup-password`], ["empty fragment", `${WEB}/setup-password#`], ["empty token", `${WEB}/setup-password#token=`]]) {
    await open(url);
    s = await state();
    check(`${label}: warning shown and submit disabled`, s.warning && s.disabled === true, `warning=${s.warning} disabled=${s.disabled}`);
  }
  await shot("4-no-token.png");
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
