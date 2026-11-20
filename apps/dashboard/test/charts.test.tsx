// SSR render tests for components/charts (react-dom/server, no DOM).
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BarChart, DonutChart, GanttStrip, Legend, Sparkline, StackedBar } from "@/components/charts";

const count = (html: string, needle: string) => html.split(needle).length - 1;
const ariaLabels = (html: string) => [...html.matchAll(/role="img" aria-label="([^"]*)"/g)].map((m) => m[1]);
/** Every hex colour must sit inside a var(--x, #hex) fallback. */
const assertNoBareHex = (html: string) => assert.equal(html.replace(/var\(--[\w-]+, #[0-9a-f]{3,8}\)/gi, "").match(/#[0-9a-f]{3,8}\b/gi), null);
const LONG = "An extraordinarily long application name that will never fit anywhere";

const WORKLOAD = [
  { label: "Over worked", color: "var(--danger)" },
  { label: "Healthy", color: "var(--success)" },
  { label: "Less utilised", color: "var(--warning)" },
];

test("BarChart: grouped bars, legend, summary, table, zero bars omitted", () => {
  const html = renderToStaticMarkup(
    <BarChart label="Workload" series={WORKLOAD} data={[{ label: "Mon", values: [2, 10, 1] }, { label: "Tue", values: [0, 12, 3] }, { label: "Wed", values: [1, 8, 4] }]} />,
  );
  assert.equal(count(html, "data-bar"), 8);
  assert.equal(count(html, "data-legend-item"), 3);
  const [summary] = ariaLabels(html);
  assert.match(summary, /^Workload: bar chart of 3 categories by Over worked, Healthy, Less utilised; highest 12 \(Healthy\) on Tue\.$/);
  assert.match(html, /<caption>Workload<\/caption>/);
  assert.match(html, /<th scope="row">Tue<\/th><td>0<\/td><td>12<\/td><td>3<\/td>/);
  assert.match(html, /<title>Mon · Healthy: 10<\/title>/);
  assert.match(html, /fill="var\(--danger\)"/);
  assertNoBareHex(html);
});

test("BarChart: single series has no legend; long labels truncated with full <title>; NaN/negative → 0", () => {
  const html = renderToStaticMarkup(<BarChart label="Hours" series={[{ label: "Hours" }]} data={[{ label: LONG, values: [NaN] }, { label: "B", values: [-4] }, { label: "C", values: [1e12] }]} />);
  assert.equal(count(html, "data-legend-item"), 0);
  assert.equal(count(html, "data-bar"), 1);
  assert.match(html, new RegExp(`<title>${LONG}</title>`));
  assert.match(html, /…<\/text>/);
  assert.match(html, /1T/);
  assert.ok(!html.includes("NaN"));
  assertNoBareHex(html);
});

test("BarChart: empty and all-zero show a message, not a blank box", () => {
  const empty = renderToStaticMarkup(<BarChart label="Workload" series={WORKLOAD} data={[]} empty="No workload yet." />);
  assert.match(empty, /data-chart-empty/);
  assert.match(empty, /No workload yet\./);
  assert.ok(!empty.includes("<svg"));
  const zero = renderToStaticMarkup(<BarChart label="Workload" series={WORKLOAD} data={[{ label: "Mon", values: [0, 0, 0] }]} />);
  assert.match(zero, /every value is 0/);
});

test("StackedBar: absolute and percent modes, segment counts, totals, legend", () => {
  const series = [{ label: "Productive" }, { label: "Neutral" }, { label: "Idle" }];
  const rows = [{ label: "Asha", values: [60, 30, 10] }, { label: LONG, values: [0, 20, 0] }];
  const abs = renderToStaticMarkup(<StackedBar label="Day split" series={series} rows={rows} />);
  assert.equal(count(abs, "data-segment"), 4);
  assert.equal(count(abs, "data-legend-item"), 3);
  assert.match(abs, /<title>Asha · Productive: 60 \(60%\)<\/title>/);
  assert.match(abs, /x="0" width="60"/);
  assert.match(abs, /x="0" width="20"/); // 20 of the largest total (100)
  assert.match(abs, new RegExp(`title="${LONG}"`));
  assert.match(ariaLabels(abs)[0], /^Day split: stacked bars for 2 rows by Productive, Neutral, Idle; largest total 100\.$/);
  const pct = renderToStaticMarkup(<StackedBar label="Day split" series={series} rows={rows} mode="percent" />);
  assert.match(pct, /x="0" width="100"/); // the 20 is the whole of its row
  assert.match(ariaLabels(pct)[0], /100% stacked/);
  assertNoBareHex(abs);
  assert.match(renderToStaticMarkup(<StackedBar label="x" series={series} rows={[]} />), /No data to show/);
  assert.match(renderToStaticMarkup(<StackedBar label="x" series={series} rows={[{ label: "a", values: [NaN, -1] }]} />), /every value is 0/);
});

test("DonutChart: top 8 + Other, centre, legend values and percent", () => {
  const data = Array.from({ length: 10 }, (_, i) => ({ label: `App ${i}`, value: (i + 1) * 10 }));
  const html = renderToStaticMarkup(<DonutChart label="Top apps" data={data} />);
  assert.equal(count(html, "data-slice"), 9);
  assert.equal(count(html, "data-legend-item"), 9);
  assert.match(html, /Other<\/span><span[^>]*>30 · 5%<\/span>/);
  assert.match(html, />550<\/text>/); // total in the centre
  assert.match(html, />Total<\/text>/);
  assert.match(ariaLabels(html)[0], /^Top apps: donut of 9 slices, total 550; App 9 18%, App 8 16%, App 7 15%, …\.$/);
  assert.match(html, /<th scope="row">App 9<\/th><td>100<\/td><td>18%<\/td>/);
  assertNoBareHex(html);
});

test("DonutChart: single slice is a full ring; empty/zero/negative → message; custom centre", () => {
  const one = renderToStaticMarkup(<DonutChart label="Apps" data={[{ label: "Only", value: 5 }, { label: "Neg", value: -2 }]} centerLabel="Active" centerValue="5m" />);
  assert.equal(count(one, "data-slice"), 1);
  assert.match(one, /fill-rule="evenodd"/);
  assert.match(one, />Only<\/span><span[^>]*>5 · 100%</);
  assert.match(one, />5m<\/text>/);
  assert.match(renderToStaticMarkup(<DonutChart label="Apps" data={[{ label: "a", value: 0 }]} />), /data-chart-empty/);
  assert.match(renderToStaticMarkup(<DonutChart label="Apps" data={[]} empty="No apps used." />), /No apps used\./);
});

const H = 3_600_000;
const DAY = Date.UTC(2026, 10, 2);
test("GanttStrip: segments, ticks, tooltips, legend of present types, table", () => {
  const html = renderToStaticMarkup(
    <GanttStrip
      label="Today"
      start={DAY}
      end={DAY + 24 * H}
      rows={[
        { label: "Asha", segments: [{ type: "PRODUCTIVE", start: DAY + 9 * H, end: DAY + 11 * H, label: "Editor" }, { type: "BREAK", start: DAY + 11 * H, end: DAY + 11.5 * H }, { type: "IDLE", start: DAY + 12 * H, end: DAY + 12 * H }] },
        { label: LONG, segments: [] },
      ]}
    />,
  );
  assert.equal(count(html, "data-segment="), 2);
  assert.match(html, /data-segment="PRODUCTIVE"/);
  assert.match(html, /x="375" width="83.33/);
  assert.match(html, /<title>Asha: Productive 09:00–11:00 \(2h 00m\) · Editor<\/title>/);
  assert.equal(count(html, "data-legend-item"), 2);
  assert.match(html, />02:00<\/span>/);
  assert.match(ariaLabels(html)[0], /^Today: timeline of 2 rows, 00:00–00:00 \(UTC\); Productive 2h 00m, Break 30m 00s\.$/);
  assert.match(html, /<th scope="row">Asha<\/th><td>Break<\/td><td>11:00<\/td><td>11:30<\/td>/);
  assert.match(html, new RegExp(`title="${LONG}"`));
  assert.match(html, /fill="var\(--success\)"/);
  assertNoBareHex(html);
});

test("GanttStrip: zone-local ticks and times; empty and inverted windows show a message", () => {
  const ist = renderToStaticMarkup(
    <GanttStrip label="IST" timeZone="Asia/Kolkata" start="2026-11-01T18:30:00Z" end="2026-11-02T18:30:00Z" rows={[{ label: "Ravi", segments: [{ type: "NEUTRAL", start: "2026-11-02T03:30:00Z", end: "2026-11-02T04:00:00Z" }] }]} />,
  );
  assert.match(ist, /Neutral 09:00–09:30/);
  assert.match(renderToStaticMarkup(<GanttStrip label="x" start={DAY} end={DAY + H} rows={[]} />), /data-chart-empty/);
  assert.match(renderToStaticMarkup(<GanttStrip label="x" start={DAY + H} end={DAY} rows={[{ label: "a", segments: [{ type: "IDLE", start: DAY, end: DAY + H }] }]} />), /data-chart-empty/);
});

test("Sparkline: line, optional area, summary, single point, empty, invalid values", () => {
  const html = renderToStaticMarkup(<Sparkline label="Hours" values={[1, 3, 2]} area />);
  assert.equal(count(html, "data-line"), 1);
  assert.equal(count(html, "data-area"), 1);
  assert.match(ariaLabels(html)[0], /^Hours: 3 points, from 1 to 2, min 1, max 3\.$/);
  assert.match(html, /<desc>1, 3, 2<\/desc>/);
  assertNoBareHex(html);
  const one = renderToStaticMarkup(<Sparkline label="x" values={[NaN]} />);
  assert.match(one, /d="M 0 23 L 100 23"/);
  assert.equal(count(one, "data-area"), 0);
  assert.match(renderToStaticMarkup(<Sparkline label="x" values={[]} />), /data-chart-empty/);
});

test("Legend renders values and nothing for no items", () => {
  assert.equal(renderToStaticMarkup(<Legend items={[]} />), "");
  const html = renderToStaticMarkup(<Legend items={[{ label: "A", color: "var(--chart-1, #2a78d6)", value: "3" }]} />);
  assert.match(html, /aria-label="Legend"/);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, />3<\/span>/);
});
