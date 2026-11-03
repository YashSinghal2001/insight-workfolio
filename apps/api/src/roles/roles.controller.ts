import { Body, Controller, Get, Param, ParseUUIDPipe, Patch } from "@nestjs/common";
import { changeRoleSchema } from "@workfolio/shared";
import type { z } from "zod";
import { CurrentUser, RequirePermission } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { RolesService } from "./roles.service.js";

/** Super Admin and Admin (both ADMIN): role identities and their history. */
@Controller({ path: "roles", version: "1" })
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get("users")
  @RequirePermission("roles:manage")
  users() {
    return this.roles.users();
  }

  @Patch("users/:id")
  @RequirePermission("roles:manage")
  change(@CurrentUser() user: AuthContext, @Param("id", new ParseUUIDPipe({ version: "4" })) id: string, @Body(new ZodPipe(changeRoleSchema)) body: z.infer<typeof changeRoleSchema>) {
    return this.roles.change(user, id, body.platformRole, body.reason);
  }

  @Get("history")
  @RequirePermission("roles:manage")
  history() {
    return this.roles.history();
  }
}
