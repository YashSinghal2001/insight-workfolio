// W3-TIMELINE: timeline helpers and rows (SSR), screenshot idle marker (SSR).
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TeamTimelineRow, TimelineSegment } from "@workfolio/shared";
import { groupByZone, rowSummary, segmentTotals } from "@/lib/timeline";

// next/link has no exports map: Node needs the file name (the shared loader only maps the @/ alias).
registerHooks({ resolve: (specifier, context, next) => next(specifier === "next/link" ? "next/link.js" : specifier, context) });
const { TimelineGroup } = await import("@/app/(admin)/timeline/timeline-rows");
const { IdleBadge, shotFrameClass } = await import("@/app/(admin)/screenshots/idle");

const seg = (type: TimelineSegment["type"], from: string, to: string, label: string | null = null): TimelineSegment => ({ type, start: `2026-11-10T${from}:00.000Z`, end: `2026-11-10T${to}:00.000Z`, label });
const row = (id: string, timezone: string, segments: TimelineSegment[]): TeamTimelineRow => ({
  employee: { id, fullName: `Person <${id}>`, employeeCode: id.toUpperCase(), timezone },
  dayStart: "2026-11-10T00:00:00.000Z",
  dayEnd: "2026-11-11T00:00:00.000Z",
  segments,
});

test("segmentTotals and rowSummary: text totals, not-clocked-in left out", () => {
  const segs = [seg("UNTRACKED", "00:00", "09:00"), seg("PRODUCTIVE", "09:00", "11:00", "Code"), seg("IDLE", "11:00", "11:30"), seg("BREAK", "12:00", "13:00")];
  assert.equal(segmentTotals(segs).PRODUCTIVE, 2 * 3_600_000);
  assert.equal(segmentTotals(segs).UNTRACKED, 9 * 3_600_000);
  assert.equal(rowSummary(segs), "Productive 2h 00m · Idle 30m 00s · Break 1h 00m");
  assert.equal(rowSummary([seg("UNTRACKED", "00:00", "24:00")]), "Not clocked in");
  assert.equal(rowSummary([]), "No data");
});

test("groupByZone keeps first-seen order", () => {
  const g = groupByZone([row("a", "UTC", []), row("b", "Asia/Kolkata", []), row("c", "UTC", [])]);
  assert.deepEqual(g.map((x) => [x.zone, x.rows.map((r) => r.employee.id)]), [["UTC", ["a", "c"]], ["Asia/Kolkata", ["b"]]]);
});

test("TimelineGroup: rows link to the profile, escaped names, text summary, segment tooltips, zone ticks", () => {
  const html = renderToStaticMarkup(<TimelineGroup zone="UTC" rows={[row("a", "UTC", [seg("UNTRACKED", "00:00", "09:00"), seg("UNPRODUCTIVE", "09:00", "10:00", "Game")])]} />);
  assert.match(html, /href="\/employees\/a"/);
  assert.match(html, /Person &lt;a&gt;/);
  assert.match(html, /aria-label="Person &lt;a&gt; \(A\): Unproductive 1h 00m\. Open profile"/);
  assert.match(html, /data-segment="UNPRODUCTIVE"[^>]*><title>Unproductive 09:00–10:00 \(1h 00m\) · Game<\/title>/);
  assert.match(html, /<title>Not clocked in 00:00–09:00/);
  assert.match(html, />12:00</, "hour ticks");
  assert.match(html, /aria-label="Employees in UTC"/);
});

test("idle screenshots: red border plus a text label; nothing for non-idle", () => {
  assert.match(shotFrameClass(true), /border-danger/);
  assert.doesNotMatch(shotFrameClass(false), /danger/);
  assert.match(renderToStaticMarkup(<IdleBadge idle />), />Idle</);
  assert.equal(renderToStaticMarkup(<IdleBadge idle={false} />), "");
});
