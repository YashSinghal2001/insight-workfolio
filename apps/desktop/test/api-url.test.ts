import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolveApiUrl } from "../src/api-url.ts";
// @ts-expect-error -- plain .mjs script without type declarations
import { releaseConfig } from "../scripts/desktop-config.mjs";

test("accepted API URLs, normalized without a trailing slash", () => {
  for (const mode of ["development", "production"] as const) {
    assert.equal(resolveApiUrl("https://api.example.com", mode), "https://api.example.com");
    assert.equal(resolveApiUrl("https://API.Example.com/", mode), "https://api.example.com");
    assert.equal(resolveApiUrl("https://example.com:8443/workfolio//", mode), "https://example.com:8443/workfolio");
    assert.equal(resolveApiUrl("https://example.com:443", mode), "https://example.com");
    assert.equal(resolveApiUrl("  https://example.com  ", mode), "https://example.com");
  }
  assert.equal(resolveApiUrl("http://localhost:4000/", "development"), "http://localhost:4000");
  assert.equal(resolveApiUrl("http://127.0.0.1:4000", "development"), "http://127.0.0.1:4000");
  assert.equal(resolveApiUrl("http://[::1]:4000", "development"), "http://[::1]:4000");
  assert.equal(resolveApiUrl(undefined, "development"), "http://localhost:4000", "dev default");
  assert.equal(resolveApiUrl("", "development"), "http://localhost:4000");
});

test("rejected API URLs", () => {
  const always = [
    "http://example.com",
    "http://192.168.1.10:4000",
    "http://localhost.example.com",
    "https://user:pass@api.example.com",
    "https://user@api.example.com",
    "https://api.example.com/?x=1",
    "https://api.example.com/?",
    "https://api.example.com/#frag",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "ws://localhost:4000",
    "ftp://example.com",
    "not a url",
    "api.example.com",
  ];
  for (const mode of ["development", "production"] as const) {
    for (const raw of always) assert.throws(() => resolveApiUrl(raw, mode), Error, `${mode}: ${raw}`);
  }
  for (const raw of ["http://localhost:4000", "http://127.0.0.1:4000", "http://[::1]:4000", undefined, ""]) {
    assert.throws(() => resolveApiUrl(raw, "production"), /https|No API URL/, `production: ${raw}`);
  }
});

test("release config: connect-src gets exactly the API origin in place of the dev API", () => {
  const base = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")).app.security.csp as string;
  const { apiUrl, origin, config } = releaseConfig("https://api.acme.test/workfolio/", base);
  assert.equal(apiUrl, "https://api.acme.test/workfolio");
  assert.equal(origin, "https://api.acme.test");
  const csp: string = config.app.security.csp;
  const connect = csp.split("; ").find((d) => d.startsWith("connect-src "));
  assert.equal(connect, "connect-src 'self' ipc: http://ipc.localhost https://api.acme.test");
  assert.ok(!csp.includes("localhost:4000"));
  assert.equal(csp.replace("https://api.acme.test", "http://localhost:4000"), base, "other directives unchanged");
  assert.deepEqual(Object.keys(config), ["app"], "only the CSP is overridden");

  assert.throws(() => releaseConfig("http://localhost:4000", base), /https/);
  assert.throws(() => releaseConfig(undefined, base), /No API URL/);
  assert.throws(() => releaseConfig("https://api.acme.test", "default-src 'self'"), /connect-src/);
});
