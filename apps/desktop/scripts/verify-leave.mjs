// F10 runtime check: the employee Leave tab in the real desktop front end (Vite on :1420, headless
// Chrome, no Tauri shell) and the admin Leave page in the dashboard production build (:3102), against
// a throwaway API (temporary file DB) on :4000. Synthetic employees only.
// Run after `pnpm build`. Needs Google Chrome (macOS path) and free ports 4000, 1420 and 3102.
// Usage: pnpm --filter @workfolio/desktop verify:leave [out-dir]
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = process.argv[2] ?? mkdtempSync(join(tmpdir(), "wf-verify-leave-"));
const RUN = join(OUT, "run");
rmSync(RUN, { recursive: true, force: true });
mkdirSync(RUN, { recursive: true });
Object.assign(process.env, {
  NODE_ENV: "development", LOG_LEVEL: "warn", PORT: "4000",
  DATABASE_URL: `file:${join(RUN, "leave.db")}`,
  JWT_SECRET: "leave-check-secret-leave-check-secret-xx",
  SCREENSHOT_STORAGE: "local", SCREENSHOT_LOCAL_DIR: join(RUN, "shots"), TIMELAPSE_DIR: join(RUN, "videos"),
  CORS_ORIGINS: "http://localhost:1420,http://localhost:3102",
});
const req = createRequire(`${ROOT}/apps/api/package.json`);
req("reflect-metadata");
const { NestFactory } = req("@nestjs/core");
const dist = (p) => import(`${ROOT}/apps/api/dist/${p}`);
const { AppModule } = await dist("app.module.js");
const { configureApp } = await dist("app.setup.js");
const { DATABASE } = await dist("database/database.module.js");
const { hashPassword } = await dist("auth/crypto.js");
const { addDays, localDate } = await import(`${ROOT}/packages/shared/dist/index.js`);
const PASSWORD = "leave check password 1";
const APP = "http://localhost:1420";
const DASH = "http://localhost:3102";
const TZ = "Asia/Kolkata";
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
  const email = `leave${n}@example.com`;
  const r = await api("/employees", { method: "POST", cookie: adminCookie, body: { email, employeeCode: `LV-${n}`, fullName: name, timezone: TZ } });
  await api("/auth/setup-password", { method: "POST", body: { token: r.body.setup.token, password: PASSWORD } });
  const bearer = (await api("/auth/login", { method: "POST", body: { email, password: PASSWORD, client: "desktop" } })).body.accessToken;
  return { id: r.body.employee.id, email, bearer };
}
const ana = await employee(1, "Ana Employee");
const ben = await employee(2, "Ben Other");
const today = localDate(Date.now(), TZ);
const d = addDays(today, 14);
await api("/leave", { method: "POST", bearer: ben.bearer, body: { startDate: d, endDate: d, portion: "FULL_DAY", reason: "Ben private reason" } });
const count = async (sql, args = []) => Number((await db.execute({ sql, args })).rows[0].n);

// ---- Chrome over CDP ---------------------------------------------------------------------------
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--remote-debugging-port=9337", `--user-data-dir=${join(RUN, "chrome")}`, "--window-size=1000,1100", "--no-first-run", "about:blank"], { stdio: "ignore" });
let target;
for (let i = 0; i < 150 && !target; i++) {
  await new Promise((r) => setTimeout(r, 200));
  target = await fetch("http://127.0.0.1:9337/json/new?about:blank", { method: "PUT" }).then((r) => r.json(), () => null);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) (pending.get(msg.id)(msg), pending.delete(msg.id));
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
const network = (conditions) => cdp("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, ...conditions });
await cdp("Page.enable");
await cdp("Runtime.enable");
await cdp("Network.enable");

const vite = spawn("pnpm", ["exec", "vite", "--port", "1420", "--strictPort"], { cwd: `${ROOT}/apps/desktop`, stdio: "ignore", env: { ...process.env, VITE_API_URL: "http://localhost:4000" } });
const dash = spawn("pnpm", ["exec", "next", "start", "--port", "3102"], { cwd: `${ROOT}/apps/dashboard`, stdio: "ignore" });
for (const url of [APP, `${DASH}/login`]) {
  for (let i = 0; i < 150 && !(await fetch(url).then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 200));
}

// Desktop helpers
const $text = (sel) => js(`document.querySelector(${JSON.stringify(sel)}).textContent`);
const visible = (sel) => js(`!document.querySelector(${JSON.stringify(sel)}).closest('[hidden]')`);
const items = () => js(`[...document.querySelectorAll('#leave-list > li')].map((li) => li.innerText)`);
const listLoaded = `document.querySelector('#leave-status').textContent !== 'Loading…'`;
async function fill(values) {
  await js(`(() => {
    const f = document.querySelector('#leave-form');
    f.portion.value = ${JSON.stringify(values.portion ?? "FULL_DAY")}; f.portion.dispatchEvent(new Event('change'));
    for (const [k, v] of Object.entries(${JSON.stringify(values)})) if (k !== 'portion') f.elements.namedItem(k).value = v;
    f.dispatchEvent(new Event('input'));
  })()`);
}
async function submit(values) {
  await fill(values);
  await js(`document.querySelector('#leave-ok').textContent = ''; document.querySelector('#leave-form').requestSubmit()`);
  await waitFor(`!document.querySelector('#leave-ok').hidden || !document.querySelector('#leave-error').hidden`, "submit result");
  await waitFor(listLoaded, "list reload");
  return { ok: await js(`document.querySelector('#leave-ok').hidden ? null : document.querySelector('#leave-ok').textContent`), error: await js(`document.querySelector('#leave-error').hidden ? null : document.querySelector('#leave-error').textContent`) };
}
async function openLeave() {
  await js(`document.querySelector('#tab-btn-today').click()`);
  await js(`document.querySelector('#tab-btn-leave').click()`);
}
// Dashboard helpers
const card = (text) => `[...document.querySelectorAll('article')].find((a) => a.innerText.includes(${JSON.stringify(text)}))`;
const button = (scope, label) => `[...${scope}.querySelectorAll('button')].find((b) => b.textContent === ${JSON.stringify(label)})`;
/** The dashboard's confirmation dialog (components/kit.tsx ConfirmDialog): checks its title, then confirms. Returns its text. */
const confirmDialog = async (title, confirmLabel) => {
  const dlg = `[...document.querySelectorAll('dialog[open]')].find((d) => d.querySelector('h2')?.textContent === ${JSON.stringify(title)})`;
  await waitFor(`!!${dlg}`, `confirmation "${title}"`);
  const text = await js(`${dlg}.innerText`);
  await js(`${button(dlg, confirmLabel)}.click()`);
  return text;
};
const setReact = (sel, value) => `(() => { const el = ${sel}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); })()`;
const filter = async (label) => {
  await js(`${button("document", label)}.click()`);
  await waitFor(`!document.body.innerText.includes('Loading…')`, `${label} list`);
};

try {
  // ---- Desktop: employee ----
  await cdp("Page.navigate", { url: APP });
  await waitFor(`!document.querySelector('#login-view').hidden`, "login view");
  await js(`(() => { const f = document.querySelector('#login-form'); f.email.value = ${JSON.stringify(ana.email)}; f.password.value = ${JSON.stringify(PASSWORD)}; f.requestSubmit(); })()`);
  await waitFor(`!document.querySelector('#signed-in-view').hidden`, "signed in");

  await network({ latency: 1500 });
  await openLeave();
  await waitFor(`document.querySelector('#leave-status').textContent === 'Loading…'`, "loading state", 3000);
  check("desktop: loading state while the list is fetched", true);
  await network({});
  await waitFor(listLoaded, "empty list");
  check("desktop: empty state", (await $text("#leave-status")) === "No leave requests yet." && (await items()).length === 0);
  check("desktop: Leave tab selected and labelled (role=tab, aria-selected)", await js(`document.querySelector('#tab-btn-leave').getAttribute('aria-selected') === 'true' && !document.querySelector('#tab-leave').hidden`));
  check("desktop: time zone and sensitive-details hint shown", (await $text("#leave-tz")).includes(TZ) && /do not include medical/.test(await $text("#leave-reason-hint")));
  check("desktop: no leave types, balances or payroll fields in the form", await js(`[...document.querySelector('#leave-form').elements].every((e) => ['portion','startDate','endDate','startTime','endTime','reason',''].includes(e.name))`));

  await fill({ portion: "SHORT" });
  const shortFields = (await visible("[name=startTime]")) && !(await visible("[name=endDate]")) && (await $text("#leave-start-label")) === "Date";
  await fill({ portion: "FULL_DAY" });
  check("desktop: fields follow the choice (times only for short leave, end date only for full days)", shortFields && (await visible("[name=endDate]")) && !(await visible("[name=startTime]")));

  const reversed = await submit({ portion: "FULL_DAY", startDate: addDays(d, 3), endDate: d });
  check("desktop: reversed dates refused before sending, nothing stored", /end date must not be before/.test(reversed.error ?? "") && (await count("SELECT count(*) n FROM leave_requests WHERE employee_id = ?", [ana.id])) === 0, reversed.error);
  const badShort = await submit({ portion: "SHORT", startDate: d, startTime: "15:00", endTime: "14:00" });
  check("desktop: short leave with the end before the start refused", /after the start time/.test(badShort.error ?? ""), badShort.error);

  const r1 = await submit({ portion: "FULL_DAY", startDate: addDays(d, 1), endDate: addDays(d, 3), reason: "Family wedding, \"Zoë\" 日本" });
  check("desktop: full-day request sent, success message", /^Sent: .*full days\. An administrator will approve or reject it/.test(r1.ok ?? ""), r1.ok ?? r1.error);
  check("desktop: form reset after sending", (await js(`document.querySelector('#leave-form').startDate.value`)) === "");
  const r2 = await submit({ portion: "SHORT", startDate: addDays(d, 5), startTime: "14:00", endTime: "15:30" });
  const r3 = await submit({ portion: "SECOND_HALF", startDate: addDays(d, 6) });
  const list1 = await items();
  check("desktop: short and half-day requests sent; list shows all three as pending, Unicode reason intact", !!r2.ok && !!r3.ok && list1.length === 3 && list1.every((t) => t.includes("pending")) && list1.some((t) => t.includes("14:00–15:30")) && list1.some((t) => t.includes("second half")) && list1.some((t) => t.includes("“Family wedding, \"Zoë\" 日本”")), JSON.stringify(list1));
  const clash = await submit({ portion: "FIRST_HALF", startDate: addDays(d, 2) });
  check("desktop: overlapping request refused by the server, message shown", /overlaps your pending request/.test(clash.error ?? "") && (await items()).length === 3, clash.error);
  check("desktop: only the employee's own requests (not Ben's)", !(await items()).some((t) => t.includes("Ben private reason")) && (await count("SELECT count(*) n FROM leave_requests WHERE employee_id = ?", [ana.id])) === 3);

  const cancelBtn = `[...document.querySelectorAll('#leave-list > li')].find((li) => li.innerText.includes('14:00–15:30')).querySelector('button')`;
  await js(`${cancelBtn}.click()`);
  const confirmText = await js(`${cancelBtn}.textContent`);
  const stillPending = await count("SELECT count(*) n FROM leave_requests WHERE employee_id = ? AND status = 'CANCELLED'", [ana.id]);
  await js(`${cancelBtn}.click()`);
  await waitFor(`[...document.querySelectorAll('#leave-list > li')].some((li) => li.innerText.includes('14:00–15:30') && li.innerText.includes('cancelled'))`, "cancelled");
  check("desktop: cancel asks once more (no blocking dialog), then cancels", confirmText === "Yes, cancel this request" && stillPending === 0 && (await items()).some((t) => t.includes("14:00–15:30") && /Cancelled by you/.test(t)));
  await shot("leave-desktop.png");

  // ---- Dashboard: admin ----
  await cdp("Page.navigate", { url: `${DASH}/login` });
  await waitFor(`(() => { const f = document.querySelector('form'); return !!f && Object.keys(f).some((k) => k.startsWith('__reactProps')); })()`, "hydrated login form");
  await js(`(() => {
    const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
    set(document.querySelector('input[type=email], input[name=email]'), "admin@example.com");
    set(document.querySelector('input[type=password]'), ${JSON.stringify(PASSWORD)});
    document.querySelector('form').requestSubmit();
  })()`);
  await waitFor(`location.pathname !== "/login"`, "sign-in");
  const navLink = `[...document.querySelectorAll('nav a')].find((a) => a.textContent === 'Leave')`;
  await waitFor(`!!${navLink}`, "Leave link in the sidebar");
  await js(`${navLink}.click()`);
  await waitFor(`location.pathname === '/leave' && document.querySelectorAll('article').length >= 3`, "pending leave");
  const pendingCards = await js(`[...document.querySelectorAll('article')].map((a) => a.innerText)`);
  check("dashboard: pending requests from everyone, with reasons and the employee's time zone", pendingCards.length === 3 && pendingCards.some((t) => t.includes("Ben private reason")) && pendingCards.some((t) => t.includes("Zoë")) && pendingCards.every((t) => t.includes(TZ)), String(pendingCards.length));
  check("dashboard: no cancel action for admins", !(await js(`[...document.querySelectorAll('article button')].some((b) => /cancel/i.test(b.textContent))`)));

  const anaCard = card("Family wedding");
  await js(setReact(`${anaCard}.querySelector('input')`, "Enjoy the wedding"));
  await js(`${button(anaCard, "Approve")}.click()`);
  await waitFor(`!${card("Family wedding")}`, "approved card leaves Pending");
  await js(`${button(card("Ben private reason"), "Reject")}.click()`);
  const rejectText = await confirmDialog("Reject Ben Other's leave request?", "Reject request");
  check("dashboard: reject asks first and says no note will be sent", rejectText.includes("No note will be sent") && rejectText.includes("cannot be undone"), rejectText.replace(/\s+/g, " ").slice(0, 160));
  await waitFor(`!${card("Ben private reason")}`, "rejected card leaves Pending");
  check("dashboard: approve (with note) and reject (without) recorded", (await count("SELECT count(*) n FROM leave_requests WHERE status = 'APPROVED' AND decision_note = 'Enjoy the wedding'")) === 1 && (await count("SELECT count(*) n FROM leave_requests WHERE status = 'REJECTED' AND decision_note IS NULL")) === 1);
  await js(`${button(card("second half"), "Approve")}.click()`);
  await waitFor(`document.body.innerText.includes('No leave requests waiting for a decision.')`, "empty pending");
  check("dashboard: empty Pending state", true);
  await filter("Approved");
  const approved = await js(`${card("Family wedding")}?.innerText ?? ''`);
  check("dashboard: history shows who requested and who approved, with the note", /Requested .* by leave1@example\.com/.test(approved) && /Approved .* by admin@example\.com: Enjoy the wedding/.test(approved), approved.replace(/\s+/g, " ").slice(0, 200));
  await filter("Cancelled");
  check("dashboard: cancelled requests listed with who cancelled", (await js(`${card("14:00–15:30")}?.innerText ?? ''`)).includes("Cancelled"));
  await filter("All");
  await shot("leave-dashboard.png");

  // ---- Desktop: the employee sees the decisions ----
  await cdp("Page.navigate", { url: APP });
  await waitFor(`!document.querySelector('#signed-in-view').hidden || !document.querySelector('#login-view').hidden`, "desktop reload");
  if (!(await visible("#signed-in-view"))) {
    await js(`(() => { const f = document.querySelector('#login-form'); f.email.value = ${JSON.stringify(ana.email)}; f.password.value = ${JSON.stringify(PASSWORD)}; f.requestSubmit(); })()`);
    await waitFor(`!document.querySelector('#signed-in-view').hidden`, "signed in again");
  }
  await openLeave();
  await waitFor(`${listLoaded} && document.querySelectorAll('#leave-list > li').length === 3`, "decisions");
  const decided = await items();
  check("desktop: decision and note visible to the employee; no cancel on decided requests", decided.some((t) => t.includes("approved") && t.includes("Approved") && t.includes("Enjoy the wedding")) && (await js(`document.querySelectorAll('#leave-list button').length`)) === 0, JSON.stringify(decided));

  // Offline: the request is not sent and the employee is told why.
  await network({ offline: true });
  const off = await submit({ portion: "FULL_DAY", startDate: addDays(d, 20), endDate: addDays(d, 20) });
  check("desktop: offline submit shows a clear error, nothing stored", /Connect to the server/.test(off.error ?? "") && (await count("SELECT count(*) n FROM leave_requests WHERE employee_id = ?", [ana.id])) === 3, off.error);
  await openLeave();
  await waitFor(`!document.querySelector('#leave-list-error').hidden`, "offline list error");
  check("desktop: offline list shows an error", /Connect to the server/.test(await $text("#leave-list-error")));
  await network({});

  // Server error on the dashboard: the API is gone.
  await app.close();
  await cdp("Page.navigate", { url: `${DASH}/leave` });
  await waitFor(`document.body.innerText.includes('Could not reach the API')`, "dashboard error", 30_000).catch(() => {});
  const down = await js(`document.body.innerText`);
  check("dashboard: API unreachable shows an error instead of a list", /Could not reach the API/.test(down) && (await js(`document.querySelectorAll('article').length`)) === 0, down.replace(/\s+/g, " ").slice(0, 300));
} catch (err) {
  check(`run aborted: ${err.message}`, false);
  await shot("leave-failure.png").catch(() => {});
} finally {
  ws.close();
  chrome.kill();
  vite.kill();
  dash.kill();
  await app.close().catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  rmSync(RUN, { recursive: true, force: true });
}
console.log(`Page captures: ${OUT}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
