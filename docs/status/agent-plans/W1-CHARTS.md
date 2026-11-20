# W1-CHARTS — plan

Owner: W1-CHARTS (branch `agent/w1-charts`). Contracts: `docs/IMPLEMENTATION-CONTRACTS.md` §2, §6, §7.

## Scope

1. Hand-built SVG chart components (no chart dependency): `BarChart`, `StackedBar`, `DonutChart`,
   `GanttStrip`, `Sparkline`, `Legend` + barrel `index.ts`, in `apps/dashboard/src/components/charts/`.
2. Pure logic `apps/dashboard/src/lib/charts.ts`: value sanitising, linear scale, nice ticks, donut slices
   (top N + "Other") and arc paths, stacking (absolute / percent), Gantt clipping + overlap resolution +
   merging, zone-aware hour ticks, compact number / percent / duration formatting, label truncation.
3. Dashboard unit-test runner: `apps/dashboard/test/register-tsx.mjs` (resolve + load hooks that transpile
   `.ts`/`.tsx` with the installed `typescript`, `@/` alias and extensionless specifiers), `test:unit`
   script, `test` runs `test:unit` first, CI step "Dashboard unit tests" after Typecheck.
4. Tests: `src/lib/charts.test.ts` (logic), `test/charts.test.tsx` (SSR render via `react-dom/server`).

Not in scope: pages, globals.css (`--chart-1…8` tokens come from W1-UI), kit, wiring into pages (wave 2).

## Files

- new `src/components/charts/{bar-chart,stacked-bar,donut-chart,gantt-strip,sparkline,legend,frame,index}.tsx|ts`
- new `src/lib/charts.ts`, `src/lib/charts.test.ts`
- new `test/register-tsx.mjs`, `test/charts.test.tsx`
- edit `apps/dashboard/package.json` (scripts only), `.github/workflows/ci.yml` (one step)

Dependencies: none new. Uses `react`, `react-dom/server`, `typescript` (already installed),
`formatDurationShort` from `@workfolio/shared`.

## Behaviour

- Props are plain data + a required accessible `label`; optional `format(value)` for values.
- Values: `NaN`, `±Infinity`, negatives, non-numbers → 0 (clamped, documented). All-zero → explicit
  empty state for donut/stacked/bar (nothing to compare), sparkline draws a flat line.
- Empty input → a visible message (`empty` prop, default "No data to show."), never a blank box.
- Colours only through CSS variables: categorical `var(--chart-N, <fallback>)` in fixed slot order (never
  cycled; a donut folds slices past 8 into "Other" in `var(--muted)`), semantic series via status variables
  (`--success`, `--warning`, `--danger`, `--info`, `--muted`, `--border-strong`). Gantt defaults: PRODUCTIVE
  success, UNPRODUCTIVE danger, NEUTRAL info, BREAK warning (contract: amber = break), IDLE muted,
  UNTRACKED border-strong. Every series has a legend entry; colour is never the only signal.
- Responsive: SVG `viewBox` + `width:100%`. Strip-like charts (stacked bar, Gantt, sparkline) use
  `preserveAspectRatio="none"` with `vector-effect: non-scaling-stroke`; their text is HTML so it stays
  legible at 375 px. Server-render safe: no hooks, no `window`, no generated ids.
- Long labels are truncated with "…" and the full text kept in `<title>` / the HTML `title` attribute.
- Gantt: segments (ISO string or epoch ms) clipped to `[start,end]`; zero-length / inverted / invalid dropped;
  overlaps resolved deterministically (sorted by start then input order; earlier segment wins, later one is
  trimmed); touching same-type segments merged. Hour ticks are whole local hours in the given IANA zone
  (works for +05:30 and DST days), thinned to ≤ 13 ticks.
- Hover: native `<title>` on every mark (works without JS, SSR safe).

## Accessibility

`role="img"` + `aria-label` summarising the data on each chart; a visually hidden (`sr-only`) data table
with every value; legends in HTML text; empty state in text; status colours paired with labels.

## Test cases

Logic: sanitise (NaN, -1, Infinity, string), scale (zero-width domain, inverted), nice ticks (0, 0.3, 7, 1e9,
NaN), compact format (0, 999, 1 500, 2.5e6, NaN), percent, duration (NaN, negative), truncate (short, long,
max<1), stack (absolute / percent / all-zero), donut (empty, single = full ring path, > 8 → Other, zero
values dropped, shares sum to 1), arc path (full circle, quarter), Gantt (clip, zero-length, inverted,
overlap, merge, out of range, invalid dates, deterministic order), hour ticks (UTC, Asia/Kolkata,
America/New_York DST day, thinning, empty window).
Render: each chart's aria-label + role, sr-only table rows, bar/slice/segment counts, legend values, empty
states, single item, long label truncation with full `<title>`, negatives/NaN, no hex colour outside `var()`
fallbacks. Regression: existing `src/lib/*.test.mjs` pass under the new runner.

## Acceptance criteria

- `pnpm --filter @workfolio/dashboard test:unit` green (old + new tests); typecheck + lint green.
- No new dependencies; no files outside ownership edited.
