import { ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { can, type AttendancePolicy, type AuthUser } from "@workfolio/shared";
import type { Env } from "../config/env.js";

export const POLICY = Symbol("ATTENDANCE_POLICY");

/** Effective attendance policy from env (defaults in packages/shared/src/timesheet.ts). */
export const policyProvider = {
  provide: POLICY,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): AttendancePolicy => ({
    weekStartsOn: config.get("WORKWEEK_START_DAY", { infer: true }),
    scheduledDailyMinutes: Math.round(config.get("SCHEDULED_HOURS_PER_DAY", { infer: true }) * 60),
    maxOfflineAgeDays: config.get("OFFLINE_MAX_AGE_DAYS", { infer: true }),
  }),
};

/**
 * Changing a retention period or its approval decides what the scheduled purge deletes, so it needs the
 * same Super Admin-only capability as running a purge. Saving the form with those fields unchanged does not.
 */
export function assertMayChangeRetention(user: AuthUser, current: { retentionDays: number; retentionApproved?: boolean }, next: { retentionDays: number; retentionApproved?: boolean }) {
  if (current.retentionDays === next.retentionDays && current.retentionApproved === next.retentionApproved) return;
  if (!can(user, "screenshots:delete")) throw new ForbiddenException("Only a Super Admin can change retention settings");
}
