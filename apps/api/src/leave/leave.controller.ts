import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import {
  createLeaveSchema,
  decideLeaveSchema,
  leaveBalanceMeQuerySchema,
  leaveBalanceQuerySchema,
  leaveSummaryMeQuerySchema,
  leaveSummaryQuerySchema,
  leaveTypeSchema,
  listLeaveQuerySchema,
  updateLeaveTypeSchema,
  type CreateLeave,
  type LeaveSummaryQuery,
  type LeaveTypeInput,
  type UpdateLeaveTypeInput,
} from "@workfolio/shared";
import type { z } from "zod";
import { CurrentUser, RequirePermission, TeamScoped } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { LeaveService } from "./leave.service.js";

const Id = () => Param("id", new ParseUUIDPipe({ version: "4" }));
type Decision = z.infer<typeof decideLeaveSchema>;

/** Employees request and cancel their own leave; administrators (other than the requester) decide. */
@Controller({ path: "leave", version: "1" })
export class LeaveController {
  constructor(private readonly leave: LeaveService) {}

  @Post()
  @RequirePermission("leave:request")
  create(@CurrentUser() user: AuthContext, @Body(new ZodPipe(createLeaveSchema)) body: CreateLeave) {
    return this.leave.create(user, body);
  }

  @Get()
  @RequirePermission("leave:request")
  list(@CurrentUser() user: AuthContext, @Query(new ZodPipe(listLeaveQuerySchema)) q: z.infer<typeof listLeaveQuerySchema>) {
    return this.leave.list(user, q);
  }

  /** Admin: requests per employee and status overlapping the range (records only, not balances). Team heads: their teams. Declared before :id. */
  @Get("summary")
  @RequirePermission("leave:read-all")
  @TeamScoped()
  summary(@Query(new ZodPipe(leaveSummaryQuerySchema)) q: LeaveSummaryQuery, @CurrentUser() user: AuthContext) {
    return this.leave.summary(q, user);
  }

  /** The caller's own totals; the employee always comes from the session. */
  @Get("summary/me")
  @RequirePermission("leave:request")
  mySummary(@CurrentUser() user: AuthContext, @Query(new ZodPipe(leaveSummaryMeQuerySchema)) q: { from: string; to: string }) {
    return this.leave.mySummary(user, q.from, q.to);
  }

  /** Active types for everyone who requests leave; administrators (leave:manage) also see inactive ones. */
  @Get("types")
  @RequirePermission("leave:request")
  types(@CurrentUser() user: AuthContext) {
    return this.leave.listTypes(user);
  }

  @Post("types")
  @RequirePermission("leave:manage")
  createType(@CurrentUser() user: AuthContext, @Body(new ZodPipe(leaveTypeSchema)) body: LeaveTypeInput) {
    return this.leave.createType(user, body);
  }

  @Patch("types/:id")
  @RequirePermission("leave:manage")
  updateType(@CurrentUser() user: AuthContext, @Id() id: string, @Body(new ZodPipe(updateLeaveTypeSchema)) body: UpdateLeaveTypeInput) {
    return this.leave.updateType(user, id, body);
  }

  /** Admin: every employee's balances for the year of `month` (short leave for `month`). Team heads: their teams. */
  @Get("balances")
  @RequirePermission("leave:read-all")
  @TeamScoped()
  balances(@Query(new ZodPipe(leaveBalanceQuerySchema)) q: z.infer<typeof leaveBalanceQuerySchema>, @CurrentUser() user: AuthContext) {
    return this.leave.balances(q, user);
  }

  /** The caller's own balances; the employee always comes from the session. */
  @Get("balances/me")
  @RequirePermission("leave:request")
  myBalances(@CurrentUser() user: AuthContext, @Query(new ZodPipe(leaveBalanceMeQuerySchema)) q: z.infer<typeof leaveBalanceMeQuerySchema>) {
    return this.leave.myBalances(user, q.month);
  }

  @Get(":id")
  @RequirePermission("leave:request")
  get(@CurrentUser() user: AuthContext, @Id() id: string) {
    return this.leave.get(user, id);
  }

  /**
   * Admins (leave:review) decide any request. W41 exception: the guard also lets a team head through
   * (leave:read-all on a team-scoped route) and LeaveService.decide allows them only for members of the
   * teams they head, never their own request. Plain employees are refused by the guard (403).
   */
  @Post(":id/approve")
  @HttpCode(200)
  @RequirePermission("leave:read-all")
  @TeamScoped()
  approve(@CurrentUser() user: AuthContext, @Id() id: string, @Body(new ZodPipe(decideLeaveSchema)) body: Decision) {
    return this.leave.decide(user, id, "APPROVED", body.note);
  }

  @Post(":id/reject")
  @HttpCode(200)
  @RequirePermission("leave:read-all")
  @TeamScoped()
  reject(@CurrentUser() user: AuthContext, @Id() id: string, @Body(new ZodPipe(decideLeaveSchema)) body: Decision) {
    return this.leave.decide(user, id, "REJECTED", body.note);
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @RequirePermission("leave:request")
  cancel(@CurrentUser() user: AuthContext, @Id() id: string) {
    return this.leave.cancel(user, id);
  }
}
