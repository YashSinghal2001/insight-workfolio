import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { DEVICE_HEADER, registerDeviceSchema, revokeDeviceSchema, type RegisterDeviceInput, type RevokeDeviceInput } from "@workfolio/shared";
import { CurrentUser, RequirePermission } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { DevicesService } from "./devices.service.js";

const Id = () => Param("id", new ParseUUIDPipe({ version: "4" }));

/** Employees manage only their own devices (resolved from the session, never from a parameter). */
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

  /** Sign one of your own devices out (frees the account to sign in on another). */
  @Post("mine/:id/end-session")
  @HttpCode(200)
  @RequirePermission("sessions:own")
  endOwn(@CurrentUser() user: AuthContext, @Id() id: string) {
    return this.devices.endOwnSession(user, id);
  }

  @Get()
  @RequirePermission("devices:read")
  list() {
    return this.devices.list();
  }

  @Get(":id/history")
  @RequirePermission("devices:read")
  history(@Id() id: string) {
    return this.devices.history(id);
  }

  @Post(":id/revoke")
  @HttpCode(200)
  @RequirePermission("devices:manage")
  revoke(@CurrentUser() admin: AuthContext, @Id() id: string, @Body(new ZodPipe(revokeDeviceSchema)) body: RevokeDeviceInput) {
    return this.devices.revoke(admin, id, body?.reason);
  }

  @Post(":id/allow-reregistration")
  @HttpCode(200)
  @RequirePermission("devices:manage")
  allowReregistration(@CurrentUser() admin: AuthContext, @Id() id: string) {
    return this.devices.allowReregistration(admin, id);
  }

  @Post(":id/end-session")
  @HttpCode(200)
  @RequirePermission("devices:manage")
  endSession(@CurrentUser() admin: AuthContext, @Id() id: string) {
    return this.devices.endSessionAsAdmin(admin, id);
  }
}
