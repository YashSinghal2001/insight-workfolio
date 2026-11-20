# W3-TIMELINE — Timeline Gantt, screenshot idle marker, bulk export, timelapse check

Branch `agent/w3-timeline`. Contracts §4–§8, §12.

## 1. Timeline page (`/timeline`)
- Per-employee calls would be 2·N requests (+ pagination), so one aggregated endpoint:
  **GET `/activity/team-timeline?date=YYYY-MM-DD&teamId=&page=&pageSize≤100`** — `activity:read-all`, `@TeamScoped`,
  `assertTeamReadable` (via `EmployeesService.list(…, "activity:read-all")`, as `/activity/overview`), one
  `EMPLOYEE_ACTIVITY_TIMELINE_VIEWED` audit row per other employee on the page (metadata `date`, `view: team`), written in one batch.
  New files `apps/api/src/timeline/team-timeline.{controller,service}.ts` (controller path `activity`, so `activity/**`
  owned by W3-APPS is not edited); one line in `app.module.ts`.
- Three reads per page (sessions, breaks via `withBreaks`, activity intervals) + `ActivityCategoriesService.labelsFor`.
- Segments built by a pure shared function `buildTimelineSegments` (new `packages/shared/src/timeline.ts`), each employee's
  local day `[00:00, 24:00)` in their own zone, cut at `now`:
  not clocked in → UNTRACKED; break → BREAK; activity inside clocked-in, non-break time → IDLE / PRODUCTIVE / UNPRODUCTIVE /
  NEUTRAL (UNCLASSIFIED shown as Neutral, labelled "unlabelled"); clocked in without activity data → no segment (blank,
  explained in the legend). Touching segments of the same type+label are merged.
- Dashboard: `app/(admin)/timeline/page.tsx`, `<GlobalFilters />` (date + team), rows grouped by employee zone (hour ticks
  in that zone), each row a link to `/employees/[id]` with a visible text total (not colour only), shared legend,
  loading/empty/error, rows scroll inside the card. Pure helpers `src/lib/timeline.ts` (+ test). Nav "Timeline" under
  Monitoring + smoke route. GanttStrip (W1-CHARTS) is not edited; its `layoutGantt`/`hourTicks`/colours/labels/`Legend` are reused.

## 2. Screenshot idle marker
- Signal: a screenshot is idle when its `captured_at` lies inside an IDLE `activity_intervals` row of the same employee
  (idle = no keyboard/mouse input for the threshold, attributed from the last input; locked screens are never captured).
  Computed in SQL (bounded by the 24 h max interval, indexed), no schema change. Additive `idle: boolean` on gallery items;
  gallery filter `idle=true` (additive query field).
- UI: red border + text badge "Idle" on the card; "Idle only" toggle (`aria-pressed`).
- Limits: no activity data (monitoring off / not yet synced / purged by activity retention) → not marked idle.

## 3. Bulk export (Super Admin)
- **POST `/screenshots/export` `{ ids: uuid[1..200] }`** — `@RequirePermission("screenshots:delete")` (the guard uses
  `can()`, so SUPER_ADMIN_ONLY applies: plain admin 403, team head 403, employee 403). Unknown/out-of-scope id → 404;
  not STORED / other provider → 409; total registered bytes > 200 MB → 413. Before streaming: one
  `screenshot_access_log` row (`VIEW`, the existing CHECK allows only VIEW/THUMBNAIL) per screenshot + one
  `SCREENSHOTS_EXPORTED` account-audit row (count, bytes) in one batch.
- Stream: STORE-only ZIP (`apps/api/src/screenshots/zip.ts`, `zlib.crc32`), each file validated like `/content`
  (size, WebP), entry names `screenshot-<employeeCode>-<UTC capture time>-<id>.webp` (no storage keys/paths), no-store headers.
- Dashboard: Select / Select all (page) / Export (n) / Clear, only when `can(user, "screenshots:delete")`; selection kept across pages.

## 4. Timelapse
- No change; `TimelapsePanel` stays wired as before. Existing `timelapse.e2e` + `auto-timelapse.e2e` run in the full suite.

## Tests
- shared: `timeline.test.ts` (segments: untracked/break/idle/categories/open session/now cut/DST day).
- API: `zip.test.ts` (unzip with system `unzip -t` if present + CRC check vs zlib), `screenshots-export.e2e.test.ts`,
  `team-timeline.e2e.test.ts` (scoping: admin, head in-team, head other team 404, employee 403, 400s, audit rows),
  gallery `idle` field + filter.
- dashboard: `src/lib/timeline.test.ts`, SSR test of the idle badge.
