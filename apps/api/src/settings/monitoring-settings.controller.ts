import { Body, Controller, Get, Post, Put } from "@nestjs/common";
import { monitoringSettingsSchema, noticeSchema, type MonitoringSettingsInput, type NoticeInput } from "@workfolio/shared";
import { CurrentUser, RequirePermission } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { MonitoringSettingsService } from "./monitoring-settings.service.js";

/** Admin-only. Changes are append-only (who, when, why) and take effect for every desktop on its next refresh. */
@Controller({ path: "settings/monitoring", version: "1" })
export class MonitoringSettingsController {
  constructor(private readonly settings: MonitoringSettingsService) {}

  @Get()
  @RequirePermission("settings:manage")
  overview() {
    return this.settings.overview();
  }

  @Put()
  @RequirePermission("settings:manage")
  update(@CurrentUser() user: AuthContext, @Body(new ZodPipe(monitoringSettingsSchema)) body: MonitoringSettingsInput) {
    return this.settings.update(user, body);
  }

  @Post("notices")
  @RequirePermission("settings:manage")
  publishNotice(@CurrentUser() user: AuthContext, @Body(new ZodPipe(noticeSchema)) body: NoticeInput) {
    return this.settings.publishNotice(user, body);
  }
}
