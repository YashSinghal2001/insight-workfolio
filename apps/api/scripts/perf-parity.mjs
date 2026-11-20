// P7-09 performance check (not part of `pnpm test`): 200 synthetic employees with ~30 days of sessions, breaks and
// activity, then p50/p95 of 10 calls each for the heavy parity reads, and (with --page) the Overview page load in
// headless Chrome against the dashboard production build. In-process API on a temporary FILE database.
// Usage (after `pnpm --filter @workfolio/api build`, and `pnpm --filter @workfolio/dashboard build` for --page):
//   node apps/api/scripts/perf-parity.mjs [--page] [--keep <db path>]
// Ports: IW_API_PORT (4000), IW_APP_PORT (3105), IW_CDP_PORT (9345). Synthetic data only (*@example.com).
// Direct database writes (test-only): history older than the 7-day offline-sync limit cannot go through
// /attendance/sync, so devices, sessions, breaks and activity are inserted with SQL in the same shapes the API writes.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../..");
const args = process.argv.slice(2);
const PAGE = args.includes("--page");
const KEEP = args.includes("--keep") ? args[args.indexOf("--keep") + 1] : null;
const API_PORT = Number(process.env.IW_API_PORT ?? 4000);
const APP_PORT = Number(process.env.IW_APP_PORT ?? 3105);
const CDP_PORT = Number(process.env.IW_CDP_PORT ?? 9345);
const APP = `http://localhost:${APP_PORT}`;
const API = `http://localhost:${API_PORT}/api/v1`;
const N = 200;
const DAYS = 30;
const RUN = mkdtempSync(join(tmpdir(), "wf-perf-"));
const DB_FILE = join(RUN, "perf.db");
Object.assign(process.env, {
  NODE_ENV: "development", LOG_LEVEL: "warn", PORT: String(API_PORT), DATABASE_URL: `file:${DB_FILE}`,
  JWT_SECRET: "perf-check-secret-perf-check-secret-perf", SCREENSHOT_STORAGE: "local", SCREENSHOT_LOCAL_DIR: join(RUN, "shots"),
  TIMELAPSE_DIR: join(RUN, "videos"), CORS_ORIGINS: APP, REPORT_SCHEDULER_SECONDS: "0",
});
const req = createRequire(`${ROOT}/apps/api/package.json`);
req("reflect-metadata");
const { NestFactory } = req("@nestjs/core");
const dist = (p) => import(`${ROOT}/apps/api/dist/${p}`);
const { AppModule } = await dist("app.module.js");
const { configureApp } = await dist("app.setup.js");
const { DATABASE } = await dist("database/database.module.js");
const { hashPassword } = await dist("auth/crypto.js");
const { addDays, localDate, zonedToUtc } = await import(`${ROOT}/packages/shared/dist/index.js`);

const M = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const app = await NestFactory.create(AppModule, { logger: ["error", "warn"] });
configureApp(app);
await app.listen(API_PORT);
const db = app.get(DATABASE);
const api = async (path, { method = "GET", body, cookie } = {}) => {
  const headers = { origin: APP, ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) };
  const send = () => fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  // A keep-alive socket idle through the seeding can be closed by the server just as it is reused: retry once.
  const res = await send().catch((err) => (err?.cause?.code === "ECONNRESET" ? send() : Promise.reject(err)));
  const text = await res.text();
  if (res.status >= 300) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
  return { res, body: text && (res.headers.get("content-type") ?? "").includes("json") ? JSON.parse(text) : text };
};

// ---- seed -----------------------------------------------------------------------------------
const t0 = Date.now();
const PASSWORD = "perf check password 1";
const adminId = randomUUID();
await db.execute({ sql: "INSERT INTO users (id, email, role, admin_title, password_hash) VALUES (?, 'perf-admin@example.com', 'ADMIN', 'SUPER_ADMIN', ?)", args: [adminId, await hashPassword(PASSWORD)] });
const cookie = (await api("/auth/login", { method: "POST", body: { email: "perf-admin@example.com", password: PASSWORD } })).res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const NOW = Date.now();
const today = localDate(NOW, "UTC");
// Today's open shifts start 3 h ago, or just after UTC midnight early in the day (same local date for every zone used).
const openAt = Math.max(NOW - 3 * 60 * M, Date.parse(`${today}T00:00:00Z`) + M, Date.parse(zonedToUtc(`${localDate(NOW, "Asia/Kolkata")}T00:00`, "Asia/Kolkata")) + M);
await db.execute({ sql: "INSERT INTO work_schedule_policies (enabled, expected_start, grace_minutes, workdays, reason, changed_by, effective_at) VALUES (1, '09:00', 15, '12345', 'perf check', ?, ?)", args: [adminId, iso(NOW - 40 * 86_400_000)] });
const APPS = ["Code Editor", "Browser", "Mail", "Chat", "Spreadsheet", "Terminal", "Design Tool", "Docs", "Calendar", "Music"];
const emps = [];
for (let i = 0; i < N; i++) {
  const tz = i % 4 === 0 ? "Asia/Kolkata" : "UTC";
  const r = await api("/employees", { method: "POST", cookie, body: { email: `perf${i}@example.com`, employeeCode: `PF-${String(i).padStart(3, "0")}`, fullName: `Perf Person ${i}`, timezone: tz } });
  emps.push({ id: r.body.employee.id, tz, device: randomUUID() });
}
const stmts = [];
const flush = async () => { while (stmts.length) await db.batch(stmts.splice(0, 2000), "write"); };
for (const [i, e] of emps.entries()) {
  stmts.push({ sql: "UPDATE employee_profiles SET created_at = ? WHERE id = ?", args: [iso(NOW - 40 * 86_400_000), e.id] });
  // Device last seen: most now, every 10th stale (2 h), so Live/Overview show both.
  stmts.push({ sql: "INSERT INTO devices (id, employee_id, device_name, platform, device_identifier, last_seen_at) VALUES (?, ?, 'Perf Mac', 'macos', ?, ?)", args: [e.device, e.id, randomUUID(), iso(i % 10 === 0 ? NOW - 120 * M : NOW)] });
  for (let d = DAYS; d >= 0; d--) {
    const date = addDays(localDate(NOW, e.tz), -d);
    const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    if ((i + d) % 17 === 0) continue; // occasional absence
    const sid = randomUUID();
    const late = (i + d) % 9 === 0 ? 40 : 0;
    const start = Date.parse(zonedToUtc(`${date}T09:00`, e.tz)) + ((i * 7) % 15 + late) * M;
    const open = d === 0;
    if (open && i % 4 === 3) continue; // a quarter has not clocked in today
    const inAt = open ? openAt : start;
    const end = open ? NOW : start + (i % 5 === 0 ? 6 : 8.5) * 60 * M; // every 5th works short days (risk users)
    stmts.push({ sql: "INSERT INTO attendance_sessions (id, employee_id, device_id, clock_in_at, clock_out_at, status) VALUES (?, ?, ?, ?, NULL, 'OPEN')", args: [sid, e.id, e.device, iso(inAt)] });
    if (!open) {
      const b = inAt + 4 * 60 * M;
      stmts.push({ sql: "INSERT INTO break_sessions (id, attendance_session_id, started_at, ended_at, status) VALUES (?, ?, ?, ?, 'CLOSED')", args: [randomUUID(), sid, iso(b), iso(b + 30 * M)] });
      stmts.push({ sql: "UPDATE attendance_sessions SET clock_out_at = ?, status = 'CLOSED' WHERE id = ?", args: [iso(end), sid] });
    }
    // Activity: 20-minute intervals across the shift (every 6th idle).
    for (let t = inAt, k = 0; t + 20 * M <= end; t += 20 * M, k++) {
      const idle = k % 6 === 5;
      const name = idle ? null : APPS[(i + k) % APPS.length];
      stmts.push({
        sql: `INSERT INTO activity_intervals (id, employee_id, device_id, attendance_session_id, kind, application_identifier, application_name, started_at, ended_at,
                active_seconds, idle_seconds, source, device_started_at, received_at, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DESKTOP_MACOS', ?, ?, ?)`,
        args: [randomUUID(), e.id, e.device, sid, idle ? "IDLE" : "ACTIVE", name && `com.example.${name.replace(/\W/g, "")}`, name, iso(t), iso(t + 20 * M), idle ? 0 : 1200, idle ? 1200 : 0, iso(t), iso(t + 20 * M), randomUUID()],
      });
    }
    if (stmts.length > 5000) await flush();
  }
}
await flush();
const count = async (t) => (await db.execute(`SELECT count(*) AS n FROM ${t}`)).rows[0].n;
const counts = { employees: await count("employee_profiles"), sessions: await count("attendance_sessions"), breaks: await count("break_sessions"), activity: await count("activity_intervals") };
console.log(`seeded in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${JSON.stringify(counts)}`);

// ---- API timings -------------------------------------------------------------------------------
const month = today.slice(0, 7);
const ENDPOINTS = {
  "GET /overview": `/overview?date=${today}`,
  "GET /attendance/monthly": `/attendance/monthly?month=${month}&pageSize=100`,
  "GET /attendance/missing-clock-outs": "/attendance/missing-clock-outs",
  "GET /activity/risk-users": `/activity/risk-users?from=${addDays(today, -29)}&to=${today}`,
  "GET /activity/team-timeline": `/activity/team-timeline?date=${today}&pageSize=100`,
};
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];
const rows = [];
for (const [name, path] of Object.entries(ENDPOINTS)) {
  await api(path, { cookie }); // warm-up (not counted)
  const ms = [];
  for (let k = 0; k < 10; k++) {
    const s = performance.now();
    await api(path, { cookie });
    ms.push(performance.now() - s);
  }
  rows.push([name, pct(ms, 50), pct(ms, 95)]);
}
const ov = (await api(`/overview?date=${today}`, { cookie })).body;

// ---- Overview page load (optional) ---------------------------------------------------------------
let page = null;
if (PAGE) {
  const dash = spawn("pnpm", ["exec", "next", "start", "--port", String(APP_PORT)], { cwd: `${ROOT}/apps/dashboard`, stdio: "ignore", env: { ...process.env, NODE_ENV: "production" } });
  const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(RUN, "chrome")}`, "--window-size=1440,1000", "--no-first-run", "about:blank"], { stdio: "ignore" });
  try {
    for (let i = 0; i < 150 && !(await fetch(`${APP}/login`).then((r) => r.ok, () => false)); i++) await sleep(200);
    let target;
    for (let i = 0; i < 150 && !target; i++) { await sleep(200); target = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json(), () => null); }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    let seq = 0;
    const pending = new Map();
    ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } });
    const cdp = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, (m) => res(m.result)); ws.send(JSON.stringify({ id, method, params })); });
    const js = async (expr) => (await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }))?.result?.value;
    await cdp("Emulation.setTimezoneOverride", { timezoneId: "UTC" });
    for (const c of cookie.split("; ")) { const [n, ...v] = c.split("="); await cdp("Network.setCookie", { name: n, value: v.join("="), url: APP }); }
    // Ready = the KPI card shows the seeded head count and no widget is still loading.
    const ready = `(() => { const p = [...document.querySelectorAll('main p')].find((x) => x.textContent.trim() === 'Active employees'); return p?.parentElement?.children[1]?.textContent.trim() === '${N}' && !/Loading…/.test(document.querySelector('main').innerText); })()`;
    const loads = [];
    for (let k = 0; k < 6; k++) {
      await cdp("Page.navigate", { url: "about:blank" });
      await sleep(100);
      const s = performance.now();
      await cdp("Page.navigate", { url: `${APP}/` });
      let done = false;
      for (const end = Date.now() + 30_000; Date.now() < end && !done; await sleep(25)) done = !!(await js(ready));
      if (!done) throw new Error("overview page did not become ready in 30 s");
      if (k) loads.push(performance.now() - s); // first load warms the Next.js server
    }
    page = { p50: pct(loads, 50), p95: pct(loads, 95), n: loads.length };
  } finally {
    dash.kill();
    chrome.kill();
  }
}
await app.close();
if (KEEP) copyFileSync(DB_FILE, KEEP);
rmSync(RUN, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });

console.log(`\n${"endpoint".padEnd(36)} ${"p50 ms".padStart(8)} ${"p95 ms".padStart(8)}   (10 calls each, ${N} employees)`);
for (const [n, a, b] of rows) console.log(`${n.padEnd(36)} ${a.toFixed(0).padStart(8)} ${b.toFixed(0).padStart(8)}`);
if (page) console.log(`${"Overview page (navigate → KPIs ready)".padEnd(36)} ${page.p50.toFixed(0).padStart(8)} ${page.p95.toFixed(0).padStart(8)}   (${page.n} loads)`);
console.log(`overview: ${ov.kpis.totalMembers} members, working ${ov.kpis.workingNow}, missing clock-outs ${ov.missingClockOuts?.length ?? "n/a"}`);
const overviewP95 = rows[0][2];
console.log(overviewP95 < 1000 ? "PASS  GET /overview p95 < 1 s" : "FAIL  GET /overview p95 ≥ 1 s");
if (KEEP) console.log(`database kept at ${KEEP}`);
process.exit(overviewP95 < 1000 ? 0 : 1);
