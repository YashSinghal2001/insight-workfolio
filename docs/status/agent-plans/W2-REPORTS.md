# W2-REPORTS — plan

Reports sub-pages, timesheet week grid, summary report (JSON + XLSX). Contracts: §4, §6, §7, §11.

## Files
| File | Change |
|---|---|
| `app/(admin)/reports/layout.tsx` | SubNav: Activity overview · Daily attendance · Monthly attendance · Monthly in/out · Late · Overtime · Summary · Scheduled reports |
| `app/(admin)/reports/_parts.tsx` (new) | `useApiData` (loading/error/retry), month field, export buttons, employee cell, matrix wrapper |
| `app/(admin)/reports/{daily-attendance,monthly-attendance,monthly-in-out,late,overtime,summary}/page.tsx` (new) | the six pages |
| `app/(admin)/timesheets/page.tsx` | Tabs "Summary" (unchanged) / "Week grid" |
| `app/(admin)/timesheets/week-grid.tsx` (new) | week grid view |
| `src/lib/reports.ts` + `reports.test.ts` (new) | pure shaping: daily tabs + export rows, in/out cells and counts, overtime, week grid merge, all-pages fetch, minimal XLSX writer (STORED zip, inline strings, no formulas) |
| `packages/shared/src/summary-report.ts` + test (new), `index.ts` (+1 line) | query schema, response types, pure `summaryReportRow`, XLSX columns |
| `apps/api/src/attendance/summary-report.{service,controller}.ts` (new), `app.module.ts` (+2 lines) | `GET /api/v1/attendance/summary-report` |
| `apps/api/test/summary-report.e2e.test.ts` (new) | e2e |
| `apps/dashboard/scripts/smoke.mjs` | 6 routes |

## Data sources
- Daily attendance: `/attendance/daily` (all pages) for tabs/status; `/attendance/monthly` for that day's clock-out and worked minutes (enrichment; failure shows "—"). Export CSV (shared `toCsv`) / XLSX built in the browser from the visible tab.
- Monthly attendance / in-out / overtime: `/attendance/monthly` (paginated); export `/attendance/monthly/export`.
- Late: `/attendance/late` (RangePicker, ≤ 92 days).
- Summary: new endpoint (active/idle per range is not available elsewhere).
- Week grid: `/attendance/monthly` for the 1–2 months the week touches, merged by employee; red tint = `ABSENT`.

## Summary report endpoint
`GET /attendance/summary-report?from&to&teamId&format=json|xlsx&page&pageSize` — `attendance:read-all`, `@TeamScoped`,
`assertTeamReadable`; active employees in scope (`scopedEmployees`). Per employee: worked days, worked/break minutes
(`buildTimesheet`, floored totals = timesheet totals), active/idle minutes (activity_intervals of completed shifts in
range, floored). Totals = column sums. XLSX: code, name, zone, numbers; no ids/emails/app data.

## Not done
No schema change, no new dependency. No browser suite (checks described to the lead).
