# W2-LIVETEAM — Live team card page

Branch `agent/w2-liveteam`. Scope: new `app/(admin)/live-team/**`, `src/lib/live-team.ts` (+ test), one nav line, one smoke route. No API change.

## Data (existing endpoints only, refreshed every 30 s, paused while the tab is hidden)
- `GET /attendance/overview?teamId=&pageSize=100` (all pages) — session, state, `online`/`lastSeenAt`, `missingClockOut`. Required; failure = page ErrorState.
- `GET /attendance/daily?date=<today>&teamId=` (all pages) — approved leave + whether today is a workday. Optional; failure = no leave/schedule info (note shown).
- `GET /activity/overview?from=today&to=today` (all pages) — `activeMs / clockedInMs` = active-time %. Optional (needs `activity:read-all`); failure or no data = "—".
- Scheduled minutes: shared `DEFAULT_POLICY.scheduledDailyMinutes` (8 h) on workdays; no bar on non-workdays.
- Current/last app: not in the overview payload → not shown (no data added).

## Classification (`classifyMember`, pure, injected `now`)
1. Open session (incl. one opened on an earlier date = missing clock-out, flagged): device not seen for 30 min (contract §9 stale device) or never → `OFFLINE`; open break → `ON_BREAK`; else `WORKING`.
2. Approved leave today → `ON_LEAVE`.
3. No registered device (`lastSeenAt` null) → `APP_NOT_INSTALLED`.
4. Session clocked out today (employee zone) → `STOPPED`.
5. Else `NOT_STARTED`.
Presence line: "Online" only when `online === true`, else "Last seen X ago" / "Never seen".

## UI
Filter chips with counts (All, Working, On break, Stopped, On leave, App not installed, Not started; Offline counted under All only, plus its own chip if >0), `aria-pressed`; search name/code (client-side); per-chip empty state; cards tinted with status tokens + text chip; link to `/employees/[id]`; grid 1→2→3→4 columns.

## Tests
`src/lib/live-team.test.ts`: every state, stale device, open session from yesterday, on leave, no device, presence line, counts/filter.
