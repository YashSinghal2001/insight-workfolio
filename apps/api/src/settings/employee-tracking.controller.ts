import { randomUUID } from "node:crypto";
import { Body, Controller, Get, Inject, Injectable, Logger, NotFoundException, Param, ParseUUIDPipe, Put } from "@nestjs/common";
import type { DatabaseClient } from "@workfolio/database";
import {
  effectiveIdleThreshold,
  employeeTrackingOverrideSchema,
  withScheduleOverride,
  type AuthUser,
  type EmployeeTrackingOverrideInput,
  type EmployeeTrackingOverridesResponse,
} from "@workfolio/shared";
import { CurrentUser, RequirePermission } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { DATABASE } from "../database/database.module.js";
import { ScheduleService } from "../schedule/schedule.service.js";
import { ScreenshotSettingsService } from "../screenshots/screenshot-settings.service.js";
import { MonitoringSettingsService } from "./monitoring-settings.service.js";

/**
 * Per-employee overrides (W17 start time / workdays, W21 idle threshold, F08 own-screenshot access). Append-only: every change
 * is a new full version (who, when, why); null fields inherit the organisation setting. The schedule
 * override applies from the employee's next local day (like the organisation schedule); the idle
 * threshold reaches the desktop on its next policy refresh.
 */
@Injectable()
export class EmployeeTrackingService {
  private readonly logger = new Logger(EmployeeTrackingService.name);

  constructor(
    @Inject(DATABASE) private readonly db: DatabaseClient,
    private readonly schedule: ScheduleService,
    private readonly monitoring: MonitoringSettingsService,
    private readonly screenshots: ScreenshotSettingsService,
  ) {}

  async overview(employeeId: string): Promise<EmployeeTrackingOverridesResponse> {
    const [{ rows: emp }, { rows }, sched, mon, shots] = await Promise.all([
      this.db.execute({ sql: "SELECT id FROM employee_profiles WHERE id = ?", args: [employeeId] }),
      this.db.execute({
        sql: `SELECT o.expected_start, o.workdays, o.idle_threshold_seconds, o.screenshot_self_view, o.reason, o.effective_at, u.id AS user_id, u.email AS user_email
              FROM employee_tracking_overrides o JOIN users u ON u.id = o.changed_by
              WHERE o.employee_id = ? ORDER BY o.effective_at DESC, o.rowid DESC LIMIT 100`,
        args: [employeeId],
      }),
      this.schedule.overview(),
      this.monitoring.current(),
      this.screenshots.current(),
    ]);
    if (!emp[0]) throw new NotFoundException("Employee not found");
    const history = rows.map((r) => ({
      expectedStart: r.expected_start === null ? null : String(r.expected_start),
      workdays: r.workdays === null ? null : String(r.workdays),
      idleThresholdSeconds: r.idle_threshold_seconds === null ? null : Number(r.idle_threshold_seconds),
      screenshotSelfView: r.screenshot_self_view === null ? null : Boolean(r.screenshot_self_view),
      reason: String(r.reason),
      changedBy: { id: String(r.user_id), email: String(r.user_email) },
      effectiveAt: String(r.effective_at),
    }));
    const h = history[0];
    const override = { expectedStart: h?.expectedStart ?? null, workdays: h?.workdays ?? null, idleThresholdSeconds: h?.idleThresholdSeconds ?? null, screenshotSelfView: h?.screenshotSelfView ?? null };
    const { enabled, expectedStart, graceMinutes, workdays } = sched.current;
    const orgSchedule = { enabled, expectedStart, graceMinutes, workdays };
    return {
      employeeId,
      override,
      organisation: { schedule: orgSchedule, idleThresholdSeconds: mon.idleThresholdSeconds, sampleSeconds: mon.sampleSeconds, screenshotSelfView: shots.employeeSelfView },
      effective: {
        schedule: withScheduleOverride(orgSchedule, override),
        idleThresholdSeconds: effectiveIdleThreshold(mon, override.idleThresholdSeconds),
        screenshotSelfView: override.screenshotSelfView ?? shots.employeeSelfView,
      },
      history,
    };
  }

  async set(admin: AuthUser, employeeId: string, input: EmployeeTrackingOverrideInput): Promise<EmployeeTrackingOverridesResponse> {
    const { rows } = await this.db.execute({ sql: "SELECT id FROM employee_profiles WHERE id = ?", args: [employeeId] });
    if (!rows[0]) throw new NotFoundException("Employee not found");
    // Omitted by older clients: the current self-view override carries over (each version is the full set).
    const screenshotSelfView = input.screenshotSelfView !== undefined ? input.screenshotSelfView : await this.monitoring.screenshotSelfView(employeeId);
    await this.db.execute({
      sql: `INSERT INTO employee_tracking_overrides (id, employee_id, expected_start, workdays, idle_threshold_seconds, screenshot_self_view, reason, changed_by, effective_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      args: [randomUUID(), employeeId, input.expectedStart, input.workdays, input.idleThresholdSeconds, screenshotSelfView === null ? null : screenshotSelfView ? 1 : 0, input.reason, admin.id],
    });
    const { expectedStart, workdays, idleThresholdSeconds } = input;
    this.logger.log({ adminId: admin.id, employeeId, expectedStart, workdays, idleThresholdSeconds, screenshotSelfView }, "Employee tracking override changed");
    return this.overview(employeeId);
  }
}

/** Admin-only. One employee's schedule start / workdays, idle threshold and screenshot self-view overrides. */
@Controller({ path: "settings/employees/:employeeId/tracking", version: "1" })
export class EmployeeTrackingController {
  constructor(private readonly tracking: EmployeeTrackingService) {}

  @Get()
  @RequirePermission("settings:manage")
  overview(@Param("employeeId", new ParseUUIDPipe()) employeeId: string) {
    return this.tracking.overview(employeeId);
  }

  @Put()
  @RequirePermission("settings:manage")
  update(
    @CurrentUser() user: AuthContext,
    @Param("employeeId", new ParseUUIDPipe()) employeeId: string,
    @Body(new ZodPipe(employeeTrackingOverrideSchema)) body: EmployeeTrackingOverrideInput,
  ) {
    return this.tracking.set(user, employeeId, body);
  }
}
