import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Put, Query } from "@nestjs/common";
import { autoClockOutHistoryQuerySchema, shiftInputSchema, shiftListQuerySchema, type AutoClockOutHistoryQuery, type ShiftInput, type ShiftListQuery } from "@workfolio/shared";
import { CurrentUser, RequirePermission, TeamScoped } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { ShiftsService } from "./shifts.service.js";

const Id = () => Param("id", new ParseUUIDPipe({ version: "4" }));

/** One employee's shift. Read: their own, or one the caller may read (else 404). Change: admins only. */
@Controller({ path: "employees", version: "1" })
export class EmployeeShiftController {
  constructor(private readonly shifts: ShiftsService) {}

  @Get(":id/shift")
  @RequirePermission("profile:read-own")
  get(@Id() id: string, @CurrentUser() user: AuthContext) {
    return this.shifts.get(user, id);
  }

  @Put(":id/shift")
  @RequirePermission("employees:manage")
  put(@Id() id: string, @Body(new ZodPipe(shiftInputSchema)) body: ShiftInput, @CurrentUser() user: AuthContext) {
    return this.shifts.put(user, id, body);
  }

  @Delete(":id/shift")
  @RequirePermission("employees:manage")
  remove(@Id() id: string, @CurrentUser() user: AuthContext) {
    return this.shifts.remove(user, id);
  }
}

/** Shift overview with live status. Admins: everyone; team heads: their teams (W41). */
@Controller({ path: "attendance", version: "1" })
export class ShiftOverviewController {
  constructor(private readonly shifts: ShiftsService) {}

  @Get("shifts")
  @RequirePermission("attendance:read-all")
  @TeamScoped()
  list(@Query(new ZodPipe(shiftListQuerySchema)) q: ShiftListQuery, @CurrentUser() user: AuthContext) {
    return this.shifts.list(user, q);
  }

  @Get("auto-clock-outs")
  @RequirePermission("attendance:read-all")
  @TeamScoped()
  history(@Query(new ZodPipe(autoClockOutHistoryQuerySchema)) q: AutoClockOutHistoryQuery, @CurrentUser() user: AuthContext) {
    return this.shifts.history(user, q);
  }
}
