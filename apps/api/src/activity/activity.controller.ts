import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import {
  activityOverviewQuerySchema,
  activityQuerySchema,
  activitySyncSchema,
  applicationCategorySchema,
  applicationCategoryUpdateSchema,
  consentSchema,
  DEVICE_HEADER,
  employeeFilterSchema,
  retentionRunSchema,
  type ActivityOverviewQuery,
  type ActivityOverviewResponse,
  type ActivityQuery,
  type ActivitySyncRequest,
  type ApplicationCategoryInput,
} from "@workfolio/shared";
import { CurrentUser, RequirePermission, TeamScoped } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { DevicesService } from "../devices/devices.service.js";
import { EmployeesService } from "../employees/employees.service.js";
import { ActivityService } from "./activity.service.js";
import { ActivityCategoriesService } from "./categories.service.js";
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
    private readonly categories: ActivityCategoriesService,
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
    return this.activity.summary(await this.target(user, q.employeeId), q.from, q.to);
  }

  @Get("timeline")
  @RequirePermission("activity:read-own")
  async timeline(@CurrentUser() user: AuthContext, @Query(new ZodPipe(activityQuerySchema)) q: ActivityQuery) {
    return this.activity.timeline(await this.target(user, q.employeeId), q);
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

  private target(user: AuthContext, employeeId?: string) {
    return this.employees.attendanceTarget(user, employeeId, "activity:read-all");
  }
}
