import { Body, Controller, Get, Headers, HttpCode, Post, Query } from "@nestjs/common";
import {
  activityQuerySchema,
  activitySyncSchema,
  consentSchema,
  DEVICE_HEADER,
  employeeFilterSchema,
  retentionRunSchema,
  type ActivityQuery,
  type ActivitySyncRequest,
} from "@workfolio/shared";
import { CurrentUser, RequirePermission } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { DevicesService } from "../devices/devices.service.js";
import { EmployeesService } from "../employees/employees.service.js";
import { ActivityService } from "./activity.service.js";
import { RetentionService } from "./retention.service.js";

/**
 * Writes come only from the caller's own active device. Reads default to the caller;
 * `employeeId` is honoured for admins (activity:read-all) and otherwise only for the caller's own ID.
 */
@Controller({ path: "activity", version: "1" })
export class ActivityController {
  constructor(
    private readonly activity: ActivityService,
    private readonly devices: DevicesService,
    private readonly employees: EmployeesService,
    private readonly retention: RetentionService,
  ) {}

  @Post("sync")
  @HttpCode(200)
  @RequirePermission("activity:record")
  async sync(
    @CurrentUser() user: AuthContext,
    @Body(new ZodPipe(activitySyncSchema)) body: ActivitySyncRequest,
    @Headers(DEVICE_HEADER) installationId?: string,
  ) {
    return this.activity.sync(await this.devices.require(user, installationId), body);
  }

  /** Policy, consent state and the caller's synced totals (today and current session). */
  @Get("me")
  @RequirePermission("activity:read-own")
  async me(@CurrentUser() user: AuthContext) {
    return this.activity.status(await this.employees.attendanceTarget(user));
  }

  @Post("consent")
  @HttpCode(200)
  @RequirePermission("activity:record")
  async consent(@CurrentUser() user: AuthContext, @Body(new ZodPipe(consentSchema)) body: { noticeVersion: string }) {
    return this.activity.consent(await this.employees.attendanceTarget(user), body.noticeVersion);
  }

  /** Acknowledgement history (never edited or deleted). */
  @Get("consents")
  @RequirePermission("activity:read-own")
  async consents(@CurrentUser() user: AuthContext, @Query(new ZodPipe(employeeFilterSchema)) q: { employeeId?: string }) {
    return this.activity.consents(await this.target(user, q.employeeId));
  }

  /** Dry run: what the retention purge would delete now. Deletes nothing. */
  @Get("retention")
  @RequirePermission("settings:manage")
  retentionPreview() {
    return this.retention.preview();
  }

  /** Purges expired activity. Refused (409) until retention is approved in the settings. */
  @Post("retention/run")
  @HttpCode(200)
  @RequirePermission("settings:manage")
  retentionRun(@CurrentUser() user: AuthContext, @Body(new ZodPipe(retentionRunSchema)) _body: { confirm: true }) {
    return this.retention.run(user);
  }

  @Get("summary")
  @RequirePermission("activity:read-own")
  async summary(@CurrentUser() user: AuthContext, @Query(new ZodPipe(activityQuerySchema)) q: ActivityQuery) {
    return this.activity.summary(await this.target(user, q.employeeId), q.from, q.to);
  }

  @Get("timeline")
  @RequirePermission("activity:read-own")
  async timeline(@CurrentUser() user: AuthContext, @Query(new ZodPipe(activityQuerySchema)) q: ActivityQuery) {
    return this.activity.timeline(await this.target(user, q.employeeId), q);
  }

  private target(user: AuthContext, employeeId?: string) {
    return this.employees.attendanceTarget(user, employeeId, "activity:read-all");
  }
}
