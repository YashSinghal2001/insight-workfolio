import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import type { DatabaseClient } from "@workfolio/database";
import { AUDIT_RANGE_MAX_DAYS, addDays, zonedToUtc, type AuditEvent, type AuditQuery, type AuditSource, type Paginated } from "@workfolio/shared";
import { DATABASE } from "../database/database.module.js";

const bool = (col: string) => `json(CASE WHEN ${col} = 1 THEN 'true' ELSE 'false' END)`;

/**
 * One SELECT per source table, all mapped to the same columns. `?` placeholders are the UTC window
 * [start, end) on the table's own time column (so its index is used where one exists). Details are
 * built from safe columns only: ids, versions, statuses, counts, booleans. See docs/audit.md.
 */
const BRANCHES: Record<AuditSource, string[]> = {
  ACCOUNT: [
    `SELECT 'ACCOUNT', id, created_at, action, actor_user_id, target_user_id, resource_type, resource_id, reason, metadata
     FROM account_audit WHERE created_at >= ? AND created_at < ?`,
  ],
  ROLE: [
    `SELECT 'ROLE', id, created_at, 'ROLE_CHANGED', actor_id, target_user_id, 'USER', target_user_id, reason,
       json_object('from', from_role, 'to', to_role)
     FROM role_changes WHERE created_at >= ? AND created_at < ?`,
  ],
  WEBSITE: [
    `SELECT 'WEBSITE', id, created_at, action, actor_id, NULL,
       CASE WHEN json_extract(details, '$.ruleId') IS NOT NULL THEN 'WEBSITE_CATEGORY_RULE' ELSE 'WEBSITE_DATA' END,
       json_extract(details, '$.ruleId'), NULL, details
     FROM website_audit WHERE created_at >= ? AND created_at < ?`,
  ],
  PROJECT: [
    `SELECT 'PROJECT', pa.id, pa.created_at, pa.action, pa.actor_id, ep.user_id, 'PROJECT', pa.project_id, NULL, pa.details
     FROM project_audit pa LEFT JOIN employee_profiles ep ON ep.id = json_extract(pa.details, '$.employeeId')
     WHERE pa.created_at >= ? AND pa.created_at < ?`,
  ],
  SCREENSHOT_ACCESS: [
    `SELECT 'SCREENSHOT_ACCESS', l.id, l.accessed_at, l.action, l.user_id, p.user_id, 'SCREENSHOT', s.id, NULL,
       json_object('screenshotId', s.id, 'employeeId', p.id, 'capturedAt', s.captured_at)
     FROM screenshot_access_log l JOIN screenshots s ON s.id = l.screenshot_id JOIN employee_profiles p ON p.id = s.employee_id
     WHERE l.accessed_at >= ? AND l.accessed_at < ?`,
  ],
  // Screenshots deleted by a person (deleted_by set): admin deletes and admin-triggered retention runs alike
  // (the row cannot tell them apart). Scheduled retention (deleted_by NULL) is not listed. No reason column.
  SCREENSHOT_DELETION: [
    `SELECT 'SCREENSHOT_DELETION', s.id, s.deleted_at, 'SCREENSHOT_DELETED', s.deleted_by, p.user_id, 'SCREENSHOT', s.id, NULL,
       json_object('screenshotId', s.id, 'employeeId', p.id, 'capturedAt', s.captured_at)
     FROM screenshots s JOIN employee_profiles p ON p.id = s.employee_id
     WHERE s.upload_status = 'DELETED' AND s.deleted_by IS NOT NULL AND s.deleted_at >= ? AND s.deleted_at < ?`,
  ],
  TIMELAPSE_ACCESS: [
    `SELECT 'TIMELAPSE_ACCESS', l.id, l.accessed_at, l.action, l.user_id, p.user_id, 'TIMELAPSE', t.id, NULL,
       json_object('timelapseId', t.id, 'employeeId', p.id, 'attendanceSessionId', t.attendance_session_id)
     FROM timelapse_access_log l JOIN timelapses t ON t.id = l.timelapse_id JOIN employee_profiles p ON p.id = t.employee_id
     WHERE l.accessed_at >= ? AND l.accessed_at < ?`,
  ],
  SETTINGS: [
    `SELECT 'SETTINGS', 'monitoring-policy:' || seq, effective_at, 'MONITORING_POLICY_CHANGED', changed_by, NULL, 'MONITORING_POLICY', CAST(seq AS TEXT), reason,
       json_object('version', seq, 'enabled', ${bool("monitoring_enabled")}, 'sampleSeconds', sample_seconds, 'idleThresholdSeconds', idle_threshold_seconds,
         'retentionDays', retention_days, 'retentionApproved', ${bool("retention_approved")}, 'noticeVersion', notice_version)
     FROM monitoring_policies WHERE effective_at >= ? AND effective_at < ?`,
    `SELECT 'SETTINGS', 'screenshot-policy:' || seq, effective_at, 'SCREENSHOT_POLICY_CHANGED', changed_by, NULL, 'SCREENSHOT_POLICY', CAST(seq AS TEXT), reason,
       json_object('version', seq, 'enabled', ${bool("screenshots_enabled")}, 'intervalSeconds', interval_seconds, 'retentionDays', retention_days,
         'retentionApproved', ${bool("retention_approved")}, 'employeeSelfView', ${bool("employee_self_view")}, 'maskCount', json_array_length(mask_regions),
         'blur', ${bool("blur")}, 'noticeVersion', notice_version)
     FROM screenshot_policies WHERE effective_at >= ? AND effective_at < ?`,
    `SELECT 'SETTINGS', 'screenshot-blur-override:' || o.id, o.effective_at, 'SCREENSHOT_BLUR_OVERRIDE_CHANGED', o.changed_by, p.user_id, 'EMPLOYEE', o.employee_id, o.reason,
       json_object('employeeId', o.employee_id, 'blur', CASE WHEN o.blur IS NULL THEN NULL ELSE ${bool("o.blur")} END)
     FROM screenshot_blur_overrides o JOIN employee_profiles p ON p.id = o.employee_id WHERE o.effective_at >= ? AND o.effective_at < ?`,
    `SELECT 'SETTINGS', 'website-policy:' || seq, effective_at, 'WEBSITE_POLICY_CHANGED', changed_by, NULL, 'WEBSITE_POLICY', CAST(seq AS TEXT), reason,
       json_object('version', seq, 'enabled', ${bool("enabled")}, 'retentionDays', retention_days, 'noticeVersion', notice_version)
     FROM website_policies WHERE effective_at >= ? AND effective_at < ?`,
    `SELECT 'SETTINGS', 'monitoring-notice:' || version, created_at, 'MONITORING_NOTICE_PUBLISHED', created_by, NULL, 'MONITORING_NOTICE', version, NULL,
       json_object('noticeVersion', version, 'draft', ${bool("draft")}, 'points', json_array_length(points))
     FROM monitoring_notices WHERE created_at >= ? AND created_at < ?`,
    `SELECT 'SETTINGS', 'work-schedule:' || seq, effective_at, 'WORK_SCHEDULE_CHANGED', changed_by, NULL, 'WORK_SCHEDULE', CAST(seq AS TEXT), reason,
       json_object('version', seq, 'enabled', ${bool("enabled")}, 'expectedStart', expected_start, 'graceMinutes', grace_minutes, 'workdays', workdays)
     FROM work_schedule_policies WHERE effective_at >= ? AND effective_at < ?`,
    `SELECT 'SETTINGS', 'app-category:' || id, created_at, 'APP_CATEGORY_' || action, actor_id, NULL, 'APPLICATION_CATEGORY_RULE', rule_id, NULL, details
     FROM activity_category_audit WHERE created_at >= ? AND created_at < ?`,
  ],
};

/** Keys that could carry a secret, a path or free text are dropped from stored JSON details. */
const UNSAFE_KEY = /pass|token|secret|hash|cookie|authorization|key|content|image|path|storage|checksum|description/i;

function safeDetails(raw: unknown): AuditEvent["details"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw ?? "{}"));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: AuditEvent["details"] = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (UNSAFE_KEY.test(k)) continue;
    if (typeof v === "string") out[k] = v.length > 200 ? `${v.slice(0, 200)}…` : v;
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
  }
  return out;
}

const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

function validZone(tz: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Unified, read-only audit view over the existing append-only tables. Nothing here writes. */
@Injectable()
export class AuditService {
  constructor(@Inject(DATABASE) private readonly db: DatabaseClient) {}

  async list(q: AuditQuery): Promise<Paginated<AuditEvent>> {
    if (!validZone(q.timeZone)) throw new BadRequestException("Unknown time zone");
    const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 + 1;
    if (days > AUDIT_RANGE_MAX_DAYS) throw new BadRequestException(`Range is limited to ${AUDIT_RANGE_MAX_DAYS} days`);
    const start = zonedToUtc(`${q.from}T00:00`, q.timeZone);
    const end = zonedToUtc(`${addDays(q.to, 1)}T00:00`, q.timeZone);

    const branches = q.source ? BRANCHES[q.source] : Object.values(BRANCHES).flat();
    // Column names come from the CTE, so any subset of branches lines up.
    const cte = `WITH e(source, rid, at, action, actor_id, target_id, resource_type, resource_id, reason, details) AS (${branches.join("\nUNION ALL\n")})`;
    const unionArgs = branches.flatMap(() => [start, end]);
    const where: string[] = [];
    const args: string[] = [];
    for (const [col, v] of [["actor_id", q.actorId], ["target_id", q.targetUserId], ["action", q.action?.toUpperCase()]] as const) {
      if (v === undefined) continue;
      where.push(`e.${col} = ?`);
      args.push(v);
    }
    const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows, count] = await this.db.batch(
      [
        {
          sql: `${cte} SELECT e.*, a.email AS actor_email, t.email AS target_email FROM e
                LEFT JOIN users a ON a.id = e.actor_id LEFT JOIN users t ON t.id = e.target_id
                ${filter} ORDER BY e.at DESC, e.source, e.rid LIMIT ? OFFSET ?`,
          args: [...unionArgs, ...args, q.pageSize, (q.page - 1) * q.pageSize],
        },
        { sql: `${cte} SELECT count(*) AS n FROM e ${filter}`, args: [...unionArgs, ...args] },
      ],
      "read",
    );
    const items = rows!.rows.map((r): AuditEvent => ({
      id: `${String(r.source)}:${String(r.rid)}`,
      source: String(r.source) as AuditSource,
      at: String(r.at),
      action: String(r.action),
      actor: r.actor_id ? { id: String(r.actor_id), email: str(r.actor_email) ?? "unknown user" } : null,
      target: r.target_id ? { userId: String(r.target_id), email: str(r.target_email) ?? "unknown user" } : null,
      resource: r.resource_type ? { type: String(r.resource_type), id: str(r.resource_id) } : null,
      reason: str(r.reason),
      details: safeDetails(r.details),
    }));
    return { items, total: Number(count!.rows[0]!.n), page: q.page, pageSize: q.pageSize };
  }
}
