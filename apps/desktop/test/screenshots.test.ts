import assert from "node:assert/strict";
import { test } from "node:test";
import type { AttendanceCurrent } from "@workfolio/shared";
import { decideScreenshots, type ScreenshotInputs } from "../src/monitoring.ts";
import { uploadScreenshots, type Outcome, type ShotDeps, type ShotRow } from "../src/screenshot-sync.ts";
import { ApiClient, HttpError } from "../src/session.ts";
import { project, type QueuedEvent } from "../src/sync.ts";

const OUT: AttendanceCurrent = { state: "CLOCKED_OUT", session: null, serverTime: "2026-10-13T08:00:00.000Z" };
const IN: AttendanceCurrent = {
  state: "CLOCKED_IN", serverTime: OUT.serverTime,
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
  assert.equal(mode({ consented: false }), "STOPPED", "no capture before the screenshot notice");
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

const row = (id: string, status: ShotRow["status"] = "PENDING"): ShotRow => ({
  id, sessionId: "s", capturedMs: Date.parse("2026-10-13T09:00:00.000Z"), width: 1920, height: 1200, sizeBytes: 3, checksum: "a".repeat(64), status, retries: 0, lastError: null,
});

function fakes(rows: ShotRow[], { register = (_: object) => ({ status: "REGISTERED" }), upload = () => {} }: { register?: (b: object) => object; upload?: () => void } = {}) {
  const marks: [string, Outcome, string | null][] = [];
  const calls: string[] = [];
  let attendancePending = false;
  const deps: ShotDeps = {
    next: async () => rows.find((r) => !marks.some(([id, o]) => id === r.id && o !== "REGISTERED") && !marks.some(([id, o]) => id === r.id && o === "RETRY")) ?? null,
    read: async (id) => (calls.push(`read ${id}`), new Uint8Array([1, 2, 3]).buffer),
    mark: async (id, o, reason) => void marks.push([id, o, reason]),
    register: async (b) => (calls.push(`register ${(b as { id: string }).id}`), register(b) as never),
    upload: async (id) => (calls.push(`upload ${id}`), upload(), { id, status: "STORED", storedAt: "x" }),
    attendancePending: () => attendancePending,
    now: () => Date.parse("2026-10-13T10:00:00.000Z"),
  };
  return { deps, marks, calls, setAttendancePending: (v: boolean) => (attendancePending = v) };
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
