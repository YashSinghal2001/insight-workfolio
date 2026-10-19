// Native macOS verification of activity monitoring with real OS events (no simulation).
//
//   pnpm --filter @workfolio/api build && pnpm --filter @workfolio/desktop verify:native
//
// Starts a throwaway API (temporary database, dev-only short thresholds), drives the real debug
// desktop app, and asks the person at the Mac to switch apps, stay idle, lock the screen and put
// the Mac to sleep. Each step is detected from the native collector; afterwards the activity the
// server recorded is checked. Steps that are skipped or time out are reported as SKIPPED, never PASS.
//
// Needs ports 4000 (API) and 1420 (Vite; reused if already running) and the dev Keychain: the
// app's saved sign-in and installation ID are replaced by a throwaway test employee's.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const arg = (name, fallback) => Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
const SAMPLE = arg("sample", 5); // dev-only: production defaults are 15 s / 300 s
const IDLE = arg("idle", 30);
// e.g. --skip=lock,sleep for an unattended run; skipped steps are reported as SKIPPED.
const SKIP = (process.argv.find((a) => a.startsWith("--skip="))?.slice(7) ?? "").split(",").filter(Boolean);
const API = "http://localhost:4000/api/v1";
const ORIGIN = "http://localhost:3000";
const tmp = mkdtempSync(join(tmpdir(), "wf-verify-"));
const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const up = (url) => fetch(url).then((r) => r.ok, () => false);

const env = {
  ...process.env, NODE_ENV: "development", LOG_LEVEL: "warn", PORT: "4000",
  DATABASE_URL: `file:${join(tmp, "verify.db")}`, JWT_SECRET: randomBytes(32).toString("hex"),
  ACTIVITY_SAMPLE_SECONDS: String(SAMPLE), IDLE_THRESHOLD_SECONDS: String(IDLE),
};

async function call(path, { method = "GET", body, cookie, bearer } = {}) {
  const headers = { origin: ORIGIN };
  if (body) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${API}${path}`, { method, headers, body: body && JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return { body: text ? JSON.parse(text) : undefined, res };
}

function cleanup() {
  for (const c of children) c.kill();
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

// ---- 1. Throwaway API, admin and employee ------------------------------------------------
if (await up(`${API}/health`)) throw new Error("Port 4000 is in use; stop the running API first.");
children.push(spawn("node", [join(ROOT, "apps/api/dist/main.js")], { env, stdio: "inherit" }));
for (let i = 0; i < 40 && !(await up(`${API}/ready`)); i++) await sleep(250);
const cli = execFileSync("node", [join(ROOT, "apps/api/dist/cli/create-admin.js"), "--email", "admin@verify.local"], { env, encoding: "utf8" });
const adminPassword = randomBytes(12).toString("hex");
await call("/auth/setup-password", { method: "POST", body: { token: cli.match(/#token=(\S+)/)[1], password: adminPassword } });
const login = await call("/auth/login", { method: "POST", body: { email: "admin@verify.local", password: adminPassword } });
const cookie = login.res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const created = await call("/employees", { method: "POST", cookie, body: { email: "native@verify.local", employeeCode: "NAT-1", fullName: "Native Verify", timezone: timeZone } });
const password = randomBytes(12).toString("hex");
await call("/auth/setup-password", { method: "POST", body: { token: created.body.setup.token, password } });
const employeeId = created.body.employee.id;

// ---- 2. Desktop app ------------------------------------------------------------------------
if (!(await up("http://localhost:1420"))) {
  children.push(spawn("pnpm", ["--filter", "@workfolio/desktop", "dev:web"], { cwd: ROOT, stdio: "ignore" }));
  for (let i = 0; i < 60 && !(await up("http://localhost:1420")); i++) await sleep(500);
}
execFileSync("cargo", ["build", "--manifest-path", join(ROOT, "apps/desktop/src-tauri/Cargo.toml")], { stdio: "inherit" });

const script = join(tmp, "driver.js");
writeFileSync(script, `(${driver.toString()})(${JSON.stringify({ email: "native@verify.local", password, sampleMs: SAMPLE * 1000, idleMs: IDLE * 1000, skip: SKIP })});`);
console.log(`\nThe app opens with instructions at the top of its window. Follow them; press "Skip" for anything you cannot do.\n`);
const app = spawn(join(ROOT, "apps/desktop/src-tauri/target/debug/insight-workfolio-desktop"), { env: { ...process.env, WF_E2E_SCRIPT: script }, stdio: ["ignore", "inherit", "pipe"] });
let result = null;
let buffered = "";
app.stderr.setEncoding("utf8").on("data", (chunk) => {
  const lines = (buffered + chunk).split("\n");
  buffered = lines.pop();
  for (const line of lines) {
    if (line.startsWith("[e2e] RESULT ")) result = JSON.parse(line.slice("[e2e] RESULT ".length));
    else if (line.startsWith("[e2e] ")) console.log(line);
  }
});
await new Promise((r) => app.on("exit", r));
if (!result) throw new Error("The app exited without a result.");

// ---- 3. What the server recorded -------------------------------------------------------------
const today = new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
const items = [];
for (let page = 1; ; page++) {
  const t = (await call(`/activity/timeline?employeeId=${employeeId}&from=${today}&to=${today}&page=${page}&pageSize=200`, { cookie })).body;
  items.push(...t.items.map((i) => ({ ...i, s: Date.parse(i.startedAt), e: Date.parse(i.endedAt) })));
  if (page * 200 >= t.total) break;
}
const tol = SAMPLE * 1000 + 2_000;
const overlapping = (a, b, kind) => items.filter((i) => (!kind || i.kind === kind) && i.s < b && i.e > a);
const r = result.steps;
const checks = [];
const check = (name, step, fn) => {
  if (!step?.done) return checks.push([name, "SKIPPED", step?.note ?? "not performed"]);
  try {
    const detail = fn(step);
    checks.push([name, "PASS", detail]);
  } catch (err) {
    checks.push([name, "FAIL", err.message]);
  }
};
const must = (ok, message) => {
  if (!ok) throw new Error(message);
};
const t = (ms) => new Date(ms).toLocaleTimeString();

check("App switching", r.apps, (s) => {
  const names = [...new Set(overlapping(s.start, s.end, "ACTIVE").map((i) => i.applicationName))];
  must(names.length >= 2, `only ${names.join(", ") || "nothing"} recorded`);
  return `recorded: ${names.join(", ")}`;
});
check("Idle after threshold", r.idle, (s) => {
  const expectedStart = s.detectedAt - IDLE * 1000;
  must(Math.abs(s.idleSince - expectedStart) <= tol, `idle attributed from ${t(s.idleSince)}, expected about ${t(expectedStart)}`);
  const idle = overlapping(s.idleSince + tol, s.until - tol, "IDLE");
  must(idle.length > 0, "no idle interval recorded");
  const active = overlapping(s.idleSince + tol, s.until - tol, "ACTIVE");
  must(!active.length, `active time recorded while idle: ${active.map((i) => `${t(i.s)}-${t(i.e)} ${i.applicationName}`).join("; ")}`);
  const idleMs = idle.reduce((n, i) => n + Math.min(i.e, s.until) - Math.max(i.s, s.idleSince), 0);
  return `idle ${t(s.idleSince)}-${t(s.until)}: ${Math.round(idleMs / 1000)} s recorded as idle of ${Math.round((s.until - s.idleSince) / 1000)} s`;
});
check("Activity resumes after input", r.resume, (s) => {
  const next = items.find((i) => i.kind === "ACTIVE" && i.s >= s.resumedAt - tol && i.s <= s.resumedAt + tol);
  must(next, `no active interval starting near ${t(s.resumedAt)}`);
  return `${next.applicationName} from ${t(next.s)}`;
});
check("Screen lock", r.lock, (s) => {
  const active = overlapping(s.lockedAt + tol, s.unlockedAt - tol, "ACTIVE");
  must(!active.length, `active time recorded while locked: ${active.map((i) => i.applicationName).join(", ")}`);
  must(overlapping(s.lockedAt + tol, s.unlockedAt - tol, "IDLE").length > 0 || s.unlockedAt - s.lockedAt < 2 * tol, "lock not recorded as idle");
  return `locked ${t(s.lockedAt)}-${t(s.unlockedAt)}: counted as idle, no active time`;
});
check("Sleep/wake", r.sleep, (s) => {
  const any = overlapping(s.gapStart + 1_000, s.gapEnd - 1_000);
  must(!any.length, `${any.length} interval(s) recorded across the sleep`);
  return `asleep ${t(s.gapStart)}-${t(s.gapEnd)} (${Math.round((s.gapEnd - s.gapStart) / 1000)} s): nothing recorded`;
});
check("Break pauses monitoring", r.break, (s) => {
  const any = overlapping(s.start + 1_000, s.end - 1_000);
  must(!any.length, `${any.length} interval(s) recorded during the break`);
  return `break ${t(s.start)}-${t(s.end)}: nothing recorded`;
});
check("Clock-out stops monitoring", r.clockOut, (s) => {
  const after = items.filter((i) => i.e > s.at + 1_000);
  must(!after.length, `${after.length} interval(s) after clock-out`);
  must(result.pending === 0 && result.rejected === 0, `${result.pending} not uploaded, ${result.rejected} rejected`);
  return "nothing after clock-out; everything uploaded, nothing rejected";
});
const sorted = [...items].sort((a, b) => a.s - b.s);
const overlaps = sorted.filter((i, k) => k > 0 && i.s < sorted[k - 1].e).length;
checks.push(["No overlapping intervals", overlaps ? "FAIL" : "PASS", `${items.length} intervals`]);

console.log(`\nNative verification (sampling ${SAMPLE} s, idle threshold ${IDLE} s; dev-only values)\n`);
for (const [name, status, detail] of checks) console.log(`${status.padEnd(8)} ${name.padEnd(30)} ${detail}`);
process.exit(checks.some(([, s]) => s === "FAIL") ? 1 : 0); // also stops the API and Vite started above

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

  const banner = document.createElement("div");
  banner.style.cssText = "position:fixed;inset:0 0 auto 0;z-index:9999;padding:14px 16px;background:#1e3a8a;color:#fff;font:15px/1.4 system-ui;box-shadow:0 2px 8px #0006";
  banner.innerHTML = '<strong>Native verification</strong> <span id="v-step"></span><div id="v-text" style="margin-top:6px;font-size:17px"></div><div id="v-status" style="margin-top:6px;opacity:.8;font-size:13px"></div><button id="v-skip" style="margin-top:8px">Skip this step</button>';
  document.body.append(banner);
  document.body.style.paddingTop = "150px";
  $("#v-skip").onclick = () => (skip = true);
  const say = (step, text) => (($("#v-step").textContent = step), ($("#v-text").textContent = text), log(`${step}: ${text}`));

  /** Polls the native collector until `done(status)` is true, the step is skipped, or it times out. */
  let current = "";
  async function until(done, timeoutMs) {
    const end = Date.now() + timeoutMs;
    skip = cfg.skip.includes(current);
    while (Date.now() < end && !skip) {
      const s = await inv("activity_status", {});
      $("#v-status").textContent = `Monitoring ${txt("#mon-state")} · app: ${s.currentApp?.name ?? "—"} · idle: ${s.idle} · locked: ${s.locked}`;
      const r = done(s);
      if (r) return r;
      await wait(500);
    }
    return null;
  }

  async function run() {
    // Sign in, register, acknowledge the notice, clock in.
    while (!$("#monitoring") || $("#monitoring").hidden || txt("#att-state") !== "Clocked out") {
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
      if (!$("#monitoring-consent").hidden) {
        $("#consent-accept").click();
        await wait(2000);
      }
      await wait(500);
    }
    act("CLOCK_IN").click();
    await wait(2000);
    log(`clocked in; monitoring ${txt("#mon-state")}`);

    current = "apps";
    say("1/6", "Switch between at least two other applications for about 20 seconds (click their windows, or use Command-Tab).");
    const apps = new Set();
    const a0 = Date.now();
    const appsOk = await until((s) => {
      if (s.currentApp && !/insight-workfolio/i.test(s.currentApp.name)) apps.add(s.currentApp.name);
      return apps.size >= 2 && Date.now() - a0 > 20_000;
    }, 90_000);
    steps.apps = appsOk ? { done: true, start: a0, end: Date.now() } : { done: false, note: skip ? "skipped" : "fewer than two other apps used" };

    current = "idle";
    say("2/6", `Now don't touch the keyboard, mouse or trackpad for about ${Math.round(cfg.idleMs / 1000) + 15} seconds. You will be told when to move.`);
    const idle = await until((s) => s.idle && { detectedAt: Date.now(), idleSince: s.idleSinceMs }, cfg.idleMs + 120_000);
    if (idle) {
      await wait(10_000);
      say("2/6", "Idle detected. Now move the mouse or press a key.");
      // Detected within one sample of the input; the recorded activity starts at the input itself.
      const resumed = await until((s) => !s.idle && { resumedAt: Date.now() }, 120_000);
      steps.idle = { done: true, ...idle, until: resumed?.resumedAt ?? Date.now() };
      steps.resume = resumed ? { done: true, ...resumed } : { done: false, note: "input did not resume within 2 minutes" };
      if (resumed) {
        say("2/6", "Thanks. Keep using the computer normally for 15 seconds.");
        await wait(15_000);
      }
    } else steps.idle = steps.resume = { done: false, note: skip ? "skipped" : "idle threshold never reached (the computer was in use)" };

    current = "lock";
    say("3/6", "Lock the screen now (Control-Command-Q, or Apple menu > Lock Screen). Wait about 20 seconds, then unlock.");
    const locked = await until((s) => s.locked && { lockedAt: Date.now() }, 120_000);
    const unlocked = locked && (await until((s) => !s.locked && { unlockedAt: Date.now() }, 300_000));
    steps.lock = unlocked ? { done: true, ...locked, ...unlocked } : { done: false, note: skip ? "skipped" : "screen lock not detected" };

    current = "sleep";
    say("4/6", "Put the Mac to sleep (Apple menu > Sleep, or close the lid). Wait at least 60 seconds, then wake it and unlock.");
    const s0 = Date.now();
    const gap = await until((s) => s.lastGapMs && s.lastGapMs[1] > s0 && s.lastGapMs[1] - s.lastGapMs[0] >= 30_000 && !s.locked && { gapStart: s.lastGapMs[0], gapEnd: s.lastGapMs[1] }, 600_000);
    steps.sleep = gap ? { done: true, ...gap } : { done: false, note: skip ? "skipped" : "no sleep gap detected" };

    say("5/6", "Taking a 20 second break (automatic). You can keep working normally.");
    act("BREAK_START").click();
    const b0 = Date.now();
    await wait(20_000);
    act("BREAK_END").click();
    steps.break = { done: true, start: b0, end: Date.now() };

    say("6/6", "Clocking out in 15 seconds (automatic), then uploading.");
    await wait(15_000);
    act("CLOCK_OUT").click();
    steps.clockOut = { done: true, at: Date.now() };
    for (let i = 0; i < 90 && (txt("#mon-pending") !== "0" || txt("#sync-pending") !== "0"); i++) await wait(1000);
    const rejected = $("#mon-rejected").hidden ? 0 : Number(txt("#mon-rejected-text").match(/^\d+/)?.[0] ?? 1);
    say("Done", "Checking what the server recorded…");
    log(`RESULT ${JSON.stringify({ steps, pending: Number(txt("#mon-pending")), rejected })}`);
    await wait(500);
    inv("e2e_exit", { code: 0 });
  }
  void run().catch((err) => {
    log(`ERROR ${err?.message ?? err}`);
    inv("e2e_exit", { code: 1 });
  });
}
