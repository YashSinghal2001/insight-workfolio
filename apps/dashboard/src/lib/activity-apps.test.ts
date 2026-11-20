import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActivityAppsResponse } from "@workfolio/shared";
import { appDonut, categoryShare, historyBars, parseActivityTab, unreviewed, violatedRules } from "./activity-apps";

const app = (key: string, activeMs: number, category: ActivityAppsResponse["applications"][number]["category"]) => ({ key, applicationIdentifier: key, applicationName: key.toUpperCase(), activeMs, category, employees: 1 });
const zero = { PRODUCTIVE: 0, NEUTRAL: 0, UNPRODUCTIVE: 0, UNCLASSIFIED: 0 };
const ref = (id: string) => ({ id, fullName: `Person ${id}`, employeeCode: id, timezone: "UTC" });

test("parseActivityTab: ?tab wins; old ?employeeId links open One employee; default Summary", () => {
  assert.equal(parseActivityTab(new URLSearchParams("")), "summary");
  assert.equal(parseActivityTab(new URLSearchParams("tab=review")), "review");
  assert.equal(parseActivityTab(new URLSearchParams("tab=nope")), "summary");
  assert.equal(parseActivityTab(new URLSearchParams("employeeId=6f1c2b1e-1111-4222-8333-444455556666")), "employee");
  assert.equal(parseActivityTab(new URLSearchParams("employeeId=../x")), "summary");
  assert.equal(parseActivityTab(new URLSearchParams("tab=history&employeeId=6f1c2b1e-1111-4222-8333-444455556666")), "history");
});

test("appDonut: label colours, top 7 + 'Other apps'; no fold when ≤ 8", () => {
  const few = appDonut([app("a", 5, "PRODUCTIVE"), app("b", 3, "UNCLASSIFIED")]);
  assert.deepEqual(few, [{ label: "A (Productive)", value: 5, color: "var(--success)" }, { label: "B (Unclassified)", value: 3, color: "var(--muted)" }]);
  const many = appDonut(Array.from({ length: 10 }, (_, i) => app(`x${i}`, 10 - i, "UNPRODUCTIVE")));
  assert.equal(many.length, 8);
  assert.deepEqual(many.at(-1), { label: "Other apps", value: 3 + 2 + 1, color: "var(--border-strong)" });
  assert.equal(many[0]!.color, "var(--danger)");
  assert.deepEqual(appDonut([]), []);
});

test("categoryShare: Everyone row then the most active employees (idle-only people skipped), series in label order", () => {
  const data = {
    categories: { PRODUCTIVE: 3, NEUTRAL: 1, UNPRODUCTIVE: 2, UNCLASSIFIED: 4 },
    employees: [
      { employee: ref("a"), activeMs: 2, idleMs: 0, categories: { ...zero, PRODUCTIVE: 2 }, topApplication: "A" },
      { employee: ref("b"), activeMs: 0, idleMs: 9, categories: zero, topApplication: null },
      { employee: ref("c"), activeMs: 8, idleMs: 0, categories: { ...zero, UNCLASSIFIED: 8 }, topApplication: "C" },
    ],
  };
  const { series, rows } = categoryShare(data, 5);
  assert.deepEqual(series.map((s) => s.label), ["Productive", "Neutral", "Unproductive", "Unclassified"]);
  assert.deepEqual(rows, [
    { label: "Everyone", values: [3, 1, 2, 4] },
    { label: "Person c", values: [0, 0, 0, 8] },
    { label: "Person a", values: [2, 0, 0, 0] },
  ]);
  assert.equal(categoryShare(data).rows.length, 1);
});

test("unreviewed, historyBars, violatedRules", () => {
  assert.deepEqual(unreviewed([app("a", 5, "PRODUCTIVE"), app("b", 3, "UNCLASSIFIED")]).map((a) => a.key), ["b"]);
  assert.deepEqual(historyBars([{ date: "2026-05-04", activeMs: 60 }]), [{ label: "05-04", values: [60] }]);
  assert.deepEqual(
    violatedRules([
      { trigger: "LESS_WORKING_HOURS", employees: 1, count: 4 },
      { trigger: "LATE_CLOCK_IN", employees: 2, count: 2 },
      { trigger: "NO_ACTIVITY_FOR", employees: 0, count: 0 },
    ]).map((r) => [r.trigger, r.label]),
    [["LATE_CLOCK_IN", "Late clock-in"], ["LESS_WORKING_HOURS", "Less working hours"]],
  );
});
