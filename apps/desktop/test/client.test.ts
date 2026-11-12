// Runs with node's built-in TypeScript stripping: node --test test/
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AttendanceCurrent, SyncResponse } from "@workfolio/shared";
import { ApiClient, HttpError, restoreSession, type TokenStore } from "../src/session.ts";
import { project, SyncEngine, type Queue, type QueuedEvent } from "../src/sync.ts";

// ---- fakes ----------------------------------------------------------------------

function memoryTokens(initial: string | null = null): TokenStore & { value: string | null } {
  const t = {
    value: initial,
    load: async () => t.value,
    save: async (v: string) => void (t.value = v),
    clear: async () => void (t.value = null),
  };
  return t;
}

/** A queue whose rows live in `disk`, so a new engine over the same disk simulates a restart. */
function diskQueue(disk: QueuedEvent[]): Queue {
  return {
    list: async () => disk.map((e) => ({ ...e })),
    ack: async (ids) => void disk.splice(0, disk.length, ...disk.filter((e) => !ids.includes(e.id))),
    reject: async (id, reason) => void Object.assign(disk.find((e) => e.id === id)!, { status: "REJECTED", reason }),
  };
}

const ev = (id: string, type: QueuedEvent["type"], occurredAt = "2026-10-12T09:00:00.000Z"): QueuedEvent => ({
  id, userId: "u1", deviceId: "d1", type, occurredAt, status: "PENDING",
});
const CURRENT: AttendanceCurrent = { state: "CLOCKED_OUT", session: null, missingClockOut: false, serverTime: "2026-10-12T09:00:00.000Z" };
const offline = () => Promise.reject(new TypeError("fetch failed"));
const accept = (status: "ACCEPTED" | "DUPLICATE" = "ACCEPTED") => async (b: { items: { id: string }[] }): Promise<SyncResponse> => ({
  results: b.items.map((e) => ({ id: e.id, status })),
  current: CURRENT,
});
function timers() {
  const delays: number[] = [];
  return { delays, setTimer: (_: () => void, ms: number) => delays.push(ms), clearTimer: () => undefined };
}

// ---- offline queue ----------------------------------------------------------------

test("queue persistence: events survive a failed upload and an app restart, then sync", async () => {
  const disk = [ev("e1", "CLOCK_IN"), ev("e2", "BREAK_START")];
  const first = new SyncEngine(diskQueue(disk), offline, timers());
  await first.kick();
  assert.equal(first.status.phase, "offline");
  assert.equal(disk.length, 2, "nothing lost while offline");
  first.stop();

  const sent: string[][] = [];
  const restarted = new SyncEngine(diskQueue(disk), async (b) => (sent.push(b.items.map((e) => e.id)), accept()(b)), timers());
  await restarted.kick();
  assert.deepEqual(sent, [["e1", "e2"]], "FIFO order in one batch");
  assert.equal(disk.length, 0);
  assert.equal(restarted.status.phase, "idle");
  assert.ok(restarted.status.lastSyncAt);
});

test("retries back off exponentially and reconnection retries immediately", async () => {
  const disk = [ev("e1", "CLOCK_IN")];
  const t = timers();
  let online = false;
  const engine = new SyncEngine(diskQueue(disk), (b) => (online ? accept()(b) : offline()), { ...t, baseDelayMs: 1000, maxDelayMs: 5000 });
  for (let i = 0; i < 5; i++) await engine.drain(); // what each scheduled retry does
  assert.deepEqual(t.delays, [1000, 2000, 4000, 5000, 5000]);
  online = true;
  await engine.kick(); // e.g. the `online` event or the API health check recovering
  assert.equal(disk.length, 0);
  assert.equal(engine.status.retryAt, null);
});

test("duplicate replay: events the server already has are acknowledged, not resent", async () => {
  const disk = [ev("e1", "CLOCK_IN")];
  const engine = new SyncEngine(diskQueue(disk), accept("DUPLICATE"), timers());
  await engine.kick();
  assert.equal(disk.length, 0);
});

test("rejected events are kept with the reason and never resent; later events still sync", async () => {
  const disk = [ev("bad", "CLOCK_OUT"), ev("ok", "CLOCK_IN")];
  const sent: string[][] = [];
  const engine = new SyncEngine(diskQueue(disk), async (b) => {
    sent.push(b.items.map((e) => e.id));
    return { results: b.items.map((e) => (e.id === "bad" ? { id: e.id, status: "REJECTED" as const, reason: "Cannot clock out while clocked out" } : { id: e.id, status: "ACCEPTED" as const })), current: CURRENT };
  }, timers());
  await engine.kick();
  await engine.kick();
  assert.deepEqual(sent, [["bad", "ok"]], "second pass sends nothing");
  assert.deepEqual(disk.map((e) => [e.id, e.status, e.reason]), [["bad", "REJECTED", "Cannot clock out while clocked out"]]);
});

test("401/403 (signed out, device revoked) blocks without retry loops; server errors retry", async () => {
  const t = timers();
  const blocked = new SyncEngine(diskQueue([ev("e1", "CLOCK_IN")]), () => Promise.reject(new HttpError(403, "This device is not registered or has been revoked")), t);
  await blocked.kick();
  assert.equal(blocked.status.phase, "blocked");
  assert.deepEqual(t.delays, []);
  const failing = new SyncEngine(diskQueue([ev("e1", "CLOCK_IN")]), () => Promise.reject(new HttpError(500, "boom")), t);
  await failing.kick();
  assert.equal(failing.status.phase, "error");
  assert.equal(t.delays.length, 1);
});

test("concurrent drains share one in-flight upload", async () => {
  const disk = [ev("e1", "CLOCK_IN")];
  let calls = 0;
  const engine = new SyncEngine(diskQueue(disk), async (b) => (calls++, await new Promise((r) => setTimeout(r, 10)), accept()(b)), timers());
  await Promise.all([engine.kick(), engine.drain(), engine.drain()]);
  assert.equal(calls, 1, "the follow-up pass finds the queue empty");
});

test("offline preview applies pending events with the shared state machine", () => {
  const p = project(CURRENT, [
    ev("a", "CLOCK_IN", "2026-10-12T09:00:00.000Z"),
    ev("b", "BREAK_START", "2026-10-12T12:00:00.000Z"),
    ev("x", "CLOCK_OUT", "2026-10-12T12:10:00.000Z"), // invalid while on break: not applied
  ]);
  assert.equal(p!.state, "ON_BREAK");
  assert.equal(p!.unsynced, 2);
  assert.deepEqual(p!.session!.breaks.map((b) => b.endedAt), [null]);
  assert.equal(project(null, []), null, "no snapshot: unknown, not guessed");
});

test("crash recovery: an upload the server applied before the app died is reconciled on restart, not applied twice", async () => {
  const disk = [ev("e1", "CLOCK_IN"), ev("e2", "BREAK_START")];
  const applied = new Map<string, number>();
  const server = async (b: { items: { id: string }[] }): Promise<SyncResponse> => ({
    results: b.items.map((e) => {
      applied.set(e.id, (applied.get(e.id) ?? 0) + 1);
      return { id: e.id, status: applied.get(e.id)! > 1 ? "DUPLICATE" as const : "ACCEPTED" as const };
    }),
    current: CURRENT,
  });
  // The server commits, then the app is killed before it can remove the events locally.
  const dying = new SyncEngine(diskQueue(disk), async (b) => (await server(b), Promise.reject(new TypeError("process killed"))), timers());
  await dying.kick();
  dying.stop();
  assert.equal(disk.length, 2, "still queued after the crash");

  const restarted = new SyncEngine(diskQueue(disk), server, timers());
  await restarted.kick();
  assert.equal(disk.length, 0);
  assert.deepEqual([...applied.values()], [2, 2], "sent twice, answered DUPLICATE the second time");
});

test("reconciliation: server-side changes (e.g. an approved correction) win over stale local previews", () => {
  // Locally the employee is on a break; meanwhile an admin approved a missing clock-out that closed the shift.
  const server: AttendanceCurrent = {
    state: "CLOCKED_OUT",
    missingClockOut: false,
    serverTime: "2026-10-12T18:00:00.000Z",
    session: { id: "s1", clockInAt: "2026-10-12T09:00:00.000Z", clockOutAt: "2026-10-12T17:00:00.000Z", status: "CLOSED", breaks: [], corrected: true, clockInSource: "ONLINE" },
  };
  const p = project(server, [ev("late", "BREAK_END", "2026-10-12T17:30:00.000Z")]);
  assert.deepEqual([p!.state, p!.unsynced], ["CLOCKED_OUT", 0], "invalid local event is not previewed; the server will reject it visibly");
});

// ---- session restoration -----------------------------------------------------------

function fakeApi(handler: (path: string, body: unknown) => Response | Promise<Response>): typeof fetch {
  return async (url, init) => handler(String(url).replace(/^.*\/api\/v1/, ""), init?.body ? JSON.parse(String(init.body)) : undefined);
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ME = { user: { id: "u1", email: "e@x.co", role: "EMPLOYEE" }, employee: { fullName: "Priya", employeeCode: "E1", timezone: "Asia/Kolkata" } };
const PROFILE = { userId: "u1", fullName: "Priya", employeeCode: "E1", email: "e@x.co", timezone: "Asia/Kolkata" };

test("session restoration: rotates the stored refresh token and loads the identity", async () => {
  const tokens = memoryTokens("old");
  const client = new ApiClient("http://api", tokens, fakeApi((path, body) =>
    path === "/auth/refresh"
      ? json({ accessToken: "a", refreshToken: (body as { refreshToken: string }).refreshToken === "old" ? "new" : "x", expiresIn: 900, user: ME.user })
      : json(ME)));
  const r = await restoreSession(client, tokens, null);
  assert.equal(r.kind, "online");
  assert.equal(tokens.value, "new");
});

test("concurrent refreshes share one request (a replayed refresh token would revoke the session)", async () => {
  const tokens = memoryTokens("old");
  let calls = 0;
  const client = new ApiClient("http://api", tokens, fakeApi(async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return json({ accessToken: "a", refreshToken: "new", expiresIn: 900, user: ME.user });
  }));
  assert.deepEqual(await Promise.all([client.refresh(), client.refresh(), client.refresh()]), [true, true, true]);
  assert.equal(calls, 1);
});

test("session restoration: revoked/expired session signs out and clears the token", async () => {
  const tokens = memoryTokens("old");
  const client = new ApiClient("http://api", tokens, fakeApi(() => json({ message: "Unauthorized" }, 401)));
  assert.deepEqual(await restoreSession(client, tokens, PROFILE), { kind: "signed-out", offline: false });
  assert.equal(tokens.value, null);
});

test("session restoration offline: keeps the token and uses the cached profile", async () => {
  const tokens = memoryTokens("old");
  const client = new ApiClient("http://api", tokens, () => Promise.reject(new TypeError("fetch failed")));
  assert.deepEqual(await restoreSession(client, tokens, PROFILE), { kind: "offline", profile: PROFILE });
  assert.deepEqual(await restoreSession(client, tokens, null), { kind: "signed-out", offline: true });
  assert.equal(tokens.value, "old");
  assert.deepEqual(await restoreSession(client, memoryTokens(null), PROFILE), { kind: "signed-out", offline: false });
});

test("session ended: a refused refresh (expired, revoked, account disabled) notifies the app once; offline does not", async () => {
  let ended = 0;
  const tokens = memoryTokens("old");
  const refused = new ApiClient("http://api", tokens, fakeApi(() => json({ message: "Unauthorized" }, 401)));
  refused.onSessionEnded = () => void ended++;
  await assert.rejects(refused.request("GET", "/activity/me"), (e: unknown) => e instanceof HttpError && e.status === 401);
  assert.equal(ended, 1);
  assert.equal(tokens.value, null, "the dead token is forgotten");

  const kept = memoryTokens("old");
  const unreachable = new ApiClient("http://api", kept, () => Promise.reject(new TypeError("fetch failed")));
  unreachable.onSessionEnded = () => void ended++;
  await assert.rejects(unreachable.refresh());
  assert.equal(ended, 1);
  assert.equal(kept.value, "old", "network loss keeps the session");

  // Re-authentication after the session ended works with the same client.
  const back = memoryTokens(null);
  const relogin = new ApiClient("http://api", back, fakeApi((path) =>
    path === "/auth/login" ? json({ accessToken: "a", refreshToken: "r2", expiresIn: 900, user: ME.user }) : json(ME)));
  await relogin.login("e@x.co", "pw");
  assert.equal(back.value, "r2");
});
