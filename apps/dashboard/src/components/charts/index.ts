// Hand-built SVG charts (no chart dependency). Server-render safe; colours via CSS variables only.
export { BarChart, type BarCategory, type BarChartProps, type BarSeries } from "./bar-chart";
export { StackedBar, type StackedBarProps, type StackedRow, type StackedSeries } from "./stacked-bar";
export { DonutChart, type DonutChartProps } from "./donut-chart";
export { GanttStrip, GANTT_COLORS, GANTT_LABELS, GANTT_TYPES, type GanttRow, type GanttStripProps, type GanttType } from "./gantt-strip";
export { Sparkline, type SparklineProps } from "./sparkline";
export { Legend, type LegendItem } from "./legend";
export { ChartEmpty } from "./frame";
export { categorical, formatCompact, formatDurationMs, formatMinutes, formatPercent, type DonutDatum } from "@/lib/charts";
