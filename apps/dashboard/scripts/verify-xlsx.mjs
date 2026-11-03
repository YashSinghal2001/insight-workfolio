// W39 browser check: holiday import from an .xlsx file through the real file input on /holidays.
// A throwaway API (temporary file DB) on :4214, `next dev` on :3214, headless Chrome over CDP on :9514.
// Synthetic data only. Run after `pnpm build:packages && pnpm --filter @workfolio/api build`; needs
// Google Chrome (macOS path). Usage: node apps/dashboard/scripts/verify-xlsx.mjs [out-dir]
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { crc32, deflateRawSync } from "node:zlib";

const ROOT = resolve(import.meta.dirname, "../../..");
const API_PORT = 4214, WEB_PORT = 3214, CDP_PORT = 9514;
const WEB = `http://localhost:${WEB_PORT}`;
const DEV_NOTICE = /Could not validate that a segment in your UI has instant navigation/;
const OUT = process.argv[2] ?? mkdtempSync(join(tmpdir(), "wf-verify-xlsx-"));
const RUN = join(OUT, "run");
rmSync(RUN, { recursive: true, force: true });
mkdirSync(join(RUN, "shots"), { recursive: true });
Object.assign(process.env, {
  NODE_ENV: "development", LOG_LEVEL: "warn", PORT: String(API_PORT),
  DATABASE_URL: `file:${join(RUN, "xlsx.db")}`,
  JWT_SECRET: "xlsx-check-secret-xlsx-check-secret-1",
  SCREENSHOT_STORAGE: "local", SCREENSHOT_LOCAL_DIR: join(RUN, "shots"),
  CORS_ORIGINS: WEB, DASHBOARD_URL: WEB,
});
const results = [];
const check = (name, ok, detail = "") => (results.push({ name, ok: !!ok }), console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = [];
const PASSWORD = "xlsx import check password 1";

/** Minimal .xlsx (DEFLATE ZIP): first sheet → worksheets/data.xml via rId3, with shared strings. */
function xlsx(rows, shared) {
  const files = {
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns:r="r"><workbookPr/><sheets><sheet name="Holidays" sheetId="1" r:id="rId3"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships><Relationship Id="rId3" Target="worksheets/data.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `<sst>${shared.map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`,
    "xl/worksheets/data.xml": `<worksheet><sheetData>${rows.map((c, i) => `<row r="${i + 1}">${c}</row>`).join("")}</sheetData></worksheet>`,
  };
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text), data = deflateRawSync(raw), n = Buffer.from(name);
    const l = Buffer.alloc(30), c = Buffer.alloc(46);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(8, 8); l.writeUInt32LE(crc32(raw), 14);
    l.writeUInt32LE(data.length, 18); l.writeUInt32LE(raw.length, 22); l.writeUInt16LE(n.length, 26);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc32(raw), 16);
    c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    locals.push(l, n, data); centrals.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(files).length, 8); e.writeUInt16LE(Object.keys(files).length, 10);
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, e]);
}
const serial = (ymd) => (Date.parse(`${ymd}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000;
const inline = (ref, s) => `<c r="${ref}" t="inlineStr"><is><t>${s}</t></is></c>`;

try {
  // ---- API -------------------------------------------------------------------------------------
  const req = createRequire(`${ROOT}/apps/api/package.json`);
  req("reflect-metadata");
  const { NestFactory } = req("@nestjs/core");
  const { AppModule } = await import(`${ROOT}/apps/api/dist/app.module.js`);
  const { configureApp } = await import(`${ROOT}/apps/api/dist/app.setup.js`);
  const { DATABASE } = await import(`${ROOT}/apps/api/dist/database/database.module.js`);
  const { hashPassword } = await import(`${ROOT}/apps/api/dist/auth/crypto.js`);
  const app = await NestFactory.create(AppModule, { logger: ["error", "warn"] });
  configureApp(app);
  await app.listen(API_PORT);
  cleanup.push(() => app.close());
  const db = app.get(DATABASE);
  await db.execute({ sql: "INSERT INTO users (id, email, role, password_hash) VALUES (?, 'admin@example.com', 'ADMIN', ?)", args: [randomUUID(), await hashPassword(PASSWORD)] });
  const login = await fetch(`http://localhost:${API_PORT}/api/v1/auth/login`, { method: "POST", headers: { origin: WEB, "content-type": "application/json" }, body: JSON.stringify({ email: "admin@example.com", password: PASSWORD }) });
  const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const holidays = (year) => fetch(`http://localhost:${API_PORT}/api/v1/holidays?year=${year}`, { headers: { origin: WEB, cookie } }).then((r) => r.json());

  // ---- Fixtures --------------------------------------------------------------------------------
  const Y = new Date().getUTCFullYear() + 1;
  const good = join(RUN, "holidays.xlsx");
  writeFileSync(good, xlsx([
    `<c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>`, // header
    `<c r="A2" s="1"><v>${serial(`${Y}-01-01`)}</v></c><c r="B2" t="s"><v>2</v></c>`, // date cell (serial)
    `${inline("A3", `${Y}-08-15`)}${inline("B3", "Independence Day")}`, // ISO text
    `${inline("A4", `25/12/${Y}`)}<c r="B4" t="s"><v>3</v></c>`, // d/m/yyyy text, name with comma
  ], ["Date", "Holiday", "New Year", "Christmas Day, office"]));
  const bad = join(RUN, "bad.xlsx");
  writeFileSync(bad, xlsx([`${inline("A1", `3/4/${Y}`)}${inline("B1", "Ambiguous")}`, `${inline("A2", "someday")}${inline("B2", "Not a date")}`], []));
  const old = join(RUN, "old.xls");
  writeFileSync(old, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]));

  // ---- Dashboard + Chrome ----------------------------------------------------------------------
  const dash = spawn("pnpm", ["exec", "next", "dev", "--port", String(WEB_PORT)], {
    cwd: `${ROOT}/apps/dashboard`, stdio: "ignore", detached: true,
    env: { ...process.env, NODE_ENV: "development", NEXT_PUBLIC_API_URL: `http://localhost:${API_PORT}` },
  });
  cleanup.push(() => { try { process.kill(-dash.pid, "SIGTERM"); } catch {} });
  const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(RUN, "chrome")}`, "--window-size=1440,1000", "--no-first-run", "about:blank"], { stdio: "ignore" });
  cleanup.push(() => chrome.kill("SIGKILL"));
  let target;
  for (let i = 0; i < 150 && !target; i++) {
    await sleep(200);
    target = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json(), () => null);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  cleanup.unshift(() => ws.close());
  let seq = 0;
  const pending = new Map();
  let problems = [];
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) return void (pending.get(msg.id)(msg), pending.delete(msg.id));
    const p = msg.params;
    if (msg.method === "Runtime.consoleAPICalled" && p.type === "error") problems.push(`console.error: ${p.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300)}`);
    if (msg.method === "Runtime.exceptionThrown") problems.push(`exception: ${(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text).slice(0, 300)}`);
  });
  const cdp = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result))); ws.send(JSON.stringify({ id, method, params })); });
  const js = async (expr) => {
    const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor = async (expr, label, ms = 60_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) if (await js(expr).catch(() => false)) return true;
    throw new Error(`timed out waiting for ${label}`);
  };
  const main = `(document.querySelector("main")?.innerText ?? "")`;
  const expect = async (name, expr, ms = 20_000) => {
    try {
      await waitFor(expr, name, ms);
      check(name, true);
    } catch {
      check(name, false, (await js(main).catch(() => "")).replace(/\s+/g, " ").slice(0, 400));
    }
  };
  const setValue = (selector, value) => js(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  const button = (label) => `[...document.querySelectorAll("main button")].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;
  const choose = async (path) => {
    const { result } = await cdp("Runtime.evaluate", { expression: "document.querySelector('main input[type=file]')" });
    await cdp("DOM.setFileInputFiles", { files: [path], objectId: result.objectId });
  };
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("DOM.enable");

  let up = false;
  for (let i = 0; i < 300 && !up; i++) {
    up = await fetch(`${WEB}/login`).then((r) => r.ok, () => false);
    if (!up) await sleep(500);
  }
  check("dashboard served by next dev", up);
  await cdp("Page.navigate", { url: `${WEB}/login` });
  await waitFor(`(() => { const f = document.querySelector('form'); return !!f && Object.keys(f).some((k) => k.startsWith('__reactProps')); })()`, "hydrated login form", 120_000);
  await setValue("input[type=email], input[name=email]", "admin@example.com");
  await setValue("input[type=password]", PASSWORD);
  await js("document.querySelector('form').requestSubmit()");
  await waitFor(`location.pathname !== "/login"`, "sign-in");

  await cdp("Page.navigate", { url: `${WEB}/holidays` });
  problems = [];
  await waitFor(`${main}.includes("Import from a CSV or Excel file") && !!document.querySelector("main input[type=file]")`, "/holidays", 90_000);
  const accept = await js(`document.querySelector("main input[type=file]").accept`);
  check("file input accepts .csv and .xlsx (and .xls, to explain the refusal)", /\.csv/.test(accept) && /\.xlsx/.test(accept), accept);

  await choose(old);
  await expect("an old .xls file is refused with a clear message", `${main}.includes("This is an old .xls (Excel 97–2003) file") && ${button("Import")}?.disabled`);
  await choose(bad);
  await expect("a bad .xlsx lists per-row errors and enables nothing", `${main}.includes("Row 1: \\"3/4/${Y}\\" is ambiguous") && ${main}.includes("Row 2: \\"someday\\" is not a date") && ${button("Import")}?.disabled`);
  await choose(good);
  await expect("a good .xlsx (header, date cell, ISO text, d/m/yyyy text, shared + inline strings) is ready to import 3", `${button("Import 3 holidays")} && !${button("Import 3 holidays")}.disabled`);
  await js(`${button("Import 3 holidays")}.click()`);
  await expect("import from the page succeeds (3 created)", `${main}.includes("Imported 3 holidays.")`);
  await setValue("main input[type=number]", String(Y));
  await expect(`the ${Y} list shows the imported holidays`, `["New Year", "Independence Day", "Christmas Day, office"].every((n) => (document.querySelector('table[aria-label="Holidays"]')?.innerText ?? "").includes(n))`);
  const stored = (await holidays(Y)).map((h) => `${h.date} ${h.name}`).join(" | ");
  check("the API stored exactly the three holidays", stored === `${Y}-01-01 New Year | ${Y}-08-15 Independence Day | ${Y}-12-25 Christmas Day, office`, stored);
  writeFileSync(join(OUT, "w39-xlsx-import.png"), Buffer.from((await cdp("Page.captureScreenshot", { format: "png" })).data, "base64"));

  const again = join(RUN, "holidays-again.xlsx"); // a new path: picking the same path again fires no change event
  writeFileSync(again, xlsx([`<c r="A1"><v>${serial(`${Y}-01-01`)}</v></c>${inline("B1", "New Year")}`, `${inline("A2", `${Y}-08-15`)}${inline("B2", "Independence Day")}`, `${inline("A3", `25/12/${Y}`)}${inline("B3", "Christmas")}`], []));
  await choose(again);
  await waitFor(`${button("Import 3 holidays")} && !${button("Import 3 holidays")}.disabled`, "re-import ready");
  await js(`${button("Import 3 holidays")}.click()`);
  await expect("re-importing the same dates (another .xlsx) skips all three", `${main}.includes("Imported 0 holidays; skipped 3 date(s)")`);
  check("still three holidays stored", (await holidays(Y)).length === 3);

  await sleep(600);
  const p = problems.filter((x) => !DEV_NOTICE.test(x));
  check("/holidays: no console errors", p.length === 0, p.join(" | "));
} catch (err) {
  check("run completed", false, err?.stack ?? String(err));
} finally {
  for (const fn of cleanup.reverse()) await Promise.resolve().then(fn).catch(() => {});
  await sleep(500);
  rmSync(RUN, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshot: ${OUT}`);
process.exit(failed.length ? 1 : 0);
