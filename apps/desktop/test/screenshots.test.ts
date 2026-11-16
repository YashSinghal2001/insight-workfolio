import assert from "node:assert/strict";
import { test } from "node:test";
import type { AttendanceCurrent } from "@workfolio/shared";
import { CAPTURE_FAILED, decideScreenshots, screenshotReport, type ScreenshotInputs } from "../src/monitoring.ts";
import { LOCAL_INELIGIBLE, POLICY_MAX_AGE_MS, policyBlur, policyFresh, privacyText, shotEligible, uploadScreenshots, type Outcome, type ShotDeps, type ShotRow } from "../src/screenshot-sync.ts";
import type { Projection } from "../src/sync.ts";
import { ApiClient, HttpError } from "../src/session.ts";
import { project, type QueuedEvent } from "../src/sync.ts";

const OUT: AttendanceCurrent = { state: "CLOCKED_OUT", session: null, serverTime: "2026-10-13T08:00:00.000Z", missingClockOut: false };
const IN: AttendanceCurrent = {
  state: "CLOCKED_IN", serverTime: OUT.serverTime, missingClockOut: false,
  session: { id: "s", clockInAt: "2026-10-13T08:00:00.000Z", clockOutAt: null, status: "OPEN", corrected: false, clockInSource: "ONLINE", breaks: [] },
};
const ev = (type: QueuedEvent["type"]): QueuedEvent => ({ id: type, userId: "u", deviceId: "d", type, occurredAt: "2026-10-13T09:00:00.000Z", status: "PENDING" });
const base: ScreenshotInputs = {
  signedIn: true, supported: true, deviceStatus: "ACTIVE", enabled: true, consented: true, permission: true,
  projection: project(IN, []), pendingClockIn: false, unverified: false, error: null,
};
const mode = (patch: Partial<ScreenshotInputs>) => decideScreenshots({ ...base, ...patch }).mode;

test("screenshots: only while clocked in, not on break, after the screenshot notice, with OS permission", () => {
  assert.equal(mode({}), "ACTIVE");
  assert.equal(mode({ projection: project(OUT, []) }), "STOPPED", "before clock-in");
  assert.equal(mode({ projection: project(IN, [ev("BREAK_START")]) }), "PAUSED_BREAK", "break pauses at once, before sync");
  assert.equal(mode({ projection: project(IN, [ev("CLOCK_OUT")]) }), "STOPPED", "clock-out stops");
  assert.equal(mode({ consented: false }), "AWAITING_CONSENT", "no capture before the screenshot notice");
  assert.equal(mode({ consented: false, enabled: false }), "STOPPED", "disabled wins: no notice to wait for");
  assert.equal(mode({ enabled: false }), "STOPPED");
  assert.equal(mode({ deviceStatus: "REVOKED" }), "STOPPED");
  assert.equal(mode({ unverified: true }), "PAUSED_OFFLINE_OR_UNVERIFIED");
  assert.equal(mode({ projection: null }), "PAUSED_OFFLINE_OR_UNVERIFIED");
  assert.equal(mode({ supported: false }), "STOPPED");
  assert.equal(mode({ permission: false }), "NEEDS_PERMISSION", "denied or revoked in System Settings");
  assert.equal(mode({ permission: false, projection: project(IN, [ev("BREAK_START")]) }), "PAUSED_BREAK", "attendance wins over the permission prompt");
  assert.equal(mode({ error: "Screenshot failed" }), "ERROR");
  assert.match(decideScreenshots({ ...base, pendingClockIn: true }).reason, /pending server confirmation/);
});

test("screenshots: feature states, and what the device reports about capture", () => {
  // Disabled, Awaiting consent, Enabled, Permission denied are modes; Capture failed is ACTIVE + the worker's last skip.
  assert.equal(screenshotReport(mode({}), null), "OK");
  assert.equal(screenshotReport(mode({ permission: false }), null), "PERMISSION_DENIED");
  assert.equal(screenshotReport(mode({}), `${CAPTURE_FAILED}timed out capturing the screen`), "CAPTURE_FAILED");
  assert.equal(mode({ error: null }), "ACTIVE", "a failed capture is a skip, never an error: capture goes on and retries");
  for (const skip of ["Not taken: the screen was locked.", "Not taken: the display was asleep.", "Paused: local screenshot storage is full."]) {
    assert.equal(screenshotReport("ACTIVE", skip), "OK", skip);
  }
  for (const patch of [{ enabled: false }, { consented: false }, { projection: project(OUT, []) }, { projection: project(IN, [ev("BREAK_START")]) }, { projection: null }, { signedIn: false }, { error: "invalid masks" }]) {
    assert.equal(screenshotReport(mode(patch), `${CAPTURE_FAILED}old`), undefined, JSON.stringify(Object.keys(patch)));
  }
});

test("screenshots: a cached policy older than a day pauses capture until the server answers", () => {
  const t = Date.parse("2026-10-13T09:00:00.000Z");
  assert.equal(policyFresh(t, t + POLICY_MAX_AGE_MS), true);
  assert.equal(policyFresh(t, t + POLICY_MAX_AGE_MS + 1), false);
  assert.equal(policyFresh(null, t), false, "a cached copy of unknown age is not acted on");
  assert.equal(policyFresh(t, t - 3_600_000), true, "a clock set back never makes it stale");
  const stale = decideScreenshots({ ...base, policyStale: true });
  assert.equal(stale.mode, "PAUSED_OFFLINE_OR_UNVERIFIED");
  assert.match(stale.reason, /could not be checked with the server/);
  assert.equal(screenshotReport(stale.mode, null), undefined);
  assert.equal(mode({ policyStale: true, enabled: false }), "STOPPED", "a stale 'off' stays off");
  assert.equal(mode({ policyStale: false }), "ACTIVE");
});

const row = (id: string, status: ShotRow["status"] = "PENDING"): ShotRow => ({
  id, sessionId: "s", capturedMs: Date.parse("2026-10-13T09:00:00.000Z"), width: 1920, height: 1200, sizeBytes: 3, checksum: "a".repeat(64), status, retries: 0, lastError: null, masks: [], blurred: false,
});

function fakes(rows: ShotRow[], { register = (_: object) => ({ status: "REGISTERED" }), upload = () => {} }: { register?: (b: object) => object; upload?: () => void } = {}) {
  const marks: [string, Outcome, string | null][] = [];
  const calls: string[] = [];
  let attendancePending = false;
  let projection: Projection | null = null;
  const deps: ShotDeps = {
    next: async () => rows.find((r) => !marks.some(([id, o]) => id === r.id && o !== "REGISTERED") && !marks.some(([id, o]) => id === r.id && o === "RETRY")) ?? null,
    read: async (id) => (calls.push(`read ${id}`), new Uint8Array([1, 2, 3]).buffer),
    mark: async (id, o, reason) => void marks.push([id, o, reason]),
    register: async (b) => (calls.push(`register ${(b as { id: string }).id}`), register(b) as never),
    upload: async (id) => (calls.push(`upload ${id}`), upload(), { id, status: "STORED", storedAt: "x" }),
    attendancePending: () => attendancePending,
    projection: () => projection,
    now: () => Date.parse("2026-10-13T10:00:00.000Z"),
  };
  return { deps, marks, calls, setAttendancePending: (v: boolean) => (attendancePending = v), setProjection: (p: Projection | null) => (projection = p) };
}

test("upload: register, then bytes, STORED only after the server confirmed; registered rows skip registration", async () => {
  const f = fakes([row("a"), row("b", "REGISTERED")]);
  const r = await uploadScreenshots(f.deps);
  assert.deepEqual(r, { stored: 2, rejected: 0, failed: null });
  assert.deepEqual(f.calls, ["register a", "read a", "upload a", "read b", "upload b"]);
  assert.deepEqual(f.marks.map(([id, o]) => `${id}:${o}`), ["a:REGISTERED", "a:STORED", "b:STORED"]);
});

test("upload: rejected registrations are kept with the reason; duplicates already stored are not re-sent", async () => {
  const f = fakes([row("a"), row("b")], { register: (b) => ((b as { id: string }).id === "a" ? { status: "REJECTED", reason: "Captured during a break" } : { status: "STORED" }) });
  assert.deepEqual(await uploadScreenshots(f.deps), { stored: 1, rejected: 1, failed: null });
  assert.deepEqual(f.marks, [["a", "REJECTED", "Captured during a break"], ["b", "STORED", null]]);
  assert.ok(!f.calls.some((c) => c.startsWith("upload")), "nothing uploaded");
});

test("upload: offline and storage failures retry later (backoff in the queue), nothing is lost or marked stored", async () => {
  const offline = fakes([row("a"), row("b")], { register: () => { throw new TypeError("fetch failed"); } });
  assert.deepEqual(await uploadScreenshots(offline.deps), { stored: 0, rejected: 0, failed: "Server unreachable" });
  assert.deepEqual(offline.marks, [["a", "RETRY", "Server unreachable"]], "stops at the first failure");

  const storage = fakes([row("a")], { upload: () => { throw new HttpError(502, "Screenshot storage is unavailable; the upload will be retried"); } });
  const r = await uploadScreenshots(storage.deps);
  assert.equal(r.stored, 0);
  assert.deepEqual(storage.marks.map(([, o]) => o), ["REGISTERED", "RETRY"], "registered, but not stored");

  const gone = fakes([row("a", "REGISTERED"), row("b", "REGISTERED")], { upload: () => { throw new HttpError(410, "Deleted under the screenshot retention policy before it was uploaded"); } });
  assert.deepEqual(await uploadScreenshots(gone.deps), { stored: 0, rejected: 2, failed: null });
  assert.deepEqual(gone.marks.map(([, o]) => o), ["REJECTED", "REJECTED"], "kept as rejected with the reason, never marked stored");

  const waiting = fakes([row("a")]);
  waiting.setAttendancePending(true);
  assert.deepEqual(await uploadScreenshots(waiting.deps), { stored: 0, rejected: 0, failed: null });
  assert.deepEqual(waiting.calls, [], "waits for attendance to sync first");
});

/** Session "s" clocked in at 08:00 with the given breaks (ISO times on 2026-10-13). */
const session = (breaks: [string, string | null][], clockOut: string | null = null): Projection => ({
  state: clockOut ? "CLOCKED_OUT" : breaks.some(([, end]) => !end) ? "ON_BREAK" : "CLOCKED_IN",
  unsynced: 0,
  session: {
    id: "s", clockInAt: "2026-10-13T08:00:00.000Z", clockOutAt: clockOut && `2026-10-13T${clockOut}:00.000Z`, status: clockOut ? "CLOSED" : "OPEN", corrected: false, clockInSource: "ONLINE",
    breaks: breaks.map(([a, b], i) => ({ id: `b${i}`, startedAt: `2026-10-13T${a}:00.000Z`, endedAt: b && `2026-10-13T${b}:00.000Z` })),
  },
});

test("eligibility: a capture inside a break, before clock-in or after clock-out is never eligible; other sessions go to the server", () => {
  const at = (hhmm: string, sessionId = "s") => ({ sessionId, capturedMs: Date.parse(`2026-10-13T${hhmm}:00.000Z`) });
  const p = session([["09:00", "09:15"]], "17:00");
  assert.equal(shotEligible(at("08:30"), p), true);
  assert.equal(shotEligible(at("09:00"), p), false, "at the break start");
  assert.equal(shotEligible(at("09:10"), p), false, "inside the break");
  assert.equal(shotEligible(at("09:15"), p), true, "at the break end");
  assert.equal(shotEligible(at("07:59"), p), false, "before clock-in");
  assert.equal(shotEligible(at("17:00"), p), false, "at clock-out");
  assert.equal(shotEligible(at("10:00"), session([["09:30", null]])), false, "open break");
  assert.equal(shotEligible(at("10:00", "other"), p), true, "another session: judged by the server");
  assert.equal(shotEligible(at("10:00"), null), true, "unknown attendance: judged by the server");
});

test("upload: nothing is sent during a break, and a capture that falls in a break is discarded before sending", async () => {
  const onBreak = fakes([row("a")]);
  onBreak.setProjection(session([["08:30", null]]));
  assert.deepEqual(await uploadScreenshots(onBreak.deps), { stored: 0, rejected: 0, failed: null });
  assert.deepEqual([onBreak.calls, onBreak.marks], [[], []], "held until the break ends");

  // row() is captured at 09:00; the break (recorded after the capture was queued) covers it.
  const late = fakes([row("a"), row("b", "REGISTERED")]);
  late.setProjection(session([["08:55", "09:30"]]));
  assert.deepEqual(await uploadScreenshots(late.deps), { stored: 0, rejected: 2, failed: null });
  assert.deepEqual(late.marks, [["a", "REJECTED", LOCAL_INELIGIBLE], ["b", "REJECTED", LOCAL_INELIGIBLE]]);
  assert.deepEqual(late.calls, [], "neither registered nor uploaded");

  const clockedOut = fakes([row("a")]);
  clockedOut.setProjection(session([], "08:59"));
  assert.deepEqual(await uploadScreenshots(clockedOut.deps), { stored: 0, rejected: 1, failed: null }, "captured after clock-out");

  const fine = fakes([row("a")]);
  fine.setProjection(session([["08:30", "08:45"]], "17:00"));
  assert.deepEqual(await uploadScreenshots(fine.deps), { stored: 1, rejected: 0, failed: null }, "captured before clock-out: uploads after it");
});

test("api client sends screenshot bytes as-is with their content type and the bearer token", async () => {
  const seen: { headers: Headers; body: unknown }[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    seen.push({ headers: new Headers(init.headers), body: init.body });
    return new Response(JSON.stringify({ accessToken: "t", refreshToken: "r", id: "x", status: "STORED" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const store = { load: async () => "r", save: async () => {}, clear: async () => {} };
  const client = new ApiClient("http://api", store, fetchFn);
  await client.login("a@example.com", "pw");
  const bytes = new Uint8Array([82, 73, 70, 70]).buffer;
  await client.request("PUT", "/screenshots/x/content", bytes, { "content-type": "image/webp", "x-device-id": "dev" });
  const put = seen.at(-1)!;
  assert.equal(put.body, bytes, "not JSON-encoded");
  assert.deepEqual([put.headers.get("content-type"), put.headers.get("authorization"), put.headers.get("x-device-id")], ["image/webp", "Bearer t", "dev"]);
});

test("registration carries the masks applied at capture (none for rows from before masks)", async () => {
  const masks = [{ x: 0, y: 0, w: 2500, h: 1000 }];
  const bodies: object[] = [];
  const f = fakes([{ ...row("m"), masks }, { ...row("old"), masks: undefined as never }], { register: (b) => (bodies.push(b), { status: "STORED" }) });
  await uploadScreenshots(f.deps);
  assert.deepEqual(bodies.map((b) => (b as { masks: unknown }).masks), [masks, []]);
});

test("the employee is told what is masked, or that nothing is", async () => {
  const { maskText } = await import("../src/monitoring.ts");
  assert.match(maskText([]), /Nothing is blurred or masked/);
  const t = maskText([{ label: "Menu bar clock" }, { label: "Chat" }]);
  assert.match(t, /2 area\(s\).*blacked out on this computer before each screenshot is saved \(Menu bar clock, Chat\)/);
  assert.match(t, /never stored or uploaded/);
});

test("registration says whether the image was blurred (rows from before blur: not blurred)", async () => {
  const bodies: object[] = [];
  const f = fakes([{ ...row("b"), blurred: true }, row("n"), { ...row("old"), blurred: undefined as never }], { register: (b) => (bodies.push(b), { status: "STORED" }) });
  await uploadScreenshots(f.deps);
  assert.deepEqual(bodies.map((b) => (b as { id: string; blurred: unknown }).blurred), [true, false, false]);
  assert.deepEqual(Object.keys(bodies[0]!), ["id", "capturedAt", "sentAt", "width", "height", "sizeBytes", "checksum", "mimeType", "masks", "blurred"]);
});

test("a blur mismatch rejected by the server is kept as rejected with its reason, not retried", async () => {
  const reason = "Captured without the blur in force at that time";
  const f = fakes([{ ...row("b"), blurred: false }], { register: () => ({ status: "REJECTED", reason }) });
  const r = await uploadScreenshots(f.deps);
  assert.deepEqual([r.rejected, f.marks], [1, [["b", "REJECTED", reason]]]);
  assert.deepEqual(f.calls, ["register b"], "never uploaded");
});

test("blur setting from the policy: absent = off, a non-boolean pauses capture (null)", () => {
  assert.equal(policyBlur({}), false, "a server from before blur");
  assert.equal(policyBlur({ blur: true }), true);
  assert.equal(policyBlur({ blur: false }), false);
  for (const bad of [null, "true", 1, {}]) assert.equal(policyBlur({ blur: bad }), null, String(bad));
});

test("the employee is told when screenshots are blurred, alongside the masks", () => {
  assert.match(privacyText([], false), /Nothing is blurred or masked/);
  const blurred = privacyText([], true);
  assert.match(blurred, /^Screenshots are blurred/);
  assert.match(blurred, /No areas are blacked out/);
  assert.doesNotMatch(blurred, /Nothing is blurred/);
  assert.match(privacyText([{ label: "Chat" }], true), /^Screenshots are blurred.*1 area\(s\).*\(Chat\)/);
  assert.equal(privacyText([], null), privacyText([], false), "unreadable setting: capture is paused and says so separately");
});


test("storage label names the provider, with neutral wording for unknown ones", async () => {
  const { storageLabel } = await import("../src/screenshot-sync.ts");
  assert.equal(storageLabel("MICROSOFT_GRAPH"), "Microsoft 365");
  assert.equal(storageLabel("GOOGLE_DRIVE"), "Google Drive");
  assert.match(storageLabel("LOCAL_DEV"), /development storage/);
  assert.equal(storageLabel("SOMETHING_NEW"), "your organization's cloud storage");
});
