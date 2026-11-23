# Employee shifts and automatic clock-out

An administrator may give an employee a **shift**. If the employee is still clocked in at
**shift end + grace period**, the **server** clocks them out at that time. Employees without a shift
keep the previous behaviour: nothing is ever clocked out automatically.

## Settings (per employee)

| Field | Rule |
|---|---|
| Start / end | 24-hour `HH:MM`, start ≠ end. End earlier than start = **overnight** (ends the next day). |
| Working days | ISO weekday digits, `1` Monday … `7` Sunday, default `12345`. The days a shift **starts** on. |
| Time zone | IANA name; defaults to the employee's profile time zone (whose default is `Asia/Kolkata`, the organisation default). |
| Grace period | 0–480 min, default 60. |
| Automatic clock-out | On by default; can be switched off and the shift kept for display. |

Set on **Add employee** (optional "Assign a shift now") or later on the employee's **Edit** tab
(`PUT/DELETE /api/v1/employees/:id/shift`, `employees:manage`, the Super-Admin guard applies). Employees
can read their own shift (`GET /api/v1/employees/:id/shift`) and nobody else's; they can never change it.
Every change writes a `SHIFT_ASSIGNED` / `SHIFT_REMOVED` account-audit row.

Existing employees get **no** shift from the migration (`0036_employee_shifts`, additive only).

## Which shift a session belongs to

The first occurrence whose scheduled end is after the clock-in. So clocking in after a shift ended (even
inside its grace period) counts toward the next one and is never clocked out moments later. If that
occurrence starts on a non-working day, the session is **not** clocked out automatically (status `OFF_DAY`).

Times are wall-clock in the shift's zone; DST is handled (a skipped local time resolves forward, the grace
period is real elapsed minutes).

## The clock-out

* Time recorded = the deadline (shift end + grace), never the time the job ran, and never earlier than the
  last break change or the last edit of the shift settings (no retroactive clock-out after an edit).
* One write transaction: insert the `auto_clock_outs` record (claims the session; `UNIQUE(attendance_session_id)`),
  end an open break, close the session (`WHERE status = 'OPEN'`), clear the device's live activity state, and
  write the `AUTO_CLOCK_OUT` audit row (actor NULL; employee, session, scheduled end, deadline, clock-out,
  processed time, cause). All or nothing.
* A manual clock-out before the deadline closes the session, so the claim inserts nothing: no second clock-out,
  and a manual clock-out is never overwritten.
* **Sign-in sessions are not touched.** Attendance clock-out and app sign-out are separate operations.
* Screenshots captured after the clock-out are discarded, as after a manual clock-out.

## Scheduling

`AutoClockOutService` runs in the API process: a sweep at start-up (catches up on deadlines that passed while
the API was down) and every 30 s. Each employee is processed under the per-employee lock (`EmployeeLocks`);
across API instances the `UNIQUE` claim and the `status = 'OPEN'` conditions let exactly one succeed.
Every attendance write (`/attendance/*`, offline `/attendance/sync`) first applies any overdue automatic
clock-out, so no action is accepted after the deadline just because the sweep has not run yet.
A failed attempt rolls back entirely, is logged and recorded in `auto_clock_out_failures`, and is retried on
the next sweep. Failures of the last 24 h are shown on the admin Shifts tab.

## Where it shows

* Admin: **Attendance → Shifts** (status tiles, search/status/team filters, live status with next automatic
  clock-out, recent failures; automatic clock-out history with date range). Employee profile: Overview (read
  only) and Edit (assign/edit/remove, history).
* API: `GET /attendance/shifts` (`?q, teamId, status, beyondShift, page, pageSize`),
  `GET /attendance/auto-clock-outs` (`?from, to, employeeId, teamId, page, pageSize`), both
  `attendance:read-all`, team heads see their teams only. `GET /attendance/current` has `shiftEndAt` and
  `autoClockOutAt`; sessions have `clockOutReason` (`MANUAL` | `AUTOMATIC_SHIFT_END`).
* Employee dashboard (`/my`): "My shift" card and a notice before/at the automatic clock-out.
* Desktop app: the same notice in the Attendance card, one OS notification when the grace period starts, and
  a state refresh once the clock-out time has passed. The app is never signed out or closed by it.
