// P2 runtime check: the employee web panel (/my/*) in the dashboard production build (:3103), headless
// Chrome, against a throwaway API (temporary file DB, local screenshot storage) on :4000. Two employees
// (Ana signs in; Ben's records must never appear), a Super Admin and an IT Admin. Synthetic data only.
// Run after `pnpm build`. Needs Google Chrome (macOS path) and free ports 4000 and 3103.
// Usage: pnpm --filter @workfolio/dashboard verify:my-panel [out-dir]
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = process.argv[2] ?? mkdtempSync(join(tmpdir(), "wf-verify-my-panel-"));
const RUN = join(OUT, "run");
rmSync(RUN, { recursive: true, force: true });
mkdirSync(join(RUN, "shots"), { recursive: true });
const APP = "http://localhost:3103";
Object.assign(process.env, {
  NODE_ENV: "development", LOG_LEVEL: "warn", PORT: "4000",
  DATABASE_URL: `file:${join(RUN, "panel.db")}`,
  JWT_SECRET: "panel-check-secret-panel-check-secret-xyz",
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
const { DEFAULT_NOTICE_VERSION: ACTIVITY_NOTICE, addDays, localDate } = await import(`${ROOT}/packages/shared/dist/index.js`);
const SHOT_NOTICE = "2026-10-screenshots-draft-1";
const PASSWORD = "panel check password 1";
const M = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const results = [];
const check = (name, ok, detail = "") => (results.push({ name, ok }), console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`));
const BEN_MARKERS = ["Ben Other", "MP-2", "Ben Secret App", "BEN-LEAVE-REASON", "Ben Project", "Ben task"];

// ---- API and synthetic data -------------------------------------------------------------------
const app = await NestFactory.create(AppModule, { logger: ["error", "warn"] });
configureApp(app);
await app.listen(4000);
const db = app.get(DATABASE);
const api = async (path, { method = "GET", body, raw, cookie, bearer, device } = {}) => {
  const headers = { origin: APP };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (raw) headers["content-type"] = "image/webp";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (device) headers["x-device-id"] = device;
  const res = await fetch(`http://localhost:4000/api/v1${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  return { status: res.status, body: text && (res.headers.get("content-type") ?? "").includes("json") ? JSON.parse(text) : undefined, res };
};
const ok = (r, what) => {
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const superId = randomUUID();
await db.execute({ sql: "INSERT INTO users (id, email, role, admin_title, password_hash) VALUES (?, 'ceo@example.com', 'ADMIN', 'SUPER_ADMIN', ?), (?, 'it@example.com', 'ADMIN', 'ADMIN', ?)", args: [superId, await hashPassword(PASSWORD), randomUUID(), await hashPassword(PASSWORD)] });
const adminCookie = (await api("/auth/login", { method: "POST", body: { email: "ceo@example.com", password: PASSWORD } })).res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const policy = (selfView, effectiveAt = Date.now()) =>
  db.execute({
    sql: `INSERT INTO screenshot_policies (screenshots_enabled, mask_regions, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
            retention_approved, notice_version, employee_self_view, reason, changed_by, effective_at) VALUES (1, '[{"x":0,"y":0,"w":2000,"h":1000,"label":"Clock"}]', 60, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, ?, ?, 'panel check', ?, ?)`,
    args: [SHOT_NOTICE, selfView ? 1 : 0, superId, iso(effectiveAt)],
  });
await policy(true, Date.now() - 2 * 86_400_000);
const yesterday = addDays(localDate(Date.now(), "UTC"), -1);
async function employee(n, name) {
  const email = `panel${n}@example.com`;
  const r = ok(await api("/employees", { method: "POST", cookie: adminCookie, body: { email, employeeCode: `MP-${n}`, fullName: name, timezone: "UTC" } }), "employee");
  await api("/auth/setup-password", { method: "POST", body: { token: r.setup.token, password: PASSWORD } });
  const bearer = (await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } })).body.accessToken;
  const e = { id: r.employee.id, email, bearer, device: randomUUID() };
  ok(await api("/devices/register", { method: "POST", bearer, body: { installationId: e.device, deviceName: `${name.split(" ")[0]}'s Mac`, platform: "macos" } }), "device");
  for (const v of [SHOT_NOTICE, ACTIVITY_NOTICE]) await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), e.id, v, iso(Date.now() - 300 * M)] });
  // Yesterday 09:00–17:00 UTC with a 30-minute break; today an open shift since two hours ago.
  const y = (h, m = 0) => iso(Date.parse(`${yesterday}T00:00:00Z`) + (h * 60 + m) * M);
  const events = [["CLOCK_IN", y(9)], ["BREAK_START", y(12)], ["BREAK_END", y(12, 30)], ["CLOCK_OUT", y(17)], ["CLOCK_IN", iso(Date.now() - 120 * M)]];
  const sync = ok(await api("/attendance/sync", { method: "POST", bearer, device: e.device, body: { sentAt: iso(Date.now()), events: events.map(([type, occurredAt]) => ({ id: randomUUID(), type, occurredAt })) } }), "attendance");
  if (!sync.results.every((x) => x.status === "ACCEPTED")) throw new Error(`attendance sync: ${JSON.stringify(sync)}`);
  return e;
}
const ana = await employee(1, "Ana Employee");
const ben = await employee(2, "Ben Other");
const activity = (e, rows) =>
  api("/activity/sync", { method: "POST", bearer: e.bearer, device: e.device, body: { sentAt: iso(Date.now()), platform: "macos", intervals: rows.map(([app, from, to]) => ({ id: randomUUID(), kind: app ? "ACTIVE" : "IDLE", applicationIdentifier: app ? `com.example.${app.replace(/\W/g, "")}` : null, applicationName: app, startedAt: iso(Date.now() - from * M), endedAt: iso(Date.now() - to * M) })) } });
ok(await activity(ana, [["Code Editor", 100, 70], [null, 70, 60], ["Mail", 60, 40]]), "ana activity");
ok(await activity(ben, [["Ben Secret App", 100, 50]]), "ben activity");
async function project(code, name, who, task) {
  const p = ok(await api("/projects", { method: "POST", cookie: adminCookie, body: { code, name, description: `${name} description` } }), "project");
  ok(await api(`/projects/${p.id}/members`, { method: "POST", cookie: adminCookie, body: { employeeId: who.id } }), "member");
  const t = ok(await api(`/projects/${p.id}/tasks`, { method: "POST", cookie: adminCookie, body: { title: task } }), "task");
  return { id: p.id, taskId: t.tasks?.find((x) => x.title === task)?.id ?? t.id };
}
const anaProject = await project("AP-1", "Ana Project", ana, "Write the spec");
await project("BP-1", "Ben Project", ben, "Ben task");
const timer = ok(await api("/task-time/start", { method: "POST", bearer: ana.bearer, body: { taskId: anaProject.taskId } }), "timer start");
await new Promise((r) => setTimeout(r, 1200));
ok(await api(`/task-time/${timer.running?.id ?? timer.id}/stop`, { method: "POST", bearer: ana.bearer }), "timer stop");
ok(await api("/task-time/start", { method: "POST", bearer: ana.bearer, body: { taskId: anaProject.taskId } }), "timer running");
ok(await api("/leave", { method: "POST", bearer: ana.bearer, body: { startDate: addDays(yesterday, 20), endDate: addDays(yesterday, 20), portion: "FULL_DAY", reason: "Ana family event" } }), "ana leave");
ok(await api("/leave", { method: "POST", bearer: ben.bearer, body: { startDate: addDays(yesterday, 21), endDate: addDays(yesterday, 21), portion: "FULL_DAY", reason: "BEN-LEAVE-REASON" } }), "ben leave");

// ---- Chrome over CDP -------------------------------------------------------------------------
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--remote-debugging-port=9341", `--user-data-dir=${join(RUN, "chrome")}`, "--window-size=1280,1000", "--no-first-run", "about:blank"], { stdio: "ignore" });
let target;
for (let i = 0; i < 150 && !target; i++) {
  await new Promise((r) => setTimeout(r, 200));
  target = await fetch("http://127.0.0.1:9341/json/new?about:blank", { method: "PUT" }).then((r) => r.json(), () => null);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pending = new Map();
const consoleErrors = [];
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
  if (msg.method === "Runtime.consoleAPICalled" && ["log", "info", "debug"].includes(msg.params.type)) consoleErrors.push(`console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description).join(" ")}`);
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
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 120))) if (await js(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${label}`);
};
const shot = async (name) => writeFileSync(join(OUT, name), Buffer.from((await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true })).data, "base64"));
await cdp("Page.enable");
await cdp("Runtime.enable");
const DOWNLOADS = join(RUN, "downloads");
mkdirSync(DOWNLOADS);
await cdp("Page.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOADS });

/** Synthetic WebP from a canvas (no real screen). */
const webp = async (n) => Buffer.from(await js(`(async () => {
  const c = document.createElement("canvas"); c.width = 640; c.height = 360; const g = c.getContext("2d");
  g.fillStyle = "hsl(${(n * 67) % 360} 70% 75%)"; g.fillRect(0, 0, 640, 360); g.fillStyle = "#000"; g.fillRect(0, 0, 128, 36);
  const b = await new Promise((r) => c.toBlob(r, "image/webp", 0.8)); const u = new Uint8Array(await b.arrayBuffer());
  let s = ""; for (const x of u) s += String.fromCharCode(x); return btoa(s);
})()`), "base64");
async function upload(e, minutesAgo, n) {
  const bytes = await webp(n);
  const id = randomUUID();
  const reg = await api("/screenshots/register", { method: "POST", bearer: e.bearer, device: e.device, body: { id, capturedAt: iso(Date.now() - minutesAgo * M), sentAt: iso(Date.now()), width: 640, height: 360, sizeBytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), mimeType: "image/webp", masks: [{ x: 0, y: 0, w: 2000, h: 1000 }] } });
  if (reg.body?.status !== "REGISTERED") throw new Error(`register: ${JSON.stringify(reg.body)}`);
  ok(await api(`/screenshots/${id}/content`, { method: "PUT", bearer: e.bearer, device: e.device, raw: bytes }), "screenshot content");
  return (await db.execute({ sql: "SELECT id FROM screenshots WHERE idempotency_key = ?", args: [id] })).rows[0].id;
}
for (const [i, m] of [30, 20, 10].entries()) await upload(ana, m, i);
const benShot = await upload(ben, 15, 9);

const dash = spawn("pnpm", ["exec", "next", "start", "--port", "3103"], { cwd: `${ROOT}/apps/dashboard`, stdio: "ignore" });
for (let i = 0; i < 150 && !(await fetch(`${APP}/login`).then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 200));

const go = async (path) => {
  await cdp("Page.navigate", { url: `${APP}${path}` });
  await waitFor(`location.pathname === ${JSON.stringify(path)} && !!document.querySelector('main h1')`, `${path} heading`);
  // every section finished loading (no "Loading …" status left)
  await waitFor(`![...document.querySelectorAll('[role=status]')].some((e) => /^Loading/.test(e.textContent))`, `${path} loaded`);
};
const text = () => js(`document.querySelector('main').innerText`);
const h1 = () => js(`document.querySelector('main h1').textContent`);
const table = (label) => js(`document.querySelector('table[aria-label=${JSON.stringify(label)}]')?.innerText ?? null`);
const noBen = (t) => BEN_MARKERS.every((m) => !t.includes(m));
const setReact = (sel, value) => `(() => { const el = ${sel}; const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); })()`;
/** Inputs, selects and textareas without an accessible name. */
const unlabelled = () => js(`[...document.querySelectorAll('main input, main select, main textarea')].filter((el) => el.type !== 'hidden' && !el.closest('label') && !el.getAttribute('aria-label') && !(el.id && document.querySelector('label[for="' + el.id + '"]'))).length`);
async function signIn(email) {
  await cdp("Network.clearBrowserCookies").catch(() => undefined);
  await cdp("Page.navigate", { url: `${APP}/login` });
  await waitFor(`(() => { const f = document.querySelector('form'); return !!f && Object.keys(f).some((k) => k.startsWith('__reactProps')); })()`, "login form");
  await js(`(() => { const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
    set(document.querySelector('input[type=email], input[name=email]'), ${JSON.stringify(email)}); set(document.querySelector('input[type=password]'), ${JSON.stringify(PASSWORD)}); document.querySelector('form').requestSubmit(); })()`);
}

const PAGES = ["/my", "/my/attendance", "/my/activity", "/my/websites", "/my/screenshots", "/my/projects", "/my/tasks", "/my/leave", "/my/reports", "/my/profile"];
try {
  await cdp("Network.enable");
  // ---- Ana: routed to the employee panel ---------------------------------------------------------
  await signIn(ana.email);
  await waitFor(`location.pathname === '/my' && !!document.querySelector('main h1')`, "employee lands on /my");
  await go("/my");
  let t = await text();
  check("sign-in: employee lands on /my (My dashboard) with the employee navigation, not the admin sidebar", (await h1()) === "My dashboard" && (await js(`!!document.querySelector('nav[aria-label="My workspace"]') && !document.querySelector('nav[aria-label="Main"]')`)) && (await js(`document.querySelectorAll('nav[aria-label="My workspace"] a').length`)) === 10);
  check("dashboard: welcome, attendance state, today's activity, website card, project + running timer, pending leave, recent screenshots", /Welcome, Ana Employee/.test(t) && /Clocked in/.test(t) && /Code Editor/.test(t) && /Website activity today/.test(t) && /Ana Project/.test(t) && /Timer running: Ana Project · Write the spec/.test(t) && (await js(`document.querySelector('ul[aria-label="My pending leave"]')?.children.length`)) === 1 && (await js(`document.querySelectorAll('ul[aria-label="Recent screenshots"] li').length`)) === 3, t.slice(0, 300).replace(/\n/g, " | "));
  check("dashboard: desktop app section with a macOS and a Windows card, each either a /downloads/ link or a disabled button", (await js(`(() => { const s = document.querySelector('section[aria-label="Desktop app"]'); return !!s && ['macos', 'windows'].every((p) => { const c = s.querySelector('[data-platform=' + p + ']'); const a = c?.querySelector('a[download]'); return !!c && (a ? /^\\/(desktop-)?downloads\\//.test(new URL(a.href).pathname) && a.origin === location.origin : c.querySelector('button')?.disabled === true); }); })()`)) === true);
  // The card reads the VPS release manifest at runtime (written by deploy/scripts/desktop-downloads-receiver.py).
  // Serve one to the browser: what it publishes is what the employee sees, and a bad entry is ignored.
  {
    const live = {
      windows: { version: "9.8.7", releasedAt: "2026-11-19", file: "insight-workfolio_9.8.7_windows-x86_64-setup.exe", href: "/desktop-downloads/insight-workfolio_9.8.7_windows-x86_64-setup.exe", arch: "64-bit (x64)", sizeBytes: 5242880, sha256: "a".repeat(64), commit: "0".repeat(40), notes: "Faster start.\nFixes the clock-in button." },
      macos: { version: "9.8.7", releasedAt: "2026-11-19", file: "evil.dmg", href: "https://example.invalid/evil.dmg", arch: "Universal", sizeBytes: 1, sha256: "b".repeat(64) },
    };
    const onPaused = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.method === "Fetch.requestPaused") void cdp("Fetch.fulfillRequest", { requestId: msg.params.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(JSON.stringify(live)).toString("base64") });
    };
    ws.addEventListener("message", onPaused);
    await cdp("Fetch.enable", { patterns: [{ urlPattern: "*/desktop-downloads/desktop-releases.json" }] });
    await go("/my");
    await waitFor(`document.querySelector('[data-platform=windows] a[download]')?.getAttribute('href') === ${JSON.stringify(live.windows.href)}`, "the published Windows release on the card");
    const card = await js(`(() => { const s = document.querySelector('section[aria-label="Desktop app"]'); const of = (p) => s.querySelector('[data-platform=' + p + ']').closest('section');
      return { win: of('windows').innerText, winAll: of('windows').textContent, mac: of('macos').innerText, macHref: of('macos').querySelector('a[download]')?.getAttribute('href') ?? null, first: s.querySelector('[data-platform]').dataset.platform }; })()`);
    check("dashboard: the published manifest drives the Windows card (latest version, release date, size, release notes, checksum, link)", /Latest version 9\.8\.7/.test(card.win) && /Released/.test(card.win) && /5\.0 MB/.test(card.win) && card.win.includes("Faster start.") && card.win.includes("Fixes the clock-in button.") && card.winAll.includes("a".repeat(64)), card.win.replace(/\s+/g, " ").slice(0, 160));
    check("dashboard: a manifest entry linking to another site is ignored; the bundled installer stays", !!card.macHref?.startsWith("/downloads/") && !/9\.8\.7/.test(card.mac), String(card.macHref));
    check("dashboard: the installer for this computer (a Mac here) comes first and is marked", card.first === "macos" && /This computer/.test(card.mac) && !/This computer/.test(card.win));
    await cdp("Fetch.disable");
    ws.removeEventListener("message", onPaused);
    await go("/my");
  }
  await waitFor(`[...document.querySelectorAll('ul[aria-label="Recent screenshots"] img')].length === 3 && [...document.querySelectorAll('ul[aria-label="Recent screenshots"] img')].every((i) => i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0)`, "dashboard thumbnails");
  check("dashboard: thumbnails load as blob URLs through the API (no image URL in the page)", !(await js(`document.documentElement.outerHTML`)).includes("/content"));
  check("dashboard: no productivity score or ranking", !/score|rank/i.test(t));
  await shot("my-dashboard.png");

  await go("/my/attendance");
  await js(setReact(`document.querySelector('main input[type=date]')`, yesterday));
  await waitFor(`document.querySelector("main input[type=date]").value === ${JSON.stringify(yesterday)}`, "range start set to yesterday");
  await new Promise((r) => setTimeout(r, 300));
  await waitFor(`![...document.querySelectorAll('[role=status]')].some((e) => /^Loading/.test(e.textContent))`, "range from yesterday");
  t = await text();
  const hist = await table("My attendance history");
  check("attendance: current state, timesheet with yesterday's 7h 30m, history with break and the open shift, corrections table", (await h1()) === "My attendance" && /7h 30m/.test((await table("My timesheet")) ?? "") && /Open/.test(hist ?? "") && /0h 30m/.test(hist ?? "") && ((await table("My correction requests")) !== null || /not requested any corrections/.test(t)), (hist ?? "").slice(0, 200).replace(/\n/g, " | "));
  check("attendance: read-only on the web (no clock-in/out or break buttons; desktop note)", !(await js(`[...document.querySelectorAll('main button')].some((b) => /clock|break/i.test(b.textContent))`)) && /desktop app/i.test(t));

  {
    const f = `document.querySelector('form[aria-label="Request a correction"]')`;
    // empty submit -> client-side validation messages, nothing sent
    await js(`(() => { const el = ${f}.querySelector('select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, "MISSING_CLOCK_IN"); el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await waitFor(`${f}.querySelectorAll('input[type="datetime-local"]').length === 2`, "missing-shift fields");
    await js(`${f}.requestSubmit()`);
    await waitFor(`/Required/.test(${f}.innerText) && /at least 3 characters/.test(${f}.innerText)`, "validation errors");
    check("correction form: client-side validation (required times, reason length)", true);
    await js(setReact(`${f}.querySelectorAll('input[type="datetime-local"]')[0]`, `${yesterday}T18:00`));
    await js(setReact(`${f}.querySelectorAll('input[type="datetime-local"]')[1]`, `${yesterday}T19:00`));
    await js(setReact(`${f}.querySelector('textarea')`, "Forgot to start the app in the evening"));
    await js(`${f}.requestSubmit()`);
    await waitFor(`/Correction requested/.test(document.querySelector('main').innerText) && /Missing shift/.test(document.querySelector('table[aria-label="My correction requests"]')?.innerText ?? '')`, "correction created");
    const rows = await api("/attendance/corrections?mine=true", { bearer: ana.bearer });
    check("correction form: request created with UTC times from the employee zone and listed", rows.body.items.some((c) => c.type === "MISSING_CLOCK_IN" && c.proposed.clockInAt === `${yesterday}T18:00:00.000Z` && c.status === "PENDING"), JSON.stringify(rows.body.items.map((c) => c.proposed)));
    await js(`(() => { const el = ${f}.querySelector('select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, "MISSING_CLOCK_IN"); el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await js(setReact(`${f}.querySelectorAll('input[type="datetime-local"]')[0]`, `${yesterday}T10:00`));
    await js(setReact(`${f}.querySelectorAll('input[type="datetime-local"]')[1]`, `${yesterday}T11:00`));
    await js(setReact(`${f}.querySelector('textarea')`, "Overlap test"));
    await js(`${f}.requestSubmit()`);
    await waitFor(`/overlaps an existing shift/.test(${f}.innerText)`, "409 shown");
    check("correction form: server 409 (overlap) shown in the form", true);
  }
  await go("/my/activity");
  t = await text();
  check("activity: per-application totals and timeline from the API, active/idle/no-record labels", (await h1()) === "My activity" && /Code Editor/.test((await table("My application activity")) ?? "") && /Mail/.test((await table("My application activity")) ?? "") && /Code Editor/.test((await table("My activity timeline")) ?? "") && /Active \(an application in front\)/.test(t) && /Idle/.test(t) && /No record/.test(t));
  check("activity: website summary links to /my/websites; no titles or URLs", (await js(`!!document.querySelector('main a[href="/my/websites"]')`)) && !/https?:\/\//.test(t));
  await js(`[...document.querySelectorAll('main button')].find((b) => /previous/i.test(b.textContent))?.click()`);
  await waitFor(`![...document.querySelectorAll('[role=status]')].some((e) => /^Loading/.test(e.textContent))`, "previous day");
  check("activity: date navigation (previous day has no Ana app activity seeded)", !/Code Editor/.test((await table("My application activity")) ?? ""));

  await go("/my/websites");
  check("websites (F04 page, moved): loads with status and the never-recorded list", /My website activity/.test(await h1()) && /Never recorded/i.test(await text()));

  await go("/my/screenshots");
  await waitFor(`document.querySelectorAll('ul[aria-label="My screenshots list"] img').length === 3`, "screenshot thumbnails");
  t = await text();
  check("screenshots: own 3 screenshots with capture time and masking info; viewing is logged (said)", (await h1()) === "My screenshots" && /1 masked area/.test(t) && /logged/i.test(t));
  await js(`document.querySelector('ul[aria-label="My screenshots list"] button').click()`);
  await waitFor(`document.querySelector('dialog[aria-label="Screenshot viewer"]')?.open && document.querySelector('dialog img')?.naturalWidth > 0`, "viewer");
  check("screenshots: viewer is a modal dialog with the full image and mask labels", (await js(`document.querySelector('dialog[aria-label="Screenshot viewer"]').innerText`)).includes("Clock"));
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await waitFor(`!document.querySelector('dialog[aria-label="Screenshot viewer"]')`, "viewer closed by Escape");
  check("screenshots: Escape closes the viewer", true);
  const benContent = await js(`fetch("http://localhost:4000/api/v1/screenshots/${benShot}/content?variant=thumbnail", { credentials: "include" }).then((r) => r.status)`);
  const benList = await js(`fetch("http://localhost:4000/api/v1/screenshots?employeeId=${ben.id}", { credentials: "include" }).then((r) => r.status)`);
  check("screenshots: Ben's image and list refused to Ana's browser session (404)", benContent === 404 && benList === 404, `${benContent}/${benList}`);
  await shot("my-screenshots.png");

  await go("/my/projects");
  t = await text();
  check("projects: Ana's project with description and task; not Ben's", (await h1()) === "My projects" && /Ana Project/.test(t) && /Ana Project description/.test(t) && /Write the spec/.test(t) && noBen(t));

  await go("/my/tasks");
  t = await text();
  const entries = await table("My time entries");
  check("tasks: current timer shown, tasks table, time entries (one stopped, one running)", (await h1()) === "My tasks" && /Write the spec/.test((await js(`document.querySelector('section[aria-label="Current timer"]').innerText`)) ?? "") && /Write the spec/.test((await table("My tasks")) ?? "") && (entries ?? "").split("\n").length >= 3, (entries ?? "").replace(/\n/g, " | ").slice(0, 200));
  check("tasks: no start/pause/stop controls on the web", !(await js(`[...document.querySelectorAll('main button')].some((b) => /start|pause|stop/i.test(b.textContent))`)));

  await go("/my/leave");
  const before = await table("My leave requests");
  const form = `document.querySelector('form[aria-label="New leave request"]')`;
  const date = addDays(yesterday, 30);
  await js(setReact(`${form}.querySelector('input[type=date]')`, date));
  await js(setReact(`${form}.querySelectorAll('input[type=date]')[1]`, date));
  await js(setReact(`${form}.querySelector('textarea')`, "Panel check leave"));
  await js(`${form}.requestSubmit()`);
  await waitFor(`document.querySelector('table[aria-label="My leave requests"]')?.innerText.includes('Panel check leave')`, "new leave in history");
  check("leave: existing request listed; new full-day request created from the form and listed as pending", /Ana family event/.test(before ?? "") && /Pending/i.test((await table("My leave requests")) ?? "") && noBen((await table("My leave requests")) ?? ""));
  const row = `[...document.querySelectorAll('table[aria-label="My leave requests"] tbody tr')].find((r) => r.innerText.includes('Panel check leave'))`;
  await js(`[...${row}.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Cancel').click()`);
  await waitFor(`[...${row}.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Yes, cancel')`, "inline confirmation");
  await js(`[...${row}.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Yes, cancel').click()`);
  await waitFor(`/cancel/i.test(${row}?.innerText ?? '') && ![...(${row}?.querySelectorAll('button') ?? [])].some((b) => b.textContent.trim() === 'Cancel')`, "cancelled");
  check("leave: inline cancel confirmation; request cancelled; no balances or entitlements shown", !/balance:|entitled|accrued/i.test(await text()));

  await go("/my/reports");
  await js(setReact(`document.querySelector('main input[type=date]')`, yesterday));
  await waitFor(`document.querySelector("main input[type=date]").value === ${JSON.stringify(yesterday)}`, "range start set to yesterday");
  await new Promise((r) => setTimeout(r, 300));
  await waitFor(`![...document.querySelectorAll('[role=status]')].some((e) => /^Loading/.test(e.textContent))`, "range from yesterday");
  t = await text();
  check("reports: attendance summary and activity summary for the range; draft export label", (await h1()) === "My reports" && /7h 30m/.test(t) && /Code Editor/.test(t) && /not yet approved for payroll/i.test(t));
  await js(`document.querySelector('form[aria-label="Export my timesheet"]').requestSubmit()`);
  await waitFor(`/Downloaded workfolio-timesheet-draft1_MP-1_/.test(document.querySelector('main').innerText)`, "export status");
  let file = null;
  for (let i = 0; i < 100 && !file; i++) {
    const f = readdirSync(DOWNLOADS).find((x) => x.endsWith(".csv"));
    if (f && statSync(join(DOWNLOADS, f)).size > 0) file = readFileSync(join(DOWNLOADS, f), "utf8");
    else await new Promise((r) => setTimeout(r, 100));
  }
  check("reports: CSV export downloaded with Ana's rows only", !!file && file.includes("MP-1") && !file.includes("MP-2") && file.includes("Ana Employee"), file ? `${file.split("\r\n").length - 2} rows` : "no file");

  await go("/my/profile");
  t = await text();
  check("profile: account details, role Employee, own device, notice statuses, read-only (no inputs)", (await h1()) === "My profile" && t.includes(ana.email) && /MP-1/.test(t) && /Employee/.test(t) && /Ana's Mac/.test((await table("My devices")) ?? "") && /acknowledged/i.test(t) && (await js(`document.querySelectorAll('main input, main textarea, main select').length`)) === 0 && noBen(t));

  // ---- Sessions (P1): list, current flag, revoke another session from the page ----------------------
  const second = (await api("/auth/login", { method: "POST", body: { email: ana.email, password: PASSWORD } })).res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  await go("/my/profile");
  const rows = `[...document.querySelectorAll('table[aria-label="My sessions"] tbody tr')]`;
  await waitFor(`${rows}.length >= 3`, "sessions listed");
  const sessionsBefore = await js(`${rows}.length`);
  check("sessions: own sessions listed (web and desktop), exactly one marked as this session; no tokens in the page", (await js(`${rows}.filter((r) => r.innerText.includes('This session')).length`)) === 1 && /Desktop/.test((await table("My sessions")) ?? "") && /Web/.test((await table("My sessions")) ?? "") && !(await js(`document.documentElement.outerHTML`)).includes(second.split("=")[1]?.slice(0, 20) ?? "§"));
  await js(`[...${rows}.find((r) => !r.innerText.includes('This session')).querySelectorAll('button')].find((b) => b.textContent.trim() === 'Revoke').click()`);
  await waitFor(`!!document.querySelector('[role=group][aria-label="Sign out this session?"]')`, "inline confirmation");
  await js(`[...document.querySelector('[role=group][aria-label="Sign out this session?"]').querySelectorAll('button')].find((b) => b.textContent.trim() === 'Revoke').click()`);
  await waitFor(`${rows}.length === ${sessionsBefore - 1}`, "session removed from the list");
  const secondMe = (await api("/auth/me", { cookie: second })).status;
  const stillMe = await js(`fetch("http://localhost:4000/api/v1/auth/me", { credentials: "include" }).then((r) => r.status)`);
  check("sessions: revoking the newest other session from the page ends it (401) and keeps this one (200)", secondMe === 401 && stillMe === 200, `${secondMe}/${stillMe}`);

  // ---- Every page: no Ben data, labelled inputs, no console errors/logs --------------------------
  const leaks = [];
  const unl = [];
  for (const p of PAGES) {
    await go(p);
    if (!noBen(await js(`document.documentElement.outerHTML`))) leaks.push(p);
    if (await unlabelled()) unl.push(p);
  }
  check("isolation in the browser: no page contains any of Ben's names, codes, apps, projects or leave", leaks.length === 0, leaks.join(", "));
  check("accessibility: every input, select and textarea has a label", unl.length === 0, unl.join(", "));
  check("no console errors or data logged to the console", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" || "));

  // ---- Direct navigation and API refusals from the employee's own browser session --------------
  await cdp("Page.navigate", { url: `${APP}/employees` });
  await waitFor(`location.pathname === '/my'`, "admin page redirects the employee");
  const adminApis = await js(`Promise.all(["/employees", "/attendance/timesheets?from=${yesterday}&to=${yesterday}", "/screenshots/gallery?from=${yesterday}&to=${yesterday}", "/projects", "/roles/users", "/settings/monitoring", "/audit?from=${yesterday}&to=${yesterday}"].map((p) => fetch("http://localhost:4000/api/v1" + p, { credentials: "include" }).then((r) => r.status)))`);
  check("direct navigation: admin pages send the employee to /my; admin APIs refuse the employee session (403)", adminApis.every((s) => s === 403), JSON.stringify(adminApis));
  const idSwap = await js(`Promise.all(["/attendance/history?employeeId=${ben.id}", "/activity/summary?from=${yesterday}&to=${yesterday}&employeeId=${ben.id}", "/employees/${ben.id}", "/task-time/entries?from=${yesterday}&to=${yesterday}&employeeId=${ben.id}"].map((p) => fetch("http://localhost:4000/api/v1" + p, { credentials: "include" }).then((r) => r.status)))`);
  check("URL parameter manipulation from the browser: Ben's records refused (404)", idSwap.every((s) => s === 404), JSON.stringify(idSwap));

  // ---- Self-view turned off ----------------------------------------------------------------------
  await policy(false);
  await go("/my/screenshots");
  check("screenshots: self-view off → clear explanation, no list, no images", /has not enabled viewing your own screenshots/.test(await text()) && !(await js(`!!document.querySelector('ul[aria-label="My screenshots list"]')`)));
  await go("/my");
  check("dashboard: self-view off → recent screenshots replaced by an explanation", /not enabled by your organization/.test(await text()) && !(await js(`!!document.querySelector('ul[aria-label="Recent screenshots"]')`)));
  await policy(true);

  // ---- Responsive: phone width ---------------------------------------------------------------------
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  const overflow = [];
  for (const p of PAGES) {
    await go(p);
    if (await js(`document.documentElement.scrollWidth > window.innerWidth + 1`)) overflow.push(p);
  }
  check("responsive (390 px): no page scrolls horizontally (tables scroll inside their wrapper)", overflow.length === 0, overflow.join(", "));
  await go("/my");
  const hidden = await js(`getComputedStyle(document.querySelector('#my-nav')).display === 'none'`);
  await js(`document.querySelector('button[aria-controls="my-nav"]').click()`);
  await waitFor(`getComputedStyle(document.querySelector('#my-nav')).display !== 'none'`, "menu open");
  await js(`document.querySelector('#my-nav a[href="/my/leave"]').click()`);
  await waitFor(`location.pathname === '/my/leave'`, "navigated from the menu");
  check("responsive: menu button opens the navigation drawer; a link navigates and marks the page current", hidden && (await js(`document.querySelector('#my-nav a[aria-current="page"]')?.getAttribute('href')`)) === "/my/leave");
  await shot("my-leave-mobile.png");
  await cdp("Emulation.clearDeviceMetricsOverride");

  // ---- Sign out: the session is gone ------------------------------------------------------------------
  await js(`[...document.querySelectorAll('header button')].find((b) => b.textContent.trim() === 'Sign out').click()`);
  await waitFor(`location.pathname === '/login'`, "signed out");
  const after = await js(`fetch("http://localhost:4000/api/v1/attendance/current", { credentials: "include" }).then((r) => r.status)`);
  await cdp("Page.navigate", { url: `${APP}/my/attendance` });
  await waitFor(`location.pathname === '/login'`, "employee page after sign-out redirects to login");
  check("sign-out: employee API refused afterwards (401); /my/* redirects to /login", after === 401, String(after));

  // ---- Super Admin and IT Admin keep the admin panel ------------------------------------------------------
  for (const [email, label] of [["ceo@example.com", "Super Admin"], ["it@example.com", "Admin"]]) {
    await signIn(email);
    await waitFor(`location.pathname === '/' && !!document.querySelector('nav[aria-label="Main"]')`, `${label} admin overview`);
    await cdp("Page.navigate", { url: `${APP}/employees` });
    await waitFor(`document.body.innerText.includes('Ana Employee') && document.body.innerText.includes('Ben Other')`, `${label} employees`);
    check(`${label}: no desktop download section in the admin panel`, !(await js(`!!document.querySelector('section[aria-label="Desktop app"]')`)));
    const badge = await js(`document.querySelector('[data-testid="platform-role"]')?.textContent`);
    await cdp("Page.navigate", { url: `${APP}/my` });
    await waitFor(`/no employee profile/.test(document.body.innerText)`, `${label} /my without profile`);
    check(`${label}: admin panel unchanged (overview, employees list incl. both employees, role badge); /my explains there is no employee profile`, badge === label, badge);
  }
  // ---- Audit log and My account (P1), as the IT Admin signed in last --------------------------------------
  await go("/audit");
  await waitFor(`document.querySelectorAll('table[aria-label="Audit events"] tbody tr').length > 0`, "audit events");
  let audit = await table("Audit events");
  check("audit page: recorded events from several sources (account creation, setup links, screenshot views, session revocation)", /ACCOUNT_CREATED/.test(audit) && /SETUP_LINK_ISSUED/.test(audit) && /THUMBNAIL|VIEW/.test(audit) && /SESSION_REVOKED/.test(audit), audit.slice(0, 200).replace(/\n/g, " | "));
  check("audit page: no secrets (no password hashes, tokens or storage paths)", !/\$argon2|wf_access|refresh_token|token_hash|\/shots\//i.test(await js(`document.documentElement.outerHTML`)));
  await js(`(() => { const el = [...document.querySelectorAll('main select')][0]; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, "ACCOUNT"); el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await waitFor(`(() => { const t = document.querySelector('table[aria-label="Audit events"]'); return !!t && t.querySelectorAll('tbody tr').length > 0 && !/THUMBNAIL|ROLE_CHANGED/.test(t.innerText); })()`, "source filter applied");
  audit = await table("Audit events");
  check("audit page: source filter (Account only) and no edit or delete controls", /ACCOUNT_CREATED/.test(audit) && !(await js(`[...document.querySelectorAll('main button')].some((b) => /delete|edit|remove/i.test(b.textContent))`)));
  await go("/account");
  check("admin My account page: email, role and own sessions", /it@example.com/.test(await text()) && /Admin/.test(await text()) && /This session/.test((await table("My sessions")) ?? ""));
} catch (err) {
  check("run aborted", false, String(err?.message ?? err));
  await shot("failure.png").catch(() => undefined);
} finally {
  dash.kill();
  chrome.kill();
  await app.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed${existsSync(OUT) ? ` · screenshots in ${OUT}` : ""}`);
process.exit(failed ? 1 : 0);
