import assert from "node:assert/strict";
import { test } from "node:test";
import { categorize, normalizeDomain, websiteCategorySchema, websiteIntervalsSchema, websiteRangeSchema } from "../dist/index.js";

test("domains: hostnames only, normalized; URLs, paths, queries, ports, IPs and credentials refused", () => {
  for (const [input, out] of [
    ["Docs.Example.COM", "docs.example.com"], ["www.example.com", "example.com"], ["example.com.", "example.com"],
    ["bücher.de", "xn--bcher-kva.de"], ["a-b.example.co.uk", "a-b.example.co.uk"], ["www2.example.com", "www2.example.com"],
  ]) assert.equal(normalizeDomain(input), out, input);
  for (const bad of ["https://example.com", "example.com/path", "example.com?q=1", "example.com#x", "example.com:443", "user@example.com", "user:pw@example.com",
    "1.2.3.4", "[::1]", "::1", "localhost", "example", "a..b", "-a.com", "a-.com", "example.123", " example.com", "exa mple.com", "x%2f.com", "x\\y.com", "a".repeat(64) + ".com", ""]) {
    assert.equal(normalizeDomain(bad), null, JSON.stringify(bad));
  }
});

test("categories: exact beats subdomain rules; the longest subdomain rule wins; otherwise unclassified", () => {
  const rules = [
    { id: "1", domain: "example.com", match: "SUBDOMAINS" as const, category: "NEUTRAL" as const },
    { id: "2", domain: "docs.example.com", match: "EXACT" as const, category: "PRODUCTIVE" as const },
    { id: "3", domain: "games.example.com", match: "SUBDOMAINS" as const, category: "UNPRODUCTIVE" as const },
    { id: "4", domain: "news.org", match: "EXACT" as const, category: "NEUTRAL" as const },
  ];
  assert.deepEqual(categorize("docs.example.com", rules), { category: "PRODUCTIVE", ruleId: "2" });
  assert.deepEqual(categorize("example.com", rules), { category: "NEUTRAL", ruleId: "1" });
  assert.deepEqual(categorize("a.docs.example.com", rules), { category: "NEUTRAL", ruleId: "1" }, "exact does not cover subdomains");
  assert.deepEqual(categorize("x.games.example.com", rules), { category: "UNPRODUCTIVE", ruleId: "3" });
  assert.deepEqual(categorize("notexample.com", rules), { category: "UNCLASSIFIED", ruleId: null }, "suffix must be a whole label");
  assert.deepEqual(categorize("sub.news.org", rules), { category: "UNCLASSIFIED", ruleId: null });
});

test("schemas: rules take a normalized domain; uploads carry no URLs, titles or identity; ranges bounded", () => {
  assert.deepEqual(websiteCategorySchema.parse({ domain: "WWW.Example.com", match: "SUBDOMAINS", category: "NEUTRAL" }), { domain: "example.com", match: "SUBDOMAINS", category: "NEUTRAL" });
  assert.equal(websiteCategorySchema.safeParse({ domain: "example.com/x", match: "EXACT", category: "NEUTRAL" }).success, false);
  const iv = { id: "6f1c3e5a-1b2c-4d3e-8f90-123456789abc", domain: "example.com", startedAt: "2026-11-02T10:00:00Z", endedAt: "2026-11-02T10:01:00Z" };
  assert.ok(websiteIntervalsSchema.safeParse({ sentAt: "2026-11-02T10:02:00Z", intervals: [iv] }).success);
  for (const extra of [{ url: "https://example.com/a" }, { title: "Inbox" }, { path: "/a" }, { employeeId: "x" }]) {
    assert.equal(websiteIntervalsSchema.safeParse({ sentAt: "2026-11-02T10:02:00Z", intervals: [{ ...iv, ...extra }] }).success, false, JSON.stringify(extra));
  }
  assert.equal(websiteRangeSchema.safeParse({ from: "2026-10-01", to: "2026-11-01" }).success, false, "31 days max");
  assert.ok(websiteRangeSchema.safeParse({ from: "2026-10-01", to: "2026-10-31" }).success);
});
