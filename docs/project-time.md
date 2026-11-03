# Project and task time tracking (F11)

Admins create projects and tasks and assign employees; assigned employees run task timers in the
desktop app; admins see logged time by project, task and employee. It is **separate from
attendance**: timers never create or change shifts or breaks, and attendance remains the record of
work sessions. Timer time is how long a timer ran (idle time included). It is not a productivity
measure, and no score is calculated. **The rules below are recommended defaults, not approved
policy.**

## Audit before this feature (2026-10-30)

No project, task, client or time-entry tables, routes, fields or UI existed (migrations 0001–0010;
the word "task" appears in the desktop code only in unrelated comments). Reused: employee profiles
and `attendanceTarget` (identity from the session), attendance sessions and breaks (read only), the
timesheet service (attendance worked time beside task time), the employee lock, the append-only
patterns of corrections and leave, and the desktop tab and dashboard page conventions.

## Architecture and defaults (each needs business approval)

| Question | Default built | Alternative to decide |
| --- | --- | --- |
| Project ownership | Any admin creates, edits, archives and restores projects. No project owner or manager role (only ADMIN and EMPLOYEE exist) | Per-project managers; clients; billing codes |
| Assignment | Admins assign employees per project. Removal ends the assignment (kept in history). Removal or archiving does not stop a running timer; it refuses new ones | Stop running timers on removal or archive |
| Tasks | Admin-created per project; open or closed. Any assigned employee may log time on any open task of the project | Per-task assignees; employee-created tasks (not allowed now) |
| Time entry | One row per timer run: employee, project, task, the attendance shift it ran in, server start and end time, and why it ended (paused, stopped, break, clock-out). Pause ends the entry; resume starts a new one | Estimates, notes, billable flag |
| Relationship to attendance | A timer starts only while clocked in and not on a break. A break or clock-out ends it at that recorded time (also when synced later from offline) | Timers outside attendance; keep running through breaks |
| Simultaneous timers | One running timer per employee (database-enforced). Starting another task needs a pause or stop first | Several, or automatic switching |
| Logout, app restart, lost connection | The timer lives on the server, so it keeps running; the app shows it again after restart or reconnection. Starting and stopping need a connection (no offline timer queue) | Stop on logout; offline timers |
| Sleep and idle | The timer keeps running while the Mac sleeps or the employee is idle, as attendance does. Idle time is not subtracted, and it is not called productive | Pause on idle or sleep (would use activity data: needs approval) |
| Manual entries and corrections | Not built: no approved permission model. Entries cannot be edited or deleted (database triggers) | Employee requests with admin review, like attendance corrections |
| Reporting | Completed entries only, on the employee's local date of the start; running timers counted separately; attendance worked time in its own column | Rounding, billing, exports (F03, F12) |

## Robustness

- **Server time:** start and end times come from the API clock; the app shows elapsed time using
  the server time from its last response, so a wrong computer clock does not change any record.
- **Duplicates and concurrency:** starting the task that is already running returns the same entry
  (double taps, retries), also when the two starts reach different API instances. Pause and stop
  name the entry, so a late duplicate cannot end a newer timer (409). The database is authoritative:
  a partial unique index allows one running entry per employee; the start is one `INSERT … SELECT`
  that requires an open shift with no running break in the same statement; a stop only succeeds if
  its `UPDATE … WHERE ended_at IS NULL` changed the row, otherwise it reports the earlier end (409).
  The per-process lock only reduces contention; correctness does not depend on it.
- **Server unreachable (desktop):** the Tasks tab shows an error and the last known state ("Last
  known: running since …"), stops the elapsed counter and disables Pause/Stop. It never counts on
  locally or creates entries. It reloads every 30 s while shown and when the system reports the
  network back, so the server's state (e.g. a timer ended by a clock-out elsewhere) returns by itself.
- **Never invented time:** an end is never before the start; a break synced later that covers the
  timer's start ends it with zero time.
- **Audit:** entries end once and are never edited or deleted. Every admin change to projects, tasks
  and assignments is recorded in `project_audit` (who, when, what), shown as the project's history.

## Completion audit (2026-10-30)

Defects found and fixed (no rule changed):

1. **Stop race:** a stop arriving at the same moment as another stop, or as a break or clock-out
   ending the timer (e.g. on another API instance), returned 200 although its update changed
   nothing. Now 409 with how the timer actually ended.
2. **Start race:** the "clocked in, not on a break" check and the insert were separate statements,
   so across API instances a break could land in between. Now one statement.
3. **Duplicate start across instances** returned 409 instead of the running timer.
4. **Desktop offline display** kept ticking from the last known state; see "Server unreachable".
5. **Local development database:** two API processes on one SQLite file failed with
   `SQLITE_BUSY: database is locked` (HTTP 500) under concurrent writes, because no busy timeout was
   set. File databases now wait up to 5 s (`PRAGMA busy_timeout`); remote Turso is unaffected.

**Known limitation (unchanged rule):** a timer is ended by a break or clock-out only while it is still
running. If attendance is recorded offline and synced later *after* the employee already stopped the
timer online, that entry keeps its stop time and can include break time. Starting and stopping need
the server, and attendance syncs as soon as the app is online, so this needs a split connection.
Whether reports should subtract recorded breaks from such entries is a business decision.

## API

| Route | Permission | Notes |
| --- | --- | --- |
| `GET/POST /projects`, `PATCH /projects/:id`, `GET /projects/:id/history` | `projects:manage` (ADMIN) | Create, edit, archive (`status`), restore |
| `POST /projects/:id/members`, `DELETE /projects/:id/members/:employeeId` | `projects:manage` | Assign, end assignment |
| `POST /projects/:id/tasks`, `PATCH /projects/:id/tasks/:taskId` | `projects:manage` | Create, rename, close, reopen |
| `GET /projects/summary?from&to` | `projects:manage` | ≤ 92 days; by project, task and employee |
| `GET /task-time/assignments`, `/current`, `/entries?from&to` | `tasks:track` | Own only; admins may add `employeeId` to `entries` |
| `POST /task-time/start` `{taskId}`, `POST /task-time/:id/pause`, `/stop` | `tasks:track` | Identity from the session; unknown or unassigned task 404 |

Data: migration `0011_project_time` (additive): `projects`, `project_tasks`, `project_members`,
`task_time_entries`, `project_audit`.

## Interfaces

- **Desktop "Tasks" tab:** task selector (assigned active projects, open tasks), Start, Pause,
  Resume, Stop, a running timer with elapsed time, the attendance requirement in plain words,
  the last 7 days of entries with a total; loading, empty, offline and error states.
- **Dashboard "Projects" page:** create, edit, archive or restore projects (archived clearly
  marked), tasks, assignments, change history; logged time by project and task and by employee,
  with attendance worked time as a separate column.

## Verification (2026-10-30, this Mac, synthetic data)

| Layer | Kind | Result |
| --- | --- | --- |
| Schemas, attendance-end rule, totals | Unit | 2 tests (in shared 42/42) |
| Constraints and triggers | Unit, in-memory libSQL | 1 test (in database 12/12) |
| API | In-process API, in-memory DB (`project-time.e2e.test.ts`) | 11/11: admin CRUD and history, admin-only routes, assignments, start/pause/resume/stop, duplicates and races, invalid and unauthorized requests, break and clock-out endings with attendance unchanged, late offline break, restart, isolation, summary totals vs entries, F03/F07/F08/F10 regressions |
| Desktop wording | Unit | 2 tests |
| Desktop Tasks tab + dashboard Projects page | Headless Chrome (Vite front end, dashboard production build, real API) `verify:tasks` | 23/23 |

### Completion phase (2026-10-30)

| Layer | Kind | Result |
| --- | --- | --- |
| Known-length timer (duration = server end − start ≈ wall clock), immutability | In-process API | 12/12 F11 API tests (1 new) |
| **Two API processes, one database file, two sign-ins ("devices")**: 20 rounds of concurrent starts of different tasks (exactly one runs, one 409), 10 rounds of the same start on both (same entry), 10 rounds of concurrent stops (one 200, one 409, stored end = reported end), break/clock-out racing a stop (ended once; stop committed first by 0–2 ms in every run, so no time after the break), integrity (43 entries, no overlaps, no server errors) | `project-time-multi-instance.e2e.test.ts` (real processes, SQLite file locking) | 5/5, 3 runs |
| Desktop: unreachable server with a timer running (last known state, no ticking, buttons disabled), clock-out elsewhere, automatic recovery | Headless Chrome (`verify:tasks`) | 25/25 (2 new) |

| **Packaged app** (`tauri build --debug --bundles app`, served from `tauri://localhost` with the app CSP): sign-in, only assigned tasks, clocked-out explanation, clock in, start (ticking from server time), stop, second start not offered while one runs, break ends the timer, 440 px window without overflow; **real quit and relaunch** (signed in again, same running timer and start time); **real Mac sleep** (38 s, `pmset sleepnow`, woken by hand: same timer, elapsed 9 s → 55 s, one running entry, no duplicate); **API stopped and restarted** (error, last-known state, no ticking, Pause/Stop disabled; recovered without a click); clock-out ends the timer exactly at the recorded clock-out; 3 entries ended once each, no overlaps | `verify:tasks-packaged --sleep` (attended: Keychain "Always Allow" and waking the Mac) | **19/19** |

**Packaged-run notes:** debug profile (the test hook is compiled out of release builds), not a signed
release. "Server unreachable" was simulated by stopping the API, not by turning off the Mac's
network. Each rebuilt (ad-hoc signed) bundle makes macOS ask once for the app's Keychain items; until
"Always Allow" is chosen, every attendance action waits on that prompt. The app header still showed
"Online" while the API was down at the moment checked (the Tasks tab itself showed the error); the
header indicator is outside F11 and was not changed.

**Multi-instance limitation:** verified with two processes on one local SQLite file. Production is
meant to use remote Turso (libSQL over HTTP), which was not available; the guarantees rely on a unique
index and single-statement conditions that libSQL enforces the same way, but that is not verified on
Turso. The test is written against the HTTP API and can be pointed at two instances sharing a Turso
database once one exists.

**Not verified:** several API instances on Turso; a signed release build; Windows; a production host.
