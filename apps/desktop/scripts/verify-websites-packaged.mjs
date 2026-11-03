// F04 packaged-app check: the BUNDLED desktop app (`tauri build --debug --bundles app`: front end
// embedded, tauri://localhost, app CSP; debug profile only because the test hook is compiled out of
// release builds) together with the REAL browser extension in Google Chrome (headless, loaded over the
// DevTools pipe) and a throwaway API that is stopped and restarted mid-run. Two launches of the app
// with a quit in between. Synthetic people and local test sites only. The activity notice is NOT
// acknowledged, so the desktop app records no application activity.
//
//   pnpm build && pnpm --filter @workfolio/desktop tauri build --debug --bundles app
//   pnpm --filter @workfolio/desktop verify:websites-packaged [--sleep]
//
// --sleep (attended): with a site in front, puts this Mac to sleep (`pmset sleepnow`); wake it after
// about two minutes. The app's saved dev sign-in (Keychain) is replaced and cleared; choose "Always
// Allow" if macOS asks about the app's Keychain items.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const APP = join(ROOT, "apps/desktop/src-tauri/target/debug/bundle/macos/Insight Workfolio.app/Contents/MacOS/insight-workfolio-desktop");
const EXT = join(ROOT, "apps/browser-extension");
const SLEEP = process.argv.includes("--sleep");
const API = "http://localhost:4000/api/v1";
const ORIGIN = "http://localhost:3000";
const tmp = mkdtempSync(join(tmpdir(), "wf-websites-packaged-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const up = (u) => fetch(u).then((r) => r.ok, () => false);
const results = [];
const check = (name, ok, detail = "") => (results.push({ name, ok }), console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`));
const children = new Set();
process.on("exit", () => children.forEach((c) => c.kill()));

if (!existsSync(APP)) throw new Error(`No bundle at ${APP}; build it first (see the header).`);
if (await up(`${API}/health`)) throw new Error("Port 4000 is in use; stop the running API first.");
if (spawnSync("pgrep", ["-x", "insight-workfolio-desktop"]).status === 0) throw new Error("The desktop app is running; quit it first (one instance only).");

// ---- API (a child process, so it can be stopped and started) ------------------------------------
const env = { ...process.env, NODE_ENV: "development", LOG_LEVEL: "warn", PORT: "4000", DATABASE_URL: `file:${join(tmp, "web.db")}`, JWT_SECRET: randomBytes(32).toString("hex"), REPORT_SCHEDULER_SECONDS: "0" };
let api = null;
async function startApi() {
  api = spawn("node", [join(ROOT, "apps/api/dist/main.js")], { env, stdio: ["ignore", "ignore", "inherit"] });
  children.add(api);
  for (let i = 0; i < 60 && !(await up(`${API}/ready`)); i++) await sleep(250);
}
async function stopApi() {
  const exited = new Promise((r) => api.on("exit", r));
  api.kill();
  await exited;
  children.delete(api);
}
async function call(path, { method = "GET", body, cookie, bearer, device } = {}) {
  const headers = { origin: ORIGIN };
  if (body) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (device) headers["x-device-id"] = device;
  const res = await fetch(`${API}${path}`, { method, headers, body: body && JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return { body: text ? JSON.parse(text) : undefined, res };
}
await startApi();
const cli = execFileSync("node", [join(ROOT, "apps/api/dist/cli/create-admin.js"), "--email", "ceo@verify.local", "--super-admin"], { env, encoding: "utf8" });
const adminPassword = randomBytes(12).toString("hex");
await call("/auth/setup-password", { method: "POST", body: { token: cli.match(/#token=(\S+)/)[1], password: adminPassword } });
const adminCookie = async () => (await call("/auth/login", { method: "POST", body: { email: "ceo@verify.local", password: adminPassword } })).res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const cookie = await adminCookie();
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const password = randomBytes(12).toString("hex");
const emp = await call("/employees", { method: "POST", cookie, body: { email: "web@verify.local", employeeCode: "PKW-1", fullName: "Packaged Web", timezone: timeZone } });
await call("/auth/setup-password", { method: "POST", body: { token: emp.body.setup.token, password } });
const employeeId = emp.body.employee.id;
const bearer = (await call("/auth/login", { method: "POST", body: { email: "web@verify.local", password, client: "desktop" } })).body.accessToken;
const seedDevice = randomUUID();
await call("/devices/register", { method: "POST", bearer, body: { installationId: seedDevice, deviceName: "Seed", platform: "macos" } });
await call("/attendance/sync", { method: "POST", bearer, device: seedDevice, body: { sentAt: new Date().toISOString(), events: [{ id: randomUUID(), type: "CLOCK_IN", occurredAt: new Date(Date.now() - 30 * 60_000).toISOString() }] } });
const m = (await call("/settings/monitoring", { cookie })).body.effective;
await call("/settings/monitoring", { method: "PUT", cookie, body: { enabled: m.enabled, sampleSeconds: m.sampleSeconds, idleThresholdSeconds: 3600, retentionDays: m.retentionDays, retentionApproved: m.retentionApproved, noticeVersion: m.noticeVersion, reason: "verification: idle threshold 1 h" } });
await call("/websites/policy", { method: "PUT", cookie, body: { enabled: true, retentionDays: 30, noticeVersion: "2026-10-websites-draft-1", reason: "Packaged-app verification (synthetic)" } });
const intervals = async () => {
  const day = (n) => new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(Date.now() + n * 86_400_000));
  // a fresh sign-in each time: the run can outlast the access token (a long sleep)
  return (await call(`/websites/report?from=${day(-1)}&to=${day(0)}&employeeId=${employeeId}`, { cookie: await adminCookie() })).body;
};

// ---- Local test sites and Chrome with the extension --------------------------------------------------
const site = http.createServer((q, r) => r.writeHead(200, { "content-type": "text/html" }).end(`<title>Title ${q.url}</title><p>secret body</p>`));
await new Promise((r) => site.listen(0, r));
const P = site.address().port;
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${join(tmp, "chrome")}`, "--no-first-run", "--host-resolver-rules=MAP *.test 127.0.0.1", "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
children.add(chrome);
let seq = 0;
const pending = new Map();
let buffer = "";
chrome.stdio[4].on("data", (d) => {
  buffer += d;
  for (let i; (i = buffer.indexOf("\0")) >= 0; ) {
    const msg = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    if (msg.id && pending.has(msg.id)) (pending.get(msg.id)(msg), pending.delete(msg.id));
  }
});
const cdp = (method, params = {}, sessionId) => new Promise((res, rej) => { const id = ++seq; pending.set(id, (mm) => (mm.error ? rej(new Error(`${method}: ${mm.error.message}`)) : res(mm.result))); chrome.stdio[3].write(`${JSON.stringify({ id, method, params, sessionId })}\0`); });
async function tab(u, opts = {}) {
  const { targetId } = await cdp("Target.createTarget", { url: u, ...opts });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  await cdp("Runtime.enable", {}, sessionId);
  return { targetId, sessionId };
}
const js = async (t, expr) => (await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, t.sessionId)).result.value;
const { id: extId } = await cdp("Extensions.loadUnpacked", { path: EXT });
const pop = await tab(`chrome-extension://${extId}/popup.html`);
const browse = await tab("about:blank", { newWindow: true });
const tick = () => js(pop, `chrome.runtime.sendMessage({ type: 'tick' })`);
const go = async (u, ms) => {
  await cdp("Target.activateTarget", { targetId: browse.targetId });
  await cdp("Page.navigate", { url: u }, browse.sessionId);
  await sleep(ms);
};

// ---- The driver inside the packaged app ------------------------------------------------------------
function driver(cfg) {
  if (window.__wfWeb) return;
  window.__wfWeb = true;
  const inv = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const log = (line) => inv("e2e_log", { line });
  const $ = (s) => document.querySelector(s);
  const txt = (s) => ($(s)?.textContent ?? "").trim();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 90_000, what = "condition") => {
    for (const end = Date.now() + ms; Date.now() < end; await wait(250)) {
      const v = await fn();
      if (v) return v;
    }
    throw new Error(`timed out: ${what}`);
  };
  const r = { phase: cfg.phase, href: location.href, steps: {} };
  const websites = async () => {
    $("#tab-btn-today").click();
    $("#tab-btn-websites").click();
    await until(() => txt("#web-status") !== "Loading…" && (!$("#web-body").hidden || !$("#web-error").hidden), 90_000, "websites tab");
  };
  const refresh = async () => {
    $("#web-range").requestSubmit();
    await wait(300);
    await until(() => txt("#web-status") !== "Loading…", 30_000, "refresh");
  };
  const snap = () => ({ state: txt("#web-state"), reasons: $("#web-reasons")?.innerText ?? "", usage: $("#web-usage")?.innerText ?? "", links: $("#web-links")?.innerText ?? "", error: $("#web-error").hidden ? "" : txt("#web-error"), notice: !$("#web-notice").hidden, role: $("#role-badge").hidden ? "" : txt("#role-badge"), adminPanel: !$("#admin-panel").hidden });
  (async () => {
    try {
      await until(() => !$("#login-view").hidden || !$("#signed-in-view").hidden, 300_000, "app ready"); // time to answer a Keychain prompt
      r.autoSignedIn = !$("#signed-in-view").hidden && document.body.textContent.includes("PKW-1");
      if (!$("#signed-in-view").hidden && !r.autoSignedIn) {
        $("#logout").click();
        await until(() => !$("#login-view").hidden, 20_000, "signed out");
      }
      if (!r.autoSignedIn) {
        $("#login-form").email.value = cfg.email;
        $("#login-form").password.value = cfg.password;
        $("#login-form").requestSubmit();
        await until(() => !$("#signed-in-view").hidden && document.body.textContent.includes("PKW-1"), 90_000, "signed in");
      }
      await websites();
      if (cfg.phase === "first") {
        r.steps.initial = snap();
        $("#web-ack").click();
        await until(() => $("#web-notice").hidden && /No browser extension is connected/.test($("#web-reasons").innerText), 30_000, "acknowledged");
        $("#web-connect").click();
        await until(() => /^[A-Z2-9]{8}$/.test(txt("#web-code")), 30_000, "code");
        log(`CODE ${txt("#web-code")}`);
        await until(async () => {
          await refresh();
          return /docs\.example\.test/.test($("#web-usage").innerText) && /news\.example\.test/.test($("#web-usage").innerText);
        }, 120_000, "domains recorded by the browser shown in the app");
        r.steps.recorded = snap();
        log("first: quitting");
      } else {
        r.steps.restored = snap();
        if (cfg.sleep) {
          let last = Date.now();
          let gap = 0;
          const watch = setInterval(() => { const now = Date.now(); if (now - last > 15_000) gap = now - last; last = now; }, 1000);
          log("PHASE sleep-ready");
          await until(() => gap > 0, 8 * 60_000, "sleep and wake").catch(() => (r.noSleep = true));
          clearInterval(watch);
          log(r.noSleep ? "the Mac did not sleep" : `awake after ${Math.round(gap / 1000)} s asleep`);
          await until(async () => fetch("http://localhost:4000/api/v1/health").then((x) => x.ok, () => false), 60_000, "network after wake");
          log("PHASE awake");
          await wait(4000);
        }
        log("PHASE offline-ready");
        for (let i = 0; i < 100 && (await fetch("http://localhost:4000/api/v1/health").then((x) => x.ok, () => false)); i++) await wait(200);
        await websites();
        await until(() => !$("#web-error").hidden, 30_000, "offline error");
        r.steps.offline = snap();
        log("PHASE offline-seen");
        await until(async () => fetch("http://localhost:4000/api/v1/health").then((x) => x.ok, () => false), 60_000, "API back");
        await websites();
        await until(() => $("#web-error").hidden && !$("#web-body").hidden, 30_000, "recovered");
        r.steps.recovered = snap();
        [...document.querySelectorAll("#web-links button")].find((b) => b.textContent === "Disconnect").click();
        await until(() => /No browser connected/.test($("#web-links").innerText), 30_000, "disconnected");
        r.steps.disconnected = snap();
        log("PHASE disconnected");
        await wait(6000);
        $("#logout").click();
        await wait(1500);
      }
      r.ok = true;
    } catch (err) {
      r.error = `${err}${txt("#login-error") ? ` (login: ${txt("#login-error")})` : ""}${$("#signed-in-view").hidden ? "" : ` (signed in: ${document.body.textContent.includes("PKW-1") ? "PKW-1" : "other"})`}`;
      r.steps.atError = snap();
    }
    log(`RESULT ${JSON.stringify(r)}`);
    inv("e2e_exit", { code: 0 });
  })();
}

async function launch(phase, onLine) {
  const script = join(tmp, `${phase}.js`);
  writeFileSync(script, `(${driver.toString()})(${JSON.stringify({ phase, email: "web@verify.local", password, sleep: SLEEP })});`);
  const app = spawn(APP, { env: { ...process.env, WF_E2E_SCRIPT: script }, stdio: ["ignore", "ignore", "pipe"] });
  children.add(app);
  let result = null;
  let buffered = "";
  app.stderr.setEncoding("utf8").on("data", (chunk) => {
    const lines = (buffered + chunk).split("\n");
    buffered = lines.pop();
    for (const line of lines) {
      if (line.startsWith("[e2e] RESULT ")) result = JSON.parse(line.slice("[e2e] RESULT ".length));
      else if (line.startsWith("[e2e] ")) {
        console.log(`  app: ${line.replace(/CODE \w+/, "CODE ********")}`);
        void onLine(line.slice(6));
      }
    }
  });
  const exited = new Promise((r) => app.on("exit", r));
  if ((await Promise.race([exited, sleep(SLEEP ? 1_800_000 : 900_000).then(() => "timeout")])) === "timeout") app.kill();
  children.delete(app);
  return result ?? { error: "no result (timed out or crashed; a Keychain prompt may be waiting on screen)" };
}

// ---- Launch 1: notice, pairing from the packaged app, real browsing, the app shows it --------------------
const one = await launch("first", async (line) => {
  if (!line.startsWith("CODE ")) return;
  await js(pop, `(() => { const f = document.querySelector('#connect'); f.code.value = ${JSON.stringify(line.slice(5))}; f.label.value = 'Chrome (packaged check)'; f.requestSubmit(); })()`);
  const status = () => js(pop, `document.querySelector('#status').textContent`);
  for (let i = 0; i < 240 && (await status()) !== "Recording website domain names."; i++) await sleep(250);
  console.log(`  harness: extension says "${await status()}"`);
  await go(`http://docs.example.test:${P}/private/path?q=search`, 3000);
  await go(`http://news.example.test:${P}/a`, 2500);
  await go("about:blank", 800);
  // the upload is retried on every tick; wait until the server has both (a loaded machine is slow)
  for (let i = 0; i < 20; i++) {
    await tick();
    const d = (await intervals()).byDomain.map((x) => x.domain);
    if (d.includes("docs.example.test") && d.includes("news.example.test")) break;
    await sleep(3000);
  }
});
const s1 = one.steps ?? {};
check("launch 1 ran from the bundle (tauri://localhost) and finished", one.ok === true && one.href?.startsWith("tauri://localhost"), one.error ?? one.href);
check("packaged app: 'Not recording' until the notice is acknowledged; the (draft) notice is shown", s1.initial?.state === "Not recording" && /not acknowledged/.test(s1.initial?.reasons ?? "") && s1.initial?.notice === true);
check("packaged app → real Chrome extension: connected with the code from the app; the browser's domains appear in the app with categories", /docs\.example\.test — .*category: unclassified/.test(s1.recorded?.usage ?? "") && /news\.example\.test/.test(s1.recorded?.usage ?? "") && /Chrome \(packaged check\)/.test(s1.recorded?.links ?? ""), (s1.recorded?.usage ?? s1.atError?.usage ?? "").replace(/\n/g, " | "));
check("packaged app: 'Recording website domain names' indicator while collecting", s1.recorded?.state === "Recording website domain names", s1.recorded?.state);
check("packaged app: employee account shows no admin panel (the role comes from the server)", s1.recorded?.adminPanel === false && s1.recorded?.role === "");
const r1 = await intervals();
check("server: only domains (no paths or queries)", r1.byDomain.every((d) => /^[a-z0-9.-]+$/.test(d.domain)) && !JSON.stringify(r1).match(/private|path|search|Title|secret/));

// ---- Launch 2: restart, (sleep), API outage and recovery, disconnect from the app --------------------------
let sleepWindow = null;
const quitAt = Date.now();
await sleep(2000);
const two = await launch("second", async (line) => {
  if (line === "PHASE sleep-ready") {
    await go(`http://sleepy.example.test:${P}/`, 3000);
    console.log("  harness: putting the Mac to sleep now (pmset sleepnow). Wake it after about two minutes.");
    console.log("  harness: if the screen only goes dark and the Mac stays awake, choose Apple menu → Sleep within 8 minutes.");
    const before = Date.now();
    spawnSync("pmset", ["sleepnow"]);
    sleepWindow = { before };
  }
  if (line === "PHASE awake") {
    sleepWindow.after = Date.now();
    await sleep(2000);
    await go("about:blank", 1000);
    await tick();
  }
  if (line === "PHASE offline-ready") await stopApi();
  if (line === "PHASE offline-seen") await startApi();
  if (line === "PHASE disconnected") await tick();
});
const s2 = two.steps ?? {};
check("launch 2 (restart): signed in from the saved sign-in; same connection and records shown", two.ok === true && two.autoSignedIn === true && /docs\.example\.test/.test(s2.restored?.usage ?? "") && /Chrome \(packaged check\)/.test(s2.restored?.links ?? ""), two.error ?? `auto ${two.autoSignedIn}`);
check("packaged app: API unreachable → clear error; back → recovered", /Connect to the server/.test(s2.offline?.error ?? "") && s2.recovered?.error === "" && /docs\.example\.test/.test(s2.recovered?.usage ?? ""), s2.offline?.error);
check("packaged app: disconnect → the extension stops (not connected) on its next contact", /No browser connected/.test(s2.disconnected?.links ?? "") && (await js(pop, `document.querySelector('#status').textContent`)) === "Not connected. Nothing is recorded.");
if (SLEEP) {
  const r2 = await intervals();
  const sleepy = r2.rows.filter((x) => x.domain === "sleepy.example.test").reduce((n, x) => n + x.durationMs, 0);
  const slept = sleepWindow?.after ? sleepWindow.after - sleepWindow.before : 0;
  if (two.noSleep) check("real Mac sleep with a site in front", false, "the Mac did not sleep; nothing to measure");
  else check("real Mac sleep with a site in front: the time asleep is not counted (gap rule: at most 90 s)", slept > 30_000 && sleepy <= 3000 + 90_000 + 5000 && sleepy < slept, `asleep ${Math.round(slept / 1000)} s; sleepy.example.test recorded ${Math.round(sleepy / 1000)} s`);
} else console.log("SKIP  real Mac sleep (run with --sleep, attended)");
void quitAt;
await stopApi();
chrome.kill();
site.close();
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
