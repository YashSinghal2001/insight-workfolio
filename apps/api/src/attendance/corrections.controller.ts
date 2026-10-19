import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import {
  createCorrectionSchema,
  listCorrectionsQuerySchema,
  reviewCorrectionSchema,
  type CreateCorrection,
} from "@workfolio/shared";
import type { z } from "zod";
import { CurrentUser, RequirePermission } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { CorrectionsService } from "./corrections.service.js";

const Id = () => Param("id", new ParseUUIDPipe({ version: "4" }));

/** Employees request corrections to their own attendance; admins (other than the requester) review. */
@Controller({ path: "attendance/corrections", version: "1" })
export class CorrectionsController {
  constructor(private readonly corrections: CorrectionsService) {}

  @Post()
  @RequirePermission("corrections:request")
  create(@CurrentUser() user: AuthContext, @Body(new ZodPipe(createCorrectionSchema)) body: CreateCorrection) {
    return this.corrections.create(user, body);
  }

  @Get()
  @RequirePermission("timesheet:read-own")
  list(@CurrentUser() user: AuthContext, @Query(new ZodPipe(listCorrectionsQuerySchema)) q: z.infer<typeof listCorrectionsQuerySchema>) {
    return this.corrections.list(user, q);
  }

  @Get(":id")
  @RequirePermission("timesheet:read-own")
  get(@CurrentUser() user: AuthContext, @Id() id: string) {
    return this.corrections.get(user, id);
  }

  @Post(":id/approve")
  @HttpCode(200)
  @RequirePermission("attendance:review")
  approve(@CurrentUser() user: AuthContext, @Id() id: string, @Body(new ZodPipe(reviewCorrectionSchema)) body: { reason: string }) {
    return this.corrections.approve(user, id, body.reason);
  }

  @Post(":id/reject")
  @HttpCode(200)
  @RequirePermission("attendance:review")
  reject(@CurrentUser() user: AuthContext, @Id() id: string, @Body(new ZodPipe(reviewCorrectionSchema)) body: { reason: string }) {
    return this.corrections.reject(user, id, body.reason);
  }
}
