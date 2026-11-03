// F11 packaged-app check: the Tasks tab inside the BUNDLED desktop app (`tauri build --debug --bundles
// app`: front end embedded, tauri://localhost, app CSP; debug profile only because the test hook is
// compiled out of release builds). Two real launches with a quit in between (restart), and the API
// process stopped and restarted (server unreachable, then back). Throwaway API and synthetic data.
// The monitoring notice is NOT acknowledged, so no activity of this Mac is recorded.
//
//   pnpm --filter @workfolio/api build && pnpm --filter @workfolio/desktop tauri build --debug --bundles app
//   pnpm --filter @workfolio/desktop verify:tasks-packaged
//
// The app's saved dev sign-in (Keychain) is replaced by the test employee and cleared at the end.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
// --sleep: attended only. Puts this Mac to sleep (`pmset sleepnow`) with a timer running; wake it after about a minute.
const SLEEP = process.argv.includes("--sleep");
const APP = join(ROOT, "apps/desktop/src-tauri/target/debug/bundle/macos/Insight Workfolio.app/Contents/MacOS/insight-workfolio-desktop");
const API = "http://localhost:4000/api/v1";
const ORIGIN = "http://localhost:3000";
const tmp = mkdtempSync(join(tmpdir(), "wf-tasks-packaged-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const up = (url) => fetch(url).then((r) => r.ok, () => false);
const results = [];
const check = (name, ok, detail = "") => (results.push({ name, ok }), console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`));
let api = null;
const children = new Set();
process.on("exit", () => children.forEach((c) => c.kill()));

if (!existsSync(APP)) throw new Error(`No bundle at ${APP}; build it first (see the header).`);
if (await up(`${API}/health`)) throw new Error("Port 4000 is in use; stop the running API first.");
if (spawnSync("pgrep", ["-x", "insight-workfolio-desktop"]).status === 0) throw new Error("The desktop app is running; quit it first (one instance only).");

const env = { ...process.env, NODE_ENV: "development", LOG_LEVEL: "warn", PORT: "4000", DATABASE_URL: `file:${join(tmp, "tasks.db")}`, JWT_SECRET: randomBytes(32).toString("hex"), REPORT_SCHEDULER_SECONDS: "0" };
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
await startApi();
const cli = execFileSync("node", [join(ROOT, "apps/api/dist/cli/create-admin.js"), "--email", "admin@verify.local"], { env, encoding: "utf8" });
const adminPassword = randomBytes(12).toString("hex");
await call("/auth/setup-password", { method: "POST", body: { token: cli.match(/#token=(\S+)/)[1], password: adminPassword } });
const cookie = (await call("/auth/login", { method: "POST", body: { email: "admin@verify.local", password: adminPassword } })).res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const password = randomBytes(12).toString("hex");
const emp = await call("/employees", { method: "POST", cookie, body: { email: "tasks@verify.local", employeeCode: "PKT-1", fullName: "Packaged Tasks", timezone: timeZone } });
await call("/auth/setup-password", { method: "POST", body: { token: emp.body.setup.token, password } });
const other = await call("/employees", { method: "POST", cookie, body: { email: "other@verify.local", employeeCode: "PKT-2", fullName: "Other Person", timezone: timeZone } });
const project = async (code, titles, member) => {
  const p = (await call("/projects", { method: "POST", cookie, body: { code, name: `Project ${code}` } })).body;
  for (const title of titles) await call(`/projects/${p.id}/tasks`, { method: "POST", cookie, body: { title } });
  await call(`/projects/${p.id}/members`, { method: "POST", cookie, body: { employeeId: member } });
};
await project("ALPHA", ["Design", "Build"], emp.body.employee.id);
await project("SECRET", ["Hidden task"], other.body.employee.id);
const employeeId = emp.body.employee.id;
const entries = async () => (await call(`/task-time/entries?from=${new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(Date.now() - 86_400_000))}&to=${new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date())}&employeeId=${employeeId}`, { cookie })).body;

// ---- The driver (runs inside the app window) ---------------------------------------------------------
function driver(cfg) {
  if (window.__wfTasks) return;
  window.__wfTasks = true;
  const inv = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const log = (line) => inv("e2e_log", { line });
  const $ = (s) => document.querySelector(s);
  const txt = (s) => ($(s)?.textContent ?? "").trim();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 30_000, what = "condition") => {
    log(`${cfg.phase}: waiting for ${what}`);
    for (const end = Date.now() + ms; Date.now() < end; await wait(200)) {
      const v = fn();
      if (v) return v;
    }
    throw new Error(`timed out: ${what}`);
  };
  const r = { phase: cfg.phase, href: location.href, steps: {} };
  const tasksTab = async () => {
    $("#tab-btn-today").click();
    $("#tab-btn-tasks").click();
    await until(() => txt("#tasks-status") !== "Loading…" && (!$("#tasks-timer").hidden || !$("#tasks-error").hidden), 90_000, "tasks loaded");
    await wait(300);
  };
  const today = () => $("#tab-btn-today").click();
  const action = async (a, state) => {
    today();
    // 90 s: each attendance action reads the device ID from the Keychain, which macOS may ask about.
    await until(() => !$(`[data-action="${a}"]`).disabled && !$("#attendance").hidden, 90_000, `${a} enabled`);
    $(`[data-action="${a}"]`).click();
    await until(() => txt("#att-state") === state, 90_000, `state ${state}`);
  };
  const health = () => fetch("http://localhost:4000/api/v1/health").then((x) => x.ok, () => false);
  const snapshot = () => ({ running: !$("#tasks-running").hidden, current: txt("#tasks-current"), since: txt("#tasks-since"), elapsed: txt("#tasks-elapsed"), attendance: $("#tasks-attendance").hidden ? "" : txt("#tasks-attendance"), error: $("#tasks-error").hidden ? "" : txt("#tasks-error"), history: $("#tasks-history").innerText, startDisabled: $("#tasks-start").disabled, pauseDisabled: $("#tasks-pause").disabled, stopDisabled: $("#tasks-stop").disabled });
  const startTask = async (title) => {
    const option = [...document.querySelectorAll("#tasks-task option")].find((o) => o.textContent === title);
    $("#tasks-task").value = option.value;
    $("#tasks-start-form").requestSubmit();
    await until(() => !$("#tasks-running").hidden && txt("#tasks-current").endsWith(title) && txt("#tasks-elapsed") !== "", 15_000, `running ${title}`);
  };
  log(`${cfg.phase}: driver loaded at ${location.href}`);
  (async () => {
    try {
      await until(() => !$("#login-view").hidden || !$("#signed-in-view").hidden, 30_000, "app ready");
      r.autoSignedIn = !$("#signed-in-view").hidden && document.body.textContent.includes("PKT-1");
      if (!$("#signed-in-view").hidden && !r.autoSignedIn) {
        $("#logout").click();
        await until(() => !$("#login-view").hidden, 15_000, "signed out");
      }
      if (!r.autoSignedIn) {
        $("#login-form").email.value = cfg.email;
        $("#login-form").password.value = cfg.password;
        $("#login-form").requestSubmit();
        await until(() => !$("#signed-in-view").hidden && document.body.textContent.includes("PKT-1"), 30_000, "signed in");
      }
      log(`${cfg.phase}: signed in (automatic: ${r.autoSignedIn})`);
      r.size = { w: innerWidth, h: innerHeight, scroll: document.documentElement.scrollWidth };
      if (cfg.phase === "first") {
        if (!$("#device-register").hidden) {
          $("#device-form").deviceName.value = "Packaged test Mac";
          $("#device-form").requestSubmit();
          await until(() => $("#device-register").hidden && !$("#attendance").hidden, 90_000, "device registered");
        }
        await tasksTab();
        r.steps.clockedOut = snapshot();
        r.steps.options = [...document.querySelectorAll("#tasks-task optgroup")].map((g) => `${g.label}: ${[...g.querySelectorAll("option")].map((o) => o.textContent).join(",")}`);
        await action("CLOCK_IN", "Clocked in");
        await tasksTab();
        await startTask("Design");
        const e1 = txt("#tasks-elapsed");
        await wait(3200);
        r.steps.ticking = { before: e1, after: txt("#tasks-elapsed"), since: txt("#tasks-since") };
        $("#tasks-stop").click();
        await until(() => $("#tasks-running").hidden && /stopped\)/.test($("#tasks-history").innerText), 15_000, "stopped");
        r.steps.stopped = snapshot();
        await startTask("Build");
        r.steps.second = { startHidden: $("#tasks-start-form").hidden };
        await action("BREAK_START", "On break");
        await tasksTab();
        r.steps.onBreak = snapshot();
        await action("BREAK_END", "Clocked in");
        await tasksTab();
        await startTask("Design");
        r.steps.leftRunning = snapshot();
        log("first: quitting with a timer running");
      } else {
        await tasksTab();
        r.steps.restored = snapshot();
        await wait(2200);
        r.steps.restoredTicking = txt("#tasks-elapsed");
        if (cfg.sleep) {
          // Real sleep: the harness runs `pmset sleepnow`; timers in this page stop while asleep, so a
          // jump in wall-clock time between ticks marks the wake.
          const seconds = (t) => [...t.matchAll(/(\d+)([hms])/g)].reduce((n, [, v, u]) => n + Number(v) * { h: 3600, m: 60, s: 1 }[u], 0);
          let last = Date.now();
          let gap = 0;
          const watch = setInterval(() => {
            const now = Date.now();
            if (now - last > 15_000) gap = now - last;
            last = now;
          }, 1000);
          log("PHASE sleep-ready");
          await until(() => gap > 0, 15 * 60_000, "the Mac to sleep and wake");
          clearInterval(watch);
          log(`awake after ${Math.round(gap / 1000)} s asleep`);
          for (let i = 0; i < 100 && !(await health()); i++) await wait(300); // network back after wake
          await tasksTab();
          await until(() => !$("#tasks-running").hidden && txt("#tasks-elapsed") !== "", 90_000, "timer after wake");
          r.steps.afterSleep = { ...snapshot(), gapS: Math.round(gap / 1000), elapsedS: seconds(txt("#tasks-elapsed")), beforeS: seconds(r.steps.restoredTicking) };
        }
        log("PHASE offline-ready");
        for (let i = 0; i < 100 && (await health()); i++) await wait(200); // the harness stops the API
        await tasksTab();
        await until(() => txt("#tasks-since").startsWith("Last known"), 20_000, "stale state");
        await wait(1500);
        r.steps.offline = { ...snapshot(), header: txt("header") };
        log("PHASE offline-seen");
        for (let i = 0; i < 150 && !(await health()); i++) await wait(200); // the harness restarts it
        // No click: the tab refreshes itself (every 30 s while shown).
        await until(() => $("#tasks-error").hidden && !$("#tasks-running").hidden && txt("#tasks-elapsed") !== "", 45_000, "recovered");
        r.steps.recovered = snapshot();
        await action("CLOCK_OUT", "Clocked out");
        await tasksTab();
        r.steps.clockedOutAfter = snapshot();
        $("#logout").click(); // clears the saved test sign-in from the Keychain
        await wait(1500);
      }
      r.ok = true;
    } catch (err) {
      // What the app shows at the failure (no secrets: visible status texts only).
      const seen = ["#login-error", "#login-status", "#api-status", "#signed-in-view"].map((s) => [s, $(s) && !$(s).hidden ? txt(s).slice(0, 160) : null]).filter(([, v]) => v);
      r.error = `${err} | ${JSON.stringify(seen)}`;
    }
    log(`RESULT ${JSON.stringify(r)}`);
    inv("e2e_exit", { code: 0 });
  })();
}

async function launch(phase, onLine = () => {}) {
  const script = join(tmp, `${phase}.js`);
  writeFileSync(script, `(${driver.toString()})(${JSON.stringify({ phase, email: "tasks@verify.local", password, sleep: SLEEP })});`);
  const app = spawn(APP, { env: { ...process.env, WF_E2E_SCRIPT: script }, stdio: ["ignore", "ignore", "pipe"] });
  children.add(app);
  let result = null;
  let buffered = "";
  app.stderr.setEncoding("utf8").on("data", (chunk) => {
    const lines = (buffered + chunk).split("\n");
    buffered = lines.pop();
    for (const line of lines) {
      if (process.env.WF_DEBUG && !line.startsWith("[e2e]")) console.log(`  app(raw): ${line}`);
      if (line.startsWith("[e2e] RESULT ")) result = JSON.parse(line.slice("[e2e] RESULT ".length));
      else if (line.startsWith("[e2e] ")) {
        console.log(`  app: ${line}`);
        onLine(line.slice(6));
      }
    }
  });
  const exited = new Promise((r) => app.on("exit", r));
  if ((await Promise.race([exited, sleep(SLEEP ? 1_800_000 : 900_000).then(() => "timeout")])) === "timeout") app.kill();
  children.delete(app);
  return result ?? { error: "no result (timed out or crashed; a Keychain prompt may be waiting on screen)" };
}

// ---- Launch 1: workflow, then quit with a timer running -----------------------------------------------
const one = await launch("first");
const s1 = one.steps ?? {};
check("launch 1 ran from the bundle (tauri://localhost) and finished", one.ok === true && one.href?.startsWith("tauri://localhost"), one.error ?? one.href);
check("clocked out: Tasks explains it, Start disabled", /Clock in on the Today tab/.test(s1.clockedOut?.attendance ?? "") && s1.clockedOut?.startDisabled === true);
check("only assigned projects and open tasks offered (not SECRET)", JSON.stringify(s1.options) === JSON.stringify(["ALPHA · Project ALPHA: Design,Build"]), JSON.stringify(s1.options));
check("start → running timer, elapsed ticks from server time", !!s1.ticking && s1.ticking.before !== s1.ticking.after && /s$/.test(s1.ticking.after), JSON.stringify(s1.ticking));
check("stop → no timer running, history shows the stopped entry", s1.stopped && !s1.stopped.running && /Design — .*stopped\)/.test(s1.stopped.history));
check("while a timer runs, no second start is offered", s1.second?.startHidden === true);
check("break → timer ended by the break, start disabled with the reason", s1.onBreak && !s1.onBreak.running && /ended by your break/.test(s1.onBreak.history) && /on a break/.test(s1.onBreak.attendance) && s1.onBreak.startDisabled);
check("window at its normal size (440×640 default) has no horizontal overflow", one.size && one.size.scroll <= one.size.w, JSON.stringify(one.size));
let list = await entries();
const runningBefore = list.filter((e) => !e.endedAt);
check("server after quit: exactly one running entry (the timer left running)", runningBefore.length === 1 && runningBefore[0].task.title === "Design", JSON.stringify(list.map((e) => [e.task.title, e.endReason])));

// ---- Launch 2: restart recovery, server unreachable and back, clock-out --------------------------------
const quitAt = Date.now();
await sleep(3000);
let runningAtSleep = null;
const two = await launch("second", async (line) => {
  if (line === "PHASE sleep-ready") {
    runningAtSleep = (await entries()).filter((e) => !e.endedAt);
    console.log("  harness: putting the Mac to sleep now (pmset sleepnow). Wake it after about a minute.");
    spawnSync("pmset", ["sleepnow"]);
  }
  if (line === "PHASE offline-ready") await stopApi();
  if (line === "PHASE offline-seen") await startApi();
});
const s2 = two.steps ?? {};
check("launch 2 finished (restart)", two.ok === true, two.error);
check("restart: signed in again from the saved sign-in, same running timer recovered (same start), still ticking", two.autoSignedIn === true && s2.restored?.running && s2.restored.current === "ALPHA · Design" && s2.restored.since === s1.leftRunning?.since && s2.restoredTicking !== "", `${s2.restored?.since} vs ${s1.leftRunning?.since}; auto ${two.autoSignedIn}`);
if (SLEEP) {
  const a = s2.afterSleep;
  check("real sleep/wake: same timer after wake, elapsed covers the time asleep (server time), still ticking", a?.running && a.current === "ALPHA · Design" && a.since === s1.leftRunning?.since && a.gapS >= 30 && a.elapsedS >= a.beforeS + a.gapS - 5, JSON.stringify(a && { gapS: a.gapS, beforeS: a.beforeS, elapsedS: a.elapsedS, since: a.since }));
  check("real sleep/wake: one running entry before sleep, the same one after (no duplicate)", runningAtSleep?.length === 1 && runningAtSleep[0].startedAt === (await entries()).find((e) => e.endReason === "CLOCK_OUT")?.startedAt);
} else console.log("SKIP  real sleep/wake (run with --sleep, attended)");
check("server unreachable: clear error, last-known state, no ticking, Pause/Stop disabled", s2.offline && /Connect to the server/.test(s2.offline.error) && s2.offline.elapsed === "" && s2.offline.since.startsWith("Last known") && s2.offline.pauseDisabled && s2.offline.stopDisabled, JSON.stringify({ error: s2.offline?.error, since: s2.offline?.since, header: s2.offline?.header?.slice(0, 60) }));
check("server back: state recovered without a click, same timer, ticking", s2.recovered?.running && s2.recovered.current === "ALPHA · Design" && s2.recovered.since === s1.leftRunning?.since && s2.recovered.elapsed !== "");
check("clock-out → timer ended by the clock-out", s2.clockedOutAfter && !s2.clockedOutAfter.running && /ended by clock-out/.test(s2.clockedOutAfter.history));
list = await entries();
const byReason = list.map((e) => e.endReason).sort();
check("server: 3 entries (Design stopped, Build ended by the break, Design ended by the clock-out), each ended once, none running", list.length === 3 && list.every((e) => e.endedAt) && JSON.stringify(byReason) === '["BREAK","CLOCK_OUT","STOPPED"]', JSON.stringify(list.map((e) => [e.task.title, e.endReason, e.durationMs])));
const last = list.find((e) => e.endReason === "CLOCK_OUT");
const att = (await call(`/attendance/history?from=${new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date())}&to=${new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date())}&employeeId=${employeeId}`, { cookie })).body.items;
const clockOut = att.find((s) => s.clockOutAt)?.clockOutAt;
check("the restarted timer ran across the quit and the outage, ending exactly at the recorded clock-out", last && last.endedAt === clockOut && Date.parse(last.startedAt) < quitAt && last.durationMs === Date.parse(last.endedAt) - Date.parse(last.startedAt), `${last?.startedAt} → ${last?.endedAt} (clock-out ${clockOut})`);
const sorted = [...list].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
check("no overlapping entries", sorted.every((e, i) => i === 0 || e.startedAt >= sorted[i - 1].endedAt));
await stopApi();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
