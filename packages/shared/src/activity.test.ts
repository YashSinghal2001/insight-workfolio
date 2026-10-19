import assert from "node:assert/strict";
import { test } from "node:test";
import { activitySyncSchema, activityQuerySchema, DEFAULT_MONITORING_SETTINGS, monitoringSettingsSchema, noticeSchema, summarizeActivity } from "../dist/index.js";

const M = 60_000;
const iv = (kind: "ACTIVE" | "IDLE", start: string, end: string, app?: [string, string]) => ({
  kind, startedAt: start, endedAt: end, applicationIdentifier: app?.[0] ?? null, applicationName: app?.[1] ?? null,
});
const SAFARI: [string, string] = ["com.apple.Safari", "Safari"];
const CODE: [string, string] = ["com.microsoft.VSCode", "Code"];

test("aggregation: per-app active time, idle never counted as app usage", () => {
  const s = summarizeActivity(
    [
      iv("ACTIVE", "2026-10-12T04:00:00Z", "2026-10-12T04:30:00Z", CODE),
      iv("ACTIVE", "2026-10-12T04:30:00Z", "2026-10-12T04:40:00Z", SAFARI),
      iv("IDLE", "2026-10-12T04:40:00Z", "2026-10-12T05:00:00Z"),
      iv("ACTIVE", "2026-10-12T05:00:00Z", "2026-10-12T05:15:00Z", CODE),
    ],
    { from: "2026-10-12", to: "2026-10-12", timeZone: "Asia/Kolkata" },
  );
  assert.deepEqual([s.activeMs, s.idleMs], [55 * M, 20 * M]);
  assert.deepEqual(s.applications.map((a) => [a.applicationName, a.activeMs]), [["Code", 45 * M], ["Safari", 10 * M]]);
  assert.deepEqual(s.days, [{ date: "2026-10-12", activeMs: 55 * M, idleMs: 20 * M }]);
});

test("aggregation: an interval crossing local midnight is split between days, and clipped to the range", () => {
  // 23:50-00:10 IST
  const all = [iv("ACTIVE", "2026-10-12T18:20:00Z", "2026-10-12T18:40:00Z", CODE)];
  const both = summarizeActivity(all, { from: "2026-10-12", to: "2026-10-13", timeZone: "Asia/Kolkata" });
  assert.deepEqual(both.days.map((d) => [d.date, d.activeMs]), [["2026-10-12", 10 * M], ["2026-10-13", 10 * M]]);
  const one = summarizeActivity(all, { from: "2026-10-13", to: "2026-10-13", timeZone: "Asia/Kolkata" });
  assert.equal(one.activeMs, 10 * M, "only the part inside the range");
});

test("aggregation: DST day in New York counts real elapsed time", () => {
  // 2026-03-08 01:30 EST -> 03:30 EDT is one real hour.
  const s = summarizeActivity([iv("ACTIVE", "2026-03-08T06:30:00Z", "2026-03-08T07:30:00Z", CODE)], { from: "2026-03-08", to: "2026-03-08", timeZone: "America/New_York" });
  assert.equal(s.activeMs, 60 * M);
});

test("sync schema: only app name/identifier; window titles, URLs or extra fields are rejected", () => {
  const ok = { id: "6f1c1b2a-3d4e-4f50-8a6b-7c8d9e0f1a2b", kind: "ACTIVE", applicationIdentifier: "com.apple.Safari", applicationName: "Safari", startedAt: "2026-10-12T04:00:00Z", endedAt: "2026-10-12T04:00:15Z" };
  const parse = (iv: object, extra = {}) => activitySyncSchema.safeParse({ sentAt: "2026-10-12T04:01:00Z", platform: "macos", intervals: [iv], ...extra }).success;
  assert.equal(parse(ok), true);
  assert.equal(parse({ ...ok, windowTitle: "Payroll.xlsx" }), false, "window titles are not accepted");
  assert.equal(parse({ ...ok, url: "https://example.com/private" }), false, "URLs are not accepted");
  assert.equal(parse(ok, { keystrokes: 12 }), false);
  assert.equal(parse({ ...ok, kind: "IDLE" }), false, "idle intervals carry no app");
  assert.equal(parse({ ...ok, kind: "IDLE", applicationIdentifier: null, applicationName: null }), true);
  assert.equal(parse({ ...ok, endedAt: ok.startedAt }), false, "zero/negative duration");
  assert.equal(parse({ ...ok, endedAt: "2026-10-13T05:00:00Z" }), false, "over 24 h");
  assert.equal(activityQuerySchema.safeParse({ from: "2026-10-01", to: "2026-11-30" }).success, false, "range limit");
});

test("settings validation: bounded values, idle threshold of at least two samples, a reason, no unknown fields", () => {
  const ok = { ...DEFAULT_MONITORING_SETTINGS, reason: "Pilot defaults" };
  const parse = (patch: object) => monitoringSettingsSchema.safeParse({ ...ok, ...patch }).success;
  assert.equal(parse({}), true);
  for (const bad of [
    { sampleSeconds: 4 }, { sampleSeconds: 301 }, { sampleSeconds: 7.5 },
    { idleThresholdSeconds: 29 }, { idleThresholdSeconds: 3601 }, { sampleSeconds: 60, idleThresholdSeconds: 90 },
    { retentionDays: 6 }, { retentionDays: 3651 }, { reason: "  " }, { enabled: "yes" }, { collectWindowTitles: true },
  ]) {
    assert.equal(parse(bad), false, JSON.stringify(bad));
  }
  assert.deepEqual([DEFAULT_MONITORING_SETTINGS.retentionDays, DEFAULT_MONITORING_SETTINGS.retentionApproved], [30, false], "30 days proposed, not approved");
});

test("notice validation: safe version ids, 1-20 points", () => {
  const ok = { version: "2026-11-v2", title: "Monitoring", points: ["We record the foreground app."], draft: false };
  assert.equal(noticeSchema.safeParse(ok).success, true);
  assert.equal(noticeSchema.safeParse({ ...ok, version: "v 2" }).success, false);
  assert.equal(noticeSchema.safeParse({ ...ok, points: [] }).success, false);
  assert.equal(noticeSchema.safeParse({ ...ok, points: Array(21).fill("x") }).success, false);
});
