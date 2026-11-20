# W2-SETTINGS — plan

Branch `agent/w2-settings`. Contracts: `docs/IMPLEMENTATION-CONTRACTS.md` §4–§9, §11.

## 1. Settings split (behaviour unchanged, code moved)

Today `/settings` is one 664-line page. Its sections move into `app/(admin)/settings/_parts/*.tsx` (private
folder, not routes) and each sub-page renders them unchanged:

| Route | Content |
|---|---|
| `/settings` General | "In force now" summary (monitoring + screenshots) and a card list linking every sub-page. Forwards the OneDrive / Google Drive OAuth return (`?oneDrive=` / `?googleDrive=`, set by the API) to `/settings/storage` |
| `/settings/schedule`, `/settings/labels` | exist, unchanged |
| `/settings/monitoring` | Activity monitoring form, notices, activity retention (dry run + purge), settings history |
| `/settings/screenshots` | Screenshot settings + privacy masks + screenshot retention |
| `/settings/websites` | Website policy lives on `/websites` together with its report (not owned by this agent): a short page linking there; no duplicate form |
| `/settings/storage` | Storage readiness card + Microsoft OneDrive card |
| `/settings/notifications` | new: notification rules UI (below) |
| `/settings/leave-types` | the existing leave-type manager (`leave/leave-types.tsx`), removed from the `/leave` tabs (link kept there) |

Super-Admin gating (`useCan`) moves with the components. `SETTINGS_NAV` gets the new entries; smoke routes added.
`verify-*.mjs`: `/settings` selectors for the screenshot form, policy form, storage card and retention inputs move to
the sub-page URLs; leave types move to `/settings/leave-types`. Every change listed in the report.

## 2. `/settings/notifications`

GET `/notifications/rules` (creates the six org-wide OFF rules), GET `/notifications` (email status only),
GET `/teams`, GET `/roles/users` is Super-Admin only so admin candidates come from GET `/employees?role=ADMIN|SUPER_ADMIN`
(new filter) plus each team's head. One card per type: org-wide rule + any team rules; per rule: mode, digest time,
timezone (PATCH), recipients checklist (PUT; API 400 shown inline). "Add team rule" (POST teamId). Provider banner from
`email.delivers` / `provider`; link to `/notifications`. Text: every rule starts Off. Pure helpers (rule grouping,
candidate list) in `src/lib/notification-rules.ts` with unit tests.

## 3. Employees list filters

Shared `listEmployeesQuerySchema` + optional `teamId` (uuid), `role` (PLATFORM_ROLES), `platform` (macos|windows),
`appVersion` (MAJOR.MINOR.PATCH). `Employee` gains additive `platformRole`, `teams` (active teams), `platforms`,
`appVersion` (latest reported by a non-revoked device). `EmployeesService.list` adds the conditions (non-revoked
devices; team via `teamFilterSql` + `assertTeamReadable` → 404 for unknown / not-headed team). No schema change.
e2e `apps/api/test/employees-filters.e2e.test.ts`: each filter, combinations, head scope + foreign team 404,
employee 403, validation 400. Dashboard `/employees`: filter bar + Team, Role, App version columns.

## 4. Polish

Teams, roles, devices, leave, holidays: `about` text, kit empty/error states where missing. No behaviour change.
Leave balances are already a tab of `/leave` (GET `/leave/balances`); kept.

## Gates

`pnpm build:packages`; typecheck + lint shared/api/dashboard; full API suite; dashboard `test:unit`. No browser
suites (fixed ports) — browser checks described for the lead.
