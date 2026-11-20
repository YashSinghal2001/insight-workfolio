// Privacy-mask runtime check (F02): a throwaway API (temporary file DB, local storage, real FFmpeg) on
// :4000, the dashboard production build on :3102, headless Chrome over CDP. It checks the settings
// editor (save, server-side refusal of a bad mask, history, 390 px), the gallery mask count and the
// displayed pixels, and a real H.264 timelapse of masked frames. Frames are synthetic canvases encoded
// to WebP by Chrome, with the masks blacked out the way the desktop agent does it (floor start, ceil
// end); the agent's own masking is tested in Rust (screenshot.rs), never on a real screen here.
// Run after `pnpm build`; needs Google Chrome (macOS path) and FFmpeg with libx264 on PATH.
// Usage: pnpm --filter @workfolio/dashboard verify:masks [out-dir]
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = process.argv[2] ?? mkdtempSync(join(tmpdir(), "wf-verify-masks-"));
const RUN = join(OUT, "run");
rmSync(RUN, { recursive: true, force: true });
for (const d of ["shots", "videos"]) mkdirSync(join(RUN, d), { recursive: true });
Object.assign(process.env, {
  NODE_ENV: "development", LOG_LEVEL: "warn", PORT: "4000",
  DATABASE_URL: `file:${join(RUN, "masks.db")}`,
  JWT_SECRET: "masks-check-secret-masks-check-secret-masks",
  SCREENSHOT_STORAGE: "local", SCREENSHOT_LOCAL_DIR: join(RUN, "shots"),
  TIMELAPSE_DIR: join(RUN, "videos"),
  CORS_ORIGINS: "http://localhost:3102",
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
const PASSWORD = "masks check password 1";
const M = 60_000;
const DASH = "http://localhost:3102";
const iso = (ms) => new Date(ms).toISOString();
const results = [];
const check = (name, ok, detail = "") => (results.push({ name, ok }), console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`));

// The masks entered in the browser, and what they must be stored as (1/10 000 of the frame).
const UI_MASKS = [
  { label: "Menu bar clock", x: "75", y: "0", w: "25", h: "5" },
  { label: "Chat corner", x: "0", y: "80", w: "30.5", h: "20" },
];
const STORED = [
  { x: 7500, y: 0, w: 2500, h: 500, label: "Menu bar clock" },
  { x: 0, y: 8000, w: 3050, h: 2000, label: "Chat corner" },
];
const RECTS = STORED.map(({ x, y, w, h }) => ({ x, y, w, h }));

// ---- API -----------------------------------------------------------------------------------
const app = await NestFactory.create(AppModule, { logger: ["error", "warn"] });
configureApp(app);
await app.listen(4000);
const db = app.get(DATABASE);
const api = async (path, { method = "GET", body, raw, cookie, bearer, device } = {}) => {
  const headers = { origin: DASH };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (raw) headers["content-type"] = "image/webp";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (device) headers["x-device-id"] = device;
  const res = await fetch(`http://localhost:4000/api/v1${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const buf = Buffer.from(await res.arrayBuffer());
  const json = (res.headers.get("content-type") ?? "").includes("json") && buf.length ? JSON.parse(buf.toString()) : undefined;
  return { status: res.status, body: json, buf, res };
};
const adminId = randomUUID();
await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [adminId, await hashPassword(PASSWORD)] });
const adminCookie = (await api("/auth/login", { method: "POST", body: { email: "admin@example.com", password: PASSWORD } })).res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
await db.execute({
  sql: `INSERT INTO screenshot_policies (screenshots_enabled, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
          retention_approved, notice_version, reason, changed_by, effective_at) VALUES (1, 60, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, ?, 'masks check: start', ?, ?)`,
  args: [NOTICE, adminId, iso(Date.now() - 2 * 86_400_000)],
});
const r0 = await api("/employees", { method: "POST", cookie: adminCookie, body: { email: "masks1@example.com", employeeCode: "MSK-1", fullName: "Mia Masked", timezone: "UTC" } });
await api("/auth/setup-password", { method: "POST", body: { token: r0.body.setup.token, password: PASSWORD } });
const mia = { id: r0.body.employee.id, bearer: (await api("/auth/login", { method: "POST", body: { email: "masks1@example.com", password: PASSWORD, client: "desktop" } })).body.accessToken, device: randomUUID() };
await api("/devices/register", { method: "POST", bearer: mia.bearer, body: { installationId: mia.device, deviceName: "Mac", platform: "macos" } });
await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), mia.id, NOTICE, iso(Date.now() - 4 * 60 * M)] });
await api("/attendance/sync", { method: "POST", bearer: mia.bearer, device: mia.device, body: { sentAt: iso(Date.now()), events: [{ id: randomUUID(), type: "CLOCK_IN", occurredAt: iso(Date.now() - 180 * M) }] } });

// ---- Chrome ----------------------------------------------------------------------------------
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--remote-debugging-port=9335", `--user-data-dir=${join(RUN, "chrome")}`, "--window-size=1440,1000", "--no-first-run", "about:blank"], { stdio: "ignore" });
let target;
for (let i = 0; i < 150 && !target; i++) {
  await new Promise((r) => setTimeout(r, 200));
  target = await fetch("http://127.0.0.1:9335/json/new?about:blank", { method: "PUT" }).then((r) => r.json(), () => null);
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
const shot = async (name) => writeFileSync(join(OUT, name), Buffer.from((await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true })).data, "base64"));
await cdp("Page.enable");
await cdp("Runtime.enable");

/** A synthetic bright "screen" with text, masks blacked out like the agent does, as WebP. */
const maskedWebp = async (n, rects) => Buffer.from(await js(`(async () => {
  const W = 1920, H = 1080, S = 10000;
  const c = document.createElement("canvas"); c.width = W; c.height = H; const g = c.getContext("2d");
  g.fillStyle = "hsl(${(n * 67) % 360} 70% 75%)"; g.fillRect(0, 0, W, H);
  g.fillStyle = "#222"; g.font = "bold 60px sans-serif";
  for (let y = 80; y < H; y += 90) g.fillText("SYNTHETIC SECRET #${n} 1234-5678", 40, y);
  g.fillStyle = "#000";
  for (const m of ${JSON.stringify(rects)}) {
    const x0 = Math.floor(m.x * W / S), x1 = Math.ceil((m.x + m.w) * W / S), y0 = Math.floor(m.y * H / S), y1 = Math.ceil((m.y + m.h) * H / S);
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
  }
  const b = await new Promise((r) => c.toBlob(r, "image/webp", 0.8)); const u = new Uint8Array(await b.arrayBuffer());
  let s = ""; for (const x of u) s += String.fromCharCode(x); return btoa(s);
})()`), "base64");
async function register(at, bytes, masks) {
  const id = randomUUID();
  const body = { id, capturedAt: iso(at), sentAt: iso(Date.now()), width: 1920, height: 1080, sizeBytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), mimeType: "image/webp", ...(masks ? { masks } : {}) };
  const reg = await api("/screenshots/register", { method: "POST", bearer: mia.bearer, device: mia.device, body });
  if (reg.body?.status === "REGISTERED") assert.equal((await api(`/screenshots/${id}/content`, { method: "PUT", bearer: mia.bearer, device: mia.device, raw: bytes })).status, 200);
  return reg.body;
}

const dash = spawn("pnpm", ["exec", "next", "start", "--port", "3102"], { cwd: `${ROOT}/apps/dashboard`, stdio: "ignore" });
for (let i = 0; i < 100; i++) {
  if (await fetch(`${DASH}/login`).then((r) => r.ok, () => false)) break;
  await new Promise((r) => setTimeout(r, 200));
}
const form = `[...document.querySelectorAll('form')].find((f) => f.innerText.includes('Save screenshot settings'))`;
const setValue = (sel, value) => `(() => { const el = ${sel}; const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); })()`;
const maskInput = (i, field) => `${form}.querySelectorAll('ol > li')[${i}].querySelectorAll('input')[${field}]`;
const settingsNow = async () => (await api("/settings/screenshots", { cookie: adminCookie })).body;

try {
  await cdp("Page.navigate", { url: `${DASH}/login` });
  await waitFor(`(() => { const f = document.querySelector('form'); return !!f && Object.keys(f).some((k) => k.startsWith('__reactProps')); })()`, "hydrated login form");
  await js(`(() => {
    const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
    set(document.querySelector('input[type=email], input[name=email]'), "admin@example.com");
    set(document.querySelector('input[type=password]'), ${JSON.stringify(PASSWORD)});
    document.querySelector('form').requestSubmit();
  })()`);
  await waitFor(`location.pathname !== "/login"`, "sign-in");

  // ---- Settings editor ----
  await cdp("Page.navigate", { url: `${DASH}/settings` });
  await waitFor(`!!${form}`, "screenshot settings form");
  check("editor: 'Privacy masks' group with an explanation and 'No masks' state", await js(`${form}.querySelector('fieldset legend')?.textContent === 'Privacy masks' && ${form}.innerText.includes('No masks: the whole main screen is captured') && ${form}.innerText.includes('before')`));
  const add = `[...${form}.querySelectorAll('button')].find((b) => b.textContent === 'Add mask')`;
  for (const [i, m] of UI_MASKS.entries()) {
    await js(`${add}.click()`);
    await waitFor(`${form}.querySelectorAll('ol > li').length === ${i + 1}`, `mask row ${i + 1}`);
    for (const [f, v] of [m.label, m.x, m.y, m.w, m.h].entries()) await js(setValue(maskInput(i, f), v));
  }
  check("every mask input has a visible label", await js(`[...${form}.querySelectorAll('ol input')].every((el) => el.closest('label')?.innerText.trim().length > 0)`));
  await js(`${form}.querySelector('input[name=enabled]').checked || ${form}.querySelector('input[name=enabled]').click()`);
  await js(setValue(`${form}.querySelector('textarea[name=reason]')`, "Hide the clock and the chat corner (verification)"));
  await js(`${form}.requestSubmit()`);
  await waitFor(`document.body.innerText.includes('Saved. Desktops pick up the change')`, "saved");
  const saved = await settingsNow();
  check("saved masks reach the API in 1/10 000 units with labels", (() => { try { assert.deepStrictEqual(saved.effective.maskRegions, STORED); return true; } catch { return false; } })(), JSON.stringify(saved.effective.maskRegions));
  check("history records who and why", saved.effective.changedBy.email === "admin@example.com" && saved.effective.reason.startsWith("Hide the clock"));
  await waitFor(`${form}?.querySelectorAll('ol > li').length === 2`, "form reloaded with the saved masks");
  check("the form reloads with the saved masks", (await js(`${maskInput(1, 3)}.value`)) === "30.5");
  await js(`${form}.parentElement.querySelector('details')?.setAttribute('open', '')`);
  check("history in the page lists the mask labels", (await js("document.body.innerText")).includes("masks: Menu bar clock, Chat corner"));
  await shot("masks-settings.png");

  // A mask past the right edge passes the browser's per-field limits but is refused by the API.
  const versions = saved.history.length;
  await js(setValue(maskInput(0, 1), "90"));
  await js(setValue(`${form}.querySelector('textarea[name=reason]')`, "bad mask"));
  await js(`${form}.requestSubmit()`);
  await waitFor(`[...document.querySelectorAll('[role=alert]')].some((a) => /inside the screen|maskRegions/i.test(a.innerText))`, "server refusal");
  check("a mask outside the screen is refused with the reason and nothing is stored", (await settingsNow()).history.length === versions, (await js(`[...document.querySelectorAll('[role=alert]')].map((a) => a.innerText).join(' | ')`)).slice(0, 160));

  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await new Promise((r) => setTimeout(r, 400));
  // Compared with 390 itself: with mobile emulation an overflowing page widens innerWidth too.
  const wide = await js(`[...document.querySelectorAll('body *')].filter((el) => { if (el.getBoundingClientRect().right <= 391) return false; for (let p = el.parentElement; p; p = p.parentElement) if (/auto|scroll|hidden|clip/.test(getComputedStyle(p).overflowX)) return false; return true; }).slice(-4).map((el) => el.tagName + '.' + (el.className?.toString?.() ?? '').slice(0, 50) + ' ' + Math.round(el.getBoundingClientRect().right))`);
  check("mobile (390 px): settings page has no horizontal scroll", (await js("document.scrollingElement.scrollWidth")) <= 390, `${await js("document.scrollingElement.scrollWidth")} px; ${wide.join(" | ")}`);
  await js(`${form}.querySelector('fieldset').scrollIntoView()`);
  await shot("masks-settings-mobile.png");
  await cdp("Emulation.clearDeviceMetricsOverride");

  // ---- Screenshots under the masks ----
  // The saved version starts now; two frames one interval apart need a version that started earlier,
  // so the same masks are also recorded as in force from an hour ago (test setup, directly in the DB).
  await db.execute({
    sql: `INSERT INTO screenshot_policies (screenshots_enabled, mask_regions, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
            retention_approved, notice_version, reason, changed_by, effective_at) VALUES (1, ?, 60, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, ?, 'masks check: backdated copy', ?, ?)`,
    args: [JSON.stringify(STORED), NOTICE, adminId, iso(Date.now() - 60 * M)],
  });
  const unmasked = await register(Date.now() - 45 * M, await maskedWebp(0, []), undefined);
  check("an upload without the masks in force is rejected (older or modified agent)", unmasked.status === "REJECTED", unmasked.reason);
  const frames = [];
  for (const [i, at] of [Date.now() - 40 * M, Date.now() - 30 * M].entries()) {
    const bytes = await maskedWebp(i + 1, RECTS);
    frames.push(bytes);
    assert.equal((await register(at, bytes, RECTS)).status, "REGISTERED");
  }
  check("masked screenshots registered and stored", true);

  await cdp("Page.navigate", { url: `${DASH}/screenshots` });
  await waitFor(`document.querySelector('select')?.options.length === 2`, "employee options");
  await js(`(() => { const s = document.querySelector('select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, ${JSON.stringify(mia.id)}); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  const cards = `[...document.querySelectorAll('section[aria-label="Screenshot gallery"] li')]`;
  await waitFor(`${cards}.length === 2 && ${cards}.every((li) => li.querySelector('img')?.complete && li.querySelector('img').naturalWidth > 0)`, "gallery thumbnails");
  check("gallery cards show '2 masked area(s)'", await js(`${cards}.every((li) => li.innerText.includes('2 masked area(s)'))`));
  // The explanation sits in the page's "About this page" disclosure (closed by default): open it first.
  await js("document.querySelectorAll('main details').forEach((d) => (d.open = true))");
  check("gallery explains that only configured masks are blacked out", (await js("document.body.innerText")).includes("Only the privacy masks set in Settings are blacked out"));
  await js(`${cards}[0].querySelector('button').click()`);
  await waitFor(`document.querySelector('dialog[open] img')?.complete && document.querySelector('dialog[open] img').naturalWidth === 1920`, "viewer image");
  // Pixels of the image as displayed (decoded by Chrome from the blob the API sent).
  const px = await js(`(() => {
    const img = document.querySelector('dialog[open] img'); const c = document.createElement('canvas'); c.width = 1920; c.height = 1080;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0); const max = (x, y, w, h) => { const d = g.getImageData(x, y, w, h).data; let m = 0; for (let i = 0; i < d.length; i += 4) m = Math.max(m, d[i], d[i + 1], d[i + 2]); return m; };
    const mean = (x, y, w, h) => { const d = g.getImageData(x, y, w, h).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += (d[i] + d[i + 1] + d[i + 2]) / 3; return s / (d.length / 4); };
    return { clock: max(1448, 4, 468, 46), chat: max(4, 868, 577, 208), open: mean(700, 300, 500, 400) };
  })()`);
  check("viewer: both masked areas are black, the rest shows the screen", px.clock <= 16 && px.chat <= 16 && px.open > 120, JSON.stringify(px));
  await shot("masks-viewer.png");

  // ---- Real timelapse of the masked frames ----
  const session = (await db.execute({ sql: "SELECT id FROM attendance_sessions WHERE employee_id = ?", args: [mia.id] })).rows[0].id;
  const job = await api("/timelapses", { method: "POST", cookie: adminCookie, body: { sessionId: session, fps: 2 } });
  let status = job.body;
  for (let i = 0; i < 300 && ["QUEUED", "RUNNING"].includes(status?.status); i++) {
    await new Promise((r) => setTimeout(r, 100));
    status = (await api(`/timelapses/${job.body.id}`, { cookie: adminCookie })).body;
  }
  const video = await api(`/timelapses/${job.body.id}/content?download=true`, { cookie: adminCookie });
  const mp4 = join(RUN, "masked.mp4");
  writeFileSync(mp4, video.buf);
  // First frame as 8-bit gray, 1280x720 (1920x1080 scales by exactly 2/3, no letterbox).
  const gray = execFileSync("ffmpeg", ["-v", "error", "-i", mp4, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 8 << 20 });
  const region = (x0, y0, x1, y1, f) => { let acc = f === "max" ? 0 : 0, n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const v = gray[y * 1280 + x]; acc = f === "max" ? Math.max(acc, v) : acc + v; n++; } return f === "max" ? acc : acc / n; };
  const v = { clock: region(976, 4, 1276, 32, "max"), chat: region(4, 584, 384, 716, "max"), open: Math.round(region(470, 200, 800, 470, "mean")) };
  check(`real H.264 timelapse (${status.framesDone} frames): masked areas black, rest visible`, status.status === "READY" && gray.length === 1280 * 720 && v.clock <= 24 && v.chat <= 24 && v.open > 100, JSON.stringify(v));
} catch (err) {
  check(`run aborted: ${err.message}`, false);
  await shot("masks-failure.png").catch(() => {});
} finally {
  ws.close();
  chrome.kill();
  dash.kill();
  await app.close().catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  rmSync(RUN, { recursive: true, force: true });
}
console.log(`Page captures: ${OUT}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
