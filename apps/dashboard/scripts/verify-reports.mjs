// F12 runtime check: the admin Scheduled reports page (/reports/scheduled) in the dashboard production build (:3102), headless
// Chrome, against a throwaway API (temporary file DB) on :4000 with the MOCK mail provider: messages
// stay in that API process's memory and nothing is emailed. Synthetic people only.
// Run after `pnpm build`. Needs Google Chrome (macOS path) and free ports 4000 and 3102.
// Usage: pnpm --filter @workfolio/dashboard verify:reports [out-dir]
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = process.argv[2] ?? mkdtempSync(join(tmpdir(), "wf-verify-reports-"));
const RUN = join(OUT, "run");
rmSync(RUN, { recursive: true, force: true });
mkdirSync(RUN, { recursive: true });
Object.assign(process.env, {
  NODE_ENV: "development", LOG_LEVEL: "warn", PORT: "4000",
  DATABASE_URL: `file:${join(RUN, "reports.db")}`,
  JWT_SECRET: "report-check-secret-report-check-secret-x",
  SCREENSHOT_STORAGE: "local", SCREENSHOT_LOCAL_DIR: join(RUN, "shots"), TIMELAPSE_DIR: join(RUN, "videos"),
  CORS_ORIGINS: "http://localhost:3102", REPORT_MAIL_PROVIDER: "mock", REPORT_SCHEDULER_SECONDS: "0",
});
const req = createRequire(`${ROOT}/apps/api/package.json`);
req("reflect-metadata");
const { NestFactory } = req("@nestjs/core");
const dist = (p) => import(`${ROOT}/apps/api/dist/${p}`);
const { AppModule } = await dist("app.module.js");
const { configureApp } = await dist("app.setup.js");
const { DATABASE } = await dist("database/database.module.js");
const { hashPassword } = await dist("auth/crypto.js");
const { MAIL_TRANSPORT } = await dist("reports/mail.js");
const { addDays, localDate } = await import(`${ROOT}/packages/shared/dist/index.js`);
const PASSWORD = "report check password 1";
const APP = "http://localhost:3102";
const results = [];
const check = (name, ok, detail = "") => (results.push({ name, ok }), console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`));

// ---- API and synthetic people ------------------------------------------------------------------
const app = await NestFactory.create(AppModule, { logger: ["error", "warn"] });
configureApp(app);
await app.listen(4000);
const db = app.get(DATABASE);
const api = async (path, { method = "GET", body, cookie, bearer } = {}) => {
  const headers = { origin: APP };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`http://localhost:4000/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, res };
};
await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [randomUUID(), await hashPassword(PASSWORD)] });
const adminCookie = (await api("/auth/login", { method: "POST", body: { email: "admin@example.com", password: PASSWORD } })).res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
async function employee(n, name) {
  const email = `report${n}@example.com`;
  const r = await api("/employees", { method: "POST", cookie: adminCookie, body: { email, employeeCode: `RE-${n}`, fullName: name, timezone: "UTC" } });
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const bearer = (await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } })).body.accessToken;
  return { id: r.body.employee.id, email, bearer };
}
await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin2@example.com', 'ADMIN', ?)", args: [randomUUID(), await hashPassword(PASSWORD)] });
const ana = await employee(1, "Ana Employee");
const mock = app.get(MAIL_TRANSPORT);
// Ana: a 4-hour shift yesterday (UTC), synced from her registered device; a leave request with a private reason.
const device = randomUUID();
await api("/devices/register", { method: "POST", bearer: ana.bearer, body: { installationId: device, deviceName: "Mac", platform: "macos" } });
const yesterday = addDays(localDate(Date.now(), "UTC"), -1);
const y0 = Date.parse(`${yesterday}T09:00:00Z`);
{
  const res = await fetch("http://localhost:4000/api/v1/attendance/sync", { method: "POST", headers: { origin: APP, "content-type": "application/json", authorization: `Bearer ${ana.bearer}`, "x-device-id": device }, body: JSON.stringify({ sentAt: new Date().toISOString(), events: [["CLOCK_IN", y0], ["CLOCK_OUT", y0 + 4 * 3_600_000]].map(([type, at]) => ({ id: randomUUID(), type, occurredAt: new Date(at).toISOString() })) }) });
  const out = await res.json();
  if (!out.results?.every((r) => r.status === "ACCEPTED")) throw new Error(`sync: ${JSON.stringify(out)}`);
}
await api("/leave", { method: "POST", bearer: ana.bearer, body: { startDate: addDays(yesterday, 10), endDate: addDays(yesterday, 10), portion: "FULL_DAY", reason: "PRIVATE-LEAVE-REASON" } });

// ---- Chrome over CDP ---------------------------------------------------------------------------
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--remote-debugging-port=9339", `--user-data-dir=${join(RUN, "chrome")}`, "--window-size=1200,1100", "--no-first-run", "about:blank"], { stdio: "ignore" });
let target;
for (let i = 0; i < 150 && !target; i++) {
  await new Promise((r) => setTimeout(r, 200));
  target = await fetch("http://127.0.0.1:9339/json/new?about:blank", { method: "PUT" }).then((r) => r.json(), () => null);
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
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (await js(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${label}`);
};
const shot = async (name) => writeFileSync(join(OUT, name), Buffer.from((await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true })).data, "base64"));
await cdp("Page.enable");
await cdp("Runtime.enable");
await cdp("Network.enable");

const dash = spawn("pnpm", ["exec", "next", "start", "--port", "3102"], { cwd: `${ROOT}/apps/dashboard`, stdio: "ignore" });
for (let i = 0; i < 150 && !(await fetch(`${APP}/login`).then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 200));

// /reports/scheduled: a table row per report (tr[data-schedule]) and one editor section (new or "Edit <name>").
const row = (name) => `document.querySelector(${JSON.stringify(`tr[data-schedule="${name}"]`)})`;
const editor = (label) => `document.querySelector(${JSON.stringify(`section[aria-label="${label}"]`)})`;
const button = (scope, label) => `[...${scope}.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)} || b.getAttribute('aria-label') === ${JSON.stringify(label)})`;
const setReact = (sel, value) => `(() => { const el = ${sel}; const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); })()`;
const field = (scope, label) => `document.getElementById([...${scope}.querySelectorAll('label')].find((l) => l.textContent.replace('*', '').trim() === ${JSON.stringify(label)}).htmlFor)`;
async function createReport(name, frequency, employeeLabel = "", kind = "WORKED_HOURS") {
  await js(`${button("document", "New report")}.click()`);
  const form = editor("New scheduled report");
  await waitFor(`!!${form}`, "new report form");
  await js(setReact(field(form, "Report type"), kind));
  await js(setReact(field(form, "Title"), name));
  await js(setReact(field(form, "Frequency"), frequency));
  await js(setReact(field(form, "Time zone"), "UTC"));
  if (employeeLabel) {
    await js(setReact(field(form, "Report of"), "EMPLOYEE"));
    await waitFor(`[...${form}.querySelectorAll('select option')].some((o) => o.textContent.startsWith(${JSON.stringify(employeeLabel)}))`, "employee option");
    const sel = `[...${form}.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.textContent.startsWith(${JSON.stringify(employeeLabel)})))`;
    await js(setReact(sel, await js(`[...${sel}.options].find((o) => o.textContent.startsWith(${JSON.stringify(employeeLabel)})).value`)));
  }
  await js(`${form}.querySelector('form').requestSubmit()`);
  await waitFor(`!!${editor(`Edit ${name}`)} && !!${row(name)}`, `report ${name}`);
}
async function addRecipient(name, email) {
  const form = editor(`Edit ${name}`);
  if (!(await js(`!!${form}`))) await js(`${button(row(name), `Edit ${name}`)}.click()`);
  const box = `[...${form}.querySelectorAll('fieldset[aria-label=Recipients] label')].find((l) => l.textContent.startsWith(${JSON.stringify(email)}))?.querySelector('input')`;
  await waitFor(`!!${box}`, `eligible ${email}`);
  await js(`${box}.click()`);
  await waitFor(`${row(name)}.innerText.includes(${JSON.stringify(email)})`, `recipient ${email}`);
}
async function runNow(name) {
  // Mark (never remove: React owns it) the previous message; the page unmounts it and renders a fresh one.
  const msg = "[data-report-message]";
  await js(`document.querySelector('${msg}')?.setAttribute('data-old', '')`);
  await js(`${button(row(name), `Run ${name} now`)}.click()`);
  await waitFor(`!!document.querySelector('${msg}:not([data-old])')`, "run result");
  await waitFor(`!!${row(name)}.querySelector('[data-run-status]')`, "run listed");
  return js(`document.querySelector('${msg}:not([data-old])').textContent`);
}

try {
  await cdp("Page.navigate", { url: `${APP}/login` });
  await waitFor(`(() => { const f = document.querySelector('form'); return !!f && Object.keys(f).some((k) => k.startsWith('__reactProps')); })()`, "hydrated login form");
  await js(`(() => {
    const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
    set(document.querySelector('input[type=email], input[name=email]'), "admin@example.com");
    set(document.querySelector('input[type=password]'), ${JSON.stringify(PASSWORD)});
    document.querySelector('form').requestSubmit();
  })()`);
  await waitFor(`location.pathname !== "/login"`, "sign-in");
  const nav = `[...document.querySelectorAll('nav a')].find((a) => a.textContent === 'Scheduled reports')`;
  await waitFor(`!!${nav}`, "Scheduled reports link");
  await js(`${nav}.click()`);
  await waitFor(`location.pathname === '/reports/scheduled' && document.body.innerText.includes('No scheduled reports yet.')`, "empty scheduled reports page");
  const page = await js(`document.body.innerText`);
  check("dashboard: mock provider clearly labelled (nothing is emailed); empty state", /Mock provider \(development only\).*Nothing is emailed/s.test(page) && /The scheduler is off/.test(page));

  await createReport("Daily attendance", "DAILY");
  check("dashboard: report created with no recipients", (await js(`${row("Daily attendance")}.innerText`)).includes("none"));
  const recipients = `${editor("Edit Daily attendance")}.querySelectorAll('fieldset[aria-label=Recipients] label')`;
  await waitFor(`${recipients}.length >= 2`, "eligible list");
  const options = await js(`[...${recipients}].map((o) => o.textContent)`);
  check("dashboard: an all-employee report offers administrators only (not the employee)", options.some((o) => o.startsWith("admin2@example.com")) && !options.some((o) => o.includes("report1@example.com")), JSON.stringify(options));
  await addRecipient("Daily attendance", "admin2@example.com");

  // The page has no preview; the API's preview (same generator) is checked instead.
  const scheduleId = (await api("/reports/schedules", { cookie: adminCookie })).body.find((s) => s.name === "Daily attendance").id;
  const preview = (await api(`/reports/schedules/${scheduleId}/preview`, { cookie: adminCookie })).body.text;
  check("dashboard: preview shows yesterday's attendance (4h 00m) and freshness warnings, without sending", preview.includes(`for ${yesterday}`) && /Ana Employee \(RE-1\): 1 shift\(s\), worked 4h 00m/.test(preview) && preview.includes("WARNINGS") && mock.outbox.length === 0, preview.split("\n").slice(0, 6).join(" | "));
  check("dashboard: no leave reason, screenshots, activity or e-mail addresses in the report", !preview.includes("PRIVATE-LEAVE-REASON") && !preview.includes("@example.com") && /contains no screenshots, application activity, leave details or website data/.test(preview));

  const first = await runNow("Daily attendance");
  const runText = await js(`${row("Daily attendance")}.innerText`);
  check("dashboard: run now → 'not emailed' (mock only), never 'sent'; one message in the mock outbox", /ran for .*not emailed/.test(first) && runText.includes("Not emailed") && runText.includes("mock only") && !/\bSent\b|Delivered/.test(runText) && mock.outbox.length === 1 && mock.outbox[0].to === "admin2@example.com", `${first} | ${runText.replace(/\s+/g, " ")}`);
  const again = await runNow("Daily attendance");
  check("dashboard: running again for the same period sends nothing new", /already run for/.test(again) && mock.outbox.length === 1 && (await js(`${row("Daily attendance")}.querySelectorAll('[data-run-status]').length`)) === 1, again);

  await createReport("Ana weekly", "WEEKLY", "Ana Employee");
  await addRecipient("Ana weekly", "report1@example.com");
  check("dashboard: a one-employee report may go to that employee", (await js(`${row("Ana weekly")}.innerText`)).includes("report1@example.com"));

  mock.failNext("permanent");
  await createReport("Monthly", "MONTHLY");
  await addRecipient("Monthly", "admin@example.com");
  await runNow("Monthly");
  const failed = await js(`${row("Monthly")}.innerText`);
  check("dashboard: a provider failure is shown as Failed", /Failed/.test(failed) && failed.includes("failed"), failed.replace(/\s+/g, " "));

  await js(`${button(row("Monthly"), "Pause Monthly")}.click()`);
  await waitFor(`${row("Monthly")}.innerText.includes('Paused') && !!${button(row("Monthly"), "Activate Monthly")}`, "paused");
  check("dashboard: report paused", true);
  await shot("reports-dashboard.png");

  await app.close();
  await cdp("Page.reload");
  await waitFor(`document.body.innerText.includes('Could not reach the API')`, "error state", 30_000).catch(() => {});
  check("dashboard: API unreachable shows an error", /Could not reach the API/.test(await js(`document.body.innerText`)));
} catch (err) {
  check(`run aborted: ${err.message}`, false);
  await shot("reports-failure.png").catch(() => {});
} finally {
  ws.close();
  chrome.kill();
  dash.kill();
  await app.close().catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  rmSync(RUN, { recursive: true, force: true });
}
console.log(`Page captures: ${OUT}`);
const failedCount = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failedCount}/${results.length} passed`);
process.exit(failedCount ? 1 : 0);
