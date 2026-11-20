import { Controller, Get, Param, ParseUUIDPipe, Query } from "@nestjs/common";
import { employeeAnalyticsQuerySchema, type EmployeeAnalyticsQuery } from "@workfolio/shared";
import { CurrentUser, RequirePermission, TeamScoped } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { EmployeeAnalyticsService } from "./analytics.service.js";

@Controller({ path: "employees", version: "1" })
export class EmployeeAnalyticsController {
  constructor(private readonly analytics: EmployeeAnalyticsService) {}

  /** Personal statistics for local dates [from, to] (≤ 92 days; default the last 14). Admins: anyone; team heads: their members; else 404. */
  @Get(":id/analytics")
  @RequirePermission("attendance:read-all")
  @TeamScoped()
  get(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Query(new ZodPipe(employeeAnalyticsQuerySchema)) q: EmployeeAnalyticsQuery,
    @CurrentUser() user: AuthContext,
  ) {
    return this.analytics.forEmployee(user, id, q);
  }
}
