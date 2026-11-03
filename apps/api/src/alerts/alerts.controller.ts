import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { createAlertRuleSchema, listAlertsQuerySchema, updateAlertRuleSchema, type AlertRuleInput, type AlertRuleUpdate } from "@workfolio/shared";
import type { z } from "zod";
import { CurrentUser, RequirePermission } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { AlertsService } from "./alerts.service.js";

const Id = () => Param("id", new ParseUUIDPipe({ version: "4" }));

/** Admin-only alert rules and the alerts they raise (F06, in-app only). */
@Controller({ path: "alerts", version: "1" })
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  @RequirePermission("alerts:manage")
  list(@Query(new ZodPipe(listAlertsQuerySchema)) q: z.infer<typeof listAlertsQuerySchema>) {
    return this.alerts.alerts(q.status);
  }

  @Post(":id/acknowledge")
  @HttpCode(204)
  @RequirePermission("alerts:manage")
  async acknowledge(@CurrentUser() user: AuthContext, @Id() id: string) {
    await this.alerts.acknowledge(user, id);
  }

  @Get("rules")
  @RequirePermission("alerts:manage")
  rules() {
    return this.alerts.rules();
  }

  @Post("rules")
  @RequirePermission("alerts:manage")
  create(@CurrentUser() user: AuthContext, @Body(new ZodPipe(createAlertRuleSchema)) body: AlertRuleInput) {
    return this.alerts.create(user, body);
  }

  @Patch("rules/:id")
  @RequirePermission("alerts:manage")
  update(@CurrentUser() user: AuthContext, @Id() id: string, @Body(new ZodPipe(updateAlertRuleSchema)) body: AlertRuleUpdate) {
    return this.alerts.update(user, id, body);
  }

  @Delete("rules/:id")
  @HttpCode(204)
  @RequirePermission("alerts:manage")
  async remove(@CurrentUser() user: AuthContext, @Id() id: string) {
    await this.alerts.remove(user, id);
  }
}
