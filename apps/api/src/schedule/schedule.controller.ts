import { Body, Controller, Get, Put, Query } from "@nestjs/common";
import {
  dailyAttendanceQuerySchema,
  dateRangeSchema,
  employeeFilterSchema,
  workScheduleSchema,
  type DailyAttendanceQuery,
  type WorkScheduleInput,
} from "@workfolio/shared";
import { z } from "zod";
import { CurrentUser, RequirePermission, TeamScoped } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { EmployeesService } from "../employees/employees.service.js";
import { ScheduleService } from "./schedule.service.js";

const expectedQuerySchema = dateRangeSchema.and(employeeFilterSchema);

/** Admin-only. Organisation-wide work schedule; every change is a new version (who, when, why). */
@Controller({ path: "settings/schedule", version: "1" })
export class ScheduleSettingsController {
  constructor(private readonly schedule: ScheduleService) {}

  @Get()
  @RequirePermission("settings:manage")
  overview() {
    return this.schedule.overview();
  }

  @Put()
  @RequirePermission("settings:manage")
  update(@CurrentUser() user: AuthContext, @Body(new ZodPipe(workScheduleSchema)) body: WorkScheduleInput) {
    return this.schedule.update(user, body);
  }
}

@Controller({ path: "attendance", version: "1" })
export class DailyAttendanceController {
  constructor(
    private readonly schedule: ScheduleService,
    private readonly employees: EmployeesService,
  ) {}

  /** Late clock-in, absence and leave per employee for one local date. Admins: everyone; team heads: their teams (W41). */
  @Get("daily")
  @RequirePermission("attendance:read-all")
  @TeamScoped()
  daily(@Query(new ZodPipe(dailyAttendanceQuerySchema)) q: DailyAttendanceQuery, @CurrentUser() user: AuthContext) {
    return this.schedule.daily(q, Date.now(), user);
  }

  /**
   * W24: the expected start per scheduled local date (≤ 92 days). Same target rules as the attendance
   * history: the caller's own by default; another employee only for readers allowed to see them (else 404).
   */
  @Get("expected")
  @RequirePermission("timesheet:read-own")
  async expected(@CurrentUser() user: AuthContext, @Query(new ZodPipe(expectedQuerySchema)) q: z.infer<typeof expectedQuerySchema>) {
    return this.schedule.expected(await this.employees.attendanceTarget(user, q.employeeId), q.from, q.to);
  }
}
