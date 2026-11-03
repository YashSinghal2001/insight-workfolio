// Run: node --test apps/dashboard/src/lib/zoned-time.test.mjs (Node strips the helper's types).
import assert from "node:assert/strict";
import { test } from "node:test";
import { zonedTime } from "./zoned-time.ts";

test("one instant shows each employee's own wall-clock time, with the zone named", () => {
  const at = "2026-11-02T09:00:00Z";
  assert.equal(zonedTime(at, "Asia/Kolkata"), "2 Nov 2026, 14:30:00 (Asia/Kolkata)");
  assert.equal(zonedTime(at, "America/New_York"), "2 Nov 2026, 04:00:00 (America/New_York)");
  assert.equal(zonedTime("2026-11-02T23:30:00Z", "Asia/Tokyo"), "3 Nov 2026, 08:30:00 (Asia/Tokyo)");
});

test("an unknown zone yields null instead of throwing", () => {
  assert.equal(zonedTime("2026-11-02T09:00:00Z", "Nowhere/City"), null);
});
