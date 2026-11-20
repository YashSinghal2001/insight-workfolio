import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTimelineSegments, screenshotExportSchema, screenshotGallerySchema, teamTimelineQuerySchema, zonedToUtc } from "../dist/index.js";

const H = 3_600_000;
const D0 = Date.parse("2026-11-10T00:00:00.000Z");
const at = (h: number) => new Date(D0 + h * H).toISOString();
const short = (segs: { type: string; start: string; end: string; label: string | null }[]) =>
  segs.map((s) => `${s.type}${s.label ? `(${s.label})` : ""} ${(Date.parse(s.start) - D0) / H}-${(Date.parse(s.end) - D0) / H}`);

test("buildTimelineSegments: untracked, break, idle and labelled app time; blank where clocked in without data", () => {
  const segs = buildTimelineSegments({
    dayStart: D0,
    dayEnd: D0 + 24 * H,
    now: D0 + 48 * H,
    sessions: [{ clockInAt: at(9), clockOutAt: at(17), breaks: [{ startedAt: at(12), endedAt: at(13) }] }],
    intervals: [
      { kind: "ACTIVE", startedAt: at(9), endedAt: at(10), category: "PRODUCTIVE", applicationName: "Code" },
      { kind: "ACTIVE", startedAt: at(10), endedAt: at(10.5), category: "PRODUCTIVE", applicationName: "Code" },
      { kind: "IDLE", startedAt: at(10.5), endedAt: at(11), category: null, applicationName: null },
      { kind: "ACTIVE", startedAt: at(11), endedAt: at(12.5), category: "UNPRODUCTIVE", applicationName: "Game" }, // runs into the break: trimmed
      { kind: "ACTIVE", startedAt: at(13), endedAt: at(14), category: "NEUTRAL", applicationName: "Mail" },
      { kind: "ACTIVE", startedAt: at(14), endedAt: at(15), category: "UNCLASSIFIED", applicationName: "Thing" },
    ],
  });
  assert.deepEqual(short(segs), [
    "UNTRACKED 0-9",
    "PRODUCTIVE(Code) 9-10.5",
    "IDLE 10.5-11",
    "UNPRODUCTIVE(Game) 11-12",
    "BREAK 12-13",
    "NEUTRAL(Mail) 13-14",
    "NEUTRAL(Thing · unlabelled) 14-15",
    "UNTRACKED 17-24",
  ]);
});

test("buildTimelineSegments: open session and open break run to now; nothing after now; sessions from the previous day are clipped", () => {
  const segs = buildTimelineSegments({
    dayStart: D0,
    dayEnd: D0 + 24 * H,
    now: D0 + 10 * H,
    sessions: [
      { clockInAt: at(-2), clockOutAt: at(1), breaks: [] },
      { clockInAt: at(8), clockOutAt: null, breaks: [{ startedAt: at(9), endedAt: null }] },
    ],
    intervals: [{ kind: "IDLE", startedAt: at(-1), endedAt: at(0.5), category: null, applicationName: null }],
  });
  assert.deepEqual(short(segs), ["IDLE 0-0.5", "UNTRACKED 1-8", "BREAK 9-10"]);
});

test("buildTimelineSegments: a future day or empty day", () => {
  assert.deepEqual(buildTimelineSegments({ dayStart: D0, dayEnd: D0 + 24 * H, now: D0 - 1, sessions: [], intervals: [] }), []);
  assert.deepEqual(short(buildTimelineSegments({ dayStart: D0, dayEnd: D0 + 24 * H, now: D0 + 30 * H, sessions: [], intervals: [] })), ["UNTRACKED 0-24"]);
});

test("buildTimelineSegments: a 23-hour DST day in America/New_York", () => {
  const dayStart = Date.parse(zonedToUtc("2026-03-08T00:00", "America/New_York"));
  const dayEnd = Date.parse(zonedToUtc("2026-03-09T00:00", "America/New_York"));
  assert.equal(dayEnd - dayStart, 23 * H);
  const segs = buildTimelineSegments({ dayStart, dayEnd, now: dayEnd + H, sessions: [], intervals: [] });
  assert.deepEqual(segs.map((s) => [s.start, s.end]), [[new Date(dayStart).toISOString(), new Date(dayEnd).toISOString()]]);
});

test("schemas: team timeline query, export ids, gallery idle flag", () => {
  assert.deepEqual(teamTimelineQuerySchema.parse({ date: "2026-11-10" }), { date: "2026-11-10", page: 1, pageSize: 50 });
  for (const bad of [{}, { date: "10/11/2026" }, { date: "2026-11-10", teamId: "x" }, { date: "2026-11-10", pageSize: "101" }, { date: "2026-11-10", employeeId: crypto.randomUUID() }]) {
    assert.equal(teamTimelineQuerySchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
  const id = crypto.randomUUID();
  assert.equal(screenshotExportSchema.safeParse({ ids: [id] }).success, true);
  assert.equal(screenshotExportSchema.safeParse({ ids: [] }).success, false);
  assert.equal(screenshotExportSchema.safeParse({ ids: [id, id] }).success, false);
  assert.equal(screenshotExportSchema.safeParse({ ids: Array.from({ length: 201 }, () => crypto.randomUUID()) }).success, false);
  assert.equal(screenshotExportSchema.safeParse({ ids: [id], path: "/x" }).success, false);
  assert.equal(screenshotGallerySchema.parse({ from: "2026-11-10", to: "2026-11-10", idle: "true" }).idle, true);
  assert.equal(screenshotGallerySchema.parse({ from: "2026-11-10", to: "2026-11-10" }).idle, undefined);
});
