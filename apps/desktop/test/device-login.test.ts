// One active device per account (API migration 0031): what the desktop client sends and how it surfaces a
// refusal. Platform-neutral: the same client code runs on Windows and macOS.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiClient, HttpError, type TokenStore } from "../src/session.ts";

function memoryTokens(): TokenStore & { value: string | null } {
  const t = { value: null as string | null, load: async () => t.value, save: async (v: string) => void (t.value = v), clear: async () => void (t.value = null) };
  return t;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("sign-in sends the installation id; takeover only when the user chose it", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return json(200, { user: { id: "u" }, accessToken: "a", refreshToken: "s.r", expiresIn: 900 });
  }) as typeof fetch;
  const tokens = memoryTokens();
  const client = new ApiClient("http://localhost:4000", tokens, fetchFn);
  await client.login("e@x.co", "pw", "11111111-1111-4111-8111-111111111111");
  await client.login("e@x.co", "pw", "11111111-1111-4111-8111-111111111111", true);
  assert.equal(bodies[0]!.takeover, undefined, "never an implicit takeover");
  assert.deepEqual(bodies[0], { email: "e@x.co", password: "pw", client: "desktop", installationId: "11111111-1111-4111-8111-111111111111" });
  assert.equal(bodies[1]!.takeover, true);
  assert.equal(tokens.value, "s.r", "session persisted for the next app start");
});

test("a refused sign-in keeps nothing and exposes the code and the active device", async () => {
  const activeDevice = { id: "d", deviceName: "MacBook Air M2", platform: "macos", lastSeenAt: null, since: "2026-11-16T09:00:00.000Z" };
  const fetchFn = (async () =>
    json(409, { statusCode: 409, error: "Conflict", message: "Your account is already signed in on MacBook Air M2 (macOS).", code: "ACTIVE_ON_ANOTHER_DEVICE", details: { activeDevice } })) as unknown as typeof fetch;
  const tokens = memoryTokens();
  const client = new ApiClient("http://localhost:4000", tokens, fetchFn);
  const err = await client.login("e@x.co", "pw", "22222222-2222-4222-8222-222222222222").catch((e: unknown) => e);
  assert.ok(err instanceof HttpError);
  assert.equal(err.status, 409);
  assert.equal(err.code, "ACTIVE_ON_ANOTHER_DEVICE");
  assert.deepEqual(err.details, { activeDevice });
  assert.match(err.message, /MacBook Air M2 \(macOS\)/);
  assert.equal(tokens.value, null, "no token stored");
});

test("logout revokes server-side and forgets the token even when the server is unreachable", async () => {
  const tokens = memoryTokens();
  tokens.value = "s.r";
  const client = new ApiClient("http://localhost:4000", tokens, (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch);
  await client.logout();
  assert.equal(tokens.value, null);
});
