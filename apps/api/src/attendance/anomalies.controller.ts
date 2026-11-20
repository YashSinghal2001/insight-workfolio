import { Controller, Get, Query } from "@nestjs/common";
import { missingClockOutsQuerySchema, type MissingClockOutsQuery } from "@workfolio/shared";
import { CurrentUser, RequirePermission, TeamScoped } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { AnomaliesService } from "./anomalies.service.js";

/** Forgotten clock-outs, stale devices, long breaks: flagged, never closed (docs/IMPLEMENTATION-CONTRACTS.md §9). */
@Controller({ path: "attendance", version: "1" })
export class AnomaliesController {
  constructor(private readonly anomalies: AnomaliesService) {}

  @Get("missing-clock-outs")
  @RequirePermission("attendance:read-all")
  @TeamScoped()
  missingClockOuts(@CurrentUser() user: AuthContext, @Query(new ZodPipe(missingClockOutsQuerySchema)) q: MissingClockOutsQuery) {
    return this.anomalies.missingClockOuts(user, q.teamId);
  }
}
