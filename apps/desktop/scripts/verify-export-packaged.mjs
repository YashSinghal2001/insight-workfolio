// F03 packaged-app check: the timesheet download (CSV and Excel) inside the BUNDLED desktop app
// (`tauri build --debug --bundles app`: front end embedded and served from tauri://localhost with the
// app's CSP, the real WKWebView download path and the Rust download handler). Debug profile only
// because the test hook (WF_E2E_SCRIPT) is compiled out of release builds; it is not a signed release.
//
//   pnpm --filter @workfolio/api build && pnpm --filter @workfolio/desktop verify:export-packaged [out-dir]
//
// Starts a throwaway API on :4000 (temporary database, synthetic employee), launches the bundle, signs
// in and downloads into the real ~/Downloads. Files the run created there are checked and then MOVED to
// the output folder, so Downloads is left as it was. The app's saved dev sign-in (Keychain) is replaced
// by the test employee and cleared at the end; macOS may ask once to allow Keychain access.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const APP = join(ROOT, "apps/desktop/src-tauri/target/debug/bundle/macos/Insight Workfolio.app/Contents/MacOS/insight-workfolio-desktop");
const OUT = process.argv[2] ?? mkdtempSync(join(tmpdir(), "wf-verify-export-packaged-"));
mkdirSync(OUT, { recursive: true });
const DOWNLOADS = join(homedir(), "Downloads");
const API = "http://localhost:4000/api/v1";
const ORIGIN = "http://localhost:3000";
const tmp = mkdtempSync(join(tmpdir(), "wf-export-packaged-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const up = (url) => fetch(url).then((r) => r.ok, () => false);
const results = [];
const check = (name, ok, detail = "") => (results.push({ name, ok }), console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`));
const children = [];
process.on("exit", () => children.forEach((c) => c.kill()));

if (!existsSync(APP)) throw new Error(`No bundle at ${APP}; run: pnpm --filter @workfolio/desktop tauri build --debug --bundles app`);
if (await up(`${API}/health`)) throw new Error("Port 4000 is in use; stop the running API first.");
if (spawnSync("pgrep", ["-x", "insight-workfolio-desktop"]).status === 0) throw new Error("The desktop app is running; quit it first (one instance only).");

// ---- Throwaway API and a synthetic employee with shifts ------------------------------------------
const env = { ...process.env, NODE_ENV: "development", LOG_LEVEL: "warn", PORT: "4000", DATABASE_URL: `file:${join(tmp, "export.db")}`, JWT_SECRET: randomBytes(32).toString("hex"), REPORT_SCHEDULER_SECONDS: "0" };
children.push(spawn("node", [join(ROOT, "apps/api/dist/main.js")], { env, stdio: "inherit" }));
for (let i = 0; i < 40 && !(await up(`${API}/ready`)); i++) await sleep(250);
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
const cli = execFileSync("node", [join(ROOT, "apps/api/dist/cli/create-admin.js"), "--email", "admin@verify.local"], { env, encoding: "utf8" });
const adminPassword = randomBytes(12).toString("hex");
await call("/auth/setup-password", { method: "POST", body: { token: cli.match(/#token=(\S+)/)[1], password: adminPassword } });
const cookie = (await call("/auth/login", { method: "POST", body: { email: "admin@verify.local", password: adminPassword } })).res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const NAME = '=SUM(1,2) Zoë "Q", 日本';
const created = await call("/employees", { method: "POST", cookie, body: { email: "export@verify.local", employeeCode: "PKG-1", fullName: NAME, timezone: timeZone } });
const password = randomBytes(12).toString("hex");
await call("/auth/setup-password", { method: "POST", body: { token: created.body.setup.token, password } });
// Shifts recorded from a separate (seed) device: a cross-midnight shift, a shift with a break, an open shift.
const bearer = (await call("/auth/login", { method: "POST", body: { email: "export@verify.local", password, client: "desktop" } })).body.accessToken;
const seed = randomUUID();
await call("/devices/register", { method: "POST", bearer, body: { installationId: seed, deviceName: "Seed", platform: "macos" } });
const H = 3_600_000;
const day = (n) => new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(Date.now() - n * 24 * H));
const at = (date, hh) => Date.parse(new Date(`${date}T${hh}:00`).toISOString()); // local wall time on this Mac (= the employee's zone)
const [d2, d1, d0] = [day(2), day(1), day(0)];
const events = [["CLOCK_IN", at(d2, "22:00")], ["CLOCK_OUT", at(d1, "01:00")], ["CLOCK_IN", at(d1, "09:00")], ["BREAK_START", at(d1, "13:00")], ["BREAK_END", at(d1, "13:30")], ["CLOCK_OUT", at(d1, "17:30")], ["CLOCK_IN", Date.now() - H]];
const sync = await call("/attendance/sync", { method: "POST", bearer, device: seed, body: { sentAt: new Date().toISOString(), events: events.map(([type, t]) => ({ id: randomUUID(), type, occurredAt: new Date(t).toISOString() })) } });
if (!sync.body.results.every((r) => r.status === "ACCEPTED")) throw new Error(`seed: ${JSON.stringify(sync.body.results)}`);
const [from, to] = [d2, d0];

// ---- Drive the packaged app ------------------------------------------------------------------------
function driver(cfg) {
  if (window.__wfExport) return;
  window.__wfExport = true;
  const inv = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const log = (line) => inv("e2e_log", { line });
  const $ = (s) => document.querySelector(s);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 30_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await wait(200)) {
      const v = fn();
      if (v) return v;
    }
    throw new Error("timed out");
  };
  const result = { href: location.href, csp: !!document.querySelector("meta[http-equiv='Content-Security-Policy']"), downloads: [] };
  const exportOnce = async (format) => {
    const f = $("#export-form");
    $("#export").open = true;
    f.from.value = cfg.from;
    f.to.value = cfg.to;
    f.format.value = format;
    f.dispatchEvent(new Event("input", { bubbles: true }));
    const button = $("#export-submit").textContent;
    f.requestSubmit();
    await until(() => !$("#export-submit").disabled && ($("#export-status").textContent.startsWith("Downloaded") || $("#export-status").textContent.startsWith("No shifts") || !$("#export-error").hidden));
    result.downloads.push({ format, button, status: $("#export-status").textContent, error: $("#export-error").hidden ? "" : $("#export-error").textContent });
    await wait(1500); // let WebKit finish writing before the next one
  };
  (async () => {
    try {
      await until(() => !$("#login-view").hidden || !$("#signed-in-view").hidden);
      if (!$("#signed-in-view").hidden) {
        log("signed in as someone else: signing out first");
        $("#logout").click();
        await until(() => !$("#login-view").hidden);
      }
      const f = $("#login-form");
      f.email.value = cfg.email;
      f.password.value = cfg.password;
      f.requestSubmit();
      await until(() => !$("#signed-in-view").hidden && document.body.textContent.includes("PKG-1"));
      log("signed in");
      $("#tab-btn-history").click();
      await until(() => $("#days-body").children.length > 0);
      await exportOnce("csv");
      await exportOnce("xlsx");
      await exportOnce("csv"); // same name again: must not overwrite
      // Not an export: the native handler must refuse it.
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob(["not an export"])), download: "notes-from-page.txt" });
      a.click();
      await wait(2500);
      result.ok = true;
    } catch (err) {
      result.error = String(err);
    }
    try {
      $("#logout").click(); // clears the saved test sign-in from the Keychain
      await wait(1500);
    } catch {}
    log(`RESULT ${JSON.stringify(result)}`);
    inv("e2e_exit", { code: 0 });
  })();
}
const script = join(tmp, "driver.js");
writeFileSync(script, `(${driver.toString()})(${JSON.stringify({ email: "export@verify.local", password, from, to })});`);
const started = Date.now() - 1000;
const before = new Set(readdirSync(DOWNLOADS));
const app = spawn(APP, { env: { ...process.env, WF_E2E_SCRIPT: script }, stdio: ["ignore", "ignore", "pipe"] });
children.push(app);
let result = null;
const native = [];
let buffered = "";
app.stderr.setEncoding("utf8").on("data", (chunk) => {
  const lines = (buffered + chunk).split("\n");
  buffered = lines.pop();
  for (const line of lines) {
    if (line.startsWith("[e2e] RESULT ")) result = JSON.parse(line.slice("[e2e] RESULT ".length));
    else if (line.startsWith("[download]")) native.push(line);
    if (line.startsWith("[e2e] ") || line.startsWith("[download]")) console.log(`  app: ${line.startsWith("[e2e] RESULT") ? "[e2e] RESULT …" : line}`);
  }
});
const exited = new Promise((r) => app.on("exit", r));
const timeout = sleep(150_000).then(() => "timeout");
if ((await Promise.race([exited, timeout])) === "timeout") {
  app.kill();
  check("packaged app finished (a Keychain prompt may be waiting on screen)", false, "timed out after 150 s");
}

// ---- What the app did and what landed in Downloads ---------------------------------------------------
const csvName = `workfolio-timesheet-draft1_PKG-1_${from}_${to}.csv`;
const xlsxName = `workfolio-timesheet-draft1_PKG-1_${from}_${to}.xlsx`;
const dupName = `workfolio-timesheet-draft1_PKG-1_${from}_${to} (1).csv`;
const fresh = readdirSync(DOWNLOADS).filter((f) => !before.has(f) && statSync(join(DOWNLOADS, f)).mtimeMs >= started);
console.log(`  new in ~/Downloads: ${fresh.join(", ") || "nothing"}`);
if (result) {
  check("app ran from the bundle (tauri://localhost, embedded front end), not the Vite dev server", result.href.startsWith("tauri://localhost"), result.href);
  check("signed in and ran three exports without errors", result.ok === true && result.downloads.length === 3 && result.downloads.every((d) => !d.error), result.error ?? JSON.stringify(result.downloads.map((d) => d.error || d.status.slice(0, 60))));
  check("buttons and status name the file type and the shift count (3)", result.downloads[0]?.button === "Download CSV" && result.downloads[1]?.button === "Download Excel file" && result.downloads[0]?.status.startsWith(`Downloaded ${csvName} (3 shift(s))`) && result.downloads[1]?.status.startsWith(`Downloaded ${xlsxName} (3 shift(s))`));
}
check("native handler: 3 exports accepted, the non-export file refused, 3 writes finished", native.filter((l) => l === "[download] accepted").length === 3 && native.filter((l) => l === "[download] refused").length === 1 && native.filter((l) => l === "[download] finished, success: true").length === 3, native.join(" | "));
check("files saved in ~/Downloads; the repeated CSV got ' (1)' instead of overwriting; nothing else", [csvName, xlsxName, dupName].every((f) => fresh.includes(f)) && fresh.length === 3, fresh.join(", "));
if (fresh.includes(csvName)) {
  const csv = readFileSync(join(DOWNLOADS, csvName), "utf8");
  const lines = csv.replace(/^﻿/, "").split("\r\n").filter(Boolean);
  check("CSV: BOM, 16-column header, 3 shifts (cross-midnight on its start date, break of 30 min, open shift blank), name neutralised", csv.startsWith("﻿Employee code,Employee name,Work date,Time zone,Clock in,Clock out,Status,Breaks,Break count,Break minutes,Worked minutes,Active minutes,Idle minutes,No activity record minutes,Corrected,Clock-in source\r\n") && lines.length === 4 && lines[1].includes(`,${d2},`) && lines[1].includes(",180,") && lines[2].includes(",30,480,") && lines[3].includes("Open: no clock-out recorded") && lines[1].includes(`"'=SUM(1,2) Zoë ""Q"", 日本"`), lines.slice(1).map((l) => l.slice(0, 90)).join(" / "));
  check("the ' (1)' copy is an identical export, the first file untouched", readFileSync(join(DOWNLOADS, dupName), "utf8") === csv);
}
if (fresh.includes(xlsxName)) {
  const bytes = readFileSync(join(DOWNLOADS, xlsxName));
  const sheet1 = execFileSync("unzip", ["-p", join(DOWNLOADS, xlsxName), "xl/worksheets/sheet1.xml"], { encoding: "utf8" });
  check("XLSX: a real workbook (ZIP), frozen header, filter over 3 rows, no formula cells", bytes.subarray(0, 2).toString() === "PK" && /state="frozen"/.test(sheet1) && /<autoFilter ref="A1:P4"\/>/.test(sheet1) && !/<f[ >]/.test(sheet1));
  if (spawnSync("python3", ["-I", "-c", "import openpyxl"]).status === 0) {
    const wb = JSON.parse(execFileSync("python3", ["-I", "-c", "import json,sys,datetime,openpyxl\nwb=openpyxl.load_workbook(sys.argv[1])\nv=lambda x: x.date().isoformat() if isinstance(x, datetime.datetime) else x\nprint(json.dumps({s.title: [[v(c.value) for c in r] for r in s.iter_rows()] for s in wb.worksheets}))", join(DOWNLOADS, xlsxName)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    const sum = Object.fromEntries(wb.Summary.map((r) => [r[0], r[1]]));
    check("XLSX (openpyxl): Timesheet + Summary; name as plain text; dates, numbers and blanks; sums of the columns", Object.keys(wb).join() === "Timesheet,Summary" && wb.Timesheet.length === 4 && wb.Timesheet[1][1] === NAME && wb.Timesheet[1][2] === d2 && wb.Timesheet[2][10] === 480 && wb.Timesheet[3][10] === null && sum["Shifts (rows)"] === 3 && sum["Open shifts"] === 1 && sum["Worked minutes (sum of the column)"] === 660 && sum["Break minutes (sum of the column)"] === 30, JSON.stringify(wb.Timesheet[1]));
  } else check("XLSX contents (needs python3 openpyxl)", false, "not verified");
}
check("the refused file was not written anywhere in Downloads", !fresh.some((f) => f.startsWith("notes-from-page")));
// Leave ~/Downloads as it was: move exactly the files this run created into the output folder.
for (const f of fresh) renameSync(join(DOWNLOADS, f), join(OUT, f));
console.log(`Moved ${fresh.length} test file(s) from ~/Downloads to ${OUT}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
