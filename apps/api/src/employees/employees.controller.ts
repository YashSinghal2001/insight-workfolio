import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import {
  createEmployeeSchema,
  listEmployeesQuerySchema,
  updateAccountStatusSchema,
  updateEmployeeSchema,
} from "@workfolio/shared";
import type { z } from "zod";
import { CurrentUser, RequirePermission, TeamScoped } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { EmployeesService } from "./employees.service.js";

const Id = () => Param("id", new ParseUUIDPipe({ version: "4" }));

/** No DELETE: accounts are disabled, never removed, in the MVP. */
@Controller({ path: "employees", version: "1" })
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  /** Admins: everyone. Team heads: the members of their teams. */
  @Get()
  @RequirePermission("employees:read")
  @TeamScoped()
  list(@Query(new ZodPipe(listEmployeesQuerySchema)) query: z.infer<typeof listEmployeesQuerySchema>, @CurrentUser() user: AuthContext) {
    return this.employees.list(query, user);
  }

  @Post()
  @RequirePermission("employees:manage")
  create(@Body(new ZodPipe(createEmployeeSchema)) body: z.infer<typeof createEmployeeSchema>, @CurrentUser() user: AuthContext) {
    return this.employees.create(body, user);
  }

  /** Admins: any employee. Employees: only their own record (404 otherwise). */
  @Get(":id")
  @RequirePermission("profile:read-own")
  get(@Id() id: string, @CurrentUser() user: AuthContext) {
    return this.employees.getForCaller(id, user);
  }

  @Get(":id/devices")
  @RequirePermission("profile:read-own")
  devices(@Id() id: string, @CurrentUser() user: AuthContext) {
    return this.employees.devicesForCaller(id, user);
  }

  @Patch(":id")
  @RequirePermission("employees:manage")
  update(@Id() id: string, @Body(new ZodPipe(updateEmployeeSchema)) body: z.infer<typeof updateEmployeeSchema>, @CurrentUser() user: AuthContext) {
    return this.employees.update(id, body, user);
  }

  @Patch(":id/status")
  @RequirePermission("employees:manage")
  setStatus(
    @Id() id: string,
    @Body(new ZodPipe(updateAccountStatusSchema)) body: z.infer<typeof updateAccountStatusSchema>,
    @CurrentUser() user: AuthContext,
  ) {
    return this.employees.setAccountStatus(id, body.status, user);
  }

  @Post(":id/setup-token")
  @RequirePermission("employees:manage")
  reissueSetupToken(@Id() id: string, @CurrentUser() user: AuthContext) {
    return this.employees.reissueSetupToken(id, user);
  }
}
