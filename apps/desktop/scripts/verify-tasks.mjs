// F11 runtime check: the employee Tasks tab in the real desktop front end (Vite on :1420, headless
// Chrome, no Tauri shell) and the admin Projects page in the dashboard production build (:3102),
// against a throwaway API (temporary file DB) on :4000. Synthetic employees only; attendance actions
// go through the API for the employee's registered device.
// Run after `pnpm build`. Needs Google Chrome (macOS path) and free ports 4000, 1420 and 3102.
// Usage: pnpm --filter @workfolio/desktop verify:tasks [out-dir]
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = process.argv[2] ?? mkdtempSync(join(tmpdir(), "wf-verify-tasks-"));
const RUN = join(OUT, "run");
rmSync(RUN, { recursive: true, force: true });
mkdirSync(RUN, { recursive: true });
Object.assign(process.env, {
  NODE_ENV: "development", LOG_LEVEL: "warn", PORT: "4000",
  DATABASE_URL: `file:${join(RUN, "tasks.db")}`,
  JWT_SECRET: "tasks-check-secret-tasks-check-secret-xx",
  SCREENSHOT_STORAGE: "local", SCREENSHOT_LOCAL_DIR: join(RUN, "shots"), TIMELAPSE_DIR: join(RUN, "videos"),
  CORS_ORIGINS: "http://localhost:1420,http://localhost:3102",
});
const req = createRequire(`${ROOT}/apps/api/package.json`);
req("reflect-metadata");
const { NestFactory } = req("@nestjs/core");
const dist = (p) => import(`${ROOT}/apps/api/dist/${p}`);
const { AppModule } = await dist("app.module.js");
const { configureApp } = await dist("app.setup.js");
const { DATABASE } = await dist("database/database.module.js");
const { hashPassword } = await dist("auth/crypto.js");
const { addDays, formatDuration, localDate } = await import(`${ROOT}/packages/shared/dist/index.js`);
const PASSWORD = "tasks check password 1";
const APP = "http://localhost:1420";
const DASH = "http://localhost:3102";
const TZ = "Asia/Kolkata";
const results = [];
const check = (name, ok, detail = "") => (results.push({ name, ok }), console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`));

// ---- API and synthetic people ------------------------------------------------------------------
const app = await NestFactory.create(AppModule, { logger: ["error", "warn"] });
configureApp(app);
await app.listen(4000);
const db = app.get(DATABASE);
const api = async (path, { method = "GET", body, cookie, bearer } = {}) => {
  const headers = { origin: APP };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`http://localhost:4000/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, res };
};
await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [randomUUID(), await hashPassword(PASSWORD)] });
const adminCookie = (await api("/auth/login", { method: "POST", body: { email: "admin@example.com", password: PASSWORD } })).res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
async function employee(n, name) {
  const email = `tasks${n}@example.com`;
  const r = await api("/employees", { method: "POST", cookie: adminCookie, body: { email, employeeCode: `TK-${n}`, fullName: name, timezone: TZ } });
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const bearer = (await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } })).body.accessToken;
  const device = randomUUID();
  await api("/devices/register", { method: "POST", bearer, body: { installationId: device, deviceName: "Mac", platform: "macos" } });
  return { id: r.body.employee.id, email, bearer, device };
}
const attend = async (e, action) => {
  const res = await fetch(`http://localhost:4000/api/v1/attendance/${action}`, { method: "POST", headers: { origin: APP, authorization: `Bearer ${e.bearer}`, "x-device-id": e.device, "idempotency-key": randomUUID() } });
  if (res.status !== 200) throw new Error(`${action}: ${res.status} ${await res.text()}`);
};
const ana = await employee(1, "Ana Employee");
const ben = await employee(2, "Ben Other");
const today = localDate(Date.now(), TZ);
// Ana's recorded shift yesterday (09:00–13:00 local), synced as if from offline.
const y0 = Date.parse(`${addDays(today, -1)}T09:00:00+05:30`);
{
  const res = await fetch("http://localhost:4000/api/v1/attendance/sync", { method: "POST", headers: { origin: APP, "content-type": "application/json", authorization: `Bearer ${ana.bearer}`, "x-device-id": ana.device }, body: JSON.stringify({ sentAt: new Date().toISOString(), events: [["CLOCK_IN", y0], ["CLOCK_OUT", y0 + 4 * 3_600_000]].map(([type, at]) => ({ id: randomUUID(), type, occurredAt: new Date(at).toISOString() })) }) });
  const out = await res.json();
  if (!out.results?.every((r) => r.status === "ACCEPTED")) throw new Error(`sync: ${JSON.stringify(out)}`);
}
const count = async (sql, args = []) => Number((await db.execute({ sql, args })).rows[0].n);

// ---- Chrome over CDP ---------------------------------------------------------------------------
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--remote-debugging-port=9338", `--user-data-dir=${join(RUN, "chrome")}`, "--window-size=1000,1100", "--no-first-run", "about:blank"], { stdio: "ignore" });
let target;
for (let i = 0; i < 150 && !target; i++) {
  await new Promise((r) => setTimeout(r, 200));
  target = await fetch("http://127.0.0.1:9338/json/new?about:blank", { method: "PUT" }).then((r) => r.json(), () => null);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) (pending.get(msg.id)(msg), pending.delete(msg.id));
});
const cdp = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result))); ws.send(JSON.stringify({ id, method, params })); });
const js = async (expr) => {
  const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const waitFor = async (expr, label, ms = 20_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (await js(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${label}`);
};
const shot = async (name) => writeFileSync(join(OUT, name), Buffer.from((await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true })).data, "base64"));
const network = (conditions) => cdp("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, ...conditions });
await cdp("Page.enable");
await cdp("Runtime.enable");
await cdp("Network.enable");

const vite = spawn("pnpm", ["exec", "vite", "--port", "1420", "--strictPort"], { cwd: `${ROOT}/apps/desktop`, stdio: "ignore", env: { ...process.env, VITE_API_URL: "http://localhost:4000" } });
const dash = spawn("pnpm", ["exec", "next", "start", "--port", "3102"], { cwd: `${ROOT}/apps/dashboard`, stdio: "ignore" });
for (const url of [APP, `${DASH}/login`]) {
  for (let i = 0; i < 150 && !(await fetch(url).then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 200));
}


// Helpers
const $text = (sel) => js(`document.querySelector(${JSON.stringify(sel)}).textContent`);
const visible = (sel) => js(`!document.querySelector(${JSON.stringify(sel)}).closest('[hidden]')`);
const card = (text) => `[...document.querySelectorAll('article')].find((a) => a.innerText.includes(${JSON.stringify(text)}))`;
const button = (scope, label) => `[...${scope}.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;
/** The dashboard's confirmation dialog (components/kit.tsx ConfirmDialog): checks its title, then confirms. Returns its text. */
const confirmDialog = async (title, confirmLabel) => {
  const dlg = `[...document.querySelectorAll('dialog[open]')].find((d) => d.querySelector('h2')?.textContent === ${JSON.stringify(title)})`;
  await waitFor(`!!${dlg}`, `confirmation "${title}"`);
  const text = await js(`${dlg}.innerText`);
  await js(`${button(dlg, confirmLabel)}.click()`);
  return text;
};
const setReact = (sel, value) => `(() => { const el = ${sel}; const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); })()`;
const tasksLoaded = `document.querySelector('#tasks-status').textContent !== 'Loading…'`;
async function openTasks() {
  await js(`document.querySelector('#tab-btn-today').click()`);
  await js(`document.querySelector('#tab-btn-tasks').click()`);
  await waitFor(`${tasksLoaded} && (!document.querySelector('#tasks-timer').hidden || !document.querySelector('#tasks-error').hidden)`, "tasks tab");
}
async function desktopSignIn(e) {
  await cdp("Page.navigate", { url: APP });
  await waitFor(`!document.querySelector('#login-view').hidden || !document.querySelector('#signed-in-view').hidden`, "desktop loaded");
  if (await visible("#login-view")) {
    await js(`(() => { const f = document.querySelector('#login-form'); f.email.value = ${JSON.stringify(e.email)}; f.password.value = ${JSON.stringify(PASSWORD)}; f.requestSubmit(); })()`);
    await waitFor(`!document.querySelector('#signed-in-view').hidden`, "signed in");
  }
}
const timerAction = async (id) => {
  await js(`document.querySelector('#${id}').click()`);
  await waitFor(`!document.querySelector('#${id}').disabled`, `${id} done`);
  await waitFor(tasksLoaded, "reload");
};

try {
  // ---- Dashboard: admin sets up projects ----
  await cdp("Page.navigate", { url: `${DASH}/login` });
  await waitFor(`(() => { const f = document.querySelector('form'); return !!f && Object.keys(f).some((k) => k.startsWith('__reactProps')); })()`, "hydrated login form");
  await js(`(() => {
    const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
    set(document.querySelector('input[type=email], input[name=email]'), "admin@example.com");
    set(document.querySelector('input[type=password]'), ${JSON.stringify(PASSWORD)});
    document.querySelector('form').requestSubmit();
  })()`);
  await waitFor(`location.pathname !== "/login"`, "sign-in");
  const navLink = `[...document.querySelectorAll('nav a')].find((a) => a.textContent === 'Projects')`;
  await waitFor(`!!${navLink}`, "Projects link");
  await js(`${navLink}.click()`);
  await waitFor(`location.pathname === '/projects' && document.body.innerText.includes('No projects yet.') && document.body.innerText.includes('No task time in this range.')`, "empty projects page");
  check("dashboard: empty states (no projects, no task time)", true);

  const newForm = `[...document.querySelectorAll('form')].find((f) => f.innerText.includes('Create project'))`;
  const createProject = async (code, name) => {
    await js(setReact(`${newForm}.querySelectorAll('input')[0]`, code));
    await js(setReact(`${newForm}.querySelectorAll('input')[1]`, name));
    await js(`${newForm}.requestSubmit()`);
  };
  await createProject("apollo", "Apollo");
  await waitFor(`!!${card("APOLLO")}`, "project created");
  await createProject("APOLLO", "Again");
  await waitFor(`${newForm}.querySelector('[role=alert]')?.textContent.includes('already exists')`, "duplicate refused");
  check("dashboard: create project (code normalized); duplicate code refused with a message", true);

  const apollo = card("APOLLO");
  for (const title of ["Design", "Build"]) {
    await js(setReact(`${apollo}.querySelector('input[placeholder="New task"]')`, title));
    await js(`${apollo}.querySelector('input[placeholder="New task"]').form.requestSubmit()`);
    await waitFor(`${apollo}.innerText.includes(${JSON.stringify(title)})`, `task ${title}`);
  }
  await js(setReact(`${apollo}.querySelector('select')`, ana.id));
  await js(`${apollo}.querySelector('select').form.requestSubmit()`);
  await waitFor(`${apollo}.innerText.includes('Ana Employee') && !!${button(apollo, "Remove")}`, "Ana assigned");
  check("dashboard: tasks added and an employee assigned", (await js(`${apollo}.innerText`)).includes("Build"));

  await js(`${apollo}.querySelector('details').open = true`);
  await js(setReact(`${apollo}.querySelector('input[name=name]')`, "Apollo Mission"));
  await js(`${apollo}.querySelector('input[name=name]').form.requestSubmit()`);
  await waitFor(`!!${card("Apollo Mission")}`, "renamed");
  check("dashboard: project renamed", true);

  // Two more projects through the API: ZEUS for Ben only, OLD for Ana (archived in the UI).
  const mk = async (code, member) => {
    const p = (await api("/projects", { method: "POST", cookie: adminCookie, body: { code, name: code } })).body;
    await api(`/projects/${p.id}/tasks`, { method: "POST", cookie: adminCookie, body: { title: `${code} task` } });
    await api(`/projects/${p.id}/members`, { method: "POST", cookie: adminCookie, body: { employeeId: member.id } });
    return p;
  };
  await mk("ZEUS", ben);
  await mk("OLD", ana);
  await cdp("Page.reload");
  await waitFor(`!!${card("OLD")}`, "OLD listed");
  await js(`${button(card("OLD"), "Archive")}.click()`);
  const archiveText = await confirmDialog("Archive OLD OLD?", "Archive project");
  check("dashboard: archive asks first and says nothing is deleted", archiveText.includes("Nothing is deleted") && archiveText.includes("restore it later"), archiveText.replace(/\s+/g, " ").slice(0, 160));
  await waitFor(`${card("OLD")}.innerText.includes('Archived: no new timers') && !!${button(card("OLD"), "Restore")}`, "archived");
  check("dashboard: archived project clearly marked, can be restored", true);
  await js(`[...${card("Apollo Mission")}.querySelectorAll('details')].at(-1).open = true`);
  await waitFor(`[...${card("Apollo Mission")}.querySelectorAll('details')].at(-1).querySelectorAll('li').length >= 5`, "history");
  const hist = await js(`[...${card("Apollo Mission")}.querySelectorAll('details')].at(-1).innerText`);
  check("dashboard: change history with who did what", /project created/.test(hist) && /employee assigned/.test(hist) && /project updated/.test(hist) && hist.includes("admin@example.com"));
  await shot("tasks-dashboard-setup.png");

  // ---- Desktop: Ana ----
  await desktopSignIn(ana);
  await network({ latency: 1500 });
  await js(`document.querySelector('#tab-btn-tasks').click()`);
  await waitFor(`document.querySelector('#tasks-status').textContent === 'Loading…'`, "loading", 3000);
  check("desktop: loading state", true);
  await network({});
  await waitFor(`${tasksLoaded} && !document.querySelector('#tasks-timer').hidden`, "tasks loaded");
  check("desktop: not clocked in → explained, Start disabled", /Clock in on the Today tab/.test(await $text("#tasks-attendance")) && (await js(`document.querySelector('#tasks-start').disabled`)));
  const options = await js(`[...document.querySelectorAll('#tasks-task optgroup')].map((g) => g.label + ': ' + [...g.querySelectorAll('option')].map((o) => o.textContent).join(','))`);
  check("desktop: only the employee's active projects and open tasks (not ZEUS, not archived OLD)", JSON.stringify(options) === JSON.stringify(["APOLLO · Apollo Mission: Design,Build"]), JSON.stringify(options));
  check("desktop: empty history state", (await $text("#tasks-history")).includes("No task time in the last 7 days."));

  await attend(ana, "clock-in");
  await openTasks();
  check("desktop: clocked in → Start enabled", !(await js(`document.querySelector('#tasks-start').disabled`)) && (await js(`document.querySelector('#tasks-attendance').hidden`)));
  await js(`document.querySelector('#tasks-task').value = [...document.querySelectorAll('#tasks-task option')].find((o) => o.textContent === 'Design').value`);
  await js(`document.querySelector('#tasks-start-form').requestSubmit()`);
  await waitFor(`!document.querySelector('#tasks-running').hidden`, "running");
  const e1 = await $text("#tasks-elapsed");
  await new Promise((r) => setTimeout(r, 2200));
  const e2 = await $text("#tasks-elapsed");
  check("desktop: running timer shows the task and a ticking elapsed time; Start hidden", (await $text("#tasks-current")) === "APOLLO · Design" && e1 !== e2 && /s$/.test(e2) && !(await visible("#tasks-start-form")), `${e1} → ${e2}`);
  const startedText = await $text("#tasks-since");

  // App restart: a fresh page and sign-in; the server still has the timer.
  await cdp("Page.navigate", { url: "about:blank" });
  await desktopSignIn(ana);
  await openTasks();
  check("desktop: after a restart the same timer is shown (same start time)", !(await js(`document.querySelector('#tasks-running').hidden`)) && (await $text("#tasks-since")) === startedText && (await $text("#tasks-current")) === "APOLLO · Design");

  await timerAction("tasks-pause");
  check("desktop: pause → paused task offered for resume", (await visible("#tasks-paused")) && (await $text("#tasks-paused-text")) === "Paused: APOLLO · Design" && !(await visible("#tasks-running")));
  await timerAction("tasks-resume");
  check("desktop: resume → running again", (await visible("#tasks-running")) && (await $text("#tasks-current")) === "APOLLO · Design");
  await timerAction("tasks-stop");
  const hist1 = await js(`document.querySelector('#tasks-history').innerText`);
  check("desktop: stop → history shows the paused and the stopped entry, with a total", !(await visible("#tasks-running")) && /paused\)/.test(hist1) && /stopped\)/.test(hist1) && /Timer time, last 7 days: .* over 2 entries/.test(await $text("#tasks-total")), hist1.replace(/\s+/g, " "));

  await js(`document.querySelector('#tasks-start-form').requestSubmit()`);
  await waitFor(`!document.querySelector('#tasks-running').hidden`, "running again");
  await attend(ana, "break/start");
  await openTasks();
  const hist2 = await js(`document.querySelector('#tasks-history').innerText`);
  check("desktop: a break ends the timer (shown as such) and blocks new timers", !(await visible("#tasks-running")) && /ended by your break/.test(hist2) && /on a break/.test(await $text("#tasks-attendance")) && (await js(`document.querySelector('#tasks-start').disabled`)));
  await attend(ana, "break/end");
  await openTasks();
  await network({ offline: true });
  await js(`document.querySelector('#tasks-start-form').requestSubmit()`);
  await waitFor(`!document.querySelector('#tasks-error').hidden`, "offline error");
  check("desktop: offline start shows a clear error, nothing started", /Connect to the server to use task timers/.test(await $text("#tasks-error")) && (await count("SELECT count(*) n FROM task_time_entries WHERE employee_id = ? AND ended_at IS NULL", [ana.id])) === 0);
  await network({});
  // A running timer while the server cannot be reached: last known state only, nothing ticks or
  // can be pressed; the employee clocks out elsewhere; back online, the server's state returns.
  await openTasks();
  await js(`document.querySelector('#tasks-start-form').requestSubmit()`);
  await waitFor(`!document.querySelector('#tasks-running').hidden && document.querySelector('#tasks-elapsed').textContent !== ''`, "running before going offline");
  await network({ offline: true });
  await js(`document.querySelector('#tab-btn-today').click()`);
  await js(`document.querySelector('#tab-btn-tasks').click()`);
  await waitFor(`!document.querySelector('#tasks-error').hidden && document.querySelector('#tasks-since').textContent.startsWith('Last known')`, "stale state");
  await new Promise((r) => setTimeout(r, 1500));
  check("desktop: server unreachable with a timer running → error, last-known state, no ticking, buttons disabled", (await js(`document.querySelector('#tasks-elapsed').textContent`)) === "" && (await js(`document.querySelector('#tasks-pause').disabled && document.querySelector('#tasks-stop').disabled`)) && /Connect to the server/.test(await $text("#tasks-error")), await $text("#tasks-since"));
  await attend(ana, "clock-out");
  await network({});
  await waitFor(`document.querySelector('#tasks-running').hidden && document.querySelector('#tasks-error').hidden && document.querySelector('#tasks-history').innerText.includes('ended by clock-out')`, "recovered after reconnect", 40_000);
  check("desktop: back online → server state recovered without a click (timer ended by the clock-out, shown as such)", /Clock in on the Today tab/.test(await $text("#tasks-attendance")));
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
  await openTasks();
  check("desktop: 390 px wide, no horizontal scroll", (await js(`document.documentElement.scrollWidth`)) <= 390, String(await js(`document.documentElement.scrollWidth`)));
  await shot("tasks-desktop-narrow.png");
  await cdp("Emulation.clearDeviceMetricsOverride");
  const dbAttendance = await count("SELECT count(*) n FROM attendance_events WHERE employee_id = ?", [ana.id]);
  check("desktop: attendance has exactly the 4 actions taken today (clock-in, break start, break end, clock-out) plus the 2 synced for yesterday", dbAttendance === 6, String(dbAttendance));

  // ---- Dashboard: the summary matches the stored entries ----
  // A recorded shift yesterday (09:00–13:00 local, synced) with a known 90-minute entry in it.
  const ySession = (await db.execute({ sql: "SELECT id FROM attendance_sessions WHERE employee_id = ? AND clock_out_at IS NOT NULL", args: [ana.id] })).rows[0].id;
  const design = (await db.execute("SELECT id, project_id FROM project_tasks WHERE title = 'Design'")).rows[0];
  await db.execute({ sql: "INSERT INTO task_time_entries (id, employee_id, project_id, task_id, attendance_session_id, started_at, ended_at, end_reason) VALUES (?, ?, ?, ?, ?, ?, ?, 'STOPPED')", args: [randomUUID(), ana.id, design.project_id, design.id, ySession, new Date(y0 + 3_600_000).toISOString(), new Date(y0 + 2.5 * 3_600_000).toISOString()] });
  const sum = Number((await db.execute({ sql: "SELECT coalesce(sum((julianday(ended_at) - julianday(started_at)) * 86400000), 0) AS n FROM task_time_entries WHERE employee_id = ? AND ended_at IS NOT NULL", args: [ana.id] })).rows[0].n);
  await cdp("Page.navigate", { url: `${DASH}/projects` });
  await waitFor(`!!document.querySelector('table[aria-label="Task time by employee"]')`, "summary");
  const fromInput = `[...document.querySelectorAll('input[type=date]')][0]`;
  await js(setReact(fromInput, addDays(today, -6)));
  await waitFor(`document.querySelector('table[aria-label="Task time by employee"]')?.innerText.includes('Ana Employee')`, "summary row");
  const row = await js(`[...document.querySelectorAll('table[aria-label="Task time by employee"] tbody tr')].find((r) => r.innerText.includes('Ana Employee')).innerText`);
  const cells = row.split("\t").map((c) => c.trim());
  check("dashboard: employee summary = sum of stored entries (1h 30m + today's short entries); attendance worked (4h 00m, the completed shift) is a separate column", cells[1] === formatDuration(Math.round(sum)) && cells[1] === "1h 30m" && cells[2] === "4h 00m" && cells[3] === "5", cells.join(" | "));
  const proj = await js(`document.querySelector('table[aria-label="Task time by project"]').innerText`);
  check("dashboard: project summary lists APOLLO with its task; no productivity wording", proj.includes("APOLLO · Apollo Mission") && proj.includes("Design") && !/productiv|score/i.test(proj));
  await shot("tasks-dashboard-summary.png");

  await app.close();
  await cdp("Page.navigate", { url: `${DASH}/projects` });
  await waitFor(`document.body.innerText.includes('Could not reach the API')`, "dashboard error", 30_000).catch(() => {});
  check("dashboard: API unreachable shows an error", /Could not reach the API/.test(await js(`document.body.innerText`)) && (await js(`document.querySelectorAll('article').length`)) === 0);
} catch (err) {
  check(`run aborted: ${err.message}`, false);
  await shot("tasks-failure.png").catch(() => {});
} finally {
  ws.close();
  chrome.kill();
  vite.kill();
  dash.kill();
  await app.close().catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  rmSync(RUN, { recursive: true, force: true });
}
console.log(`Page captures: ${OUT}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
