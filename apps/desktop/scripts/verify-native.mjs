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
import { execFile, execFileSync, spawn } from "node:child_process";
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
// --only=autoswitch: just the automatic foreground switch while idle. With the operator's hands off,
// the harness asks macOS to open --app (default Calculator) with `open -a`: a normal app activation,
// no keyboard or mouse events. The system idle counter shows whether anyone touched the Mac.
// --only=userswitch: fast user switching (needs a second macOS account): switch to it, then back.
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.slice(7) ?? "";
const SWITCH_APP = process.argv.find((a) => a.startsWith("--app="))?.slice(6) ?? "Calculator";
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
writeFileSync(script, `(${driver.toString()})(${JSON.stringify({ email: "native@verify.local", password, sampleMs: SAMPLE * 1000, idleMs: IDLE * 1000, skip: SKIP, only: ONLY })});`);
console.log(`\nThe app opens with instructions at the top of its window. Follow them; press "Skip" for anything you cannot do.\n`);
const app = spawn(join(ROOT, "apps/desktop/src-tauri/target/debug/insight-workfolio-desktop"), { env: { ...process.env, WF_E2E_SCRIPT: script }, stdio: ["ignore", "inherit", "pipe"] });
let result = null;
let buffered = "";
app.stderr.setEncoding("utf8").on("data", (chunk) => {
  const lines = (buffered + chunk).split("\n");
  buffered = lines.pop();
  for (const line of lines) {
    if (line.startsWith("[e2e] RESULT ")) result = JSON.parse(line.slice("[e2e] RESULT ".length));
    else if (line === "[e2e] TRIGGER autoswitch") {
      console.log(`[harness] open -a ${SWITCH_APP} (no input events)`);
      execFile("open", ["-a", SWITCH_APP], (err) => err && console.log(`[harness] open failed: ${err.message}`));
    }
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
  if (ONLY && !step) return; // not part of this run
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
/** The last interval that started before `at`. */
const lastBefore = (at) => items.filter((i) => i.s < at).sort((a, b) => b.e - a.e)[0];
/**
 * An unobserved stretch (locked screen, other user's session): neither ACTIVE nor IDLE inside it, and
 * the interval before it ends at the transition. `from` is when the harness saw it (polled every
 * 0.5 s, the collector picks the event up within 0.25 s), so the real transition is at most ~1 s earlier.
 */
const unobserved = (what, from, to) => {
  const any = overlapping(from + 1_000, to - tol);
  must(!any.length, `recorded while ${what}: ${any.map((i) => `${t(i.s)}-${t(i.e)} ${i.kind} ${i.applicationName ?? ""}`).join("; ")}`);
  const last = lastBefore(from);
  must(last, `nothing recorded before ${what}`);
  must(last.e <= from + 1_000 && last.e >= from - tol, `last interval before ${what} ends at ${t(last.e)}, expected at ${t(from)}`);
  return last;
};
check("Screen lock", r.lock, (s) => {
  const last = unobserved("locked", s.lockedAt, s.unlockedAt);
  return `locked ${t(s.lockedAt)}-${t(s.unlockedAt)}: unobserved (no active or idle time); ${last.kind} ended at ${t(last.e)}`;
});
check("Sleep/wake", r.sleep, (s) => {
  const any = overlapping(s.gapStart + 1_000, s.gapEnd - 1_000);
  must(!any.length, `${any.length} interval(s) recorded across the sleep`);
  const last = lastBefore(s.gapStart + 1_000);
  must(last && Math.abs(last.e - s.gapStart) <= SAMPLE * 1000, `last interval before the sleep ends at ${last ? t(last.e) : "never"}, more than one sample from ${t(s.gapStart)}`);
  return `asleep ${t(s.gapStart)}-${t(s.gapEnd)} (${Math.round((s.gapEnd - s.gapStart) / 1000)} s): nothing recorded; last interval ended at ${t(last.e)}`;
});
check("Break pauses monitoring", r.break, (s) => {
  const any = overlapping(s.start + 1_000, s.end - 1_000);
  must(!any.length, `${any.length} interval(s) recorded during the break`);
  must(s.appNapBefore === true, `App Nap opt-out not in force while monitoring before the break (${s.appNapBefore})`);
  must(s.appNapDuring === false, `App Nap opt-out still held during the break (${s.appNapDuring})`);
  return `break ${t(s.start)}-${t(s.end)}: nothing recorded; App Nap opt-out held before, released during`;
});
check("Fast user switching", r.userswitch, (s) => {
  const last = unobserved("another user's session was in front", s.awayAt, s.backAt);
  return `away ${t(s.awayAt)}-${t(s.backAt)}: unobserved; ${last.kind} ended at ${t(last.e)}`;
});
check("Clock-out stops monitoring", r.clockOut, (s) => {
  const after = items.filter((i) => i.e > s.at + 1_000);
  must(!after.length, `${after.length} interval(s) after clock-out`);
  must(result.pending === 0 && result.rejected === 0, `${result.pending} not uploaded, ${result.rejected} rejected`);
  return "nothing after clock-out; everything uploaded, nothing rejected";
});
if (r.autoswitch) {
  const s = r.autoswitch;
  const name = "Automatic switch while idle";
  const window = items.filter((i) => i.e > s.readyAt - 30_000 && i.s < (s.resumedAt ?? Date.now()) + 30_000).sort((a, b) => a.s - b.s);
  console.log(`\nRecorded timeline around the test (server):`);
  for (const i of window) console.log(`  ${t(i.s)}–${t(i.e)}  ${i.kind.padEnd(6)} ${i.applicationName ?? ""}`);
  const at = (ms) => (ms ? t(ms) : "never");
  console.log(`  harness: monitoring from ${at(s.monitoringFrom)}, hands off from ${at(s.lastInput)}, ${s.switchApp ?? SWITCH_APP} in front at ${at(s.switchAt)}${s.switchAt ? ` (idle counter then ${Math.round(s.idleAtSwitch / 1000)} s)` : ""}, idle from ${at(s.idleSince)}, input again ${at(s.resumedAt)}`);
  if (!s.done) checks.push([name, "INCONCLUSIVE", s.note]);
  // The last input must follow monitoring start (also false when either is missing): otherwise the
  // collector could not have seen it and the checks below would test the harness, not the collector.
  else if (!(s.lastInput >= s.monitoringFrom + 1_000)) checks.push([name, "INCONCLUSIVE", `last input ${at(s.lastInput)} is not after monitoring start ${at(s.monitoringFrom)}`]);
  else {
    try {
      // Before the fix idle could only reach back to the switch (about switchAt); now to the last input.
      must(Math.abs(s.idleSince - s.lastInput) <= 1_500, `collector idle from ${t(s.idleSince)}, last input was ${t(s.lastInput)}`);
      const idle = window.find((i) => i.kind === "IDLE" && Math.abs(i.s - s.lastInput) <= 2_000);
      must(idle, `no IDLE interval starting at the last input (${t(s.lastInput)})`);
      must(idle.e >= s.resumedAt - tol, `IDLE interval ends at ${t(idle.e)}, before input resumed at ${t(s.resumedAt)}`);
      const active = overlapping(s.lastInput + 1_000, s.resumedAt - tol, "ACTIVE");
      must(!active.length, `active time while hands-off: ${active.map((i) => `${t(i.s)}-${t(i.e)} ${i.applicationName}`).join("; ")}`);
      must(!window.some((i) => i.applicationName === s.switchApp && i.s < s.resumedAt - tol), `${s.switchApp} credited before input resumed`);
      const before = window.find((i) => i.kind === "ACTIVE" && Math.abs(i.e - s.lastInput) <= 2_000);
      must(before, `no ACTIVE interval ending at the last input (${t(s.lastInput)})`);
      const after = window.find((i) => i.kind === "ACTIVE" && i.s >= s.resumedAt - tol && i.s <= s.resumedAt + tol);
      must(after, `no ACTIVE interval starting when input resumed (${t(s.resumedAt)})`);
      checks.push([name, "PASS", `${before.applicationName} until ${t(before.e)} (last input); idle ${t(idle.s)}-${t(idle.e)} across ${s.switchApp} coming to the front at ${t(s.switchAt)}; ${after.applicationName} from ${t(after.s)}`]);
    } catch (err) {
      checks.push([name, "FAIL", err.message]);
    }
  }
}
const sorted = [...items].sort((a, b) => a.s - b.s);
const overlaps = sorted.filter((i, k) => k > 0 && i.s < sorted[k - 1].e).length;
checks.push(["No overlapping intervals", overlaps ? "FAIL" : "PASS", `${items.length} intervals`]);

console.log(`\nNative verification (sampling ${SAMPLE} s, idle threshold ${IDLE} s; dev-only values)\n`);
for (const [name, status, detail] of checks) console.log(`${status.padEnd(8)} ${name.padEnd(30)} ${detail}`);
process.exit(checks.some(([, s]) => s === "FAIL") ? 1 : checks.some(([, s]) => s === "INCONCLUSIVE") ? 2 : 0); // also stops the API and Vite started above

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
    if (cfg.only === "autoswitch") return finish(await autoswitch());
    if (cfg.only === "userswitch") return finish(undefined, await userswitch());

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
    const appNapBefore = (await inv("activity_status", {})).appNapPrevented;
    act("BREAK_START").click();
    const b0 = Date.now();
    await wait(5_000);
    const appNapDuring = (await inv("activity_status", {})).appNapPrevented;
    await wait(15_000);
    act("BREAK_END").click();
    steps.break = { done: true, start: b0, end: Date.now(), appNapBefore, appNapDuring };

    await finish();
  }

  /** The automatic foreground switch + idle threshold case: an app comes to the front with nobody touching the Mac. */
  async function autoswitch() {
    const idleMs = () => inv("e2e_idle_ms", {});
    const self = (s) => /insight-workfolio/i.test(s.currentApp?.name ?? "");
    current = "autoswitch";
    // Monitoring start: a collector sample taken after clock-in (the first one or a later one).
    const started = await until((s) => s.collecting && s.lastSampleMs && { monitoringFrom: s.lastSampleMs }, 15_000);
    if (!started) return { done: false, note: "monitoring start not observed after clock-in" };
    say("1/2", "Click once inside this window, then take your hands off the keyboard, mouse and trackpad. Don't touch anything until told (about 1 minute). Another app will come to the front by itself; leave it.");
    // Hands off for 3 s with this app in front, after a real input made once monitoring had started: that
    // is the last input. Idle carried over from before clock-in is not a valid start (the collector never
    // saw that input), so keep waiting for the click.
    let ready = null;
    skip = false;
    for (let end = Date.now() + 120_000; !ready && !skip && Date.now() < end; await wait(250)) {
      const s = await inv("activity_status", {});
      const ms = await idleMs();
      const lastInput = Date.now() - ms;
      const clicked = lastInput >= started.monitoringFrom + 1_000;
      $("#v-status").textContent = `app: ${s.currentApp?.name ?? "—"} · input since clock-in: ${clicked ? "yes" : "no (click once)"} · no input for ${Math.floor(ms / 1000)} s`;
      if (self(s) && ms >= 3_000 && clicked) ready = { ...started, readyAt: Date.now(), lastInput };
    }
    if (!ready) return { ...started, done: false, note: skip ? "skipped" : "no input in Workfolio after clock-in followed by 3 s hands-off" };
    const touched = async () => Date.now() - (await idleMs()) > ready.lastInput + 1_500; // the counter restarted: input
    // Well past one sample period, well before the idle threshold.
    while (Date.now() - ready.lastInput < 12_000) {
      if (await touched()) return { ...ready, done: false, note: "input happened before the switch (keep hands off); run again" };
      await wait(250);
    }
    log("TRIGGER autoswitch");
    const switched = await until((s) => !self(s) && s.currentApp && { switchAt: Date.now(), switchApp: s.currentApp.name }, 15_000);
    if (!switched) return { ...ready, done: false, note: "macOS did not bring the other app to the front (switch not observed)" };
    const idleAtSwitch = await idleMs();
    if (await touched()) return { ...ready, ...switched, idleAtSwitch, done: false, note: "input happened around the switch; run again" };
    $("#v-text").textContent = "Keep your hands off. Waiting for the idle threshold…";
    const idle = await until((s) => s.idle && { idleSince: s.idleSinceMs, detectedAt: Date.now() }, cfg.idleMs + 60_000);
    if (!idle || (await touched())) return { ...ready, ...switched, idleAtSwitch, done: false, note: idle ? "input happened before idle was confirmed; run again" : "idle threshold never reached" };
    await wait(2 * cfg.sampleMs);
    if (await touched()) return { ...ready, ...switched, idleAtSwitch, ...idle, done: false, note: "input happened before you were told; run again" };
    say("2/2", "Idle confirmed. Now move the mouse or press a key (in any app).");
    const resumed = await until((s) => !s.idle && { resumedAt: Date.now() }, 120_000);
    if (!resumed) return { ...ready, ...switched, idleAtSwitch, ...idle, done: false, note: "input did not resume within 2 minutes" };
    say("2/2", "Thanks. Keep using the computer normally for 10 seconds.");
    await wait(10_000);
    return { done: true, ...ready, ...switched, idleAtSwitch, ...idle, ...resumed };
  }

  /** Fast user switching: another account comes to the front, then this one again. */
  async function userswitch() {
    current = "userswitch";
    say("1/1", "Use some apps for 10 seconds, then switch to another user (menu bar user name or Control Center > Fast User Switching). Wait about 20 seconds there, then switch back to this account.");
    await wait(10_000);
    const away = await until((s) => s.sessionInactive && { awayAt: Date.now() }, 300_000);
    const back = away && (await until((s) => !s.sessionInactive && !s.locked && { backAt: Date.now() }, 600_000));
    return back ? { done: true, ...away, ...back } : { done: false, note: skip ? "skipped" : away ? "did not come back within 10 minutes" : "user switch not detected" };
  }

  async function finish(autoswitchStep, userswitchStep) {
    if (autoswitchStep) steps.autoswitch = autoswitchStep;
    if (userswitchStep) steps.userswitch = userswitchStep;
    say(cfg.only ? "Done" : "6/6", "Clocking out in 15 seconds (automatic), then uploading.");
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
