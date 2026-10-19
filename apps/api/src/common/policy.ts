import { ConfigService } from "@nestjs/config";
import type { AttendancePolicy } from "@workfolio/shared";
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
