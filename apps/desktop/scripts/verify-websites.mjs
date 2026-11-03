// F04 runtime check with a REAL browser extension: Google Chrome (headless) with the unpacked extension
// from apps/browser-extension loaded over the DevTools pipe (`Extensions.loadUnpacked`), the desktop
// front end (Vite :1420) for the employee, the dashboard production build (:3102) for the admin, and a
// throwaway API (:4000, temporary DB). Test websites are served locally under mapped hostnames
// (*.example.test, *.other.test). Synthetic people only; no real browsing data.
// Not covered: Safari (needs a Safari Web Extension in an app), Firefox, a packaged Tauri window, and a
// visible incognito window (an off-the-record browser context stands in for it).
// Run after `pnpm build`. Needs Google Chrome and free ports 4000, 1420 and 3102.
// Usage: [BROWSER=chrome|brave] pnpm --filter @workfolio/desktop verify:websites [out-dir]
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../..");
const EXT = join(ROOT, "apps/browser-extension");
const OUT = process.argv[2] ?? mkdtempSync(join(tmpdir(), "wf-verify-websites-"));
const RUN = join(OUT, "run");
rmSync(RUN, { recursive: true, force: true });
mkdirSync(RUN, { recursive: true });
Object.assign(process.env, {
  NODE_ENV: "development", LOG_LEVEL: "warn", PORT: "4000",
  DATABASE_URL: `file:${join(RUN, "websites.db")}`, JWT_SECRET: "websites-check-secret-websites-check-sec",
  SCREENSHOT_STORAGE: "local", SCREENSHOT_LOCAL_DIR: join(RUN, "shots"), TIMELAPSE_DIR: join(RUN, "videos"),
  CORS_ORIGINS: "http://localhost:1420,http://localhost:3102", REPORT_SCHEDULER_SECONDS: "0",
});
const req = createRequire(`${ROOT}/apps/api/package.json`);
req("reflect-metadata");
const { NestFactory } = req("@nestjs/core");
const dist = (p) => import(`${ROOT}/apps/api/dist/${p}`);
const { AppModule } = await dist("app.module.js");
const { configureApp } = await dist("app.setup.js");
const { DATABASE } = await dist("database/database.module.js");
const { hashPassword } = await dist("auth/crypto.js");
const { MonitoringSettingsService } = await dist("settings/monitoring-settings.service.js");
const { localDate } = await import(`${ROOT}/packages/shared/dist/index.js`);
const PASSWORD = "websites check password 1";
const BROWSERS = { chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", brave: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" };
const BROWSER = process.env.BROWSER ?? "chrome";
console.log(`Browser: ${BROWSER}`);
const APP = "http://localhost:1420";
const DASH = "http://localhost:3102";
const results = [];
const check = (name, ok, detail = "") => (results.push({ name, ok }), console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString();

// ---- API, people, settings ---------------------------------------------------------------------------
const app = await NestFactory.create(AppModule, { logger: ["error", "warn"] });
configureApp(app);
await app.listen(4000);
const db = app.get(DATABASE);
const api = async (path, { method = "GET", body, cookie, bearer, headers = {} } = {}) => {
  const h = { origin: APP, ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  if (cookie) h.cookie = cookie;
  if (bearer) h.authorization = `Bearer ${bearer}`;
  const res = await fetch(`http://localhost:4000/api/v1${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text && (res.headers.get("content-type") ?? "").includes("json") ? JSON.parse(text) : undefined, res };
};
// The CEO (Super Admin) and IT (Admin): same permissions, different identity.
await db.execute({ sql: "INSERT INTO users (id, email, role, admin_title, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', 'SUPER_ADMIN', ?), (?, 'it@example.com', 'ADMIN', 'ADMIN', ?)", args: [randomUUID(), await hashPassword(PASSWORD), randomUUID(), await hashPassword(PASSWORD)] });
const adminCookie = (await api("/auth/login", { method: "POST", body: { email: "admin@example.com", password: PASSWORD } })).res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
async function employee(n, name) {
  const email = `site${n}@example.com`;
  const r = await api("/employees", { method: "POST", cookie: adminCookie, body: { email, employeeCode: `WS-${n}`, fullName: name, timezone: "UTC" } });
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const bearer = (await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } })).body.accessToken;
  const device = randomUUID();
  await api("/devices/register", { method: "POST", bearer, body: { installationId: device, deviceName: "Mac", platform: "macos" } });
  await api("/attendance/sync", { method: "POST", bearer, headers: { "x-device-id": device }, body: { sentAt: iso(Date.now()), events: [{ id: randomUUID(), type: "CLOCK_IN", occurredAt: iso(Date.now() - 30 * 60_000) }] } });
  return { id: r.body.employee.id, email, bearer, device };
}
const ana = await employee(1, "Ana Employee");
const ben = await employee(2, "Ben Other");
// The organization's idle threshold also pauses website time; the maximum (1 h) keeps an untouched test Mac "active".
const m = await app.get(MonitoringSettingsService).current();
await api("/settings/monitoring", { method: "PUT", cookie: adminCookie, body: { enabled: m.enabled, sampleSeconds: m.sampleSeconds, idleThresholdSeconds: 3600, retentionDays: m.retentionDays, retentionApproved: m.retentionApproved, noticeVersion: m.noticeVersion, reason: "verification: idle threshold 1 h" } });
const intervals = async (employeeId) => (await db.execute({ sql: "SELECT * FROM website_intervals WHERE employee_id = ? ORDER BY started_at", args: [employeeId] })).rows;

// ---- Local test websites ---------------------------------------------------------------------------------
const site = http.createServer((q, r) => r.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Private page title ${q.url}</title><p>Page body with secret text for ${q.headers.host}</p><input type=password value=hunter2>`));
await new Promise((r) => site.listen(0, r));
const P = site.address().port;
const url = (host, path = "/") => `http://${host}:${P}${path}`;

// ---- Front ends -----------------------------------------------------------------------------------------
const vite = spawn("pnpm", ["exec", "vite", "--port", "1420", "--strictPort"], { cwd: `${ROOT}/apps/desktop`, stdio: "ignore", env: { ...process.env, VITE_API_URL: "http://localhost:4000" } });
const dash = spawn("pnpm", ["exec", "next", "start", "--port", "3102"], { cwd: `${ROOT}/apps/dashboard`, stdio: "ignore" });
for (const u of [APP, `${DASH}/login`]) for (let i = 0; i < 150 && !(await fetch(u).then((r) => r.ok, () => false)); i++) await sleep(200);

// ---- Chrome over the DevTools pipe (needed for Extensions.loadUnpacked) -----------------------------------------
let chrome;
let seq = 0;
const pending = new Map();
function launchBrowser() {
  chrome = spawn(BROWSERS[BROWSER], ["--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${join(RUN, "browser")}`, "--no-first-run", "--window-size=1200,1000", "--host-resolver-rules=MAP *.test 127.0.0.1", "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  let buffer = "";
  chrome.stdio[4].on("data", (d) => {
    buffer += d;
    for (let i; (i = buffer.indexOf("\0")) >= 0; ) {
      const msg = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      if (msg.id && pending.has(msg.id)) (pending.get(msg.id)(msg), pending.delete(msg.id));
    }
  });
}
launchBrowser();
const cdp = (method, params = {}, sessionId) => new Promise((res, rej) => { const id = ++seq; pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result))); chrome.stdio[3].write(`${JSON.stringify({ id, method, params, sessionId })}\0`); });
async function tab(u, opts = {}) {
  const { targetId } = await cdp("Target.createTarget", { url: u, ...opts });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  await cdp("Runtime.enable", {}, sessionId);
  return { targetId, sessionId };
}
const js = async (t, expr) => {
  const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, t.sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const waitFor = async (t, expr, label, ms = 20_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) if (await js(t, expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${label}`);
};
const shot = async (t, name) => writeFileSync(join(OUT, name), Buffer.from((await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, t.sessionId)).data, "base64"));
const setReact = (sel, value) => `(() => { const el = ${sel}; const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); })()`;

let debugTab = null;
try {
  const { id: extId } = await cdp("Extensions.loadUnpacked", { path: EXT });
  check(`real ${BROWSER} loaded the unpacked extension (Manifest V3)`, /^[a-p]{32}$/.test(extId), extId);

  // ---- Admin: off by default, then on with a reason; category rules ----
  let d = await tab(`${DASH}/login`);
  await waitFor(d, `(() => { const f = document.querySelector('form'); return !!f && Object.keys(f).some((k) => k.startsWith('__reactProps')); })()`, "login form");
  await js(d, `(() => { const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
    set(document.querySelector('input[type=email], input[name=email]'), "admin@example.com"); set(document.querySelector('input[type=password]'), ${JSON.stringify(PASSWORD)}); document.querySelector('form').requestSubmit(); })()`);
  await waitFor(d, `location.pathname !== "/login"`, "signed in");
  const nav = `[...document.querySelectorAll('nav a')].find((a) => a.textContent === 'Websites')`;
  await waitFor(d, `!!${nav}`, "Websites link");
  await js(d, `${nav}.click()`);
  await waitFor(d, `location.pathname === '/websites' && document.body.innerText.includes('Website tracking is off')`, "websites page");
  const page = await js(d, `document.body.innerText`);
  check("dashboard: off by default, with warnings (draft notice, texts that still say websites are never recorded, acknowledgements 0 of 2)", /Website tracking:\s*Off/.test(page) && /is a draft/.test(page) && /0 of 2 current employees/.test(page) && /not a measure of productivity/.test(page));
  const policyForm = `[...document.querySelectorAll('form')].find((f) => f.innerText.includes('Save policy'))`;
  await js(d, `${policyForm}.querySelector('input[type=checkbox]').click()`);
  await js(d, setReact(`[...${policyForm}.querySelectorAll('input')].at(-1)`, "Pilot with synthetic people (verification)"));
  await js(d, `${policyForm}.requestSubmit()`);
  await waitFor(d, `document.body.innerText.includes('Saved. The change is recorded') && /Website tracking:\\s*On/.test(document.body.innerText)`, "policy on");
  check("dashboard: admin turns tracking on with a reason; recorded in the history", (await js(d, `document.body.innerText`)).includes("Pilot with synthetic people (verification)"));
  const ruleForm = `[...document.querySelectorAll('form')].find((f) => f.innerText.includes('Add rule'))`;
  for (const [domain, match, category] of [["docs.example.test", "EXACT", "PRODUCTIVE"], ["example.test", "SUBDOMAINS", "NEUTRAL"]]) {
    await js(d, setReact(`${ruleForm}.querySelector('input')`, domain));
    await js(d, setReact(`${ruleForm}.querySelectorAll('select')[0]`, match));
    await js(d, setReact(`${ruleForm}.querySelectorAll('select')[1]`, category));
    await js(d, `${ruleForm}.requestSubmit()`);
    await waitFor(d, `document.querySelector('table[aria-label="Category rules"]').innerText.includes(${JSON.stringify(domain)})`, `rule ${domain}`);
  }
  check("dashboard: category rules added (exact and domain-and-subdomains)", true);

  // ---- Employee: notice, then a connection code ----
  let e = await tab(APP);
  await waitFor(e, `!document.querySelector('#login-view').hidden`, "desktop login");
  await js(e, `(() => { const f = document.querySelector('#login-form'); f.email.value = ${JSON.stringify(ana.email)}; f.password.value = ${JSON.stringify(PASSWORD)}; f.requestSubmit(); })()`);
  await waitFor(e, `!document.querySelector('#signed-in-view').hidden`, "desktop signed in");
  await js(e, `document.querySelector('#tab-btn-websites').click()`);
  await waitFor(e, `!document.querySelector('#web-body').hidden && !document.querySelector('#web-notice').hidden`, "websites tab with notice");
  const before = await js(e, `({ state: document.querySelector('#web-state').textContent, reasons: document.querySelector('#web-reasons').innerText, never: document.querySelector('#web-never').innerText, notice: document.querySelector('#web-notice').innerText })`);
  check("desktop: not recording until acknowledged; says what is and is never recorded; shows the (draft) notice", before.state === "Not recording" && /not acknowledged/.test(before.reasons) && /search terms/.test(before.never) && /incognito/.test(before.never) && /\(draft\)/.test(before.notice), before.reasons.replace(/\s+/g, " "));
  await js(e, `document.querySelector('#web-ack').click()`);
  await waitFor(e, `document.querySelector('#web-notice').hidden && document.querySelector('#web-reasons').innerText.includes('No browser extension is connected')`, "acknowledged");
  await js(e, `document.querySelector('#web-connect').click()`);
  await waitFor(e, `/^[A-Z2-9]{8}$/.test(document.querySelector('#web-code').textContent)`, "code");
  const code = await js(e, `document.querySelector('#web-code').textContent`);
  check("desktop: acknowledged; a one-time connection code is shown", /^[A-Z2-9]{8}$/.test(code));

  // ---- The extension: connect with the code ----
  let pop = (debugTab = await tab(`chrome-extension://${extId}/popup.html`));
  await waitFor(pop, `!document.querySelector('#connect').hidden`, "popup");
  check("extension (not connected): says nothing is recorded", (await js(pop, `document.querySelector('#status').textContent`)) === "Not connected. Nothing is recorded.");
  await js(pop, `(() => { const f = document.querySelector('#connect'); f.code.value = ${JSON.stringify(code)}; f.label.value = 'Chrome (verification)'; f.requestSubmit(); })()`);
  await waitFor(pop, `document.querySelector('#status').textContent === 'Recording website domain names.'`, "recording");
  check("extension: connected as Ana; recording; says what is recorded and never", (await js(pop, `document.body.innerText`)).includes("Connected as Ana Employee (WS-1)") && /Never:/.test(await js(pop, `document.body.innerText`)));
  const tick = () => js(pop, `chrome.runtime.sendMessage({ type: 'tick' })`);
  const ext = (expr) => js(pop, expr); // chrome.* APIs, from the extension's own page

  // ---- Real browsing in a window of its own ----
  let w = await tab("about:blank", { newWindow: true });
  await cdp("Target.activateTarget", { targetId: w.targetId });
  const go = async (u, ms) => {
    await cdp("Page.navigate", { url: u }, w.sessionId);
    await sleep(ms);
  };
  await go(url("docs.example.test", "/secret/path?q=hidden-search#frag"), 3500);
  await go(url("news.example.test", "/article?id=42"), 2500);
  await go(url("blog.other.test", "/2026/private-post"), 2200);
  // An off-the-record (incognito-like) context: the extension does not run there.
  const { browserContextId } = await cdp("Target.createBrowserContext");
  const inc = await tab(url("private.example.test", "/secret"), { browserContextId, newWindow: true });
  await cdp("Target.activateTarget", { targetId: inc.targetId });
  await sleep(2500);
  await cdp("Target.closeTarget", { targetId: inc.targetId });
  await cdp("Target.activateTarget", { targetId: w.targetId });
  await go("about:blank", 1200);
  await tick();
  await sleep(500);
  await tick();
  const rows = await intervals(ana.id);
  const domains = [...new Set(rows.map((r) => r.domain))];
  check("recorded domains are exactly the regular-window sites, as domains only", JSON.stringify([...domains].sort()) === JSON.stringify(["blog.other.test", "docs.example.test", "news.example.test"]), JSON.stringify(rows.map((r) => [r.domain, r.duration_ms])));
  const all = JSON.stringify((await db.execute("SELECT * FROM website_intervals")).rows) + JSON.stringify((await db.execute("SELECT * FROM website_audit")).rows);
  // Every stored domain is a bare hostname; nothing stored anywhere carries the test site's port or any part of a page.
  const leak = all.match(new RegExp(`secret|path|hidden-search|frag|article|id=42|private-post|Private page|hunter2|:${P}\\b`));
  const bare = rows.every((r) => /^[a-z0-9.-]+$/.test(String(r.domain)));
  check("nothing but domains reached the server: no paths, queries, fragments, titles, page text, passwords or ports", !leak && bare, leak ? `found "${leak[0]}" in …${all.slice(Math.max(0, leak.index - 60), leak.index + 40)}…` : "");
  check("the off-the-record (incognito-like) window was not recorded", !domains.includes("private.example.test"));
  const docs = rows.filter((r) => r.domain === "docs.example.test").reduce((n, r) => n + Number(r.duration_ms), 0);
  check("durations follow the visits (docs ≈ 3.5 s, news ≈ 2.5 s)", docs >= 2500 && docs <= 6000 && rows.filter((r) => r.domain === "news.example.test").every((r) => Number(r.duration_ms) >= 1500 && Number(r.duration_ms) <= 5000), `docs ${docs} ms`);

  // ---- The employee sees their own; the admin sees reports with categories ----
  await js(e, `document.querySelector('#web-range').requestSubmit()`);
  await waitFor(e, `document.querySelector('#web-usage').innerText.includes('docs.example.test')`, "own usage");
  const own = await js(e, `document.querySelector('#web-usage').innerText`);
  check("desktop: own website activity with the organization's categories (productive, neutral, unclassified)", /docs\.example\.test — .*category: productive/.test(own) && /news\.example\.test — .*category: neutral/.test(own) && /blog\.other\.test — .*category: unclassified/.test(own), own.replace(/\n/g, " | "));
  check("desktop: 'Recording website domain names' indicator while collecting", (await js(e, `document.querySelector('#web-state').textContent`)) === "Recording website domain names");
  await shot(e, "websites-desktop.png");
  await cdp("Page.reload", {}, d.sessionId);
  await waitFor(d, `document.querySelector('table[aria-label="Time by domain"]')?.innerText.includes('docs.example.test')`, "report");
  const rep = await js(d, `document.querySelector('table[aria-label="Time by domain"]').innerText`);
  const people = await js(d, `document.querySelector('table[aria-label="Time by employee"]').innerText`);
  check("dashboard: domain report with categories from the rules; employee report; totals and unclassified", /docs\.example\.test\s+Productive/.test(rep) && /news\.example\.test\s+Neutral/.test(rep) && /blog\.other\.test\s+Unclassified/.test(rep) && people.includes("Ana Employee") && !people.includes("Ben Other") && (await js(d, `document.querySelector('[data-testid="web-totals"]').innerText`)).includes("Unclassified"));
  await js(d, setReact(`document.querySelector('select[aria-label="Category filter"]')`, "PRODUCTIVE"));
  await waitFor(d, `(() => { const t = document.querySelector('table[aria-label="Time by domain"]').innerText; return t.includes('docs.example.test') && !t.includes('news.example.test'); })()`, "category filter");
  check("dashboard: category filter (Productive shows only docs.example.test)", true);
  await js(d, setReact(`document.querySelector('select[aria-label="Category filter"]')`, ""));
  await waitFor(d, `document.querySelector('table[aria-label="Time by domain"]').innerText.includes('blog.other.test')`, "filter cleared");
  const daily = await js(d, `document.querySelector('table[aria-label="Employee daily detail"]').innerText`);
  check("dashboard: overview (employees with activity 1), employee daily detail (date, employee, domain, time, category), domain employee counts", (await js(d, `document.querySelector('[data-testid="web-employees"]').textContent`)) === "1" && new RegExp(`${localDate(Date.now(), "UTC")}\\s+Ana Employee WS-1\\s+docs\\.example\\.test`).test(daily) && /docs\.example\.test\s+Productive\s+[\dhm ]+\s+1\s+1/.test(await js(d, `document.querySelector('table[aria-label="Time by domain"]').innerText`)), daily.split("\n").slice(0, 3).join(" | "));
  await js(d, `(() => { const i = document.querySelector('input[aria-label="Domain filter"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, "example.test"); i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
  await waitFor(d, `(() => { const t = document.querySelector('table[aria-label="Time by domain"]').innerText; return t.includes('docs.example.test') && !t.includes('blog.other.test'); })()`, "domain filter");
  check("dashboard: domain filter covers the domain and its subdomains (example.test: docs and news, not blog.other.test)", true);
  const notesText = await js(d, `document.querySelector('table[aria-label="Notification status"]').innerText`);
  check("dashboard: employee notification status (Ana acknowledged with 1 browser, Ben not acknowledged)", /Ana Employee WS-1\s+acknowledged [^\n]+\s+1/.test(notesText) && /Ben Other WS-2\s+not acknowledged\s+0/.test(notesText), notesText.replace(/\s+/g, " "));
  check("dashboard: header shows the Super Admin identity (from the server)", (await js(d, `document.querySelector('[data-testid="platform-role"]').textContent`)) === "Super Admin");
  await shot(d, "websites-dashboard.png");

  // ---- Tabs: a background tab never counts; switching tabs ends one interval and starts the next ----
  const before2 = (await intervals(ana.id)).length;
  await cdp("Target.activateTarget", { targetId: w.targetId });
  await go(url("docs.example.test", "/again"), 300);
  const winId = await ext(`chrome.windows.getLastFocused().then((x) => x.id)`);
  const bg = await ext(`chrome.tabs.create({ windowId: ${winId}, url: ${JSON.stringify(url("background.example.test", "/"))}, active: false }).then((t) => t.id)`);
  await sleep(2500);
  await ext(`chrome.tabs.update(${bg}, { active: true })`);
  await sleep(2000);
  const front = await ext(`chrome.tabs.query({ windowId: ${winId}, url: '*://docs.example.test/*' }).then((t) => t[0].id)`);
  await ext(`chrome.tabs.update(${front}, { active: true })`);
  await sleep(1500);
  await go("about:blank", 800);
  await tick();
  const tabRows = (await intervals(ana.id)).slice(before2);
  const tabSeq = tabRows.map((r) => r.domain);
  const bgMs = tabRows.filter((r) => r.domain === "background.example.test").reduce((n, r) => n + Number(r.duration_ms), 0);
  check("tabs: background tab not counted while in the background; switching gives docs → background → docs with no overlap", JSON.stringify(tabSeq) === JSON.stringify(["docs.example.test", "background.example.test", "docs.example.test"]) && bgMs >= 1500 && bgMs <= 3000 && tabRows.every((r, i) => i === 0 || r.started_at >= tabRows[i - 1].ended_at), JSON.stringify(tabRows.map((r) => [r.domain, r.duration_ms])));

  // ---- Minimized window (headless: reported as observed, not asserted) ----
  const beforeMin = (await intervals(ana.id)).length;
  await go(url("minimized.example.test", "/"), 1200);
  await ext(`chrome.windows.update(${winId}, { state: "minimized" })`);
  await sleep(2500);
  const minState = await ext(`chrome.windows.get(${winId}).then((x) => x.state + "/" + x.focused)`);
  await ext(`chrome.windows.update(${winId}, { state: "normal" })`);
  await go("about:blank", 800);
  await tick();
  const minMs = (await intervals(ana.id)).slice(beforeMin).filter((r) => r.domain === "minimized.example.test").reduce((n, r) => n + Number(r.duration_ms), 0);
  check("minimized window: time while minimized is not counted (about 1.2 s visible of 3.7 s)", minState.startsWith("minimized") && minMs >= 700 && minMs <= 2500, `window ${minState}; recorded ${minMs} ms`);

  // ---- Browser closed and reopened: nothing for the closed period; recording resumes with the saved connection ----
  const closedAt = Date.now();
  chrome.kill();
  await sleep(3000);
  launchBrowser();
  const reopenedAt = Date.now();
  await cdp("Extensions.loadUnpacked", { path: EXT }); // same folder, same id; storage kept in the profile
  pop = debugTab = await tab(`chrome-extension://${extId}/popup.html`);
  await waitFor(pop, `document.querySelector('#who')?.textContent.includes('Ana Employee')`, "still connected after reopen", 30_000);
  await tick();
  w = await tab("about:blank", { newWindow: true });
  await cdp("Target.activateTarget", { targetId: w.targetId });
  await go(url("after-reopen.example.test", "/"), 2000);
  await go("about:blank", 800);
  await tick();
  const all2 = await intervals(ana.id);
  check("browser closed/reopened: still connected; recording resumes; no interval covers the closed period", all2.some((r) => r.domain === "after-reopen.example.test") && !all2.some((r) => Date.parse(r.started_at) < reopenedAt && Date.parse(r.ended_at) > closedAt));
  d = await tab(`${DASH}/websites`);
  await waitFor(d, `document.body.innerText.includes('Website tracking:')`, "dashboard after reopen (cookie kept)");
  e = await tab(APP);
  await waitFor(e, `!document.querySelector('#login-view').hidden`, "desktop login after reopen");
  await js(e, `(() => { const f = document.querySelector('#login-form'); f.email.value = ${JSON.stringify(ana.email)}; f.password.value = ${JSON.stringify(PASSWORD)}; f.requestSubmit(); })()`);
  await waitFor(e, `!document.querySelector('#signed-in-view').hidden`, "desktop signed in after reopen");
  await js(e, `document.querySelector('#tab-btn-websites').click()`);

  // ---- Employee web dashboard (separate browser profile: Ana signs in to the web) ----
  const anaCtx = (await cdp("Target.createBrowserContext")).browserContextId;
  const my = await tab(`${DASH}/login`, { browserContextId: anaCtx });
  await waitFor(my, `(() => { const f = document.querySelector('form'); return !!f && Object.keys(f).some((k) => k.startsWith('__reactProps')); })()`, "employee login form");
  await js(my, `(() => { const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
    set(document.querySelector('input[type=email], input[name=email]'), ${JSON.stringify(ana.email)}); set(document.querySelector('input[type=password]'), ${JSON.stringify(PASSWORD)}); document.querySelector('form').requestSubmit(); })()`);
  await waitFor(my, `location.pathname === '/my'`, "employee dashboard after sign-in");
  await cdp("Page.navigate", { url: `${DASH}/my/websites` }, my.sessionId); // the website page of the employee panel
  await waitFor(my, `location.pathname === '/my/websites' && !!document.querySelector('table[aria-label="My recorded websites"] tbody tr td')`, "employee website page");
  await waitFor(my, `document.querySelector('table[aria-label="My recorded websites"]').innerText.includes('docs.example.test')`, "own rows");
  const myText = await js(my, `document.body.innerText`);
  check("employee web dashboard: own website activity (date, domain, time, category), status, collected/never lists, no other employee", /Recording website domain names/.test(myText) && /docs\.example\.test[\s\S]*Productive/.test(myText) && /Never recorded/.test(myText) && !myText.includes("Ben Other") && myText.includes("Ana Employee (WS-1)"));
  await cdp("Page.navigate", { url: `${DASH}/websites` }, my.sessionId);
  await waitFor(my, `location.pathname === '/my'`, "employee sent back from the admin area");
  const forbidden = await js(my, `Promise.all(["/websites/report?from=2026-10-01&to=2026-10-07", "/websites/policy", "/roles/users", "/websites/notifications"].map((p) => fetch("http://localhost:4000/api/v1" + p, { credentials: "include" }).then((r) => r.status)))`);
  check("employee web dashboard: admin pages redirect to /my; admin API routes refused with the employee's own session (403)", forbidden.every((x) => x === 403), JSON.stringify(forbidden));
  await shot(my, "websites-employee-web.png");

  // ---- IT Admin: the same Website Usage functions as the Super Admin ----
  const itCtx = (await cdp("Target.createBrowserContext")).browserContextId;
  const it = await tab(`${DASH}/login`, { browserContextId: itCtx });
  await waitFor(it, `(() => { const f = document.querySelector('form'); return !!f && Object.keys(f).some((k) => k.startsWith('__reactProps')); })()`, "IT login form");
  await js(it, `(() => { const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
    set(document.querySelector('input[type=email], input[name=email]'), "it@example.com"); set(document.querySelector('input[type=password]'), ${JSON.stringify(PASSWORD)}); document.querySelector('form').requestSubmit(); })()`);
  await waitFor(it, `location.pathname === '/'`, "IT signed in");
  await cdp("Page.navigate", { url: `${DASH}/websites` }, it.sessionId);
  await waitFor(it, `document.querySelector('table[aria-label="Time by domain"]')?.innerText.includes('docs.example.test') && !!document.querySelector('table[aria-label="Category rules"]') && !!document.querySelector('table[aria-label="Notification status"]')`, "IT websites page");
  check("IT Admin: same Website Usage page (policy, reports, categories, notifications) with the Admin identity", (await js(it, `document.querySelector('[data-testid="platform-role"]').textContent`)) === "Admin" && (await js(it, `[...document.querySelectorAll('form')].some((f) => f.innerText.includes('Save policy'))`)));
  await cdp("Page.navigate", { url: `${DASH}/roles` }, it.sessionId);
  await waitFor(it, `document.querySelector('table[aria-label="Accounts and roles"]')?.innerText.includes('admin@example.com')`, "roles page");
  const rolesText = await js(it, `document.querySelector('table[aria-label="Accounts and roles"]').innerText`);
  check("Roles page: Super Admin, Admin and Employee identities listed; own role not editable", /admin@example\.com\s+Super Admin/.test(rolesText) && /it@example\.com\s+Admin\s+your own role cannot be changed here/.test(rolesText) && /site1@example\.com[^\n]*\s+Employee/.test(rolesText), rolesText.split("\n").slice(0, 4).join(" | "));

  // ---- Break: the extension stops; nothing is recorded ----
  await api("/attendance/break/start", { method: "POST", bearer: ana.bearer, headers: { "x-device-id": ana.device, "idempotency-key": randomUUID() } });
  await tick();
  await waitFor(pop, `document.querySelector('#status').textContent === 'Not recording.' && document.querySelector('#reasons').textContent.includes('on a break')`, "paused on break");
  await go(url("during-break.example.test", "/"), 2500);
  await go("about:blank", 800);
  await tick();
  check("break: extension shows 'Not recording' with the reason; nothing recorded during the break", !(await intervals(ana.id)).some((r) => r.domain === "during-break.example.test"));
  await api("/attendance/break/end", { method: "POST", bearer: ana.bearer, headers: { "x-device-id": ana.device, "idempotency-key": randomUUID() } });

  // ---- Policy off: the extension stops ----
  await js(d, `${policyForm}.querySelector('input[type=checkbox]').click()`);
  await js(d, setReact(`[...${policyForm}.querySelectorAll('input')].at(-1)`, "Pilot ended (verification)"));
  await js(d, `${policyForm}.requestSubmit()`);
  await waitFor(d, `/Website tracking:\\s*Off/.test(document.body.innerText)`, "policy off");
  await tick();
  await waitFor(pop, `document.querySelector('#reasons').textContent.includes('turned off')`, "paused by policy");
  const countAtOff = (await intervals(ana.id)).length;
  await go(url("after-off.example.test", "/"), 2000);
  await go("about:blank", 800);
  await tick();
  check("policy off: extension stops ('turned off'); nothing recorded; earlier records kept", !(await intervals(ana.id)).some((r) => r.domain === "after-off.example.test") && (await intervals(ana.id)).length === countAtOff);
  await shot(pop, "websites-extension-popup.png");

  // ---- Disconnect from the desktop app: the extension's token stops working ----
  await cdp("Page.navigate", { url: APP }, e.sessionId);
  await waitFor(e, `!document.querySelector('#login-view').hidden`, "desktop login again");
  await js(e, `(() => { const f = document.querySelector('#login-form'); f.email.value = ${JSON.stringify(ana.email)}; f.password.value = ${JSON.stringify(PASSWORD)}; f.requestSubmit(); })()`);
  await waitFor(e, `!document.querySelector('#signed-in-view').hidden`, "signed in again");
  await js(e, `document.querySelector('#tab-btn-websites').click()`);
  await waitFor(e, `[...document.querySelectorAll('#web-links button')].some((b) => b.textContent === 'Disconnect')`, "connection listed");
  await js(e, `[...document.querySelectorAll('#web-links button')].find((b) => b.textContent === 'Disconnect').click()`);
  await waitFor(e, `document.querySelector('#web-links').innerText.includes('No browser connected')`, "disconnected");
  await tick();
  await waitFor(pop, `document.querySelector('#status').textContent === 'Not connected. Nothing is recorded.'`, "extension disconnected");
  check("disconnect in the desktop app: the extension is told on its next contact and forgets its token", true);

  // ---- Extension removed: nothing more is recorded; the connection shows its last contact ----
  await js(d, `${policyForm}.querySelector('input[type=checkbox]').click()`);
  await js(d, setReact(`[...${policyForm}.querySelectorAll('input')].at(-1)`, "Pilot resumed for the removal check"));
  await js(d, `${policyForm}.requestSubmit()`);
  await waitFor(d, `/Website tracking:\\s*On/.test(document.body.innerText)`, "policy on again");
  await js(e, `document.querySelector('#web-connect').click()`);
  await waitFor(e, `/^[A-Z2-9]{8}$/.test(document.querySelector('#web-code').textContent)`, "second code");
  const code2 = await js(e, `document.querySelector('#web-code').textContent`);
  await cdp("Page.reload", {}, pop.sessionId);
  await waitFor(pop, `!document.querySelector('#connect').hidden`, "popup reconnect form");
  await js(pop, `(() => { const f = document.querySelector('#connect'); f.code.value = ${JSON.stringify(code2)}; f.label.value = 'Chrome (removal check)'; f.requestSubmit(); })()`);
  await waitFor(pop, `document.querySelector('#status').textContent === 'Recording website domain names.'`, "recording again");
  await cdp("Target.activateTarget", { targetId: w.targetId });
  await go(url("before-removal.example.test", "/"), 1800);
  await go("about:blank", 800);
  await tick();
  await cdp("Extensions.uninstall", { id: extId });
  await sleep(1000);
  await go(url("after-removal.example.test", "/"), 2000);
  await go("about:blank", 800);
  await sleep(1000);
  const finalRows = await intervals(ana.id);
  check("extension removed: what it sent before stays; nothing is recorded after removal", finalRows.some((r) => r.domain === "before-removal.example.test") && !finalRows.some((r) => r.domain === "after-removal.example.test"));

  // ---- Isolation ----
  const benUsage = await api(`/websites/me/usage?from=${localDate(Date.now(), "UTC")}&to=${localDate(Date.now(), "UTC")}`, { bearer: ben.bearer });
  check("another employee sees none of Ana's website time", benUsage.status === 200 && benUsage.body.byDomain.length === 0);
  check("employees cannot open admin reports (403)", (await api(`/websites/report?from=${localDate(Date.now(), "UTC")}&to=${localDate(Date.now(), "UTC")}`, { bearer: ana.bearer })).status === 403);
} catch (err) {
  check(`run aborted: ${err.message}`, false);
  if (debugTab) console.log("  extension popup:", await js(debugTab, `chrome.storage.local.get().then((s) => JSON.stringify({ text: document.body.innerText, state: s.lastState, hasToken: !!s.token, queue: (s.queue ?? []).length }))`).catch((e) => String(e)));
} finally {
  chrome.kill();
  vite.kill();
  dash.kill();
  site.close();
  await app.close().catch(() => {});
  await sleep(500);
  rmSync(RUN, { recursive: true, force: true });
}
console.log(`Page captures: ${OUT}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
