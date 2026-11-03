import assert from "node:assert/strict";
import { test } from "node:test";
import { apiBaseOf, hostOf, originPatternOf, trimQueue, Tracker, uploadError } from "./tracker.js";

test("only the host of http(s) pages leaves hostOf: no path, query, fragment or credentials", () => {
  assert.equal(hostOf("https://Docs.Example.com/secret/path?q=search#frag"), "docs.example.com");
  assert.equal(hostOf("https://user:pw@mail.example.com/inbox"), "mail.example.com");
  for (const u of ["chrome://settings", "file:///Users/me/doc.pdf", "about:blank", "chrome-extension://abc/popup.html", "data:text/html,hi", "not a url", undefined]) assert.equal(hostOf(u), null, String(u));
});

test("intervals: host changes end them, long visits split, sub-second dropped, nothing eligible ends tracking", () => {
  let n = 0;
  const t = new Tracker({ maxMs: 300_000, newId: () => `i${++n}` });
  const at = (s) => Date.parse("2026-11-02T10:00:00Z") + s * 1000;
  assert.deepEqual(t.observe("a.com", at(0)), []);
  assert.deepEqual(t.observe("a.com", at(10)), [], "same host continues");
  assert.deepEqual(t.observe("b.com", at(60)), [{ id: "i1", domain: "a.com", startedAt: "2026-11-02T10:00:00.000Z", endedAt: "2026-11-02T10:01:00.000Z" }]);
  assert.deepEqual(t.observe("c.com", at(60.5)), [], "under a second: dropped");
  for (const k of [60, 120, 180, 240]) assert.deepEqual(t.observe("c.com", at(60.5 + k)), [], "regular looks"); // the extension looks at least every 30 s
  const split = t.observe("c.com", at(60.5 + 301));
  assert.equal(split.length, 1);
  assert.equal(Date.parse(split[0].endedAt) - Date.parse(split[0].startedAt), 300_000, "split at the maximum");
  assert.deepEqual([t.current.host, t.current.start], ["c.com", at(360.5)], "continues after the split");
  assert.equal(t.observe(null, at(400)).length, 1, "nothing eligible (idle, other app, incognito, paused): ends it");
  assert.equal(t.current, null);
  assert.deepEqual(t.observe(null, at(500)), []);
});

test("a long gap without observations (sleep, browser not running) ends the interval at the last observation", () => {
  let n = 0;
  const t = new Tracker({ maxMs: 300_000, gapMs: 90_000, newId: () => `g${++n}` });
  const at = (s) => Date.parse("2026-11-02T10:00:00Z") + s * 1000;
  t.observe("a.com", at(0));
  t.observe("a.com", at(30));
  t.observe("a.com", at(60)); // last look before sleeping
  const woke = t.observe("a.com", at(60 + 600)); // 10 minutes later, same site in front
  assert.deepEqual(woke, [{ id: "g1", domain: "a.com", startedAt: "2026-11-02T10:00:00.000Z", endedAt: "2026-11-02T10:01:00.000Z" }], "sleep not counted");
  assert.equal(t.current.start, at(660), "a new interval starts at the wake");
  assert.deepEqual(t.observe("a.com", at(660 + 80)), [], "regular looks (< gap) continue the interval");
});

test("queue stays bounded and drops what the server would refuse as too old", () => {
  const now = Date.parse("2026-11-03T10:00:00Z");
  const item = (h) => ({ id: String(h), endedAt: new Date(now - h * 3_600_000).toISOString() });
  assert.deepEqual(trimQueue([item(30), item(2), item(1)], now).map((i) => i.id), ["2", "1"]);
  assert.equal(trimQueue(Array.from({ length: 600 }, () => item(1)), now).length, 500);
});

test("server address: https anywhere, plain http only to this computer, normalized", () => {
  assert.equal(apiBaseOf(" https://workfolio.example.com/ "), "https://workfolio.example.com");
  assert.equal(apiBaseOf("https://example.com/insight//"), "https://example.com/insight");
  for (const u of ["http://localhost:4000", "http://127.0.0.1:4000/"]) assert.match(apiBaseOf(u), /^http:\/\//, u);
  for (const u of ["http://workfolio.example.com", "http://192.168.1.10:4000", "http://[::1]:4000", "http://localhost.evil.com", "http://127.0.0.1.nip.io", "ftp://example.com", "javascript:alert(1)", "example.com", "", "https://u:p@example.com", "https://example.com/?x=1", "https://example.com/#a"]) {
    assert.throws(() => apiBaseOf(u), Error, u);
  }
});

test("host permission requested at Connect: exactly the API origin, never a wildcard", () => {
  assert.equal(originPatternOf(apiBaseOf("https://api-staging.example.com/insight/")), "https://api-staging.example.com/*");
  assert.equal(originPatternOf(apiBaseOf("https://API.example.com:8443")), "https://api.example.com:8443/*");
  assert.equal(originPatternOf(apiBaseOf("http://localhost:4000")), "http://localhost:4000/*", "the manifest's required dev permission");
  assert.equal(originPatternOf(apiBaseOf("http://127.0.0.1:5173/")), "http://127.0.0.1:5173/*");
  for (const u of ["https://api.example.com", "http://localhost:4000"]) assert.doesNotMatch(originPatternOf(apiBaseOf(u)), /\*\.|\/\/\*/, u);
});

test("upload refusals give a generic message with the status, no addresses", () => {
  assert.match(uploadError(400), /HTTP 400/);
  assert.match(uploadError(429), /HTTP 429/);
  assert.doesNotMatch(uploadError(403), /\/\/|\.com/);
});
