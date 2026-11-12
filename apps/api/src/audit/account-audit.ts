import { randomUUID } from "node:crypto";
import type { InStatement } from "@workfolio/database";
import type { AccountAuditAction, AccountAuditResource } from "@workfolio/shared";

export interface AccountAuditEntry {
  /** The authenticated actor; null only for the server itself (bootstrap tool, automatic revocation). */
  actorUserId: string | null;
  targetUserId?: string | null;
  action: AccountAuditAction;
  resourceType: AccountAuditResource;
  resourceId?: string | null;
  reason?: string | null;
  /** Safe facts only: ids, counts, field names, statuses. Values must be primitives. */
  metadata?: Record<string, string | number | boolean | null>;
}

/** Metadata keys that could carry a secret or personal content are refused outright. */
const FORBIDDEN_KEY = /pass|token|secret|hash|cookie|authorization|key|content|image|reason/i;

/**
 * The INSERT for one account audit row, to be put in the SAME batch as the change it records (so a
 * change is never committed without its audit row, or the reverse). Pass `when` as a statement
 * condition (e.g. "changes() > 0") to write the row only if the preceding statement changed something;
 * `whenArgs` binds plain `?` placeholders in it. `changesAs` stores the preceding statement's row count
 * (`changes()`) in the metadata under that key: counts only known inside the transaction.
 */
export function accountAudit(
  entry: AccountAuditEntry,
  when?: string,
  opts: { whenArgs?: (string | number | null)[]; changesAs?: "count" | "sessionsRevoked" } = {},
): InStatement {
  const metadata = entry.metadata ?? {};
  for (const [k, v] of Object.entries(metadata)) {
    if (FORBIDDEN_KEY.test(k)) throw new Error(`account audit: metadata key "${k}" is not allowed`);
    if (v !== null && typeof v === "object") throw new Error(`account audit: metadata "${k}" must be a primitive`);
  }
  const meta = opts.changesAs ? `json_set(?, '$.${opts.changesAs}', changes())` : "?";
  return {
    sql: `INSERT INTO account_audit (id, actor_user_id, target_user_id, action, resource_type, resource_id, reason, metadata)
          SELECT ?, ?, ?, ?, ?, ?, ?, ${meta}${when ? ` WHERE ${when}` : ""}`,
    args: [randomUUID(), entry.actorUserId, entry.targetUserId ?? null, entry.action, entry.resourceType, entry.resourceId ?? null, entry.reason ?? null, JSON.stringify(metadata), ...(opts.whenArgs ?? [])],
  };
}

/**
 * The audit row for a read of ANOTHER employee's records by an admin or team head; null when the
 * caller reads their own (not audited). One row per request, naming the employee's account.
 */
export function employeeReadAudit(
  caller: { id: string },
  employee: { id: string; userId: string },
  action: Extract<AccountAuditAction, `EMPLOYEE_${string}`>,
  metadata: Record<string, string | number | null> = {},
): InStatement | null {
  if (caller.id === employee.userId) return null;
  return accountAudit({ actorUserId: caller.id, targetUserId: employee.userId, action, resourceType: "ACCOUNT", resourceId: employee.userId, metadata: { employeeId: employee.id, ...metadata } });
}
