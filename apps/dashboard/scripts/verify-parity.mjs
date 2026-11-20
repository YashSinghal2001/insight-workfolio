// Product-parity browser suite (W4-E2E, tracker P7-01…05): the wave 1–3 pages as Super Admin, Admin, team head and
// employee, the desktop → API → dashboard attendance flow and the notification mock delivery. Throwaway API
// (temporary file DB, local screenshot storage, mock mail), the dashboard production build and headless Chrome over CDP.
// Synthetic data only. Run after `pnpm build` (packages, API dist, dashboard .next built with
// NEXT_PUBLIC_API_URL=http://localhost:${IW_API_PORT}).
// Usage: pnpm --filter @workfolio/dashboard verify:parity [out-dir]
// Ports: IW_API_PORT (4000), IW_APP_PORT (3105), IW_CDP_PORT (9345).
//
// Direct database writes (documented, test-only):
// - employee_profiles.created_at is backdated so past days count the seeded people;
// - a work schedule version effective 20 days ago (a page-saved schedule applies only from tomorrow);
// - history older than "now" for monthly / reports / risk users: closed sessions inserted with SQL in the shape the
//   API writes (the desktop sync accepts at most 7 days back and these rows are not what is under test);
// - one device's last_seen_at is set 2 h back (a stale desktop app), as the desktop would leave it by going silent;
// - screenshot policy and monitoring consents, as the other suites do.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const API_PORT = Number(process.env.IW_API_PORT ?? 4000);
const APP_PORT = Number(process.env.IW_APP_PORT ?? 3105);
const CDP_PORT = Number(process.env.IW_CDP_PORT ?? 9345);
const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = process.argv[2] ?? mkdtempSync(join(tmpdir(), "wf-verify-parity-"));
const RUN = join(OUT, "run");
rmSync(RUN, { recursive: true, force: true });
mkdirSync(join(RUN, "shots"), { recursive: true });
const APP = `http://localhost:${APP_PORT}`;
const API = `http://localhost:${API_PORT}/api/v1`;
Object.assign(process.env, {
  NODE_ENV: "development", LOG_LEVEL: "warn", PORT: String(API_PORT),
  DATABASE_URL: `file:${join(RUN, "parity.db")}`,
  JWT_SECRET: "parity-check-secret-parity-check-secret",
  SCREENSHOT_STORAGE: "local", SCREENSHOT_LOCAL_DIR: join(RUN, "shots"), TIMELAPSE_DIR: join(RUN, "videos"),
  CORS_ORIGINS: APP, REPORT_SCHEDULER_SECONDS: "0",
  REPORT_MAIL_PROVIDER: "mock", INVITATION_MAIL_PROVIDER: "mock", MAIL_SENDER: "noreply@example.com",
});
const req = createRequire(`${ROOT}/apps/api/package.json`);
req("reflect-metadata");
const { NestFactory } = req("@nestjs/core");
const dist = (p) => import(`${ROOT}/apps/api/dist/${p}`);
const { AppModule } = await dist("app.module.js");
const { configureApp } = await dist("app.setup.js");
const { DATABASE } = await dist("database/database.module.js");
const { hashPassword } = await dist("auth/crypto.js");
const { NotificationsService } = await dist("notifications/notifications.service.js");
const { INVITATION_TRANSPORT } = await dist("employees/invitations.js");
const { DEFAULT_NOTICE_VERSION: ACTIVITY_NOTICE, addDays, localDate } = await import(`${ROOT}/packages/shared/dist/index.js`);
const SHOT_NOTICE = "2026-10-screenshots-draft-1";
const PASSWORD = "parity check password 1";
const M = 60_000;
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
const results = [];
const check = (name, ok, detail = "") => (results.push({ name, ok: !!ok }), console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- API and synthetic data -------------------------------------------------------------------
const app = await NestFactory.create(AppModule, { logger: ["error", "warn"] });
configureApp(app);
await app.listen(API_PORT);
const db = app.get(DATABASE);
const outbox = app.get(INVITATION_TRANSPORT).outbox; // mock mail: invitations and notification emails
const one = async (sql, args = []) => (await db.execute({ sql, args })).rows[0];
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
await db.execute({
  sql: `INSERT INTO screenshot_policies (screenshots_enabled, mask_regions, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
          retention_approved, notice_version, employee_self_view, reason, changed_by, effective_at) VALUES (1, '[]', 60, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, ?, 1, 'parity check', ?, ?)`,
  args: [SHOT_NOTICE, superId, iso(Date.now() - 30 * DAY)],
});
// Schedule 09:00 + 15 min grace, every day, from 20 days ago: late / absent / risk users have data.
await db.execute({ sql: "INSERT INTO work_schedule_policies (enabled, expected_start, grace_minutes, workdays, reason, changed_by, effective_at) VALUES (1, '09:00', 15, '1234567', 'parity check (backdated)', ?, ?)", args: [superId, iso(Date.now() - 20 * DAY)] });

// Everyone is in UTC (the browser is pinned to UTC too). "Today" activity sits in a window W that is inside today's
// UTC date whatever the hour of the run.
const NOW = Date.now();
const today = localDate(NOW, "UTC");
const yesterday = addDays(today, -1);
const dayStart = Date.parse(`${today}T00:00:00Z`);
const W = Math.max(4 * M, Math.min(150 * M, NOW - dayStart - 2 * M));
const ago = (f) => NOW - f * W;
const at = (date, hm) => Date.parse(`${date}T${hm}:00Z`);

async function employee(code, name, { device = true } = {}) {
  const email = `${code.toLowerCase()}@example.com`;
  const r = ok(await api("/employees", { method: "POST", cookie: superCookie, body: { email, employeeCode: code, fullName: name, timezone: "UTC" } }), "employee");
  // Mock mail provider: the invitation (with its setup link) lands in the outbox instead of the API response.
  const token = /#token=([A-Za-z0-9_-]+)/.exec(outbox.findLast((m) => m.to === email)?.text ?? "")?.[1];
  ok(await api("/auth/setup-password", { method: "POST", body: { token, password: PASSWORD } }), "setup password");
  // The desktop app signs in with client=desktop (bearer token), then registers its installation.
  const bearer = (await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } })).body.accessToken;
  const e = { id: r.employee.id, userId: r.employee.userId, email, bearer, device: randomUUID(), name, code };
  if (device) ok(await api("/devices/register", { method: "POST", bearer, body: { installationId: e.device, deviceName: `${name.split(" ")[0]}'s Mac`, platform: "macos" } }), "device");
  for (const v of [SHOT_NOTICE, ACTIVITY_NOTICE]) await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), e.id, v, iso(NOW - 25 * DAY)] });
  await db.execute({ sql: "UPDATE employee_profiles SET created_at = ? WHERE id = ?", args: [iso(NOW - 25 * DAY), e.id] });
  return e;
}
/** Desktop offline-queue upload; `skewMs` = how far the device clock is ahead of the server. */
const sync = async (e, events, skewMs = 0) => {
  const r = ok(await api("/attendance/sync", { method: "POST", bearer: e.bearer, device: e.device, body: { sentAt: iso(Date.now() + skewMs), events: events.map(([type, t]) => ({ id: randomUUID(), type, occurredAt: iso(t + skewMs) })) } }), "attendance sync");
  if (!r.results.every((x) => x.status === "ACCEPTED")) throw new Error(`attendance sync: ${JSON.stringify(r)}`);
  return r;
};
const online = (e, action) => api(`/attendance/${action}`, { method: "POST", bearer: e.bearer, device: e.device, headers: { "idempotency-key": randomUUID() } });
/** Closed historic shift inserted directly (see header). */
async function pastShift(e, date, from, to) {
  const device = (await one("SELECT id FROM devices WHERE employee_id = ?", [e.id])).id;
  await db.execute({ sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, clock_out_at, status) VALUES (?, ?, ?, ?, ?, 'CLOSED')", args: [randomUUID(), e.id, device, iso(at(date, from)), iso(at(date, to))] });
}
const activity = (e, rows) =>
  api("/activity/sync", { method: "POST", bearer: e.bearer, device: e.device, body: { sentAt: iso(Date.now()), platform: "macos", intervals: rows.map(([appName, from, to]) => ({ id: randomUUID(), kind: appName ? "ACTIVE" : "IDLE", applicationIdentifier: appName ? `com.example.${appName.replace(/\W/g, "")}` : null, applicationName: appName, startedAt: iso(ago(from)), endedAt: iso(ago(to)) })) } });

const ana = await employee("PA-1", "Ana Desk");
const ben = await employee("PA-2", "Ben Short");
const cara = await employee("PA-3", "Cara Break");
const dev = await employee("PA-4", "Dev Stale");
const eli = await employee("PA-5", "Eli Forgot");
const fay = await employee("PA-6", "Fay Noapp", { device: false });
const gus = await employee("PA-7", "Gus Done");
const hana = await employee("PA-8", "Hana Head");
const ivy = await employee("PA-9", "Ivy Notify");
const ALL = [ana, ben, cara, dev, eli, fay, gus, hana, ivy];
const alpha = ok(await api("/teams", { method: "POST", cookie: superCookie, body: { name: "Alpha", headUserId: hana.userId } }), "team alpha");
const beta = ok(await api("/teams", { method: "POST", cookie: superCookie, body: { name: "Beta", headUserId: hana.userId } }), "team beta");
ok(await api(`/teams/${alpha.id}/members`, { method: "PUT", cookie: superCookie, body: { employeeIds: [ana.id, ben.id, dev.id, eli.id] } }), "alpha members");
ok(await api(`/teams/${beta.id}/members`, { method: "PUT", cookie: superCookie, body: { employeeIds: [cara.id, gus.id] } }), "beta members");

// History: Ben works 3 h days (risk: less working hours), Gus full days with one late start, Ana full days.
for (let d = 1; d <= 8; d++) {
  const date = addDays(today, -d);
  await pastShift(ben, date, "09:00", "12:00");
  await pastShift(gus, date, d === 2 ? "10:10" : "09:05", "17:30");
  if (d > 1) await pastShift(ana, date, "09:00", "17:00");
}
// Eli: clocked in yesterday through the offline queue and never clocked out (missing clock-out, previous day).
await sync(eli, [["CLOCK_IN", at(yesterday, "09:30")]]);
// Cara on a break now; Dev working but his app went silent 2 h ago (stale device).
await sync(cara, [["CLOCK_IN", ago(0.9)], ["BREAK_START", ago(0.2)]]);
await sync(dev, [["CLOCK_IN", ago(0.8)]]);
// Gus: online clock-in and clock-out today (desktop online endpoints).
const gusIn = await online(gus, "clock-in");
const gusOut = await online(gus, "clock-out");
await db.execute({ sql: "UPDATE devices SET last_seen_at = ? WHERE employee_id = ?", args: [iso(NOW - 2 * 60 * M), dev.id] });
ok(await activity(ben, [["Code Editor", 0.95, 0.9]]), "ben activity");

// ---- Chrome over CDP -------------------------------------------------------------------------
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(RUN, "chrome")}`, "--window-size=1440,1000", "--no-first-run", "about:blank"], { stdio: "ignore" });
let target;
for (let i = 0; i < 150 && !target; i++) {
  await sleep(200);
  target = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json(), () => null);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pending = new Map();
const consoleErrors = [];
const apiFailures = [];
const apiCalls = [];
const requests = new Map();
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);
  if (msg.method === "Runtime.consoleAPICalled" && ["error", "assert"].includes(msg.params.type)) consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
  if (msg.method === "Runtime.exceptionThrown") consoleErrors.push(`uncaught: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
  if (msg.method === "Network.requestWillBeSent") {
    requests.set(msg.params.requestId, `${msg.params.request.method} ${msg.params.request.url}`);
    if (msg.params.request.url.startsWith(API) && msg.params.request.method !== "OPTIONS") apiCalls.push(`${msg.params.request.method} ${msg.params.request.url.slice(API.length)}`);
  }
  if (msg.method === "Network.responseReceived" && msg.params.response.url.startsWith(API) && msg.params.response.status >= 400) apiFailures.push(`${msg.params.response.status} ${msg.params.response.url.slice(API.length)}`);
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
async function upload(e, t, n) {
  const bytes = await webp(n);
  const id = randomUUID();
  const reg = await api("/screenshots/register", { method: "POST", bearer: e.bearer, device: e.device, body: { id, capturedAt: iso(t), sentAt: iso(Date.now()), width: 640, height: 360, sizeBytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), mimeType: "image/webp" } });
  if (reg.body?.status !== "REGISTERED") throw new Error(`register: ${reg.text}`);
  ok(await api(`/screenshots/${id}/content`, { method: "PUT", bearer: e.bearer, device: e.device, raw: bytes }), "screenshot content");
  return (await one("SELECT id FROM screenshots WHERE idempotency_key = ?", [id])).id;
}

// =========================== Desktop → API flow (P7-04) =========================================
// Ana's desktop was offline with its clock 90 minutes fast: it uploads clock-in, break start and break end in one
// batch. The API corrects the skew from the batch's send time; the events are marked as synced later.
const SKEW = 90 * M;
const anaIn = ago(0.9);
const anaBreak = [ago(0.6), ago(0.5)];
await sync(ana, [["CLOCK_IN", anaIn], ["BREAK_START", anaBreak[0]], ["BREAK_END", anaBreak[1]]], SKEW);
const anaSession = await one("SELECT id, clock_in_at, status FROM attendance_sessions WHERE employee_id = ? AND clock_out_at IS NULL", [ana.id]);
const anaBreakRow = await one("SELECT started_at, ended_at FROM break_sessions WHERE attendance_session_id = ?", [anaSession?.id ?? ""]);
const anaSources = (await db.execute({ sql: "SELECT DISTINCT source FROM attendance_events WHERE employee_id = ?", args: [ana.id] })).rows.map((r) => r.source);
const near = (a, b) => Math.abs(Date.parse(a) - b) < 5_000;
check("desktop: offline batch with a +90 min device clock is skew-corrected (clock-in and break within 5 s of the real times) and stored as OFFLINE_SYNC",
  anaSession && near(anaSession.clock_in_at, anaIn) && anaBreakRow && near(anaBreakRow.started_at, anaBreak[0]) && near(anaBreakRow.ended_at, anaBreak[1]) && anaSources.join() === "OFFLINE_SYNC",
  JSON.stringify({ in: anaSession?.clock_in_at, expected: iso(anaIn), sources: anaSources }));
check("desktop: online clock-in / clock-out endpoints with device headers → 200, session closed", gusIn.status === 200 && gusOut.status === 200 && (await one("SELECT count(*) AS n FROM attendance_sessions WHERE employee_id = ? AND clock_out_at IS NULL", [gus.id])).n === 0, `${gusIn.status}/${gusOut.status}`);
const reg2 = await api("/devices/register", { method: "POST", bearer: ana.bearer, body: { installationId: ana.device, deviceName: "Ana's Mac", platform: "macos" } });
check("desktop: re-registering the same installation is idempotent (2xx)", reg2.status < 300, String(reg2.status));
const noDevice = await api("/attendance/clock-in", { method: "POST", bearer: fay.bearer, headers: { "idempotency-key": randomUUID() } });
check("desktop: clock-in without a registered device header is refused (4xx)", noDevice.status >= 400 && noDevice.status < 500, String(noDevice.status));

// Activity and screenshots for Ana today: one screenshot inside an IDLE interval (idle marker).
ok(await activity(ana, [["Code Editor", 0.45, 0.35], [null, 0.35, 0.25], ["Mail", 0.25, 0.15]]), "ana activity");
const anaShots = [await upload(ana, ago(0.4), 1), await upload(ana, ago(0.3), 2), await upload(ana, ago(0.2), 3)];
const idleShot = anaShots[1];

const dash = spawn("pnpm", ["exec", "next", "start", "--port", String(APP_PORT)], { cwd: `${ROOT}/apps/dashboard`, stdio: "ignore" });
for (let i = 0; i < 150 && !(await fetch(`${APP}/login`).then((r) => r.ok, () => false)); i++) await sleep(200);

// ---- Page helpers ------------------------------------------------------------------------------
const LOADED = `![...document.querySelectorAll('[role=status]')].some((e) => e.checkVisibility() && /^\\s*Loading/.test(e.textContent)) && !/Loading…/.test(document.querySelector('main')?.innerText ?? '')`;
async function go(path, { wait = true } = {}) {
  const [p, q = ""] = path.split("?");
  await cdp("Page.navigate", { url: `${APP}${path}` });
  await waitFor(`location.pathname === ${JSON.stringify(p)} && location.search === ${JSON.stringify(q ? `?${q}` : "")} && !!document.querySelector('main h1')`, `${path} heading`);
  return { loaded: wait ? await tryWait(LOADED, `${path} loaded`, 20_000) : true };
}
const loaded = () => tryWait(LOADED, "loaded", 20_000);
const text = () => js(`document.querySelector('main').innerText`);
const setReact = (sel, value) => `(() => { const el = ${sel}; const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); })()`;
const click = (sel) => js(`(() => { const el = ${sel}; if (!el) throw new Error("not found: " + ${JSON.stringify(sel)}); el.click(); return true; })()`);
const byText = (scope, tag, label) => `[...${scope}.querySelectorAll(${JSON.stringify(tag)})].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;
const byPrefix = (scope, tag, label) => `[...${scope}.querySelectorAll(${JSON.stringify(tag)})].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)}))`;
async function signIn(email, landing) {
  await cdp("Network.clearBrowserCookies");
  await cdp("Page.navigate", { url: `${APP}/login` });
  await waitFor(`(() => { const f = document.querySelector('form'); return !!f && Object.keys(f).some((k) => k.startsWith('__reactProps')); })()`, "login form");
  await js(`(() => { const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
    set(document.querySelector('input[type=email], input[name=email]'), ${JSON.stringify(email)}); set(document.querySelector('input[type=password]'), ${JSON.stringify(PASSWORD)}); document.querySelector('form').requestSubmit(); })()`);
  await waitFor(`location.pathname === ${JSON.stringify(landing)} && !!document.querySelector('main h1')`, `${email} signed in`);
}
const statCard = (label) => js(`(() => { const p = [...document.querySelectorAll('main p')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); return p?.parentElement?.children[1]?.textContent.trim() ?? null; })()`);
async function downloaded(ext, since) {
  for (let i = 0; i < 150; i++) {
    const f = readdirSync(DOWNLOADS).filter((x) => x.endsWith(ext) && !since.includes(x));
    if (f.length && statSync(join(DOWNLOADS, f[0])).size > 0) return { name: f[0], bytes: readFileSync(join(DOWNLOADS, f[0])) };
    await sleep(100);
  }
  return null;
}
const listDownloads = () => readdirSync(DOWNLOADS);
/** Clicks a button and returns the new download with that extension (or null). */
async function download(sel, ext) {
  // Chrome overwrites a file of the same name (two exports of one month), so start from an empty folder.
  for (const f of listDownloads()) rmSync(join(DOWNLOADS, f), { force: true });
  await click(sel);
  return downloaded(ext, []);
}
/** Page-level horizontal scroll at each width (against the emulated width), as verify-web-app does. */
async function hscroll(paths, widths) {
  const bad = [];
  for (const w of widths) {
    await cdp("Emulation.setDeviceMetricsOverride", { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 768 });
    for (const p of paths) {
      try {
        await go(p);
        await sleep(200);
        const sw = await js("document.documentElement.scrollWidth");
        if (sw > w) bad.push(`${p}@${w}: ${sw}`);
      } catch (err) {
        bad.push(`${p}@${w}: ${String(err.message).slice(0, 60)}`);
      }
    }
  }
  await cdp("Emulation.clearDeviceMetricsOverride");
  return bad;
}
/** Wide tables scroll inside their own box (an ancestor with overflow-x auto/scroll that is narrower than the table). */
const tablesScrollInside = () => js(`[...document.querySelectorAll('main table')].every((t) => {
  if (t.getBoundingClientRect().width <= innerWidth) return true;
  for (let a = t.parentElement; a && a !== document.body; a = a.parentElement) if (/auto|scroll/.test(getComputedStyle(a).overflowX) && a.clientWidth < t.scrollWidth) return true;
  return false; })`);
const noFailures = (what) => {
  const f = [...apiFailures, ...consoleErrors.map((c) => `console: ${c.slice(0, 120)}`)];
  apiFailures.length = 0;
  consoleErrors.length = 0;
  return f;
};
const W375 = [375];

try {
  await cdp("Page.navigate", { url: `${APP}/login` });
  await signIn("ceo@example.com", "/");

  // =========================== Notification mock delivery (P7-05) ==============================
  await go("/settings/notifications");
  const clockInCard = `[...document.querySelectorAll('main section')].find((x) => x.querySelector('h3')?.textContent.trim() === 'Clock-in')?.querySelector('fieldset[aria-label^="All employees"]')`;
  await waitFor(`!!${clockInCard}`, "clock-in rule card");
  await js(setReact(`${clockInCard}.querySelector('select')`, "IMMEDIATE"));
  await click(`[...${clockInCard}.querySelectorAll('label')].find((l) => l.textContent.includes('it@example.com'))?.querySelector('input[type=checkbox]')`);
  await click(byText(clockInCard, "button", "Save rule"));
  const saved = await tryWait(`/Saved\\./.test(${clockInCard}.innerText)`, "rule saved");
  const rule = (await db.execute("SELECT r.id, r.mode, (SELECT group_concat(u.email) FROM notification_rule_recipients x JOIN users u ON u.id = x.user_id WHERE x.rule_id = r.id) AS recipients FROM notification_rules r WHERE r.type = 'ATTENDANCE_CLOCK_IN' AND r.team_id IS NULL")).rows[0];
  check("notifications: /settings/notifications switches the org Clock-in rule to Immediate with an admin recipient", saved && rule?.mode === "IMMEDIATE" && rule.recipients === "it@example.com", JSON.stringify(rule));
  const notifications = app.get(NotificationsService);
  const deliveries = async () => (await db.execute("SELECT d.status, u.email FROM notification_deliveries d LEFT JOIN users u ON u.id = d.recipient_user_id JOIN notification_events e ON e.id = d.event_id WHERE e.type = 'ATTENDANCE_CLOCK_IN'")).rows;
  ok(await online(ivy, "clock-in"), "ivy clock-in");
  await notifications.deliver();
  const sent = await deliveries();
  const mails = outbox.filter((m) => m.to === "it@example.com");
  check("notifications: one clock-in → exactly one mock delivery (SENT) to it@example.com, one email in the mock outbox", sent.length === 1 && sent[0].status === "SENT" && sent[0].email === "it@example.com" && mails.length === 1, `${JSON.stringify(sent)} · ${mails.map((m) => m.subject).join(" | ")}`);
  await go("/notifications");
  const events = await js(`document.querySelector('table[aria-label="Notification events"]')?.innerText ?? ''`);
  check("notifications: /notifications lists the delivery to it@example.com (mock provider shown)", /it@example\.com/.test(events) && /Mock \(development\)/.test(await text()), events.slice(0, 160).replace(/\n/g, " | "));
  ok(await api(`/notifications/rules/${rule.id}`, { method: "PATCH", cookie: superCookie, body: { mode: "OFF" } }), "rule off");
  ok(await online(ivy, "clock-out"), "ivy clock-out");
  ok(await online(ivy, "clock-in"), "ivy clock-in again");
  await notifications.deliver();
  check("notifications: rule OFF → the next clock-in yields no delivery and no email", (await deliveries()).length === 1 && outbox.filter((m) => m.to === "it@example.com").length === 1, String((await deliveries()).length));
  ok(await online(ivy, "clock-out"), "ivy clock-out again");

  // =========================== Overview (P7-01) ================================================
  apiFailures.length = consoleErrors.length = 0;
  const logBefore = Number((await one("SELECT count(*) AS n FROM screenshot_access_log")).n);
  await go("/");
  await waitFor(`[...document.querySelectorAll('main p')].some((p) => p.textContent.trim() === 'Pending corrections')`, "overview cards");
  const ov = ok(await api(`/overview?date=${today}`, { cookie: superCookie }), "overview");
  const kpi = {};
  for (const l of ["Active employees", "Working now", "On a break", "Clocked out today", "App not installed", "Missing clock-outs", "Screenshots stored today"]) kpi[l] = await statCard(l);
  check("overview: KPI cards render and equal the API (9 active, Ana + Dev working, Cara on a break, Fay without the app, 3 screenshots)",
    kpi["Active employees"] === "9" && kpi["Active employees"] === String(ov.kpis.totalMembers) && kpi["Working now"] === String(ov.kpis.workingNow) && kpi["On a break"] === "1" && kpi["App not installed"] === "1" && kpi["Screenshots stored today"] === "3" && Number(kpi["Missing clock-outs"]) >= 1,
    JSON.stringify(kpi));
  // Thumbnails: each one loads through /screenshots/:id/content, which writes the access log; a click opens the gallery.
  const thumbs = await tryWait(`document.querySelectorAll('section[aria-labelledby="ov-shots"] img').length === 3`, "thumbnails", 15_000);
  const logAfter = Number((await one("SELECT count(*) AS n FROM screenshot_access_log")).n);
  check("overview: recent screenshot thumbnails load and each load adds a screenshot_access_log row", thumbs && logAfter - logBefore >= 3, `${logBefore} → ${logAfter}`);
  check("overview: no failed API call or console error", noFailures().length === 0);
  await click(`document.querySelector('section[aria-labelledby="ov-shots"] a[href="/screenshots"][aria-label]')`);
  check("overview: a thumbnail opens the screenshot gallery", await tryWait(`location.pathname === '/screenshots'`, "gallery", 10_000));
  await go(`/?team=${alpha.id}`);
  await waitFor(`[...document.querySelectorAll('main p')].some((p) => p.textContent.trim() === 'Active employees')`, "team overview");
  const teamActive = await statCard("Active employees");
  const teamSelect = await js(`document.querySelector('select[aria-label=Team]')?.selectedOptions[0]?.textContent`);
  check("overview: team filter (Alpha) narrows the widgets to its 4 members", teamActive === "4" && teamSelect === "Alpha", `${teamActive} / ${teamSelect}`);
  await go(`/?date=${addDays(today, -2)}`);
  await waitFor(`[...document.querySelectorAll('main p')].some((p) => p.textContent.trim() === 'Active employees')`, "past overview");
  const pastLabels = await js(`[...document.querySelectorAll('main p')].map((p) => p.textContent.trim()).filter((t) => /that day|today/.test(t))`);
  check("overview: a past date relabels the day cards ('… that day', never '… today')", pastLabels.some((l) => l === "Clocked out that day") && !pastLabels.some((l) => /today$/.test(l)), pastLabels.join(", "));
  const ovScroll = await hscroll(["/"], [1440, 1024, 768, 375]);
  check("overview: no page-level horizontal scroll at 1440/1024/768/375", ovScroll.length === 0, ovScroll.join(", "));

  // =========================== Live team ========================================================
  await go("/live-team");
  await waitFor(`!!document.querySelector('[role=group][aria-label="Filter by status"]')`, "chips");
  const chips = await js(`Object.fromEntries([...document.querySelectorAll('[role=group][aria-label="Filter by status"] button')].map((b) => [b.firstChild.textContent.trim(), Number(b.querySelector('span').textContent)]))`);
  const cardCount = () => js(`document.querySelectorAll('ul[aria-label="Team members"] > li').length`);
  check("live team: chip counts — All equals the number of cards (9)", chips.All === 9 && (await cardCount()) === 9, JSON.stringify(chips));
  const devCard = await js(`[...document.querySelectorAll('ul[aria-label="Team members"] > li')].find((li) => li.innerText.includes('Dev Stale'))?.innerText ?? ''`);
  check("live team: a stale device shows Offline and 'Last seen', never 'Online'", /Offline/.test(devCard) && /Last seen/.test(devCard) && !/\bOnline\b/.test(devCard), devCard.replace(/\n/g, " | "));
  const anaCard = await js(`[...document.querySelectorAll('ul[aria-label="Team members"] > li')].find((li) => li.innerText.includes('Ana Desk'))?.innerText ?? ''`);
  check("desktop → live team: Ana (offline batch) is Working and Online", /Working/.test(anaCard) && /Online/.test(anaCard), anaCard.replace(/\n/g, " | "));
  await click(byPrefix(`document.querySelector('[role=group][aria-label="Filter by status"]')`, "button", "On break"));
  const pressed = await js(`[...document.querySelectorAll('[role=group][aria-label="Filter by status"] button')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.firstChild.textContent.trim())`);
  const breakCards = await js(`[...document.querySelectorAll('ul[aria-label="Team members"] > li')].map((li) => li.innerText.split('\\n')[1])`);
  check("live team: a chip is aria-pressed and filters the cards (On break → Cara only)", pressed.join() === "On break" && breakCards.length === 1 && /Cara/.test(breakCards[0]), `${pressed} ${breakCards}`);
  const leaveChip = byPrefix(`document.querySelector('[role=group][aria-label="Filter by status"]')`, "button", "On leave");
  await click(leaveChip);
  check("live team: a chip with no members shows an empty state", (await cardCount()) === 0 && (await js(`!!document.querySelector('main [role=status], main')?.innerText.match(/leave/i)`)));
  await click(byPrefix(`document.querySelector('[role=group][aria-label="Filter by status"]')`, "button", "All"));
  await js(setReact(`document.querySelector('input[aria-label="Search team members"]')`, "PA-7"));
  await sleep(200);
  const searched = await js(`[...document.querySelectorAll('ul[aria-label="Team members"] > li')].map((li) => li.innerText.split('\\n')[1])`);
  check("live team: search by employee code (PA-7 → Gus)", searched.length === 1 && /Gus/.test(searched[0]), searched.join());
  await js(setReact(`document.querySelector('input[aria-label="Search team members"]')`, ""));
  apiCalls.length = 0;
  await js(setReact(`document.querySelector('select[aria-label=Team]')`, beta.id));
  const betaShown = await tryWait(`document.querySelectorAll('ul[aria-label="Team members"] > li').length === 2`, "beta cards", 15_000);
  check("live team: team select reloads with teamId and shows Beta's 2 members", betaShown && apiCalls.some((c) => c.includes("/attendance/overview") && c.includes(`teamId=${beta.id}`)), `${await cardCount()} cards; ${apiCalls.filter((c) => c.includes("overview")).join(" ")}`);
  // Keyboard: Tab reaches a chip and its focus ring is visible.
  await go("/live-team");
  await waitFor(`!!document.querySelector('[role=group][aria-label="Filter by status"] button')`, "chips again");
  let chipFocus = null;
  for (let i = 0; i < 60 && !chipFocus; i++) {
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    chipFocus = await js(`(() => { const a = document.activeElement; if (!a?.closest('[role=group][aria-label="Filter by status"]')) return null; const s = getComputedStyle(a); return { fv: a.matches(':focus-visible'), ring: s.boxShadow !== 'none' || (s.outlineStyle !== 'none' && s.outlineWidth !== '0px') }; })()`);
  }
  check("keyboard: Tab reaches the status chips with a visible focus ring", chipFocus?.fv && chipFocus.ring, JSON.stringify(chipFocus));

  // =========================== Attendance tabs + corrections ===================================
  await go("/attendance");
  await waitFor(`!!document.querySelector('table[aria-label="Live attendance"]')`, "live table");
  const devRow = await js(`[...document.querySelectorAll('table[aria-label="Live attendance"] tr')].find((r) => r.innerText.includes('Dev Stale'))?.innerText ?? ''`);
  check("attendance live: stale device → 'Last seen …', not Online", /Last seen/.test(devRow) && !/\bOnline\b/.test(devRow), devRow.replace(/\s+/g, " ").slice(0, 200));
  const anaRow = await js(`[...document.querySelectorAll('table[aria-label="Live attendance"] tr')].find((r) => r.innerText.includes('Ana Desk'))?.innerText ?? ''`);
  check("desktop → attendance: Ana clocked in, her events labelled as synced later", /Clocked in/.test(anaRow) && /Synced later/i.test(anaRow), anaRow.replace(/\s+/g, " ").slice(0, 200));
  const tabIssues = [];
  for (const t of ["live", "daily", "monthly", "late", "missing"]) {
    const bad = await hscroll([`/attendance?tab=${t}`], W375);
    if (bad.length) tabIssues.push(...bad);
  }
  check("attendance: every tab (Live, Daily, Monthly, Late, Missing clock-outs) at 375 px — no page-level horizontal scroll", tabIssues.length === 0, tabIssues.join(", "));
  await go("/attendance?tab=monthly");
  await waitFor(`!!document.querySelector('table[aria-label="Monthly attendance"]')`, "monthly table");
  const monthly = await js(`document.querySelector('table[aria-label="Monthly attendance"]').innerText`);
  const xlsx = await download(byText("document", "button", "Export XLSX"), ".xlsx");
  const csv = await download(byText("document", "button", "Export CSV"), ".csv");
  check("attendance monthly: table[aria-label='Monthly attendance'] lists everyone; XLSX (zip) and CSV exports download",
    /Ben Short/.test(monthly) && /Gus Done/.test(monthly) && xlsx?.bytes.subarray(0, 2).toString() === "PK" && csv && /Ben Short/.test(csv.bytes.toString()), `${xlsx?.name} ${csv?.name}`);
  await go("/attendance?tab=missing");
  await waitFor(`!!document.querySelector('ul[aria-label="Missing clock-outs"]')`, "missing list");
  const eliItem = `[...document.querySelectorAll('ul[aria-label="Missing clock-outs"] > li')].find((li) => li.innerText.includes('Eli Forgot'))`;
  // Employee view first (Eli's banner needs the open shift); the admin files the correction below.
  const missingText = await js(`${eliItem}?.innerText ?? ''`);
  check("attendance missing: Eli's shift open since yesterday is listed with a Request correction action", /Request correction/.test(missingText), missingText.replace(/\n/g, " | ").slice(0, 200));

  // =========================== Employee /my (P7-02) =============================================
  await signIn(eli.email, "/my");
  const banner = await tryWait(`/You are still clocked in since/.test(document.querySelector('[data-testid="missing-clock-out-banner"]')?.innerText ?? '')`, "banner");
  check("employee /my: missing clock-out banner for a shift open since yesterday", banner);
  await click(`[...document.querySelectorAll('[data-testid="missing-clock-out-banner"] a')].find((a) => a.textContent.includes('Request a correction'))`);
  await waitFor(`location.pathname === '/my/attendance' && !!document.querySelector('form[aria-label="Request a correction"]')`, "correction form");
  const prefill = await tryWait(`document.querySelector('form[aria-label="Request a correction"] select')?.value === 'MISSING_CLOCK_OUT'`, "prefill", 10_000);
  check("employee: the /my banner link (?correct=missing-clock-out) pre-fills the correction form as a missing clock-out", prefill, await js(`document.querySelector('form[aria-label="Request a correction"] select')?.value`));
  await click(`[...document.querySelectorAll('[data-testid="missing-clock-out-banner"] button')].find((b) => b.textContent.includes('Request a correction'))`);
  check("employee: the /my/attendance banner button pre-fills the correction form as a missing clock-out", await tryWait(`document.querySelector('form[aria-label="Request a correction"] select')?.value === 'MISSING_CLOCK_OUT'`, "prefill button", 10_000));
  await waitFor(`!!document.querySelector('[data-testid="my-attendance-calendar"]')`, "calendar");
  const cap0 = await js(`document.querySelector('[data-testid="my-attendance-calendar"] caption').textContent`);
  await click(`document.querySelector('button[aria-label="Previous month"]')`);
  await waitFor(`document.querySelector('[data-testid="my-attendance-calendar"] caption')?.textContent !== ${JSON.stringify(cap0)}`, "previous month");
  const cap1 = await js(`document.querySelector('[data-testid="my-attendance-calendar"] caption').textContent`);
  const nextDisabledNow = await js(`(() => { document.querySelector('button[aria-label="Next month"]').click(); return true; })()`).then(() => tryWait(`document.querySelector('[data-testid="my-attendance-calendar"] caption')?.textContent === ${JSON.stringify(cap0)} && document.querySelector('button[aria-label="Next month"]').disabled`, "back to this month", 10_000));
  check("employee: monthly calendar renders with month navigation (previous, back; next disabled on the current month)", cap1 !== cap0 && nextDisabledNow, `${cap0} → ${cap1}`);
  const myScroll = await hscroll(["/my", "/my/attendance"], W375);
  check("employee: /my and /my/attendance at 375 px — no horizontal page scroll", myScroll.length === 0, myScroll.join(", "));

  // =========================== Team head (P7-03) ================================================
  await signIn(hana.email, "/my");
  await go("/my/team/attendance");
  await waitFor(`!!document.querySelector('table[aria-label="Live team attendance"]')`, "team table");
  const picker = await js(`[...document.querySelectorAll('main select')].map((s) => [...s.options].map((o) => o.textContent))`);
  const teamText = await text();
  const headTable = await js(`document.querySelector('table[aria-label="Live team attendance"]').innerText`);
  check("team head: /my/team/attendance has a picker for both teams, Late and Missing clock-out cards, 'Last seen' column",
    picker.some((o) => o.includes("Alpha") && o.includes("Beta")) && /Late arrivals/.test(teamText) && /Missing clock-outs/.test(teamText) && /Last seen/.test(headTable), JSON.stringify(picker));
  const devHead = await js(`[...document.querySelectorAll('table[aria-label="Live team attendance"] tr')].find((r) => r.innerText.includes('Dev Stale'))?.innerText ?? ''`);
  check("team head: stale member shows 'Last seen', never Online", /Last seen|ago/.test(devHead) && !/\bOnline\b/.test(devHead), devHead.replace(/\s+/g, " "));
  const firstTeam = await js(`document.querySelector('main select').value`);
  await js(setReact(`document.querySelector('main select')`, firstTeam === alpha.id ? beta.id : alpha.id));
  const switched = await tryWait(`(() => { const t = document.querySelector('table[aria-label="Live team attendance"]')?.innerText ?? ''; return ${firstTeam === alpha.id} ? /Cara Break/.test(t) && !/Dev Stale/.test(t) : /Dev Stale/.test(t) && !/Cara Break/.test(t); })()`, "team switch", 15_000);
  check("team head: switching the team picker reloads that team's members", switched);
  const outside = await api(`/attendance/missing-clock-outs?teamId=${randomUUID()}`, { cookie: await login(hana.email) });
  check("team head: a team they do not head → 404", outside.status === 404, String(outside.status));

  // =========================== Corrections (admin files, other admin approves) ==================
  await signIn("ceo@example.com", "/");
  await go("/attendance?tab=missing");
  await waitFor(`!!${eliItem}`, "eli anomaly");
  await click(byText(eliItem, "button", "Request correction"));
  const form = `document.querySelector('form[aria-label="Request correction for Eli Forgot"]')`;
  await waitFor(`!!${form}`, "admin correction form");
  await js(setReact(`${form}.querySelector('input[type=datetime-local]')`, `${yesterday}T17:30`));
  await js(setReact(`${form}.querySelector('textarea')`, "Parity check: forgot to clock out"));
  await js(`${form}.requestSubmit()`);
  const pendingShown = await tryWait(`/Correction pending review/.test(${eliItem}?.innerText ?? '')`, "pending", 15_000);
  check("corrections: Missing clock-outs → Request correction → 'Correction pending review'", pendingShown);
  await go("/corrections");
  const eliCard = `[...document.querySelectorAll('main article')].find((a) => a.innerText.includes('Eli Forgot'))`;
  await waitFor(`!!${eliCard}`, "eli correction card");
  const own = await js(`(() => { const b = ${byText(eliCard, "button", "Approve and apply")}; return { disabled: b?.disabled, why: b?.title, text: ${eliCard}.innerText }; })()`);
  check("corrections: the filing admin sees Approve disabled with the reason", own.disabled === true && /different administrator/.test(own.why ?? ""), own.why);
  await signIn("it@example.com", "/");
  await go("/corrections");
  await waitFor(`!!${eliCard}`, "eli card as it");
  await js(setReact(`${eliCard}.querySelector('input')`, "Checked with the employee"));
  await click(byText(eliCard, "button", "Approve and apply"));
  // The card either shows Approved or leaves the pending queue.
  const approved = await tryWait(`!${eliCard} || /Approved/.test(${eliCard}.innerText)`, "approved", 15_000);
  const eliOpen = Number((await one("SELECT count(*) AS n FROM attendance_sessions WHERE employee_id = ? AND clock_out_at IS NULL", [eli.id])).n);
  check("corrections: a second admin approves; Eli's shift is closed by the approved correction", approved && eliOpen === 0, `open sessions ${eliOpen}`);

  // Plain Admin: no screenshot export controls.
  await go("/screenshots");
  await waitFor(`document.querySelectorAll('main img, main button[aria-label^="Open screenshot"]').length > 0`, "gallery as admin");
  check("screenshots: plain Admin sees no select/export controls", !(await js(`!!document.querySelector('[role=group][aria-label="Export screenshots"]') || !!document.querySelector('input[aria-label^="Select screenshot"]')`)));

  // =========================== Employee profile ================================================
  await signIn("ceo@example.com", "/");
  await go(`/employees/${ben.id}`);
  await waitFor(`[...document.querySelectorAll('main p')].some((p) => p.textContent.trim() === 'Total worked') && !!document.querySelector('table[aria-label="Clock-in and clock-out log"]')`, "profile overview");
  const svgCharts = await js(`document.querySelectorAll('main svg[role=img], main figure svg, main svg').length`);
  check("profile: Overview KPIs, charts and the clock-in/out log render", (await statCard("Total worked")) !== null && svgCharts > 0 && /09:00/.test(await js(`document.querySelector('table[aria-label="Clock-in and clock-out log"]').innerText`)), `${svgCharts} svg`);
  apiCalls.length = 0;
  await click(byText("document", "button", "Last week"));
  await sleep(1500);
  check("profile: changing the range reloads the analytics", apiCalls.some((c) => c.includes(`/employees/${ben.id}/analytics?`)), apiCalls.join(" "));
  await click(`[...document.querySelectorAll('[role=tab]')].find((t) => t.textContent.trim() === 'Edit')`);
  check("profile: Edit tab opens the edit form", await tryWait(`location.search.includes('tab=edit') && !!document.querySelector('main form')`, "edit tab", 10_000));
  const profScroll = await hscroll([`/employees/${ben.id}`], W375);
  check("profile: 375 px — no page-level horizontal scroll", profScroll.length === 0, profScroll.join(", "));

  // =========================== Reports + timesheets =============================================
  const REPORTS = ["/reports", "/reports/daily-attendance", "/reports/monthly-attendance", "/reports/monthly-in-out", "/reports/late", "/reports/overtime", "/reports/summary", "/reports/scheduled", "/timesheets"];
  const repIssues = [];
  await cdp("Emulation.setDeviceMetricsOverride", { width: 375, height: 900, deviceScaleFactor: 1, mobile: true });
  for (const p of REPORTS) {
    apiFailures.length = 0;
    await go(p);
    await sleep(300);
    const sw = await js("document.documentElement.scrollWidth");
    if (sw > 375) repIssues.push(`${p}: scroll ${sw}`);
    if (!(await tablesScrollInside())) repIssues.push(`${p}: table not scrolling inside its card`);
    if (p.startsWith("/reports") && (await js(`document.querySelector('nav[aria-label=Reports] a[aria-current=page]')?.getAttribute('href')`)) !== p) repIssues.push(`${p}: SubNav active state`);
    if (apiFailures.length) repIssues.push(`${p}: ${apiFailures.join(" ")}`);
  }
  await cdp("Emulation.clearDeviceMetricsOverride");
  check("reports: every /reports/* page and /timesheets at 375 px — no page scroll, matrices scroll inside their card, SubNav marks the active page, no API failures", repIssues.length === 0, repIssues.join(" || "));
  await go(`/reports/daily-attendance`);
  await waitFor(`[...document.querySelectorAll('[role=tab]')].some((t) => /\\(\\d+\\)/.test(t.textContent))`, "daily tab counts");
  const dailyTabs = await js(`[...document.querySelectorAll('[role=tab]')].map((t) => t.textContent.trim())`);
  const dailyCsv = await download(byText("document", "button", "Export CSV"), ".csv");
  const dailyXlsx = await download(byText("document", "button", "Export XLSX"), ".xlsx");
  check("reports daily: tabs carry counts (Worked/Late/On leave/Absent) and CSV + XLSX exports download", dailyTabs.length === 4 && dailyTabs.every((t) => /\(\d+\)$/.test(t)) && !!dailyCsv && dailyXlsx?.bytes.subarray(0, 2).toString() === "PK", dailyTabs.join(", "));
  for (const [p, label] of [["/reports/monthly-attendance", "XLSX"], ["/reports/summary", "XLSX"]]) {
    await go(p);
    await loaded();
    const btn = byText("document.querySelector('main')", "button", `Export ${label}`);
    await waitFor(`!!${btn} && !${btn}.disabled`, `${p} export button`);
    const f = await download(btn, ".xlsx");
    check(`reports: ${p} export downloads an XLSX`, f?.bytes.subarray(0, 2).toString() === "PK", f?.name);
  }
  await go("/timesheets");
  await click(`[...document.querySelectorAll('[role=tab]')].find((t) => t.textContent.trim() === 'Week grid')`);
  await waitFor(`!!document.querySelector('table[aria-label="Week grid"]')`, "week grid");
  const range0 = await js(`document.querySelector('[role=group][aria-label=Week] span').textContent`);
  const grid = await js(`document.querySelector('table[aria-label="Week grid"]').innerText`);
  const absentTinted = await js(`[...document.querySelectorAll('table[aria-label="Week grid"] td')].some((td) => td.textContent.trim() === 'Absent' && /danger/.test(td.className))`);
  check("week grid: renders with Absent cells (text + red tint)", /Absent/.test(grid) && absentTinted);
  await click(`document.querySelector('button[aria-label="Previous week"]')`);
  const prevOk = await tryWait(`document.querySelector('[role=group][aria-label=Week] span').textContent !== ${JSON.stringify(range0)} && !!document.querySelector('table[aria-label="Week grid"]')`, "previous week", 10_000);
  await click(byText("document", "button", "This week"));
  const backOk = await tryWait(`document.querySelector('[role=group][aria-label=Week] span').textContent === ${JSON.stringify(range0)}`, "this week", 10_000);
  check("week grid: previous week / This week navigation", prevOk && backOk, range0);
  const hasIn = () => js(`[...document.querySelectorAll('table[aria-label="Week grid"] dt')].some((d) => d.textContent === 'IN')`);
  const inBefore = await hasIn();
  await click(`[...document.querySelectorAll('fieldset label')].find((l) => l.textContent.trim() === 'IN').querySelector('input')`);
  await sleep(200);
  check("week grid: column toggles hide a field (IN)", inBefore && !(await hasIn()));
  const rowsAll = await js(`document.querySelectorAll('table[aria-label="Week grid"] tbody tr').length`);
  await js(setReact(`document.querySelector('select[aria-label=Team]')`, beta.id));
  const narrowed = await tryWait(`(() => { const n = document.querySelectorAll('table[aria-label="Week grid"] tbody tr').length; return n > 0 && n < ${rowsAll}; })()`, "team grid", 15_000);
  check("week grid: team select narrows the rows (Beta)", narrowed, `${rowsAll} rows before`);

  // =========================== Settings + employees =============================================
  const SETTINGS = ["/settings", "/settings/schedule", "/settings/monitoring", "/settings/screenshots", "/settings/labels", "/settings/websites", "/settings/storage", "/settings/notifications", "/settings/leave-types"];
  const setIssues = [];
  await cdp("Emulation.setDeviceMetricsOverride", { width: 375, height: 900, deviceScaleFactor: 1, mobile: true });
  for (const p of SETTINGS) {
    apiFailures.length = 0;
    const { loaded: l } = await go(p).catch((e) => ({ loaded: String(e.message) }));
    await sleep(200);
    const sw = await js("document.documentElement.scrollWidth");
    if (sw > 375) setIssues.push(`${p}: scroll ${sw}`);
    if (l !== true) setIssues.push(`${p}: ${l === false ? "still loading" : l}`);
    if (apiFailures.length) setIssues.push(`${p}: ${apiFailures.join(" ")}`);
  }
  await cdp("Emulation.clearDeviceMetricsOverride");
  check("settings: every /settings/* sub-page loads at 375 px without page scroll or API failures", setIssues.length === 0, setIssues.join(" || "));
  await go("/employees");
  await waitFor(`!!document.querySelector('table[aria-label=Employees]')`, "employees");
  const empAll = await js(`document.querySelectorAll('table[aria-label=Employees] tbody tr').length`);
  await waitFor(`[...document.querySelectorAll('form select[name=teamId] option')].some((o) => o.value === ${JSON.stringify(alpha.id)})`, "team options");
  await js(setReact(`document.querySelector('form select[name=teamId]')`, alpha.id));
  await js(`document.querySelector('select[name=teamId]').form.requestSubmit()`);
  const empTeam = await tryWait(`document.querySelectorAll('table[aria-label=Employees] tbody tr').length === 4`, "alpha employees", 10_000);
  await js(setReact(`document.querySelector('form select[name=teamId]')`, ""));
  await js(setReact(`document.querySelector('form select[name=platform]')`, "macos"));
  await js(`document.querySelector('select[name=platform]').form.requestSubmit()`);
  const empPlatform = await tryWait(`(() => { const t = document.querySelector('table[aria-label=Employees]')?.innerText ?? ''; return !/Fay Noapp/.test(t) && /Ana Desk/.test(t); })()`, "platform filter", 10_000);
  check("employees: Team and Platform filters narrow the list (Alpha → 4; macOS hides the employee without a device)", empAll >= 9 && empTeam && empPlatform, `${empAll} rows`);

  // =========================== Timeline + screenshots ===========================================
  await go("/timeline");
  await waitFor(`!!document.querySelector('section[aria-label="Employee timelines"] a[href^="/employees/"]')`, "timeline rows");
  const tlRows = () => js(`document.querySelectorAll('section[aria-label="Employee timelines"] a[href^="/employees/"]').length`);
  const tlAll = await tlRows();
  await js(setReact(`document.querySelector('select[aria-label=Team]')`, beta.id));
  const tlTeam = await tryWait(`(() => { const n = document.querySelectorAll('section[aria-label="Employee timelines"] a[href^="/employees/"]').length; return n === 2; })()`, "timeline team", 15_000);
  check("timeline: the team filter changes the rows (Beta → 2)", tlAll >= 9 && tlTeam, `${tlAll} rows`);
  await click(`document.querySelector('section[aria-label="Employee timelines"] a[href^="/employees/"]')`);
  check("timeline: a row opens the employee profile", await tryWait(`location.pathname.startsWith('/employees/') && !!document.querySelector('main h1')`, "profile", 10_000));
  const tlScroll = await hscroll(["/timeline"], W375);
  check("timeline: 375 px — no page-level horizontal scroll (rows scroll inside the card)", tlScroll.length === 0, tlScroll.join(", "));
  await go("/screenshots");
  await waitFor(`document.querySelectorAll('main button[aria-label^="Open screenshot"]').length === 3`, "gallery");
  const idleCards = await js(`[...document.querySelectorAll('main button[aria-label^="Open screenshot"]')].map((b) => { const card = b.parentElement; return { idle: /\\bIdle\\b/.test(card.innerText), red: /border-danger/.test(card.className) }; })`);
  check("screenshots: the capture inside an idle interval has a red border and an 'Idle' label (only that one)", idleCards.filter((c) => c.idle && c.red).length === 1 && idleCards.filter((c) => c.idle || c.red).length === 1, JSON.stringify(idleCards));
  await click(byText("document", "button", "Idle only"));
  const idleOnly = await tryWait(`document.querySelector('main button[aria-pressed]')?.getAttribute('aria-pressed') === 'true' && document.querySelectorAll('main button[aria-label^="Open screenshot"]').length === 1`, "idle only", 10_000);
  check("screenshots: 'Idle only' (aria-pressed) shows only the idle capture", idleOnly);
  await click(byText("document", "button", "Idle only"));
  await waitFor(`document.querySelectorAll('main button[aria-label^="Open screenshot"]').length === 3`, "all again");
  await click(byText("document", "button", "Select all on this page"));
  const zipBtn = byPrefix("document", "button", "Export 3 as ZIP");
  await waitFor(`!!${zipBtn} && !${zipBtn}.disabled`, "export enabled");
  const exportsBefore = Number((await one("SELECT count(*) AS n FROM screenshot_access_log WHERE screenshot_id IN (?, ?, ?)", anaShots)).n);
  const zip = await download(zipBtn, ".zip");
  let unzipOk = false;
  let entries = 0;
  if (zip) {
    const r = spawnSync("unzip", ["-t", join(DOWNLOADS, zip.name)], { encoding: "utf8" });
    unzipOk = r.status === 0 && /No errors detected/.test(r.stdout);
    entries = (r.stdout.match(/testing: /g) ?? []).length;
  }
  const exportsAfter = Number((await one("SELECT count(*) AS n FROM screenshot_access_log WHERE screenshot_id IN (?, ?, ?)", anaShots)).n);
  check("screenshots: Super Admin selects all and exports a valid ZIP (unzip -t, 3 entries), each export access-logged", unzipOk && entries === 3 && exportsAfter - exportsBefore === 3, `${zip?.name} entries=${entries} log +${exportsAfter - exportsBefore}`);
  void idleShot;

  // =========================== Activity + risk users ============================================
  const actIssues = [];
  for (const t of ["summary", "employees", "history", "review", "employee"]) {
    apiFailures.length = consoleErrors.length = 0;
    const { loaded: l } = await go(`/activity?tab=${t}`);
    const sel = await js(`[...document.querySelectorAll('[role=tab]')].find((x) => x.getAttribute('aria-selected') === 'true')?.textContent.trim()`);
    if (!l || !sel) actIssues.push(`${t}: ${l ? "" : "not loaded "}${sel ?? "no selected tab"}`);
    const f = noFailures();
    if (f.length) actIssues.push(`${t}: ${f.join(" ")}`);
  }
  await go("/activity?tab=summary");
  const actText = await text();
  check("activity: every tab renders without API failures; Summary shows the synced apps", actIssues.length === 0 && /Code Editor/.test(actText), actIssues.join(" || "));
  await go("/risk-users");
  await waitFor(`!!document.querySelector('table[aria-label="Risky users"]')`, "risky users");
  const risky = await js(`document.querySelector('table[aria-label="Risky users"]').innerText`);
  check("risk users: renders with data (Ben's 3-hour days are flagged)", /Ben Short/.test(risky), risky.slice(0, 160).replace(/\n/g, " | "));

  // =========================== Theme + keyboard =================================================
  await go("/");
  const theme0 = await js("document.documentElement.dataset.theme ?? 'light'");
  await click(`document.querySelector('[data-testid=theme-toggle]')`);
  const theme1 = await js("document.documentElement.dataset.theme");
  await go("/live-team");
  const theme2 = await js("document.documentElement.dataset.theme");
  await cdp("Page.reload");
  await waitFor(`!!document.querySelector('main h1')`, "reload");
  const theme3 = await js("document.documentElement.dataset.theme");
  check("theme: the toggle switches the theme and it persists across navigation and reload", theme0 !== theme1 && theme1 === theme2 && theme2 === theme3, `${theme0} → ${theme1} → ${theme2} → ${theme3}`);
  await click(`document.querySelector('[data-testid=theme-toggle]')`);
  let navFocus = null;
  for (let i = 0; i < 40 && !navFocus; i++) {
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    navFocus = await js(`(() => { const a = document.activeElement; if (!a?.closest('nav[aria-label="Main"]')) return null; const s = getComputedStyle(a); return { fv: a.matches(':focus-visible'), ring: s.boxShadow !== 'none' || (s.outlineStyle !== 'none' && s.outlineWidth !== '0px'), href: a.getAttribute('href') }; })()`);
  }
  check("keyboard: Tab reaches the main navigation with a visible focus ring", navFocus?.fv && navFocus.ring, JSON.stringify(navFocus));
  await shot("parity-overview.png");
} catch (err) {
  check("run aborted", false, String(err?.stack ?? err?.message ?? err).split("\n").slice(0, 3).join(" "));
  await shot("failure.png").catch(() => undefined);
} finally {
  dash.kill();
  chrome.kill();
  await app.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed${existsSync(OUT) ? ` · artifacts in ${OUT}` : ""}`);
process.exit(failed ? 1 : 0);
