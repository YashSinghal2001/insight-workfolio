// W41/F09 team-head browser check: a throwaway API (temporary file DB, local storage) on :4211, `next dev`
// on :3211, headless Chrome over CDP on :9511. Synthetic data only. Signs in as a team head (an EMPLOYEE
// heading team Alpha) and checks the "My team" area under /my: members, attendance, timesheets, screenshots
// gallery + timelapse panel, leave approve. Then signs in as a plain employee: no "My team" entry and the
// area refuses them. Every page is also checked for console errors.
// Run after `pnpm build:packages && pnpm --filter @workfolio/api build`; needs Google Chrome (macOS path).
// Usage: node apps/dashboard/scripts/verify-teamhead.mjs [out-dir]
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const ROOT = resolve(import.meta.dirname, "../../..");
const API_PORT = 4211, WEB_PORT = 3211, CDP_PORT = 9511;
const WEB = `http://localhost:${WEB_PORT}`;
const DEV_NOTICE = /Could not validate that a segment in your UI has instant navigation/;
let devNotices = 0;
const OUT = process.argv[2] ?? mkdtempSync(join(tmpdir(), "wf-verify-teamhead-"));
const RUN = join(OUT, "run");
rmSync(RUN, { recursive: true, force: true });
mkdirSync(join(RUN, "shots"), { recursive: true });
Object.assign(process.env, {
  NODE_ENV: "development", LOG_LEVEL: "warn", PORT: String(API_PORT),
  DATABASE_URL: `file:${join(RUN, "teamhead.db")}`,
  JWT_SECRET: "teamhead-check-secret-teamhead-check-secret",
  SCREENSHOT_STORAGE: "local", SCREENSHOT_LOCAL_DIR: join(RUN, "shots"),
  CORS_ORIGINS: WEB, DASHBOARD_URL: WEB,
});
const results = [];
const check = (name, ok, detail = "") => (results.push({ name, ok: !!ok }), console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = [];
const M = 60_000, DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
const ymd = (ms) => iso(ms).slice(0, 10);
const PASSWORD = "team head check password 1";
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
  await db.execute({
    sql: `INSERT INTO screenshot_policies (screenshots_enabled, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
            retention_approved, notice_version, reason, changed_by, effective_at) VALUES (1, 60, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, ?, 'team head check', ?, ?)`,
    args: [NOTICE, adminId, iso(now - 30 * DAY)],
  });

  async function employee(n, name, clockedIn) {
    const email = `teamhead-${n}@example.com`;
    const r = await api("/employees", { method: "POST", cookie: adminCookie, body: { email, employeeCode: `TH-${n}`, fullName: name, timezone: "UTC" } });
    assert.equal(r.status, 201, r.text);
    await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
    const bearer = (await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } })).body.accessToken;
    const e = { id: r.body.employee.id, userId: r.body.employee.userId, email, name, bearer, device: randomUUID() };
    if (clockedIn) {
      await api("/devices/register", { method: "POST", bearer, body: { installationId: e.device, deviceName: "Mac", platform: "macos" } });
      await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), e.id, NOTICE, iso(now - 5 * 60 * M)] });
      const sync = await api("/attendance/sync", { method: "POST", bearer, device: e.device, body: { sentAt: iso(Date.now()), events: [{ id: randomUUID(), type: "CLOCK_IN", occurredAt: iso(now - 120 * M) }] } });
      assert.equal(sync.status, 200, sync.text);
    }
    return e;
  }
  const hana = await employee(1, "Hana Head", false);
  const mia = await employee(2, "Mia Member", true);
  const otto = await employee(3, "Otto Outsider", true);
  const pete = await employee(4, "Pete Plain", false);
  const team = await api("/teams", { method: "POST", cookie: adminCookie, body: { name: "Alpha", headUserId: hana.userId } });
  assert.equal(team.status, 201, team.text);
  assert.equal((await api(`/teams/${team.body.id}/members`, { method: "PUT", cookie: adminCookie, body: { employeeIds: [mia.id] } })).status, 200);
  const leaveOf = async (e, offset) => {
    const r = await api("/leave", { method: "POST", bearer: e.bearer, body: { startDate: ymd(now + offset * DAY), endDate: ymd(now + offset * DAY), portion: "FULL_DAY", reason: `${e.name} trip` } });
    assert.equal(r.status, 201, r.text);
    return r.body.id;
  };
  const miaLeave = await leaveOf(mia, 5);
  const ottoLeave = await leaveOf(otto, 5);

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
  const expect = async (name, expr, ms = 20_000) => {
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
  const hasNot = (s, sel = "main") => `!${has(s, sel)}`;
  const setValue = (selector, value) => js(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error("no element ${selector.replace(/"/g, "'")}");
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
  const click = (label, scope = "main") => js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => b.textContent.trim() === ${JSON.stringify(label)} || b.getAttribute("aria-label") === ${JSON.stringify(label)});
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

  // Real WebP screenshots (synthetic content) for Mia (team) and Otto (outside), through register + upload.
  let up = false;
  for (let i = 0; i < 300 && !up; i++) {
    up = await fetch(`${WEB}/login`).then((r) => r.ok, () => false);
    if (!up) await sleep(500);
  }
  assert.ok(up, "next dev did not serve /login");
  check("dashboard served by next dev", true);
  await cdp("Page.navigate", { url: `${WEB}/login` });
  await waitFor("document.readyState === 'complete'", "login page");
  const webp = async (n) => Buffer.from(await js(`(async () => {
    const c = document.createElement("canvas"); c.width = 1280; c.height = 720; const g = c.getContext("2d");
    g.fillStyle = "hsl(${(n * 97) % 360} 55% 40%)"; g.fillRect(0, 0, 1280, 720);
    g.fillStyle = "#fff"; g.font = "bold 90px sans-serif"; g.fillText("SYNTHETIC TEST #${n}", 80, 380);
    const b = await new Promise((r) => c.toBlob(r, "image/webp", 0.7)); const u = new Uint8Array(await b.arrayBuffer());
    let s = ""; for (const x of u) s += String.fromCharCode(x); return btoa(s); })()`), "base64");
  for (const [i, e] of [mia, otto].entries()) {
    const bytes = await webp(i + 1);
    const id = randomUUID();
    const reg = await api("/screenshots/register", { method: "POST", bearer: e.bearer, device: e.device, body: { id, capturedAt: iso(now - 30 * M), sentAt: iso(Date.now()), width: 1280, height: 720, sizeBytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), mimeType: "image/webp" } });
    assert.equal(reg.body?.status, "REGISTERED", reg.text);
    assert.equal((await api(`/screenshots/${id}/content`, { method: "PUT", bearer: e.bearer, device: e.device, raw: bytes })).status, 200);
  }

  // ================================ Team head (Hana, an EMPLOYEE) ==================================
  await login(hana.email);
  await expect("team head lands on /my with a My team nav section", `location.pathname.startsWith("/my") && [...document.querySelectorAll('#my-nav a')].some((a) => a.getAttribute("href") === "/my/team")`, 60_000);
  check("team head nav has the 5 team links", (await js(`[...document.querySelectorAll('#my-nav a')].filter((a) => a.getAttribute("href").startsWith("/my/team")).length`)) === 5);
  await shot("teamhead-nav.png");

  await visit("/my/team", `${has(mia.name)} || ${has("This area")}`, "/my/team");
  await expect("My team: lists the member", has(mia.name));
  await expect("My team: outsider not shown", `${hasNot(otto.name)} && ${hasNot(pete.name)}`);
  await expect("My team: summary counts the team (1 member, 1 working)", `[...document.querySelectorAll('main a, main div')].some((d) => /^Members\\s*1$/.test(d.innerText.trim())) && [...document.querySelectorAll('main a')].some((d) => /^Working now\\s*1\\b/.test(d.innerText.trim()))`);
  await shot("teamhead-members.png");
  await pageProblems("/my/team");

  await visit("/my/team/attendance", `${has(mia.name)} || ${has("Could not load")}`, "/my/team/attendance");
  await expect("Team attendance: member clocked in", `${has(mia.name)} && ${has("Clocked in")}`);
  await expect("Team attendance: outsider not shown", hasNot(otto.name));
  await shot("teamhead-attendance.png");
  await pageProblems("/my/team/attendance");

  await visit("/my/team/timesheets", `${has(mia.name)} || ${has("Could not load")}`, "/my/team/timesheets");
  await expect("Team timesheets: member row, no outsider", `${has(mia.name)} && ${hasNot(otto.name)}`);
  await pageProblems("/my/team/timesheets");
  const exported = await api(`/attendance/timesheets/export?from=${ymd(now - 7 * DAY)}&to=${ymd(now)}`, { bearer: (await api("/auth/login", { method: "POST", body: { email: hana.email, password: PASSWORD, client: "desktop" } })).body.accessToken });
  check("Team timesheets export (API, the button's request) is team-only", exported.status === 200 && !exported.text.includes("TH-3"), `HTTP ${exported.status} rows=${exported.res.headers.get("x-export-rows")}`);

  await visit("/my/team/screenshots", `${has("screenshot(s)")} || ${has("No screenshots")} || ${has("Something went wrong")}`, "/my/team/screenshots");
  await expect("Team screenshots: one capture, the member's", `${has("1 screenshot(s)")} && ${has(mia.name)} && ${hasNot("Otto Outsider (TH-3)")}`);
  await expect("Team screenshots: thumbnail image loaded", `!!document.querySelector('section[aria-label="Screenshot gallery"] img')?.complete && document.querySelector('section[aria-label="Screenshot gallery"] img').naturalWidth > 0`);
  check("Team screenshots: picker offers only the member", (await js(`[...document.querySelectorAll('main select option')].map((o) => o.textContent).join("|")`)).includes(mia.name) && !(await js(`[...document.querySelectorAll('main select option')].map((o) => o.textContent).join("|")`)).includes(otto.name));
  await visit(`/my/team/screenshots?employeeId=${mia.id}`, `${has("Timelapse")} || ${has("Something went wrong")}`, "/my/team/screenshots?employeeId");
  await expect("Team screenshots: timelapse panel for the member", `${has("Timelapse")} && ${hasNot("Something went wrong")}`);
  await shot("teamhead-screenshots.png");
  await pageProblems("/my/team/screenshots");

  await visit("/my/team/leave", `${has(mia.name)} || ${has("No leave requests")} || ${has("Could not load")}`, "/my/team/leave");
  await expect("Team leave: member's pending request shown, outsider's not", `${has("Mia Member trip")} && ${hasNot("Otto Outsider trip")}`);
  await click("Approve");
  await expect("Team leave: approve removes it from Pending", hasNot("Mia Member trip"));
  const decided = (await db.execute({ sql: "SELECT status, decided_by FROM leave_requests WHERE id = ?", args: [miaLeave] })).rows[0];
  check("Team leave: request APPROVED by the head (DB)", decided?.status === "APPROVED" && decided?.decided_by === hana.userId, JSON.stringify(decided));
  const untouched = (await db.execute({ sql: "SELECT status FROM leave_requests WHERE id = ?", args: [ottoLeave] })).rows[0];
  check("Team leave: outsider's request untouched", untouched?.status === "PENDING");
  await shot("teamhead-leave.png");
  await pageProblems("/my/team/leave");

  // ================================ Plain employee (Pete) ===========================================
  await login(pete.email);
  await waitFor(`location.pathname.startsWith("/my") && !!document.querySelector('#my-nav a')`, "plain employee /my");
  check("plain employee: no My team entry", (await js(`[...document.querySelectorAll('#my-nav a')].filter((a) => a.getAttribute("href").startsWith("/my/team")).length`)) === 0);
  await visit("/my/team", `${has("This area is for team heads")}`, "/my/team as plain");
  check("plain employee: /my/team refuses (team heads only)", true);
  await visit("/my/team/leave", `${has("This area is for team heads")}`, "/my/team/leave as plain");
  check("plain employee: /my/team/leave refuses", true);
  await pageProblems("/my/team (plain)");
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
