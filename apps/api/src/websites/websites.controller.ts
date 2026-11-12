import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from "@nestjs/common";
import {
  consentSchema,
  retentionRunSchema,
  websiteCategorySchema,
  websiteCategoryUpdateSchema,
  websiteIntervalsSchema,
  websitePairSchema,
  websitePolicySchema,
  websiteRangeSchema,
} from "@workfolio/shared";
import type { Request } from "express";
import type { z } from "zod";
import { CsrfExempt, CurrentUser, Public, RequirePermission } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { WebsitesService } from "./websites.service.js";

const Id = () => Param("id", new ParseUUIDPipe({ version: "4" }));
type Range = z.infer<typeof websiteRangeSchema>;

/** Admin policy, reports and category rules; the employee's own status, notice, connections and usage. */
@Controller({ path: "websites", version: "1" })
export class WebsitesController {
  constructor(private readonly websites: WebsitesService) {}

  @Get("policy")
  @RequirePermission("websites:manage")
  async policy() {
    return { current: await this.websites.policy(), history: await this.websites.history() };
  }

  @Put("policy")
  @RequirePermission("websites:manage")
  setPolicy(@CurrentUser() user: AuthContext, @Body(new ZodPipe(websitePolicySchema)) body: z.infer<typeof websitePolicySchema>) {
    return this.websites.setPolicy(user, body);
  }

  @Get("report")
  @RequirePermission("websites:manage")
  report(@Query(new ZodPipe(websiteRangeSchema)) q: Range) {
    return this.websites.report(q.from, q.to, q.employeeId, q.category, q.domain);
  }

  @Get("notifications")
  @RequirePermission("websites:manage")
  notifications() {
    return this.websites.notifications();
  }

  @Get("categories")
  @RequirePermission("websites:manage")
  rules() {
    return this.websites.rules();
  }

  @Post("categories")
  @RequirePermission("websites:manage")
  addRule(@CurrentUser() user: AuthContext, @Body(new ZodPipe(websiteCategorySchema)) body: z.infer<typeof websiteCategorySchema>) {
    return this.websites.addRule(user, body);
  }

  @Patch("categories/:id")
  @RequirePermission("websites:manage")
  updateRule(@CurrentUser() user: AuthContext, @Id() id: string, @Body(new ZodPipe(websiteCategoryUpdateSchema)) body: z.infer<typeof websiteCategoryUpdateSchema>) {
    return this.websites.updateRule(user, id, body.category);
  }

  @Delete("categories/:id")
  @RequirePermission("websites:manage")
  removeRule(@CurrentUser() user: AuthContext, @Id() id: string) {
    return this.websites.removeRule(user, id);
  }

  @Get("audit")
  @RequirePermission("websites:manage")
  audit() {
    return this.websites.auditLog();
  }

  @Post("retention/run")
  @HttpCode(200)
  @RequirePermission("screenshots:delete")
  retention(@CurrentUser() user: AuthContext, @Body(new ZodPipe(retentionRunSchema)) _body: { confirm: true }) {
    return this.websites.retention(user);
  }

  // ---- The signed-in employee (identity from the session only) ----

  @Get("me")
  @RequirePermission("websites:own")
  me(@CurrentUser() user: AuthContext) {
    return this.websites.status(user);
  }

  @Post("consent")
  @HttpCode(200)
  @RequirePermission("websites:own")
  consent(@CurrentUser() user: AuthContext, @Body(new ZodPipe(consentSchema)) body: { noticeVersion: string }) {
    return this.websites.consent(user, body.noticeVersion);
  }

  @Get("me/usage")
  @RequirePermission("websites:own")
  myUsage(@CurrentUser() user: AuthContext, @Query(new ZodPipe(websiteRangeSchema)) q: Range) {
    if (q.employeeId) throw new BadRequestException("employeeId is not accepted: this is your own usage");
    return this.websites.myUsage(user, q.from, q.to, q.category, q.domain);
  }

  @Post("links")
  @RequirePermission("websites:own")
  pairingCode(@CurrentUser() user: AuthContext) {
    return this.websites.pairingCode(user);
  }

  @Delete("links/:id")
  @RequirePermission("websites:own")
  revoke(@CurrentUser() user: AuthContext, @Id() id: string) {
    return this.websites.revoke(user, id);
  }

  // ---- The browser extension (its own token; no employee id is ever taken from it) ----

  @Post("extension/pair")
  @Public()
  @CsrfExempt() // no cookies are read; the one-time code is the credential; called from the extension's own origin
  pair(@Body(new ZodPipe(websitePairSchema)) body: z.infer<typeof websitePairSchema>, @Req() req: Request) {
    return this.websites.pair(body.code, body.label, req.ip ?? "unknown");
  }

  @Get("extension/state")
  @Public()
  async state(@Headers("authorization") auth?: string) {
    return this.websites.extensionState(await this.websites.extension(auth));
  }

  @Post("extension/intervals")
  @HttpCode(200)
  @Public()
  async intervals(@Headers("authorization") auth: string | undefined, @Body(new ZodPipe(websiteIntervalsSchema)) body: z.infer<typeof websiteIntervalsSchema>) {
    return this.websites.submit(await this.websites.extension(auth), body);
  }

  @Post("extension/disconnect")
  @HttpCode(200)
  @Public()
  async disconnect(@Headers("authorization") auth?: string) {
    return this.websites.disconnect(await this.websites.extension(auth));
  }
}
