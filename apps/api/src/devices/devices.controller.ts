import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { DEVICE_HEADER, registerDeviceSchema, type RegisterDeviceInput } from "@workfolio/shared";
import { CurrentUser, RequirePermission } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { DevicesService } from "./devices.service.js";

/** Employees manage only their own device (resolved from the session, never from a parameter). */
@Controller({ path: "devices", version: "1" })
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Post("register")
  @RequirePermission("timesheet:clock")
  register(@CurrentUser() user: AuthContext, @Body(new ZodPipe(registerDeviceSchema)) body: RegisterDeviceInput) {
    return this.devices.register(user, body);
  }

  /** Status of the calling installation (X-Device-Id header). Also records last-seen. */
  @Get("me")
  @RequirePermission("timesheet:read-own")
  me(@CurrentUser() user: AuthContext, @Headers(DEVICE_HEADER) installationId?: string) {
    return this.devices.status(user, installationId);
  }

  @Post(":id/revoke")
  @HttpCode(200)
  @RequirePermission("devices:manage")
  revoke(@CurrentUser() admin: AuthContext, @Param("id", new ParseUUIDPipe({ version: "4" })) id: string) {
    return this.devices.revoke(admin, id);
  }
}
