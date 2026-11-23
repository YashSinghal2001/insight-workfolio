import type { InStatement } from "@workfolio/database";
import type { shiftInputSchema } from "@workfolio/shared";
import type { z } from "zod";
import { accountAudit } from "../audit/account-audit.js";
import { iso } from "../attendance/sessions.js";
import type { AuthContext } from "../auth/auth.service.js";

/**
 * Statements that set an employee's shift (insert or replace) with its audit row; `guard.when` (the Super
 * Admin guard) holds for all of them or none apply. Shared by PUT /employees/:id/shift and employee creation.
 * (SQLite needs a WHERE on INSERT … SELECT … ON CONFLICT, hence "WHERE 1".)
 */
export function shiftStatements(admin: AuthContext, e: { id: string; userId: string; timezone: string }, input: z.output<typeof shiftInputSchema>, guard: { when?: string; args: string[] } = { args: [] }): InStatement[] {
  const timezone = input.timezone ?? e.timezone;
  const now = iso(Date.now());
  return [
    {
      sql: `INSERT INTO employee_shifts (employee_id, start_time, end_time, timezone, grace_minutes, auto_clock_out, workdays, updated_by, updated_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.when ?? "1"}
            ON CONFLICT (employee_id) DO UPDATE SET start_time = excluded.start_time, end_time = excluded.end_time, timezone = excluded.timezone,
              grace_minutes = excluded.grace_minutes, auto_clock_out = excluded.auto_clock_out, workdays = excluded.workdays, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      args: [e.id, input.startTime, input.endTime, timezone, input.graceMinutes, input.autoClockOut ? 1 : 0, input.workdays, admin.id, now, ...guard.args],
    },
    accountAudit(
      { actorUserId: admin.id, targetUserId: e.userId, action: "SHIFT_ASSIGNED", resourceType: "ACCOUNT", resourceId: e.userId, metadata: { employeeId: e.id, startTime: input.startTime, endTime: input.endTime, timezone, graceMinutes: input.graceMinutes, autoClockOut: input.autoClockOut, workdays: input.workdays } },
      guard.when,
      { whenArgs: guard.args },
    ),
  ];
}

