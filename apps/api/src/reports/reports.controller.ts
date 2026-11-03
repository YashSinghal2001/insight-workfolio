import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { addRecipientSchema, createReportScheduleSchema, updateReportScheduleSchema } from "@workfolio/shared";
import { z } from "zod";
import { CurrentUser, RequirePermission } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { ReportsService } from "./reports.service.js";

const Id = (name = "id") => Param(name, new ParseUUIDPipe({ version: "4" }));
const runsQuery = z.object({ scheduleId: z.uuid().optional() });

/** Admin-only: report definitions, recipients, previews, runs and delivery records. */
@Controller({ path: "reports", version: "1" })
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get("provider")
  @RequirePermission("reports:manage")
  provider() {
    return this.reports.provider();
  }

  @Get("schedules")
  @RequirePermission("reports:manage")
  list() {
    return this.reports.list();
  }

  @Post("schedules")
  @RequirePermission("reports:manage")
  create(@CurrentUser() user: AuthContext, @Body(new ZodPipe(createReportScheduleSchema)) body: z.infer<typeof createReportScheduleSchema>) {
    return this.reports.create(user, body);
  }

  @Patch("schedules/:id")
  @RequirePermission("reports:manage")
  update(@CurrentUser() user: AuthContext, @Id() id: string, @Body(new ZodPipe(updateReportScheduleSchema)) body: z.infer<typeof updateReportScheduleSchema>) {
    return this.reports.update(user, id, body);
  }

  @Get("schedules/:id/eligible-recipients")
  @RequirePermission("reports:manage")
  eligible(@Id() id: string) {
    return this.reports.eligible(id);
  }

  @Post("schedules/:id/recipients")
  @RequirePermission("reports:manage")
  addRecipient(@CurrentUser() user: AuthContext, @Id() id: string, @Body(new ZodPipe(addRecipientSchema)) body: { userId: string }) {
    return this.reports.addRecipient(user, id, body.userId);
  }

  @Delete("schedules/:id/recipients/:userId")
  @RequirePermission("reports:manage")
  removeRecipient(@CurrentUser() user: AuthContext, @Id() id: string, @Id("userId") userId: string) {
    return this.reports.removeRecipient(user, id, userId);
  }

  @Get("schedules/:id/preview")
  @RequirePermission("reports:manage")
  preview(@Id() id: string) {
    return this.reports.preview(id);
  }

  @Post("schedules/:id/run")
  @HttpCode(200)
  @RequirePermission("reports:manage")
  run(@CurrentUser() user: AuthContext, @Id() id: string) {
    return this.reports.runNow(user, id);
  }

  @Get("runs")
  @RequirePermission("reports:manage")
  runs(@Query(new ZodPipe(runsQuery)) q: z.infer<typeof runsQuery>) {
    return this.reports.runs(q.scheduleId);
  }
}
