// Staging integration suite (DEP-13): 12 black-box checks against a running API over HTTP(S).
//
//   BASE_API_URL=https://api-staging.<domain> DASHBOARD_URL=https://app-staging.<domain> \
//   STAGING_ADMIN_EMAIL=… STAGING_ADMIN_PASSWORD=… STAGING_EMPLOYEE_EMAIL=… STAGING_EMPLOYEE_PASSWORD=… \
//     pnpm --filter @workfolio/api staging:suite
//
// Credentials come only from the environment and are never printed (nor are tokens or cookies).
// The admin must be able to manage settings, employees, devices and screenshots; the employee should be a
// dedicated synthetic suite account (it is clocked in/out and gets activity + screenshots).
// Shared-DB safety: every record is tagged with a run id (app name, device name, reasons). The suite deletes
// what the API allows (screenshots, timelapse, device → revoked, sessions → logged out) and restores the
// screenshot policy it temporarily changes. Append-only records stay by design: attendance sessions, activity
// intervals, consents, audit rows, DELETED screenshot rows.
// Nothing destructive is run: retention is checked via its dry-run previews only.
// Checks needing HTTPS (HSTS, Secure cookies, dashboard headers) SKIP on http:// with the reason.
// Exit: 0 all 12 passed, 1 a check failed, 2 missing configuration (nothing contacted), 3 no failure but skips.
import { createHash, randomUUID } from "node:crypto";

const env = process.env;
const missing = ["BASE_API_URL", "DASHBOARD_URL", "STAGING_ADMIN_EMAIL", "STAGING_ADMIN_PASSWORD", "STAGING_EMPLOYEE_EMAIL", "STAGING_EMPLOYEE_PASSWORD"].filter((k) => !env[k]);
if (missing.length) {
  console.error(`BLOCKED: set ${missing.join(", ")} (values are never printed)`);
  process.exit(2);
}
const BASE = env.BASE_API_URL.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
const DASH = new URL(env.DASHBOARD_URL).origin;
const HTTPS = BASE.startsWith("https://");
const RUN = `suite-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}-${randomUUID().slice(0, 8)}`;
const TIMELAPSE_WAIT_MS = Number(env.SUITE_TIMELAPSE_WAIT_SECONDS ?? 120) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString();

// ---- HTTP -----------------------------------------------------------------------------------
async function api(path, { method = "GET", body, raw, cookie, bearer, device, origin = DASH, headers: extra = {} } = {}) {
  const headers = { ...extra };
  if (origin) headers.origin = origin;
  if (body !== undefined) headers["content-type"] = "application/json";
  if (raw) headers["content-type"] = "image/webp";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (device) headers["x-device-id"] = device;
  const url = path.startsWith("http") ? path : `${BASE}/api/v1${path}`;
  const res = await fetch(url, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: "manual", signal: AbortSignal.timeout(30_000) });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  let json;
  if ((res.headers.get("content-type") ?? "").includes("json") && text) json = JSON.parse(text);
  return { status: res.status, body: json, bytes, h: res.headers, res, msg: `${res.status} ${json?.message ?? ""}`.trim() };
}
const cookiesOf = (r) => r.res.headers.getSetCookie();
const jar = (r) => cookiesOf(r).map((c) => c.split(";")[0]).join("; ");

class Skip extends Error {}
const ok = (cond, what) => {
  if (!cond) throw new Error(what);
};
const want = (r, status, what) => ok(r.status === status, `${what}: expected ${status}, got ${r.msg}`);

// ---- State shared by checks and cleanup --------------------------------------------------------
const S = { admin: null, emp: null, empId: null, device: randomUUID(), deviceId: null, sessionId: null, shots: [], timelapseId: null, origSettings: null, notes: [] };
const actHeaders = () => ({ "idempotency-key": randomUUID() });
const act = (path) => api(`/attendance/${path}`, { method: "POST", bearer: S.emp.accessToken, device: S.device, headers: actHeaders() });
const current = async () => (await api("/attendance/current", { bearer: S.emp.accessToken })).body;

async function loginAdmin() {
  const r = await api("/auth/login", { method: "POST", body: { email: env.STAGING_ADMIN_EMAIL, password: env.STAGING_ADMIN_PASSWORD } });
  want(r, 200, "admin login");
  return { cookie: jar(r), r };
}
async function loginEmployee() {
  const r = await api("/auth/login", { method: "POST", body: { email: env.STAGING_EMPLOYEE_EMAIL, password: env.STAGING_EMPLOYEE_PASSWORD, client: "desktop" } });
  want(r, 200, "employee login");
  return r.body; // { accessToken, refreshToken, user }
}
async function ensureClockedIn() {
  if ((await current()).state === "CLOCKED_OUT") want(await act("clock-in"), 200, "clock-in");
  const c = await current();
  ok(c.state === "CLOCKED_IN", `expected CLOCKED_IN, got ${c.state}`);
  S.sessionId = c.session.id;
  return Date.parse(c.session.clockInAt ?? c.serverTime);
}

/** A real 1x1 lossless WebP: decodable by FFmpeg, so the timelapse check can encode it (the API itself never decodes). */
const WEBP_1X1 = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");

// ---- The 12 checks -------------------------------------------------------------------------------
const checks = [
  ["health-ready", "Liveness /health and readiness /ready (database + storage)", async () => {
    const h = await api("/health", { origin: null });
    want(h, 200, "/health");
    ok(h.body?.status === "ok", "/health status is not ok");
    const r = await api("/ready", { origin: null });
    want(r, 200, `/ready (${JSON.stringify(r.body?.checks ?? r.body)})`);
    return `health ok, ready ${JSON.stringify(r.body?.checks ?? {})}`;
  }],

  ["security-headers", "API security headers on public, authenticated and error responses", async () => {
    const targets = [await api("/health", { origin: null }), await api("/auth/me", { cookie: S.admin }), await api(`/no-such-route-${RUN}`, { origin: null })];
    for (const r of targets) {
      ok(r.h.get("cache-control")?.includes("no-store"), `cache-control on ${r.status}`);
      ok(r.h.get("x-content-type-options") === "nosniff", `x-content-type-options on ${r.status}`);
      ok(r.h.get("referrer-policy") === "no-referrer", `referrer-policy on ${r.status}`);
      ok(r.h.get("x-frame-options") === "DENY", `x-frame-options on ${r.status}`);
      ok(!r.h.has("x-powered-by"), `x-powered-by present on ${r.status}`);
    }
    return "no-store, nosniff, no-referrer, DENY, no x-powered-by on 200/200/404";
  }],

  ["https-hsts", "HTTPS only: HSTS on API and dashboard, Secure cookies, dashboard security headers", async () => {
    if (!HTTPS) throw new Skip(`BASE_API_URL is ${new URL(BASE).protocol}//: HSTS/Secure cookies are only sent over HTTPS (production mode)`);
    const h = await api("/health", { origin: null });
    ok(/max-age=\d{7,}/.test(h.h.get("strict-transport-security") ?? ""), "API strict-transport-security missing or max-age < 1e6");
    const { r } = await loginAdmin();
    for (const c of cookiesOf(r)) ok(/;\s*secure/i.test(c), `cookie ${c.split("=")[0]} is not Secure`);
    await api("/auth/logout", { method: "POST", cookie: jar(r), body: {} });
    if (!DASH.startsWith("https://")) throw new Error("DASHBOARD_URL must be https:// when the API is");
    const d = await fetch(`${DASH}/login`, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    ok(d.status < 500, `dashboard /login answered ${d.status}`);
    ok(/max-age=\d{7,}/.test(d.headers.get("strict-transport-security") ?? ""), "dashboard strict-transport-security missing");
    ok(d.headers.get("x-frame-options") || /frame-ancestors/.test(d.headers.get("content-security-policy") ?? ""), "dashboard has no framing protection");
    return "API + dashboard HSTS, Secure cookies, dashboard framing protection";
  }],

  ["cors-csrf", "CORS for the real dashboard origin; foreign origin gets no grant and 403 on writes", async () => {
    const pre = await api("/auth/login", { method: "OPTIONS", headers: { "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
    ok(pre.status < 300, `preflight from ${DASH}: ${pre.status}`);
    ok(pre.h.get("access-control-allow-origin") === DASH, `preflight allow-origin is ${pre.h.get("access-control-allow-origin")}, expected ${DASH}`);
    ok(pre.h.get("access-control-allow-credentials") === "true", "preflight does not allow credentials");
    const me = await api("/auth/me", { cookie: S.admin });
    ok(me.h.get("access-control-allow-origin") === DASH, "credentialed GET lacks allow-origin");
    const evil = "https://evil.example";
    const ePre = await api("/auth/login", { method: "OPTIONS", origin: evil, headers: { "access-control-request-method": "POST" } });
    ok(!ePre.h.has("access-control-allow-origin"), `foreign origin got allow-origin ${ePre.h.get("access-control-allow-origin")}`);
    want(await api("/auth/login", { method: "POST", origin: evil, body: { email: "x@example.com", password: "x" } }), 403, "foreign-origin POST (CSRF)");
    want(await api("/attendance/clock-in", { method: "POST", origin: evil, cookie: S.admin, body: {} }), 403, "foreign-origin cookie write");
    return `${DASH} allowed with credentials; ${evil} no grant, writes 403${HTTPS ? "" : " (local origin, not the staging one)"}`;
  }],

  ["auth", "Login, cookie flags, /auth/me, wrong password, logout revokes the session", async () => {
    want(await api("/employees", { origin: null }), 401, "unauthenticated /employees");
    want(await api("/auth/login", { method: "POST", body: { email: env.STAGING_ADMIN_EMAIL, password: `wrong-${RUN}` } }), 401, "wrong password");
    const { cookie, r } = await loginAdmin();
    const flags = cookiesOf(r);
    ok(flags.length >= 2, "expected access + refresh cookies");
    for (const c of flags) ok(/;\s*httponly/i.test(c) && /;\s*samesite=strict/i.test(c), `cookie ${c.split("=")[0]} lacks HttpOnly/SameSite=Strict`);
    const me = await api("/auth/me", { cookie });
    want(me, 200, "/auth/me");
    ok(me.body.user.email === env.STAGING_ADMIN_EMAIL.toLowerCase(), "/auth/me returned another user");
    want(await api("/auth/logout", { method: "POST", cookie, body: {} }), 204, "logout");
    want(await api("/auth/me", { cookie }), 401, "old cookie after logout");
    const e = await api("/auth/me", { bearer: S.emp.accessToken });
    want(e, 200, "employee bearer /auth/me");
    ok(e.body.employee?.id, "employee account has no employee record");
    return "401 unauth/wrong password, HttpOnly+SameSite=Strict, logout → 401";
  }],

  ["rbac-isolation", "Employee denied admin routes; cannot read other employees' data", async () => {
    for (const p of ["/employees", "/audit", "/settings/screenshots", "/activity/overview?from=2026-01-01&to=2026-01-01", "/screenshots/gallery"]) {
      want(await api(p, { bearer: S.emp.accessToken }), 403, `employee GET ${p}`);
    }
    const other = randomUUID();
    want(await api(`/screenshots?employeeId=${other}`, { bearer: S.emp.accessToken }), 404, "employee reading another employee's screenshots");
    want(await api(`/attendance/history?employeeId=${other}`, { bearer: S.emp.accessToken }), 404, "employee reading another employee's attendance");
    want(await api("/employees", { cookie: S.admin }), 200, "admin GET /employees");
    return "employee 403 on 5 admin routes, 404 on foreign ids; admin 200";
  }],

  ["attendance", "Device registration, clock-in, break, clock-out, history", async () => {
    const reg = await api("/devices/register", { method: "POST", bearer: S.emp.accessToken, body: { installationId: S.device, deviceName: `staging ${RUN}`, platform: "macos" } });
    ok(reg.status === 200 || reg.status === 201, `device register: ${reg.msg}`);
    S.deviceId = reg.body?.device?.id ?? reg.body?.id;
    const before = await current();
    if (before.state !== "CLOCKED_OUT") {
      S.notes.push(`employee was ${before.state} before the run (stale session closed)`);
      if (before.state === "ON_BREAK") await act("break/end");
      want(await act("clock-out"), 200, "closing stale session");
    }
    want(await act("clock-in"), 200, "clock-in");
    want(await act("break/start"), 200, "break start");
    ok((await current()).state === "ON_BREAK", "state after break start");
    want(await act("break/end"), 200, "break end");
    const c = await current();
    ok(c.state === "CLOCKED_IN", "state after break end");
    const sid = c.session.id;
    want(await act("clock-out"), 200, "clock-out");
    ok((await current()).state === "CLOCKED_OUT", "state after clock-out");
    want(await api("/attendance/clock-in", { method: "POST", bearer: S.emp.accessToken, headers: actHeaders() }), 403, "clock-in without a device header");
    const hist = await api("/attendance/history?pageSize=5", { bearer: S.emp.accessToken });
    want(hist, 200, "history");
    const s = hist.body.items.find((x) => x.id === sid);
    ok(s && s.clockOutAt && (s.breaks?.length ?? 0) >= 1, "session with break not in history");
    return `session ${sid.slice(0, 8)} in/break/out recorded; no-device write 403`;
  }],

  ["activity", "Monitoring notice consent, activity upload, own summary", async () => {
    const me = await api("/activity/me", { bearer: S.emp.accessToken });
    want(me, 200, "/activity/me");
    if (!me.body.policy?.enabled) throw new Skip("activity monitoring is turned off on this environment");
    want(await api("/activity/consent", { method: "POST", bearer: S.emp.accessToken, body: { noticeVersion: me.body.notice.version } }), 200, "consent");
    const consents = await api("/activity/consents", { bearer: S.emp.accessToken });
    const ack = Math.max(...consents.body.items.filter((c) => c.noticeVersion === me.body.notice.version).map((c) => Date.parse(c.acknowledgedAt)));
    const clockIn = await ensureClockedIn();
    const start = Math.max(ack, clockIn) + 1000;
    while (Date.now() < start + 3000) await sleep(250);
    const app = `Staging Suite ${RUN}`;
    const r = await api("/activity/sync", {
      method: "POST", bearer: S.emp.accessToken, device: S.device,
      body: { sentAt: iso(Date.now()), platform: "macos", intervals: [{ id: randomUUID(), kind: "ACTIVE", startedAt: iso(start), endedAt: iso(Date.now() - 200), applicationIdentifier: `com.example.${RUN}`, applicationName: app }] },
    });
    want(r, 200, "activity sync");
    ok(r.body.results?.[0]?.status === "ACCEPTED", `interval ${r.body.results?.[0]?.status}: ${r.body.results?.[0]?.reason ?? ""}`);
    const day = (ms) => iso(ms).slice(0, 10);
    const sum = await api(`/activity/summary?from=${day(Date.now() - 86_400_000)}&to=${day(Date.now() + 86_400_000)}`, { bearer: S.emp.accessToken });
    want(sum, 200, "activity summary");
    ok(sum.body.applications?.some((a) => a.applicationName === app), "uploaded app missing from summary");
    return "consent recorded, 1 interval ACCEPTED and visible in own summary";
  }],

  ["screenshots", "Screenshot policy, notice, register + upload, admin view (sandboxed, logged)", async () => {
    const st = await api("/settings/screenshots", { cookie: S.admin });
    want(st, 200, "screenshot settings");
    const eff = st.body.effective;
    const keys = ["enabled", "intervalSeconds", "webpQuality", "maxDimension", "captureScope", "maskRegions", "blur", "retentionDays", "retentionApproved", "noticeVersion", "employeeSelfView"];
    const pick = (o) => Object.fromEntries(keys.map((k) => [k, o[k]]));
    if (!eff.enabled || eff.intervalSeconds > 60) {
      S.origSettings = pick(eff);
      want(await api("/settings/screenshots", { method: "PUT", cookie: S.admin, body: { ...pick(eff), enabled: true, intervalSeconds: 60, reason: `staging suite ${RUN}: temporary, restored at the end` } }), 200, "enable screenshots temporarily");
    }
    const me = await api("/screenshots/me", { bearer: S.emp.accessToken });
    want(me, 200, "/screenshots/me");
    want(await api("/screenshots/consent", { method: "POST", bearer: S.emp.accessToken, body: { noticeVersion: me.body.notice.version } }), 200, "screenshot notice consent");
    await ensureClockedIn();
    const { maskRegions = [], blur = false } = me.body.policy;
    await sleep(1500);
    for (let i = 0; i < 2; i++) {
      if (i) await sleep(31_000); // the policy allows one capture per half interval (60 s → 30 s)
      const bytes = new Uint8Array(WEBP_1X1);
      const at = Date.now();
      const id = randomUUID();
      const reg = await api("/screenshots/register", {
        method: "POST", bearer: S.emp.accessToken, device: S.device,
        body: { id, capturedAt: iso(at), sentAt: iso(Date.now()), width: 1, height: 1, sizeBytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), mimeType: "image/webp", masks: maskRegions, blurred: blur },
      });
      ok(reg.status < 300 && reg.body?.status === "REGISTERED", `register: ${reg.msg} ${reg.body?.status ?? ""} ${reg.body?.reason ?? ""}`);
      const up = await api(`/screenshots/${id}/content`, { method: "PUT", bearer: S.emp.accessToken, device: S.device, raw: bytes });
      ok(up.status < 300, `upload: ${up.msg}`);
      const list = await api(`/screenshots?pageSize=20`, { bearer: S.emp.accessToken });
      const item = list.body?.items?.find((x) => x.fileSizeBytes === bytes.length && Math.abs(Date.parse(x.capturedAt) - at) < 5000 && !S.shots.some((s) => s.id === x.id));
      ok(item?.uploadStatus === "STORED", "uploaded screenshot not STORED in own list");
      S.shots.push({ id: item.id, bytes });
    }
    const view = await api(`/screenshots/${S.shots[0].id}/content`, { cookie: S.admin });
    want(view, 200, "admin view");
    ok(createHash("sha256").update(view.bytes).digest("hex") === createHash("sha256").update(S.shots[0].bytes).digest("hex"), "served bytes differ from upload");
    ok(view.h.get("content-security-policy") === "default-src 'none'; sandbox", "image lacks sandbox CSP");
    const detail = await api(`/screenshots/${S.shots[0].id}`, { cookie: S.admin });
    want(detail, 200, "admin detail");
    return `2 screenshots stored (${me.body.storageProvider ?? st.body.storageProvider}), admin view byte-identical, sandboxed`;
  }],

  ["timelapse", "Timelapse video for the suite's session (queued, encoded, served, deleted)", async () => {
    ok(S.sessionId && S.shots.length >= 2, "needs the screenshots check to have stored 2 frames");
    const c = await api("/timelapses", { method: "POST", cookie: S.admin, body: { sessionId: S.sessionId, fps: 8 } });
    if (c.status === 503) throw new Skip(`encoder unavailable on this server: ${c.body?.message ?? ""}`);
    want(c, 202, "create timelapse");
    S.timelapseId = c.body.id;
    let job = c.body;
    const until = Date.now() + TIMELAPSE_WAIT_MS;
    while (["QUEUED", "RUNNING"].includes(job.status) && Date.now() < until) {
      await sleep(1000);
      job = (await api(`/timelapses/${S.timelapseId}`, { cookie: S.admin })).body;
    }
    ok(job.status === "READY", `timelapse ${job.status}${job.error ? `: ${job.error}` : ""}`);
    const v = await api(`/timelapses/${S.timelapseId}/content`, { cookie: S.admin });
    want(v, 200, "timelapse content");
    ok(v.bytes.length > 0 && v.h.get("content-security-policy") === "default-src 'none'; sandbox", "video empty or not sandboxed");
    want(await api(`/timelapses/${S.timelapseId}`, { method: "DELETE", cookie: S.admin }), 204, "delete timelapse");
    S.timelapseId = null;
    return `READY, ${v.bytes.length} bytes served sandboxed, deleted`;
  }],

  ["retention", "Retention dry-run previews (activity, screenshots); admin-only", async () => {
    const a = await api("/activity/retention", { cookie: S.admin });
    want(a, 200, "activity retention preview");
    const s = await api("/screenshots/retention", { cookie: S.admin });
    want(s, 200, "screenshot retention preview");
    want(await api("/activity/retention", { bearer: S.emp.accessToken }), 403, "employee retention preview");
    want(await api("/screenshots/retention/run", { method: "POST", bearer: S.emp.accessToken, body: { confirm: true } }), 403, "employee retention run");
    return "previews 200 for admin, 403 for employee (no purge run)";
  }],

  ["rate-limits", "Login limiter returns 429 for a throwaway address (Retry-After reported)", async () => {
    const email = `${RUN}-ratelimit@example.com`;
    let last;
    for (let i = 0; i < 11; i++) {
      last = await api("/auth/login", { method: "POST", body: { email, password: "not the password" } });
      if (last.status === 429) break;
      want(last, 401, `wrong login #${i + 1}`);
    }
    want(last, 429, "11th wrong login");
    if (!last.h.has("retry-after")) S.notes.push("login 429 carries no Retry-After header (finding; the API-wide limiter sets it)");
    return `429 after 10 failures (address never existed); Retry-After ${last.h.get("retry-after") ?? "absent"}`;
  }],
];

// ---- Run --------------------------------------------------------------------------------------
async function cleanup() {
  const done = [];
  const tryStep = async (what, fn) => {
    try {
      await fn();
      done.push(what);
    } catch (e) {
      done.push(`${what} FAILED (${e.message})`);
    }
  };
  if (S.timelapseId) await tryStep("timelapse deleted", async () => want(await api(`/timelapses/${S.timelapseId}`, { method: "DELETE", cookie: S.admin }), 204, "delete"));
  for (const s of S.shots) {
    await tryStep(`screenshot ${s.id.slice(0, 8)} deleted`, async () => want(await api(`/screenshots/${s.id}`, { method: "DELETE", cookie: S.admin, body: { reason: `staging suite ${RUN} cleanup` } }), 200, "delete"));
  }
  if (S.emp && S.deviceId) {
    await tryStep("clocked out", async () => {
      const c = await current();
      if (c.state === "ON_BREAK") await act("break/end");
      if (c.state !== "CLOCKED_OUT") want(await act("clock-out"), 200, "clock-out");
    });
  }
  if (S.origSettings) {
    await tryStep("screenshot policy restored", async () =>
      want(await api("/settings/screenshots", { method: "PUT", cookie: S.admin, body: { ...S.origSettings, reason: `staging suite ${RUN}: restore previous policy` } }), 200, "restore"));
  }
  if (S.deviceId) await tryStep("device revoked", async () => want(await api(`/devices/${S.deviceId}/revoke`, { method: "POST", cookie: S.admin, body: {} }), 200, "revoke"));
  if (S.emp) await tryStep("employee session logged out", async () => want(await api("/auth/logout", { method: "POST", origin: null, bearer: S.emp.accessToken, body: { refreshToken: S.emp.refreshToken } }), 204, "logout"));
  if (S.admin) await tryStep("admin session logged out", async () => want(await api("/auth/logout", { method: "POST", cookie: S.admin, body: {} }), 204, "logout"));
  return done;
}

console.log(`Staging suite ${RUN}\n  API ${BASE}\n  dashboard origin ${DASH}\n`);
const results = [];
try {
  S.admin = (await loginAdmin()).cookie;
  S.emp = await loginEmployee();
} catch (e) {
  console.error(`FAIL setup: ${e.message}`);
  process.exit(1);
}
for (const [id, name, fn] of checks) {
  const t = Date.now();
  let status, detail;
  try {
    detail = await fn();
    status = "PASS";
  } catch (e) {
    status = e instanceof Skip ? "SKIP" : "FAIL";
    detail = e.message;
  }
  results.push(status);
  console.log(`${status.padEnd(4)} ${String(results.length).padStart(2)} ${id.padEnd(17)} ${name}\n          ${detail} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
}
const cleaned = await cleanup();
console.log(`\nCleanup: ${cleaned.join("; ") || "nothing to clean"}`);
console.log("Left by design (append-only): attendance sessions, activity interval, consents, audit rows, DELETED screenshot rows; tagged " + RUN);
if (S.notes.length) console.log(`Notes: ${S.notes.join("; ")}`);
const n = (s) => results.filter((r) => r === s).length;
console.log(`\n${n("PASS")}/${checks.length} passed, ${n("FAIL")} failed, ${n("SKIP")} skipped`);
process.exit(n("FAIL") ? 1 : n("SKIP") ? 3 : 0);
