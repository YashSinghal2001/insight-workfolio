import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { categorizeForEmployee, employeeTrackingOverrideSchema, hasPermission, isTeamHeadPermission, PERMISSIONS, TEAM_HEAD_PERMISSIONS, teamCreateSchema, teamLabelSchema, teamMembersSchema, teamProductivityQuerySchema, teamUpdateSchema } from "../dist/index.js";

test("team schemas: trimmed names, optional head, non-empty updates, unique member ids, bounded productivity range", () => {
  assert.deepEqual(teamCreateSchema.parse({ name: " Sales " }), { name: "Sales", headUserId: null });
  const head = randomUUID();
  assert.equal(teamCreateSchema.parse({ name: "S", headUserId: head }).headUserId, head);
  for (const bad of [{ name: "" }, { name: "x".repeat(81) }, { name: "S", headUserId: "nope" }, { name: "S", extra: 1 }]) assert.equal(teamCreateSchema.safeParse(bad).success, false);
  assert.equal(teamUpdateSchema.safeParse({}).success, false);
  assert.equal(teamUpdateSchema.safeParse({ headUserId: null }).success, true);
  assert.equal(teamUpdateSchema.safeParse({ active: false }).success, true);
  const id = randomUUID();
  assert.equal(teamMembersSchema.safeParse({ employeeIds: [id, id] }).success, false);
  assert.equal(teamMembersSchema.safeParse({ employeeIds: [] }).success, true);
  assert.equal(teamProductivityQuerySchema.safeParse({ from: "2026-01-01", to: "2026-01-31" }).success, true);
  assert.equal(teamProductivityQuerySchema.safeParse({ from: "2026-01-01", to: "2026-02-01" }).success, false);
  assert.equal(teamProductivityQuerySchema.safeParse({ from: "2026-01-02", to: "2026-01-01" }).success, false);
});

test("teams:manage is admin-only; team-head permissions are reads employees do not hold by role", () => {
  assert.equal(hasPermission("ADMIN", "teams:manage"), true);
  assert.equal(hasPermission("EMPLOYEE", "teams:manage"), false);
  for (const p of TEAM_HEAD_PERMISSIONS) {
    assert.ok(p in PERMISSIONS);
    assert.equal(hasPermission("EMPLOYEE", p), false, p);
    assert.equal(isTeamHeadPermission(p), true);
  }
  for (const p of ["teams:manage", "settings:manage", "roles:manage", "employees:manage", "reports:manage"] as const) assert.equal(isTeamHeadPermission(p), false, p);
});

test("F05 per-team labels: agreeing team rules win, no team rule or disagreeing teams fall back to the organisation", () => {
  const rule = (id: string, value: string, category: "PRODUCTIVE" | "NEUTRAL" | "UNPRODUCTIVE", matchKind: "NAME" | "IDENTIFIER" = "NAME") => ({ id, matchKind, value, category });
  const slack = { applicationIdentifier: "com.tinyspeck.slackmacgap", applicationName: "Slack" };
  const org = [rule("o", "slack", "NEUTRAL")];
  const support = [rule("s", "com.tinyspeck.slackmacgap", "PRODUCTIVE", "IDENTIFIER")];
  const sales = [rule("a", "Slack", "PRODUCTIVE")];
  const eng = [rule("e", "Slack", "UNPRODUCTIVE")];
  const none = [rule("n", "Xcode", "PRODUCTIVE")];
  assert.equal(categorizeForEmployee(slack, org, []), "NEUTRAL", "no team");
  assert.equal(categorizeForEmployee(slack, org, [support]), "PRODUCTIVE", "team override");
  assert.equal(categorizeForEmployee(slack, org, [support, none]), "PRODUCTIVE", "a team without a rule for the app does not disagree");
  assert.equal(categorizeForEmployee(slack, org, [support, sales]), "PRODUCTIVE", "teams agree");
  assert.equal(categorizeForEmployee(slack, org, [support, eng]), "NEUTRAL", "teams disagree: organisation");
  assert.equal(categorizeForEmployee(slack, [], [support, eng]), "UNCLASSIFIED", "disagree and no organisation rule");
  assert.equal(categorizeForEmployee({ applicationIdentifier: null, applicationName: "Zoom" }, org, [support]), "UNCLASSIFIED");
  assert.equal(teamLabelSchema.safeParse({ matchKind: "NAME", value: "Slack", category: "PRODUCTIVE" }).success, true);
  assert.equal(teamLabelSchema.safeParse({ matchKind: "NAME", value: "Slack", category: "GREAT" }).success, false);
});

test("F08 self-view override: true / false / null accepted, omitted allowed (carries over), anything else rejected", () => {
  const base = { expectedStart: null, workdays: null, idleThresholdSeconds: null, reason: "privacy request" };
  for (const v of [true, false, null]) assert.equal(employeeTrackingOverrideSchema.parse({ ...base, screenshotSelfView: v }).screenshotSelfView, v);
  assert.equal(employeeTrackingOverrideSchema.parse(base).screenshotSelfView, undefined);
  assert.equal(employeeTrackingOverrideSchema.safeParse({ ...base, screenshotSelfView: "deny" }).success, false);
});
