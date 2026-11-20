import assert from "node:assert/strict";
import { test } from "node:test";
import type { NotificationRule } from "@workfolio/shared";
import { candidatesFor, groupRules, ruleChanges, ruleSummary, teamsWithoutRule, type TeamLite } from "./notification-rules.ts";

const rule = (p: Partial<NotificationRule>): NotificationRule => ({
  id: "r", type: "LATE_ARRIVAL", mode: "OFF", digestLocalTime: "18:00", timezone: "Asia/Kolkata", teamId: null, recipients: [],
  changedBy: "u", createdAt: "", updatedAt: "", ...p,
});
const teams: TeamLite[] = [
  { id: "t1", name: "Beta", active: true, head: { id: "h1", email: "h1@example.com", fullName: "Hana Head" } },
  { id: "t2", name: "Alpha", active: true, head: null },
  { id: "t3", name: "Gone", active: false, head: { id: "h3", email: "h3@example.com", fullName: null } },
];
const elig = (userId: string, fullName: string | null, teamHead = false) => ({ userId, fullName, email: `${userId}@example.com`, platformRole: teamHead ? "EMPLOYEE" as const : "ADMIN" as const, teamHead });

test("groupRules: six types in fixed order, org rule first, team rules by team name", () => {
  const rules = [rule({ id: "x", teamId: "t1" }), rule({ id: "o" }), rule({ id: "y", teamId: "t2" }), rule({ id: "c", type: "ATTENDANCE_CLOCK_IN" })];
  const g = groupRules(rules, (id) => teams.find((t) => t.id === id)!.name);
  assert.deepEqual(g.map((x) => x.type), ["ATTENDANCE_CLOCK_IN", "ATTENDANCE_CLOCK_OUT", "LATE_ARRIVAL", "ABSENCE", "MISSING_CLOCK_OUT", "PRODUCTIVITY_ALERT"]);
  assert.equal(g[0]!.org!.id, "c");
  assert.equal(g[1]!.org, null);
  assert.equal(g[2]!.org!.id, "o");
  assert.deepEqual(g[2]!.teams.map((r) => r.id), ["y", "x"]);
  assert.deepEqual(groupRules([], () => "").flatMap((x) => x.teams), []);
});

test("candidatesFor: the API's eligible accounts (head marked), current recipients kept, no duplicates, by name", () => {
  assert.deepEqual(candidatesFor(rule({}), []), []);
  const c = candidatesFor(rule({ teamId: "t1" }), [elig("a1", "Zed Admin"), elig("h1", "Hana Head", true), elig("a2", null)]);
  assert.deepEqual(c.map((x) => [x.userId, x.kind, x.label]), [["a2", "admin", "a2@example.com"], ["h1", "head", "Hana Head"], ["a1", "admin", "Zed Admin"]]);
  const dup = candidatesFor(rule({ recipients: [{ userId: "a1", fullName: "Zed Admin", email: "a1@example.com" }] }), [elig("a1", "Zed Admin")]);
  assert.deepEqual(dup.map((x) => [x.userId, x.kind]), [["a1", "admin"]]);
  const gone = candidatesFor(rule({ recipients: [{ userId: "old", fullName: null, email: "old@example.com" }] }), []);
  assert.deepEqual(gone.map((x) => [x.label, x.kind]), [["old@example.com", "current"]]);
});

test("teamsWithoutRule: active teams lacking a rule of the type, by name", () => {
  assert.deepEqual(teamsWithoutRule(teams, []).map((t) => t.id), ["t2", "t1"]);
  assert.deepEqual(teamsWithoutRule(teams, [rule({ teamId: "t2" })]).map((t) => t.id), ["t1"]);
});

test("ruleChanges: only changed fields; trimmed zone; null when unchanged", () => {
  const r = rule({});
  assert.equal(ruleChanges(r, { mode: "OFF", digestLocalTime: "18:00", timezone: "Asia/Kolkata" }), null);
  assert.deepEqual(ruleChanges(r, { mode: "DAILY_DIGEST", digestLocalTime: "09:30", timezone: " America/New_York " }), { mode: "DAILY_DIGEST", digestLocalTime: "09:30", timezone: "America/New_York" });
  assert.deepEqual(ruleChanges(rule({ digestLocalTime: null }), { mode: "OFF", digestLocalTime: "18:00", timezone: "Asia/Kolkata" }), { digestLocalTime: "18:00" });
});

test("ruleSummary", () => {
  assert.equal(ruleSummary(rule({})), "Off");
  assert.equal(ruleSummary(rule({ mode: "IMMEDIATE" })), "Immediate");
  assert.equal(ruleSummary(rule({ mode: "DAILY_DIGEST", digestLocalTime: "07:15", timezone: "UTC" })), "Daily digest at 07:15 (UTC)");
});
