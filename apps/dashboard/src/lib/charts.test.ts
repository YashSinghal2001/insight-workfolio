import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  arcPath, categorical, donutSlices, formatCompact, formatDurationMs, formatMinutes, formatPercent, hourTicks,
  layoutGantt, linearScale, niceTicks, OTHER_COLOR, safe, stack, sum, toMs, truncate,
} from "./charts";

test("safe clamps NaN, infinities, negatives and non-numbers to 0", () => {
  for (const v of [NaN, Infinity, -Infinity, -1, "5", null, undefined, {}]) assert.equal(safe(v), 0);
  assert.equal(safe(0), 0);
  assert.equal(safe(3.5), 3.5);
  assert.equal(safe(1e15), 1e15);
});

test("categorical colours are CSS variables with fallbacks, never cycled past 8", () => {
  assert.equal(categorical(0), "var(--chart-1, #2a78d6)");
  assert.match(categorical(7), /^var\(--chart-8, #[0-9a-f]{6}\)$/);
  // Fallbacks mirror the light --chart-N tokens in globals.css.
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  for (let i = 0; i < 8; i++) {
    const token = css.match(new RegExp(`--chart-${i + 1}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
    assert.equal(categorical(i), `var(--chart-${i + 1}, ${token})`);
  }
  assert.equal(categorical(8), OTHER_COLOR);
  assert.equal(categorical(-1), OTHER_COLOR);
});

test("formatting: compact, percent, durations, invalid input", () => {
  assert.equal(formatCompact(0), "0");
  assert.equal(formatCompact(999), "999");
  assert.equal(formatCompact(1500), "1.5K");
  assert.equal(formatCompact(2_500_000), "2.5M");
  assert.equal(formatCompact(NaN), "0");
  assert.equal(formatPercent(0.4249), "42%");
  assert.equal(formatPercent(1), "100%");
  assert.equal(formatPercent(0.001), "<1%");
  assert.equal(formatPercent(0), "0%");
  assert.equal(formatPercent(NaN), "0%");
  assert.equal(formatDurationMs(7_500_000), "2h 05m");
  assert.equal(formatDurationMs(38_000), "38s");
  assert.equal(formatDurationMs(NaN), "0s");
  assert.equal(formatDurationMs(-5000), "0s");
  assert.equal(formatMinutes(425), "7h 05m");
});

test("truncate keeps short text and shortens long text with an ellipsis", () => {
  assert.equal(truncate("Chrome", 10), "Chrome");
  assert.equal(truncate("Visual Studio Code — Insiders", 10), "Visual St…");
  assert.equal(truncate("abc", 1), "…");
  assert.equal(truncate("😀😀😀😀", 3), "😀😀…");
});

test("linearScale maps, inverts and survives a zero-width domain", () => {
  const s = linearScale([0, 10], [100, 0]);
  assert.equal(s(0), 100);
  assert.equal(s(5), 50);
  assert.equal(s(10), 0);
  assert.equal(linearScale([3, 3], [7, 9])(3), 7);
  assert.equal(linearScale([0, NaN], [7, 9])(1), 7);
});

test("niceTicks covers the max on a nice step", () => {
  assert.deepEqual(niceTicks(0), [0, 1]);
  assert.deepEqual(niceTicks(NaN), [0, 1]);
  assert.deepEqual(niceTicks(-4), [0, 1]);
  assert.deepEqual(niceTicks(7), [0, 2, 4, 6, 8]);
  assert.deepEqual(niceTicks(10), [0, 2.5, 5, 7.5, 10]);
  assert.deepEqual(niceTicks(0.3), [0, 0.1, 0.2, 0.3]);
  const big = niceTicks(1e9);
  assert.ok(big.at(-1)! >= 1e9 && big.length <= 6);
  assert.deepEqual(niceTicks(1), [0, 0.25, 0.5, 0.75, 1]);
});

test("stack lays values end to end, absolute and percent", () => {
  assert.deepEqual(stack([1, 3], 8), [{ value: 1, x0: 0, x1: 0.125 }, { value: 3, x0: 0.125, x1: 0.5 }]);
  const pct = stack([1, NaN, 3], 4);
  assert.deepEqual(pct.map((p) => [p.x0, p.x1]), [[0, 0.25], [0.25, 0.25], [0.25, 1]]);
  assert.deepEqual(stack([0, 0], 0).map((p) => p.x1), [0, 0]);
  assert.equal(sum([1, -2, NaN, 3]), 4);
});

test("donutSlices: empty, single, zero/negative dropped, top 8 + Other, shares sum to 1", () => {
  assert.deepEqual(donutSlices([]), []);
  assert.deepEqual(donutSlices([{ label: "a", value: 0 }, { label: "b", value: NaN }]), []);
  const one = donutSlices([{ label: "Only", value: 5 }]);
  assert.equal(one.length, 1);
  assert.equal(one[0].share, 1);
  assert.equal(one[0].end, 2 * Math.PI);
  const many = donutSlices(Array.from({ length: 12 }, (_, i) => ({ label: `app${i}`, value: i + 1 })));
  assert.equal(many.length, 9);
  assert.equal(many[0].label, "app11");
  assert.equal(many[8].label, "Other");
  assert.equal(many[8].other, true);
  assert.equal(many[8].value, 1 + 2 + 3 + 4);
  assert.equal(many[8].color, OTHER_COLOR);
  assert.ok(Math.abs(many.reduce((a, s) => a + s.share, 0) - 1) < 1e-9);
  assert.equal(many.at(-1)!.end, 2 * Math.PI);
  const pinned = donutSlices([{ label: "x", value: 1, color: "var(--danger)" }, { label: "y", value: -3 }], 3);
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].color, "var(--danger)");
  assert.equal(donutSlices([{ label: "a", value: 1 }, { label: "b", value: 1 }], 1)[1].label, "Other");
});

test("arcPath: quarter sector and full ring", () => {
  assert.equal(arcPath(100, 100, 90, 60, 0, Math.PI / 2), "M 100 10 A 90 90 0 0 1 190 100 L 160 100 A 60 60 0 0 0 100 40 Z");
  const ring = arcPath(100, 100, 90, 60, 0, 2 * Math.PI);
  assert.equal((ring.match(/M /g) ?? []).length, 2);
  assert.ok(!ring.includes("NaN"));
  assert.match(arcPath(0, 0, 10, 5, 0, 1.5 * Math.PI), /A 10 10 0 1 1/);
});

test("toMs accepts ISO, epoch ms and Date; invalid is NaN", () => {
  assert.equal(toMs("2026-11-02T09:00:00Z"), Date.UTC(2026, 10, 2, 9));
  assert.equal(toMs(5), 5);
  assert.equal(toMs(new Date(7)), 7);
  assert.ok(Number.isNaN(toMs("nope")));
  assert.ok(Number.isNaN(toMs(Infinity)));
});

const H = 3_600_000;
test("layoutGantt clips, drops invalid/zero-length, resolves overlaps and merges deterministically", () => {
  const segs = [
    { type: "IDLE", start: 3 * H, end: 3 * H }, // zero-length
    { type: "IDLE", start: 6 * H, end: 5 * H }, // inverted
    { type: "IDLE", start: "garbage", end: 4 * H }, // invalid
    { type: "PRODUCTIVE", start: -H, end: H }, // clipped at the window start
    { type: "PRODUCTIVE", start: H, end: 2 * H }, // touches, same type → merged
    { type: "BREAK", start: 1.5 * H, end: 2.5 * H }, // overlaps → trimmed to 2h
    { type: "NEUTRAL", start: 2.2 * H, end: 2.4 * H }, // fully covered → dropped
    { type: "UNTRACKED", start: 9 * H, end: 30 * H }, // clipped at the window end
    { type: "IDLE", start: 40 * H, end: 41 * H }, // out of range
  ] as const;
  const out = layoutGantt([...segs], 0, 10 * H);
  assert.deepEqual(out, [
    { type: "PRODUCTIVE", start: 0, end: 2 * H },
    { type: "BREAK", start: 2 * H, end: 2.5 * H },
    { type: "UNTRACKED", start: 9 * H, end: 10 * H },
  ]);
  // Same start: input order wins, independent of type.
  const tie = layoutGantt([{ type: "IDLE", start: 0, end: H }, { type: "BREAK", start: 0, end: 2 * H }], 0, 3 * H);
  assert.deepEqual(tie, [{ type: "IDLE", start: 0, end: H }, { type: "BREAK", start: H, end: 2 * H }]);
  // Different labels are not merged.
  assert.equal(layoutGantt([{ type: "PRODUCTIVE", start: 0, end: H, label: "a" }, { type: "PRODUCTIVE", start: H, end: 2 * H, label: "b" }], 0, 3 * H).length, 2);
  assert.deepEqual(layoutGantt([{ type: "IDLE", start: 0, end: H }], H, H), []);
  assert.deepEqual(layoutGantt([], 0, H), []);
});

test("hourTicks: UTC, half-hour zone, DST day, thinning, empty window", () => {
  const day = Date.UTC(2026, 10, 2);
  const utc = hourTicks(day, day + 24 * H, "UTC");
  assert.equal(utc.length, 13); // every 2 h, 00:00…24:00
  assert.equal(utc[1].label, "02:00");
  assert.equal(hourTicks(day, day + 6 * H, "UTC").length, 7);
  // Asia/Kolkata (+05:30): local whole hours are at :30 UTC.
  const ist = hourTicks(Date.UTC(2026, 10, 1, 18, 30), Date.UTC(2026, 10, 2, 18, 30), "Asia/Kolkata");
  assert.equal(ist[0].label, "00:00");
  assert.equal(new Date(ist[0].at).getUTCMinutes(), 30);
  // America/New_York, 2026-11-01 (DST ends, 25-hour day): still whole local hours, no duplicates by label pair.
  const ny = hourTicks(Date.UTC(2026, 10, 1, 4), Date.UTC(2026, 10, 2, 5), "America/New_York", 30);
  assert.equal(ny.length, 26);
  assert.equal(ny.filter((t) => t.label === "01:00").length, 2);
  assert.deepEqual(hourTicks(day, day, "UTC"), []);
  assert.equal(hourTicks(day, day + H, "Nowhere/City")[0].label, "00:00");
});
