// Web product check: leave summary (admin tab + employee own summary), activity timeline labels,
// per-day productivity bars, the admin /activity tabs (summary charts + overview, per employee, app history, review apps), /risk-users, and the read-only overview
// on /reports. Throwaway API (temporary file DB) on :4000, dashboard production build on :3117,
// headless Chrome over CDP (time zone pinned to UTC). Synthetic data only.
// Run after `pnpm build`. Needs Google Chrome (macOS path) and free ports 4000, 3117 and 9357.
// Usage: pnpm --filter @workfolio/dashboard verify:web-product [out-dir]
// Direct database write (test-only, as in the other suites): the monitoring notice acknowledgement.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = process.argv[2] ?? mkdtempSync(join(tmpdir(), "wf-verify-web-product-"));
const RUN = join(OUT, "run");
rmSync(RUN, { recursive: true, force: true });
mkdirSync(RUN, { recursive: true });
const APP = "http://localhost:3117";
const API = "http://localhost:4000/api/v1";
Object.assign(process.env, {
  NODE_ENV: "development", LOG_LEVEL: "warn", PORT: "4000",
  DATABASE_URL: `file:${join(RUN, "product.db")}`,
  JWT_SECRET: "web-product-check-secret-web-product-check",
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
const { DEFAULT_NOTICE_VERSION, addDays, formatDurationShort, localDate } = await import(`${ROOT}/packages/shared/dist/index.js`);
const PASSWORD = "web product check password 1";
const M = 60_000;
const H = 60 * M;
const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => (results.push({ name, ok: !!ok }), console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`));

// ---- API and synthetic data -------------------------------------------------------------------
const app = await NestFactory.create(AppModule, { logger: ["error", "warn"] });
configureApp(app);
await app.listen(4000);
const db = app.get(DATABASE);
const api = async (path, { method = "GET", body, cookie, bearer, device } = {}) => {
  const headers = { origin: APP };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (device) headers["x-device-id"] = device;
  const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text, res };
};
const ok = (r, what) => {
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${r.text}`);
  return r.body;
};
await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [randomUUID(), await hashPassword(PASSWORD)] });
const admin = (await api("/auth/login", { method: "POST", body: { email: "admin@example.com", password: PASSWORD } })).res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
async function employee(n, name, timezone) {
  const email = `product${n}@example.com`;
  const r = ok(await api("/employees", { method: "POST", cookie: admin, body: { email, employeeCode: `PR-${n}`, fullName: name, timezone } }), "employee");
  ok(await api("/auth/setup-password", { method: "POST", body: { token: r.setup.token, password: PASSWORD } }), "setup");
  const bearer = ok(await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } }), "login").accessToken;
  const e = { id: r.employee.id, email, bearer, device: randomUUID() };
  ok(await api("/devices/register", { method: "POST", bearer, body: { installationId: e.device, deviceName: "Mac", platform: "macos" } }), "device");
  await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), e.id, DEFAULT_NOTICE_VERSION, iso(Date.now() - 24 * H)] });
  return e;
}
const attendance = async (e, events) => {
  const r = ok(await api("/attendance/sync", { method: "POST", bearer: e.bearer, device: e.device, body: { sentAt: iso(Date.now()), events: events.map(([type, at]) => ({ id: randomUUID(), type, occurredAt: iso(at) })) } }), "attendance");
  if (!r.results.every((x) => x.status === "ACCEPTED")) throw new Error(JSON.stringify(r));
};
const interval = (name, start, end) => ({ id: randomUUID(), kind: name ? "ACTIVE" : "IDLE", applicationIdentifier: name ? `com.example.${name}` : null, applicationName: name, startedAt: iso(start), endedAt: iso(end) });
const activity = async (e, list) => {
  const r = ok(await api("/activity/sync", { method: "POST", bearer: e.bearer, device: e.device, body: { sentAt: iso(Date.now()), platform: "macos", intervals: list } }), "activity");
  if (!r.results.every((x) => x.status === "ACCEPTED")) throw new Error(JSON.stringify(r));
};

const ana = await employee(1, "Ana Product", "UTC");
const ben = await employee(2, "Ben Product", "Asia/Kolkata");
// Ana: clocked in 2 h ago (open): Code 60 min, Safari 10 min, idle 20 min, Slack 5 min.
const t0 = Date.now() - 2 * H;
await attendance(ana, [["CLOCK_IN", t0]]);
await activity(ana, [interval("Code", t0, t0 + 60 * M), interval("Safari", t0 + 60 * M, t0 + 70 * M), interval(null, t0 + 70 * M, t0 + 90 * M), interval("Slack", t0 + 90 * M, t0 + 95 * M)]);
// Ben: closed shift with a 1 h break → 1h 30m clocked in, 20 min Code.
const b0 = Date.now() - 3 * H;
await attendance(ben, [["CLOCK_IN", b0], ["BREAK_START", b0 + H], ["BREAK_END", b0 + 2 * H], ["CLOCK_OUT", b0 + 150 * M]]);
await activity(ben, [interval("Code", b0 + 10 * M, b0 + 30 * M)]);
ok(await api("/activity/categories", { method: "POST", cookie: admin, body: { matchKind: "IDENTIFIER", value: "com.example.Code", category: "PRODUCTIVE" } }), "rule code");
ok(await api("/activity/categories", { method: "POST", cookie: admin, body: { matchKind: "NAME", value: "Slack", category: "UNPRODUCTIVE" } }), "rule slack");

// Leave (UTC dates): Ana D+10..12 approved, D+14 first half pending, D+15 short cancelled; Ben D+11 rejected.
const D = localDate(Date.now(), "UTC");
const leave = async (e, body) => ok(await api("/leave", { method: "POST", bearer: e.bearer, body }), "leave").id;
const full = await leave(ana, { startDate: addDays(D, 10), endDate: addDays(D, 12), portion: "FULL_DAY" });
await leave(ana, { startDate: addDays(D, 14), endDate: addDays(D, 14), portion: "FIRST_HALF" });
const short = await leave(ana, { startDate: addDays(D, 15), endDate: addDays(D, 15), portion: "SHORT", startTime: "09:00", endTime: "10:30" });
const benLeave = await leave(ben, { startDate: addDays(D, 11), endDate: addDays(D, 11), portion: "FULL_DAY", reason: "BEN-PRIVATE-REASON" });
ok(await api(`/leave/${full}/approve`, { method: "POST", cookie: admin, body: {} }), "approve");
ok(await api(`/leave/${benLeave}/reject`, { method: "POST", cookie: admin, body: {} }), "reject");
ok(await api(`/leave/${short}/cancel`, { method: "POST", bearer: ana.bearer }), "cancel");
const LEAVE_FROM = addDays(D, 11);
const LEAVE_TO = addDays(D, 20);

// ---- Chrome over CDP -----------------------------------------------------------------------------
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--remote-debugging-port=9357", `--user-data-dir=${join(RUN, "chrome")}`, "--window-size=1280,1000", "--no-first-run", "about:blank"], { stdio: "ignore" });
let target;
for (let i = 0; i < 150 && !target; i++) {
  await sleep(200);
  target = await fetch("http://127.0.0.1:9357/json/new?about:blank", { method: "PUT" }).then((r) => r.json(), () => null);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
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
const waitFor = async (expr, label, ms = 20_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await js(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${label}`);
};
const shot = async (name) => writeFileSync(join(OUT, name), Buffer.from((await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true })).data, "base64"));
await cdp("Page.enable");
await cdp("Runtime.enable");
await cdp("Network.enable");
await cdp("Emulation.setTimezoneOverride", { timezoneId: "UTC" });

const dash = spawn("pnpm", ["exec", "next", "start", "--port", "3117"], { cwd: `${ROOT}/apps/dashboard`, stdio: "ignore" });
for (let i = 0; i < 150 && !(await fetch(`${APP}/login`).then((r) => r.ok, () => false)); i++) await sleep(200);

const LOADED = `![...document.querySelectorAll('[role=status]')].some((e) => e.checkVisibility() && /^\\s*Loading/.test(e.textContent))`;
async function go(path) {
  await cdp("Page.navigate", { url: `${APP}${path}` });
  await waitFor(`location.pathname === ${JSON.stringify(path.split("?")[0])} && !!document.querySelector('main h1')`, `${path} heading`);
  await waitFor(LOADED, `${path} loaded`);
}
const setReact = (sel, value) => `(() => { const el = ${sel}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); })()`;
const rowText = (label, name) => js(`[...document.querySelectorAll('table[aria-label=${JSON.stringify(label)}] tbody tr')].find((r) => r.innerText.includes(${JSON.stringify(name)}))?.innerText.replace(/\\s+/g, ' ') ?? ''`);
const cell = (label, name, status) => js(`[...document.querySelectorAll('table[aria-label=${JSON.stringify(label)}] tbody tr')].find((r) => r.innerText.includes(${JSON.stringify(name)}))?.querySelector('td[data-status=${status}]')?.innerText.replace(/\\s+/g, ' ').trim() ?? ''`);
/** Sets a RangePicker (first pair of date inputs inside `scope`): "to" first so from ≤ to at every step. */
async function setRange(scope, from, to) {
  await js(setReact(`${scope}.querySelectorAll('input[type=date]')[1]`, to));
  await sleep(150);
  await js(setReact(`${scope}.querySelectorAll('input[type=date]')[0]`, from));
  await waitFor(`${scope}.querySelectorAll('input[type=date]')[0].value === ${JSON.stringify(from)} && ${scope}.querySelectorAll('input[type=date]')[1].value === ${JSON.stringify(to)}`, "range set");
  await sleep(300);
  await waitFor(LOADED, "range loaded");
}
async function signIn(email) {
  await cdp("Network.clearBrowserCookies");
  await cdp("Page.navigate", { url: `${APP}/login` });
  await waitFor(`(() => { const f = document.querySelector('form'); return !!f && Object.keys(f).some((k) => k.startsWith('__reactProps')); })()`, "login form");
  await js(`(() => { const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
    set(document.querySelector('input[type=email], input[name=email]'), ${JSON.stringify(email)}); set(document.querySelector('input[type=password]'), ${JSON.stringify(PASSWORD)}); document.querySelector('form').requestSubmit(); })()`);
  await waitFor(`location.pathname !== '/login' && !!document.querySelector('main h1')`, `${email} signed in`);
}
async function noHorizontalScroll(paths, prepare = {}) {
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
  const bad = [];
  for (const p of paths) {
    await go(p);
    if (prepare[p]) await prepare[p]();
    await sleep(300);
    const sw = await js(`document.documentElement.scrollWidth`);
    if (sw > 390) {
      const culprits = await js(`[...document.querySelectorAll('body *')].filter((e) => { if (e.getBoundingClientRect().right <= 391) return false; for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) if (getComputedStyle(a).overflowX !== 'visible') return false; return true; }).filter((e, _, all) => !all.includes(e.parentElement)).slice(0, 3).map((e) => e.tagName.toLowerCase() + '.' + String(e.className).split(' ').slice(0, 5).join('.') + ' "' + e.textContent.trim().slice(0, 40) + '"').join(' ; ')`);
      bad.push(`${p}: ${sw}px [${culprits}]`);
    }
  }
  await cdp("Emulation.clearDeviceMetricsOverride");
  return bad;
}

const ACT_FROM = addDays(D, -1);
try {
  await signIn("admin@example.com");

  // ---- Leave summary (admin) ----
  await go("/leave");
  await js(`document.querySelector('#leave-view-btn-summary').click()`);
  await waitFor(`!!document.querySelector('form[aria-label="Leave summary filters"]')`, "summary tab");
  await setRange(`document.querySelector('form[aria-label="Leave summary filters"]')`, LEAVE_FROM, LEAVE_TO);
  await waitFor(`/Ben Product/.test(document.querySelector('table[aria-label="Leave summary"]')?.innerText ?? '')`, "leave summary table");
  const sum = ok(await api(`/leave/summary?from=${LEAVE_FROM}&to=${LEAVE_TO}`, { cookie: admin }), "leave summary").items;
  const anaApi = sum.find((r) => r.employee.id === ana.id).byStatus;
  const anaCells = { APPROVED: await cell("Leave summary", "Ana Product", "APPROVED"), PENDING: await cell("Leave summary", "Ana Product", "PENDING"), CANCELLED: await cell("Leave summary", "Ana Product", "CANCELLED"), REJECTED: await cell("Leave summary", "Ana Product", "REJECTED") };
  check("leave summary tab: Ana approved 2 days (D+10..12 clipped to the range), pending 0.5 days, cancelled short 90 min, nothing rejected",
    anaApi.APPROVED.days === 2 && anaCells.APPROVED.startsWith("2 days") && anaCells.PENDING.startsWith("0.5 days") && anaCells.CANCELLED.startsWith("1 short (90 min)") && anaCells.REJECTED === "—", JSON.stringify(anaCells));
  check("leave summary tab: Ben rejected 1 day; the day rule (weekends included) is stated; no leave reasons shown",
    (await cell("Leave summary", "Ben Product", "REJECTED")).startsWith("1 day") && /weekends included/.test(await js(`document.querySelector('main').innerText`)) && !(await js(`document.querySelector('main').innerText`)).includes("BEN-PRIVATE-REASON"));
  await js(setReact(`document.querySelector('form[aria-label="Leave summary filters"] input[type=search]')`, "PR-2"));
  await js(`document.querySelector('form[aria-label="Leave summary filters"]').requestSubmit()`);
  await waitFor(`document.querySelectorAll('table[aria-label="Leave summary"] tbody tr').length === 1`, "search");
  check("leave summary tab: search narrows to Ben", /Ben Product/.test(await rowText("Leave summary", "Ben")));
  await shot("leave-summary.png");

  // ---- Activity: Summary (default tab): app charts + the overview table ----
  await go("/activity");
  check("activity: 'Summary' is the default tab", await js(`document.querySelector('#activity-view-btn-summary')?.getAttribute('aria-selected') === 'true'`));
  await setRange(`document.querySelector('main')`, ACT_FROM, await js(`document.querySelectorAll('main input[type=date]')[1].value`));
  const range = await js(`[...document.querySelectorAll('main input[type=date]')].map((i) => i.value)`);
  await waitFor(`/Ben Product/.test(document.querySelector('table[aria-label="Activity overview"]')?.innerText ?? '')`, "overview table");
  const ov = ok(await api(`/activity/overview?from=${range[0]}&to=${range[1]}`, { cookie: admin }), "overview");
  const anaOv = ov.items.find((r) => r.employee.id === ana.id);
  const anaRow = await rowText("Activity overview", "Ana Product");
  const benRow = await rowText("Activity overview", "Ben Product");
  // Ana's clock-in and her activity are two syncs, each corrected by its own request latency (clock-skew rule): when the
  // activity request is faster, her first interval starts a few ms before the clock-in and that edge is trimmed, so 75 min
  // can read 1h 14m (floor). The UI must show exactly the API's value, and the API must be 75 min minus at most that trim.
  const TRIM_MS = 1_000;
  const anaActiveOk = anaOv.activeMs <= 75 * M && anaOv.activeMs > 75 * M - TRIM_MS;
  check("activity overview: rows for every employee with clocked-in, active, idle, unobserved, productive share and last upload",
    ov.categoriesConfigured && anaActiveOk && anaRow.includes(`${Math.round(anaOv.productiveShare * 100)}%`) && anaRow.includes(formatDurationShort(anaOv.activeMs)) && anaRow.includes("20m 00s") && benRow.includes("1h 30m") && /20m 00s/.test(benRow), `${anaOv.activeMs} ms: ${anaRow} || ${benRow}`);
  const apps = ok(await api(`/activity/apps?from=${range[0]}&to=${range[1]}`, { cookie: admin }), "apps");
  const slices = await js(`document.querySelectorAll('svg[aria-label^="Top applications by active time"] [data-slice]').length`);
  check("activity summary: top-apps donut (one slice per app: Code, Safari, Slack) and a 100% label-share bar",
    apps.applications.map((a) => a.applicationName).join() === "Code,Safari,Slack" && apps.applications[0].category === "PRODUCTIVE" && slices === 3 && (await js(`/Label share of active time/.test(document.querySelector('main').innerHTML)`)), `${slices} slices`);
  await shot("activity-overview.png");

  // ---- Activity: one employee (from the overview link) ----
  await js(`[...document.querySelectorAll('table[aria-label="Activity overview"] a')].find((a) => a.textContent === 'Ana Product').click()`);
  await waitFor(`document.querySelector('#activity-view-btn-employee')?.getAttribute('aria-selected') === 'true' && !!document.querySelector('table[aria-label="Activity timeline"] tbody tr')`, "employee view");
  await waitFor(LOADED, "employee view loaded");
  const tl = await js(`[...document.querySelectorAll('table[aria-label="Activity timeline"] tbody tr')].map((r) => [...r.cells].slice(3).map((c) => c.innerText.trim()).join('|'))`);
  check("activity timeline: label badge per row (Code Productive, Safari Unclassified, idle —, Slack Unproductive)",
    JSON.stringify(tl) === JSON.stringify(["Code|Productive", "Safari|Unclassified", "Idle|—", "Slack|Unproductive"]), JSON.stringify(tl));
  const s = ok(await api(`/activity/summary?employeeId=${ana.id}&from=${range[0]}&to=${range[1]}`, { cookie: admin }), "summary");
  const bars = await js(`[...document.querySelectorAll('[data-testid=productivity-trend] li[data-day]')].map((l) => ({ day: l.dataset.day, share: l.dataset.share, text: l.querySelector('[data-testid=trend-value]').innerText }))`);
  // Ana's shift is still open, so her clocked-in time (and share) grows between the two reads: compare to 1 %.
  const expectBars = s.days.map((d) => ({ day: d.date, share: d.productiveShare }));
  const today = s.days.find((d) => d.date === D);
  const todayBar = bars.find((b) => b.day === D);
  check("activity trend: one bar per day, data matches /activity/summary days[], text shows today's share and productive time",
    bars.length === expectBars.length && bars.every((b, i) => b.day === expectBars[i].day && (expectBars[i].share === null ? b.share === "" : Math.abs(Number(b.share) - expectBars[i].share) < 0.01)) && !!todayBar && todayBar.text.startsWith(`${Math.round(today.productiveShare * 100)}%`) && bars.every((b) => s.days.find((d) => d.date === b.day).clockedInMs > 0 || b.text === "Not clocked in"),
    JSON.stringify(bars));
  check("activity trend: screen-reader table with one row per day",
    (await js(`document.querySelectorAll('table[aria-label="Productivity by day"] tbody tr').length`)) === s.days.length && (await js(`[...document.querySelectorAll('[data-testid=productivity-trend] ol')].every((o) => o.getAttribute('aria-hidden') === 'true')`)));
  await shot("activity-employee.png");

  // ---- Activity: Per employee, App history, Review apps ----
  await js(`document.querySelector('#activity-view-btn-employees').click()`);
  await waitFor(`/Ben Product/.test(document.querySelector('table[aria-label="Usage per employee"]')?.innerText ?? '')`, "per employee");
  const perAna = await rowText("Usage per employee", "Ana Product");
  check("activity per employee: Ana's active time and top application match /activity/apps",
    perAna.includes(formatDurationShort(apps.employees.find((e) => e.employee.id === ana.id).activeMs)) && perAna.includes("Code"), perAna);
  await js(`document.querySelector('#activity-view-btn-history').click()`);
  await waitFor(`/Ben Product/.test(document.querySelector('table[aria-label="App history per employee"]')?.innerText ?? '')`, "app history");
  check("activity app history: Code chosen first, bar chart per day, Ana and Ben listed", await js(`document.querySelector('select[aria-label=Application]').value === 'com.example.Code' && document.querySelectorAll('[data-bar]').length >= 1`));
  await js(`document.querySelector('#activity-view-btn-review').click()`);
  await waitFor(`/Safari/.test(document.querySelector('table[aria-label="Unreviewed applications"]')?.innerText ?? '')`, "review apps");
  check("activity review apps: Safari is the one unreviewed app; link to Settings › App labels",
    (await js(`document.querySelectorAll('table[aria-label="Unreviewed applications"] tbody tr').length === 1 && !!document.querySelector('main a[href="/settings/labels"]')`)));

  // ---- Risk users ----
  await go("/risk-users");
  check("risk users: page renders (list or empty state) with a link to /alerts", await js(`!!document.querySelector('main a[href="/alerts"]') && (!!document.querySelector('table[aria-label="Risky users"]') || /No risky users/.test(document.querySelector('main').innerText))`));

  // ---- Reports: read-only overview ----
  await go("/reports");
  await waitFor(`/Ana Product/.test(document.querySelector('table[aria-label="Activity overview"]')?.innerText ?? '')`, "reports overview");
  check("reports: read-only activity overview with employee links to /activity",
    (await js(`!!document.querySelector('main a[href="/activity"]') && !!document.querySelector('table[aria-label="Activity overview"] a[href="/activity?employeeId=${ana.id}"]')`)));
  // The email report form moved to /reports/scheduled (wave 1).
  await go("/reports/scheduled");
  await js(`[...document.querySelectorAll('main button')].find((b) => b.textContent.trim() === 'New report').click()`);
  const formOk = await waitFor(`[...document.querySelectorAll('section[aria-label="New scheduled report"] form')].some((f) => f.innerText.includes('Create report'))`, "schedule form").catch(() => false);
  check("reports/scheduled: 'New report' opens the email report form", formOk);

  const adminScroll = await noHorizontalScroll(["/leave", "/activity", "/activity?tab=employees", "/risk-users", "/reports"], { "/leave": () => js(`document.querySelector('#leave-view-btn-summary').click()`).then(() => waitFor(`!!document.querySelector('table[aria-label="Leave summary"]')`, "summary at 390")) });
  check("responsive 390px: /leave (summary), /activity (summary, per employee), /risk-users, /reports have no horizontal page scroll", adminScroll.length === 0, adminScroll.join(", "));

  // ---- Employee ----
  await signIn(ana.email);
  await go("/my/activity");
  await waitFor(`!!document.querySelector('[data-testid=productivity-trend]') && !!document.querySelector('table[aria-label="My activity timeline"] tbody tr')`, "my activity");
  const myTl = await js(`[...document.querySelectorAll('table[aria-label="My activity timeline"] tbody tr')].map((r) => r.innerText.replace(/\\s+/g, ' '))`);
  const myBars = await js(`document.querySelectorAll('[data-testid=productivity-trend] li[data-day]').length`);
  check("my activity: timeline label column (Code Productive, Slack Unproductive) and a 7-day productivity trend",
    myTl.some((r) => /Code Productive/.test(r)) && myTl.some((r) => /Slack Unproductive/.test(r)) && myBars === 7, `${myBars} bars; ${myTl.join(" || ")}`);
  await go("/my/leave");
  const myCard = `[...document.querySelectorAll('main section')].find((c) => c.querySelector('h3')?.textContent === 'Summary for a period')`;
  await waitFor(`!!${myCard}`, "my summary card");
  await setRange(myCard, LEAVE_FROM, LEAVE_TO);
  await waitFor(`!!document.querySelector('table[aria-label="My leave summary"] td[data-status=APPROVED]')`, "my summary table");
  const mine = { APPROVED: await js(`document.querySelector('table[aria-label="My leave summary"] td[data-status=APPROVED]').innerText.replace(/\\s+/g, ' ')`), CANCELLED: await js(`document.querySelector('table[aria-label="My leave summary"] td[data-status=CANCELLED]').innerText.replace(/\\s+/g, ' ')`) };
  check("my leave: own summary for the selected range (2 days approved, 1 short cancelled), day rule stated, no other employee",
    mine.APPROVED.startsWith("2 days") && mine.CANCELLED.startsWith("1 short (90 min)") && /weekends included/.test(await js(`document.querySelector('main').innerText`)) && !/Ben Product/.test(await js(`document.querySelector('main').innerText`)), JSON.stringify(mine));

  const statuses = await js(`Promise.all(["/leave/summary?from=${LEAVE_FROM}&to=${LEAVE_TO}", "/activity/overview?from=${ACT_FROM}&to=${D}", "/leave/summary/me?from=${LEAVE_FROM}&to=${LEAVE_TO}&employeeId=${ben.id}", "/activity/timeline?from=${ACT_FROM}&to=${D}&employeeId=${ben.id}"].map((p) => fetch(${JSON.stringify(API)} + p, { credentials: "include" }).then((r) => r.status)))`);
  const own = await js(`fetch(${JSON.stringify(API)} + "/leave/summary/me?from=${LEAVE_FROM}&to=${LEAVE_TO}", { credentials: "include" }).then((r) => r.json())`);
  check("employee: admin summary and overview are 403; /me refuses another id (400); Ben's timeline 404; /me returns only Ana",
    JSON.stringify(statuses) === JSON.stringify([403, 403, 400, 404]) && own.row?.employee.id === ana.id, JSON.stringify(statuses));
  await cdp("Page.navigate", { url: `${APP}/activity` });
  check("employee: /activity (admin page) redirects to /my", await waitFor(`location.pathname.startsWith('/my')`, "redirect").catch(() => false));

  const myScroll = await noHorizontalScroll(["/my/leave", "/my/activity"]);
  check("responsive 390px: /my/leave and /my/activity have no horizontal page scroll", myScroll.length === 0, myScroll.join(", "));
} catch (err) {
  check(`run aborted: ${err.message}`, false);
  await shot("failure.png").catch(() => {});
} finally {
  ws.close();
  chrome.kill();
  dash.kill();
  await app.close().catch(() => {});
  await sleep(500);
  rmSync(RUN, { recursive: true, force: true });
}
console.log(`Page captures: ${OUT}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
