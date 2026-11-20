import { Controller, Get, Query } from "@nestjs/common";
import { teamTimelineQuerySchema, type TeamTimelineQuery, type TeamTimelineResponse } from "@workfolio/shared";
import { CurrentUser, RequirePermission, TeamScoped } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { TeamTimelineService } from "./team-timeline.service.js";

/** Admins and team heads (their teams): every employee's day as Gantt segments (Timeline page). */
@Controller({ path: "activity", version: "1" })
export class TeamTimelineController {
  constructor(private readonly timeline: TeamTimelineService) {}

  @Get("team-timeline")
  @RequirePermission("activity:read-all")
  @TeamScoped()
  teamTimeline(@CurrentUser() user: AuthContext, @Query(new ZodPipe(teamTimelineQuerySchema)) q: TeamTimelineQuery): Promise<TeamTimelineResponse> {
    return this.timeline.timeline(q, user);
  }
}
