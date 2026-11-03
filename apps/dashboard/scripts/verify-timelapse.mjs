// Timelapse runtime check: a throwaway API (temporary file DB, local storage, real FFmpeg) on :4000,
// the dashboard production build on :3101, headless Chrome over CDP. Frames are real WebPs encoded
// by Chrome from synthetic canvases (never a real screen), uploaded through register/upload.
// Run after `pnpm build`; needs Google Chrome (macOS path) and FFmpeg with libx264 on PATH.
// Usage: pnpm --filter @workfolio/dashboard verify:timelapse [out-dir]
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

const ROOT = resolve(import.meta.dirname, "../../..");
/** Page captures (PNG) land here; the database, files, videos and Chrome profile are deleted at the end. */
const OUT = process.argv[2] ?? mkdtempSync(join(tmpdir(), "wf-verify-timelapse-"));
const RUN = join(OUT, "run");
rmSync(RUN, { recursive: true, force: true });
for (const d of ["shots", "videos", "downloads"]) mkdirSync(join(RUN, d), { recursive: true });
Object.assign(process.env, {
  NODE_ENV: "development", LOG_LEVEL: "warn", PORT: "4000",
  DATABASE_URL: `file:${join(RUN, "timelapse.db")}`,
  JWT_SECRET: "timelapse-check-secret-timelapse-check-secret",
  SCREENSHOT_STORAGE: "local", SCREENSHOT_LOCAL_DIR: join(RUN, "shots"),
  TIMELAPSE_DIR: join(RUN, "videos"),
  CORS_ORIGINS: "http://localhost:3101",
});
const dist = (p) => import(`${ROOT}/apps/api/dist/${p}`);
const req = createRequire(`${ROOT}/apps/api/package.json`);
req("reflect-metadata");
const { NestFactory } = req("@nestjs/core");
const { AppModule } = await dist("app.module.js");
const { configureApp } = await dist("app.setup.js");
const { DATABASE } = await dist("database/database.module.js");
const { hashPassword } = await dist("auth/crypto.js");
const { TimelapseService } = await dist("screenshots/timelapse.service.js");
const { TIMELAPSE_LIMITS } = await import(`${ROOT}/packages/shared/dist/index.js`);
const NOTICE = "2026-10-screenshots-draft-1";
const PASSWORD = "timelapse check password 1";
const M = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const results = [];
const check = (name, ok, detail = "") => (results.push({ name, ok }), console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`));

// ---- API -----------------------------------------------------------------------------------
const app = await NestFactory.create(AppModule, { logger: ["error", "warn"] });
configureApp(app);
await app.listen(4000);
const db = app.get(DATABASE);
const service = app.get(TimelapseService);
const api = async (path, { method = "GET", body, raw, cookie, bearer, device } = {}) => {
  const headers = { origin: "http://localhost:3101" };
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
await db.execute({
  sql: `INSERT INTO screenshot_policies (screenshots_enabled, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
          retention_approved, notice_version, reason, changed_by, effective_at) VALUES (1, 60, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, ?, 'timelapse check', ?, ?)`,
  args: [NOTICE, adminId, iso(Date.now() - 2 * 86_400_000)],
});
async function employee(n, name, clockedInMinutesAgo = 180) {
  const email = `timelapse${n}@example.com`;
  const r = await api("/employees", { method: "POST", cookie: adminCookie, body: { email, employeeCode: `TLV-${n}`, fullName: name, timezone: "UTC" } });
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const bearer = (await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } })).body.accessToken;
  const e = { id: r.body.employee.id, bearer, device: randomUUID() };
  await api("/devices/register", { method: "POST", bearer, body: { installationId: e.device, deviceName: "Mac", platform: "macos" } });
  await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), e.id, NOTICE, iso(Date.now() - (clockedInMinutesAgo + 60) * M)] });
  await api("/attendance/sync", { method: "POST", bearer, device: e.device, body: { sentAt: iso(Date.now()), events: [{ id: randomUUID(), type: "CLOCK_IN", occurredAt: iso(Date.now() - clockedInMinutesAgo * M) }] } });
  return e;
}
const alice = await employee(1, "Alice Synthetic");
const bob = await employee(2, "Bob OneShot");
const carol = await employee(3, "Carol LongDay", 11 * 60); // 11 h session: room for 601 frames at the 60 s capture interval

// ---- Chrome ----------------------------------------------------------------------------------
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--remote-debugging-port=9334", `--user-data-dir=${join(RUN, "chrome")}`, "--window-size=1440,1000", "--no-first-run", "--autoplay-policy=no-user-gesture-required", "about:blank"], { stdio: "ignore" });
let target;
for (let i = 0; i < 150 && !target; i++) {
  await new Promise((r) => setTimeout(r, 200));
  target = await fetch("http://127.0.0.1:9334/json/new?about:blank", { method: "PUT" }).then((r) => r.json(), () => null);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pending = new Map();
const events = [];
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);
  if (!msg.id || !pending.has(msg.id)) return void events.push(msg);
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
await cdp("Runtime.enable");

// Real WebP frames from synthetic canvases: alternating 16:9 and 4:3 to exercise letterboxing.
const webp = async (n, w, h) => Buffer.from(await js(`(async () => {
  const c = document.createElement("canvas"); c.width = ${w}; c.height = ${h}; const g = c.getContext("2d");
  g.fillStyle = "hsl(${(n * 47) % 360} 55% 40%)"; g.fillRect(0, 0, ${w}, ${h});
  g.fillStyle = "#fff"; g.font = "bold 90px sans-serif"; g.fillText("SYNTHETIC FRAME #${n}", 80, ${h / 2});
  const b = await new Promise((r) => c.toBlob(r, "image/webp", 0.7)); const u = new Uint8Array(await b.arrayBuffer());
  let s = ""; for (const x of u) s += String.fromCharCode(x); return btoa(s);
})()`), "base64");
async function upload(e, at, n, w = 1920, h = 1080, bytes) {
  bytes ??= await webp(n, w, h);
  const id = randomUUID();
  const reg = await api("/screenshots/register", { method: "POST", bearer: e.bearer, device: e.device, body: { id, capturedAt: iso(at), sentAt: iso(Date.now()), width: w, height: h, sizeBytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), mimeType: "image/webp" } });
  assert.equal(reg.body.status, "REGISTERED", JSON.stringify(reg.body));
  assert.equal((await api(`/screenshots/${id}/content`, { method: "PUT", bearer: e.bearer, device: e.device, raw: bytes })).status, 200);
  return bytes;
}
const now = Date.now();
for (let i = 0; i < 16; i++) await upload(alice, now - (150 - i * 5) * M, i + 1, ...(i % 2 ? [1440, 1080] : [1920, 1080]));
await upload(bob, now - 60 * M, 99);
check("seeded 17 real WebP screenshots (synthetic) through register+upload", true);

// ---- Dashboard ---------------------------------------------------------------------------------
const dash = spawn("pnpm", ["exec", "next", "start", "--port", "3101"], { cwd: `${ROOT}/apps/dashboard`, stdio: "ignore" });
for (let i = 0; i < 100; i++) {
  if (await fetch("http://localhost:3101/login").then((r) => r.ok, () => false)) break;
  await new Promise((r) => setTimeout(r, 200));
}
const panel = `[...document.querySelectorAll('section')].find((s) => s.querySelector('h3')?.textContent === 'Timelapse')`;
const click = (label) => js(`(() => { const b = [...${panel}.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled); if (!b) return false; b.focus(); b.click(); return true; })()`);
const panelText = () => js(`${panel}?.innerText ?? ""`);
try {
  await cdp("Network.enable");
  await cdp("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: join(RUN, "downloads"), eventsEnabled: true });
  await cdp("Page.navigate", { url: "http://localhost:3101/login" });
  await waitFor(`(() => { const f = document.querySelector('form'); return !!f && Object.keys(f).some((k) => k.startsWith('__reactProps')); })()`, "hydrated login form");
  await js(`(() => {
    const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
    set(document.querySelector('input[type=email], input[name=email]'), "admin@example.com");
    set(document.querySelector('input[type=password]'), ${JSON.stringify(PASSWORD)});
    document.querySelector('form').requestSubmit();
  })()`);
  await waitFor(`location.pathname !== "/login"`, "sign-in");
  await cdp("Page.navigate", { url: "http://localhost:3101/screenshots" });
  await waitFor(`document.querySelector('select')?.options.length === 4`, "employee options");
  check("without an employee the page asks to choose one", (await js("document.body.innerText")).includes("Choose an employee to create a timelapse"));
  const pick = (value) => js(`(() => { const s = document.querySelector('select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);

  await pick(bob.id);
  await waitFor(`(${panel}?.innerText ?? "").includes("Not enough stored screenshots")`, "insufficient state");
  check("insufficient screenshots: explained, Create disabled", await js(`[...${panel}.querySelectorAll('button')].find((b) => b.textContent === 'Create timelapse').disabled`));

  await pick(alice.id);
  await waitFor(`(${panel}?.innerText ?? "").includes("16 stored screenshot(s)")`, "Alice's session");
  const t0 = await panelText();
  check("session listed with count and estimated duration (16 frames at 8 fps → 2 s)", t0.includes("16 stored screenshot(s) → about 2 s at 8 fps"));
  check("panel explains content, masking and access", t0.includes("nothing else is blurred or masked") && t0.includes("Only administrators") && t0.includes("logged"));
  await shot("timelapse-before.png");

  assert.ok(await click("Create timelapse"), "Create button");
  await waitFor(`/Queued|Creating/.test(${panel}.innerText) || ${panel}.innerText.includes("Ready")`, "job started");
  check("progress/status shown while creating", true, (await panelText()).match(/(Queued|Creating|Ready)[^\n]*/)?.[0]);
  await waitFor(`${panel}.innerText.includes("Ready")`, "ready", 60_000);
  const t1 = await panelText();
  check("ready: 16 frames · 2 s, size and deletion time shown", /16 frames · 2 s · \d+ KB · deleted/.test(t1), t1.match(/16 frames[^\n]*/)?.[0]);

  assert.ok(await click("Preview"), "Preview button");
  await waitFor(`(() => { const v = ${panel}.querySelector('video'); return v && v.readyState >= 1 && v.duration > 0; })()`, "video metadata");
  const v = await js(`(() => { const v = ${panel}.querySelector('video'); return { src: v.src, w: v.videoWidth, h: v.videoHeight, d: v.duration, label: v.getAttribute('aria-label') }; })()`);
  check("preview plays a blob: URL in the browser (1280×720, 2 s)", v.src.startsWith("blob:") && v.w === 1280 && v.h === 720 && Math.abs(v.d - 2) < 0.01, JSON.stringify({ w: v.w, h: v.h, d: v.d }));
  check("video has an accessible label", !!v.label);
  await js(`${panel}.querySelector('video').currentTime = 1.2`);
  await new Promise((r) => setTimeout(r, 500));
  await shot("timelapse-preview.png");

  const contentResponses = () => events.filter((e) => e.method === "Network.responseReceived" && e.params.response.url.includes("/timelapses/") && e.params.response.url.includes("/content")).map((e) => e.params.response);
  const h = Object.fromEntries(Object.entries(contentResponses()[0]?.headers ?? {}).map(([k, val]) => [k.toLowerCase(), val]));
  check("video headers: video/mp4, no-store, nosniff, CSP sandbox, Repr-Digest", h["content-type"] === "video/mp4" && h["cache-control"]?.includes("no-store") && h["x-content-type-options"] === "nosniff" && h["content-security-policy"]?.includes("sandbox") && /^sha-256=:/.test(h["repr-digest"] ?? ""), JSON.stringify({ ct: h["content-type"], cc: h["cache-control"] }));

  assert.ok(await click("Download"), "Download button");
  const dl = join(RUN, "downloads");
  for (let i = 0; i < 100 && !readdirSync(dl).some((f) => f.endsWith(".mp4")); i++) await new Promise((r) => setTimeout(r, 100));
  const file = readdirSync(dl).find((f) => f.endsWith(".mp4"));
  const probe = file && JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,nb_read_frames:format=duration", "-of", "json", join(dl, file)], { encoding: "utf8" }));
  const s = probe?.streams[0];
  check("download saved a valid H.264 MP4 (16 frames, 2 s, 1280×720)", !!s && s.codec_name === "h264" && s.nb_read_frames === "16" && s.width === 1280 && Number(probe.format.duration) === 2, file && `${file}, ${statSync(join(dl, file)).size} bytes`);
  const jobId = (await db.execute("SELECT id FROM timelapses WHERE status = 'READY'")).rows[0]?.id;
  const log = (await db.execute({ sql: "SELECT action FROM timelapse_access_log WHERE timelapse_id = ? ORDER BY rowid", args: [jobId] })).rows.map((r) => r.action).join(",");
  check("access log: CREATE, VIEW (preview), DOWNLOAD", log === "CREATE,VIEW,DOWNLOAD", log);
  check("no file path or API content URL in the DOM", !(await js(`document.documentElement.outerHTML`)).includes(join(RUN, "videos")) && !(await js(`document.documentElement.outerHTML`)).includes("/content"));

  // Mobile width: no horizontal page scroll; actions wrap.
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await new Promise((r) => setTimeout(r, 400));
  check("mobile (390 px): no horizontal scroll", await js(`document.scrollingElement.scrollWidth <= window.innerWidth`), String(await js("document.scrollingElement.scrollWidth")));
  await js(`${panel}.scrollIntoView()`);
  await shot("timelapse-mobile.png");
  await cdp("Emulation.clearDeviceMetricsOverride");

  assert.ok(await click("Delete video"), "Delete button");
  await waitFor(`${panel}.innerText.includes("Deleted") && [...${panel}.querySelectorAll('button')].some((b) => b.textContent === 'Retry')`, "deleted state");
  check("delete: status Deleted, file removed, Retry offered", !existsSync(join(RUN, "videos", `${jobId}.mp4`)));

  // Retry → cancel while encoding. The encoder is held open until Cancel arrives: 16 real frames
  // would otherwise finish before the button can be pressed, and the check would race.
  const realEncode = service.encoder.encode;
  service.encoder.encode = (_frames, _out, o) => new Promise((_, reject) => o.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  try {
    assert.ok(await click("Retry"), "Retry button");
    await waitFor(`[...${panel}.querySelectorAll('button')].some((b) => b.textContent === 'Cancel')`, "cancel offered");
    assert.ok(await click("Cancel"), "Cancel button");
    await waitFor(`${panel}.innerText.includes("Cancelled")`, "cancelled state");
  } finally {
    service.encoder.encode = realEncode;
  }
  const aliceSession = (await db.execute({ sql: "SELECT id FROM attendance_sessions WHERE employee_id = ?", args: [alice.id] })).rows[0].id;
  const retryId = (await db.execute({ sql: "SELECT id FROM timelapses WHERE attendance_session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", args: [aliceSession] })).rows[0].id;
  check("retry starts a new job; cancel while encoding → Cancelled, Retry offered again", retryId !== jobId && (await panelText()).includes("Cancelled") && (await js(`[...${panel}.querySelectorAll('button')].some((b) => b.textContent === 'Retry')`)));
  check("no partial files left", readdirSync(join(RUN, "videos")).every((f) => !f.endsWith(".part")));

  // Large video: above the confirmation threshold the first click asks, "Not now" creates nothing,
  // confirming queues the job. Carol's session gets 601 stored frames one capture interval apart: one
  // real register+upload, then copies of that file as STORED rows (the register endpoint allows 120
  // requests per employee per 10 minutes, so 600 more uploads cannot go through the API).
  const big = TIMELAPSE_LIMITS.confirmAboveFrames + 1;
  const carolIn = now - 11 * 60 * M;
  await upload(carol, carolIn + 5 * M, 100);
  const seed = (await db.execute({ sql: "SELECT * FROM screenshots WHERE employee_id = ?", args: [carol.id] })).rows[0];
  const copies = [];
  for (let i = 1; i < big; i++) {
    const id = randomUUID();
    const at = iso(carolIn + (5 + i) * M);
    const key = `${carol.id}/${at.slice(0, 7)}/${id}.webp`;
    mkdirSync(dirname(join(RUN, "shots", key)), { recursive: true });
    copyFileSync(join(RUN, "shots", seed.storage_key), join(RUN, "shots", key));
    copies.push({
      sql: `INSERT INTO screenshots (id, employee_id, device_id, attendance_session_id, idempotency_key, captured_at, device_captured_at, width, height,
              mime_type, file_size_bytes, checksum, storage_provider, storage_key, upload_status, stored_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'image/webp', ?, ?, 'LOCAL_DEV', ?, 'STORED', ?)`,
      args: [id, carol.id, seed.device_id, seed.attendance_session_id, id, at, at, seed.width, seed.height, seed.file_size_bytes, seed.checksum, key, at],
    });
  }
  await db.batch(copies, "write");
  const carolSession = seed.attendance_session_id;
  const carolJobs = async () => Number((await db.execute({ sql: "SELECT count(*) AS n FROM timelapses WHERE attendance_session_id = ?", args: [carolSession] })).rows[0].n);
  await pick(carol.id);
  await waitFor(`(${panel}?.innerText ?? "").includes("${big} stored screenshot(s)")`, "Carol's large session");
  assert.ok(await click("Create timelapse"), "Create button (large)");
  await waitFor(`!!${panel}.querySelector('[role=group][aria-label="Confirm large timelapse"]')`, "confirmation step");
  const confirmText = await js(`${panel}.querySelector('[role=group]').innerText`);
  assert.ok(await click("Not now"), "Not now button");
  await new Promise((r) => setTimeout(r, 300));
  check(`large video (${big} frames): confirmation asked first; "Not now" creates no job`, confirmText.includes(`${big} screenshots`) && (await carolJobs()) === 0 && !(await js(`!!${panel}.querySelector('[role=group]')`)), confirmText.replace(/\n/g, " | "));
  assert.ok(await click("Create timelapse"), "Create button (large, again)");
  await waitFor(`!!${panel}.querySelector('[role=group]')`, "confirmation step again");
  assert.ok(await js(`(() => { const b = [...${panel}.querySelectorAll('[role=group] button')].find((b) => /^Create .* video$/.test(b.textContent.trim())); if (!b) return false; b.click(); return true; })()`), "confirm button");
  await waitFor(`/Queued|Creating|Ready/.test(${panel}.innerText)`, "large job started");
  check("confirming queues the large job (one job for the session)", (await carolJobs()) === 1);
  await waitFor(`${panel}.innerText.includes("Ready")`, "large job ready", 180_000);
  const tBig = await panelText();
  check(`large video ready: ${big} frames, 1 min 15 s at 8 fps`, tBig.includes(`${big} frames · 1 min 15 s`), tBig.match(new RegExp(`${big} frames[^\\n]*`))?.[0]);

  // Encoder unavailable: shown, creation refused.
  Object.assign(service, { encoderReason: "FFmpeg is not installed on the API server (or FFMPEG_PATH is wrong)" });
  await pick(bob.id);
  await pick(alice.id);
  await waitFor(`(${panel}?.innerText ?? "").includes("cannot be created on this server")`, "encoder warning");
  check("encoder unavailable: warning shown, Create disabled", await js(`[...${panel}.querySelectorAll('button')].filter((b) => /Create|Retry/.test(b.textContent)).every((b) => b.disabled)`));
  await shot("timelapse-unavailable.png");
  Object.assign(service, { encoderReason: null });

  await app.close(); // error state: API gone
  await pick(bob.id);
  await waitFor(`!!document.querySelector('[role=alert]')`, "error state");
  check("error state when the API is unreachable", true, await js(`document.querySelector('[role=alert]').innerText`));
} catch (err) {
  check(`run aborted: ${err.message}`, false);
  await shot("timelapse-failure.png").catch(() => {});
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
