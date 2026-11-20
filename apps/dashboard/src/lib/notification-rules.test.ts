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
const admins = [{ userId: "a1", label: "Zed Admin", email: "a1@example.com" }, { userId: "h1", label: "Hana Head", email: "h1@example.com" }];

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

test("candidatesFor: admins everywhere; the team head only on that team's rule; current recipients kept; no duplicates", () => {
  assert.deepEqual(candidatesFor(rule({}), admins.slice(0, 1), teams).map((c) => c.userId), ["a1"]);
  const team = candidatesFor(rule({ teamId: "t1" }), admins.slice(0, 1), teams);
  assert.deepEqual(team.map((c) => [c.userId, c.kind]), [["h1", "head"], ["a1", "admin"]]);
  assert.equal(candidatesFor(rule({ teamId: "t3" }), [], teams).length, 0, "inactive team's head not offered");
  const dup = candidatesFor(rule({ teamId: "t1", recipients: [{ userId: "h1", fullName: "Hana Head", email: "h1@example.com" }] }), admins, teams);
  assert.deepEqual(dup.map((c) => [c.userId, c.kind]), [["h1", "admin"], ["a1", "admin"]]);
  const gone = candidatesFor(rule({ recipients: [{ userId: "old", fullName: null, email: "old@example.com" }] }), [], teams);
  assert.deepEqual(gone.map((c) => [c.label, c.kind]), [["old@example.com", "current"]]);
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
