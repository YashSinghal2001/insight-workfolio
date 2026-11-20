// Pure chart maths for the hand-built SVG charts (components/charts). No DOM, no React: unit-tested in
// charts.test.ts. Angles are radians clockwise from 12 o'clock; times are epoch milliseconds.
import { formatDurationShort } from "@workfolio/shared";

/** A plotted value: finite and ≥ 0. NaN, ±Infinity, negatives and non-numbers become 0. */
export function safe(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

// ---- colour (CSS variables only; fallbacks render before the --chart-N tokens exist) --------------------

/** Copy of the light --chart-1…8 values in globals.css (keep in sync); slot order is the CVD safety. */
const CHART_FALLBACKS = ["#2a78d6", "#eb6834", "#128b7a", "#b57d00", "#d4508a", "#008300", "#6250d6", "#e34948"];
export const MAX_CATEGORIES = CHART_FALLBACKS.length;
/** Neutral for "Other" and for anything past the 8th slot: hues are never cycled. */
export const OTHER_COLOR = "var(--muted)";

/** Categorical colour for slot `index` (0-based): `var(--chart-N, fallback)`. */
export function categorical(index: number): string {
  return index >= 0 && index < MAX_CATEGORIES ? `var(--chart-${index + 1}, ${CHART_FALLBACKS[index]})` : OTHER_COLOR;
}

// ---- formatting ---------------------------------------------------------------------------------------

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
/** 0, 999, 1.5K, 2.5M. Invalid input → "0". */
export function formatCompact(value: number): string {
  return compact.format(Number.isFinite(value) ? value : 0);
}

/** Share 0…1 → "42%"; a non-zero share under 0.5 % → "<1%". */
export function formatPercent(share: number): string {
  const s = safe(share);
  if (s > 0 && s < 0.005) return "<1%";
  return `${Math.round(s * 100)}%`;
}

/** Milliseconds → "2h 05m" / "4m 07s" / "38s" (shared formatter); invalid → "0s". */
export function formatDurationMs(ms: number): string {
  return formatDurationShort(safe(ms));
}

/** Minutes → "7h 05m". */
export function formatMinutes(minutes: number): string {
  return formatDurationShort(safe(minutes) * 60_000);
}

/** Shorten to at most `max` characters with a trailing "…" (whole code points). */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return max < 2 ? "…" : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

// ---- scales and ticks -----------------------------------------------------------------------------------

/** Linear map from `domain` to `range`; a zero-width or invalid domain maps everything to range[0]. */
export function linearScale([d0, d1]: [number, number], [r0, r1]: [number, number]): (v: number) => number {
  const span = d1 - d0;
  if (!Number.isFinite(span) || span === 0) return () => r0;
  return (v) => r0 + ((v - d0) / span) * (r1 - r0);
}

/** Ticks 0…top on a 1/2/2.5/5×10ⁿ step, top ≥ max, about `count` intervals. max ≤ 0 → [0, 1]. */
export function niceTicks(max: number, count = 4): number[] {
  const m = safe(max);
  if (m === 0) return [0, 1];
  const raw = m / Math.max(1, Math.floor(count));
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= raw * (1 - 1e-9)) ?? 10 * mag;
  const n = Math.ceil(m / step - 1e-9);
  return Array.from({ length: n + 1 }, (_, i) => Number((i * step).toPrecision(12)));
}

// ---- stacking -------------------------------------------------------------------------------------------

export interface StackPart {
  value: number;
  /** Start and end as fractions (0…1) of the row's scale. */
  x0: number;
  x1: number;
}

/** Lay `values` end to end. `scaleMax` is the full width (the largest row total for absolute mode,
 *  the row total for 100 %); a scale of 0 gives zero-width parts. */
export function stack(values: number[], scaleMax: number): StackPart[] {
  const max = safe(scaleMax);
  let at = 0;
  return values.map((raw) => {
    const value = safe(raw);
    const x0 = max ? at / max : 0;
    at += value;
    return { value, x0, x1: max ? at / max : 0 };
  });
}

export const sum = (values: number[]) => values.reduce((a, v) => a + safe(v), 0);

// ---- donut ----------------------------------------------------------------------------------------------

export interface DonutDatum {
  label: string;
  value: number;
  /** CSS colour; defaults to the categorical slot of the slice's rank. */
  color?: string;
}
export interface DonutSlice {
  label: string;
  value: number;
  share: number;
  start: number;
  end: number;
  color: string;
  other: boolean;
}

/** Largest first; up to `max` (≤ 8) slices, the rest folded into one "Other". Zero values are dropped.
 *  Colour follows rank unless the datum pins one. */
export function donutSlices(items: DonutDatum[], max = MAX_CATEGORIES, otherLabel = "Other"): DonutSlice[] {
  const keep = Math.min(Math.max(1, Math.floor(max)), MAX_CATEGORIES);
  const valid = items.map((d) => ({ ...d, value: safe(d.value) })).filter((d) => d.value > 0);
  valid.sort((a, b) => b.value - a.value);
  const total = sum(valid.map((d) => d.value));
  if (!total) return [];
  const rows = valid.slice(0, keep).map((d, i) => ({ label: d.label, value: d.value, color: d.color ?? categorical(i), other: false }));
  const rest = sum(valid.slice(keep).map((d) => d.value));
  if (rest) rows.push({ label: otherLabel, value: rest, color: OTHER_COLOR, other: true });
  let at = 0;
  return rows.map((r) => {
    const share = r.value / total;
    const start = at * 2 * Math.PI;
    at += share;
    return { ...r, share, start, end: Math.min(at, 1) * 2 * Math.PI };
  });
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** SVG path of a ring sector between angles a0…a1 (radians, clockwise from 12 o'clock).
 *  A full turn draws a whole ring (use fill-rule="evenodd"). */
export function arcPath(cx: number, cy: number, outer: number, inner: number, a0: number, a1: number): string {
  const at = (a: number, r: number) => `${r2(cx + r * Math.sin(a))} ${r2(cy - r * Math.cos(a))}`;
  if (a1 - a0 >= 2 * Math.PI - 1e-6) {
    const ring = (r: number, sweep: 0 | 1) =>
      `M ${at(0, r)} A ${r} ${r} 0 1 ${sweep} ${at(Math.PI, r)} A ${r} ${r} 0 1 ${sweep} ${at(0, r)} Z`;
    return `${ring(outer, 1)} ${ring(inner, 0)}`;
  }
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${at(a0, outer)} A ${outer} ${outer} 0 ${large} 1 ${at(a1, outer)} L ${at(a1, inner)} A ${inner} ${inner} 0 ${large} 0 ${at(a0, inner)} Z`;
}

// ---- Gantt ----------------------------------------------------------------------------------------------

export type TimeInput = string | number | Date;
/** Epoch ms from an ISO string, epoch ms or Date; NaN when invalid. */
export function toMs(t: TimeInput): number {
  if (t instanceof Date) return t.getTime();
  if (typeof t === "number") return Number.isFinite(t) ? t : NaN;
  return typeof t === "string" ? Date.parse(t) : NaN;
}

export interface GanttInput<T extends string = string> {
  type: T;
  start: TimeInput;
  end: TimeInput;
  /** Shown in the tooltip and table, e.g. an application name. */
  label?: string;
}
export interface GanttSegment<T extends string = string> {
  type: T;
  start: number;
  end: number;
  label?: string;
}

/** Clip to [from,to]; drop invalid, zero-length and inverted segments; resolve overlaps (sorted by start,
 *  then input order: the earlier segment keeps its time, a later one is trimmed or dropped); merge touching
 *  segments of the same type and label. Result is sorted and non-overlapping. */
export function layoutGantt<T extends string>(segments: GanttInput<T>[], from: TimeInput, to: TimeInput): GanttSegment<T>[] {
  const w0 = toMs(from);
  const w1 = toMs(to);
  if (!(w1 > w0)) return [];
  const clipped = segments
    .map((s, i) => ({ type: s.type, label: s.label, start: Math.max(toMs(s.start), w0), end: Math.min(toMs(s.end), w1), i }))
    .filter((s) => s.end > s.start) // NaN fails this too
    .sort((a, b) => a.start - b.start || a.i - b.i);
  const out: GanttSegment<T>[] = [];
  for (const s of clipped) {
    const prev = out.at(-1);
    const start = prev ? Math.max(s.start, prev.end) : s.start;
    if (s.end <= start) continue;
    if (prev && prev.end === start && prev.type === s.type && prev.label === s.label) prev.end = s.end;
    else out.push({ type: s.type, start, end: s.end, ...(s.label === undefined ? {} : { label: s.label }) });
  }
  return out;
}

/** 24-hour "HH:MM" formatter for `timeZone`; an unknown zone falls back to UTC. */
export function clockFormat(timeZone = "UTC"): Intl.DateTimeFormat {
  const opts = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;
  try {
    return new Intl.DateTimeFormat("en-GB", { ...opts, timeZone });
  } catch {
    return new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: "UTC" });
  }
}

export interface HourTick {
  at: number;
  /** "09:00" in the zone. */
  label: string;
}

/** Whole local hours in `timeZone` inside [from,to], thinned to every 1/2/3/4/6/12/24 h so there are at most
 *  `maxTicks`. Correct for half-hour zones and DST days. An unknown zone falls back to UTC.
 *  ponytail: scans in 15-min steps (offsets are multiples of 15 min) — fine for day-long windows. */
export function hourTicks(from: TimeInput, to: TimeInput, timeZone = "UTC", maxTicks = 13): HourTick[] {
  const w0 = toMs(from);
  const w1 = toMs(to);
  if (!(w1 > w0)) return [];
  const fmt = clockFormat(timeZone);
  const Q = 15 * 60_000;
  const hours: { at: number; hour: number; label: string }[] = [];
  for (let t = Math.ceil(w0 / Q) * Q; t <= w1; t += Q) {
    const parts = fmt.formatToParts(t);
    const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
    if (parts.find((p) => p.type === "minute")?.value === "00") hours.push({ at: t, hour: Number(hour), label: `${hour}:00` });
  }
  const step = [1, 2, 3, 4, 6, 12, 24].find((s) => hours.filter((h) => h.hour % s === 0).length <= Math.max(1, maxTicks)) ?? 24;
  return hours.filter((h) => h.hour % step === 0).map(({ at, label }) => ({ at, label }));
}
