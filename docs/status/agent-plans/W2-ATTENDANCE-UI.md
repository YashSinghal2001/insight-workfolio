# W2-ATTENDANCE-UI — plan

Scope (contracts §11): `app/(admin)/attendance/**`, `app/(admin)/corrections/**`, `components/correction-card.tsx`,
plus new `src/lib/attendance-ui.ts` (+ test). No API, schema or dependency changes.

## Findings (inspection)
- `/attendance` already has Live + Daily tabs via `?view=`; Daily keeps its own date state; no team filter.
- Live "Last sync" prints "Online" whenever the last *event* was sent online (`lastEvent.source`), even when the
  device has not been seen for hours (current-state §2 issue 1). Overview now returns `online` + `lastSeenAt`.
- `/attendance/overview` has no date (it is "now"); `daily` takes `date`; monthly/late/missing take `teamId`.
- Correction card hides review controls for the requester; does not say who filed it for whom.

## Plan
1. `lib/attendance-ui.ts` (pure, unit-tested): tab parsing (`?tab=`, legacy `?view=` alias), monthly status codes
   P/L/A/LV/H/WO/OPEN + day title, missing-clock-out reason labels + plain explanations (thresholds from the
   response), relative time, last-seen label, event-source label ("Sent online" / "Synced later").
2. `/attendance`: Tabs Live · Daily · Monthly · Late · Missing clock-outs, tab in `?tab=`. `<GlobalFilters>`:
   team on every tab, date only on Daily (Live is "now"; the API has no date). Each tab: loading/empty/error.
   - Live: freshness cell = `online ? Online : Last seen <relative>` (zoned time in title), event source labelled.
   - Daily: uses global date + team (own date input removed).
   - Monthly: `<input type=month>`, matrix (sticky employee column, scroll inside the card, totals columns,
     In–Out in cell `title`), XLSX/CSV export via `apiBlob` + `EXPORT_CONTENT_TYPES`.
   - Late: `RangePicker maxDays=92`, paginated table.
   - Missing clock-outs: reason chips + explanation, open-for, last device seen, pending-correction indicator,
     "Request correction" form → POST `/attendance/corrections` (MISSING_CLOCK_OUT, `employeeId`); copy states a
     different admin must approve; no direct close.
3. Corrections: "Filed by <requester> for <employee>"; requester sees Approve/Reject disabled with the reason.
4. Browser scripts: `verify-wave2.mjs` W18 selects `main input[type=date]` (Daily's own date input) → changed to
   the global filter's `input[type=date][aria-label=Date]`. `?view=daily` URLs keep working (alias).
5. Gates: dashboard typecheck, lint, test:unit.
