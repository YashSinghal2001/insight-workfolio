import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import {
  assignEmployeeSchema,
  createProjectSchema,
  createTaskSchema,
  dateRangeSchema,
  employeeFilterSchema,
  startTimerSchema,
  updateProjectSchema,
  updateTaskSchema,
} from "@workfolio/shared";
import type { z } from "zod";
import { CurrentUser, RequirePermission } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { ProjectsService } from "./projects.service.js";

const Id = (name = "id") => Param(name, new ParseUUIDPipe({ version: "4" }));
const rangeQuery = dateRangeSchema.and(employeeFilterSchema);

/** Admin administration of projects, tasks and assignments, and the time summary. */
@Controller({ path: "projects", version: "1" })
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @RequirePermission("projects:manage")
  list() {
    return this.projects.list();
  }

  @Get("summary")
  @RequirePermission("projects:manage")
  summary(@Query(new ZodPipe(dateRangeSchema)) q: z.infer<typeof dateRangeSchema>) {
    return this.projects.summary(q.from, q.to);
  }

  @Post()
  @RequirePermission("projects:manage")
  create(@CurrentUser() user: AuthContext, @Body(new ZodPipe(createProjectSchema)) body: z.infer<typeof createProjectSchema>) {
    return this.projects.create(user, body);
  }

  @Patch(":id")
  @RequirePermission("projects:manage")
  update(@CurrentUser() user: AuthContext, @Id() id: string, @Body(new ZodPipe(updateProjectSchema)) body: z.infer<typeof updateProjectSchema>) {
    return this.projects.update(user, id, body);
  }

  @Get(":id/history")
  @RequirePermission("projects:manage")
  history(@Id() id: string) {
    return this.projects.history(id);
  }

  @Post(":id/members")
  @RequirePermission("projects:manage")
  assign(@CurrentUser() user: AuthContext, @Id() id: string, @Body(new ZodPipe(assignEmployeeSchema)) body: { employeeId: string }) {
    return this.projects.assign(user, id, body.employeeId);
  }

  @Delete(":id/members/:employeeId")
  @RequirePermission("projects:manage")
  unassign(@CurrentUser() user: AuthContext, @Id() id: string, @Id("employeeId") employeeId: string) {
    return this.projects.unassign(user, id, employeeId);
  }

  @Post(":id/tasks")
  @RequirePermission("projects:manage")
  createTask(@CurrentUser() user: AuthContext, @Id() id: string, @Body(new ZodPipe(createTaskSchema)) body: { title: string }) {
    return this.projects.createTask(user, id, body.title);
  }

  @Patch(":id/tasks/:taskId")
  @RequirePermission("projects:manage")
  updateTask(@CurrentUser() user: AuthContext, @Id() id: string, @Id("taskId") taskId: string, @Body(new ZodPipe(updateTaskSchema)) body: z.infer<typeof updateTaskSchema>) {
    return this.projects.updateTask(user, id, taskId, body);
  }
}

/** The signed-in employee's assignments and task timers (identity from the session only). */
@Controller({ path: "task-time", version: "1" })
export class TaskTimeController {
  constructor(private readonly projects: ProjectsService) {}

  @Get("assignments")
  @RequirePermission("tasks:track")
  assignments(@CurrentUser() user: AuthContext) {
    return this.projects.assignments(user);
  }

  @Get("current")
  @RequirePermission("tasks:track")
  current(@CurrentUser() user: AuthContext) {
    return this.projects.state(user);
  }

  @Get("entries")
  @RequirePermission("tasks:track")
  entries(@CurrentUser() user: AuthContext, @Query(new ZodPipe(rangeQuery)) q: z.infer<typeof rangeQuery>) {
    return this.projects.entries(user, q.from, q.to, q.employeeId);
  }

  @Post("start")
  @HttpCode(200)
  @RequirePermission("tasks:track")
  start(@CurrentUser() user: AuthContext, @Body(new ZodPipe(startTimerSchema)) body: { taskId: string }) {
    return this.projects.start(user, body.taskId);
  }

  @Post(":id/pause")
  @HttpCode(200)
  @RequirePermission("tasks:track")
  pause(@CurrentUser() user: AuthContext, @Id() id: string) {
    return this.projects.end(user, id, "PAUSED");
  }

  @Post(":id/stop")
  @HttpCode(200)
  @RequirePermission("tasks:track")
  stop(@CurrentUser() user: AuthContext, @Id() id: string) {
    return this.projects.end(user, id, "STOPPED");
  }
}
