import { Body, Controller, Get, Headers, HttpCode, Post, Query, Res, StreamableFile } from "@nestjs/common";
import {
  attendanceSummaryQuerySchema,
  attendanceTimelineQuerySchema,
  DEVICE_HEADER,
  IDEMPOTENCY_HEADER,
  dateRangeSchema,
  employeeFilterSchema,
  historyQuerySchema,
  listEmployeesQuerySchema,
  syncRequestSchema,
  EXPORT_CONTENT_TYPES,
  EXPORT_FORMATS,
  orgTimesheetFilename,
  timesheetFilename,
  type AttendanceEventType,
  type AttendanceTimelineQuery,
  type ListEmployeesQuery,
  type SyncRequest,
} from "@workfolio/shared";
import type { Response } from "express";
import { z } from "zod";
import { CurrentUser, RequirePermission, TeamScoped } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { DevicesService } from "../devices/devices.service.js";
import { EmployeesService } from "../employees/employees.service.js";
import { AttendanceService } from "./attendance.service.js";
import { TimesheetService } from "./timesheet.service.js";

const timesheetQuerySchema = dateRangeSchema.and(employeeFilterSchema);
/** `format` defaults to csv, so existing CSV callers are unchanged. */
const exportQuerySchema = timesheetQuerySchema.and(z.object({ format: z.enum(EXPORT_FORMATS).default("csv") }));
const timesheetsQuerySchema = dateRangeSchema.and(listEmployeesQuerySchema);
const orgExportQuerySchema = dateRangeSchema.and(
  z.object({
    format: z.enum(EXPORT_FORMATS).default("csv"),
    q: z.string().trim().max(100).optional(),
    includeInactive: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  }),
);

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
    const employee = await this.employees.attendanceTarget(user, q.employeeId);
    const page = await this.attendance.history(employee, q);
    await this.employees.auditRead(user, employee, "EMPLOYEE_ATTENDANCE_VIEWED", { from: q.from ?? null, to: q.to ?? null });
    return page;
  }

  /**
   * One local day as stored (clock-in/out, breaks, active and idle periods), chronological and paginated.
   * Same target rule as history: self; team heads their teams; admins anyone; otherwise 404.
   */
  @Get("timeline")
  @RequirePermission("timesheet:read-own")
  async timeline(@CurrentUser() user: AuthContext, @Query(new ZodPipe(attendanceTimelineQuerySchema)) q: AttendanceTimelineQuery) {
    return this.attendance.timeline(user, await this.employees.attendanceTarget(user, q.employeeId), q);
  }

  /** Daily + weekly totals for local dates [from, to] (≤ 92 days) in the employee's time zone. */
  @Get("timesheet")
  @RequirePermission("timesheet:read-own")
  async timesheet(@CurrentUser() user: AuthContext, @Query(new ZodPipe(timesheetQuerySchema)) q: z.infer<typeof timesheetQuerySchema>) {
    const employee = await this.employees.attendanceTarget(user, q.employeeId);
    const sheet = await this.timesheets.forEmployee(employee, q.from, q.to);
    await this.employees.auditRead(user, employee, "EMPLOYEE_ATTENDANCE_VIEWED", { from: q.from, to: q.to });
    return sheet;
  }

  /** Draft timesheet CSV for local dates [from, to] (≤ 92 days); same target rules as the timesheet. Not stored. */
  @Get("export")
  @RequirePermission("timesheet:read-own")
  async export(
    @CurrentUser() user: AuthContext,
    @Query(new ZodPipe(exportQuerySchema)) q: z.infer<typeof exportQuerySchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const employee = await this.employees.attendanceTarget(user, q.employeeId);
    const { body, rows } = await this.timesheets.export(employee, q.from, q.to, q.format);
    await this.employees.auditRead(user, employee, "EMPLOYEE_ATTENDANCE_EXPORTED", { from: q.from, to: q.to, format: q.format });
    res.setHeader("content-type", EXPORT_CONTENT_TYPES[q.format]);
    res.setHeader("x-export-rows", String(rows)); // shift count, so the app need not parse the file
    res.setHeader("content-disposition", `attachment; filename="${timesheetFilename(employee.employeeCode, q.from, q.to, q.format)}"`);
    res.setHeader("cache-control", "no-store, private, max-age=0");
    return q.format === "xlsx" ? new StreamableFile(body as Buffer) : body;
  }

  /** Admin: per-employee totals for the range, searchable and paginated. Team heads: their teams. */
  @Get("timesheets")
  @RequirePermission("attendance:read-all")
  @TeamScoped()
  allTimesheets(@Query(new ZodPipe(timesheetsQuerySchema)) q: z.infer<typeof timesheetsQuerySchema>, @CurrentUser() user: AuthContext) {
    return this.timesheets.summary(q, user);
  }

  /**
   * Admin: one draft file for all employees (active only unless includeInactive=true; optional search),
   * same columns and 92-day cap as the per-employee export. Not stored.
   */
  @Get("timesheets/export")
  @RequirePermission("attendance:read-all")
  @TeamScoped()
  async exportAll(
    @Query(new ZodPipe(orgExportQuerySchema)) q: z.infer<typeof orgExportQuerySchema>,
    @Res({ passthrough: true }) res: Response,
    @CurrentUser() user: AuthContext,
  ) {
    const { body, rows } = await this.timesheets.exportAll(q.from, q.to, q.format, { q: q.q || undefined, includeInactive: q.includeInactive, caller: user });
    res.setHeader("content-type", EXPORT_CONTENT_TYPES[q.format]);
    res.setHeader("x-export-rows", String(rows));
    res.setHeader("content-disposition", `attachment; filename="${orgTimesheetFilename(q.from, q.to, q.format)}"`);
    res.setHeader("cache-control", "no-store, private, max-age=0");
    return q.format === "xlsx" ? new StreamableFile(body as Buffer) : body;
  }

  /** Admin: organisation-wide counts for one local date (default: each employee's today). Team heads: their teams. */
  @Get("summary")
  @RequirePermission("attendance:read-all")
  @TeamScoped()
  summary(@Query(new ZodPipe(attendanceSummaryQuerySchema)) q: z.infer<typeof attendanceSummaryQuerySchema>, @CurrentUser() user: AuthContext) {
    return this.attendance.summary(q.date, Date.now(), user);
  }

  @Get("overview")
  @RequirePermission("attendance:read-all")
  @TeamScoped()
  overview(@Query(new ZodPipe(listEmployeesQuerySchema)) q: ListEmployeesQuery, @CurrentUser() user: AuthContext) {
    return this.attendance.overview(q, user);
  }

  private async act(user: AuthContext, installationId: string | undefined, key: string | undefined, type: AttendanceEventType) {
    return this.attendance.act(await this.devices.require(user, installationId), type, key);
  }
}
