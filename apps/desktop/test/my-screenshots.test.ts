// F08 desktop pieces that run without a window: mask wording, authenticated image fetch, CSP.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { maskLine, unavailable } from "../src/my-screenshots.ts";
import { ApiClient, HttpError, type TokenStore } from "../src/session.ts";

test("mask wording: none, a count, or the labels when the server matched them", () => {
  assert.equal(maskLine(0), "No privacy masks were applied.");
  assert.equal(maskLine(1), "1 area was blacked out before saving.");
  assert.equal(maskLine(2, [{ label: "Clock" }, { label: "Chat" }]), "2 areas were blacked out before saving: Clock, Chat.");
  assert.equal(maskLine(2, null), "2 areas were blacked out before saving.", "unknown labels: count only");
  assert.equal(maskLine(2, [{ label: "Clock" }]), "2 areas were blacked out before saving.", "labels that do not match the count are not shown");
});

test("deleted and not-yet-uploaded screenshots are shown as such, never opened", () => {
  assert.equal(unavailable({ uploadStatus: "DELETED" }), "Deleted under the retention policy");
  assert.equal(unavailable({ uploadStatus: "REGISTERED" }), "Waiting for upload");
  assert.equal(unavailable({ uploadStatus: "STORED" }), null);
});

test("image fetch: bearer token, refresh once on 401, server message on errors; no URL-borne credentials", async () => {
  const tokens: TokenStore & { v: string | null } = { v: "r1", load: async () => tokens.v, save: async (t) => void (tokens.v = t), clear: async () => void (tokens.v = null) };
  const calls: { url: string; auth?: string }[] = [];
  let expired = true;
  const fetchFn = (async (url: string, init: RequestInit) => {
    const auth = (init.headers as Record<string, string>).authorization;
    calls.push({ url, auth });
    if (url.endsWith("/auth/refresh")) return Response.json({ accessToken: "a2", refreshToken: "r2" });
    if (url.includes("/missing")) return Response.json({ message: "Screenshot not found" }, { status: 404 });
    if (expired) return (expired = false), Response.json({ message: "expired" }, { status: 401 });
    return new Response(new Uint8Array([82, 73, 70, 70]), { headers: { "content-type": "image/webp" } });
  }) as typeof fetch;
  const client = new ApiClient("http://api", tokens, fetchFn);
  const blob = await client.blob("/screenshots/abc/content?variant=thumbnail");
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [82, 73, 70, 70]);
  assert.deepEqual(calls.map((c) => c.url.replace("http://api/api/v1", "")), ["/screenshots/abc/content?variant=thumbnail", "/auth/refresh", "/screenshots/abc/content?variant=thumbnail"]);
  assert.equal(calls[2]!.auth, "Bearer a2");
  assert.ok(calls.every((c) => !/token|bearer/i.test(c.url)), "credentials never in the URL");
  await assert.rejects(client.blob("/screenshots/missing/content"), (e) => e instanceof HttpError && e.status === 404 && e.message === "Screenshot not found");
});

test("desktop CSP: images only from the app, data: and in-memory blob: URLs (never remote hosts)", () => {
  const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const img = (conf.app.security.csp as string).split(";").map((d) => d.trim()).find((d) => d.startsWith("img-src"));
  assert.equal(img, "img-src 'self' data: blob:");
});
