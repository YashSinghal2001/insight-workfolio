// Whole web app check (phase 3 QA): every admin and employee page, responsive layout, security
// boundaries, session handling and the new workflows (work schedule, app labels, screenshot deletion,
// organisation export, corrections, leave). Throwaway API (temporary file DB, local screenshot storage)
// on :4000, dashboard production build on :3105, headless Chrome over CDP. Synthetic data only.
// Run after `pnpm build`. Needs Google Chrome (macOS path) and free ports 4000, 3105 and 9345.
// Usage: pnpm --filter @workfolio/dashboard verify:web-app [out-dir]
//
// Direct database writes (documented, test-only):
// - employee_profiles.created_at is backdated 30 days so the daily view counts the seeded people on
//   past dates (it skips anyone who was not an employee yet that day).
// - a work schedule version with effective_at 10 days ago is inserted, because a schedule saved
//   from the page applies only from each employee's next local day; the page-saved version is
//   then checked to apply to tomorrow and not to the past.
// - screenshot policy and monitoring consents are inserted as the other suites do.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = process.argv[2] ?? mkdtempSync(join(tmpdir(), "wf-verify-web-app-"));
const RUN = join(OUT, "run");
rmSync(RUN, { recursive: true, force: true });
mkdirSync(join(RUN, "shots"), { recursive: true });
const APP = "http://localhost:3105";
const API = "http://localhost:4000/api/v1";
Object.assign(process.env, {
  NODE_ENV: "development", LOG_LEVEL: "warn", PORT: "4000",
  DATABASE_URL: `file:${join(RUN, "web.db")}`,
  JWT_SECRET: "web-app-check-secret-web-app-check-secret",
  SCREENSHOT_STORAGE: "local", SCREENSHOT_LOCAL_DIR: join(RUN, "shots"), TIMELAPSE_DIR: join(RUN, "videos"),
  CORS_ORIGINS: APP, REPORT_SCHEDULER_SECONDS: "0",
});
const req = createRequire(`${ROOT}/apps/api/package.json`);
req("reflect-metadata");
const { NestFactory } = req("@nestjs/core");
const dist = (p) => import(`${ROOT}/apps/api/dist/${p}`);
const { AppModule } = await dist("app.module.js");
const { configureApp } = await dist("app.setup.js");
const { DATABASE } = await dist("database/database.module.js");
const { hashPassword } = await dist("auth/crypto.js");
const { DEFAULT_NOTICE_VERSION: ACTIVITY_NOTICE, EXPORT_CONTENT_TYPES, addDays, localDate, zonedToUtc } = await import(`${ROOT}/packages/shared/dist/index.js`);
const SHOT_NOTICE = "2026-10-screenshots-draft-1";
const PASSWORD = "web app check password 1";
const M = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const results = [];
const check = (name, ok, detail = "") => (results.push({ name, ok: !!ok }), console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- API and synthetic data -------------------------------------------------------------------
const app = await NestFactory.create(AppModule, { logger: ["error", "warn"] });
configureApp(app);
await app.listen(4000);
const db = app.get(DATABASE);
const api = async (path, { method = "GET", body, raw, cookie, bearer, device, origin = APP, headers: extra = {} } = {}) => {
  const headers = { ...extra };
  if (origin) headers.origin = origin;
  if (body !== undefined) headers["content-type"] = "application/json";
  if (raw) headers["content-type"] = "image/webp";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (device) headers["x-device-id"] = device;
  const res = await fetch(`${API}${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const buf = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get("content-type") ?? "";
  return { status: res.status, body: buf.length && type.includes("json") ? JSON.parse(buf.toString("utf8")) : undefined, text: buf.toString("utf8"), buf, res };
};
const ok = (r, what) => {
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${r.text.slice(0, 300)}`);
  return r.body;
};
const login = async (email) => (await api("/auth/login", { method: "POST", body: { email, password: PASSWORD } })).res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

const superId = randomUUID();
const itId = randomUUID();
await db.execute({ sql: "INSERT INTO users (id, email, role, admin_title, password_hash) VALUES (?, 'ceo@example.com', 'ADMIN', 'SUPER_ADMIN', ?), (?, 'it@example.com', 'ADMIN', 'ADMIN', ?)", args: [superId, await hashPassword(PASSWORD), itId, await hashPassword(PASSWORD)] });
const superCookie = await login("ceo@example.com");
const itCookie = await login("it@example.com");
await db.execute({
  sql: `INSERT INTO screenshot_policies (screenshots_enabled, mask_regions, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
          retention_approved, notice_version, employee_self_view, reason, changed_by, effective_at) VALUES (1, '[]', 60, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, ?, 1, 'web app check', ?, ?)`,
  args: [SHOT_NOTICE, superId, iso(Date.now() - 2 * 86_400_000)],
});

// Dates. D: a fully past day in every seeded zone (UTC and Asia/Kolkata). "Today" activity sits inside
// a window W that is today in both zones, so the checks do not depend on the hour or weekday of the run.
const NOW = Date.now();
const todayUtc = localDate(NOW, "UTC");
const D = addDays(todayUtc, -2);
const dayStart = Math.max(Date.parse(zonedToUtc(`${localDate(NOW, "Asia/Kolkata")}T00:00`, "Asia/Kolkata")), Date.parse(`${todayUtc}T00:00:00Z`));
const W = Math.max(4 * M, Math.min(110 * M, NOW - dayStart - 2 * M));
const ago = (f) => iso(NOW - f * W);

async function employee(n, name, timezone) {
  const email = `web${n}@example.com`;
  const r = ok(await api("/employees", { method: "POST", cookie: superCookie, body: { email, employeeCode: `WA-${n}`, fullName: name, timezone } }), "employee");
  ok(await api("/auth/setup-password", { method: "POST", body: { token: r.setup.token, password: PASSWORD } }), "setup password");
  const bearer = (await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } })).body.accessToken;
  const e = { id: r.employee.id, userId: r.employee.userId ?? null, email, bearer, device: randomUUID(), tz: timezone, name };
  ok(await api("/devices/register", { method: "POST", bearer, body: { installationId: e.device, deviceName: `${name.split(" ")[0]}'s Mac`, platform: "macos" } }), "device");
  for (const v of [SHOT_NOTICE, ACTIVITY_NOTICE]) await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), e.id, v, iso(NOW - 3 * 86_400_000)] });
  await db.execute({ sql: "UPDATE employee_profiles SET created_at = ? WHERE id = ?", args: [iso(NOW - 30 * 86_400_000), e.id] });
  return e;
}
const sync = async (e, events) => {
  const r = ok(await api("/attendance/sync", { method: "POST", bearer: e.bearer, device: e.device, body: { sentAt: iso(Date.now()), events: events.map(([type, occurredAt]) => ({ id: randomUUID(), type, occurredAt })) } }), "attendance");
  if (!r.results.every((x) => x.status === "ACCEPTED")) throw new Error(`attendance sync: ${JSON.stringify(r)}`);
};
const local = (e, date, hm) => zonedToUtc(`${date}T${hm}`, e.tz);

const ana = await employee(1, "Ana Kolkata", "Asia/Kolkata");
const ben = await employee(2, "Ben Utc", "UTC");
const cara = await employee(3, "Cara Leave", "UTC");
const sam = await employee(4, "Sam Super", "UTC");
const SEEDED_CODES = ["WA-1", "WA-2", "WA-3", "WA-4"];
// D: Ana in on time (09:05 IST), Ben late (10:00 UTC, break 12:00–12:30); Cara on approved leave; Sam nothing.
await sync(ana, [["CLOCK_IN", local(ana, D, "09:05")], ["CLOCK_OUT", local(ana, D, "17:00")], ["CLOCK_IN", ago(1)]]);
await sync(ben, [["CLOCK_IN", local(ben, D, "10:00")], ["BREAK_START", local(ben, D, "12:00")], ["BREAK_END", local(ben, D, "12:30")], ["CLOCK_OUT", local(ben, D, "18:00")], ["CLOCK_IN", ago(1)], ["BREAK_START", ago(0.15)]]);
const caraLeave = ok(await api("/leave", { method: "POST", bearer: cara.bearer, body: { startDate: D, endDate: D, portion: "FULL_DAY", reason: "Synthetic day off" } }), "cara leave");
ok(await api(`/leave/${caraLeave.id}/approve`, { method: "POST", cookie: superCookie, body: {} }), "approve leave");
const benLeave = ok(await api("/leave", { method: "POST", bearer: ben.bearer, body: { startDate: addDays(todayUtc, 20), endDate: addDays(todayUtc, 20), portion: "FULL_DAY", reason: "BEN-PRIVATE-LEAVE" } }), "ben leave");
const benCorr = ok(await api("/attendance/corrections", { method: "POST", bearer: ben.bearer, body: { type: "MISSING_CLOCK_IN", clockInAt: local(ben, addDays(D, -1), "09:00"), clockOutAt: local(ben, addDays(D, -1), "10:00"), reason: "BEN-PRIVATE-CORRECTION" } }), "ben correction");
const activity = (e, rows) =>
  api("/activity/sync", { method: "POST", bearer: e.bearer, device: e.device, body: { sentAt: iso(Date.now()), platform: "macos", intervals: rows.map(([app, from, to]) => ({ id: randomUUID(), kind: app ? "ACTIVE" : "IDLE", applicationIdentifier: app ? `com.example.${app.replace(/\W/g, "")}` : null, applicationName: app, startedAt: ago(from), endedAt: ago(to) })) } });
ok(await activity(ana, [["Code Editor", 0.9, 0.6], [null, 0.6, 0.5], ["Mail", 0.5, 0.3]]), "ana activity");
ok(await activity(ben, [["Ben Secret App", 0.9, 0.5]]), "ben activity");
const project = ok(await api("/projects", { method: "POST", cookie: superCookie, body: { code: "WEB-1", name: "Web Project", description: "Synthetic project" } }), "project");
ok(await api(`/projects/${project.id}/members`, { method: "POST", cookie: superCookie, body: { employeeId: ana.id } }), "member");
ok(await api(`/projects/${project.id}/tasks`, { method: "POST", cookie: superCookie, body: { title: "Build the page" } }), "task");
// Backdated schedule version (see header): 09:00, 15 min grace, every day.
await db.execute({ sql: "INSERT INTO work_schedule_policies (enabled, expected_start, grace_minutes, workdays, reason, changed_by, effective_at) VALUES (1, '09:00', 15, '1234567', 'web app check (backdated)', ?, ?)", args: [superId, iso(NOW - 10 * 86_400_000)] });

// ---- Chrome over CDP -------------------------------------------------------------------------
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--remote-debugging-port=9345", `--user-data-dir=${join(RUN, "chrome")}`, "--window-size=1440,1000", "--no-first-run", "about:blank"], { stdio: "ignore" });
let target;
for (let i = 0; i < 150 && !target; i++) {
  await sleep(200);
  target = await fetch("http://127.0.0.1:9345/json/new?about:blank", { method: "PUT" }).then((r) => r.json(), () => null);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pending = new Map();
const consoleErrors = [];
const apiFailures = [];
const requests = new Map();
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);
  if (msg.method === "Runtime.consoleAPICalled" && ["error", "assert"].includes(msg.params.type)) consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
  if (msg.method === "Runtime.exceptionThrown") consoleErrors.push(`uncaught: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
  if (msg.method === "Network.requestWillBeSent") requests.set(msg.params.requestId, `${msg.params.request.method} ${msg.params.request.url}`);
  if (msg.method === "Network.responseReceived" && msg.params.response.url.startsWith(API) && msg.params.response.status >= 400) apiFailures.push(`${msg.params.response.status} ${requests.get(msg.params.requestId)?.split(" ")[0] ?? ""} ${msg.params.response.url.slice(API.length)}`);
  if (msg.method === "Network.loadingFailed" && !msg.params.canceled && (requests.get(msg.params.requestId) ?? "").includes(API)) apiFailures.push(`failed ${requests.get(msg.params.requestId)} ${msg.params.errorText}`);
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
const waitFor = async (expr, label, ms = 20_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(120)) if (await js(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${label}`);
};
const tryWait = (expr, label, ms) => waitFor(expr, label, ms).then(() => true, () => false);
const shot = async (name) => writeFileSync(join(OUT, name), Buffer.from((await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true })).data, "base64"));
await cdp("Page.enable");
await cdp("Runtime.enable");
await cdp("Network.enable");
// Admin pages use the browser's zone: pin it so "today" is the same as the API's UTC dates.
await cdp("Emulation.setTimezoneOverride", { timezoneId: "UTC" });
const DOWNLOADS = join(RUN, "downloads");
mkdirSync(DOWNLOADS);
await cdp("Page.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOADS });

/** Synthetic WebP from a canvas (no real screen). */
const webp = async (n) => Buffer.from(await js(`(async () => {
  const c = document.createElement("canvas"); c.width = 640; c.height = 360; const g = c.getContext("2d");
  g.fillStyle = "hsl(${(n * 67) % 360} 70% 75%)"; g.fillRect(0, 0, 640, 360); g.fillStyle = "#000"; g.font = "bold 40px sans-serif"; g.fillText("SYNTHETIC ${n}", 40, 200);
  const b = await new Promise((r) => c.toBlob(r, "image/webp", 0.8)); const u = new Uint8Array(await b.arrayBuffer());
  let s = ""; for (const x of u) s += String.fromCharCode(x); return btoa(s);
})()`), "base64");
async function upload(e, f, n) {
  const bytes = await webp(n);
  const id = randomUUID();
  const reg = await api("/screenshots/register", { method: "POST", bearer: e.bearer, device: e.device, body: { id, capturedAt: ago(f), sentAt: iso(Date.now()), width: 640, height: 360, sizeBytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), mimeType: "image/webp" } });
  if (reg.body?.status !== "REGISTERED") throw new Error(`register: ${reg.text}`);
  ok(await api(`/screenshots/${id}/content`, { method: "PUT", bearer: e.bearer, device: e.device, raw: bytes }), "screenshot content");
  return (await db.execute({ sql: "SELECT id FROM screenshots WHERE idempotency_key = ?", args: [id] })).rows[0].id;
}
const anaShots = [];
for (const [i, f] of [0.5, 0.4, 0.3].entries()) anaShots.push(await upload(ana, f, i));
const benShot = await upload(ben, 0.6, 9);

const dash = spawn("pnpm", ["exec", "next", "start", "--port", "3105"], { cwd: `${ROOT}/apps/dashboard`, stdio: "ignore" });
for (let i = 0; i < 150 && !(await fetch(`${APP}/login`).then((r) => r.ok, () => false)); i++) await sleep(200);

// ---- Page helpers ------------------------------------------------------------------------------
// Visible loading indicators only (a status inside a closed <details> is not shown or announced).
const LOADED = `![...document.querySelectorAll('[role=status]')].some((e) => e.checkVisibility() && /^\\s*Loading/.test(e.textContent)) && !/Loading…/.test(document.querySelector('main')?.innerText ?? '')`;
/** Navigates; waits for the heading and for every section to finish loading. Returns { loaded }. */
async function go(path, { wait = true } = {}) {
  const [p, q = ""] = path.split("?");
  await cdp("Page.navigate", { url: `${APP}${path}` });
  await waitFor(`location.pathname === ${JSON.stringify(p)} && location.search === ${JSON.stringify(q ? `?${q}` : "")} && !!document.querySelector('main h1')`, `${path} heading`);
  return { loaded: wait ? await tryWait(LOADED, `${path} loaded`, 20_000) : true };
}
const text = () => js(`document.querySelector('main').innerText`);
const table = (label) => js(`document.querySelector('table[aria-label=${JSON.stringify(label)}]')?.innerText ?? null`);
const setReact = (sel, value) => `(() => { const el = ${sel}; const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); })()`;
const click = (sel) => js(`(() => { const el = ${sel}; if (!el) throw new Error("not found: " + ${JSON.stringify(sel)}); el.click(); return true; })()`);
const buttonByText = (scope, label) => `[...${scope}.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;
async function signIn(email) {
  await cdp("Network.clearBrowserCookies");
  await cdp("Page.navigate", { url: `${APP}/login` });
  await waitFor(`(() => { const f = document.querySelector('form'); return !!f && Object.keys(f).some((k) => k.startsWith('__reactProps')); })()`, "login form");
  await js(`(() => { const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
    set(document.querySelector('input[type=email], input[name=email]'), ${JSON.stringify(email)}); set(document.querySelector('input[type=password]'), ${JSON.stringify(PASSWORD)}); document.querySelector('form').requestSubmit(); })()`);
}
/** Page quality: one h1, no href="#", every button named. */
const pageIssues = () => js(`(() => {
  const issues = [];
  const h1 = document.querySelectorAll('h1').length;
  if (h1 !== 1) issues.push(h1 + ' h1');
  const hash = document.querySelectorAll('[href="#"]').length;
  if (hash) issues.push(hash + ' href="#"');
  const name = (b) => (b.getAttribute('aria-label') || (b.getAttribute('aria-labelledby') || '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join('') || b.textContent || b.title || '').trim();
  const unnamed = [...document.querySelectorAll('button')].filter((b) => !name(b));
  if (unnamed.length) issues.push(unnamed.length + ' unnamed button(s): ' + unnamed.slice(0, 2).map((b) => b.outerHTML.slice(0, 80)).join(' | '));
  return issues;
})()`);
/** Standard page checks, one PASS/FAIL line per route. No API failure is expected on any page. */
async function auditRoutes(routes, who) {
  for (const path of routes) {
    consoleErrors.length = 0;
    apiFailures.length = 0;
    let issues;
    try {
      const { loaded } = await go(path);
      await sleep(250);
      issues = await pageIssues();
      if (!loaded) issues.push("still loading");
    } catch (err) {
      issues = [String(err.message ?? err)];
    }
    if (consoleErrors.length) issues.push(`console: ${consoleErrors.slice(0, 2).join(" || ").slice(0, 200)}`);
    if (apiFailures.length) issues.push(`API: ${apiFailures.slice(0, 3).join(", ")}`);
    check(`${who} ${path.replace(ana.id, "[id]")}: loads fully, one h1, no href="#", named buttons, no console errors, no failed API calls`, issues.length === 0, issues.join("; "));
  }
}
const statCard = (label) => js(`(() => { const p = [...document.querySelectorAll('main p')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); const card = p?.parentElement; return card ? { value: card.children[1]?.textContent.trim(), all: card.innerText } : null; })()`);
async function downloaded(ext) {
  for (let i = 0; i < 100; i++) {
    const f = readdirSync(DOWNLOADS).find((x) => x.endsWith(ext));
    if (f && statSync(join(DOWNLOADS, f)).size > 0) return readFileSync(join(DOWNLOADS, f));
    await sleep(100);
  }
  return null;
}

const ADMIN_ROUTES = ["/", "/employees", "/employees/new", `/employees/${ana.id}`, "/attendance", "/attendance?view=daily", "/timesheets", `/timesheets/${ana.id}`, "/corrections", "/leave", "/activity", "/websites", "/screenshots", "/projects", "/reports", "/roles", "/audit", "/settings", "/settings/schedule", "/settings/monitoring", "/settings/screenshots", "/settings/labels", "/settings/websites", "/settings/storage", "/settings/notifications", "/settings/leave-types", "/account"];
const MY_ROUTES = ["/my", "/my/attendance", "/my/activity", "/my/websites", "/my/screenshots", "/my/projects", "/my/tasks", "/my/leave", "/my/reports", "/my/profile"];
const RESPONSIVE_ADMIN = ["/", "/attendance?view=daily", "/timesheets", "/reports/scheduled", "/screenshots", "/settings/schedule", "/settings/monitoring", "/settings/screenshots", "/settings/notifications", "/settings/labels", "/audit", `/employees/${ana.id}`];
const RESPONSIVE_MY = ["/my", "/my/attendance", "/my/leave", "/my/reports", "/my/profile"];
const WIDTHS = [1440, 1024, 768, 375, 360];
const responsive = {};

async function responsiveRoutes(routes, navId) {
  for (const w of WIDTHS) {
    await cdp("Emulation.setDeviceMetricsOverride", { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 768 });
    // Sidebar from 1024 px (lg); below it the Menu button opens a drawer.
    for (const path of routes) {
      const key = path.replace(ana.id, "[id]");
      let cell;
      try {
        await go(path);
        await sleep(200);
        // Against the emulated width itself: a mobile viewport can grow innerWidth to fit wide content.
        const r = await js(`({ sw: document.documentElement.scrollWidth, iw: ${w} })`);
        const issues = [];
        if (r.sw > r.iw) {
          // Name the outermost elements that stick out, to make the failure actionable.
          const culprits = await js(`[...document.querySelectorAll('body *')].filter((e) => { if (e.getBoundingClientRect().right <= ${w} + 1) return false; if (/absolute|fixed/.test(getComputedStyle(e).position)) return true; for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) if (getComputedStyle(a).overflowX !== 'visible') return false; return true; }).filter((e, _, all) => !all.includes(e.parentElement)).slice(0, 3).map((e) => e.tagName.toLowerCase() + '.' + String(e.className).split(' ').slice(0, 4).join('.') + ' "' + e.textContent.trim().slice(0, 30) + '"').join(' ; ')`);
          issues.push(`scroll ${r.sw}>${r.iw} [${culprits}]`);
        }
        if (w >= 1024) {
          if (!(await js(`(() => { const n = document.getElementById(${JSON.stringify(navId)}); const b = n?.getBoundingClientRect(); return !!n && getComputedStyle(n).display !== 'none' && b.width > 0 && b.left >= 0; })()`))) issues.push("sidebar hidden");
          if (await js(`(() => { const b = document.querySelector('button[aria-controls=${JSON.stringify(navId)}]'); return !!b && getComputedStyle(b).display !== 'none'; })()`)) issues.push("menu button shown");
        } else {
          const hidden = await js(`getComputedStyle(document.getElementById(${JSON.stringify(navId)})).display === 'none'`);
          await click(`document.querySelector('button[aria-controls=${JSON.stringify(navId)}]')`);
          await waitFor(`getComputedStyle(document.getElementById(${JSON.stringify(navId)})).display !== 'none'`, "drawer open", 5000);
          const reach = await js(`(() => { const n = document.getElementById(${JSON.stringify(navId)}); const links = [...n.querySelectorAll('a')];
            return { n: links.length, ok: links.every((a) => { a.scrollIntoView({ block: 'nearest' }); const b = a.getBoundingClientRect(); return b.width > 0 && b.left >= 0 && b.right <= ${w} && b.top >= 0 && b.bottom <= innerHeight; }) }; })()`);
          if (!hidden) issues.push("nav visible before Menu");
          if (!reach.n || !reach.ok) issues.push(`drawer links unreachable (${reach.n})`);
          await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
          await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
          if (!(await tryWait(`getComputedStyle(document.getElementById(${JSON.stringify(navId)})).display === 'none'`, "drawer closed", 3000))) issues.push("Escape did not close drawer");
        }
        cell = issues.length ? `FAIL: ${issues.join(", ")}` : "ok";
      } catch (err) {
        cell = `FAIL: ${String(err.message ?? err).slice(0, 80)}`;
      }
      (responsive[key] ??= {})[w] = cell;
    }
  }
  await cdp("Emulation.clearDeviceMetricsOverride");
}

let csvText = null;
try {
  // =========================== d. Security (API level) ===========================================
  const users = ok(await api("/roles/users", { cookie: superCookie }), "role users");
  const uid = (e) => users.find((u) => u.employee?.id === e.id).id;
  const reason = { reason: "web app security check" };
  check("security: Admin cannot grant Super Admin (403)", (await api(`/roles/users/${uid(ben)}`, { method: "PATCH", cookie: itCookie, body: { platformRole: "SUPER_ADMIN", ...reason } })).status === 403);
  const grant = await api(`/roles/users/${uid(sam)}`, { method: "PATCH", cookie: superCookie, body: { platformRole: "SUPER_ADMIN", ...reason } });
  check("security: Super Admin can grant Super Admin (200)", grant.status === 200 && grant.body.platformRole === "SUPER_ADMIN", String(grant.status));
  const samDevice = ok(await api(`/employees/${sam.id}/devices`, { cookie: superCookie }), "sam devices");
  const samDeviceId = (samDevice.items ?? samDevice)[0].id;
  const adminOnSuper = [
    (await api(`/roles/users/${uid(sam)}`, { method: "PATCH", cookie: itCookie, body: { platformRole: "ADMIN", ...reason } })).status,
    (await api(`/employees/${sam.id}`, { method: "PATCH", cookie: itCookie, body: { fullName: "Sam Hijacked" } })).status,
    (await api(`/employees/${sam.id}/status`, { method: "PATCH", cookie: itCookie, body: { status: "DISABLED" } })).status,
    (await api(`/devices/${samDeviceId}/revoke`, { method: "POST", cookie: itCookie })).status,
    (await api(`/employees/${sam.id}/setup-token`, { method: "POST", cookie: itCookie })).status,
  ];
  check("security: Admin cannot demote, edit, disable, re-invite or revoke the device of a Super Admin (all 403)", adminOnSuper.every((s) => s === 403), JSON.stringify(adminOnSuper));
  const superOnSuper = [
    (await api(`/employees/${sam.id}`, { method: "PATCH", cookie: superCookie, body: { fullName: "Sam Super" } })).status,
    (await api(`/employees/${sam.id}/status`, { method: "PATCH", cookie: superCookie, body: { status: "DISABLED" } })).status,
    (await api(`/employees/${sam.id}/status`, { method: "PATCH", cookie: superCookie, body: { status: "ACTIVE" } })).status,
    (await api(`/devices/${samDeviceId}/revoke`, { method: "POST", cookie: superCookie })).status,
  ];
  check("security: Super Admin can edit, disable/enable and revoke the device of a Super Admin (all 2xx)", superOnSuper.every((s) => s >= 200 && s < 300), JSON.stringify(superOnSuper));
  check("security: Admin still manages ordinary employees (edit Ben → 200)", (await api(`/employees/${ben.id}`, { method: "PATCH", cookie: itCookie, body: { fullName: "Ben Utc" } })).status === 200);

  const anaCookie = await login(ana.email);
  const from = addDays(D, -3);
  const swaps = {
    timesheet: `/attendance/timesheet?employeeId=${ben.id}&from=${from}&to=${todayUtc}`,
    history: `/attendance/history?employeeId=${ben.id}`,
    activitySummary: `/activity/summary?employeeId=${ben.id}&from=${from}&to=${todayUtc}`,
    activityTimeline: `/activity/timeline?employeeId=${ben.id}&from=${from}&to=${todayUtc}`,
    screenshotList: `/screenshots?employeeId=${ben.id}`,
    screenshot: `/screenshots/${benShot}`,
    screenshotContent: `/screenshots/${benShot}/content?variant=thumbnail`,
    leave: `/leave/${benLeave.id}`,
    leaveList: `/leave?employeeId=${ben.id}`,
    correction: `/attendance/corrections/${benCorr.id}`,
    correctionList: `/attendance/corrections?employeeId=${ben.id}`,
  };
  const SPOOF = { "x-role": "ADMIN", "x-user-id": superId, "x-employee-id": ben.id, "x-platform-role": "SUPER_ADMIN" };
  const plain = {};
  const spoofed = {};
  for (const [k, p] of Object.entries(swaps)) {
    const a = await api(p, { cookie: anaCookie });
    const b = await api(p, { cookie: anaCookie, headers: SPOOF });
    plain[k] = a.status;
    spoofed[k] = b.status;
    if (/BEN-PRIVATE|Ben Utc|Ben Secret/.test(a.text + b.text)) plain[k] = `LEAK ${a.status}`;
  }
  check("security: Ana cannot read Ben's timesheet, history, activity, screenshots, leave or corrections by id swap (404)", Object.values(plain).every((s) => s === 404), JSON.stringify(plain));
  check("security: spoofed x-role / x-user-id / x-employee-id headers change nothing", JSON.stringify(plain) === JSON.stringify(spoofed), JSON.stringify(spoofed));
  const mineSpoof = await api("/attendance/current", { cookie: anaCookie, headers: SPOOF });
  const adminSpoof = await api("/employees", { cookie: anaCookie, headers: SPOOF });
  check("security: spoofed headers neither grant admin APIs (403) nor switch the employee (own data only)", adminSpoof.status === 403 && mineSpoof.status === 200 && !mineSpoof.text.includes(ben.id), `${adminSpoof.status}/${mineSpoof.status}`);
  const unauth = await Promise.all([`/screenshots/${anaShots[0]}/content`, `/screenshots/${anaShots[0]}/content?variant=thumbnail`, `/attendance/timesheets/export?from=${D}&to=${todayUtc}&format=csv`, "/employees", "/attendance/summary"].map(async (p) => (await api(p, { origin: null })).status));
  check("security: unauthenticated content, export and admin URLs → 401", unauth.every((s) => s === 401), JSON.stringify(unauth));
  const exportUrl = (format) => `/attendance/timesheets/export?from=${D}&to=${todayUtc}&format=${format}`;
  check("security: org export as an employee → 403", (await api(exportUrl("csv"), { cookie: anaCookie })).status === 403);
  const csrf = [
    (await api("/leave", { method: "POST", cookie: anaCookie, origin: "https://evil.example", body: {} })).status,
    (await api("/leave", { method: "POST", cookie: anaCookie, origin: null, body: {} })).status,
    (await api(`/screenshots/${anaShots[2]}`, { method: "DELETE", cookie: superCookie, origin: "https://evil.example", body: { reason: "csrf attempt" } })).status,
    (await api("/leave", { method: "POST", cookie: anaCookie, body: {} })).status,
  ];
  check("security: CSRF — cookie POST/DELETE from a foreign or missing Origin → 403; the allowed Origin reaches validation (400)", csrf[0] === 403 && csrf[1] === 403 && csrf[2] === 403 && csrf[3] === 400, JSON.stringify(csrf));

  // =========================== b. Employee panel (Ana) ===========================================
  await signIn(ana.email);
  await waitFor(`location.pathname === '/my' && !!document.querySelector('main h1')`, "employee lands on /my");
  await auditRoutes(MY_ROUTES, "employee page");
  const nav = await js(`(() => { const n = document.querySelector('nav[aria-label="My workspace"]'); return { links: [...(n?.querySelectorAll('a') ?? [])].map((a) => a.getAttribute('href')), admin: !!document.querySelector('nav[aria-label="Main"]') }; })()`);
  check("employee nav: exactly the 10 /my links, no admin navigation", nav.links.length === 10 && nav.links.every((h) => h.startsWith("/my")) && !nav.admin, nav.links.join(","));
  const notRedirected = [];
  for (const p of ADMIN_ROUTES) {
    await cdp("Page.navigate", { url: `${APP}${p}` });
    if (!(await tryWait(`location.pathname === '/my' && !!document.querySelector('main h1')`, `${p} → /my`, 15_000))) notRedirected.push(p);
  }
  check("employee: every admin route redirects to /my", notRedirected.length === 0, notRedirected.join(", "));
  const adminApis = await js(`Promise.all([["GET", "/employees"], ["GET", "/attendance/summary"], ["GET", "/attendance/daily?date=${D}"], ["GET", "/attendance/timesheets/export?from=${D}&to=${todayUtc}&format=csv"], ["DELETE", "/screenshots/${anaShots[0]}"], ["GET", "/settings/schedule"], ["PUT", "/settings/schedule"], ["GET", "/activity/categories"], ["POST", "/activity/categories"], ["GET", "/roles/users"], ["GET", "/audit?from=${D}&to=${todayUtc}"]].map(([m, p]) => fetch("${API}" + p, { method: m, credentials: "include", headers: m === "GET" ? {} : { "content-type": "application/json" }, body: m === "GET" ? undefined : JSON.stringify({ reason: "employee attempt" }) }).then((r) => r.status)))`);
  check("employee: admin APIs refuse the employee's browser session (403)", adminApis.every((s) => s === 403), JSON.stringify(adminApis));

  // f. Correction request from the employee page (Ana's zone: Asia/Kolkata).
  await go("/my/attendance");
  const cf = `document.querySelector('form[aria-label="Request a correction"]')`;
  await js(setReact(`${cf}.querySelector('select')`, "MISSING_CLOCK_IN"));
  await waitFor(`${cf}.querySelectorAll('input[type="datetime-local"]').length === 2`, "missing-shift fields");
  const corrDay = addDays(D, -1);
  await js(setReact(`${cf}.querySelectorAll('input[type="datetime-local"]')[0]`, `${corrDay}T18:00`));
  await js(setReact(`${cf}.querySelectorAll('input[type="datetime-local"]')[1]`, `${corrDay}T19:00`));
  await js(setReact(`${cf}.querySelector('textarea')`, "Web app check: evening shift not recorded"));
  await js(`${cf}.requestSubmit()`);
  const corrShown = await tryWait(`/Missing shift/.test(document.querySelector('table[aria-label="My correction requests"]')?.innerText ?? '')`, "correction listed");
  const mine = ok(await api("/attendance/corrections?mine=true", { cookie: anaCookie }), "my corrections");
  const anaCorr = mine.items.find((c) => c.type === "MISSING_CLOCK_IN");
  check("workflow: employee submits a correction (times converted from Asia/Kolkata to UTC) and sees it listed", corrShown && anaCorr?.proposed.clockInAt === zonedToUtc(`${corrDay}T18:00`, "Asia/Kolkata") && anaCorr.status === "PENDING", JSON.stringify(anaCorr?.proposed));

  // f. Leave: create and cancel.
  await go("/my/leave");
  const lf = `document.querySelector('form[aria-label="New leave request"]')`;
  const leaveDate = addDays(todayUtc, 30);
  await js(setReact(`${lf}.querySelector('input[type=date]')`, leaveDate));
  await js(setReact(`${lf}.querySelectorAll('input[type=date]')[1]`, leaveDate));
  await js(setReact(`${lf}.querySelector('textarea')`, "Web app check leave"));
  await js(`${lf}.requestSubmit()`);
  const created = await tryWait(`/Pending/i.test([...document.querySelectorAll('table[aria-label="My leave requests"] tbody tr')].find((r) => r.innerText.includes('Web app check leave'))?.innerText ?? '')`, "new leave pending");
  const row = `[...document.querySelectorAll('table[aria-label="My leave requests"] tbody tr')].find((r) => r.innerText.includes('Web app check leave'))`;
  await click(buttonByText(row, "Cancel"));
  await waitFor(`!!${buttonByText(row, "Yes, cancel")}`, "inline confirmation");
  await click(buttonByText(row, "Yes, cancel"));
  const cancelled = await tryWait(`/cancel/i.test(${row}?.innerText ?? '') && !${buttonByText(row, "Cancel")}`, "cancelled");
  const myLeave = ok(await api("/leave?mine=true", { cookie: anaCookie }), "my leave").items.find((l) => l.reason === "Web app check leave");
  check("workflow: employee creates a leave request (pending) and cancels it", created && cancelled && myLeave?.status === "CANCELLED", myLeave?.status);

  // e. Sign out → protected pages go to /login.
  await go("/my");
  await click(buttonByText("document.querySelector('header')", "Sign out"));
  await waitFor(`location.pathname === '/login'`, "signed out");
  await cdp("Page.navigate", { url: `${APP}/my/attendance` });
  const outMy = await tryWait(`location.pathname === '/login'`, "/my after sign-out");
  await cdp("Page.navigate", { url: `${APP}/timesheets` });
  const outAdmin = await tryWait(`location.pathname === '/login'`, "admin page after sign-out");
  check("session: sign out → protected employee and admin pages redirect to /login", outMy && outAdmin);

  // e. Session ended elsewhere: a second session revokes all the others, then the page's next request ends it.
  await signIn(ana.email);
  await waitFor(`location.pathname === '/my' && !!document.querySelector('main h1')`, "signed in again");
  await go("/my");
  const other = await login(ana.email);
  const revoked = await api("/auth/sessions/revoke-others", { method: "POST", cookie: other });
  await click(`document.querySelector('nav[aria-label="My workspace"] a[href="/my/attendance"]')`);
  const expired = await tryWait(`location.pathname === '/login' && location.search === '?expired=1' && /Your session has ended/.test(document.body.innerText)`, "expired redirect");
  check("session: revoked server-side → next data request redirects to /login?expired=1 with 'Your session has ended'", revoked.status === 200 && revoked.body.revoked >= 1 && expired, `revoked ${revoked.body?.revoked}; at ${await js("location.pathname + location.search")}`);

  // =========================== a. Admin pages (Super Admin, Admin) ===============================
  for (const [email, label] of [["ceo@example.com", "Super Admin"], ["it@example.com", "Admin"]]) {
    await signIn(email);
    await waitFor(`location.pathname === '/' && !!document.querySelector('nav[aria-label="Main"]')`, `${label} overview`);
    await auditRoutes(ADMIN_ROUTES, `${label} page`);

    // Super Admin-only controls are offered to the Super Admin and not to the Admin (IT); the API refuses them anyway.
    const isSuper = label === "Super Admin";
    const rolesLink = await js(`!!document.querySelector('nav[aria-label="Main"] a[href="/roles"]')`);
    await go("/roles");
    const rolesPage = await tryWait(isSuper ? `!!document.querySelector('table[aria-label="Accounts and roles"]')` : `/Only a Super Admin can view or change roles/.test(document.querySelector('main').innerText)`, "roles page", 8000);
    await go("/screenshots");
    await js(setReact(`document.querySelector('main input[type=date]')`, addDays(todayUtc, -3)));
    await waitFor(`[...document.querySelectorAll('section[aria-label="Screenshot gallery"] li img')].length > 0`, "thumbnails");
    await click(`[...document.querySelectorAll('section[aria-label="Screenshot gallery"] li button')].find((b) => !b.disabled)`);
    await waitFor(`document.querySelector('dialog[aria-label^="Screenshot of"]')?.open`, "viewer");
    const deleteOffered = await js(`!!${buttonByText(`document.querySelector('dialog[aria-label^="Screenshot of"]')`, "Delete screenshot")}`);
    await js(`document.querySelectorAll('dialog[open]').forEach((d) => d.close())`);
    await go("/settings");
    await waitFor(`/In force now/.test(document.querySelector('main').innerText)`, "in-force summary");
    // Retention lives on two settings sub-pages: activity (Monitoring & notices) and screenshots.
    const locked = [];
    for (const sub of ["/settings/monitoring", "/settings/screenshots"]) {
      await go(sub);
      await waitFor(`document.querySelectorAll('main input[name=retentionDays]').length === 1`, `retention input on ${sub}`);
      locked.push(await js(`[...document.querySelectorAll('main input[name=retentionDays], main input[name=retentionApproved]')].map((i) => i.disabled).join()`));
    }
    const retentionLocked = locked.join();
    check(`roles: ${label} sees the retention inputs ${isSuper ? "enabled" : "disabled"} in Settings`, retentionLocked === Array(4).fill(String(!isSuper)).join(), retentionLocked);
    check(`roles: ${label} ${isSuper ? "is" : "is not"} offered the Roles link, the roles table and "Delete screenshot"; Settings shows what is in force`,
      rolesLink === isSuper && rolesPage && deleteOffered === isSuper, `link ${rolesLink}, page ${rolesPage}, delete ${deleteOffered}`);
  }

  // =========================== f. Workflows as Super Admin ======================================
  await signIn("ceo@example.com");
  await waitFor(`location.pathname === '/' && !!document.querySelector('nav[aria-label="Main"]')`, "super overview");

  // Theme: light by default; the explicit Dark choice applies at once, survives a reload (pre-paint), and Light restores it.
  const themeOf = () => js(`({ theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor, pressed: document.querySelector('[data-testid="theme-toggle"]')?.getAttribute('aria-pressed') })`);
  await js(`localStorage.removeItem('iw-theme')`);
  await go("/");
  const light = await themeOf();
  await click(`document.querySelector('[data-testid="theme-toggle"]')`);
  const dark = await themeOf();
  await go("/attendance");
  const reloaded = await themeOf();
  await click(`document.querySelector('[data-testid="theme-toggle"]')`);
  const back = await themeOf();
  check("theme: light by default; Dark toggles, persists across reload, Light restores",
    light.theme === "light" && light.pressed === "false" && dark.theme === "dark" && dark.pressed === "true" && dark.bg !== light.bg &&
    reloaded.theme === "dark" && reloaded.pressed === "true" && back.theme === "light" && back.bg === light.bg && (await js(`localStorage.getItem('iw-theme')`)) === "light",
    JSON.stringify({ light, dark, reloaded, back }));

  // Work schedule saved from the page: 11:00 + 15, every day. Applies from the next local day only.
  await go("/settings/schedule");
  const sf = `document.querySelector('main form')`;
  await js(`(() => { const c = ${sf}.querySelector('input[name=enabled]'); if (!c.checked) c.click(); })()`);
  await js(setReact(`${sf}.querySelector('input[name=expectedStart]')`, "11:00"));
  await js(setReact(`${sf}.querySelector('input[name=graceMinutes]')`, "15"));
  await js(`[...${sf}.querySelectorAll('fieldset input[type=checkbox]')].forEach((c) => { if (!c.checked) c.click(); })`);
  await js(setReact(`${sf}.querySelector('textarea[name=reason]')`, "Web app check: start at 11:00"));
  await sleep(100);
  await js(`${sf}.requestSubmit()`);
  const saved = await tryWait(`/Saved\\. The new schedule applies/.test(document.querySelector('main').innerText) && /11:00/.test(document.querySelector('table[aria-label="Work schedule history"]')?.innerText ?? '')`, "schedule saved");
  const sched = ok(await api("/settings/schedule", { cookie: superCookie }), "schedule");
  check("workflow: admin saves an enabled work schedule; history lists it", saved && sched.current.enabled && sched.current.expectedStart === "11:00" && sched.current.workdays === "1234567" && sched.history.length === 2, JSON.stringify(sched.current));

  await go("/attendance?tab=daily");
  // Daily follows the global date filter in the top bar (W2-ATTENDANCE-UI).
  await waitFor(`!!document.querySelector('input[type=date][aria-label=Date]')`, "global date filter");
  await js(setReact(`document.querySelector('input[type=date][aria-label=Date]')`, D));
  await waitFor(`document.querySelector('input[type=date][aria-label=Date]').value === ${JSON.stringify(D)}`, "date set");
  await waitFor(`(document.querySelector('table[aria-label="Daily attendance"]')?.innerText ?? '').includes('Cara Leave')`, "daily table");
  const statusOf = (name) => js(`(() => { const r = [...document.querySelectorAll('table[aria-label="Daily attendance"] tbody tr')].find((x) => x.innerText.includes(${JSON.stringify(name)})); return r ? [...r.cells].map((c) => c.innerText.trim()) : null; })()`);
  const [anaRow, benRow, caraRow, samRow] = [await statusOf("Ana Kolkata"), await statusOf("Ben Utc"), await statusOf("Cara Leave"), await statusOf("Sam Super")];
  check(`workflow: daily view for ${D} (backdated 09:00+15 version): Ana Present (09:05 IST), Ben Late 60 min, Cara On leave, Sam Absent`,
    anaRow?.[1] === "Present" && /09:05/.test(anaRow[2]) && benRow?.[1] === "Late" && benRow[3] === "60 min" && caraRow?.[1] === "On leave" && /Approved leave/.test(caraRow[4]) && samRow?.[1] === "Absent",
    JSON.stringify([anaRow, benRow, caraRow, samRow]));
  check("workflow: daily status counts match the rows", /Present: 1/.test(await text()) && /Late: 1/.test(await text()) && /On leave: 1/.test(await text()) && /Absent: 1/.test(await text()));
  const tomorrow = ok(await api(`/attendance/daily?date=${addDays(todayUtc, 1)}`, { cookie: superCookie }), "daily tomorrow");
  const benTomorrow = tomorrow.items.find((r) => r.employee.id === ben.id);
  check("workflow: the page-saved version (11:00) applies from the next local day and not to past days", benTomorrow?.status === "NOT_YET_DUE" && benTomorrow.dueAt === `${addDays(todayUtc, 1)}T11:15:00.000Z`, JSON.stringify(benTomorrow && { s: benTomorrow.status, due: benTomorrow.dueAt }));

  // App label → admin activity and the employee's own activity.
  await go("/settings/labels");
  const af = `document.querySelector('main form')`;
  await js(setReact(`${af}.querySelector('input[name=value]')`, "Code Editor"));
  await js(setReact(`${af}.querySelector('select[name=category]')`, "PRODUCTIVE"));
  await js(`${af}.requestSubmit()`);
  const ruleAdded = await tryWait(`/Code Editor/.test(document.querySelector('table[aria-label="Application label rules"]')?.innerText ?? '') && /Rule added for Code Editor/.test(document.querySelector('main').innerText)`, "rule listed");
  check("workflow: admin adds an application label rule (Code Editor → Productive)", ruleAdded);
  await go(`/activity?employeeId=${ana.id}`);
  await js(setReact(`document.querySelector('main input[type=date]')`, addDays(todayUtc, -3)));
  await waitFor(`document.querySelector('main input[type=date]').value === ${JSON.stringify(addDays(todayUtc, -3))}`, "range from");
  await sleep(300);
  await waitFor(LOADED, "activity reloaded");
  const appsTable = await js(`document.querySelector('table[aria-label="Applications"]')?.innerText ?? ''`);
  const share = await statCard("Productive share of clocked-in time");
  const codeRow = await js(`[...document.querySelectorAll('table[aria-label="Applications"] tbody tr')].find((r) => r.innerText.includes('Code Editor'))?.innerText ?? ''`);
  const mailRow = await js(`[...document.querySelectorAll('table[aria-label="Applications"] tbody tr')].find((r) => r.innerText.includes('Mail'))?.innerText ?? ''`);
  check("workflow: /activity shows Code Editor as Productive, Mail Unclassified, and a productive share %", /Productive/.test(codeRow) && /Unclassified/.test(mailRow) && /^\d+%$/.test(share?.value ?? ""), `${share?.value} | ${appsTable.slice(0, 160).replace(/\n/g, " | ")}`);

  // Screenshot deletion through the viewer and ConfirmDialog.
  await go("/screenshots");
  await js(setReact(`document.querySelector('main input[type=date]')`, addDays(todayUtc, -3)));
  await waitFor(`document.querySelectorAll('section[aria-label="Screenshot gallery"] li').length === 4`, "gallery of 4");
  await waitFor(`[...document.querySelectorAll('section[aria-label="Screenshot gallery"] li img')].length === 4`, "thumbnails");
  await click(`[...document.querySelectorAll('section[aria-label="Screenshot gallery"] li button')].find((b) => /Ana Kolkata/.test(b.getAttribute('aria-label')))`);
  await waitFor(`document.querySelector('dialog[aria-label^="Screenshot of Ana"]')?.open && document.querySelector('dialog[aria-label^="Screenshot of Ana"] img')?.naturalWidth > 0`, "viewer");
  await click(buttonByText(`document.querySelector('dialog[aria-label^="Screenshot of Ana"]')`, "Delete screenshot"));
  const confirmForm = `[...document.querySelectorAll('dialog[open] form')].find((f) => /Delete this screenshot/.test(f.innerText))`;
  await waitFor(`!!${confirmForm}`, "confirm dialog");
  const disabledBefore = await js(`${buttonByText(confirmForm, "Delete screenshot")}.disabled`);
  await js(setReact(`${confirmForm}.querySelector('textarea')`, "Web app check: captured by mistake"));
  await waitFor(`!${buttonByText(confirmForm, "Delete screenshot")}.disabled`, "confirm enabled");
  await click(buttonByText(confirmForm, "Delete screenshot"));
  await waitFor(`/Screenshot deleted/.test(document.querySelector('main').innerText)`, "deleted notice");
  const viewerGone = await tryWait(`!document.querySelector('dialog[open]')`, "dialogs closed", 5000);
  if (!viewerGone) await js(`document.querySelectorAll('dialog[open]').forEach((d) => d.close())`);
  await waitFor(`[...document.querySelectorAll('section[aria-label="Screenshot gallery"] li')].some((li) => /Deleted/.test(li.innerText))`, "deleted badge");
  const deleted = (await db.execute({ sql: "SELECT id FROM screenshots WHERE upload_status = 'DELETED'" })).rows.map((r) => String(r.id));
  const gone = deleted.length === 1 ? await api(`/screenshots/${deleted[0]}/content`, { cookie: superCookie }) : { status: 0 };
  check("workflow: admin deletes a screenshot via the viewer's ConfirmDialog (reason required) → gallery shows Deleted, content 410", disabledBefore && deleted.length === 1 && anaShots.includes(deleted[0]) && gone.status === 410, `confirm disabled before reason: ${disabledBefore}; content ${gone.status}; viewer closed: ${viewerGone}`);
  await go("/audit");
  await js(setReact(`[...document.querySelectorAll('main select')][0]`, "SCREENSHOT_DELETION"));
  const audited = await tryWait(`/SCREENSHOT_DELETED/.test(document.querySelector('table[aria-label="Audit events"]')?.innerText ?? '')`, "audit deletion");
  check("workflow: audit page shows the deletion under the Screenshot deletion source", audited);

  // Organisation export (CSV + XLSX) from the page; the same URL fetched with the admin cookie.
  await go("/timesheets");
  await js(setReact(`document.querySelector('main input[type=date]')`, D));
  await waitFor(`document.querySelector('main input[type=date]').value === ${JSON.stringify(D)}`, "export range");
  await waitFor(LOADED, "timesheets reloaded");
  await click(buttonByText("document.querySelector('main')", "Export CSV"));
  const csvNotice = await tryWait(`/Downloaded the CSV draft \\(4 shift row/.test(document.querySelector('main').innerText)`, "csv notice");
  const csvFile = await downloaded(".csv");
  const exportTo = await js(`document.querySelectorAll('main input[type=date]')[1].value`);
  const csvRes = await api(`/attendance/timesheets/export?from=${D}&to=${exportTo}&format=csv&includeInactive=false`, { cookie: superCookie });
  csvText = csvRes.text;
  const lines = csvRes.text.replace(/^﻿/, "").trim().split(/\r?\n/);
  const dataLines = lines.slice(1);
  const onlySeeded = dataLines.every((l) => SEEDED_CODES.some((c) => l.includes(c)));
  check("workflow: org CSV export downloads from the page; same URL as admin → 200 text/csv, header + 4 shift rows (Ana and Ben: completed on D, open today) of seeded employees only",
    csvNotice && !!csvFile && csvRes.status === 200 && csvRes.res.headers.get("content-type") === EXPORT_CONTENT_TYPES.csv && /employee/i.test(lines[0]) && dataLines.length === 4 && onlySeeded && dataLines.filter((l) => l.startsWith(`WA-1,Ana Kolkata,${D},`) || l.startsWith(`WA-2,Ben Utc,${D},`)).every((l) => l.includes(",Completed,")) && dataLines.filter((l) => /,Completed,/.test(l)).length === 2 && dataLines.filter((l) => /,Open: /.test(l)).length === 2 && csvRes.res.headers.get("x-export-rows") === "4" && csvFile.toString("utf8") === csvRes.text,
    `${csvRes.status} ${csvRes.res.headers.get("content-type")} rows=${dataLines.length} file=${!!csvFile}`);
  await click(buttonByText("document.querySelector('main')", "Export XLSX"));
  const xlsxNotice = await tryWait(`/Downloaded the XLSX draft/.test(document.querySelector('main').innerText)`, "xlsx notice");
  const xlsxFile = await downloaded(".xlsx");
  const xlsxRes = await api(`/attendance/timesheets/export?from=${D}&to=${exportTo}&format=xlsx`, { cookie: superCookie });
  check("workflow: org XLSX export downloads; admin fetch → 200 with the XLSX content type and a ZIP (PK) body",
    xlsxNotice && !!xlsxFile && xlsxFile.subarray(0, 2).toString() === "PK" && xlsxRes.status === 200 && xlsxRes.res.headers.get("content-type") === EXPORT_CONTENT_TYPES.xlsx && xlsxRes.buf.subarray(0, 2).toString() === "PK" && xlsxRes.res.headers.get("x-export-rows") === "4",
    `${xlsxRes.status} ${xlsxRes.res.headers.get("content-type")}`);
  check("workflow: org export as Admin (not Super Admin) → 200", (await api(exportUrl("csv"), { cookie: itCookie })).status === 200);

  // Corrections: the employee's request reaches the admin queue.
  await go("/corrections");
  const corrText = await text();
  check("workflow: admin sees Ana's correction request (Missing shift) in /corrections", /Ana Kolkata/.test(corrText) && /Missing shift/.test(corrText) && /Web app check: evening shift not recorded/.test(corrText));

  // Overview stat cards vs. seeded data and the API (W2-OVERVIEW: the page reads /overview for the viewer's date).
  await go("/");
  const viewerDate = await js(`(() => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); })()`);
  const ov = ok(await api(`/overview?date=${viewerDate}`, { cookie: superCookie }), "overview");
  const summary = ov.kpis;
  const todayDaily = ok(await api(`/attendance/daily?date=${viewerDate}&pageSize=1`, { cookie: superCookie }), "daily today");
  // Independent of the aggregate: the existing summary endpoint for the same date.
  const legacy = ok(await api(`/attendance/summary?date=${viewerDate}`, { cookie: superCookie }), "summary");
  await tryWait(`[...document.querySelectorAll('main p')].some((p) => p.textContent.trim() === "Pending corrections")`, "overview cards");
  const cards = {};
  for (const l of ["Active employees", "Working now", "On a break", "Clocked out today", "Not clocked in today", "Screenshots stored today", "Pending leave requests", "Pending corrections", "Late today", "Absent today"]) cards[l] = await statCard(l);
  check("workflow: overview — Working now 1 (Ana), On a break 1 (Ben), 4 active employees, as seeded",
    cards["Working now"]?.value === "1" && cards["On a break"]?.value === "1" && cards["Active employees"]?.value === "4" && summary.workingNow === 1 && summary.onBreak === 1 && summary.totalMembers === 4, JSON.stringify(Object.fromEntries(Object.entries(cards).map(([k, v]) => [k, v?.value]))));
  check("workflow: overview cards equal the API (clocked out, not clocked in, screenshots, pending leave, pending corrections)",
    cards["Clocked out today"]?.value === String(summary.clockedOut) && cards["Not clocked in today"]?.value === String(summary.notStarted) && cards["Screenshots stored today"]?.value === String(summary.screenshotsStored) && cards["Pending leave requests"]?.value === String(ov.pendingApprovals.leave) && cards["Pending corrections"]?.value === String(ov.pendingApprovals.corrections) && ov.pendingApprovals.corrections === 2,
    JSON.stringify(ov.kpis));
  check("workflow: overview cards equal /attendance/summary (independent cross-check of the aggregate)",
    cards["Active employees"]?.value === String(legacy.totalActiveEmployees) && cards["Clocked out today"]?.value === String(legacy.clockedOutToday) && cards["Not clocked in today"]?.value === String(legacy.notClockedInToday) && cards["Screenshots stored today"]?.value === String(legacy.screenshotsStoredToday) && cards["Pending corrections"]?.value === String(legacy.pendingCorrectionCount),
    JSON.stringify(legacy));
  check("workflow: 'Not clocked in today' is not labelled absent; Late/Absent come only from the enabled schedule (and match the daily view)",
    !/^absent/i.test(cards["Not clocked in today"]?.all ?? "absent") && /Not the same as absent/.test(cards["Not clocked in today"]?.all ?? "") && cards["Late today"]?.value === String(todayDaily.summary.LATE) && cards["Absent today"]?.value === String(todayDaily.summary.ABSENT),
    `${cards["Not clocked in today"]?.all?.replace(/\n/g, " | ")} · late ${cards["Late today"]?.value} absent ${cards["Absent today"]?.value}`);
  await shot("overview.png");

  // Employee view of the label (Ana signs in again: her browser session was revoked above).
  await signIn(ana.email);
  await waitFor(`location.pathname === '/my' && !!document.querySelector('main h1')`, "ana again");
  await go("/my/activity");
  const myApps = (await table("My application activity")) ?? "";
  check("workflow: the employee's /my/activity shows the organisation's label (Code Editor: Productive) and productive share", /Code Editor\s+.*Productive/.test(myApps.replace(/\n/g, " ")) && /Productive share/.test(await text()), myApps.slice(0, 160).replace(/\n/g, " | "));

  // =========================== c. Responsive ====================================================
  await responsiveRoutes(RESPONSIVE_MY, "my-nav");
  await signIn("ceo@example.com");
  await waitFor(`location.pathname === '/' && !!document.querySelector('nav[aria-label="Main"]')`, "super again");
  await responsiveRoutes(RESPONSIVE_ADMIN, "admin-nav");
  const bad = Object.entries(responsive).flatMap(([r, ws]) => Object.entries(ws).filter(([, v]) => v !== "ok").map(([w, v]) => `${r}@${w}: ${v}`));
  check(`responsive: ${RESPONSIVE_ADMIN.length + RESPONSIVE_MY.length} routes × ${WIDTHS.join("/")} — no horizontal page scroll; sidebar visible ≥1024; Menu opens a drawer with reachable links at 768/375/360`, bad.length === 0, bad.join(" || "));
} catch (err) {
  check("run aborted", false, String(err?.stack ?? err?.message ?? err).split("\n").slice(0, 3).join(" "));
  await shot("failure.png").catch(() => undefined);
} finally {
  dash.kill();
  chrome.kill();
  await app.close();
}

const routes = Object.keys(responsive);
if (routes.length) {
  console.log(`\nResponsive (route × width):\n${["route".padEnd(24), ...WIDTHS.map((w) => String(w).padEnd(6))].join(" ")}`);
  for (const r of routes) console.log([r.padEnd(24), ...WIDTHS.map((w) => (responsive[r][w] === "ok" ? "ok" : "FAIL").padEnd(6))].join(" "));
}
if (csvText) writeFileSync(join(OUT, "org-export.csv"), csvText);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed${existsSync(OUT) ? ` · artifacts in ${OUT}` : ""}`);
process.exit(failed ? 1 : 0);
