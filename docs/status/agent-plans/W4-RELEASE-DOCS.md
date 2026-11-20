# W4-RELEASE-DOCS plan — production readiness, migration plan, rollback, smoke tests

Branch `agent/w4-release-docs`. Contracts §13. Docs only; no code, no deploy, no SSH.

## Deliverables

1. `docs/status/PRODUCTION-READINESS.md`
   - (a) what changes: features per wave, new endpoints (diff of controllers since `0493e54`), migrations
     0034 + 0035 statement by statement (additive only), measured runtime, lock behaviour (one write
     transaction per migration; API busy timeout). Note that production probably runs `4215c8e` (schema
     0032, unverified), so 0033 may be pending as well.
   - (b) env: `WORKFOLIO_BUILD_COMMIT` via `release.env` + the new `EnvironmentFile=-` line (needs
     `install-vps.sh`), `REPORT_MAIL_PROVIDER` values incl. `graph-delegated` + its refine, anything else
     from `git diff 0493e54..HEAD -- apps/api/src/config/env.ts` (and `4215c8e..0493e54` for completeness).
   - (c) pre-deploy checklist with exact copy + dry-run + timed apply commands against a copy.
   - (d) deploy steps with `deploy.sh`; (e) smoke tests; (f) rollback, with the "unknown migrations"
     refusal verified in `packages/database/src/migrations.ts` / `apps/api/src/database/prepare.ts`;
     (g) open owner decisions; (h) known limitations from agent plans.
2. Local migration dry-run: script in the scratchpad (not the repo) that builds a 0033 (and a 0032)
   database with the real migration statements + checksums, inserts synthetic rows (report_schedules,
   notification_events/deliveries, alert rules/alerts), runs the repo's `db:migrate --dry-run` then
   `db:migrate`, records timing and row survival. Commands and results copied into the doc.
3. `docs/releases/DEPLOY-RECORD-TEMPLATE.md` + a pointer in `docs/deployment.md` ("Which commit is deployed").

## Checks
Every claim is either verified locally (marked) or marked unverified. No file outside this worktree and
the session scratchpad is written.
