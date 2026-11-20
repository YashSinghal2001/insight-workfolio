import assert from "node:assert/strict";
import { test } from "node:test";
import type { OverviewKpis } from "@workfolio/shared";
import { appSlices, clock, dateRange, dayLabel, hhmm, kpiCards, longDay, overviewPath, stateBadge, workloadData } from "./overview-data";

const KPIS: OverviewKpis = {
  totalMembers: 7, workingNow: 1, onBreak: 1, clockedOut: 2, notStarted: 4, onLeave: 1, appNotInstalled: 2,
  late: 2, absent: 3, missingClockOuts: 1, screenshotsStored: 5, netWorkMs: 3_600_000, breakMs: 600_000,
};

test("kpiCards: labels the browser suite reads, values as given, today vs another day", () => {
  const cards = kpiCards(KPIS, true);
  const by = Object.fromEntries(cards.map((c) => [c.label, c]));
  for (const l of ["Active employees", "Working now", "On a break", "Clocked out today", "Not clocked in today", "Screenshots stored today", "Late today", "Absent today", "On leave", "App not installed", "Missing clock-outs"]) {
    assert.ok(by[l], l);
  }
  assert.deepEqual([by["Working now"]!.value, by["Late today"]!.value, by["Absent today"]!.value, by["App not installed"]!.value], [1, 2, 3, 2]);
  assert.match(by["Not clocked in today"]!.hint!, /Not the same as absent/);
  assert.equal(by["Late today"]!.tone, "danger");
  assert.equal(by["Net work today"]!.value, "1h 00m");
  const past = kpiCards(KPIS, false).map((c) => c.label);
  assert.ok(past.includes("Late that day") && past.includes("Clocked out that day") && !past.some((l) => l.endsWith("today")));
});

test("kpiCards: no schedule → late/absent not available, linked to the schedule; zero counts are not coloured", () => {
  const cards = kpiCards({ ...KPIS, late: null, absent: null, appNotInstalled: 0, missingClockOuts: 0 }, true);
  const late = cards.find((c) => c.label === "Late today")!;
  assert.deepEqual([late.value, late.reason, late.href, late.tone], [null, "Work schedule not configured", "/settings/schedule", undefined]);
  assert.equal(cards.find((c) => c.label === "App not installed")!.tone, undefined);
  assert.equal(cards.find((c) => c.label === "Missing clock-outs")!.tone, undefined);
});

test("workload chart data and labels (dates read as dates, not instants)", () => {
  assert.equal(dayLabel("2026-03-08"), "Sun 8");
  assert.equal(longDay("2026-12-25"), "Fri 25 Dec");
  assert.deepEqual(workloadData([{ date: "2026-11-16", overworked: 1, healthy: 2, lessUtilised: 3 }]), [{ label: "Mon 16", values: [1, 2, 3] }]);
  assert.deepEqual(workloadData([]), []);
});

test("appSlices: top apps then one muted 'Other apps' slice only when there is a rest", () => {
  assert.deepEqual(appSlices({ totalActiveMs: 30, otherMs: 0, items: [{ applicationName: "Editor", activeMs: 30 }] }), [{ label: "Editor", value: 30 }]);
  assert.deepEqual(appSlices({ totalActiveMs: 40, otherMs: 10, items: [{ applicationName: "Editor", activeMs: 30 }] }).at(-1), { label: "Other apps", value: 10, color: "var(--muted)" });
  assert.deepEqual(appSlices({ totalActiveMs: 0, otherMs: 0, items: [] }), []);
});

test("times, ranges, badges, request path", () => {
  assert.equal(hhmm("2026-11-20T09:05"), "09:05");
  assert.equal(hhmm(null), "—");
  assert.equal(clock("2026-11-20T03:35:00.000Z", "Asia/Kolkata"), "09:05");
  assert.equal(clock("2026-03-08T07:00:00.000Z", "America/New_York"), "03:00", "after the DST jump");
  assert.equal(clock(null, "UTC"), "—");
  assert.equal(clock("2026-11-20T03:35:00.000Z", "Mars/Olympus"), "—");
  assert.equal(dateRange("2026-11-12", "2026-11-12"), "12 Nov");
  assert.equal(dateRange("2026-11-12", "2026-11-14"), "12–14 Nov");
  assert.equal(dateRange("2026-11-30", "2026-12-02"), "30 Nov – 2 Dec");
  assert.deepEqual(stateBadge("CLOCKED_IN", true), { tone: "danger", label: "Missing clock-out" });
  assert.deepEqual(stateBadge("ON_BREAK", false), { tone: "warning", label: "On a break" });
  assert.deepEqual(stateBadge("CLOCKED_OUT", false), { tone: "neutral", label: "Clocked out" });
  assert.equal(overviewPath("2026-11-20", null), "/overview?date=2026-11-20");
  assert.equal(overviewPath("2026-11-20", "t1"), "/overview?date=2026-11-20&teamId=t1");
});
