// F04: the Websites tab's wording (the server decides who may record what).
import assert from "node:assert/strict";
import { test } from "node:test";
import { WEBSITE_DATA, type AuthUser } from "@workfolio/shared";
import { usageLine } from "../src/websites.ts";

test("usage lines: domain, recorded time and the organization's category, labelled as such", () => {
  assert.equal(usageLine({ domain: "docs.example.com", durationMs: 12 * 60_000, intervals: 3, category: "PRODUCTIVE" }), "docs.example.com — 0h 12m (3 visits) · category: productive");
  assert.equal(usageLine({ domain: "x.org", durationMs: 60_000, intervals: 1, category: "UNCLASSIFIED" }), "x.org — 0h 01m (1 visit) · category: unclassified");
});

test("the employee is told what is and is never recorded", () => {
  assert.match(WEBSITE_DATA.collected.join(" "), /domain name only/);
  for (const never of [/paths/, /search terms/, /titles, page content/, /history/, /incognito/]) assert.match(WEBSITE_DATA.never.join(" "), never);
});

test("the app itself reads no browser data (no history, cookies or browser files in the desktop code)", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["../src-tauri/src/lib.rs", "../src-tauri/src/activity/mod.rs", "../src/websites.ts"]) {
    let text = "";
    try {
      text = readFileSync(new URL(f, import.meta.url), "utf8");
    } catch {
      continue;
    }
    assert.ok(!/History\.db|Cookies|Library\/Safari|Google\/Chrome|places\.sqlite/i.test(text), f);
  }
});

test("roles in the desktop app are display only, taken from the server's /auth/me", async () => {
  const { profileOf } = await import("../src/session.ts");
  const user = (role: "ADMIN" | "EMPLOYEE", platformRole?: "SUPER_ADMIN" | "ADMIN" | "EMPLOYEE") => ({ id: "u", email: "x@example.com", role, platformRole }) as AuthUser; // platformRole omitted: an older server
  assert.equal(profileOf({ user: user("ADMIN", "SUPER_ADMIN"), employee: null }).platformRole, "SUPER_ADMIN");
  assert.equal(profileOf({ user: user("ADMIN"), employee: null }).platformRole, "ADMIN", "older servers: ADMIN without a title is an Admin");
  assert.equal(profileOf({ user: user("ADMIN", "ADMIN"), employee: null }).hasEmployeeProfile, false);
  assert.equal(profileOf({ user: user("EMPLOYEE", "EMPLOYEE"), employee: null }).platformRole, "EMPLOYEE");
  const { readFileSync } = await import("node:fs");
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.ok(!/platformRole[^\n]*(?:request|invoke|hidden = false[^\n]*tab)/.test(main), "the role is only used for labels, never to enable requests");
});
