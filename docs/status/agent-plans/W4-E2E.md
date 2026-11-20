# W4-E2E — plan

Branch `agent/w4-e2e`. Contracts §7, §13. Tracker rows P7-01…05, P7-08, P7-09, P7-11.

| # | Work | Where |
|---|---|---|
| 1 | Browser parity suite (admin, Super Admin, team head, employee): Overview, Live team, Attendance tabs + corrections, profile, reports + week grid, settings + notifications, timeline + screenshots (idle, ZIP export), activity, risk users, /my banner + calendar, team-head attendance, theme, focus. Responsive checks at 1440/1024/768/375. Ports from `IW_API_PORT`/`IW_APP_PORT`/`IW_CDP_PORT` (4000/3105/9345) | new `apps/dashboard/scripts/verify-parity.mjs`, `verify:parity` script |
| 2 | Flows in the same suite: simulated desktop (device register, clock-in/out, offline batch with skewed timestamps) → Live/Overview/Attendance; mock notification delivery (IMMEDIATE → exactly one, OFF → none) | verify-parity.mjs |
| 3 | Performance: 200 synthetic employees × ~30 days; p50/p95 of 10 calls for overview, monthly, missing-clock-outs, risk-users, team-timeline + Overview page load. Not in the default test run | new `apps/api/scripts/perf-parity.mjs` |
| 4 | Backup/restore drill against a local temp DB with the repo's scripts; integrity_check + row counts | `docs/status/BACKUP-RESTORE-DRILL.md` |
| 5 | P7-11: the 6 time-of-day tests seed relative to an in-day anchor; screenshots-gallery load flake root-caused. Proof: run under a shifted process clock (01:14 UTC) + full API suite twice | `apps/api/test/*.e2e.test.ts` (those files only) |
| 6 | Dedupe `src/lib/poll.ts` / `src/lib/latest.ts` | dashboard lib |
| 7 | Re-run every browser suite on the final build; fix verify-my-panel `/downloads/` assertion if the VPS path is intended (commit cebfb5c) | `apps/dashboard/scripts/verify-my-panel.mjs` |

Gates: build:packages, typecheck + lint (api, dashboard), full API suite, dashboard test:unit. `.next` deleted at the end.
No schema, API or dependency change; synthetic data only; no real mail provider.
