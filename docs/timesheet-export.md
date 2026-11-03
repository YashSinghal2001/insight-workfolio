# Timesheet CSV and Excel export (F03), DRAFT format

**Status: draft, not approved.** The business has not chosen a payroll or accounting format. This
format (`timesheet-csv-draft-1`, `TIMESHEET_CSV_FORMAT` in `packages/shared/src/export.ts`) is a
proposal built only from data the system already records. Do not feed it into payroll as is.

## Where

- Employees: desktop History tab, "Download my timesheet (CSV or Excel)": date range (defaults to the
  week shown), file type, Download, and Cancel while the file is being prepared.
- API: `GET /api/v1/attendance/export?from=YYYY-MM-DD&to=YYYY-MM-DD[&format=csv|xlsx]` (permission
  `timesheet:read-own`). `format` defaults to `csv`, so existing callers are unchanged; any other
  value is 400.
  The employee comes from the session. `employeeId` is honoured only for admins, or for the caller's
  own id; any other id is 404, the same rule as `/attendance/timesheet`. The range has at most 92
  days (`dateRangeSchema`), validated on the server and pre-checked in the app.
- The file is built in memory for each request and is never stored on the server. Both formats come
  from the same rows (`timesheetRows`). Response headers: content type (`text/csv; charset=utf-8;
  header=present` or `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`),
  `attachment; filename="workfolio-timesheet-draft1_<code>_<from>_<to>.csv|.xlsx"`, `no-store`, and
  `X-Export-Rows` (the shift count, exposed to the desktop origin so the app need not parse the file).
- The desktop app downloads it with the bearer token, as an in-memory `blob:` link: no public or
  signed file URL. In the packaged app, the window registers a Tauri `on_download` handler
  (`allowed_download` in `src-tauri/src/lib.rs`) that accepts only a `blob:` URL whose file name is an
  export name (`workfolio-timesheet-draft1_<code>_<date>_<date>[ (n)].csv|.xlsx`) saved directly in
  the Downloads folder; anything else is refused and nothing about the file is logged. wry never
  overwrites: an existing name gets ` (1)`, ` (2)`. Without the handler, the macOS webview ignores
  downloads. There is no save dialog, so "cancel" means the Cancel button while the file is prepared
  (the request is aborted and nothing is saved).

## Rows and columns (draft-1)

One row per shift (attendance session) whose clock-in falls on a local date in the range, sorted by
clock-in. A shift crossing midnight belongs to the day it started, as on the timesheet.

| # | Column | Kind | Source | Notes |
| --- | --- | --- | --- | --- |
| 1 | Employee code | recorded | employee profile | |
| 2 | Employee name | recorded | employee profile | |
| 3 | Work date | calculated | local date of the clock-in | `YYYY-MM-DD` |
| 4 | Time zone | recorded | employee profile | IANA name, e.g. `Asia/Kolkata` |
| 5 | Clock in | recorded | `attendance_sessions.clock_in_at` | ISO 8601 local time with offset, seconds: `2026-10-27T09:00:00+05:30` |
| 6 | Clock out | recorded | `clock_out_at` | Empty when no clock-out is recorded |
| 7 | Status | recorded | | `Completed` or `Open: no clock-out recorded` |
| 8 | Breaks | recorded | `break_sessions` | ISO 8601 intervals `start/end`, separated by `; `. An open break ends with `/` |
| 9 | Break count | calculated | | |
| 10 | Break minutes | calculated | same arithmetic as the timesheet | Whole minutes, rounded down. Empty for open shifts |
| 11 | Worked minutes | calculated | clock-out − clock-in − breaks | Whole minutes, rounded down. Empty for open shifts: no clock-out is assumed |
| 12 | Active minutes | calculated | sum of the shift's recorded ACTIVE intervals | `0` = none recorded |
| 13 | Idle minutes | calculated | sum of the shift's recorded IDLE intervals | `0` = none recorded |
| 14 | No activity record minutes | calculated | worked − active − idle | Time with no activity data. Empty for open shifts |
| 15 | Corrected | recorded | approved correction | `Yes` / `No` |
| 16 | Clock-in source | recorded | | `Desktop app`, `Desktop app (offline, synced later)` or `Approved correction` |

Not included: internal ids (session, employee, user, device), application names, window titles,
websites, productivity scores (none of the last three is collected), pending correction requests,
overtime and totals rows.

## Encoding

- UTF-8 with a byte-order mark (Excel then reads accents and non-Latin scripts correctly), CRLF line
  ends, a header row, comma separator, RFC 4180 quoting. Fields containing a comma, quote, line break
  or leading or trailing space are quoted; quotes are doubled.
- **Formula injection:** any text cell starting with `=`, `+`, `-`, `@`, tab or carriage return gets
  an apostrophe in front (`'=HYPERLINK(…)`), so spreadsheets show it as text. Numbers are written
  as numbers. Times and dates start with a digit.

## XLSX (Excel workbook)

Built on the server with [`write-excel-file`](https://www.npmjs.com/package/write-excel-file) 4.1.1
(released June 2026, one dependency: `fflate`; MIT), added to `apps/api` only. Chosen over `exceljs`
(about nine dependencies, last release 2023) and the npm `xlsx` package (0.18.5, unmaintained on npm,
with published advisories). Code: `apps/api/src/attendance/timesheet-xlsx.ts`.

- **Sheet "Timesheet":** the same 16 columns, headers and rows as the CSV. Bold shaded header row,
  frozen; filter on the header row; column widths from the column list.
  - Text columns are String cells with the Text (`@`) format: stored as strings, never formulas, so
    `=HYPERLINK(…)` in a name is shown as typed. No apostrophe is added (unlike the CSV, where it is
    the only protection).
  - **Work date** is a real date cell (`yyyy-mm-dd`, the local calendar day).
  - **Clock in, Clock out and Breaks stay ISO 8601 text with the offset** (`2026-10-27T09:00:00+05:30`):
    Excel date-times cannot carry a time zone, and converting them would lose the recorded offset
    (DST changes). Whether native date-time cells in local time are wanted is a business decision.
  - Minute columns are numbers (format `0`); unknown values (open shifts) are **blank, never 0**.
- **Sheet "Summary":** format version and draft notice, employee code, name and time zone, the work
  date range, generation time (UTC), and only exact counts and column sums: shifts, completed
  shifts, open shifts, and the sums of Worked, Break, Active, Idle and No-activity-record minutes, each
  with a note saying which rows have a value. No overtime, paid hours, leave or other business
  figures. Each row is rounded down before summing, so a sum can be slightly below a total computed
  from unrounded time (e.g. the History tab); the sheet says it is a column sum.

## Business decisions needed

1. Columns and order, and whether one row per shift or per day is wanted (applies to both formats).
2. Duration unit and rounding: whole minutes rounded down (draft), decimal hours, or `h:mm`. Per-row
   rounding means a column sum can differ from the timesheet total by under a minute per row.
3. Whether activity columns belong in a payroll file at all (they are monitoring data).
4. Whether totals, overtime or pending corrections should be included (the XLSX summary has column
   sums only).
5. Whether admins need an all-employees export in the dashboard (the API supports one employee
   at a time with `employeeId`; there is no dashboard button).
6. Separator and date format for the payroll system's locale.
7. XLSX: whether clock times should be native Excel date-times in local time (losing the offset), and
   whether the Summary sheet is wanted.

## Business decisions needed

1. Columns and order, and whether one row per shift or per day is wanted.
2. Duration unit and rounding: whole minutes rounded down (draft), decimal hours, or `h:mm`. Per-row
   rounding means a column sum can differ from the timesheet total by under a minute per row.
3. Whether activity columns belong in a payroll file at all (they are monitoring data).
4. Whether totals, overtime or pending corrections should be included.
5. Whether admins need an all-employees export in the dashboard (the API supports one employee
   at a time with `employeeId`; there is no dashboard button).
6. Separator and date format for the payroll system's locale.

## Verification

### 2026-10-29: CSV

| Layer | Kind | Result |
| --- | --- | --- |
| Encoding, columns, open shift, injection, time zones (DST), filename | Unit | 6 tests |
| Route: headers, BOM, range filter, empty, open shift, injection, isolation, ranges | In-process API | 6 tests |
| Download in the desktop front end | Headless Chrome via Vite (`verify:my-screenshots`) | 13 checks |

### 2026-10-30: XLSX, native handler, packaged app (this Mac, synthetic data)

| Layer | Kind | Result |
| --- | --- | --- |
| One row source for both formats, column types, summary sums (blanks not zero), file names and content types | Unit (`export.test.ts`) | 9/9 (3 new) |
| XLSX route: content type, filename, `X-Export-Rows`, ZIP container, sheet names, frozen and filtered header, same values as the CSV, date/number/text cell types, summary, open shift blank, empty range, no `<f>` formula elements, injection text stored as a string, authorization (404/401/403/200), 92-day limit and bad ranges, bad `format` values, `format=csv` byte-identical to the default, 276-row export (time, size, memory) | In-process API, workbooks read back with unzip and **Python openpyxl** (`self-service.e2e.test.ts`) | 19/19 export and self-service tests (6 new) |
| Download client: refresh on 401, shift count, cancellation; handler wiring | Unit (desktop) | 2 new (34/34) |
| Native handler: export names only, " (n)" accepted, other names, extensions, paths, folders and non-`blob:` URLs refused | Rust unit (`download_tests`) | 2/2 |
| Desktop front end: CSV and XLSX downloads, workbook read back, file-type button, cancel while preparing, existing states | Headless Chrome via Vite (`verify:my-screenshots`) | 48/48 (17 export checks) |
| **Packaged app**: `tauri build --debug --bundles app`, launched from the bundle (`tauri://localhost`, embedded front end, app CSP), signed in, CSV, Excel and CSV again into the real `~/Downloads` | `verify:export-packaged` (real WKWebView download path and Rust handler) | **10/10**: 3 accepted and written, a non-export file refused, repeated name saved as `… (1).csv` with the first file untouched, CSV and XLSX contents checked (cross-midnight shift, break, open shift, injection) |

**Not verified:** a signed **release** build (the packaged run uses the debug profile because the
test hook is compiled out of release builds), Windows (WebView2), Microsoft Excel or Apple Numbers
opening the workbook (not installed here; openpyxl read it), a production host.
