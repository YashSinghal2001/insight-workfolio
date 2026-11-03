// Native macOS verification of screenshot capture with the real app and real OS state (no simulation).
//
//   pnpm build && pnpm --filter @workfolio/desktop verify:screenshots [--skip=lock,sleep] [--keep]
//
// Starts a throwaway API (temporary database, LOCAL_DEV screenshot storage in a temporary
// directory), turns screenshots on (60 s interval, the policy minimum), drives the real debug
// app: clock in, wait for a capture and its confirmed upload, a break (no capture), a capture
// after the break, whole-image blur turned on by the admin (the next capture must be stored blurred),
// optional lock and sleep steps for a person at the Mac, clock out (no capture).
// The server's records and stored files are then checked. Images are never displayed or
// printed: only sizes, dimensions and times. Unless --keep, every test screenshot (server
// storage and the app's local copies from this run) is deleted at the end.
//
// The screenshots show whatever is on the main screen: close or hide anything sensitive first.
// Needs ports 4000 and 1420; replaces the app's saved dev sign-in in the Keychain.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const SKIP = (process.argv.find((a) => a.startsWith("--skip="))?.slice(7) ?? "").split(",").filter(Boolean);
const KEEP = process.argv.includes("--keep");
const INTERVAL = 60;
const API = "http://localhost:4000/api/v1";
const ORIGIN = "http://localhost:3000";
const tmp = mkdtempSync(join(tmpdir(), "wf-verify-shots-"));
const STORE = join(tmp, "storage");
const LOCAL = join(homedir(), "Library/Application Support/com.insightworkfolio.desktop/screenshots");
const started = Date.now();
const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const up = (url) => fetch(url).then((r) => r.ok, () => false);

const env = {
  ...process.env, NODE_ENV: "development", LOG_LEVEL: "warn", PORT: "4000",
  DATABASE_URL: `file:${join(tmp, "verify.db")}`, JWT_SECRET: randomBytes(32).toString("hex"),
  SCREENSHOT_STORAGE: "local", SCREENSHOT_LOCAL_DIR: STORE,
};

async function call(path, { method = "GET", body, cookie, raw = false } = {}) {
  const headers = { origin: ORIGIN };
  if (body) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${API}${path}`, { method, headers, body: body && JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  if (raw) return { bytes: new Uint8Array(await res.arrayBuffer()), res };
  const text = await res.text();
  return { body: text ? JSON.parse(text) : undefined, res };
}

/** Deletes this run's screenshots: the throwaway server storage and the app's local copies. */
function cleanup() {
  for (const c of children) c.kill();
  if (KEEP) return console.log(`Kept: ${tmp} and local files in ${LOCAL}`);
  rmSync(tmp, { recursive: true, force: true });
  if (existsSync(LOCAL)) {
    for (const f of readdirSync(LOCAL)) {
      // Only files this run created; the app treats a missing file of a STORED screenshot as already cleaned up.
      if (f.endsWith(".webp") && statSync(join(LOCAL, f)).mtimeMs >= started) rmSync(join(LOCAL, f));
    }
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

/** Dimensions from a WebP header (same parser idea as the API's integrity check). */
function webpSize(b) {
  const ascii = (o, s) => [...s].every((c, i) => b[o + i] === c.charCodeAt(0));
  if (b.length < 30 || !ascii(0, "RIFF") || !ascii(8, "WEBP")) return null;
  const le = (o, n) => [...b.subarray(o, o + n)].reduceRight((v, x) => v * 256 + x, 0);
  if (ascii(12, "VP8 ")) return { width: le(26, 2) & 0x3fff, height: le(28, 2) & 0x3fff };
  if (ascii(12, "VP8L")) return { width: (le(21, 4) & 0x3fff) + 1, height: ((le(21, 4) >>> 14) & 0x3fff) + 1 };
  if (ascii(12, "VP8X")) return { width: le(24, 3) + 1, height: le(27, 3) + 1 };
  return null;
}

/**
 * Mean absolute difference between neighbouring pixels (all channels): sharp text and edges score
 * high, a blurred image scores near 0. Decoded with macOS `sips` (WebP to BMP) into this run's temp dir;
 * nothing is displayed.
 */
function edgeEnergy(webp, name) {
  const src = join(tmp, `${name}.webp`);
  const bmp = join(tmp, `${name}.bmp`);
  writeFileSync(src, webp);
  execFileSync("sips", ["-s", "format", "bmp", src, "--out", bmp], { stdio: "ignore" });
  const b = readFileSync(bmp);
  rmSync(src);
  rmSync(bmp);
  const offset = b.readUInt32LE(10), w = b.readInt32LE(18), h = Math.abs(b.readInt32LE(22)), bpp = b.readUInt16LE(28) / 8;
  if (bpp !== 3 && bpp !== 4) throw new Error(`unexpected BMP format (${bpp * 8} bits)`);
  const stride = Math.ceil((w * bpp) / 4) * 4;
  const at = (x, y, c) => b[offset + y * stride + x * bpp + c];
  let sum = 0;
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) for (let c = 0; c < 3; c++) sum += Math.abs(at(x, y, c) - at(x + 1, y, c)) + Math.abs(at(x, y, c) - at(x, y + 1, c));
  return sum / ((w - 1) * (h - 1) * 3);
}

// ---- 1. Throwaway API, admin, employee, screenshots on ---------------------------------------
if (await up(`${API}/health`)) throw new Error("Port 4000 is in use; stop the running API first.");
children.push(spawn("node", [join(ROOT, "apps/api/dist/main.js")], { env, stdio: "inherit" }));
for (let i = 0; i < 40 && !(await up(`${API}/ready`)); i++) await sleep(250);
const cli = execFileSync("node", [join(ROOT, "apps/api/dist/cli/create-admin.js"), "--email", "admin@verify.local"], { env, encoding: "utf8" });
const adminPassword = randomBytes(12).toString("hex");
await call("/auth/setup-password", { method: "POST", body: { token: cli.match(/#token=(\S+)/)[1], password: adminPassword } });
const login = await call("/auth/login", { method: "POST", body: { email: "admin@verify.local", password: adminPassword } });
const cookie = login.res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const created = await call("/employees", { method: "POST", cookie, body: { email: "shots@verify.local", employeeCode: "SHOT-1", fullName: "Screenshot Verify", timezone: timeZone } });
const password = randomBytes(12).toString("hex");
await call("/auth/setup-password", { method: "POST", body: { token: created.body.setup.token, password } });
const employeeId = created.body.employee.id;
const policy = (await call("/settings/screenshots", { cookie })).body.effective;
const policyBody = { ...Object.fromEntries(Object.entries(policy).filter(([k]) => !["effectiveAt", "changedBy", "reason"].includes(k))), enabled: true, intervalSeconds: INTERVAL, blur: false, reason: "native verification" };
await call("/settings/screenshots", { method: "PUT", cookie, body: policyBody });
let blurOnAt = null;

// ---- 2. Desktop app --------------------------------------------------------------------------
if (!(await up("http://localhost:1420"))) {
  children.push(spawn("pnpm", ["--filter", "@workfolio/desktop", "dev:web"], { cwd: ROOT, stdio: "ignore" }));
  for (let i = 0; i < 60 && !(await up("http://localhost:1420")); i++) await sleep(500);
}
execFileSync("cargo", ["build", "--manifest-path", join(ROOT, "apps/desktop/src-tauri/Cargo.toml")], { stdio: "inherit" });
const script = join(tmp, "driver.js");
writeFileSync(script, `(${driver.toString()})(${JSON.stringify({ email: "shots@verify.local", password, intervalMs: INTERVAL * 1000, skip: SKIP })});`);
console.log("\nScreenshots of your MAIN screen will be taken about every minute for ~6 minutes. Hide anything sensitive.\nThey are deleted at the end (unless --keep) and never displayed.\n");
const app = spawn(join(ROOT, "apps/desktop/src-tauri/target/debug/insight-workfolio-desktop"), { env: { ...process.env, WF_E2E_SCRIPT: script }, stdio: ["ignore", "inherit", "pipe"] });
let result = null;
let buffered = "";
app.stderr.setEncoding("utf8").on("data", (chunk) => {
  const lines = (buffered + chunk).split("\n");
  buffered = lines.pop();
  for (const line of lines) {
    // Full app log (diagnostics only: lifecycle, sync and screenshot timings; never image data).
    appendFileSync(join(tmp, "app.log"), `${new Date().toISOString()} ${line}\n`);
    if (line.startsWith("[e2e] RESULT ")) result = JSON.parse(line.slice("[e2e] RESULT ".length));
    else if (line === "[e2e] TRIGGER blur-on") {
      // The admin turns whole-image blur on (the app is on a break, so no capture can race the change).
      blurOnAt = Date.now();
      call("/settings/screenshots", { method: "PUT", cookie, body: { ...policyBody, blur: true, reason: "native verification: blur" } }).then(
        () => console.log("[harness] blur turned on"),
        (err) => console.log(`[harness] blur change failed: ${err.message}`),
      );
    }
    else if (line.startsWith("[e2e] ") || line.startsWith("[screenshot]")) console.log(line);
  }
});
await new Promise((r) => app.on("exit", r));
if (!result) throw new Error(`The app exited without a result. App log: ${join(tmp, "app.log")} (kept with --keep)`);

// ---- 3. What the server stored ---------------------------------------------------------------
const items = (await call(`/screenshots?employeeId=${employeeId}&pageSize=200`, { cookie })).body.items.map((i) => ({ ...i, at: Date.parse(i.capturedAt) }));
// Admin downloads through the API (also exercises the controlled retrieval and its access log).
const downloaded = new Map();
for (const i of items) downloaded.set(i.id, await call(`/screenshots/${i.id}/content`, { cookie, raw: true }));
const s = result.steps;
const checks = [];
const must = (ok, message) => {
  if (!ok) throw new Error(message);
};
const check = (name, step, fn) => {
  if (!step?.done) return checks.push([name, "SKIPPED", step?.note ?? "not performed"]);
  try {
    checks.push([name, "PASS", fn(step)]);
  } catch (err) {
    checks.push([name, "FAIL", err.message]);
  }
};
const t = (ms) => new Date(ms).toLocaleTimeString();
const within = (a, b) => items.filter((i) => i.at > a && i.at < b);

check("OS permission", s.permission, (p) => `Screen Recording permission granted to the app (preflight): ${p.granted}`);
check("Capture after clock-in", s.first, (f) => {
  const shot = items.find((i) => Math.abs(i.at - f.atMs) < 5_000);
  must(shot, Number.isNaN(f.atMs) ? `no capture within one interval; app showed: ${f.appState}` : `no stored screenshot near ${t(f.atMs)}`);
  must(f.atMs - s.clockIn.at >= INTERVAL * 1000 - 2_000, "taken before one interval had passed");
  return `${t(f.atMs)}: ${shot.width}x${shot.height}, ${Math.round(shot.fileSizeBytes / 1024)} KB, capture ${f.captureMs} ms + encode ${f.encodeMs} ms`;
});
check("Upload confirmed by storage", s.first, (f) => {
  must(f.cloudConfirmed, "the app never showed a confirmed upload");
  must(items.every((i) => i.uploadStatus === "STORED"), `not stored: ${items.filter((i) => i.uploadStatus !== "STORED").length}`);
  return `app showed "${f.cloudConfirmed}"; all ${items.length} STORED on the server`;
});
check("No capture during break", s.break, (b) => {
  const during = within(b.start, b.end);
  must(!during.length, `${during.length} screenshot(s) during the break`);
  return `break ${t(b.start)}-${t(b.end)} (${Math.round((b.end - b.start) / 1000)} s > interval): none`;
});
check("Capture resumes after break", s.second, (f) => {
  must(items.some((i) => Math.abs(i.at - f.atMs) < 5_000), Number.isNaN(f.atMs) ? "no capture after the break" : `no stored screenshot near ${t(f.atMs)}`);
  return `${t(f.atMs)}`;
});
check("Blur on: next capture stored blurred", s.blur, (b) => {
  must(blurOnAt, "the harness never turned blur on");
  const before = items.filter((i) => i.at < blurOnAt);
  const after = items.filter((i) => i.at > blurOnAt);
  must(before.length && before.every((i) => i.blurred === false), `before blur: ${before.map((i) => i.blurred).join(",") || "no captures"}`);
  const shot = after.find((i) => Math.abs(i.at - b.atMs) < 5_000);
  must(shot, Number.isNaN(b.atMs) ? `no capture after blur was turned on; app showed: ${b.appState}` : `no stored screenshot near ${t(b.atMs)}`);
  // Registration with blurred: true was accepted (a mismatch is rejected and never stored) and every later capture is blurred too.
  must(after.every((i) => i.blurred === true && i.uploadStatus === "STORED"), `after blur: ${after.map((i) => `${i.blurred}/${i.uploadStatus}`).join(", ")}`);
  const sharp = before.map((i) => edgeEnergy(downloaded.get(i.id).bytes, `sharp-${i.id}`)).sort((x, y) => x - y);
  const soft = edgeEnergy(downloaded.get(shot.id).bytes, `blurred-${shot.id}`);
  const median = sharp[Math.floor(sharp.length / 2)];
  // Real screens differ between captures, so: far below the sharp captures of this run, or flat in absolute terms.
  must(soft < 0.25 * median || soft < 0.5, `edge energy ${soft.toFixed(2)} vs sharp ${median.toFixed(2)}: does not look blurred`);
  return `${t(shot.at)}: registered blurred, STORED; edge energy ${soft.toFixed(2)} vs ${median.toFixed(2)} for the sharp captures (${after.length} blurred capture(s) after the change)`;
});
check("No capture while locked", s.lock, (l) => {
  const during = within(l.lockedAt + 2_000, l.unlockedAt - 2_000);
  must(!during.length, `${during.length} screenshot(s) while locked`);
  return `locked ${t(l.lockedAt)}-${t(l.unlockedAt)}: none; app said "${l.skipped ?? "no capture was due"}"`;
});
check("No capture across sleep", s.sleep, (g) => {
  const during = within(g.gapStart + 1_000, g.gapEnd + INTERVAL * 1000 - 2_000);
  must(!during.length, `${during.length} screenshot(s) during sleep or right at wake`);
  return `asleep ${t(g.gapStart)}-${t(g.gapEnd)}: none, next interval restarted at wake`;
});
check("No capture after clock-out", s.clockOut, (c) => {
  const after = items.filter((i) => i.at > c.at);
  must(!after.length, `${after.length} after clock-out`);
  return `waited ${Math.round(c.waitedMs / 1000)} s after clock-out: none`;
});
check("Stored files intact", s.first, () => {
  const lines = [];
  for (const i of items) {
    const { bytes, res } = downloaded.get(i.id);
    const dims = webpSize(bytes);
    must(/^no-store/.test(res.headers.get("cache-control") ?? ""), "content is cacheable");
    must(dims && dims.width === i.width && dims.height === i.height, `${i.id}: header ${JSON.stringify(dims)} vs ${i.width}x${i.height}`);
    must(bytes.length === i.fileSizeBytes, `${i.id}: ${bytes.length} bytes vs ${i.fileSizeBytes}`);
    must(Math.max(i.width, i.height) <= 1920, "larger than the max resolution");
    lines.push(`${i.width}x${i.height}`);
  }
  return `${items.length} file(s): WebP header, size and dimensions match the metadata (${[...new Set(lines)].join(", ")})`;
});
check("Local queue drained", s.clockOut, () => {
  must(result.local.pending === "0", `${result.local.pending} still waiting`);
  must(result.local.problems === 0, `${result.local.problems} failed or rejected`);
  return `waiting 0, problems 0; local storage ${result.local.storage}`;
});

console.log(`\nNative screenshot verification (interval ${INTERVAL} s; dev-only storage)\n`);
for (const [name, status, detail] of checks) console.log(`${status.padEnd(8)} ${name.padEnd(30)} ${detail}`);
process.exit(checks.some(([, x]) => x === "FAIL") ? 1 : 0);

// ---- In-app driver (runs inside the desktop webview) -----------------------------------------
function driver(cfg) {
  if (window.__wfVerify) return;
  window.__wfVerify = true;
  const inv = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const log = (line) => inv("e2e_log", { line });
  const $ = (s) => document.querySelector(s);
  const txt = (s) => ($(s)?.textContent ?? "").trim();
  const act = (a) => $(`[data-action="${a}"]`);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const steps = {};
  let skip = false;
  let current = "";

  const banner = document.createElement("div");
  banner.style.cssText = "position:fixed;inset:0 0 auto 0;z-index:9999;padding:14px 16px;background:#1e3a8a;color:#fff;font:15px/1.4 system-ui;box-shadow:0 2px 8px #0006";
  banner.innerHTML = '<strong>Screenshot verification</strong> <span id="v-step"></span><div id="v-text" style="margin-top:6px;font-size:17px"></div><div id="v-status" style="margin-top:6px;opacity:.8;font-size:13px"></div><button id="v-skip" style="margin-top:8px">Skip this step</button>';
  document.body.append(banner);
  document.body.style.paddingTop = "150px";
  $("#v-skip").onclick = () => (skip = true);
  const say = (step, text) => (($("#v-step").textContent = step), ($("#v-text").textContent = text), log(`${step}: ${text}`));

  let beat = 0;
  async function until(done, timeoutMs) {
    const end = Date.now() + timeoutMs;
    skip = cfg.skip.includes(current);
    while (Date.now() < end && !skip) {
      const s = await inv("screenshot_status", {});
      const a = await inv("activity_status", {});
      if (Date.now() - beat > 15_000) {
        beat = Date.now();
        log(`state mode=${s.mode} capturing=${s.capturing} permission=${s.permission} next=${s.nextCaptureMs ? new Date(s.nextCaptureMs).toISOString() : null} skipped=${s.skipped} error=${s.error} ui="${txt("#shot-state")}: ${txt("#shot-reason")}" hidden=${document.hidden}`);
      }
      $("#v-status").textContent = `Screenshots ${txt("#shot-state")} · next ${txt("#shot-next")} · last local ${txt("#shot-last-local")} · cloud ${txt("#shot-last-cloud")} · locked ${a.locked}`;
      const r = await done(s, a);
      if (r) return r;
      await wait(500);
    }
    return null;
  }
  const newCapture = (after) => until((s) => s.lastCapture && s.lastCapture.atMs > after && s.lastCapture, cfg.intervalMs + 45_000);

  async function run() {
    while ($("#screenshots").hidden || txt("#att-state") !== "Clocked out" || !/^You acknowledged/.test(txt("#shot-ack")) || !$("#monitoring-consent").hidden) {
      if (!$("#login-view").hidden) {
        $("#login-form").email.value = cfg.email;
        $("#login-form").password.value = cfg.password;
        $("#login-form").requestSubmit();
        await wait(3000);
      }
      if (!$("#device-register").hidden) {
        $("#device-form").requestSubmit();
        await wait(2000);
      }
      if (!$("#monitoring-consent").hidden) $("#consent-accept").click();
      if ($("#screenshot-consent") && !$("#screenshot-consent").hidden) $("#shot-consent-accept").click();
      await wait(1500);
    }
    current = "permission";
    say("1/8", "Checking the Screen Recording permission. If it is not allowed, click \"Allow screen recording…\" below and follow macOS.");
    const perm = await until((s) => s.permission && { granted: true }, 120_000);
    steps.permission = perm ? { done: true, ...perm } : { done: false, note: `not granted; app showed "${txt("#shot-state")}: ${txt("#shot-reason")}" and took no screenshots` };
    if (!perm) return finish();

    act("CLOCK_IN").click();
    steps.clockIn = { at: Date.now() };
    say("2/8", `Clocked in. Waiting for the first screenshot (one interval, ${cfg.intervalMs / 1000} s) and its confirmed upload.`);
    const first = await newCapture(steps.clockIn.at);
    const cloud = first && (await until(() => txt("#shot-pending") === "0" && txt("#shot-last-cloud") !== "Never" && txt("#shot-last-cloud"), 150_000));
    // Permission is granted here, so a missing capture is a failure (checked on the server side), not a skip.
    steps.first = { done: true, ...(first ?? { atMs: NaN, appState: `${txt("#shot-state")} ${txt("#shot-warning")} ${txt("#shot-error")}` }), cloudConfirmed: cloud };

    say("3/8", "Break for 75 seconds (automatic): no screenshot may be taken.");
    act("BREAK_START").click();
    const b0 = Date.now();
    await wait(1000);
    const stateOnBreak = txt("#shot-state");
    await wait(cfg.intervalMs + 14_000);
    act("BREAK_END").click();
    steps.break = { done: true, start: b0, end: Date.now(), stateOnBreak };
    say("4/8", "Break ended. Waiting for the next screenshot.");
    const second = await newCapture(steps.break.end);
    steps.second = { done: true, ...(second ?? { atMs: NaN }) };

    // Blur: turned on by the admin while on a break, so no capture can be taken under the old setting.
    say("5/8", "Turning on whole-image blur (automatic, short break while the app picks it up). The next screenshot must be blurred.");
    act("BREAK_START").click();
    await wait(1000);
    log("TRIGGER blur-on");
    const blurred = await until(() => txt("#shot-policy").includes("the whole image is blurred"), 120_000);
    act("BREAK_END").click();
    const blurEnd = Date.now();
    const blurShot = blurred && (await newCapture(blurEnd));
    steps.blur = blurred
      ? { done: true, ...(blurShot ?? { atMs: NaN, appState: `${txt("#shot-state")} ${txt("#shot-warning")} ${txt("#shot-error")}` }) }
      : { done: false, note: "the app did not pick up the blur policy within 2 minutes" };

    current = "lock";
    say("6/8", "Lock the screen now (Control-Command-Q) and stay locked for about 80 seconds, then unlock.");
    const locked = await until((_, a) => a.locked && { lockedAt: Date.now() }, 120_000);
    let skipped = null;
    const unlocked = locked && (await until((s, a) => ((skipped = s.skipped ?? skipped), !a.locked && { unlockedAt: Date.now() }), 600_000));
    steps.lock = unlocked ? { done: true, ...locked, ...unlocked, skipped } : { done: false, note: skip ? "skipped" : "screen lock not detected" };

    current = "sleep";
    say("7/8", "Put the Mac to sleep for at least 60 seconds, then wake and unlock it.");
    const s0 = Date.now();
    const gap = await until((s, a) => s.lastGapMs && s.lastGapMs[1] > s0 && s.lastGapMs[1] - s.lastGapMs[0] >= 30_000 && !a.locked && { gapStart: s.lastGapMs[0], gapEnd: s.lastGapMs[1] }, 600_000);
    steps.sleep = gap ? { done: true, ...gap } : { done: false, note: skip ? "skipped" : "no sleep detected" };
    if (gap) await wait(cfg.intervalMs + 5_000); // the check covers one interval after wake

    say("8/8", "Clocking out (automatic), then waiting one interval to confirm nothing more is captured.");
    act("CLOCK_OUT").click();
    const c0 = Date.now();
    await wait(cfg.intervalMs + 15_000);
    for (let i = 0; i < 120 && txt("#shot-pending") !== "0"; i++) await wait(1000);
    steps.clockOut = { done: true, at: c0, waitedMs: Date.now() - c0, stateAfter: txt("#shot-state") };
    finish();
  }
  async function finish() {
    const problems = $("#shot-problems").hidden ? 0 : Number(txt("#shot-problems-text").match(/^\d+/)?.[0] ?? 1);
    say("Done", "Checking what the server stored…");
    log(`RESULT ${JSON.stringify({ steps, local: { pending: txt("#shot-pending"), problems, storage: txt("#shot-storage") } })}`);
    await wait(500);
    inv("e2e_exit", { code: 0 });
  }
  void run().catch((err) => {
    log(`ERROR ${err?.message ?? err}`);
    inv("e2e_exit", { code: 1 });
  });
}
