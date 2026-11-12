// Wave 2 browser check: a throwaway API (temporary file DB, local storage) on :4108, `next dev` on
// :3108, headless Chrome over CDP on :9408. Synthetic data only. Covers: gallery capture times in each
// employee's zone (AW-05), teams + head + members + productivity (W40/W41/F05), alerts (F06),
// holidays + CSV import (W38/W39), daily attendance HOLIDAY vs ABSENT (W18), leave types and
// balances (W35/W36), My leave, settings storage card (AW-04) and idle-excluded apps (W22),
// per-person tracking overrides (W17/W21), breaks overlay on /activity and /my/activity (W24), and
// what a team head sees when signing in. Every page is also checked for console errors.
// Run after `pnpm build:packages && pnpm --filter @workfolio/api build`; needs Google Chrome (macOS path).
// Usage: node apps/dashboard/scripts/verify-wave2.mjs [out-dir]
// Production build: `NEXT_PUBLIC_API_URL=http://localhost:4108 next build`, then run with VERIFY_MODE=start.
// In dev, Next 16's instant-navigation validation logs one console.error per auth-gated route
// ("Could not validate that a segment ... has instant navigation"); it is dev-only, counted and
// reported but not failed. VERIFY_VERBOSE=1 prints full console messages.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const ROOT = resolve(import.meta.dirname, "../../..");
const API_PORT = 4108, WEB_PORT = 3108, CDP_PORT = 9408;
const WEB = `http://localhost:${WEB_PORT}`;
const MODE = process.env.VERIFY_MODE === "start" ? "start" : "dev";
const DEV_NOTICE = /Could not validate that a segment in your UI has instant navigation/;
let devNotices = 0;
/** PNG screenshots land here; the database, files and Chrome profile are deleted at the end. */
const OUT = process.argv[2] ?? mkdtempSync(join(tmpdir(), "wf-verify-wave2-"));
const RUN = join(OUT, "run");
rmSync(RUN, { recursive: true, force: true });
mkdirSync(join(RUN, "shots"), { recursive: true });
Object.assign(process.env, {
  NODE_ENV: "development", LOG_LEVEL: "warn", PORT: String(API_PORT),
  DATABASE_URL: `file:${join(RUN, "wave2.db")}`,
  JWT_SECRET: "wave2-check-secret-wave2-check-secret",
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
const PASSWORD = "wave two check password 1";
const NOTICE = "2026-10-screenshots-draft-1";
/** Same format as apps/dashboard/src/lib/zoned-time.ts. */
const zoned = (ms, timeZone) => `${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "medium", timeZone }).format(new Date(ms))} (${timeZone})`;
const hhmm = (ms) => iso(ms).slice(11, 16);

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
  // Screenshots on (60 s), and a work schedule (09:00, every day), both effective 30 days ago.
  await db.execute({
    sql: `INSERT INTO screenshot_policies (screenshots_enabled, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
            retention_approved, notice_version, reason, changed_by, effective_at) VALUES (1, 60, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, ?, 'wave2 check', ?, ?)`,
    args: [NOTICE, adminId, iso(now - 30 * DAY)],
  });
  await db.execute({ sql: "INSERT INTO work_schedule_policies (enabled, expected_start, grace_minutes, workdays, reason, changed_by, effective_at) VALUES (1, '09:00', 0, '1234567', 'wave2 check', ?, ?)", args: [adminId, iso(now - 30 * DAY)] });

  async function employee(n, name, timezone, events = []) {
    const email = `wave2-${n}@example.com`;
    const r = await api("/employees", { method: "POST", cookie: adminCookie, body: { email, employeeCode: `W2-${n}`, fullName: name, timezone } });
    assert.equal(r.status, 201, r.text);
    await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
    const bearer = (await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } })).body.accessToken;
    const e = { id: r.body.employee.id, userId: r.body.employee.userId, email, name, timezone, bearer, device: randomUUID() };
    await db.execute({ sql: "UPDATE employee_profiles SET created_at = ? WHERE id = ?", args: [iso(now - 30 * DAY), e.id] });
    if (events.length) {
      await api("/devices/register", { method: "POST", bearer, body: { installationId: e.device, deviceName: "Mac", platform: "macos" } });
      await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), e.id, NOTICE, iso(now - 5 * 60 * M)] });
      const sync = await api("/attendance/sync", { method: "POST", bearer, device: e.device, body: { sentAt: iso(Date.now()), events: events.map(([type, at]) => ({ id: randomUUID(), type, occurredAt: iso(at) })) } });
      assert.equal(sync.status, 200, sync.text);
    }
    return e;
  }
  // Ben: one finished shift today (UTC) with a break, at whole minutes so the overlay's HH:MM is exact.
  const midnight = Date.parse(`${ymd(now)}T00:00:00Z`);
  const at = (f) => midnight + Math.floor(((now - midnight) * f) / M) * M;
  const shift = { in: at(0.1), bs: at(0.4), be: at(0.6), out: at(0.9) };
  assert.ok(shift.in < shift.bs && shift.bs < shift.be && shift.be < shift.out, "run after 00:10 UTC so a shift fits into today");
  const kavya = await employee(1, "Kavya Kolkata", "Asia/Kolkata", [["CLOCK_IN", now - 180 * M]]);
  const nate = await employee(2, "Nate NewYork", "America/New_York", [["CLOCK_IN", now - 180 * M]]);
  const ben = await employee(3, "Ben Breaks", "UTC", [["CLOCK_IN", shift.in], ["BREAK_START", shift.bs], ["BREAK_END", shift.be], ["CLOCK_OUT", shift.out]]);
  const hana = await employee(4, "Hana Head", "UTC");
  const D = ymd(now - DAY); // holiday
  const D0 = ymd(now - 2 * DAY); // ordinary workday

  // ---- Dashboard (next dev, or next start of a build made for this API port) --------------------
  const dash = spawn("pnpm", ["exec", "next", MODE, "--port", String(WEB_PORT)], {
    cwd: `${ROOT}/apps/dashboard`, stdio: "ignore", detached: true,
    env: { ...process.env, NODE_ENV: MODE === "dev" ? "development" : "production", NEXT_PUBLIC_API_URL: `http://localhost:${API_PORT}` },
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
  /** Console errors, uncaught exceptions and failed loads since the last visit(). */
  let problems = [];
  const requests = [];
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) return void (pending.get(msg.id)(msg), pending.delete(msg.id));
    const p = msg.params;
    if (msg.method === "Runtime.consoleAPICalled" && p.type === "error") problems.push(`console.error: ${p.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, process.env.VERIFY_VERBOSE ? 5000 : 300)}`);
    if (msg.method === "Runtime.exceptionThrown") problems.push(`exception: ${(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text).slice(0, 300)}`);
    if (msg.method === "Log.entryAdded" && p.entry.level === "error") problems.push(`log: ${p.entry.text.slice(0, 200)} ${p.entry.url ?? ""}`);
    if (msg.method === "Network.requestWillBeSent") requests.push(p.request.url);
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
  /** Like waitFor, but records a failed check instead of aborting the run. */
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
  await cdp("Network.enable");

  const text = (sel = "main") => `(document.querySelector(${JSON.stringify(sel)})?.innerText ?? "")`;
  const has = (s, sel = "main") => `${text(sel)}.includes(${JSON.stringify(s)})`;
  /** Sets an input/textarea/select value the way React notices. */
  const setValue = (selector, value) => js(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error("no element ${selector.replace(/"/g, "'")}");
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
  const selectByText = (selector, optionText) => js(`(() => {
    const s = document.querySelector(${JSON.stringify(selector)}); const o = [...s.options].find((o) => o.textContent.includes(${JSON.stringify(optionText)}));
    if (!o) throw new Error("no option ${optionText}");
    if (s.value === o.value) return o.value; // already chosen (e.g. auto-selected): a change event for the same value would be a no-op pick
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, o.value); s.dispatchEvent(new Event("change", { bubbles: true })); return o.value; })()`);
  const click = (label, scope = "main") => js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => b.textContent.trim() === ${JSON.stringify(label)} || b.getAttribute("aria-label") === ${JSON.stringify(label)});
    if (!b) throw new Error("no button ${label}"); b.click(); return true; })()`);
  const pageProblems = async (label) => {
    await sleep(600);
    devNotices += problems.filter((x) => MODE === "dev" && DEV_NOTICE.test(x)).length;
    const p = problems.filter((x) => !(MODE === "dev" && DEV_NOTICE.test(x)));
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

  // Real WebP screenshots (synthetic content), encoded by Chrome, through register + upload.
  const webp = async (n) => Buffer.from(await js(`(async () => {
    const c = document.createElement("canvas"); c.width = 1920; c.height = 1080; const g = c.getContext("2d");
    g.fillStyle = "hsl(${(n * 97) % 360} 55% 40%)"; g.fillRect(0, 0, 1920, 1080);
    g.fillStyle = "#fff"; g.font = "bold 120px sans-serif"; g.fillText("SYNTHETIC TEST #${n}", 120, 560);
    const b = await new Promise((r) => c.toBlob(r, "image/webp", 0.7)); const u = new Uint8Array(await b.arrayBuffer());
    let s = ""; for (const x of u) s += String.fromCharCode(x); return btoa(s); })()`), "base64");
  const SHOT_AT = Math.floor((now - 60 * M) / M) * M + 7_000; // a known instant: hh:mm:07
  for (const [i, e] of [kavya, nate].entries()) {
    const bytes = await webp(i + 1);
    const id = randomUUID();
    const reg = await api("/screenshots/register", { method: "POST", bearer: e.bearer, device: e.device, body: { id, capturedAt: iso(SHOT_AT), sentAt: iso(Date.now()), width: 1920, height: 1080, sizeBytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), mimeType: "image/webp" } });
    assert.equal(reg.body?.status, "REGISTERED", reg.text);
    assert.equal((await api(`/screenshots/${id}/content`, { method: "PUT", bearer: e.bearer, device: e.device, raw: bytes })).status, 200);
  }

  let up = false;
  for (let i = 0; i < 300 && !up; i++) {
    up = await fetch(`${WEB}/login`).then((r) => r.ok, () => false);
    if (!up) await sleep(500);
  }
  assert.ok(up, `next ${MODE} did not serve /login`);
  check(`dashboard served by next ${MODE}`, true);

  // ================================ Admin ========================================================
  await login("admin@example.com");

  // ---- AW-05: gallery capture times in each employee's zone ------------------------------------
  {
    const card = (name) => `[...document.querySelectorAll('section[aria-label="Screenshot gallery"] li')].find((li) => li.innerText.includes(${JSON.stringify(name)}))`;
    const startReq = requests.length;
    await visit("/screenshots", `${card(kavya.name)} && ${card(nate.name)} && document.querySelectorAll('section[aria-label="Screenshot gallery"] li img').length === 2`, "gallery with 2 thumbnails");
    const kText = await js(`${card(kavya.name)}.innerText`);
    const nText = await js(`${card(nate.name)}.innerText`);
    const kWant = zoned(SHOT_AT, "Asia/Kolkata"), nWant = zoned(SHOT_AT, "America/New_York");
    check("AW-05 Kolkata tile shows the capture time in Asia/Kolkata with the zone named", kText.includes(kWant), `${kWant} in ${JSON.stringify(kText)}`);
    check("AW-05 New York tile shows the same instant in America/New_York with the zone named", nText.includes(nWant), `${nWant} in ${JSON.stringify(nText)}`);
    check("AW-05 the two tiles show different local times for one instant", kWant !== nWant);
    await shot("aw05-gallery-two-zones.png");
    await js(`${card(nate.name)}.querySelector('button').click()`);
    await waitFor(`(() => { const i = document.querySelector('dialog[open] img'); return i && i.complete && i.naturalWidth === 1920; })()`, "viewer");
    const header = await js(`document.querySelector('dialog[open]').innerText`);
    check("AW-05 viewer header shows the employee's local time and zone", header.includes(nWant), header.split("\n")[0]);
    await shot("aw05-viewer-new-york.png");
    await js(`document.querySelector('dialog[open]').close()`);
    const perEmployee = requests.slice(startReq).filter((u) => /\/api\/v1\/employees\/[0-9a-f-]{36}(\?|$)/.test(u));
    check("AW-05 no per-employee GET /employees/:id lookups from the gallery", perEmployee.length === 0, perEmployee.join(", "));
    await pageProblems("/screenshots");
  }

  // ---- W40/W41/F05: teams ------------------------------------------------------------------------
  {
    await visit("/teams", `${has("No teams yet.")} && ${has("No active teams.")}`, "teams empty state");
    check("W40 /teams empty states (no teams, no active teams in productivity)", true);
    await shot("w40-teams-empty.png");
    await waitFor(`document.querySelectorAll('form[aria-label="Create a team"] select option').length >= 5`, "head options");
    await setValue('form[aria-label="Create a team"] input', "Support");
    await js(`document.querySelector('form[aria-label="Create a team"]').requestSubmit()`);
    await expect("W40 create team from the page", `${has("Created Support.")} && !!document.querySelector('table[aria-label="Teams"]')`);
    await click("Edit Support");
    await waitFor(`!!document.querySelector('form[aria-label="Name and head"]')`, "edit card");
    await selectByText('form[aria-label="Name and head"] select', hana.name);
    await js(`document.querySelector('form[aria-label="Name and head"]').requestSubmit()`);
    await expect("W41 set the team head from the page", `${has("Saved Support.")} && ${text('table[aria-label="Teams"]')}.includes("Hana Head")`);
    await click("Edit Support");
    await waitFor(`!!document.querySelector('form[aria-label="Name and head"]')`, "edit card again");
    for (const name of [ben.name, kavya.name]) await js(`[...document.querySelectorAll('fieldset label')].find((l) => l.innerText.includes(${JSON.stringify(name)})).querySelector('input').click()`);
    await click("Save members");
    await expect("W40 add members from the page (Members column = 2)", `${has("Saved the members of Support.")} && [...document.querySelectorAll('table[aria-label="Teams"] tr')].some((r) => r.innerText.includes("Support") && r.cells[2]?.innerText.trim() === "2")`);
    const t = (await api("/teams", { cookie: adminCookie })).body.find((x) => x.name === "Support");
    check("W40/W41 API agrees: head Hana, members Ben + Kavya", t?.head?.id === hana.userId && t.members.map((m) => m.id).sort().join() === [ben.id, kavya.id].sort().join(), JSON.stringify({ head: t?.head, members: t?.members?.map((m) => m.fullName) }));
    await visit("/teams", `!!document.querySelector('table[aria-label="Productivity by team"]')`, "productivity table");
    const prod = await js(text('table[aria-label="Productivity by team"]'));
    check("F05 /teams productivity table lists Support with 2 members", /Support\s+2\s/.test(prod), prod.replace(/\s+/g, " "));
    await shot("w40-teams-productivity.png");
    await pageProblems("/teams");
  }

  // ---- F06: alerts --------------------------------------------------------------------------------
  {
    await visit("/alerts", `${has("No alerts.")} && ${has("No rules yet.")}`, "alerts empty state");
    check("F06 /alerts empty states (no alerts, no rules)", true);
    await setValue('form[aria-label="Add a rule"] input', "Late arrivals");
    await js(`document.querySelector('form[aria-label="Add a rule"]').requestSubmit()`);
    await expect("F06 create a rule from the page; it is listed", `${has("Added rule Late arrivals.")} && ${text('table[aria-label="Alert rules"]')}.includes("Late arrivals")`);
    const rule = (await db.execute("SELECT id FROM alert_rules WHERE name = 'Late arrivals'")).rows[0];
    const DETAIL = "Seeded by verify-wave2: clocked in at 10:42";
    await db.execute({ sql: "INSERT INTO alerts (id, rule_id, employee_id, date, detail) VALUES (?, ?, ?, ?, ?)", args: [randomUUID(), rule.id, ben.id, D0, DETAIL] });
    await visit("/alerts", `${text('table[aria-label="Alerts"]')}.includes(${JSON.stringify(DETAIL)})`, "seeded alert listed");
    check("F06 seeded alert is listed under Open", true);
    await shot("f06-alerts-open.png");
    await js(`[...document.querySelectorAll('table[aria-label="Alerts"] tr')].find((r) => r.innerText.includes(${JSON.stringify(DETAIL)})).querySelector('button').click()`);
    await expect("F06 acknowledge the alert from the page", `${has("Alert acknowledged.")} && !${text('table[aria-label="Alerts"]')}.includes(${JSON.stringify(DETAIL)})`);
    await click("Acknowledged");
    await expect("F06 Acknowledged tab shows it with the admin's email", `${text('table[aria-label="Alerts"]')}.includes(${JSON.stringify(DETAIL)}) && ${text('table[aria-label="Alerts"]')}.includes("Acknowledged by admin@example.com")`);
    await shot("f06-alerts-acknowledged.png");
    await pageProblems("/alerts");
  }

  // ---- W38/W39: holidays --------------------------------------------------------------------------
  {
    const year = new Date().getFullYear();
    await visit("/holidays", has(`No holidays in ${year}.`), "holidays empty state");
    check("W38 /holidays empty state", true);
    await setValue('form[aria-label="Add a holiday"] input[type=date]', D);
    await setValue('form[aria-label="Add a holiday"] input:not([type=date])', "Verify Day");
    await js(`document.querySelector('form[aria-label="Add a holiday"]').requestSubmit()`);
    await expect("W38 add a holiday from the page; it is listed", `${has("Added Verify Day on")} && ${text('table[aria-label="Holidays"]')}.includes("Verify Day")`);
    const csvPath = join(RUN, "holidays.csv");
    writeFileSync(csvPath, `date,name\n${year + 1}-01-01,New Year\n${year + 1}-12-25,"Christmas Day, office"\n`);
    const { result } = await cdp("Runtime.evaluate", { expression: "document.querySelector('input[type=file]')" });
    await cdp("DOM.enable");
    await cdp("DOM.setFileInputFiles", { files: [csvPath], objectId: result.objectId });
    await waitFor(`[...document.querySelectorAll('main button')].some((b) => b.textContent.trim() === "Import 2 holidays" && !b.disabled)`, "import button enabled");
    await click("Import 2 holidays");
    await expect("W39 CSV import from the page (2 created)", has("Imported 2 holidays."));
    const next = (await api(`/holidays?year=${year + 1}`, { cookie: adminCookie })).body.map((h) => `${h.date} ${h.name}`);
    check("W39 imported rows stored (quoted comma kept)", next.join("|") === `${year + 1}-01-01 New Year|${year + 1}-12-25 Christmas Day, office`, next.join("|"));
    await shot("w38-holidays.png");
    await pageProblems("/holidays");
  }

  // ---- W18: daily attendance shows HOLIDAY, not ABSENT ------------------------------------------------
  {
    const row = (name) => `([...document.querySelectorAll('main table tr')].find((r) => r.innerText.includes(${JSON.stringify(name)}))?.innerText ?? "")`;
    await visit("/attendance?view=daily", `!!document.querySelector('main input[type=date]')`, "daily view");
    await setValue("main input[type=date]", D);
    await expect(`W18 ${D} (holiday): Ben and Hana show Holiday`, `${row(ben.name)}.includes("Holiday") && ${row(hana.name)}.includes("Holiday")`);
    const hol = await js(`[...document.querySelectorAll('main table tr')].map((r) => r.innerText).join("\\n")`);
    check(`W18 ${D}: nobody Absent on the holiday`, !/Absent/.test(hol), hol.replace(/\s+/g, " ").slice(0, 300));
    await shot("w18-attendance-holiday.png");
    await setValue("main input[type=date]", D0);
    await expect(`W18 ${D0} (ordinary workday, no clock-in): Hana shows Absent`, `${row(hana.name)}.includes("Absent")`);
    await shot("w18-attendance-absent-contrast.png");
    await pageProblems("/attendance?view=daily");
  }

  // ---- W35/W36: leave types and balances ---------------------------------------------------------------
  {
    await visit("/leave", `!!document.querySelector('#leave-view-btn-types')`, "leave page");
    await js(`document.querySelector('#leave-view-btn-types').click()`);
    await waitFor(`!!document.querySelector('form[aria-label="New leave type"]') && !!document.querySelector('table[aria-label="Leave types"]')`, "leave types");
    await setValue('form[aria-label="New leave type"] input[maxlength="60"]', "Annual leave");
    const nums = 'form[aria-label="New leave type"] input[type=number]';
    await js(`(() => { const [d, h] = document.querySelectorAll(${JSON.stringify(nums)}); const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }; set(d, "20"); set(h, "4"); })()`);
    await js(`document.querySelector('form[aria-label="New leave type"]').requestSubmit()`);
    await expect("W36/W35 create a leave type (20 days, 4 h short leave per month) from the page", `${has("Saved Annual leave.")} && /Annual leave\\s+Paid\\s+20 days\\s+4 hours/.test(${text('table[aria-label="Leave types"]')})`);
    await shot("w36-leave-types.png");
    await js(`document.querySelector('#leave-view-btn-balances').click()`);
    await expect("W36 balances table: Annual leave column, Ben 20 of 20 days left", `(() => { const t = document.querySelector('table[aria-label="Leave balances"]'); if (!t) return false; const r = [...t.rows].find((r) => r.innerText.includes("Ben Breaks")); return t.tHead.innerText.includes("Annual leave") && !!r && r.innerText.includes("20 of 20 days left"); })()`);
    await shot("w36-leave-balances.png");
    await pageProblems("/leave");
  }

  // ---- AW-04 / W22: settings ------------------------------------------------------------------------------
  {
    await visit("/settings", `${has("Local development")} && ${has("Connected")} && !!document.querySelector('textarea[name=idleExcludedApps]')`, "settings storage card + policy form");
    check("AW-04 storage card: Local development, Connected", true);
    await setValue("textarea[name=idleExcludedApps]", "us.zoom.xos\nZoom.exe");
    await setValue("textarea[name=reason]", "verify-wave2: exclude video calls from idle");
    await js(`document.querySelector('textarea[name=idleExcludedApps]').form.requestSubmit()`);
    await expect("W22 monitoring form with idle-excluded apps saves from the page", has("Saved. Desktops pick up the change"));
    const s = (await api("/settings/monitoring", { cookie: adminCookie })).body;
    check("W22 API returns the saved idle-excluded apps", JSON.stringify(s?.effective?.idleExcludedApps) === JSON.stringify(["us.zoom.xos", "Zoom.exe"]), JSON.stringify(s?.effective?.idleExcludedApps));
    await waitFor(`document.querySelector('textarea[name=idleExcludedApps]').value === "us.zoom.xos\\nZoom.exe"`, "form shows saved list", 10_000).then(() => check("W22 form re-renders with the saved list", true), () => check("W22 form re-renders with the saved list", false));
    await shot("aw04-w22-settings.png");
    await pageProblems("/settings");
  }

  // ---- W17/W21: per-person tracking overrides ----------------------------------------------------------------
  {
    await visit(`/employees/${ben.id}`, `!!document.querySelector('input[name=expectedStart]')`, "tracking overrides form");
    await setValue("input[name=expectedStart]", "10:30");
    await setValue("input[name=idleThresholdSeconds]", "120");
    await js(`[...document.querySelectorAll('input[name=workday]')].filter((c) => Number(c.value) <= 5 && !c.checked).forEach((c) => c.click())`);
    await setValue("textarea[name=trackingReason]", "verify-wave2 later start");
    await js(`document.querySelector('input[name=expectedStart]').form.requestSubmit()`);
    await expect("W17/W21 tracking overrides save from the page; in force: start 10:30, Mon–Fri, idle 120 s", `${has("Saved. The schedule applies")} && ${has("start 10:30, Mon, Tue, Wed, Thu, Fri; idle after 120 s")}`);
    const o = (await api(`/settings/employees/${ben.id}/tracking`, { cookie: adminCookie })).body?.override;
    check("W17/W21 API returns the override", o?.expectedStart === "10:30" && o?.workdays === "12345" && o?.idleThresholdSeconds === 120, JSON.stringify(o));
    await shot("w17-tracking-overrides.png");
    await pageProblems(`/employees/[id]`);
  }

  // ---- W24: breaks overlay (admin) -------------------------------------------------------------------------------
  const breakText = `Breaks: ${hhmm(shift.bs)}–${hhmm(shift.be)}`;
  {
    await visit("/activity", `!!document.querySelector('#activity-view-btn-employee')`, "activity page");
    await js(`document.querySelector('#activity-view-btn-employee').click()`);
    await waitFor(`[...(document.querySelector('main select')?.options ?? [])].some((o) => o.textContent.includes("Ben Breaks"))`, "employee picker");
    await selectByText("main select", ben.name);
    await expect(`W24 admin /activity overlay for Ben: ${breakText} on ${ymd(now)}`, `${has(breakText)} && ${has("per day (00:00–24:00, UTC)")}`, 40_000);
    await shot("w24-activity-admin.png");
    await pageProblems("/activity");
  }

  // ================================ Employee (Ben) ===================================================
  await login(ben.email);
  check("employee sign-in lands on /my", (await js("location.pathname")).startsWith("/my"), await js("location.pathname"));
  {
    await visit("/my/activity", has("Day timeline"), "my activity"); // the card was renamed from "Timeline" (QA round 3)
    await expect(`W24 /my/activity overlay: ${breakText}`, has(breakText), 40_000);
    await shot("w24-my-activity.png");
    await pageProblems("/my/activity");

    await visit("/my/leave", `!!document.querySelector('table[aria-label="My leave balances"]') && !!document.querySelector('form[aria-label="New leave request"]')`, "my leave");
    const bal = await js(text('table[aria-label="My leave balances"]'));
    check("W36 /my/leave balances show Annual leave 20 of 20 days left and short leave 4 h", /Annual leave/.test(bal) && /20 of 20 days left/.test(bal) && /4 of 4 h left/.test(bal), bal.replace(/\s+/g, " "));
    check("/my/leave empty history state", await js(has("You have not requested any leave yet.")));
    await shot("w36-my-leave-before.png");
    await waitFor(`[...document.querySelectorAll('form[aria-label="New leave request"] select option')].some((o) => o.textContent.includes("Annual leave"))`, "type options");
    const typeSelect = await js(`(() => { const s = [...document.querySelectorAll('form[aria-label="New leave request"] select')].find((s) => [...s.options].some((o) => o.textContent.includes("Annual leave"))); s.id ||= "w2-type"; return "#" + s.id; })()`);
    await selectByText(typeSelect, "Annual leave");
    const tomorrow = ymd(now + DAY);
    await js(`(() => { const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); };
      const ds = document.querySelectorAll('form[aria-label="New leave request"] input[type=date]'); ds.forEach((d) => set(d, ${JSON.stringify(tomorrow)})); })()`);
    await js(`document.querySelector('form[aria-label="New leave request"]').requestSubmit()`);
    await expect("W36 request leave with a type from /my/leave; history shows Annual leave, Pending", `(() => { const t = document.querySelector('table[aria-label="My leave requests"]'); return !!t && /Annual leave/.test(t.innerText) && /Pending/.test(t.innerText); })()`);
    const mine = (await api("/leave?mine=true", { bearer: ben.bearer })).body?.items?.[0];
    check("W36 API: the request carries the chosen type", mine?.leaveType?.name === "Annual leave" || mine?.leaveTypeId === (await db.execute("SELECT id FROM leave_types WHERE name = 'Annual leave'")).rows[0]?.id, JSON.stringify({ type: mine?.leaveType ?? mine?.leaveTypeId, status: mine?.status }));
    await shot("w36-my-leave-requested.png");
    await pageProblems("/my/leave");
  }

  // ================================ Team head (Hana, an EMPLOYEE) ===================================
  await login(hana.email);
  await sleep(1500);
  const headLanding = await js("location.pathname");
  check("W41 team head sign-in lands on /my (no team-head dashboard UI yet)", headLanding.startsWith("/my"), headLanding);
  await shot("w41-team-head-landing.png");
  for (const path of ["/teams", "/employees", "/screenshots"]) {
    await cdp("Page.navigate", { url: `${WEB}${path}` });
    await sleep(500);
    await waitFor(`location.pathname.startsWith("/my") || document.body.innerText.includes("Open my dashboard")`, `team head on ${path}`, 60_000).catch(() => {});
    const where = await js(`location.pathname + " | " + document.body.innerText.replace(/\\s+/g, " ").slice(0, 80)`);
    check(`W41 team head opening ${path} is sent to /my`, where.startsWith("/my"), where);
  }
  const scoped = await api("/employees", { bearer: (await api("/auth/login", { method: "POST", body: { email: hana.email, password: PASSWORD, client: "desktop" } })).body.accessToken });
  check("W41 (API, for contrast) the head's GET /employees lists only team members", scoped.status === 200 && scoped.body.items.map((e) => e.fullName).sort().join() === [ben.name, kavya.name].sort().join(), `HTTP ${scoped.status} ${scoped.body?.items?.map((e) => e.fullName).join(", ")}`);
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
