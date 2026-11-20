# W3-EMPLOYEE plan

Scope (contracts §12): `app/my/**`, `components/my-*.tsx`, `apps/dashboard/test/register-tsx.mjs` (+ new test files).
No API change: every call uses existing employee or team-scoped endpoints.

## 1. Missing clock-out banner (/my, /my/attendance)
- Pure rule `stillClockedInSince(current, tz, now)` in `app/my/_lib/attendance.ts`: open session (state ≠ CLOCKED_OUT, no
  clock-out) and (`missingClockOut()` from shared OR open > `ANOMALY_THRESHOLDS.maxShiftMinutes`). Same rule as desktop
  `staleClockInSince`. `now` = `current.serverTime`.
- `_components/missing-clock-out-banner.tsx`: "You are still clocked in since <local date/time>" + action. Replaces the
  two older `missingClockOut` notices. Never closes anything.
- Action: /my/attendance → button remounts `CorrectionForm` with `initial={type: MISSING_CLOCK_OUT, sessionId}` and
  scrolls to it; /my → link `/my/attendance?correct=missing-clock-out#request-correction` (read once on mount).
  The open session from `attendance/current` is added to the form's shift list when the history range misses it.

## 2. Monthly calendar (/my/attendance)
- Data: own `attendance/timesheet`, `attendance/expected` (month range), `leave?mine=true&status=APPROVED`.
- `calendarMonth()` pure: status per day via shared `dailyAttendanceStatus` (policy synthesised from the expected
  window; no window + schedule on → not scheduled; schedule off → no policy), OPEN for an open shift, worked = net
  completed time. Monday-first weeks. Codes/tones from `lib/attendance-ui` `DAY_CODE` (not-scheduled relabelled
  "Day off or holiday": holidays are admin-only data).
- `<table>` with caption, column headers, full text label per cell; legend; prev/next month (next disabled past
  the current month); loading/error per widget.

## 3. Team head attendance (/my/team/attendance)
- Team list from `GET /teams/productivity?from=to=today` (heads: their teams); picker when > 1; `teamId` added to
  summary + overview + new sections. Teams request failing → no filter (server scope still applies).
- New sections: Late (`/attendance/late`, 7 days ending at the chosen date) and Missing clock-outs
  (`/attendance/missing-clock-outs`), read-only (heads cannot file corrections).
- "Last sync" (last event time) → "Last seen" via `lastSeenLabel(row.online === true, row.lastSeenAt, now)`; last
  event kept as secondary text.

## 4. Test loader
- `register-tsx.mjs`: bare `next/<name>` (no exports map in next) → `next/<name>.js` (CJS entry). SSR test renders a
  kit + next/link component.

## 5. Tests
- `_lib/attendance.test.ts`: banner (IST, New York DST, open break, closed, 14 h), calendar shaping, team helpers.
- `test/my-panel.test.tsx`: SSR of banner + calendar + kit/next/link.

## Gates
build:packages, dashboard typecheck + lint + test:unit. No browser suites (checks listed in the report).
