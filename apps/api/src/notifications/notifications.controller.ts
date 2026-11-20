import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from "@nestjs/common";
import { createNotificationRuleSchema, listNotificationsQuerySchema, notificationRuleRecipientsSchema, updateNotificationRuleSchema } from "@workfolio/shared";
import type { z } from "zod";
import { CurrentUser, RequirePermission } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { NotificationRulesService } from "./notification-rules.service.js";
import { NotificationsService } from "./notifications.service.js";

/** Admin-only view of the notification log and the email service (docs/notifications.md). Recipients are never set here. */
@Controller({ path: "notifications", version: "1" })
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly rules: NotificationRulesService,
  ) {}

  @Get()
  @RequirePermission("settings:manage")
  overview(@Query(new ZodPipe(listNotificationsQuerySchema)) q: z.infer<typeof listNotificationsQuerySchema>) {
    return this.notifications.overview(q.show);
  }

  @Post("deliveries/:id/retry")
  @HttpCode(204)
  @RequirePermission("settings:manage")
  async retry(@CurrentUser() user: AuthContext, @Param("id", new ParseUUIDPipe({ version: "4" })) id: string) {
    await this.notifications.retry(id, user.id);
  }

  // ---- Attendance notification rules (docs/notifications.md §9). Recipients are accounts, validated by the server.

  @Get("rules")
  @RequirePermission("settings:manage")
  listRules(@CurrentUser() user: AuthContext) {
    return this.rules.list(user);
  }

  @Post("rules")
  @RequirePermission("settings:manage")
  createRule(@CurrentUser() user: AuthContext, @Body(new ZodPipe(createNotificationRuleSchema)) body: z.infer<typeof createNotificationRuleSchema>) {
    return this.rules.create(user, body);
  }

  @Patch("rules/:id")
  @RequirePermission("settings:manage")
  updateRule(@CurrentUser() user: AuthContext, @Param("id", new ParseUUIDPipe({ version: "4" })) id: string, @Body(new ZodPipe(updateNotificationRuleSchema)) body: z.infer<typeof updateNotificationRuleSchema>) {
    return this.rules.update(user, id, body);
  }

  @Put("rules/:id/recipients")
  @RequirePermission("settings:manage")
  setRecipients(@CurrentUser() user: AuthContext, @Param("id", new ParseUUIDPipe({ version: "4" })) id: string, @Body(new ZodPipe(notificationRuleRecipientsSchema)) body: z.infer<typeof notificationRuleRecipientsSchema>) {
    return this.rules.setRecipients(user, id, body.userIds);
  }
}
