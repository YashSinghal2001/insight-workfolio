import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import {
  activityAppHistoryQuerySchema,
  activityAppsQuerySchema,
  activityOverviewQuerySchema,
  activityQuerySchema,
  activitySyncSchema,
  applicationCategorySchema,
  applicationCategoryUpdateSchema,
  consentSchema,
  DEVICE_HEADER,
  employeeFilterSchema,
  retentionRunSchema,
  riskUsersQuerySchema,
  type ActivityAppHistoryQuery,
  type ActivityAppsQuery,
  type ActivityOverviewQuery,
  type ActivityOverviewResponse,
  type ActivityQuery,
  type ActivitySyncRequest,
  type ApplicationCategoryInput,
  type RiskUsersQuery,
} from "@workfolio/shared";
import { CurrentUser, RequirePermission, TeamScoped } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { DevicesService } from "../devices/devices.service.js";
import { EmployeesService } from "../employees/employees.service.js";
import { ActivityAppsService } from "./activity-apps.service.js";
import { ActivityService } from "./activity.service.js";
import { ActivityCategoriesService } from "./categories.service.js";
import { RetentionService } from "./retention.service.js";
import { RiskUsersService } from "./risk-users.service.js";

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
    private readonly categories: ActivityCategoriesService,
    private readonly appsUsage: ActivityAppsService,
    private readonly riskUsers: RiskUsersService,
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
  @RequirePermission("screenshots:delete")
  retentionRun(@CurrentUser() user: AuthContext, @Body(new ZodPipe(retentionRunSchema)) _body: { confirm: true }) {
    return this.retention.run(user);
  }

  /** Application productivity labels (current rules). Applied when summaries are read. */
  @Get("categories")
  @RequirePermission("settings:manage")
  categoryRules() {
    return this.categories.rules();
  }

  @Post("categories")
  @RequirePermission("settings:manage")
  addCategoryRule(@CurrentUser() user: AuthContext, @Body(new ZodPipe(applicationCategorySchema)) body: ApplicationCategoryInput) {
    return this.categories.add(user, body);
  }

  @Patch("categories/:id")
  @RequirePermission("settings:manage")
  updateCategoryRule(@CurrentUser() user: AuthContext, @Param("id", new ParseUUIDPipe({ version: "4" })) id: string, @Body(new ZodPipe(applicationCategoryUpdateSchema)) body: Pick<ApplicationCategoryInput, "category">) {
    return this.categories.update(user, id, body.category);
  }

  /** Ends the rule (kept for history); the application becomes Unclassified again. */
  @Delete("categories/:id")
  @RequirePermission("settings:manage")
  removeCategoryRule(@CurrentUser() user: AuthContext, @Param("id", new ParseUUIDPipe({ version: "4" })) id: string) {
    return this.categories.remove(user, id);
  }

  @Get("summary")
  @RequirePermission("activity:read-own")
  async summary(@CurrentUser() user: AuthContext, @Query(new ZodPipe(activityQuerySchema)) q: ActivityQuery) {
    const employee = await this.target(user, q.employeeId);
    const summary = await this.activity.summary(employee, q.from, q.to);
    await this.employees.auditRead(user, employee, "EMPLOYEE_ACTIVITY_SUMMARY_VIEWED", { from: q.from, to: q.to });
    return summary;
  }

  @Get("timeline")
  @RequirePermission("activity:read-own")
  async timeline(@CurrentUser() user: AuthContext, @Query(new ZodPipe(activityQuerySchema)) q: ActivityQuery) {
    return this.activity.timeline(await this.target(user, q.employeeId), q, user);
  }

  /** Admin: per-employee range totals (each in the employee's own time zone), searchable and paginated; ≤ 31 days. */
  @Get("overview")
  @RequirePermission("activity:read-all")
  @TeamScoped()
  async overview(@Query(new ZodPipe(activityOverviewQuerySchema)) q: ActivityOverviewQuery, @CurrentUser() user: AuthContext): Promise<ActivityOverviewResponse> {
    const page = await this.employees.list(q, user, "activity:read-all");
    const refs = page.items.map((e) => ({ id: e.id, fullName: e.fullName, employeeCode: e.employeeCode, timezone: e.timezone }));
    const { items, categoriesConfigured } = await this.activity.overview(refs, q.from, q.to);
    return { ...page, items, from: q.from, to: q.to, categoriesConfigured };
  }

  /** Admin / team head: app usage of the scope (optionally one team): per app, per label, per employee; ≤ 31 days. */
  @Get("apps")
  @RequirePermission("activity:read-all")
  @TeamScoped()
  apps(@CurrentUser() user: AuthContext, @Query(new ZodPipe(activityAppsQuerySchema)) q: ActivityAppsQuery) {
    return this.appsUsage.apps(user, q);
  }

  /** One application's usage per local day and employee; audited per employee shown (as /activity/summary). */
  @Get("apps/history")
  @RequirePermission("activity:read-all")
  @TeamScoped()
  appHistory(@CurrentUser() user: AuthContext, @Query(new ZodPipe(activityAppHistoryQuerySchema)) q: ActivityAppHistoryQuery) {
    return this.appsUsage.history(user, q);
  }

  /** Computed risk users: alert rows grouped by rule kind + less working hours; ≤ 92 days. */
  @Get("risk-users")
  @RequirePermission("activity:read-all")
  @TeamScoped()
  risk(@CurrentUser() user: AuthContext, @Query(new ZodPipe(riskUsersQuerySchema)) q: RiskUsersQuery) {
    return this.riskUsers.list(user, q);
  }

  private target(user: AuthContext, employeeId?: string) {
    return this.employees.attendanceTarget(user, employeeId, "activity:read-all");
  }
}
