// F11 with TWO API processes on ONE database file (local libSQL/SQLite, file locking between
// processes). Each instance has its own in-process lock, so only the database can keep one running
// timer per employee. Two sign-ins ("two devices") of the same employee hit both instances at once.
// Limitation: this is SQLite file locking on one host, not remote Turso; see docs/project-time.md.
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const ORIGIN = "http://localhost:3000";
const DIR = mkdtempSync(join(tmpdir(), "wf-multi-"));
const env = { ...process.env, NODE_ENV: "development", LOG_LEVEL: "warn", DATABASE_URL: `file:${join(DIR, "shared.db")}`, JWT_SECRET: randomBytes(32).toString("hex"), REPORT_SCHEDULER_SECONDS: "0", SCREENSHOT_LOCAL_DIR: join(DIR, "shots"), TIMELAPSE_DIR: join(DIR, "videos") };
const procs: ChildProcess[] = [];
const bases: string[] = [];
let admin = "";
let devices: { bearer: string; base: string }[] = [];
let tasks: string[] = [];
let device = "";
let employeeId = "";
const serverErrors: string[] = [];

const freePort = () => new Promise<number>((r) => { const s = createServer().listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });
async function call(base: string, path: string, { method = "GET", body, cookie, bearer, headers = {} }: { method?: string; body?: unknown; cookie?: string; bearer?: string; headers?: Record<string, string> } = {}) {
  const h: Record<string, string> = { origin: ORIGIN, ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  if (cookie) h.cookie = cookie;
  if (bearer) h.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (process.env.WF_DEBUG) process.stdout.write(`${method} ${path} ${res.status} ${text.slice(0, 160)}\n`);
  if (res.status >= 500) serverErrors.push(`${method} ${path}: ${res.status} ${text}`);
  return { status: res.status, body: text ? JSON.parse(text) : undefined, res };
}
const db = (sql: string) => JSON.parse(execFileSync("node", ["--input-type=module", "-e", `import { createClient } from "@libsql/client"; const c = createClient({ url: ${JSON.stringify(env.DATABASE_URL)} }); console.log(JSON.stringify((await c.execute(${JSON.stringify(sql)})).rows));`], { cwd: join(import.meta.dirname, "../../../packages/database"), encoding: "utf8" }));
const entries = () => db(`SELECT id, task_id, started_at, ended_at, end_reason FROM task_time_entries WHERE employee_id = '${employeeId}' ORDER BY started_at`) as { id: string; task_id: string; started_at: string; ended_at: string | null; end_reason: string | null }[];
const attend = (i: number, action: string) => call(devices[i]!.base, `/attendance/${action}`, { method: "POST", bearer: devices[i]!.bearer, headers: { "x-device-id": device, "idempotency-key": randomUUID() } });
const start = (i: number, taskId: string) => call(devices[i]!.base, "/task-time/start", { method: "POST", bearer: devices[i]!.bearer, body: { taskId } });
const stop = (i: number, id: string) => call(devices[i]!.base, `/task-time/${id}/stop`, { method: "POST", bearer: devices[i]!.bearer });

before(async () => {
  // Instance 1 migrates; instance 2 starts on the same file once it is ready.
  for (let n = 0; n < 2; n++) {
    const port = await freePort();
    const p = spawn("node", [join(import.meta.dirname, "../dist/main.js")], { env: { ...env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [p.stdout!, p.stderr!]) {
      stream.on("data", (d) => {
        if (process.env.WF_DEBUG) process.stdout.write(`[api${n}] ${String(d).slice(0, 800)}`);
        if (/"level":50|error/i.test(String(d))) serverErrors.push(String(d).slice(0, 300));
      });
    }
    procs.push(p);
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 80 && !(await fetch(`${base}/api/v1/ready`).then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 250));
    bases.push(base);
  }
  const cli = execFileSync("node", [join(import.meta.dirname, "../dist/cli/create-admin.js"), "--email", "admin@multi.local"], { env, encoding: "utf8" });
  const pw = randomBytes(12).toString("hex");
  await call(bases[0]!, "/auth/setup-password", { method: "POST", body: { token: cli.match(/#token=(\S+)/)![1], password: pw } });
  admin = (await call(bases[1]!, "/auth/login", { method: "POST", body: { email: "admin@multi.local", password: pw } })).res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const e = await call(bases[0]!, "/employees", { method: "POST", cookie: admin, body: { email: "multi@multi.local", employeeCode: "MI-1", fullName: "Multi Instance", timezone: "UTC" } });
  employeeId = e.body.employee.id;
  await call(bases[0]!, "/auth/setup-password", { method: "POST", body: { token: e.body.setup.token, password: pw } });
  // Two sign-ins of the same employee ("two devices"), one per instance.
  devices = await Promise.all(bases.map(async (base) => ({ base, bearer: (await call(base, "/auth/login", { method: "POST", body: { email: "multi@multi.local", password: pw, client: "desktop" } })).body.accessToken as string })));
  device = randomUUID();
  await call(bases[0]!, "/devices/register", { method: "POST", bearer: devices[0]!.bearer, body: { installationId: device, deviceName: "Mac", platform: "macos" } });
  const p = await call(bases[1]!, "/projects", { method: "POST", cookie: admin, body: { code: "MULTI", name: "Multi" } });
  for (const title of ["One", "Two"]) await call(bases[0]!, `/projects/${p.body.id}/tasks`, { method: "POST", cookie: admin, body: { title } });
  await call(bases[1]!, `/projects/${p.body.id}/members`, { method: "POST", cookie: admin, body: { employeeId } });
  tasks = (await call(bases[0]!, "/projects", { cookie: admin })).body[0].tasks.map((t: { id: string }) => t.id);
  assert.equal((await attend(0, "clock-in")).status, 200);
});
after(() => procs.forEach((p) => p.kill()));

test("two instances, two devices, different tasks at the same moment: one timer runs, the other request is refused (20 rounds)", async () => {
  for (let round = 0; round < 20; round++) {
    const r = await Promise.all([start(0, tasks[0]!), start(1, tasks[1]!)]);
    assert.deepEqual(r.map((x) => x.status).sort(), [200, 409], `round ${round}: ${r.map((x) => `${x.status} ${JSON.stringify(x.body).slice(0, 80)}`).join(" | ")}`);
    const open = entries().filter((x) => !x.ended_at);
    assert.equal(open.length, 1, `round ${round}: one running timer`);
    assert.equal((await stop(round % 2, open[0]!.id)).status, 200);
  }
  assert.deepEqual(serverErrors, [], "no 5xx or server errors under contention");
});

test("the same start sent to both instances returns the same timer (no duplicate)", async () => {
  for (let round = 0; round < 10; round++) {
    const r = await Promise.all([start(0, tasks[0]!), start(1, tasks[0]!)]);
    assert.deepEqual(r.map((x) => x.status), [200, 200], JSON.stringify(r.map((x) => x.body)));
    assert.equal(r[0]!.body.id, r[1]!.body.id);
    assert.equal(entries().filter((x) => !x.ended_at).length, 1);
    await stop(0, r[0]!.body.id);
  }
});

test("two stops at the same moment: exactly one succeeds; the entry ends once", async () => {
  for (let round = 0; round < 10; round++) {
    const s = (await start(0, tasks[1]!)).body;
    const r = await Promise.all([stop(0, s.id), stop(1, s.id)]);
    assert.deepEqual(r.map((x) => x.status).sort(), [200, 409], JSON.stringify(r.map((x) => x.body)));
    const row = entries().find((x) => x.id === s.id)!;
    const winner = r.find((x) => x.status === 200)!.body;
    assert.equal(row.ended_at, winner.endedAt, "the stored end is the one reported as successful");
  }
});

test("break or clock-out racing a stop: ended exactly once; never after the recorded break or clock-out beyond the race window", async () => {
  const overlaps: number[] = [];
  for (const [i, action] of [[0, "break/start"], [1, "break/start"], [0, "clock-out"]] as const) {
    const s = (await start(1, tasks[0]!)).body;
    const [att, st] = await Promise.all([attend(i, action), stop(1 - i, s.id)]);
    assert.equal(att.status, 200, `${action} recorded`);
    // Read through the API so a timer ended by the break/clock-out is closed now.
    await call(bases[i]!, "/task-time/current", { bearer: devices[i]!.bearer });
    const row = entries().find((x) => x.id === s.id)!;
    const marker = action === "clock-out"
      ? db(`SELECT clock_out_at AS t FROM attendance_sessions WHERE employee_id = '${employeeId}' ORDER BY clock_in_at DESC LIMIT 1`)[0].t
      : db(`SELECT b.started_at AS t FROM break_sessions b JOIN attendance_sessions a ON a.id = b.attendance_session_id WHERE a.employee_id = '${employeeId}' ORDER BY b.started_at DESC LIMIT 1`)[0].t;
    assert.ok(row.ended_at && ["STOPPED", "BREAK", "CLOCK_OUT"].includes(row.end_reason!), JSON.stringify(row));
    assert.ok(st.status === 200 || st.status === 409, `stop: ${st.status}`);
    if (st.status === 409) assert.equal(row.ended_at, marker, "ended by the break/clock-out at its recorded time");
    overlaps.push(Date.parse(row.ended_at!) - Date.parse(marker));
    if (action === "break/start") assert.equal((await attend(i, "break/end")).status, 200);
  }
  // A stop that committed first may end a few milliseconds after the break/clock-out timestamp.
  assert.ok(overlaps.every((ms) => ms < 1000), `time counted after the break/clock-out: ${overlaps.join(", ")} ms`);
  process.stdout.write(`  break/clock-out vs stop: end minus marker = ${overlaps.join(", ")} ms\n`);
  assert.equal((await start(0, tasks[0]!)).status, 409, "clocked out: no new timer on either instance");
  assert.equal((await start(1, tasks[1]!)).status, 409);
});

test("integrity after all races: one entry ends once, no overlapping entries, nothing running, no server errors", () => {
  const all = entries();
  assert.equal(all.length, 20 + 10 + 10 + 3, "one entry per successful start");
  assert.ok(all.every((x) => x.ended_at && x.end_reason && x.ended_at >= x.started_at));
  for (let k = 1; k < all.length; k++) assert.ok(all[k]!.started_at >= all[k - 1]!.ended_at!, `overlap: ${JSON.stringify(all[k - 1])} / ${JSON.stringify(all[k])}`);
  assert.deepEqual(serverErrors, []);
});
