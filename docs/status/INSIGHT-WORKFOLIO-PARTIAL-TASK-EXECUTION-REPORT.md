# Insight Workfolio: Phase 1 — PARTIAL Task Execution Report (2026-11-02)

**Scope.** This phase covered the 24 tasks that were PARTIAL after the first execution (`INSIGHT-WORKFOLIO-EXECUTION-SUMMARY.md`).

**How the work was done.**
- Four sub-agents, each with its own files:
  - **H:** team head
  - **L:** labels and self-view
  - **S:** schedule and timelapse
  - **X:** Excel import
- The main agent reviewed every report. It also re-checked the one new write permission (team-head leave decisions) and ran the final regression.

**What was not done.** Nothing was committed or pushed, nothing was deployed, and no migration was applied outside temporary test databases. No Microsoft, Google, Render, Vercel or Turso resource was touched. The unknown-author `setup-password/page.tsx` change is unchanged (same 10/5-line diff).

## 1. Result

| Outcome | Tasks | Count |
|---|---|---:|
| **PARTIAL → DONE** | W39, W41, F09, F05, F08, W24 | 6 |
| **PARTIAL → BLOCKED** (local part finished first) | W17, F01, AW-04, F06 | 4 |
| **PARTIAL → BLOCKED** (no local work left) | AW-06, API-13, DB-15, ST-08, ST-12, MAC-17, EXT-03, DEP-10, DEP-13, CI-06, W30, W43, W49 | 13 |
| **Still PARTIAL** | F04 | 1 |
| **Total** | | **24** |

## 2. Original 24 PARTIAL tasks and what happened

| ID | Gap before Phase 1 | Phase 1 work | New status |
|---|---|---|---|
| W39 | CSV import only, no Excel | `.xlsx` parsed in the browser into the existing validated CSV import. No dependency added. 1900/1904 serial dates, ISO and unambiguous d/m text, per-row errors, `.xls` refused. | **DONE** |
| W41 | API scope only, no team-head UI, several views unscoped | Team-scoped reads (see §3) and own-team leave approve/reject. "My team" area under `/my`, shown to team heads only. | **DONE** |
| F09 | No team-head timelapse UI | Per-member timelapse panel in `/my/team/screenshots` | **DONE** |
| F05 | No per-team label definitions | Per-team app-label overrides (migration 0027) used in all scoring, with an admin Labels card | **DONE** |
| F08 | No per-person self-view switch | Per-person inherit/allow/deny override (0027), enforced on the server | **DONE** |
| W24 | No expected-start window | `GET /attendance/expected` plus a marker on both timelines | **DONE** |
| W17 | Late email; leave counting ignored per-person workdays | Leave-day counting now uses per-person workdays | **BLOCKED** (late email → D5 email provider) |
| F01 | Not durable; no automatic daily videos | Opt-in automatic daily videos (migration 0028) | **BLOCKED** (durability → D1 storage) |
| AW-04 | No account, last upload or connect | "Last upload" on the Storage card from an admin-only endpoint | **BLOCKED** (account and connect → D1) |
| F06 | Email delivery | — (in-app part already done) | **BLOCKED** (D5) |
| AW-06 | Durable playback | — | **BLOCKED** (D1) |
| API-13 | Render instance setting | — | **BLOCKED** (D4) |
| DB-15 | First real Turso dump | — | **BLOCKED** (D3 / Turso access) |
| ST-08 | Keep or drop the Graph code | — | **BLOCKED** (D1) |
| ST-12 | Approved decision | — | **BLOCKED** (D1) |
| MAC-17 | Real Intel Mac | — | **BLOCKED** (Intel Mac hardware) |
| EXT-03 | Distribution channel | — | **BLOCKED** (new D13: channel choice) |
| DEP-10 | Real deployment to match | — | **BLOCKED** (D4) |
| DEP-13 | 12/12 on staging | — | **BLOCKED** (D4 + D1) |
| CI-06 | File tracked | — | **BLOCKED** (D2 first commit) |
| W30 | Primary display only, by design | — | **BLOCKED** (new D12: product/privacy decision) |
| W43 | Email invites | — | **BLOCKED** (D5) |
| W49 | Signed, plus Intel run | — | **BLOCKED** (D8 + Intel Mac) |
| F04 | Chromium only; host permission | — (host permission was done earlier, EXT-02) | **PARTIAL**: Firefox/Safari is the separate EXT-04 row, which you DEFERRED. Staging connect is EXT-02 (NEEDS VERIFICATION). |

## 3. Completed tasks and evidence

### W39 Holiday import from Excel
- **Work:**
  - `apps/dashboard/src/lib/xlsx-holidays.ts` reads the ZIP central directory and inflates entries with the native `DecompressionStream("deflate-raw")`. It reads the first sheet and shared strings, converts dates, and passes the result through the existing `parseHolidayCsv` → `POST /holidays/import`.
  - Ambiguous text such as 3/4/2026 is refused with `Row N` messages.
- **Tests:**
  - `xlsx-holidays.test.mjs`: 7/7 (generated DEFLATE and STORED workbooks).
  - `verify-xlsx.mjs`: 11/11. A real file input upload led to the API storing exactly 3 rows. Re-import skips all 3, and `.xls` and bad files are refused.
- **Not covered:** a workbook saved by real Excel (the fixtures are spec-generated).

### W41 Team head role
- **Team-scoped reads:**
  - employees, attendance overview, summary and daily
  - org timesheets plus CSV/XLSX export
  - activity overview
  - screenshots and timelapse
  - leave list, detail, summary and balances
- **Leave decisions:** `LeaveService.decide` contains an explicit exception. A team head may decide only for members of a team they head, never for their own request, and gets 404 outside the team. `leave:review` stays admin-only.
- **New permission:** `leave:read-all`, a read permission for admins plus team heads.
- **`/auth/me`:** returns `teamHead`.
- **Dashboard:** `/my/team` with members, attendance, timesheets, screenshots plus timelapse, and leave. It appears in the navigation for team heads only, and its layout gate refuses everyone else.
- **Tests:**
  - `team-head-scope.e2e` (7 tests incl. `/attendance/daily`) and `teams.e2e`.
  - `verify-teamhead.mjs`: 27/27. The approval is recorded with `decided_by` = the head, and the outsider's request stays PENDING. A plain employee has no My team entry.
- **Scope note:** projects and reports remain organisation-level resources, so they were not scoped.

### F09 Timelapse permissions
- Timelapse routes are team-scoped (404 outside the team, e2e).
- The per-member timelapse panel renders for heads (`verify-teamhead`).

### F05 Productivity labels and scoring
- **Data:** migration `0027_team_labels_self_view` adds `team_application_category_rules`. Rows are versioned (a change ends the old row), deletes are blocked, and matching is case-insensitive.
- **Rule** (`categorizeForEmployee`):
  - If the active teams that label an app agree, that label applies.
  - If they disagree, or none labels it, the organisation label applies.
  - Inactive teams are ignored.
- **Where it applies:** `/activity/summary`, `/activity/timeline`, `/activity/overview` and `/teams/productivity`.
- **Routes:** `GET/PUT/DELETE /teams/:id/labels` (`teams:manage`).
- **Tests:**
  - `team-labels-self-view.e2e`.
  - `verify-labels.mjs` 18/18: the team's productive share went from 20 % to 60 % and the non-member was unchanged.

### F08 Screenshot access control
- **Data:** `employee_tracking_overrides.screenshot_self_view` (NULL inherit, 1 allow, 0 deny), versioned like the other per-person overrides.
- **Enforcement:** `assertSelfView` checks the person first, then the organisation. Deny returns 403 on the employee's own list, detail and content. Admins and team heads are unchanged.
- **Tests:** e2e covers deny-while-org-allows, allow-while-org-denies, inherit and carry-over. In the browser (`verify-labels`) the denied employee sees 0 images and the API returns 403.
- **Wording:** the employee notice now reads "Your administrator has not enabled viewing your own screenshots for you".

### W24 Daily activity timeline
- **Endpoint:** `GET /attendance/expected?from&to[&employeeId]`.
  - Permission `timesheet:read-own`, with `attendanceTarget` scoping: your own record, or others if you are an admin or a team head in scope.
  - Ranges are limited to 92 days.
  - Days are skipped when they are non-workdays or holidays, or when the schedule is off.
- **Display:** the marker runs from the expected start to start + grace, with "Expected start HH:MM" in the text. The schedule has no duration, so no end is drawn.
- **Tests:** `expected-schedule.e2e`; `verify-schedule.mjs` 20/20. The marker appears at 10:30 (the override) on admin `/activity` and `/my/activity`, and not on the holiday.

## 4. Tasks converted to BLOCKED, and local work finished first

| ID | Local work completed in Phase 1 | Exact remaining external action |
|---|---|---|
| W17 | Leave-day counting uses the employee's effective workdays: a Mon–Sat person is charged 5 days and a Mon–Thu person 3 days for the same Mon–Sun leave. Approval within balance gives 200 vs 409. (e2e) | Choose an email provider (D5). Then build the late email on the alerts mail hook. |
| F01 | Migration `0028_auto_timelapse`; a "Generate daily timelapse automatically" toggle (off by default, versioned); `autoTick` every 15 min queues one video per finished session. It deduplicates, needs 2–2000 frames, looks back 3 days and leaves a queue slot for admins. (`auto-timelapse.e2e`, 5 runs green. Browser: the toggle saves, and a tick queued a job that went READY with real FFmpeg.) | Storage decision (D1) for durable MP4 storage (ST-17/ST-19). Note: one video per session, not per day. |
| AW-04 | "Last upload" from admin-only `GET /settings/screenshots` (`lastUploadAt`), not added to the public `/ready`. (e2e + browser) | D1, then the account display and Connect/disconnect against the real provider. |
| F06 | — (in-app done earlier) | D5 email provider |
| AW-06, ST-08, ST-12 | — | D1 storage decision |
| API-13, DEP-10, DEP-13 | — | D4 hosting (Render service, staging run) |
| DB-15 | — | D3: first real `db:dump` of Turso staging |
| CI-06 | — | D2: first commit |
| MAC-17 | — | Run the universal app on an Intel Mac |
| W49 | — | D8 Apple Developer ID, plus an Intel Mac |
| EXT-03 | — | New D13: choose a distribution channel |
| W30 | — | New D12: decide whether capturing every display is wanted and acceptable (privacy/HR) |
| W43 | — | D5 email provider |

All blocker groups and unblock steps are in `INSIGHT-WORKFOLIO-BLOCKED-TASKS.md`. Two decisions are new: **D12** (multi-display capture) and **D13** (extension distribution channel).

## 5. Files changed in Phase 1 (58)

- **API source:** `apps/api/src/`
  - Activity: `activity/{activity.service, categories.service}.ts`
  - Attendance: `attendance/{attendance.controller, attendance.service, timesheet.service}.ts`
  - Auth: `auth/auth.controller.ts`
  - Leave: `leave/{leave.controller, leave.service}.ts`
  - Schedule: `schedule/{schedule.controller, schedule.service}.ts`
  - Screenshots: `screenshots/{screenshot-settings.service, screenshots.service, timelapse.service}.ts`
  - Settings: `settings/{employee-tracking.controller, monitoring-settings.service}.ts`
  - Teams: `teams/{teams.controller, teams.service}.ts`
- **API tests:** `apps/api/test/`
  - New: `auto-timelapse`, `expected-schedule`, `team-head-scope`, `team-labels-self-view` (all `.e2e.test.ts`)
  - Edited: `teams.e2e` (head 403 list) and `person-overrides.e2e` (one deepEqual)
- **Dashboard:**
  - Scripts: `apps/dashboard/scripts/verify-{labels,schedule,teamhead,xlsx}.mjs`
  - Admin pages: `src/app/(admin)/{holidays, settings, teams}/page.tsx`
  - Employee pages: `src/app/my/layout.tsx` (one line), `src/app/my/screenshots/page.tsx` (wording)
  - Team pages: `src/app/my/team/{layout, page, attendance/page, leave/page, screenshots/page, timesheets/page}.tsx`
  - Components: `src/components/{breaks-overlay, my-nav, tracking-overrides}.tsx`
  - Lib: `src/lib/xlsx-holidays.{ts,test.mjs}`
- **Database:**
  - Migrations: `packages/database/src/migrations.ts` (0027, 0028 only)
  - Tests: `{auto-timelapse, team-labels-self-view}.test.ts`
- **Shared:** `packages/shared/src/{activity, api, leave, roles, schedule, screenshots, teams, timelapse}.ts`, `teams.test.ts`
- **Docs:** `docs/{leave-requests, teams, timelapse}.md`
- **Reports:** `docs/status/` (this report, master checklist, remaining, blocked)

## 6. Tests executed (final tree, after all Phase 1 changes)

Everything below ran under the shared build lock.

| Check | Result | Before Phase 1 |
|---|---|---|
| `pnpm build:packages` + API build | OK | OK |
| `pnpm -r typecheck` | clean | clean |
| `pnpm -r lint` (eslint + clippy `-D warnings`) | clean | clean |
| shared | 69 / 69 | 67 |
| database | 40 / 40 | 37 |
| API e2e | 385 / 385 | 367 |
| desktop TS | 66 / 66 | 66 |
| Rust `cargo test` | 94 passed, 1 ignored | same |
| extension | 7 / 7 | 7 |
| dashboard lib tests (zoned-time + xlsx-holidays) | 9 / 9 | 2 |
| dashboard smoke (`next build` + routes) | PASS, 35 routes | 35 |

Browser checks (headless Chrome against a real API on a temporary database, `next dev`):

| Script | Result | Phase |
|---|---|---|
| `verify-wave2` | 55 / 55 | regression |
| `verify-my-panel` | 43 / 43 | regression |
| `verify-gallery` | 18 / 18 | regression |
| `verify-setup-password` | 14 / 14 | regression |
| `verify-teamhead` | 27 / 27 | new |
| `verify-labels` | 18 / 18 | new |
| `verify-schedule` | 20 / 20 | new |
| `verify-xlsx` | 11 / 11 | new |

That is **206 / 206** browser checks.

**Total automated tests: 670 passed, 0 failed** (69 + 40 + 385 + 66 + 94 + 7 + 9), plus 1 ignored Rust test.

**Not run:**
- Production-build browser runs of the four new scripts (the dashboard production build itself passed the smoke test).
- Staging, real email, real storage, macOS/Windows runtime.

## 7. Regressions and risks

- **No regressions found.** Every earlier suite and browser script still passes.
- **New write path for non-admins:** team heads can approve or reject leave for their team. The decision is an explicit, tested exception in `LeaveService.decide`; the role permission was not widened. Reviewed by the main agent.
- **New read surface for team heads:** timesheets and export, leave, and attendance daily/summary. Every route is opt-in via `@TeamScoped` and filtered by `common/scope.ts`, with e2e tests showing 404 outside the team.
- **More migrations awaiting Turso approval:** 0027 and 0028. Turso staging is at 0016, and source now holds 0017, 0019 and 0021–0028; since 2026-11-03 a hosted API refuses to start while they are pending instead of applying them at boot. Apply them deliberately under D3 after a dump. Numbers 0021–0028 were assigned during execution, and 0018/0020 stay reserved.
- **Automatic timelapse:** adds background FFmpeg load on the API host when enabled (off by default). Like other in-process schedulers it assumes a single instance, and videos are still lost on redeploy until D1.
- **Team label rule:** when teams disagree, the organisation label applies (documented in `docs/teams.md`). Admins may expect a different tie-break.
- **Label and override changes:** kept as row history, not in the audit-log view.

## 8. Updated overall totals

### 139-task cohort

| Status | After first execution | After Phase 1 |
|---|---:|---:|
| DONE | 13 | **19** |
| PARTIAL | 24 | **1** |
| BLOCKED | 62 | **79** |
| NEEDS VERIFICATION | 40 | 40 |
| PENDING | 0 | 0 |
| DEFERRED | 0 | 0 |
| **Total** | 139 | **139** |

- **Done:** 19 of 139 (13.7 %).
- **Unresolved:** 120.
- **Unique unresolved:** 114, counting the six audit overlaps once.

### All 202 rows

| Status | Rows |
|---|---:|
| DONE | 70 (51 baseline + 19) |
| PARTIAL | 1 |
| BLOCKED | 79 |
| NEEDS VERIFICATION | 40 |
| DEFERRED | 12 |
| **Total** | 202 |

## 9. Recommended next phase (not started)

Almost everything left is **BLOCKED (79)** or **NEEDS VERIFICATION (40)**, so the next phase depends on your decisions and access, not on more local code.

1. **Verification at the Mac (about 2 h, no decisions needed).** Clears up to 16 NEEDS VERIFICATION rows: MAC-03…MAC-12, MAC-16, MAC-19, F02, W46, and W21/W22 on macOS. Click "Always Allow" once for the packaged suites.
2. **D2 commit + private remote.** Unblocks CI-01/02/05/06 and WIN-18/19, and gives the first CI run (CI-03, WIN-03).
3. **D1 storage decision.** Unblocks 20 rows, including AW-04, AW-06, F01 and the durable timelapse.
4. **D5 email provider.** Unblocks API-09, F12, W17, F06 and W43. The alerts mail hook is ready.
5. **D3 + D4.** Turso migrations (now 0017–0028 without 0018/0020) and hosting. Then run `staging:suite` for DEP-13.
6. **Small decisions:**
   - D12: multi-display capture.
   - D13: extension distribution channel.
   - D6: setup-link policy.
   - D11: product scope.
