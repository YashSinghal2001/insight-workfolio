// Gallery runtime check (Day 8): a throwaway API (temporary file DB, local storage) on :4000, the
// dashboard production build on :3100, headless Chrome over CDP. Images are real WebPs encoded by
// Chrome (synthetic content, never a real screen), uploaded through the real register/upload
// endpoints. Run after `pnpm build`; needs Google Chrome (macOS path). Usage: pnpm verify:gallery [out-dir]
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const ROOT = resolve(import.meta.dirname, "../../..");
/** Screenshots of the run (PNG) land here; the database, files and Chrome profile are deleted at the end. */
const OUT = process.argv[2] ?? mkdtempSync(join(tmpdir(), "wf-verify-gallery-"));
rmSync(join(OUT, "run"), { recursive: true, force: true });
mkdirSync(join(OUT, "run", "shots"), { recursive: true });
Object.assign(process.env, {
  NODE_ENV: "development", LOG_LEVEL: "warn", PORT: "4000",
  DATABASE_URL: `file:${join(OUT, "run", "gallery.db")}`,
  JWT_SECRET: "gallery-check-secret-gallery-check-secret",
  SCREENSHOT_STORAGE: "local", SCREENSHOT_LOCAL_DIR: join(OUT, "run", "shots"),
  CORS_ORIGINS: "http://localhost:3100",
});
const dist = (p) => import(`${ROOT}/apps/api/dist/${p}`);
const req = createRequire(`${ROOT}/apps/api/package.json`);
req("reflect-metadata");
const { NestFactory } = req("@nestjs/core");
const { AppModule } = await dist("app.module.js");
const { configureApp } = await dist("app.setup.js");
const { DATABASE } = await dist("database/database.module.js");
const { hashPassword } = await dist("auth/crypto.js");
const NOTICE = "2026-10-screenshots-draft-1";
const PASSWORD = "gallery check password 1";
const M = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const results = [];
const check = (name, ok, detail = "") => (results.push({ name, ok }), console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`));

// ---- API -----------------------------------------------------------------------------------
const app = await NestFactory.create(AppModule, { logger: ["error", "warn"] });
configureApp(app);
await app.listen(4000);
const db = app.get(DATABASE);
const api = async (path, { method = "GET", body, raw, cookie, bearer, device } = {}) => {
  const headers = { origin: "http://localhost:3100" };
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
// Policy on, 60 s interval, effective two days ago (same as the e2e tests' backdated policy).
await db.execute({
  sql: `INSERT INTO screenshot_policies (screenshots_enabled, interval_seconds, webp_quality, max_dimension, capture_scope, retention_days,
          retention_approved, notice_version, reason, changed_by, effective_at) VALUES (1, 60, 70, 1920, 'PRIMARY_DISPLAY', 30, 0, ?, 'gallery check', ?, ?)`,
  args: [NOTICE, adminId, iso(Date.now() - 2 * 86_400_000)],
});
async function employee(n, name) {
  const email = `gallery${n}@example.com`;
  const r = await api("/employees", { method: "POST", cookie: adminCookie, body: { email, employeeCode: `GAL-${n}`, fullName: name, timezone: "UTC" } });
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const bearer = (await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } })).body.accessToken;
  const e = { id: r.body.employee.id, bearer, device: randomUUID() };
  await api("/devices/register", { method: "POST", bearer, body: { installationId: e.device, deviceName: "Mac", platform: "macos" } });
  await db.execute({ sql: "INSERT INTO monitoring_consents (id, employee_id, notice_version, acknowledged_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), e.id, NOTICE, iso(Date.now() - 4 * 60 * M)] });
  await api("/attendance/sync", { method: "POST", bearer, device: e.device, body: { sentAt: iso(Date.now()), events: [{ id: randomUUID(), type: "CLOCK_IN", occurredAt: iso(Date.now() - 180 * M) }] } });
  return e;
}
const alice = await employee(1, "Alice Synthetic");
const bob = await employee(2, "Bob Synthetic");
const carol = await employee(3, "Carol NoShots");

// ---- Chrome ----------------------------------------------------------------------------------
const profile = join(OUT, "run", "chrome");
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--remote-debugging-port=9333", `--user-data-dir=${profile}`, "--window-size=1440,1000", "--no-first-run", "about:blank"], { stdio: "ignore" });
let target;
for (let i = 0; i < 50 && !target; i++) {
  await new Promise((r) => setTimeout(r, 200));
  target = await fetch("http://127.0.0.1:9333/json/new?about:blank", { method: "PUT" }).then((r) => r.json(), () => null);
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
const waitFor = async (expr, label, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 150))) if (await js(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${label}`);
};
const shot = async (name) => writeFileSync(join(OUT, name), Buffer.from((await cdp("Page.captureScreenshot", { format: "png" })).data, "base64"));
await cdp("Page.enable");
await cdp("Runtime.enable");

// Real WebP files, encoded by Chrome from a canvas with an obvious "synthetic" label.
const webp = async (n) => Buffer.from(await js(`(async () => {
  const c = document.createElement("canvas"); c.width = 1920; c.height = 1080; const g = c.getContext("2d");
  g.fillStyle = "hsl(${(n * 47) % 360} 55% 40%)"; g.fillRect(0, 0, 1920, 1080);
  g.fillStyle = "#fff"; g.font = "bold 120px sans-serif"; g.fillText("SYNTHETIC TEST #${n}", 120, 560);
  const b = await new Promise((r) => c.toBlob(r, "image/webp", 0.7)); const u = new Uint8Array(await b.arrayBuffer());
  let s = ""; for (const x of u) s += String.fromCharCode(x); return btoa(s);
})()`), "base64");
async function upload(e, at, n, { skipUpload = false } = {}) {
  const bytes = await webp(n);
  const id = randomUUID();
  const reg = await api("/screenshots/register", { method: "POST", bearer: e.bearer, device: e.device, body: { id, capturedAt: iso(at), sentAt: iso(Date.now()), width: 1920, height: 1080, sizeBytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), mimeType: "image/webp" } });
  assert.equal(reg.body.status, "REGISTERED", JSON.stringify(reg.body));
  if (!skipUpload) assert.equal((await api(`/screenshots/${id}/content`, { method: "PUT", bearer: e.bearer, device: e.device, raw: bytes })).status, 200);
}
const now = Date.now();
for (let i = 0; i < 27; i++) await upload(alice, now - (150 - i * 5) * M, i + 1);
for (let i = 0; i < 3; i++) await upload(bob, now - (100 - i * 10) * M, 100 + i);
await upload(bob, now - 30 * M, 200, { skipUpload: true }); // registered, bytes never arrived
check("seeded 30 real WebP screenshots through register+upload (+1 awaiting upload)", true);

// ---- Dashboard ---------------------------------------------------------------------------------
const dash = spawn("pnpm", ["exec", "next", "start", "--port", "3100"], { cwd: `${ROOT}/apps/dashboard`, stdio: "ignore" });
for (let i = 0; i < 100; i++) {
  if (await fetch("http://localhost:3100/login").then((r) => r.ok, () => false)) break;
  await new Promise((r) => setTimeout(r, 200));
}
try {
  await cdp("Network.enable");
  await cdp("Page.navigate", { url: "http://localhost:3100/login" });
  await waitFor(`(() => { const f = document.querySelector('form'); return !!f && Object.keys(f).some((k) => k.startsWith('__reactProps')); })()`, "hydrated login form");
  await js(`(() => {
    const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
    set(document.querySelector('input[type=email], input[name=email]'), "admin@example.com");
    set(document.querySelector('input[type=password]'), ${JSON.stringify(PASSWORD)});
    document.querySelector('form').requestSubmit();
  })()`);
  await waitFor(`location.pathname !== "/login"`, "sign-in");
  await cdp("Page.navigate", { url: "http://localhost:3100/screenshots" });

  const imgs = `[...document.querySelectorAll('section[aria-label="Screenshot gallery"] li img')]`;
  const cards = `document.querySelectorAll('section[aria-label="Screenshot gallery"] li').length`;
  await waitFor(`${cards} === 24 && ${imgs}.length === 23 && ${imgs}.every((i) => i.complete && i.naturalWidth === 1920)`, "24 cards, 23 decoded thumbnails");
  const text = await js("document.body.innerText");
  check("sidebar has Screenshots", await js(`[...document.querySelectorAll('nav a')].some((a) => a.getAttribute('href') === '/screenshots')`));
  check("24 cards per page; 23 stored thumbnails decoded, the awaiting one shows its status instead", true);
  check("thumbnails are blob: URLs only (no storage or API URL in the DOM)", await js(`${imgs}.every((i) => i.src.startsWith('blob:'))`));
  check("counts: 31 total, 30 stored, 1 awaiting", /Screenshots\s*31\s*30 stored · 0 deleted/.test(text) && /Awaiting upload\s*1/.test(text), text.match(/Screenshots\s*\d+[^\n]*\n?[^\n]*/)?.[0]);
  check("retention: not approved, nothing deleted", text.includes("Not approved: nothing deleted"));
  check("pagination: page 1 of 2, 31 total", text.includes("Page 1 of 2 · 31 screenshot(s)"));
  check("capture timestamps and upload status shown", text.includes("Stored") && text.includes("Awaiting upload") && /\d{2}:\d{2}:\d{2}/.test(text));
  await shot("gallery-page1.png");

  const click = (label) => js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click()`);
  await click("Next");
  await waitFor(`document.body.innerText.includes("Page 2 of 2") && document.querySelectorAll('section[aria-label="Screenshot gallery"] li').length === 7`, "page 2");
  await waitFor(`${imgs}.length === 7 && ${imgs}.every((i) => i.complete && i.naturalWidth === 1920)`, "page 2 thumbnails");
  check("page 2 has the remaining 7 stored screenshots", true);
  await click("Previous");
  await waitFor(`document.body.innerText.includes("Page 1 of 2")`, "page 1 again");

  const pick = (value) => js(`(() => { const s = document.querySelector('select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await waitFor(`document.querySelector('select').options.length === 4`, "employee options");
  await pick(bob.id);
  await waitFor(`document.body.innerText.includes("Page 1 of 1 · 4 screenshot(s)")`, "Bob filter");
  check("employee filter: Bob → 4 (3 stored + 1 awaiting), only Bob's cards", (await js(`[...document.querySelectorAll('section[aria-label="Screenshot gallery"] li')].every((li) => li.innerText.includes("Bob Synthetic"))`)));
  await pick(carol.id);
  await waitFor(`document.body.innerText.includes("No screenshots in this range.")`, "empty state");
  check("empty state for an employee without screenshots", true);
  await pick(alice.id);
  await waitFor(`${imgs}.length === 24 && ${imgs}.every((i) => i.complete && i.naturalWidth === 1920)`, "Alice page 1");

  const before = Number((await db.execute("SELECT count(*) AS n FROM screenshot_access_log WHERE action = 'VIEW'")).rows[0].n);
  const contentResponses = () => events.filter((e) => e.method === "Network.responseReceived" && /\/screenshots\/[^/]+\/content/.test(e.params.response.url)).map((e) => e.params.response);
  const openViewer = async () => {
    await js(`document.querySelector('section[aria-label="Screenshot gallery"] li button').click()`);
    await waitFor(`(() => { const i = document.querySelector('dialog[open] img'); return i && i.complete && i.naturalWidth === 1920; })()`, "full-size viewer");
  };
  await openViewer();
  await waitFor(`document.querySelector('dialog[open]').innerText.includes("Access log")`, "access log in viewer");
  const dialogText = await js(`document.querySelector('dialog[open]').innerText`);
  check("secure viewer shows full-size image from a blob: URL", await js(`document.querySelector('dialog[open] img').src.startsWith('blob:')`));
  check("viewer shows confidentiality notice and access log", dialogText.includes("This view is logged") && /Access log \(\d+\)/.test(dialogText));
  await shot("gallery-viewer.png");
  await js(`document.querySelector('dialog[open]').close()`);
  await openViewer(); // second view: must hit the API again, never a browser cache
  await js(`document.querySelector('dialog[open]').close()`);
  const after = Number((await db.execute("SELECT count(*) AS n FROM screenshot_access_log WHERE action = 'VIEW'")).rows[0].n);
  check("each full view reached the API and was logged (2 views → +2 VIEW rows)", after - before === 2, `${before} → ${after}`);
  const full = contentResponses().filter((r) => r.url.includes("variant=full"));
  check("no image response served from browser cache", contentResponses().every((r) => !r.fromDiskCache && !r.fromPrefetchCache && !r.fromServiceWorker && r.status === 200), `${contentResponses().length} responses`);
  const h = Object.fromEntries(Object.entries(full[0]?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  check("image headers: no-store, nosniff, CSP sandbox, image/webp, inline filename", h["cache-control"]?.includes("no-store") && h["x-content-type-options"] === "nosniff" && h["content-security-policy"]?.includes("sandbox") && h["content-type"] === "image/webp" && /^inline; filename="screenshot-[0-9a-f-]+\.webp"$/.test(h["content-disposition"] ?? ""), JSON.stringify({ cc: h["cache-control"], csp: h["content-security-policy"], cd: h["content-disposition"] }));
  const log = (await db.execute("SELECT action, count(*) AS n FROM screenshot_access_log GROUP BY action")).rows.map((r) => `${r.action}=${r.n}`).join(" ");
  const cols = (await db.execute("PRAGMA table_info(screenshot_access_log)")).rows.map((r) => r.name).join(",");
  check("access log holds viewer, screenshot, time and action only (no image data)", !/data|bytes|blob|content/.test(cols), `columns ${cols}; ${log}`);

  await app.close(); // error state: API gone
  await pick(bob.id);
  await waitFor(`!!document.querySelector('[role=alert], .text-red-700') || /unreachable|failed|could not|error/i.test(document.body.innerText)`, "error state");
  check("error state when the API is unreachable", true, (await js(`document.body.innerText`)).match(/[^\n]*(unreachable|failed|could not|error)[^\n]*/i)?.[0]);
  await shot("gallery-error.png");
} catch (err) {
  check(`run aborted: ${err.message}`, false);
  await shot("gallery-failure.png").catch(() => {});
} finally {
  ws.close();
  chrome.kill();
  dash.kill();
  await app.close().catch(() => {});
  await new Promise((r) => setTimeout(r, 500)); // let Chrome release its profile
  rmSync(join(OUT, "run"), { recursive: true, force: true });
}
console.log(`Page captures: ${OUT}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
