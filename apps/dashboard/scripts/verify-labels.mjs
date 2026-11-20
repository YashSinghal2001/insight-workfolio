// F05 per-team labels and F08 per-person screenshot self-view in a real browser: a throwaway API
// (temporary file DB, local storage) on :4212, `next dev` on :3212, headless Chrome over CDP on :9512.
// Synthetic data only. An admin sets a team label on /teams and sees the team's productivity change; an
// admin denies one employee's self-view on the employee page and that employee's /my/screenshots shows
// no images (another employee still sees theirs). Every page is also checked for console errors.
// Run after `pnpm build:packages && pnpm --filter @workfolio/api build`; needs Google Chrome (macOS path).
// Usage: node apps/dashboard/scripts/verify-labels.mjs [out-dir]
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const ROOT = resolve(import.meta.dirname, "../../..");
const API_PORT = 4212, WEB_PORT = 3212, CDP_PORT = 9512;
const WEB = `http://localhost:${WEB_PORT}`;
const DEV_NOTICE = /Could not validate that a segment in your UI has instant navigation/;
let devNotices = 0;
const OUT = process.argv[2] ?? mkdtempSync(join(tmpdir(), "wf-verify-labels-"));
const RUN = join(OUT, "run");
rmSync(RUN, { recursive: true, force: true });
mkdirSync(join(RUN, "shots"), { recursive: true });
Object.assign(process.env, {
  NODE_ENV: "development", LOG_LEVEL: "warn", PORT: String(API_PORT),
  DATABASE_URL: `file:${join(RUN, "labels.db")}`,
  JWT_SECRET: "labels-check-secret-labels-check-secret",
  SCREENSHOT_STORAGE: "local", SCREENSHOT_LOCAL_DIR: join(RUN, "shots"),
  CORS_ORIGINS: WEB, DASHBOARD_URL: WEB,
});
const results = [];
const check = (name, ok, detail = "") => (results.push({ name, ok: !!ok }), console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = [];
const M = 60_000, DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
const PASSWORD = "labels check password 1";

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
  const DEFAULT_NOTICE_VERSION = (await api("/settings/monitoring", { cookie: adminCookie })).body.effective.noticeVersion;
  const DEFAULT_SCREENSHOT_NOTICE_VERSION = (await api("/settings/screenshots", { cookie: adminCookie })).body.effective.noticeVersion;
  assert.ok(DEFAULT_NOTICE_VERSION && DEFAULT_SCREENSHOT_NOTICE_VERSION, "notice versions");
  // Screenshots on, employees may view their own (organisation switch), effective 30 days ago.
  await db.execute({
    sql: `INSERT INTO screenshot_policies (screenshots_enabled, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
            retention_approved, notice_version, employee_self_view, reason, changed_by, effective_at) VALUES (1, 60, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, ?, 1, 'labels check', ?, ?)`,
    args: [DEFAULT_SCREENSHOT_NOTICE_VERSION, adminId, iso(now - 30 * DAY)],
  });
  const active = (name, start, end) => ({ id: randomUUID(), kind: "ACTIVE", applicationIdentifier: `com.example.${name}`, applicationName: name, startedAt: iso(start), endedAt: iso(end) });

  /** UTC employee clocked in 150 min ago: Slack 60 min, Code 30 min of ACTIVE time. */
  async function employee(n, name) {
    const email = `labels-${n}@example.com`;
    const r = await api("/employees", { method: "POST", cookie: adminCookie, body: { email, employeeCode: `LB-${n}`, fullName: name, timezone: "UTC" } });
    assert.equal(r.status, 201, r.text);
    await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
    const bearer = (await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } })).body.accessToken;
    const e = { id: r.body.employee.id, email, name, bearer, device: randomUUID() };
    await api("/devices/register", { method: "POST", bearer, body: { installationId: e.device, deviceName: "Mac", platform: "macos" } });
    for (const v of new Set([DEFAULT_NOTICE_VERSION, DEFAULT_SCREENSHOT_NOTICE_VERSION])) {
      await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), e.id, v, iso(now - 300 * M)] });
    }
    const t = now - 150 * M;
    assert.equal((await api("/attendance/sync", { method: "POST", bearer, device: e.device, body: { sentAt: iso(Date.now()), events: [{ id: randomUUID(), type: "CLOCK_IN", occurredAt: iso(t) }] } })).status, 200);
    const up = await api("/activity/sync", { method: "POST", bearer, device: e.device, body: { sentAt: iso(Date.now()), platform: "macos", intervals: [active("Slack", t, t + 60 * M), active("Code", t + 60 * M, t + 90 * M)] } });
    assert.ok(up.body.results.every((x) => x.status === "ACCEPTED"), up.text);
    return e;
  }
  const sam = await employee(1, "Sam Support"); // in team Support; self-view denied later
  const oli = await employee(2, "Oli Other"); // no team; keeps the organisation settings
  await api("/activity/categories", { method: "POST", cookie: adminCookie, body: { matchKind: "NAME", value: "Slack", category: "NEUTRAL" } });
  await api("/activity/categories", { method: "POST", cookie: adminCookie, body: { matchKind: "NAME", value: "Code", category: "PRODUCTIVE" } });
  const team = await api("/teams", { method: "POST", cookie: adminCookie, body: { name: "Support" } });
  await api(`/teams/${team.body.id}/members`, { method: "PUT", cookie: adminCookie, body: { employeeIds: [sam.id] } });

  // ---- Dashboard (next dev) ---------------------------------------------------------------------
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

  // Real WebP screenshots (synthetic content), encoded by Chrome, through register + upload.
  const webp = async (n) => Buffer.from(await js(`(async () => {
    const c = document.createElement("canvas"); c.width = 1280; c.height = 720; const g = c.getContext("2d");
    g.fillStyle = "hsl(${(n * 97) % 360} 55% 40%)"; g.fillRect(0, 0, 1280, 720);
    g.fillStyle = "#fff"; g.font = "bold 80px sans-serif"; g.fillText("SYNTHETIC TEST #${n}", 80, 380);
    const b = await new Promise((r) => c.toBlob(r, "image/webp", 0.7)); const u = new Uint8Array(await b.arrayBuffer());
    let s = ""; for (const x of u) s += String.fromCharCode(x); return btoa(s); })()`), "base64");
  const shotIds = {};
  for (const [i, e] of [sam, oli].entries()) {
    const bytes = await webp(i + 1);
    const id = randomUUID();
    const reg = await api("/screenshots/register", { method: "POST", bearer: e.bearer, device: e.device, body: { id, capturedAt: iso(now - 60 * M), sentAt: iso(Date.now()), width: 1280, height: 720, sizeBytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), mimeType: "image/webp" } });
    assert.equal(reg.body?.status, "REGISTERED", reg.text);
    assert.equal((await api(`/screenshots/${id}/content`, { method: "PUT", bearer: e.bearer, device: e.device, raw: bytes })).status, 200);
    shotIds[e.id] = String((await db.execute({ sql: "SELECT id FROM screenshots WHERE idempotency_key = ?", args: [id] })).rows[0].id);
  }

  let up = false;
  for (let i = 0; i < 300 && !up; i++) {
    up = await fetch(`${WEB}/login`).then((r) => r.ok, () => false);
    if (!up) await sleep(500);
  }
  assert.ok(up, "next dev did not serve /login");
  check("dashboard served by next dev", true);

  // ================================ Admin ========================================================
  await login("admin@example.com");
  const prodRow = `([...document.querySelectorAll('table[aria-label="Productivity by team"] tr')].find((r) => r.innerText.startsWith("Support"))?.innerText ?? "")`;

  // ---- F05: team label on /teams changes the team's productivity --------------------------------
  {
    await visit("/teams", `${prodRow}.includes("%")`, "team productivity");
    const before = await js(prodRow);
    await click("Edit Support");
    await waitFor(`!!document.querySelector('form[aria-label="Set a team label"]')`, "team labels form");
    check("F05 /teams shows a Labels card for the team being edited", await js(has("Labels for Support")));
    await setValue('form[aria-label="Set a team label"] select[name=matchKind]', "NAME");
    await setValue('form[aria-label="Set a team label"] input[name=value]', "Slack");
    await setValue('form[aria-label="Set a team label"] select[name=category]', "PRODUCTIVE");
    await js(`document.querySelector('form[aria-label="Set a team label"]').requestSubmit()`);
    await expect("F05 the team label is saved and listed", `!!document.querySelector('table[aria-label="Labels for Support"]') && ${text('table[aria-label="Labels for Support"]')}.includes("Slack") && ${text('table[aria-label="Labels for Support"]')}.includes("Productive")`);
    await expect("F05 team productivity on the page changes after setting the label", `${prodRow} !== ${JSON.stringify(before)} && ${prodRow}.includes("%")`);
    const after = await js(prodRow);
    console.log(`      Support row before: ${before.replace(/\s+/g, " ")} | after: ${after.replace(/\s+/g, " ")}`);
    const pct = (s) => Number(/(\d+)%/.exec(s)?.[1]);
    check("F05 Support productive % rises (Slack 60 min now productive)", pct(after) > pct(before), `${pct(before)}% -> ${pct(after)}%`);
    const day = iso(Date.now()).slice(0, 10);
    const tp = (await api(`/teams/productivity?from=${iso(Date.now() - 6 * DAY).slice(0, 10)}&to=${day}`, { cookie: adminCookie })).body.items.find((t) => t.team.name === "Support");
    check("F05 (API) Support productive time is now 90 min (Code 30 + Slack 60)", Math.round(tp.productiveMs / M) === 90, `${Math.round(tp.productiveMs / M)} min`);
    const oliSum = (await api(`/activity/summary?employeeId=${oli.id}&from=${iso(Date.now() - DAY).slice(0, 10)}&to=${day}`, { cookie: adminCookie })).body;
    check("F05 (API) a non-member keeps the organisation label (30 min productive)", Math.round(oliSum.productiveMs / M) === 30, `${Math.round(oliSum.productiveMs / M)} min`);
    await shot("f05-team-labels.png");
    await pageProblems("/teams");
  }

  // ---- F08: deny self-view for one employee on the employee page --------------------------------
  {
    await visit(`/employees/${sam.id}?tab=edit`, `!!document.querySelector('select[name=screenshotSelfView]')`, "self-view control");
    await setValue("select[name=screenshotSelfView]", "deny");
    await setValue("textarea[name=trackingReason]", "verify-labels privacy request");
    await click("Save these settings");
    await expect("F08 self-view deny saves from the employee page; in force: own screenshots hidden", `${has("Saved.")} && ${has("own screenshots hidden")}`);
    const o = (await api(`/settings/employees/${sam.id}/tracking`, { cookie: adminCookie })).body;
    check("F08 (API) override stored: deny while the organisation allows", o.override.screenshotSelfView === false && o.organisation.screenshotSelfView === true, JSON.stringify(o.override));
    await shot("f08-self-view-deny.png");
    await pageProblems(`/employees/${sam.id}`);
  }

  // ================================ Employees ====================================================
  {
    await login(oli.email);
    await visit("/my/screenshots", `document.querySelectorAll("main img").length > 0`, "other employee's own screenshots");
    check("F08 an employee without an override still sees their own screenshot images", (await js(`document.querySelectorAll("main img").length`)) > 0);
    await pageProblems("/my/screenshots (Oli)");

    await login(sam.email);
    await visit("/my/screenshots", `${has("My screenshots")} && !${has("Loading")}`, "denied employee's page");
    await sleep(1500);
    const imgs = await js(`document.querySelectorAll("main img").length`);
    check("F08 the denied employee's /my/screenshots shows no images", imgs === 0, `${imgs} img`);
    check("F08 the page shows the not-allowed notice", await js(has("not enabled viewing your own screenshots")));
    await shot("f08-my-screenshots-denied.png");
    await pageProblems("/my/screenshots (Sam)");
    const own = await api(`/screenshots/${shotIds[sam.id]}/content`, { bearer: sam.bearer });
    const list = await api("/screenshots", { bearer: sam.bearer });
    check("F08 (API) the denied employee gets 403 on their own list and content", own.status === 403 && list.status === 403, `list ${list.status}, content ${own.status}`);
    check("F08 (API) admins still get the image", (await api(`/screenshots/${shotIds[sam.id]}/content`, { cookie: adminCookie })).status === 200);
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
