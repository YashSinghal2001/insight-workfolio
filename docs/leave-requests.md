# Leave and short-leave requests (F10)

A **policy-neutral** request-and-decision workflow: the employee asks for time off in the desktop
app, an administrator approves or rejects it in the dashboard, and both see the result and its
history. It has no leave types, balances, accrual, paid/unpaid treatment, holiday calendar or payroll
effect, and it never changes attendance. Those are business decisions (below). **Nothing here is an
approved HR policy.**

## Audit before this feature (2026-10-30)

| Question | Finding |
| --- | --- |
| Leave tables, routes or UI | None (migrations 0001–0009; no leave, holiday or absence code in the API, dashboard or desktop) |
| Related existing data | `employee_profiles.employment_status` allows `ON_LEAVE`: a manual admin flag on the employee form with no workflow. Left unchanged and never set automatically |
| Closest pattern | Attendance corrections (0003): employee request, review by a *different* admin, decided once, immutable, never deleted. Reused here |

## Business decisions still needed (none assumed)

| Decision | What the code does until then |
| --- | --- |
| Leave types (annual, sick, unpaid, …) | None. No type field; adding one is a new additive migration |
| Paid or unpaid treatment | Not recorded; no payroll effect; not in the timesheet CSV |
| Annual allowance, accrual, balances | None shown or calculated |
| Carry-forward | Not applicable (no balances) |
| Half-day definition (which hours, how long) | Recorded as "first half" or "second half" only. Because the hours are undefined, a half day and a short leave on the same date count as overlapping |
| Short-leave rules (minimum, maximum, how many per month) | Any start and end time on one date, end after start. No limits. No overnight short leave |
| Holidays and weekly offs | Not known to the system. A full-day range covers every calendar date in it; no day count is shown |
| Retroactive requests | Allowed within 366 days of today (sanity limit, not policy) |
| Cancellation and modification | The employee can cancel only while pending. Cancelling or changing approved leave is not built. Modifying a request = cancel and ask again |
| Approval roles and delegation | Any admin except the requester (same rule as corrections). No managers (the role model has only ADMIN and EMPLOYEE), no delegation, no escalation |
| Notifications | None (no email provider, F12). Employees and admins see status in the apps |
| Effect on attendance and timesheets | None. Approved leave does not mark days, fill hours, block clock-in or change overtime |
| Reason field | Optional, at most 500 characters, visible to the employee and all admins. The form asks for no medical or other sensitive details. Retention of reasons is not defined |

## Design

- **Data:** `leave_requests` (migration `0010_leave_requests`, additive). Dates are local dates in
  the employee's time zone; `portion` is `FULL_DAY` (start to end date), `FIRST_HALF`,
  `SECOND_HALF` (one date) or `SHORT` (one date with `HH:MM` start and end times).
- **Statuses:** `PENDING` → `APPROVED` or `REJECTED` (an admin who is not the requester) or
  `CANCELLED` (the requester only). CHECK constraints enforce who may decide; a trigger allows
  exactly one decision and no change to the request; deletes are refused.
- **History:** the row is the audit record: who asked and when, who decided, when and the
  optional note. The API returns it as `history` (`SUBMITTED`, then the decision). Logs carry ids
  and the status only, never the reason or note.
- **Overlap:** a new request is refused (409) if it overlaps the employee's own pending or approved
  request: two halves of one date and short leaves at different times do not overlap. Checked under
  the per-process employee lock (several API instances would need a database-level guard).
- **Validation (server, shared schema):** real dates, end not before start, at most 366 dates, one
  date for halves and short leave, times only for short leave, end time after start, no unknown
  fields (so no `employeeId` or type), dates within 366 days of today in the employee's zone.
  The desktop form checks the same schema first.

### API (`/api/v1/leave`)

| Route | Permission | Who |
| --- | --- | --- |
| `POST /leave` | `leave:request` | Employees and admins with an employee profile; always for themselves (admin without a profile: 403) |
| `GET /leave`, `GET /leave/:id` | `leave:request` | Employees: own only (another id 404). Admins: all, filter by `status`, `employeeId` |
| `POST /leave/:id/approve`, `/reject` | `leave:review` (ADMIN) | Not the requester (403); once (409); optional `note` |
| `POST /leave/:id/cancel` | `leave:request` | The requester only (others 403 or 404); pending only (409) |

### Interfaces

- **Desktop "Leave" tab:** form (full days, first or second half, part of a day), time-zone hint,
  sensitive-details hint, loading, empty, success, invalid, overlap, offline and error states;
  "My leave requests" with status, reason, decision and note; two-step cancel (no blocking dialog).
- **Dashboard "Leave" page:** Pending / Approved / Rejected / Cancelled / All, each request with the
  reason and its history, approve or reject with an optional note; own requests cannot be decided.

## Verification (2026-10-30, this Mac, synthetic data)

| Layer | Kind | Result |
| --- | --- | --- |
| Shared schema, overlap rule, wording | Unit | 3 tests (in shared 40/40) |
| Database constraints and triggers | Unit (in-memory libSQL) | 1 test (in database 11/11) |
| API | In-process API, in-memory DB (`leave.e2e.test.ts`) | 7/7: full, half and short; 15 invalid inputs; UTC+14 vs UTC−11 date window; overlaps; approve, reject, cancel, double and concurrent decisions; isolation and authorization; attendance unchanged |
| Desktop form rule | Unit | 1 test |
| Desktop Leave tab + dashboard Leave page | Headless Chrome (Vite front end, dashboard production build, real API) `verify:leave` | 24/24 |

**Not verified:** the Leave tab inside the packaged Tauri window; Windows; a production host or
Turso; several API instances at once.

## Holiday import from CSV or Excel (W39)

Admins import holidays on **Holidays → Import from a CSV or Excel file**. The API takes one format,
`POST /api/v1/holidays/import` with `{ csv }` (`date,name` per line, all-or-nothing, dates that
already have a holiday are skipped); the server validates every import.

An Excel `.xlsx` file is converted to that CSV in the browser
(`apps/dashboard/src/lib/xlsx-holidays.ts`, no library): the ZIP central directory is read, entries
are inflated with the native `DecompressionStream("deflate-raw")`, and the first sheet of
`xl/workbook.xml` (via `xl/_rels/workbook.xml.rels`) is read together with `xl/sharedStrings.xml`.

- Column A is the date, column B the name. The first row is skipped when column A is not a date (a header).
- Dates: Excel date cells (serial numbers; 1900 system including its non-existent 1900-02-29, which is
  rejected, and the 1904 system when `workbookPr date1904` is set), `YYYY-MM-DD` text, or
  day/month/year text. Day/month text where both parts are 12 or less and differ (e.g. `3/4/2026`) is
  rejected as ambiguous; write it as `YYYY-MM-DD` or use a date cell.
- Any bad row (not a date, ambiguous, impossible date, missing name, error cell such as `#VALUE!`,
  duplicate date) is listed as `Row N: …` with the spreadsheet row number, and nothing is uploaded.
- Old `.xls` (Excel 97–2003) files are refused: save them as `.xlsx` or CSV. Not supported: ZIP64,
  password-protected workbooks, sheets other than the first.

Checks: `node --test apps/dashboard/src/lib/xlsx-holidays.test.mjs` (fixtures generated in the test)
and `node apps/dashboard/scripts/verify-xlsx.mjs` (real API on :4214, `next dev` on :3214, headless
Chrome on :9514; uploads a generated `.xlsx` through the file input). Run after
`pnpm build:packages && pnpm --filter @workfolio/api build`.
