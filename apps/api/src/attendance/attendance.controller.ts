import { Body, Controller, Get, Headers, HttpCode, Post, Query } from "@nestjs/common";
import {
  DEVICE_HEADER,
  IDEMPOTENCY_HEADER,
  dateRangeSchema,
  employeeFilterSchema,
  historyQuerySchema,
  listEmployeesQuerySchema,
  syncRequestSchema,
  type AttendanceEventType,
  type ListEmployeesQuery,
  type SyncRequest,
} from "@workfolio/shared";
import type { z } from "zod";
import { CurrentUser, RequirePermission } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { DevicesService } from "../devices/devices.service.js";
import { EmployeesService } from "../employees/employees.service.js";
import { AttendanceService } from "./attendance.service.js";
import { TimesheetService } from "./timesheet.service.js";

const timesheetQuerySchema = dateRangeSchema.and(employeeFilterSchema);
const timesheetsQuerySchema = dateRangeSchema.and(listEmployeesQuerySchema);

/**
 * Writes act on the caller's own attendance only (no employee ID accepted). Reads default to the
 * caller; `employeeId` is honoured for admins and otherwise only for the caller's own ID (else 404).
 * Writes also require the caller's active registered device (X-Device-Id) and an
 * Idempotency-Key (direct endpoints) or per-event ids (sync).
 */
@Controller({ path: "attendance", version: "1" })
export class AttendanceController {
  constructor(
    private readonly attendance: AttendanceService,
    private readonly devices: DevicesService,
    private readonly employees: EmployeesService,
    private readonly timesheets: TimesheetService,
  ) {}

  @Post("clock-in")
  @HttpCode(200)
  @RequirePermission("timesheet:clock")
  clockIn(@CurrentUser() u: AuthContext, @Headers(DEVICE_HEADER) d?: string, @Headers(IDEMPOTENCY_HEADER) k?: string) {
    return this.act(u, d, k, "CLOCK_IN");
  }

  @Post("clock-out")
  @HttpCode(200)
  @RequirePermission("timesheet:clock")
  clockOut(@CurrentUser() u: AuthContext, @Headers(DEVICE_HEADER) d?: string, @Headers(IDEMPOTENCY_HEADER) k?: string) {
    return this.act(u, d, k, "CLOCK_OUT");
  }

  @Post("break/start")
  @HttpCode(200)
  @RequirePermission("timesheet:clock")
  breakStart(@CurrentUser() u: AuthContext, @Headers(DEVICE_HEADER) d?: string, @Headers(IDEMPOTENCY_HEADER) k?: string) {
    return this.act(u, d, k, "BREAK_START");
  }

  @Post("break/end")
  @HttpCode(200)
  @RequirePermission("timesheet:clock")
  breakEnd(@CurrentUser() u: AuthContext, @Headers(DEVICE_HEADER) d?: string, @Headers(IDEMPOTENCY_HEADER) k?: string) {
    return this.act(u, d, k, "BREAK_END");
  }

  @Post("sync")
  @HttpCode(200)
  @RequirePermission("timesheet:clock")
  async sync(
    @CurrentUser() user: AuthContext,
    @Body(new ZodPipe(syncRequestSchema)) body: SyncRequest,
    @Headers(DEVICE_HEADER) installationId?: string,
  ) {
    return this.attendance.sync(await this.devices.require(user, installationId), body);
  }

  @Get("current")
  @RequirePermission("timesheet:read-own")
  async current(@CurrentUser() user: AuthContext) {
    return this.attendance.current(await this.devices.employeeIdFor(user));
  }

  @Get("history")
  @RequirePermission("timesheet:read-own")
  async history(@CurrentUser() user: AuthContext, @Query(new ZodPipe(historyQuerySchema)) q: z.infer<typeof historyQuerySchema>) {
    return this.attendance.history(await this.employees.attendanceTarget(user, q.employeeId), q);
  }

  /** Daily + weekly totals for local dates [from, to] (≤ 92 days) in the employee's time zone. */
  @Get("timesheet")
  @RequirePermission("timesheet:read-own")
  async timesheet(@CurrentUser() user: AuthContext, @Query(new ZodPipe(timesheetQuerySchema)) q: z.infer<typeof timesheetQuerySchema>) {
    return this.timesheets.forEmployee(await this.employees.attendanceTarget(user, q.employeeId), q.from, q.to);
  }

  /** Admin: per-employee totals for the range, searchable and paginated. */
  @Get("timesheets")
  @RequirePermission("attendance:read-all")
  allTimesheets(@Query(new ZodPipe(timesheetsQuerySchema)) q: z.infer<typeof timesheetsQuerySchema>) {
    return this.timesheets.summary(q);
  }

  @Get("overview")
  @RequirePermission("attendance:read-all")
  overview(@Query(new ZodPipe(listEmployeesQuerySchema)) q: ListEmployeesQuery) {
    return this.attendance.overview(q);
  }

  private async act(user: AuthContext, installationId: string | undefined, key: string | undefined, type: AttendanceEventType) {
    return this.attendance.act(await this.devices.require(user, installationId), type, key);
  }
}
