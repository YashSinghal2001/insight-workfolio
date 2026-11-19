import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { listNotificationsQuerySchema } from "@workfolio/shared";
import type { z } from "zod";
import { CurrentUser, RequirePermission } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { NotificationsService } from "./notifications.service.js";

/** Admin-only view of the notification log and the email service (docs/notifications.md). Recipients are never set here. */
@Controller({ path: "notifications", version: "1" })
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

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
}
