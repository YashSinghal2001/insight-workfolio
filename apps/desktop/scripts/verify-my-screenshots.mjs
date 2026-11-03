// F03 + F07 + F08 runtime check: the employee History tab (hours, shifts, application activity, draft
// timesheet CSV download) and the
// "My screenshots" tab in the real desktop front end (served by Vite,
// running in headless Chrome without the Tauri shell, so tokens live in memory), against a throwaway
// API (temporary file DB, local storage) on :4000. Frames are synthetic canvases encoded to WebP by
// Chrome with the masks blacked out (no real screen). Tauri's CSP is not active in a plain browser;
// it is checked by test/my-screenshots.test.ts.
// Run after `pnpm build`. Needs Google Chrome (macOS path) and free ports 4000 and 1420.
// Usage: pnpm --filter @workfolio/desktop verify:my-screenshots [out-dir]
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = process.argv[2] ?? mkdtempSync(join(tmpdir(), "wf-verify-myshots-"));
const RUN = join(OUT, "run");
rmSync(RUN, { recursive: true, force: true });
mkdirSync(join(RUN, "shots"), { recursive: true });
Object.assign(process.env, {
  NODE_ENV: "development", LOG_LEVEL: "warn", PORT: "4000",
  DATABASE_URL: `file:${join(RUN, "myshots.db")}`,
  JWT_SECRET: "myshots-check-secret-myshots-check-secret-x",
  SCREENSHOT_STORAGE: "local", SCREENSHOT_LOCAL_DIR: join(RUN, "shots"),
  TIMELAPSE_DIR: join(RUN, "videos"),
  CORS_ORIGINS: "http://localhost:1420",
});
const req = createRequire(`${ROOT}/apps/api/package.json`);
req("reflect-metadata");
const { NestFactory } = req("@nestjs/core");
const dist = (p) => import(`${ROOT}/apps/api/dist/${p}`);
const { AppModule } = await dist("app.module.js");
const { configureApp } = await dist("app.setup.js");
const { DATABASE } = await dist("database/database.module.js");
const { hashPassword } = await dist("auth/crypto.js");
const NOTICE = "2026-10-screenshots-draft-1";
const { DEFAULT_NOTICE_VERSION: ACTIVITY_NOTICE } = await import(`${ROOT}/packages/shared/dist/index.js`);
const PASSWORD = "myshots check password 1";
const M = 60_000;
const APP = "http://localhost:1420";
const iso = (ms) => new Date(ms).toISOString();
const results = [];
const check = (name, ok, detail = "") => (results.push({ name, ok }), console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`));
const MASKS = [
  { x: 7500, y: 0, w: 2500, h: 500, label: "Menu bar clock" },
  { x: 0, y: 8000, w: 3050, h: 2000, label: "Chat corner" },
];
const RECTS = MASKS.map(({ x, y, w, h }) => ({ x, y, w, h }));

// ---- API -----------------------------------------------------------------------------------
let app = await NestFactory.create(AppModule, { logger: ["error", "warn"] });
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
const adminId = randomUUID();
await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [adminId, await hashPassword(PASSWORD)] });
const adminCookie = (await api("/auth/login", { method: "POST", body: { email: "admin@example.com", password: PASSWORD } })).res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const policy = (selfView, effectiveAt) =>
  db.execute({
    sql: `INSERT INTO screenshot_policies (screenshots_enabled, mask_regions, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
            retention_approved, notice_version, employee_self_view, reason, changed_by, effective_at) VALUES (1, ?, 60, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, ?, ?, 'my screenshots check', ?, ?)`,
    args: [JSON.stringify(MASKS), NOTICE, selfView ? 1 : 0, adminId, effectiveAt],
  });
await policy(true, iso(Date.now() - 2 * 86_400_000));
async function employee(n, name) {
  const email = `myshots${n}@example.com`;
  const r = await api("/employees", { method: "POST", cookie: adminCookie, body: { email, employeeCode: `MY-${n}`, fullName: name, timezone: "UTC" } });
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const bearer = (await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } })).body.accessToken;
  const e = { id: r.body.employee.id, email, bearer, device: randomUUID() };
  await api("/devices/register", { method: "POST", bearer, body: { installationId: e.device, deviceName: "Mac", platform: "macos" } });
  for (const v of [NOTICE, ACTIVITY_NOTICE]) await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), e.id, v, iso(Date.now() - 5 * 60 * M)] });
  await api("/attendance/sync", { method: "POST", bearer, device: e.device, body: { sentAt: iso(Date.now()), events: [{ id: randomUUID(), type: "CLOCK_IN", occurredAt: iso(Date.now() - 240 * M) }] } });
  e.userId = (await db.execute({ sql: "SELECT user_id FROM employee_profiles WHERE id = ?", args: [e.id] })).rows[0].user_id;
  return e;
}
const ana = await employee(1, "Ana Employee");
const ben = await employee(2, "Ben Other");
const cy = await employee(3, "Cy NoShots");

// ---- Chrome ----------------------------------------------------------------------------------
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--remote-debugging-port=9336", `--user-data-dir=${join(RUN, "chrome")}`, "--window-size=900,1000", "--no-first-run", "about:blank"], { stdio: "ignore" });
let target;
for (let i = 0; i < 150 && !target; i++) {
  await new Promise((r) => setTimeout(r, 200));
  target = await fetch("http://127.0.0.1:9336/json/new?about:blank", { method: "PUT" }).then((r) => r.json(), () => null);
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
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 150))) if (await js(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${label}`);
};
const shot = async (name) => writeFileSync(join(OUT, name), Buffer.from((await cdp("Page.captureScreenshot", { format: "png" })).data, "base64"));
await cdp("Page.enable");
const DOWNLOADS = join(RUN, "downloads");
mkdirSync(DOWNLOADS);
await cdp("Page.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOADS });
await cdp("Runtime.enable");

/** Synthetic bright "screen" with the masks blacked out the way the agent does it. */
const maskedWebp = async (n) => Buffer.from(await js(`(async () => {
  const W = 1920, H = 1080, S = 10000;
  const c = document.createElement("canvas"); c.width = W; c.height = H; const g = c.getContext("2d");
  g.fillStyle = "hsl(${(n * 67) % 360} 70% 75%)"; g.fillRect(0, 0, W, H);
  g.fillStyle = "#222"; g.font = "bold 60px sans-serif";
  for (let y = 80; y < H; y += 90) g.fillText("SYNTHETIC FRAME #${n}", 40, y);
  g.fillStyle = "#000";
  for (const m of ${JSON.stringify(RECTS)}) {
    const x0 = Math.floor(m.x * W / S), x1 = Math.ceil((m.x + m.w) * W / S), y0 = Math.floor(m.y * H / S), y1 = Math.ceil((m.y + m.h) * H / S);
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
  }
  const b = await new Promise((r) => c.toBlob(r, "image/webp", 0.8)); const u = new Uint8Array(await b.arrayBuffer());
  let s = ""; for (const x of u) s += String.fromCharCode(x); return btoa(s);
})()`), "base64");
async function upload(e, minutesAgo, n) {
  const bytes = await maskedWebp(n);
  const id = randomUUID();
  const reg = await api("/screenshots/register", { method: "POST", bearer: e.bearer, device: e.device, body: { id, capturedAt: iso(Date.now() - minutesAgo * M), sentAt: iso(Date.now()), width: 1920, height: 1080, sizeBytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), mimeType: "image/webp", masks: RECTS } });
  assert.equal(reg.body.status, "REGISTERED", JSON.stringify(reg.body));
  assert.equal((await api(`/screenshots/${id}/content`, { method: "PUT", bearer: e.bearer, device: e.device, raw: bytes })).status, 200);
  return (await db.execute({ sql: "SELECT id FROM screenshots WHERE idempotency_key = ?", args: [id] })).rows[0].id;
}

const vite = spawn("pnpm", ["exec", "vite", "--port", "1420", "--strictPort"], { cwd: `${ROOT}/apps/desktop`, stdio: "ignore", env: { ...process.env, VITE_API_URL: "http://localhost:4000" } });
for (let i = 0; i < 100; i++) {
  if (await fetch(APP).then((r) => r.ok, () => false)) break;
  await new Promise((r) => setTimeout(r, 200));
}
const cards = `[...document.querySelectorAll('#myshots-list > li')]`;
async function signIn(e) {
  await cdp("Page.navigate", { url: APP });
  await waitFor(`!document.querySelector('#login-view').hidden`, "login view");
  await js(`(() => {
    const f = document.querySelector('#login-form');
    f.email.value = ${JSON.stringify(e.email)}; f.password.value = ${JSON.stringify(PASSWORD)};
    f.requestSubmit();
  })()`);
  await waitFor(`!document.querySelector('#signed-in-view').hidden`, "signed in");
}
const openTab = async () => {
  await js(`document.querySelector('#tab-btn-screenshots').click()`);
  await waitFor(`document.querySelector('#myshots-status').textContent && document.querySelector('#myshots-status').textContent !== 'Loading…' || !document.querySelector('#myshots-error').hidden`, "tab loaded");
};
const activityUpload = (e, intervals) =>
  api("/activity/sync", { method: "POST", bearer: e.bearer, device: e.device, body: { sentAt: iso(Date.now()), platform: "macos", intervals: intervals.map(([app, from, to]) => ({ id: randomUUID(), kind: app ? "ACTIVE" : "IDLE", applicationIdentifier: app ? `com.example.${app.replace(/\W/g, "")}` : null, applicationName: app, startedAt: iso(Date.now() - from * M), endedAt: iso(Date.now() - to * M) })) } });
const historyLoaded = `document.querySelector('#activity-status').textContent !== 'Loading…' && document.querySelector('#days-body').children.length > 0`;
const openHistory = async () => {
  await js(`document.querySelector('#tab-btn-history').click()`);
  await waitFor(historyLoaded, "history loaded");
};
const exportStart = (from, to, format = "csv") =>
  js(`(() => { const f = document.querySelector('#export-form'); document.querySelector('#export').open = true;
    f.from.value = ${JSON.stringify(from)}; f.to.value = ${JSON.stringify(to)}; f.format.value = ${JSON.stringify(format)};
    f.dispatchEvent(new Event('input', { bubbles: true })); f.requestSubmit(); })()`);
const exportRun = async (from, to, format = "csv") => {
  await exportStart(from, to, format);
  await waitFor(`!document.querySelector('#export-submit').disabled && (document.querySelector('#export-status').textContent.startsWith('Downloaded') || document.querySelector('#export-status').textContent.startsWith('No shifts') || !document.querySelector('#export-error').hidden)`, "export finished");
  return js(`({ status: document.querySelector('#export-status').textContent, error: document.querySelector('#export-error').hidden ? '' : document.querySelector('#export-error').textContent })`);
};
const downloaded = async (name) => {
  // present and no longer growing (Chrome may still be writing it on a loaded machine)
  const size = () => (existsSync(join(DOWNLOADS, name)) ? statSync(join(DOWNLOADS, name)).size : -1);
  for (let i = 0, last = -2; i < 100 && !(size() > 0 && size() === last); i++, last = size()) await new Promise((r) => setTimeout(r, 100));
  return existsSync(join(DOWNLOADS, name)) ? readFileSync(join(DOWNLOADS, name)) : null;
};
const logCount = async () => Number((await db.execute("SELECT count(*) AS n FROM screenshot_access_log")).rows[0].n);

try {
  // 14 screenshots for Ana (two pages of 12), one of them deleted by retention; one for Ben.
  const anaIds = [];
  for (let i = 0; i < 14; i++) anaIds.push(await upload(ana, 200 - i * 5, i + 1));
  const benId = await upload(ben, 100, 99);
  await db.execute({ sql: "UPDATE screenshots SET upload_status = 'DELETED', deleted_at = ? WHERE id = ?", args: [iso(Date.now()), anaIds[13]] });
  check("seeded 15 synthetic masked screenshots (14 for Ana, 1 deleted; 1 for Ben)", true);

  // ---- F07: History tab -----------------------------------------------------------------------
  for (const r of [await activityUpload(ana, [["Code Editor", 60, 30], [null, 30, 20], ["Mail", 20, 10]]), await activityUpload(ben, [["Ben Secret App", 50, 40]])]) {
    assert.ok(r.body.results.every((x) => x.status === "ACCEPTED"), JSON.stringify(r.body));
  }
  await signIn(ana);
  await openHistory();
  const hist = await js(`document.querySelector('#tab-history').innerText`);
  check("history: this week's open shift listed with its clock-in, not counted as worked", /still open/.test(hist) && /Open shifts\s*1/.test(hist), hist.match(/Open shifts.*$/m)?.[0]);
  check("history: activity totals calculated from uploads (40 min active, 10 min idle)", /Active \(an application in front\)\s*0h 40m/.test(hist) && /Idle\s*0h 10m/.test(hist));
  check("history: per-application totals, own apps only", /Code Editor\s*0h 30m/.test(hist) && /Mail\s*0h 10m/.test(hist) && !hist.includes("Ben Secret App"));
  check("history: recorded facts vs calculated summaries are labelled", hist.includes("exactly as recorded") && hist.includes("Calculated from the application and idle intervals") && hist.includes("no productivity score"));
  check("history: 'No record' time explained, not counted as active or idle", /No record\s*\d+h \d{2}m/.test(hist) && hist.includes("It is not counted as active or idle"));
  check("history: activity table lists every day of the week", (await js(`document.querySelector('#activity-days').children.length`)) === 7);

  // ---- F03: draft timesheet CSV ----------------------------------------------------------------
  const [wkFrom, wkTo] = await js(`[document.querySelector('#export-form').from.value, document.querySelector('#export-form').to.value]`);
  check("export: range defaults to the week shown", /^\d{4}-\d{2}-\d{2}$/.test(wkFrom) && wkFrom <= wkTo, `${wkFrom}..${wkTo}`);
  check("export: labelled as a draft format, not approved for payroll", (await js(`document.querySelector('#export').textContent`)).includes("not yet approved for payroll or accounting"));
  const ex = await exportRun(wkFrom, wkTo);
  const fileName = `workfolio-timesheet-draft1_MY-1_${wkFrom}_${wkTo}.csv`;
  const file = await downloaded(fileName);
  check("export: downloaded with a meaningful file name; status says so", !!file && ex.status.startsWith(`Downloaded ${fileName} (1 shift(s)) to your Downloads folder`), ex.status || ex.error);
  const csvText = file ? file.toString("utf8") : "";
  const csvRows = csvText.replace(/^\uFEFF/, "").split("\r\n").filter(Boolean).map((l) => l.split(","));
  check("export: BOM, draft header, one open shift with no clock-out or worked minutes", csvText.startsWith("\uFEFFEmployee code,Employee name,Work date,Time zone,Clock in,Clock out,Status") && csvRows.length === 2 && csvRows[1][5] === "" && csvRows[1][6] === "Open: no clock-out recorded" && csvRows[1][10] === "", csvRows[1]?.slice(0, 11).join("|"));
  check("export: recorded activity of the open shift (40 active, 10 idle), no-record left empty", csvRows[1]?.[11] === "40" && csvRows[1]?.[12] === "10" && csvRows[1]?.[13] === "", csvRows[1]?.slice(11).join("|"));
  // Excel: the same rows in a real workbook (read back with Python openpyxl when installed).
  const xs = await exportRun(wkFrom, wkTo, "xlsx");
  const xlsxName = `workfolio-timesheet-draft1_MY-1_${wkFrom}_${wkTo}.xlsx`;
  const xlsxFile = await downloaded(xlsxName);
  check("export (xlsx): button names the type; downloaded .xlsx is a ZIP workbook; status says so", (await js(`document.querySelector('#export-submit').textContent`)) === "Download Excel file" && xlsxFile?.subarray(0, 2).toString() === "PK" && xs.status.startsWith(`Downloaded ${xlsxName} (1 shift(s))`), xs.status || xs.error);
  if (spawnSync("python3", ["-I", "-c", "import openpyxl"]).status === 0 && xlsxFile) {
    const read = JSON.parse(execFileSync("python3", ["-I", "-c", "import json,sys,datetime,openpyxl\nwb=openpyxl.load_workbook(sys.argv[1])\nv=lambda x: x.date().isoformat() if isinstance(x, datetime.datetime) else x\nprint(json.dumps({'sheets': wb.sheetnames, 'rows': [[v(c.value) for c in r] for r in wb['Timesheet'].iter_rows()], 'freeze': wb['Timesheet'].freeze_panes, 'filter': wb['Timesheet'].auto_filter.ref}))", join(DOWNLOADS, xlsxName)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    // RFC 4180 fields (quoted commas), apostrophe-neutralised text restored, for comparison.
    const fields = (line) => [...line.matchAll(/(?:^|,)("(?:[^"]|"")*"|[^,]*)/g)].map((m) => m[1].replace(/^"(.*)"$/s, "$1").replaceAll('""', '"').replace(/^'/, ""));
    const csvCells = csvText.replace(/^\uFEFF/, "").split("\r\n").filter(Boolean).map(fields);
    const same = JSON.stringify(read.rows.map((r) => r.map((v) => (v === null ? "" : String(v))))) === JSON.stringify(csvCells);
    check("export (xlsx): Timesheet + Summary sheets, frozen and filtered header, same values as the CSV", JSON.stringify(read.sheets) === '["Timesheet","Summary"]' && read.freeze === "A2" && read.filter === "A1:P2" && same, JSON.stringify(read.rows[1]));
  } else check("export (xlsx): workbook contents (needs python3 openpyxl)", false, "openpyxl not available: not verified");
  // Cancel while the server is slow: nothing is downloaded.
  await cdp("Network.enable");
  await cdp("Network.emulateNetworkConditions", { offline: false, latency: 2500, downloadThroughput: -1, uploadThroughput: -1 });
  await exportStart("2026-09-01", "2026-09-07", "xlsx");
  await waitFor(`document.querySelector('#export-status').textContent === 'Preparing…' && !document.querySelector('#export-cancel').hidden`, "preparing with cancel");
  await js(`document.querySelector('#export-cancel').click()`);
  await waitFor(`document.querySelector('#export-status').textContent.startsWith('Cancelled')`, "cancelled");
  await new Promise((r) => setTimeout(r, 3500));
  await cdp("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  check("export: cancel while preparing → 'Cancelled. Nothing was downloaded.', no file, buttons reset", (await js(`document.querySelector('#export-status').textContent`)) === "Cancelled. Nothing was downloaded." && !readdirSync(DOWNLOADS).some((f) => f.includes("2026-09-01_2026-09-07")) && (await js(`document.querySelector('#export-cancel').hidden && !document.querySelector('#export-submit').disabled`)));
  await js(`(() => { const f = document.querySelector('#export-form'); f.format.value = 'csv'; f.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  check("export: own data only (no other employee, ids or app names)", !csvText.includes("Ben") && !csvText.includes(ana.id) && !csvText.includes(ben.id) && !csvText.includes("Code Editor"));
  check("export: page never holds an export URL or file path", !(await js("document.documentElement.outerHTML")).includes("/attendance/export"));
  const bad = await exportRun(wkTo === wkFrom ? "2026-12-31" : wkTo, wkFrom);
  check("export: reversed range refused before any request", /after/.test(bad.error), bad.error);
  const big = await exportRun("2026-01-01", "2026-04-03");
  check("export: more than 92 days refused", /92 days/.test(big.error), big.error);
  const none = await exportRun("2025-01-06", "2025-01-12");
  check("export: empty range says no shifts (headers-only file)", none.status.startsWith("No shifts between") && !!(await downloaded("workfolio-timesheet-draft1_MY-1_2025-01-06_2025-01-12.csv")), none.status);
  await js(`(() => { const f = document.querySelector('#export-form'); f.from.value = ${JSON.stringify(wkFrom)}; f.to.value = ${JSON.stringify(wkTo)}; f.from.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  check("export: changing the dates clears the previous result", (await js(`document.querySelector('#export-status').textContent`)) === "" && (await js(`document.querySelector('#export-error').hidden`)));
  await js(`document.querySelector('#week-prev').click()`);
  await waitFor(`document.querySelector('#activity-status').textContent === 'No activity recorded this week.' && document.querySelector('#shift-list').innerText.includes('No shifts this week.')`, "previous week");
  check("history: previous week is empty (date navigation, empty state)", (await js(`document.querySelector('#week-next').disabled`)) === false);
  await js(`document.querySelector('#week-next').click()`);
  await waitFor(`document.querySelector('#week-next').disabled && /Code Editor/.test(document.querySelector('#activity-apps').innerText)`, "back to this week");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await new Promise((r) => setTimeout(r, 400));
  check("history: narrow window (390 px), no horizontal scroll", (await js("document.scrollingElement.scrollWidth")) <= 390, String(await js("document.scrollingElement.scrollWidth")));
  await shot("history-narrow.png");
  await cdp("Emulation.clearDeviceMetricsOverride");
  await js(`document.querySelector('#activity-heading').scrollIntoView()`);
  await shot("history-activity.png");
  await js(`window.scrollTo(0, 0)`);
  check("history: never asks the API for another employee", !(await js("document.documentElement.outerHTML")).includes(ben.id));

  check("tab 'My screenshots' is in the employee app's tab list", await js(`document.querySelector('#tab-btn-screenshots')?.getAttribute('role') === 'tab'`));
  const before = await logCount();
  await openTab();
  await waitFor(`${cards}.length === 12 && ${cards}.filter((li) => li.querySelector('img')).length === 11`, "first page thumbnails");
  const text = await js(`document.querySelector('#tab-screenshots').innerText`);
  check("explains masks, no automatic detection, admin access and logging", /privacy masks/.test(text) && /Nothing else is detected or hidden automatically/.test(text) && /Administrators can see/.test(text) && /logged with your account/.test(text));
  check("page 1 of 2, 14 screenshots, newest first", text.includes("14 screenshot(s) in the last 30 days") && text.includes("Page 1 of 2"));
  check("deleted screenshot shown as deleted, not opened", (await js(`${cards}[0].innerText`)).includes("Deleted under the retention policy") && !(await js(`!!${cards}[0].querySelector('button')`)));
  check("each card shows the capture time and mask count", await js(`${cards}.every((li) => /\\d{2}:\\d{2}:\\d{2}/.test(li.innerText) && li.innerText.includes('2 areas were blacked out before saving'))`));
  check("thumbnails are in-memory blob: URLs only", await js(`[...document.querySelectorAll('#myshots-list img')].every((i) => i.src.startsWith('blob:'))`));
  const html = await js("document.documentElement.outerHTML");
  check("no storage paths, keys, API image URLs or other employees in the page", !html.includes(join(RUN, "shots")) && !html.includes("/content") && !html.includes(ben.id) && !html.includes(benId) && !text.includes("Ben"));
  check("11 thumbnail views logged for Ana's account (deleted one not fetched)", (await logCount()) - before === 11, `${(await logCount()) - before}`);

  await js(`document.querySelector('#myshots-next').click()`);
  await waitFor(`document.querySelector('#myshots-page').textContent === 'Page 2 of 2' && ${cards}.length === 2`, "page 2");
  check("pagination: page 2 holds the 2 oldest", true);
  await js(`document.querySelector('#myshots-prev').click()`);
  await waitFor(`document.querySelector('#myshots-page').textContent === 'Page 1 of 2' && ${cards}.filter((li) => li.querySelector('img')).length === 11`, "page 1 again");

  // Viewer: open with the keyboard, labels, pixels, Escape returns focus.
  const viewsBefore = Number((await db.execute({ sql: "SELECT count(*) AS n FROM screenshot_access_log WHERE action = 'VIEW' AND user_id = ?", args: [ana.userId] })).rows[0].n);
  await js(`(() => { const b = ${cards}[1].querySelector('button'); b.focus(); b.click(); })()`);
  await waitFor(`document.querySelector('#myshots-viewer').open && document.querySelector('#myshots-image').complete && document.querySelector('#myshots-image').naturalWidth === 1920 && document.querySelector('#myshots-masks').textContent.includes(':')`, "viewer");
  check("viewer lists the mask labels from the policy at capture time", (await js(`document.querySelector('#myshots-masks').textContent`)) === "2 areas were blacked out before saving: Menu bar clock, Chat corner.");
  const px = await js(`(() => {
    const img = document.querySelector('#myshots-image'); const c = document.createElement('canvas'); c.width = 1920; c.height = 1080;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const max = (x, y, w, h) => { const d = g.getImageData(x, y, w, h).data; let m = 0; for (let i = 0; i < d.length; i += 4) m = Math.max(m, d[i], d[i + 1], d[i + 2]); return m; };
    const mean = (x, y, w, h) => { const d = g.getImageData(x, y, w, h).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += (d[i] + d[i + 1] + d[i + 2]) / 3; return s / (d.length / 4); };
    return { clock: max(1448, 4, 468, 46), chat: max(4, 868, 577, 208), open: Math.round(mean(700, 300, 500, 400)) };
  })()`);
  check("viewer image: both masked areas black, the rest visible", px.clock <= 16 && px.chat <= 16 && px.open > 120, JSON.stringify(px));
  check("viewer has an accessible name and image description", (await js(`document.querySelector('#myshots-viewer-title').textContent`)).startsWith("Screenshot taken") && (await js(`document.querySelector('#myshots-image').alt`)).startsWith("Your main screen at"));
  const viewsAfter = Number((await db.execute({ sql: "SELECT count(*) AS n FROM screenshot_access_log WHERE action = 'VIEW' AND user_id = ?", args: [ana.userId] })).rows[0].n);
  check("opening logged one VIEW with Ana's account", viewsAfter - viewsBefore === 1);
  await shot("myshots-viewer.png");
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await waitFor(`!document.querySelector('#myshots-viewer').open`, "viewer closed");
  check("Escape closes the viewer and focus returns to the screenshot", await js(`document.activeElement === ${cards}[1].querySelector('button')`));

  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await new Promise((r) => setTimeout(r, 400));
  check("narrow window (390 px): no horizontal scroll", (await js("document.scrollingElement.scrollWidth")) <= 390, String(await js("document.scrollingElement.scrollWidth")));
  await shot("myshots-narrow.png");
  await cdp("Emulation.clearDeviceMetricsOverride");
  await shot("myshots-list.png");

  await js(`document.querySelector('#tab-btn-today').click()`);
  check("leaving the tab releases the images", await js(`document.querySelectorAll('#myshots-list img').length === 0`));

  // Self-view off: the server refuses; the tab says why and shows nothing.
  await policy(false, iso(Date.now()));
  await openTab();
  const off = await js(`document.querySelector('#myshots-error').hidden ? '' : document.querySelector('#myshots-error').textContent`);
  check("self-view off: refused by the server, reason shown, nothing listed", off.includes("does not allow employees to view screenshots") && (await js(`${cards}.length`)) === 0, off);
  await policy(true, iso(Date.now() + 1));

  // Another employee sees only their own; one without screenshots sees the empty state.
  await signIn(ben);
  await openTab();
  await waitFor(`${cards}.length === 1 && !!${cards}[0].querySelector('img')`, "Ben's one screenshot");
  check("another employee sees only their own screenshot", !(await js("document.documentElement.outerHTML")).includes(anaIds[0]));
  await signIn(cy);
  await openHistory();
  check("history: no activity for an employee without uploads", (await js(`document.querySelector('#activity-status').textContent`)) === "No activity recorded this week." && (await js(`document.querySelector('#activity-apps').innerText`)).includes("No applications recorded"));
  await js(`document.querySelector('#activity-screenshots').click()`);
  await waitFor(`document.querySelector('#myshots-status').textContent && document.querySelector('#myshots-status').textContent !== 'Loading…'`, "link to screenshots");
  check("history links to My screenshots (tab selected, panel shown)", (await js(`document.querySelector('#tab-btn-screenshots').getAttribute('aria-selected') === 'true' && !document.querySelector('#tab-screenshots').hidden && document.querySelector('#tab-history').hidden`)));
  check("empty state for an employee without screenshots", (await js(`document.querySelector('#myshots-status').textContent`)) === "No screenshots in the last 30 days.");

  // API unreachable: a clear error instead of a broken list.
  await app.close();
  await js(`document.querySelector('#tab-btn-today').click()`);
  await openTab();
  const down = await js(`document.querySelector('#myshots-error').textContent`);
  check("network error shown when the server is unreachable", /Connect to the server/.test(down), down);
  await js(`document.querySelector('#tab-btn-history').click()`);
  await waitFor(`!document.querySelector('#activity-error').hidden && !document.querySelector('#history-error').hidden`, "history offline");
  const offEx = await exportRun("2026-10-01", "2026-10-07");
  check("export: server unreachable shows an error, nothing downloaded", /Connect to the server/.test(offEx.error) && !readdirSync(DOWNLOADS).some((f) => f.includes("2026-10-01_2026-10-07")), offEx.error);
  check("history: server unreachable shows an error, no stale totals", /Connect to the server/.test(await js(`document.querySelector('#activity-error').textContent`)) && (await js(`document.querySelector('#activity-totals').children.length`)) === 0);
} catch (err) {
  check(`run aborted: ${err.message}`, false);
  await shot("myshots-failure.png").catch(() => {});
} finally {
  ws.close();
  chrome.kill();
  vite.kill();
  await app.close().catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  rmSync(RUN, { recursive: true, force: true });
}
console.log(`Page captures: ${OUT}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
