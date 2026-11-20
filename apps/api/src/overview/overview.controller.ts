import { Controller, Get, Query } from "@nestjs/common";
import { overviewQuerySchema, type OverviewQuery, type OverviewResponse } from "@workfolio/shared";
import { CurrentUser, RequirePermission, TeamScoped } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { OverviewService } from "./overview.service.js";

/** The admin Overview page in one request (docs/IMPLEMENTATION-CONTRACTS.md §11). Team heads: their teams. */
@Controller({ path: "overview", version: "1" })
export class OverviewController {
  constructor(private readonly overview: OverviewService) {}

  @Get()
  @RequirePermission("attendance:read-all")
  @TeamScoped()
  get(@CurrentUser() user: AuthContext, @Query(new ZodPipe(overviewQuerySchema)) q: OverviewQuery): Promise<OverviewResponse> {
    return this.overview.get(user, q);
  }
}
