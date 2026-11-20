# Reference Workfolio — Product Audit

Audited: 2026-11-19, ~22:50–23:15 IST, via Claude in Chrome, in the owner's already signed-in browser session at
`https://app.getworkfolio.com`. Read-only: no setting saved, no leave/manual-time approved or rejected, no report
created (the "Create New Report" modal was opened to read its fields and closed without saving).

**Privacy note.** The reference account holds real people's data (another organisation's employees). Names, emails,
IPs and screenshot contents are deliberately **not** reproduced here; employees are referred to as "Employee A…G".
Screenshots were viewed during the audit but **not saved** into this repository for the same reason; each section
lists the page URL instead so it can be re-inspected.

Legend: **[O]** observed in the UI · **[I]** inference / assumption · **[?]** not determinable from the UI.

---

## 1. Global shell

| Element | Observation |
|---|---|
| Theme | [O] Light only: white background, light-grey page canvas, blue (#1a73e8-like) primary, thin grey borders, very light shadows. No dark mode toggle seen. |
| Layout | [O] Fixed left sidebar (~185 px) with small grey group headings and icon + label rows; active item = blue text + light-blue background + left bar. Top bar: page title left; "Release Notes", blue "ADD USERS" pill button, date picker ("Today"), team selector ("All Team"), avatar right. |
| Secondary nav | [O] Reports and Settings use a second inner column (sub-menu) beside the main sidebar. Screenshots, Timelapse, Apps History, Personal Statistics use an inner column listing members ("Team View" + each member, with search). |
| Global filters | [O] Date picker and Team selector in the top bar apply to most "Realtime"/"Proof of work" pages. |
| Support | [O] Third-party live-chat widget bottom-right ("Chat with a live agent!"). |
| Density | [O] Compact: 12–14 px body text, small cards, tables with sortable headers (⇕ icons), coloured cell backgrounds for status (green = healthy/worked, red = late/over, yellow = not started). |

### Sidebar inventory [O]

| Group | Item | URL |
|---|---|---|
| Realtime | Overview | `/overview` |
| | My Team | `/my-teams` |
| Proof of work | Screenshots | `/screenshots` |
| | Timelapse Videos | `/timelapse` |
| | Timesheet | `/timesheet` |
| | Risk Users | `/risk-user-history` |
| | Timeline | `/timeline` |
| | Manual Time | `/manual-time` |
| | Reports | `/reports/daily-attendance` (14 sub-reports, §9) |
| Leave Management | Apply Leave | `/apply-leave` |
| | Leave Summary | `/leave-summary` |
| | Manage Leave | `/manage-leave` |
| | Manage Holiday | `/manage-holiday` |
| Apps Usage | Review Apps | `/review-usage` |
| | Apps History | `/apps-history` |
| | Apps Summary | `/apps-summary` |
| Configuration | Settings | `/settings/manage-teams` (7 sub-pages, §17) |
| | Billing | `/billing` (not opened) |
| | Download App | external link to the vendor downloads page |

Drill-down not in the sidebar: **Personal statistics** `/personal-statistics/<id>` (reached from Overview rows).

---

## 2. Overview (`/overview`)

Purpose [O]: real-time, org- or team-wide dashboard for "today" (date picker can change the day).

Widgets, top to bottom [O]:

1. **KPI strip** (5 compact cards): Total Team Members · Currently Working · Currently On Break · Currently Stopped Work · App Not Installed.
2. **Work Load Analysis** — grouped bar chart, last 3 days, members per bucket: Over Worked / Healthy / Less Utilised (info tooltip).
3. **Top Used Apps** — pill list (app/site names coloured by category) + donut chart; data table of seconds per app in the a11y tree.
4. **Late Clock-in Employees** — count badge + table: Employee, Actual, Required, Late By.
5. **Absence Today** — count badge + red-tinted name chips.
6. **Currently using Apps and Websites** — live list (empty state "No recent app found").
7. **Risky Users** — count + list (empty state "No data found !!!").
8. **Recent Screenshots** — thumbnail grid with member name under each.
9. **Work Hours Summary** — sortable table: Member, Hours Worked (green cells), ClockIn.
10. **Upcoming Holidays** — cards (name, date, weekday).
11. **Upcoming Leaves** — list (empty state "No one applied for leave in the upcoming days.").

Employee drill-down: [O] rows/thumbnails link to `/personal-statistics/<id>`.

## 3. My Team (`/my-teams`)

[O] Filter chips with counts: All Members · Currently Working · Currently In Break · Stopped Work · On Leave · App Not Installed · Yet To Start. Search box "Search in my teams". One **card per member**, tinted by state (red = stopped, yellow = yet to start, green = working [I]): avatar initial, name, status line ("Stopped work 03 hrs 44 mins ago" / "Yet to start work"), **Active Time %**, current/last app pill, check-in time, a progress bar, hours worked.

## 4. Personal statistics (drill-down)

[O] Inner member list + profile header (name, email), KPI cards: Total Worked Hours, Active Time, Productive Apps %, Idle Time Spent %, Clock-In Time, Clock-Out Time (each with one-line explanation). Then: Manual Time Summary, Activities bar chart (hours per day), Used Apps and Websites (category pills + donut), **Clock In & Out Summary** table (Date, Start, End, Activity Duration — e.g. "Worked for 00h 53m 32s", "System locked and clocked out from work").

[O] The reference treats **screen lock as an automatic clock-out** ("System locked and clocked out from work").

## 5. Screenshots (`/screenshots`)

[O] Inner member list ("Team View" + members). Banner note: screenshots taken while the user is inactive have a red border. Search "by typing the app or site name", Select All, Export, Delete, "Today Screenshots" heading, **Idle Screenshots** toggle, sort "Newest". Grid cards: app/site icon + name, checkbox, thumbnail, member, time.

## 6. Timelapse Videos (`/timelapse`)

[O] Per member, a row of day tiles (Yesterday, Last Tuesday … ) each with "Click to Generate Timelapse" (on-demand generation with ETA). Select All / Export / Delete; "See more" per member.

## 7. Timesheet (`/timesheet`)

[O] Grid: employee column (with Emp Id), a day column with ◀ ▶ navigation, per-cell IN / OUT / WORK / ACTIVE / IDLE values (cell tinted red when nothing worked), and a **Total Work Summary** column (Worked hours, Idle time, Active time, Worked days). "Filter Columns" multi-select (Clock In, Clock Out, Worked Hours, Active Time, Idle Time), **Export**, search.

## 8. Risk Users / Timeline / Manual Time

- **Risk Users** `/risk-user-history` [O]: "Risky Users" list + "Rules violated" accordion (Less Working Hours, Unproductive Triggers, with counts); "View Risk Triggers" button → Settings › Risk User Settings.
- **Timeline** `/timeline` [O]: "Today Activities" Gantt — one horizontal bar per member across 24 h, segments coloured by Productive / Unproductive / Neutral apps time, Idle time, Not in work, Untracked. Loading spinner first (~5 s).
- **Manual Time** `/manual-time` [O]: tabs Review Manual Time / My Manual Time; sub-tabs Unreviewed (n) / Approved (n) / Rejected (n); rows grouped by date: Employee, Description, Duration, Worked Time range, **Approve / Reject** buttons. (Not clicked.)

## 9. Reports (`/reports/*`)

Inner sub-menu [O], 14 reports:

| Report | URL | Observed layout |
|---|---|---|
| Daily Attendance | `daily-attendance` | Tabs Worked / Late Clock In / On Leave / Absent Employees; member filter, date, Export; table Employee, Date, Clock-In, Clock-Out, Duration |
| Monthly Attendance | `monthly-attendance` | Month picker; per employee: Total Days, Office Days, Clock-In Days, Worked Days, Week-off & Holidays, Days Worked in Week-off/Holidays, Informed Leave (Total/Paid/Unpaid), … (horizontal scroll); Export |
| Monthly In Out | `monthly-in-out` | Per employee: Worked Days, Non Worked Days, Late Clock-In Days, then In/Out per day of month; legend NA / A (Absent) |
| Late Clock-In | `late-clock-in` | [?] not opened in detail |
| Over Time Report | `over-time-report` | Overtime Days, Overtime Hours, then per-day overtime (red cells) |
| Custom Report | `custom-report` | Date, Report type Team / Organization Summary, Team select, column checkboxes (Total Worked, Active, Idle, Clock In/Out, Productive/Unproductive/Neutral apps, Break), **Export as xlsx** |
| Apps & Sites Usage | `apps-usage` | [?] not opened |
| Work Activity Log | `work-activity-log` | Member + date; Start, End, Activity Duration, events ("Clocked out from work", "System locked and clocked out from work") |
| Work Load Analysis | `work-load-analysis` | [?] not opened |
| Manual Time Report | `manual-time-report` | [?] not opened |
| Shift Time Report | `shift-time` | Shift cards (name, time range, active members x of y) + "Create New Shift" |
| Summary Report | `summary-report` | Date range, Team/Org summary; Worked Days, Total Hours, Active, Idle, Break, Productive, Unproductive, Neutral; Export as xlsx |
| Input Activity Report | `input-activity-report` | Member/date/activity filters; keyboard/mouse counts (premium; "No data found") |
| Login IP Report | `login-ip-report` | Per employee: number of IPs and IP addresses |

## 10. Leave Management

- **Apply Leave** [O]: balance cards per leave type (Planned, Unplanned, C-level; Available/Availed/Period), Upcoming/Past tabs, "Apply Short Leave", "Apply Leave".
- **Leave Summary** [O]: tabs Leave Summary / Short Leave Summary / View & Edit Leave Balance (beta); member + financial-year filters; Applied/Approved/Pending/Rejected; "View Leave History"; Export.
- **Manage Leave** [O]: tabs Approval Pending / Approved / Rejected / All; filters; rows with Approve / Reject (not clicked); Export.
- **Manage Holiday** [O]: year + type filter, "Add Holiday", "Import Holiday"; table Title, Date, Day, Session, Type, Visibility; View / Edit / Delete.

## 11. Apps Usage

- **Review Apps** [O]: categorise each app/site as Productive / Neutral / Unproductive; tabs Unreviewed / Reviewed / Top used / Exclude apps from idle time; "Download Unreviewed Apps".
- **Apps History** [O]: per member vertical timeline of app sessions with category tag; "Export App Usage".
- **Apps Summary** [O]: app list with time + donut; tabs Total Usage / Usage Per Employee.

## 12–16. Settings (`/settings/*`)

Sub-menu [O]: Manage Teams · Manage Employees · Track Settings · Risk User Settings · Email Reports · Rebrand Settings · Leave Settings. Search box "Search in settings".

| Page | Observed |
|---|---|
| Manage Teams | Team name, employee count, team head(s); "Create New Team"; row menu |
| Manage Employees | Filters Role / Team / OS; columns Account Details (name, email, Emp Id, "Edit Track Settings"), App Version, Team (with role in team, e.g. Team Head); Edit / Delete; "Add New Employee" |
| Track Settings | Work days; expected work hours; expected productive / active time; **organisation timezone**; **expected clock-in**; project management toggles; leave management; manual time (+ notify admins); untracked-hours handling; payroll (premium); keyboard/mouse tracking (premium, Windows); email report scope (all users / exclude admins / exclude admins & heads); screenshot enable / blur / interval / timelapse; idle threshold; ~11 permission toggles (employee sees own screenshots/timesheet/timelapse, heads may delete/export, hide admin data …); holiday notifications, API access, real-time alerts (premium). Warnings: desktop settings take up to 2 h; timezone change affects history |
| Risk User Settings | Risk triggers (e.g. avg work < 7 h over 4 days; idle > 1 h & unproductive > 1 h & work < 7 h); Edit / Make Inactive / Delete; "Create Risk Triggers" |
| Email Reports | List (empty: "No report created !!!") + **New Schedule Report** modal: Report Type (**Worked Hours / Late Clock-In / Absent**), Title, Frequency (**Daily / Every Sunday / Every month 1st day**), Send Email At (time, org timezone), Report Of (Team / Organisation summary), **Send report to** (multi-select of users) |
| Rebrand Settings | Company name, company logo upload |
| Leave Settings | Leave types (allowed days, cycle, carry forward, paid/unpaid, visibility), leave approvers, short leave allowance, annual cycle (financial year) |

## 17. Roles, permissions, notifications

- [O] Signed-in user shown as admin; roles visible in Manage Employees (Admin, Team Head). [I] Three roles: Admin, Team Head, Employee, with head scope set by teams and permission toggles in Track Settings.
- [O] Email notifications: scheduled **report** emails only (3 types), plus toggles "Send manual time notifications to admins", "Auto-send holiday notifications" (premium), "Real Time Alert" (premium), task status emails (premium).
- [?] No in-app notification centre observed. [?] No per-event clock-in/clock-out emails observed.

## 18. Not determinable from the visible UI

Backend architecture, data retention periods, how idle/active is computed, screenshot storage location and encryption,
audit logging of admin screenshot views, employee-side web UI (not inspected: the session is an admin), billing page,
desktop-agent behaviour beyond the "system locked → clocked out" log line, API (premium), and whether "Absent" honours
leave/holidays (the Absence widget listed members on a workday; [I] it does).

## 19. Interaction flows observed

1. Overview → click member → Personal statistics → switch member in inner list.
2. My Team → filter chip → card (status at a glance).
3. Reports → sub-report → member/date filter → Export (xlsx).
4. Settings › Email Reports → Create New Report → choose type/frequency/time/scope/recipients → (save not performed).
5. Manual Time / Manage Leave → Approve / Reject inline (not performed).
