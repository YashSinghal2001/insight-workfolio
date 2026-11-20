# Production deploy record

One line per production activation (deploy or rollback), newest last. Fill it from the VPS right after
`deploy.sh` finishes: `tail -1 /opt/workfolio/deploys.log` gives date, action, commit and operator; the `APPLIED`
lines printed by `deploy.sh --migrate` give the migrations. Tag the commit `prod-YYYY-MM-DD[-n]` and push the tag.
Procedure and smoke list: `docs/status/PRODUCTION-READINESS.md` (sections 3, 5, 6).

Columns:
- **Date (UTC)**: from `deploys.log`.
- **Action**: `deploy` or `rollback`.
- **Commit**: full SHA (`/api/v1/health` → `commit` must match).
- **Tag**: `prod-YYYY-MM-DD[-n]`, or `—` for a rollback.
- **Migrations**: ids applied, or `none`; schema version after (`SELECT max(id) FROM schema_migrations`).
- **Pre-deploy backup**: file name in `/var/backups/workfolio/` (verified with `verify-backup.sh`: yes/no).
- **Operator**: who ran it.
- **Smoke**: `pass`, or `fail: <check numbers>` with a short note.

| Date (UTC) | Action | Commit | Tag | Migrations (schema after) | Pre-deploy backup | Operator | Smoke |
|---|---|---|---|---|---|---|---|
| 2026-MM-DDTHH:MM:SSZ | deploy | `<40-char sha>` | `prod-2026-MM-DD` | `0033_notifications, 0034_notification_rules, 0035_report_schedule_kinds` (0035) | `workfolio-<ts>.db.gz.gpg` (verified: yes) | `<name>` | pass |
