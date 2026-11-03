// Schedule / timelapse / storage browser check (W24, F01, AW-04): a throwaway API (temporary file DB,
// local storage) on :4213, `next dev` on :3213, headless Chrome over CDP on :9513. Synthetic data only.
// Covers: the expected-start window on admin /activity and /my/activity at the employee's override
// start (and none on a holiday), the "Generate daily timelapse automatically" toggle saving from
// /settings and the scheduler tick (injected clock) queuing a job that becomes READY, and the
// settings Storage card's "Last upload". Every page is also checked for console errors.
// Run after `pnpm build:packages && pnpm --filter @workfolio/api build`; needs Google Chrome (macOS path).
// Usage: node apps/dashboard/scripts/verify-schedule.mjs [out-dir]
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const ROOT = resolve(import.meta.dirname, "../../..");
const API_PORT = 4213, WEB_PORT = 3213, CDP_PORT = 9513;
const WEB = `http://localhost:${WEB_PORT}`;
const DEV_NOTICE = /Could not validate that a segment in your UI has instant navigation/;
let devNotices = 0;
const OUT = process.argv[2] ?? mkdtempSync(join(tmpdir(), "wf-verify-schedule-"));
const RUN = join(OUT, "run");
rmSync(RUN, { recursive: true, force: true });
mkdirSync(join(RUN, "shots"), { recursive: true });
Object.assign(process.env, {
  NODE_ENV: "development", LOG_LEVEL: "warn", PORT: String(API_PORT),
  DATABASE_URL: `file:${join(RUN, "schedule.db")}`,
  JWT_SECRET: "schedule-check-secret-schedule-check-secret",
  SCREENSHOT_STORAGE: "local", SCREENSHOT_LOCAL_DIR: join(RUN, "shots"), TIMELAPSE_DIR: join(RUN, "videos"),
  CORS_ORIGINS: WEB, DASHBOARD_URL: WEB,
});
const results = [];
const check = (name, ok, detail = "") => (results.push({ name, ok: !!ok }), console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = [];
const M = 60_000, DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
const ymd = (ms) => iso(ms).slice(0, 10);
const PASSWORD = "schedule check password 1";
const NOTICE = "2026-10-screenshots-draft-1";

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
  const { TimelapseService } = await dist("screenshots/timelapse.service.js");
  const { TIMELAPSE_ENCODER } = await dist("screenshots/timelapse-encoder.js");
  const app = await NestFactory.create(AppModule, { logger: ["error", "warn"] });
  configureApp(app);
  await app.listen(API_PORT);
  cleanup.push(() => app.close());
  const db = app.get(DATABASE);
  const api = async (path, { method = "GET", body, raw, cookie, bearer, device } = {}) => {
    const headers = { origin: WEB };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (raw) headers["content-type"] = "image/webp";
    if (cookie) headers.cookie = cookie;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    if (device) headers["x-device-id"] = device;
    const res = await fetch(`http://localhost:${API_PORT}/api/v1${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const text = await res.text();
    return { status: res.status, body: text && (res.headers.get("content-type") ?? "").includes("json") ? JSON.parse(text) : undefined, text, res };
  };

  const now = Date.now();
  const adminId = randomUUID();
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [adminId, await hashPassword(PASSWORD)] });
  const adminCookie = (await api("/auth/login", { method: "POST", body: { email: "admin@example.com", password: PASSWORD } })).res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  // Screenshots on (60 s) and an organisation schedule (09:00, every day), both effective 30 days ago.
  await db.execute({
    sql: `INSERT INTO screenshot_policies (screenshots_enabled, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
            retention_approved, notice_version, reason, changed_by, effective_at) VALUES (1, 60, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, ?, 'schedule check', ?, ?)`,
    args: [NOTICE, adminId, iso(now - 30 * DAY)],
  });
  await db.execute({ sql: "INSERT INTO work_schedule_policies (enabled, expected_start, grace_minutes, workdays, reason, changed_by, effective_at) VALUES (1, '09:00', 15, '1234567', 'schedule check', ?, ?)", args: [adminId, iso(now - 30 * DAY)] });

  async function employee(n, name, events) {
    const email = `sched-${n}@example.com`;
    const r = await api("/employees", { method: "POST", cookie: adminCookie, body: { email, employeeCode: `SC-${n}`, fullName: name, timezone: "UTC" } });
    assert.equal(r.status, 201, r.text);
    await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
    const bearer = (await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } })).body.accessToken;
    const e = { id: r.body.employee.id, email, name, bearer, device: randomUUID() };
    await db.execute({ sql: "UPDATE employee_profiles SET created_at = ? WHERE id = ?", args: [iso(now - 30 * DAY), e.id] });
    await api("/devices/register", { method: "POST", bearer, body: { installationId: e.device, deviceName: "Mac", platform: "macos" } });
    await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), e.id, NOTICE, iso(now - 2 * DAY)] });
    e.sync = (evs) => api("/attendance/sync", { method: "POST", bearer, device: e.device, body: { sentAt: iso(Date.now()), events: evs.map(([type, at]) => ({ id: randomUUID(), type, occurredAt: iso(at) })) } });
    if (events.length) assert.equal((await e.sync(events)).status, 200);
    return e;
  }
  const midnight = Date.parse(`${ymd(now)}T00:00:00Z`);
  const at = (f) => midnight + Math.floor(((now - midnight) * f) / M) * M;
  assert.ok(now - midnight > 30 * M, "run after 00:30 UTC so a shift fits into today");
  const YESTERDAY = ymd(now - DAY); // a holiday below
  // Ben: shifts yesterday (the holiday) and today; his own start 10:30 overrides the organisation's 09:00.
  const ben = await employee(1, "Ben Override", [
    ["CLOCK_IN", midnight - DAY + 10 * 60 * M], ["CLOCK_OUT", midnight - DAY + 12 * 60 * M],
    ["CLOCK_IN", at(0.1)], ["BREAK_START", at(0.4)], ["BREAK_END", at(0.6)], ["CLOCK_OUT", at(0.9)],
  ]);
  await db.execute({
    sql: "INSERT INTO employee_tracking_overrides (id, employee_id, expected_start, workdays, idle_threshold_seconds, reason, changed_by, effective_at) VALUES (?, ?, '10:30', '1234567', NULL, 'late shift', ?, ?)",
    args: [randomUUID(), ben.id, adminId, iso(now - 30 * DAY)],
  });
  await db.execute({ sql: "INSERT INTO holidays (id, date, name, created_by) VALUES (?, ?, 'Check holiday', ?)", args: [randomUUID(), YESTERDAY, adminId] });
  // Tia: clocked in 3 h ago; two screenshots are uploaded below, then she clocks out.
  const tia = await employee(2, "Tia Timelapse", [["CLOCK_IN", now - 180 * M]]);

  // ---- Dashboard (next dev) ----------------------------------------------------------------------
  const dash = spawn("pnpm", ["exec", "next", "dev", "--port", String(WEB_PORT)], {
    cwd: `${ROOT}/apps/dashboard`, stdio: "ignore", detached: true,
    env: { ...process.env, NODE_ENV: "development", NEXT_PUBLIC_API_URL: `http://localhost:${API_PORT}` },
  });
  cleanup.push(() => { try { process.kill(-dash.pid, "SIGTERM"); } catch {} });

  // ---- Chrome ----------------------------------------------------------------------------------
  const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(RUN, "chrome")}`, "--window-size=1440,1000", "--no-first-run", "about:blank"], { stdio: "ignore" });
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
  let problems = [];
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) return void (pending.get(msg.id)(msg), pending.delete(msg.id));
    const p = msg.params;
    if (msg.method === "Runtime.consoleAPICalled" && p.type === "error") problems.push(`console.error: ${p.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300)}`);
    if (msg.method === "Runtime.exceptionThrown") problems.push(`exception: ${(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text).slice(0, 300)}`);
    if (msg.method === "Log.entryAdded" && p.entry.level === "error") problems.push(`log: ${p.entry.text.slice(0, 200)} ${p.entry.url ?? ""}`);
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
  const expect = async (name, expr, ms = 30_000) => {
    try {
      await waitFor(expr, name, ms);
      check(name, true);
    } catch {
      check(name, false, (await js("document.querySelector('main')?.innerText ?? document.body.innerText").catch(() => "")).replace(/\s+/g, " ").slice(0, 400));
    }
  };
  const shot = async (name) => writeFileSync(join(OUT, name), Buffer.from((await cdp("Page.captureScreenshot", { format: "png" })).data, "base64"));
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Log.enable");

  const text = (sel = "main") => `(document.querySelector(${JSON.stringify(sel)})?.innerText ?? "")`;
  const has = (s, sel = "main") => `${text(sel)}.includes(${JSON.stringify(s)})`;
  const setValue = (selector, value) => js(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error("no element ${selector.replace(/"/g, "'")}");
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
  const selectByText = (selector, optionText) => js(`(() => {
    const s = document.querySelector(${JSON.stringify(selector)}); const o = [...s.options].find((o) => o.textContent.includes(${JSON.stringify(optionText)}));
    if (!o) throw new Error("no option ${optionText}");
    if (s.value === o.value) return o.value;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, o.value); s.dispatchEvent(new Event("change", { bubbles: true })); return o.value; })()`);
  const click = (label, scope = "main") => js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => b.textContent.trim() === ${JSON.stringify(label)});
    if (!b) throw new Error("no button ${label}"); b.click(); return true; })()`);
  const pageProblems = async (label) => {
    await sleep(600);
    devNotices += problems.filter((x) => DEV_NOTICE.test(x)).length;
    const p = problems.filter((x) => !DEV_NOTICE.test(x));
    check(`${label}: no console errors`, p.length === 0, p.join(" | "));
  };
  const visit = async (path, ready, label) => {
    await cdp("Page.navigate", { url: `${WEB}${path}` });
    problems = [];
    await waitFor(ready, label, 90_000);
  };
  const login = async (email) => {
    await cdp("Network.clearBrowserCookies");
    await cdp("Page.navigate", { url: `${WEB}/login` });
    await waitFor(`(() => { const f = document.querySelector('form'); return !!f && location.pathname === "/login" && Object.keys(f).some((k) => k.startsWith('__reactProps')); })()`, "hydrated login form", 120_000);
    await setValue("input[type=email], input[name=email]", email);
    await setValue("input[type=password]", PASSWORD);
    await js("document.querySelector('form').requestSubmit()");
    await waitFor(`location.pathname !== "/login"`, `sign-in as ${email}`);
  };
  /** The overlay row (date label + bar + text) for a local date, or "" when that date has no row. */
  const overlayRow = (date) => `([...document.querySelectorAll("main .grid")].find((g) => g.firstElementChild?.textContent === ${JSON.stringify(date)})?.innerText ?? "")`;
  const markerTitle = (date) => `([...document.querySelectorAll("main .grid")].find((g) => g.firstElementChild?.textContent === ${JSON.stringify(date)})?.querySelector('[title^="Expected start"]')?.title ?? "")`;

  let up = false;
  for (let i = 0; i < 300 && !up; i++) {
    up = await fetch(`${WEB}/login`).then((r) => r.ok, () => false);
    if (!up) await sleep(500);
  }
  assert.ok(up, "next dev did not serve /login");
  check("dashboard served by next dev", true);

  // Real WebP screenshots (synthetic content), encoded by Chrome, through register + upload; then Tia clocks out.
  await cdp("Page.navigate", { url: `${WEB}/login` });
  await waitFor("document.readyState === 'complete'", "blank page");
  for (const n of [1, 2]) {
    const bytes = Buffer.from(await js(`(async () => {
      const c = document.createElement("canvas"); c.width = 1280; c.height = 720; const g = c.getContext("2d");
      g.fillStyle = "hsl(${n * 120} 55% 40%)"; g.fillRect(0, 0, 1280, 720); g.fillStyle = "#fff"; g.font = "bold 80px sans-serif"; g.fillText("SYNTHETIC #${n}", 100, 380);
      const b = await new Promise((r) => c.toBlob(r, "image/webp", 0.7)); const u = new Uint8Array(await b.arrayBuffer());
      let s = ""; for (const x of u) s += String.fromCharCode(x); return btoa(s); })()`), "base64");
    const id = randomUUID();
    const reg = await api("/screenshots/register", { method: "POST", bearer: tia.bearer, device: tia.device, body: { id, capturedAt: iso(now - (100 - n * 10) * M), sentAt: iso(Date.now()), width: 1280, height: 720, sizeBytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), mimeType: "image/webp" } });
    assert.equal(reg.body?.status, "REGISTERED", reg.text);
    assert.equal((await api(`/screenshots/${id}/content`, { method: "PUT", bearer: tia.bearer, device: tia.device, raw: bytes })).status, 200);
  }
  assert.equal((await tia.sync([["CLOCK_OUT", now - M]])).status, 200);
  const tiaSession = (await db.execute({ sql: "SELECT id, clock_in_at FROM attendance_sessions WHERE employee_id = ?", args: [tia.id] })).rows[0];

  // ================================ Admin ========================================================
  await login("admin@example.com");

  // ---- W24: expected window on admin /activity ---------------------------------------------------
  {
    await visit("/activity", `!!document.querySelector('#activity-view-btn-employee')`, "activity page");
    await js(`document.querySelector('#activity-view-btn-employee').click()`);
    await waitFor(`[...(document.querySelector('main select')?.options ?? [])].some((o) => o.textContent.includes(${JSON.stringify(ben.name)}))`, "employee picker");
    await selectByText("main select", ben.name);
    await waitFor(has("per day (00:00–24:00, UTC)"), "overlay");
    // The default range is this week; start it at yesterday so the holiday is in range on any weekday.
    await setValue("main input[type=date]", YESTERDAY);
    await expect(`W24 admin /activity: today (${ymd(now)}) shows "Expected start 10:30" (Ben's override, not the organisation's 09:00)`, `${overlayRow(ymd(now))}.includes("Expected start 10:30") && !${overlayRow(ymd(now))}.includes("09:00 ·")`);
    check("W24 admin /activity: the marker is drawn at 10:30 (title of the bar segment)", (await js(markerTitle(ymd(now)))).startsWith("Expected start 10:30"), await js(markerTitle(ymd(now))));
    const left = await js(`([...document.querySelectorAll("main .grid")].find((g) => g.firstElementChild?.textContent === ${JSON.stringify(ymd(now))})?.querySelector('[title^="Expected start"]')?.style.left ?? "")`);
    check("W24 admin /activity: marker position = 10:30 of 24 h (43.75%)", left === "43.75%", left);
    const hol = await js(overlayRow(YESTERDAY));
    check(`W24 admin /activity: holiday ${YESTERDAY} has its shift row but no expected window`, hol.includes("No breaks") && !hol.includes("Expected start") && !(await js(markerTitle(YESTERDAY))), hol.replace(/\s+/g, " "));
    await shot("w24-activity-admin-expected.png");
    await pageProblems("/activity");
  }

  // ---- AW-04: Storage card "Last upload"; F01: automatic timelapse toggle ------------------------
  {
    const last = String((await db.execute("SELECT max(stored_at) AS at FROM screenshots")).rows[0].at);
    const shown = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(last));
    await visit("/settings", `!!document.querySelector('input[name=autoTimelapse]') && !!document.querySelector('[data-testid=storage-last-upload]')`, "settings page");
    await expect(`AW-04 Storage card shows "Last upload" = ${shown}`, `document.querySelector('[data-testid=storage-last-upload]')?.textContent === ${JSON.stringify(shown)} && ${has("Last upload")}`);
    const ready = await fetch(`http://localhost:${API_PORT}/api/v1/ready`).then((r) => r.text());
    check("AW-04 the public /ready does not expose the last upload", !/lastUpload/i.test(ready));
    await shot("aw04-storage-last-upload.png");

    check("F01 toggle is off by default", (await js("document.querySelector('input[name=autoTimelapse]').checked")) === false);
    await js(`(() => { const box = document.querySelector('input[name=autoTimelapse]'); box.click(); box.form.querySelector('[name=reason]').id = 'auto-reason'; return true; })()`);
    await setValue("#auto-reason", "Daily videos for the pilot");
    await js("document.querySelector('input[name=autoTimelapse]').form.requestSubmit()");
    await expect("F01 settings saved with the toggle on (page reloads it checked)", `${has("Saved. Desktops pick up the change")} && document.querySelector('input[name=autoTimelapse]')?.checked === true`);
    const saved = await api("/settings/screenshots", { cookie: adminCookie });
    check("F01 API: effective.autoTimelapse = true, previous version kept off", saved.body.effective.autoTimelapse === true && saved.body.history[1]?.autoTimelapse === false, JSON.stringify(saved.body.history.map((h) => h.autoTimelapse)));
    await shot("f01-auto-timelapse-toggle.png");
    await pageProblems("/settings");

    // Scheduler tick with an injected clock: one hour after Tia's local (UTC) day ends.
    const service = app.get(TimelapseService);
    const encoder = app.get(TIMELAPSE_ENCODER);
    const reason = await encoder.probe();
    if (reason) {
      // No usable FFmpeg here: job logic only (frames concatenated), reported as such.
      Object.assign(service, { encoderReason: null });
      encoder.encode = async (frames, out) => { const parts = []; for await (const f of frames) parts.push(f); await writeFile(out, Buffer.concat(parts)); };
    }
    const tick = Date.parse(`${ymd(Date.parse(String(tiaSession.clock_in_at)) + DAY)}T00:00:00Z`) + 60 * M;
    check("F01 tick before the employee's day ends queues nothing", (await service.autoTick(tick - 2 * 60 * M)) === 0);
    const queued = await service.autoTick(tick);
    const job = (await db.execute({ sql: "SELECT id, status, automatic FROM timelapses WHERE attendance_session_id = ?", args: [tiaSession.id] })).rows[0];
    check("F01 tick after the day ends queues one automatic job for the seeded day", queued === 1 && job && Number(job.automatic) === 1, `queued=${queued} job=${JSON.stringify(job)}`);
    await service.pump();
    const view = await api(`/timelapses/${job?.id}`, { cookie: adminCookie });
    check(`F01 the job becomes READY (${reason ? "fake encoder: no FFmpeg here" : "real FFmpeg"}) and is marked automatic`, view.body?.status === "READY" && view.body?.automatic === true && view.body?.framesDone === 2, view.text.slice(0, 200));
    check("F01 a second tick does not queue it again", (await service.autoTick(tick + 60 * M)) === 0);
  }

  // ================================ Employee (Ben) ===================================================
  await login(ben.email);
  {
    await visit("/my/activity", has("Timeline"), "my activity");
    await expect(`W24 /my/activity today: "Expected start 10:30"`, `${overlayRow(ymd(now))}.includes("Expected start 10:30")`);
    check("W24 /my/activity: the marker is drawn at 10:30", (await js(markerTitle(ymd(now)))).startsWith("Expected start 10:30"));
    await shot("w24-my-activity-expected.png");
    await click("Previous day");
    await expect(`W24 /my/activity on the holiday (${YESTERDAY}): shift shown, no expected window`, `${overlayRow(YESTERDAY)}.includes("No breaks") && !${overlayRow(YESTERDAY)}.includes("Expected start")`);
    await shot("w24-my-activity-holiday.png");
    await pageProblems("/my/activity");
  }
} catch (err) {
  check("run completed", false, err?.stack ?? String(err));
} finally {
  for (const fn of cleanup.reverse()) await Promise.resolve().then(fn).catch(() => {});
  await sleep(500);
  rmSync(RUN, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
if (devNotices) console.log(`INFO  ${devNotices} Next dev instant-navigation validation notice(s) ignored (dev only)`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${OUT}`);
process.exit(failed.length ? 1 : 0);
