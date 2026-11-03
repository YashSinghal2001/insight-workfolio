import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from "@nestjs/common";
import {
  teamCreateSchema,
  teamLabelSchema,
  teamMembersSchema,
  teamProductivityQuerySchema,
  teamUpdateSchema,
  type TeamCreateInput,
  type TeamLabelInput,
  type TeamMembersInput,
  type TeamProductivityQuery,
  type TeamUpdateInput,
} from "@workfolio/shared";
import { CurrentUser, RequirePermission, TeamScoped } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { TeamsService } from "./teams.service.js";

const Id = () => Param("id", new ParseUUIDPipe({ version: "4" }));

/** Teams (W40): admins manage teams, heads and members. Teams are deactivated, never deleted. */
@Controller({ path: "teams", version: "1" })
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Get()
  @RequirePermission("teams:manage")
  list() {
    return this.teams.list();
  }

  /** F05 per team. Admins: every active team. Team heads: the active teams they head. */
  @Get("productivity")
  @RequirePermission("activity:read-all")
  @TeamScoped()
  productivity(@CurrentUser() user: AuthContext, @Query(new ZodPipe(teamProductivityQuerySchema)) q: TeamProductivityQuery) {
    return this.teams.productivity(user, q);
  }

  @Post()
  @RequirePermission("teams:manage")
  create(@CurrentUser() user: AuthContext, @Body(new ZodPipe(teamCreateSchema)) body: TeamCreateInput) {
    return this.teams.create(user, body);
  }

  @Patch(":id")
  @RequirePermission("teams:manage")
  update(@CurrentUser() user: AuthContext, @Id() id: string, @Body(new ZodPipe(teamUpdateSchema)) body: TeamUpdateInput) {
    return this.teams.update(user, id, body);
  }

  /** F05 per team: application labels that override the organisation's for this team's members. */
  @Get(":id/labels")
  @RequirePermission("teams:manage")
  labels(@Id() id: string) {
    return this.teams.labels(id);
  }

  @Put(":id/labels")
  @RequirePermission("teams:manage")
  setLabel(@CurrentUser() user: AuthContext, @Id() id: string, @Body(new ZodPipe(teamLabelSchema)) body: TeamLabelInput) {
    return this.teams.setLabel(user, id, body);
  }

  @Delete(":id/labels/:labelId")
  @RequirePermission("teams:manage")
  removeLabel(@CurrentUser() user: AuthContext, @Id() id: string, @Param("labelId", new ParseUUIDPipe({ version: "4" })) labelId: string) {
    return this.teams.removeLabel(user, id, labelId);
  }

  @Put(":id/members")
  @RequirePermission("teams:manage")
  setMembers(@CurrentUser() user: AuthContext, @Id() id: string, @Body(new ZodPipe(teamMembersSchema)) body: TeamMembersInput) {
    return this.teams.setMembers(user, id, body.employeeIds);
  }
}
