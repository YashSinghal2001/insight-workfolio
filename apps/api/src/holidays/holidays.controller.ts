import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { holidaySchema, importHolidaysSchema, listHolidaysQuerySchema, type HolidayInput } from "@workfolio/shared";
import type { z } from "zod";
import { CurrentUser, RequirePermission } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { HolidaysService } from "./holidays.service.js";

/** Admin-only holiday calendar. Holidays are never ABSENT and do not use leave balance. */
@Controller({ path: "holidays", version: "1" })
export class HolidaysController {
  constructor(private readonly holidays: HolidaysService) {}

  @Get()
  @RequirePermission("holidays:manage")
  list(@Query(new ZodPipe(listHolidaysQuerySchema)) q: z.infer<typeof listHolidaysQuerySchema>) {
    return this.holidays.list(q.year);
  }

  @Post()
  @RequirePermission("holidays:manage")
  create(@CurrentUser() user: AuthContext, @Body(new ZodPipe(holidaySchema)) body: HolidayInput) {
    return this.holidays.create(user, body);
  }

  /** CSV text ("date,name" per line); see docs/holidays.md. */
  @Post("import")
  @HttpCode(200)
  @RequirePermission("holidays:manage")
  import(@CurrentUser() user: AuthContext, @Body(new ZodPipe(importHolidaysSchema)) body: { csv: string }) {
    return this.holidays.import(user, body.csv);
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("holidays:manage")
  async remove(@CurrentUser() user: AuthContext, @Param("id", new ParseUUIDPipe({ version: "4" })) id: string) {
    await this.holidays.remove(user, id);
  }
}
