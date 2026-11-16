# Automated email reports (F12)

Admins define scheduled summaries (daily, weekly or monthly) of attendance and, optionally,
project task time, and choose recipients from user accounts. Report **generation** is separate
from **delivery**. **No real email provider is integrated**, and nothing in this repository has
ever emailed a report.

## Audit before this feature (2026-10-30)

| Question | Finding |
| --- | --- |
| Email provider, SMTP, mail library | None for reports. A Microsoft Graph sender exists for employee invitations only (`INVITATION_MAIL_PROVIDER`, docs/invitations.md); it does not send reports |
| Scheduling | No job scheduler. Retention and timelapse sweeps use in-process `setInterval` timers (skipped under test); the report scheduler uses the same pattern |
| Report sources | Timesheet totals (`TimesheetService.forEmployee`), F11 project summary, device last-seen times. F03's draft CSV exists but is an employee download, not attached |
| Who may configure | Admins (the only privileged role) |

## Decisions needed before real email (none assumed)

| Decision | Interim behaviour |
| --- | --- |
| **Provider** (Microsoft Graph `sendMail` from a shared mailbox, which fits the planned Microsoft 365 tenant; or an SMTP relay; or a transactional email service), the sending address, SPF/DKIM/DMARC | `REPORT_MAIL_PROVIDER=none` (default): runs and deliveries are recorded as **Not emailed: no provider**. `mock` exists for development and tests and is refused in production |
| Credentials | Would live only in the server's environment or secret store, like `GRAPH_CLIENT_SECRET`; Graph needs the `Mail.Send` application permission scoped to one mailbox (Exchange application access policy) |
| Recipients | User accounts only, never free-form addresses. All-employee reports: active admins. One-employee reports: active admins or that employee. Whether managers, HR or payroll staff (no such roles exist) may receive reports needs a decision |
| Frequency and send time | Daily (yesterday), weekly (last week, using `WORKWEEK_START_DAY`) or monthly (last month), in a chosen time zone; sent at the first scheduler check after the period ends. No fixed hour of day |
| Attachments or links | Neither. Plain-text email body with aggregates only. Attaching the F03 CSV waits for its format approval; secure links would need a hosted dashboard |
| Content | Attendance totals, breaks, overtime (reported only), open shifts, pending corrections, task time per project and employee, freshness and missing-record warnings. Approval of this content (and of emailing per-employee figures at all) is an HR/Legal decision |
| Retention of delivery records | Kept indefinitely (append-only); no report content is stored, only its SHA-256 |

## Never included

Screenshots, application activity or idle data, leave requests or reasons, website history,
productivity scores or categories (F04/F05 are not approved), email addresses, or another employee's
figures in a one-employee report. Tests check this with planted data.

## Reliability

- **One run per schedule and period** (unique in the database): a second scheduler tick, a second
  API instance or a repeated "Run now" returns the existing run.
- **One delivery per run and recipient** (unique), claimed with a 10-minute lease before sending;
  a finished delivery can never be changed or sent again (database trigger).
- **Retries:** transient provider errors retry after 5, 10 and 20 minutes (4 attempts), then
  FAILED. Permanent errors (e.g. a rejected address) fail at once.
- **Interrupted sends** (lease expired, e.g. a crash mid-send) are marked FAILED and **not**
  retried, because the email may already have gone out. An admin can see this and decide.
- **Recipient checks at send time:** a removed, disabled or no-longer-eligible recipient, or a
  paused report, is SKIPPED with the reason.
- **Audit:** every attempt is recorded (outcome, short provider error, SHA-256 of the content).
  Logs carry ids and statuses only, never addresses or report content.
- **No backfill:** the scheduler only runs periods that ended after the report was created.

## Statuses

| Delivery | Meaning |
| --- | --- |
| Waiting, Sending, Will retry | Not finished |
| Sent | Accepted by a real provider (none exists yet) |
| Mock only: not emailed | Accepted by the mock provider; nothing left the server |
| Not emailed: no provider | No provider configured |
| Skipped | Recipient no longer authorized, or report paused |
| Failed | Permanent error, retries exhausted, or interrupted |

A run is **Delivered** only if every delivery was Sent (or Skipped); otherwise **Not emailed**,
**Failed**, **In progress** or **No recipients**.

## API (admin only, `reports:manage`)

`GET /reports/provider`; `GET/POST /reports/schedules`; `PATCH /reports/schedules/:id` (name,
frequency, active, includeProjects); `GET /reports/schedules/:id/eligible-recipients`;
`POST /reports/schedules/:id/recipients` `{userId}`; `DELETE /reports/schedules/:id/recipients/:userId`;
`GET /reports/schedules/:id/preview` (generates, sends nothing); `POST /reports/schedules/:id/run`;
`GET /reports/runs?scheduleId`. Data: migration `0012_email_reports` (additive).

## Verification (2026-10-30, this Mac, synthetic data)

| Layer | Kind | Result |
| --- | --- | --- |
| Periods, time zones, schema, empty report | Unit | 3 tests (in shared 45/45) |
| Constraints and triggers | Unit, in-memory libSQL | 1 test (in database 13/13) |
| Generation and delivery | In-process API, **mock provider** (`reports.e2e.test.ts`) | 14/14: IST week boundaries, a New York evening shift on its local date, totals, project time in the period only, warnings, planted leave reason and app name excluded, one-employee isolation, admin-only routes, recipient authorization (add and send time), duplicate runs and sends, scheduler (no backfill, inactive), retries with backoff, exhausted and permanent failures, interrupted sends, no content stored |
| Default provider | In-process API, **no provider** (`reports-none.e2e.test.ts`) | 1/1: recorded as not emailed |
| Production config | Unit (`env.test.ts`) | mock refused in production |
| Dashboard Reports page | Headless Chrome, dashboard production build, real API with **mock provider** (`verify:reports`) | 11/11 |

**Not verified (cannot be, yet):** any real email delivery, provider authentication, bounces,
spam placement, or the scheduler running for days on a host. No real provider exists in this build.
