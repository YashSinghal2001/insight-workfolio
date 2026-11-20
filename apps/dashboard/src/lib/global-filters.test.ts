// Run: node --test apps/dashboard/src/lib/global-filters.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { isLocalDate, parseGlobalFilters, serialiseGlobalFilters, todayLocal } from "./global-filters.ts";

const TODAY = "2026-11-20";
const TEAM = "6f1c2b3a-1d2e-4f50-8a9b-0c1d2e3f4a5b";
const q = (s: string) => new URLSearchParams(s);

test("valid date and team are kept", () => {
  assert.deepEqual(parseGlobalFilters(q(`date=2026-11-02&team=${TEAM}`), TODAY), { date: "2026-11-02", teamId: TEAM });
  assert.deepEqual(parseGlobalFilters(q("date=2024-02-29"), TODAY), { date: "2024-02-29", teamId: null });
});

test("empty params mean today and all teams", () => {
  assert.deepEqual(parseGlobalFilters(q(""), TODAY), { date: TODAY, teamId: null });
  assert.deepEqual(parseGlobalFilters(q("date=&team="), TODAY), { date: TODAY, teamId: null });
});

test("bad dates are ignored", () => {
  for (const d of ["2026-02-30", "2025-02-29", "2026-13-01", "20261102", "2026-1-2", "today", "2026-11-02T00:00", "<script>"]) {
    assert.equal(parseGlobalFilters(q(`date=${encodeURIComponent(d)}`), TODAY).date, TODAY, d);
  }
  assert.equal(isLocalDate(null), false);
});

test("non-uuid and unknown teams mean all teams", () => {
  assert.equal(parseGlobalFilters(q("team=abc"), TODAY).teamId, null);
  assert.equal(parseGlobalFilters(q(`team=${TEAM}x`), TODAY).teamId, null);
  assert.equal(parseGlobalFilters(q(`team=${TEAM}`), TODAY, ["00000000-0000-4000-8000-000000000000"]).teamId, null);
  assert.equal(parseGlobalFilters(q(`team=${TEAM}`), TODAY, []).teamId, null);
  assert.equal(parseGlobalFilters(q(`team=${TEAM.toUpperCase()}`), TODAY, [TEAM]).teamId, TEAM);
});

test("serialise drops defaults and keeps unrelated params", () => {
  assert.equal(serialiseGlobalFilters(q("view=daily"), { date: TODAY, teamId: null }, TODAY), "?view=daily");
  assert.equal(serialiseGlobalFilters(q(""), { date: TODAY, teamId: null }, TODAY), "");
  assert.equal(serialiseGlobalFilters(q("view=daily&date=2026-01-01"), { date: "2026-11-02", teamId: TEAM }, TODAY), `?view=daily&date=2026-11-02&team=${TEAM}`);
  assert.equal(serialiseGlobalFilters(q(`date=2026-11-02&team=${TEAM}`), { date: TODAY, teamId: null }, TODAY), "");
  assert.equal(serialiseGlobalFilters(q(""), { date: "nope", teamId: "nope" }, TODAY), "");
});

test("parse(serialise(x)) round-trips", () => {
  const v = { date: "2026-03-08", teamId: TEAM };
  assert.deepEqual(parseGlobalFilters(q(serialiseGlobalFilters(q(""), v, TODAY).slice(1)), TODAY, [TEAM]), v);
});

test("today is read in the viewer's zone (boundary around midnight UTC)", () => {
  const at = Date.parse("2026-11-19T20:00:00Z");
  assert.equal(todayLocal(at, "Asia/Kolkata"), "2026-11-20");
  assert.equal(todayLocal(at, "America/New_York"), "2026-11-19");
  assert.equal(todayLocal(Date.parse("2026-03-08T07:30:00Z"), "America/New_York"), "2026-03-08");
});
