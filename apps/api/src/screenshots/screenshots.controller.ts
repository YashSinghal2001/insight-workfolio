import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, Res, StreamableFile } from "@nestjs/common";
import {
  consentSchema,
  DEVICE_HEADER,
  retentionRunSchema,
  screenshotBlurOverrideQuerySchema,
  screenshotBlurOverrideSchema,
  screenshotContentQuerySchema,
  screenshotDeleteSchema,
  screenshotGallerySchema,
  screenshotQuerySchema,
  screenshotRegisterSchema,
  screenshotSettingsSchema,
  SCREENSHOT_MIME,
  type ScreenshotBlurOverrideInput,
  type ScreenshotDeleteRequest,
  type ScreenshotGalleryQuery,
  type ScreenshotQuery,
  type ScreenshotRegisterRequest,
  type ScreenshotSettingsInput,
} from "@workfolio/shared";
import type { Request, Response } from "express";
import { CurrentUser, RequirePermission, TeamScoped } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { DevicesService } from "../devices/devices.service.js";
import { EmployeesService } from "../employees/employees.service.js";
import { ScreenshotSettingsService } from "./screenshot-settings.service.js";
import { ScreenshotsService } from "./screenshots.service.js";

/**
 * Upload flow: POST /screenshots/register (metadata, policy checks) then PUT /screenshots/:id/content
 * (bytes; the API stores them with the provider and answers STORED only after the provider
 * confirmed the file, which is the "complete" step). Writes only from the caller's active device.
 */
@Controller({ path: "screenshots", version: "1" })
export class ScreenshotsController {
  constructor(
    private readonly screenshots: ScreenshotsService,
    private readonly devices: DevicesService,
    private readonly employees: EmployeesService,
  ) {}

  /** Policy, screenshot notice, consent state and the last stored screenshot (desktop status). */
  @Get("me")
  @RequirePermission("activity:read-own")
  async me(@CurrentUser() user: AuthContext) {
    return this.screenshots.status(await this.employees.attendanceTarget(user));
  }

  @Post("consent")
  @HttpCode(200)
  @RequirePermission("activity:record")
  async consent(@CurrentUser() user: AuthContext, @Body(new ZodPipe(consentSchema)) body: { noticeVersion: string }) {
    return this.screenshots.consent(await this.employees.attendanceTarget(user), body.noticeVersion);
  }

  @Post("register")
  @HttpCode(200)
  @RequirePermission("activity:record")
  async register(
    @CurrentUser() user: AuthContext,
    @Body(new ZodPipe(screenshotRegisterSchema)) body: ScreenshotRegisterRequest,
    @Headers(DEVICE_HEADER) installationId?: string,
  ) {
    return this.screenshots.register(await this.devices.require(user, installationId), body);
  }

  /** Body: the WebP bytes (Content-Type: image/webp), at most 10 MB. */
  @Put(":id/content")
  @RequirePermission("activity:record")
  async upload(
    @CurrentUser() user: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: Request,
    @Headers(DEVICE_HEADER) installationId?: string,
  ) {
    return this.screenshots.upload(await this.devices.require(user, installationId), id, req.body);
  }

  /** Metadata only (never image bytes or links). Defaults to the caller; admins may pass employeeId. */
  @Get()
  @RequirePermission("activity:read-own")
  async list(@CurrentUser() user: AuthContext, @Query(new ZodPipe(screenshotQuerySchema)) q: ScreenshotQuery) {
    return this.screenshots.list(user, await this.employees.attendanceTarget(user, q.employeeId, "screenshots:read"), q);
  }

  /** Admin gallery: all employees or one, date range in the viewer's time zone, paginated. */
  @Get("gallery")
  @RequirePermission("screenshots:read")
  @TeamScoped()
  gallery(@CurrentUser() user: AuthContext, @Query(new ZodPipe(screenshotGallerySchema)) q: ScreenshotGalleryQuery) {
    return this.screenshots.gallery(q, user);
  }

  /** Server-side counts for the same filters, plus retention status. */
  @Get("overview")
  @RequirePermission("screenshots:read")
  @TeamScoped()
  overview(@CurrentUser() user: AuthContext, @Query(new ZodPipe(screenshotGallerySchema)) q: ScreenshotGalleryQuery) {
    return this.screenshots.overview(q, user);
  }

  /** Dry run: what the screenshot retention purge would delete now. */
  @Get("retention")
  @RequirePermission("settings:manage")
  retentionPreview() {
    return this.screenshots.retentionPreview();
  }

  @Post("retention/run")
  @HttpCode(200)
  @RequirePermission("screenshots:delete")
  retentionRun(@CurrentUser() user: AuthContext, @Body(new ZodPipe(retentionRunSchema)) _body: { confirm: true }) {
    return this.screenshots.retentionRun(user);
  }

  /** Metadata of one screenshot (admins also get its access log). */
  @Get(":id")
  @RequirePermission("activity:read-own")
  detail(@CurrentUser() user: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    return this.screenshots.detail(user, id);
  }

  /** Super Admin: deletes one screenshot (file, then the row is marked DELETED; the row is kept). Idempotent. */
  @Delete(":id")
  @RequirePermission("screenshots:delete")
  remove(@CurrentUser() user: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(screenshotDeleteSchema)) body: ScreenshotDeleteRequest) {
    return this.screenshots.remove(user, id, body.reason);
  }

  /**
   * The image, streamed through the API: no public or shareable URL, never cached, sandboxed
   * (it cannot run script or load anything even if opened directly), logged on every request.
   */
  @Get(":id/content")
  @RequirePermission("activity:read-own")
  async content(
    @CurrentUser() user: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Query(new ZodPipe(screenshotContentQuerySchema)) q: { variant: "full" | "thumbnail" },
    @Res({ passthrough: true }) res: Response,
  ) {
    const bytes = await this.screenshots.content(user, id, q.variant);
    res.setHeader("cache-control", "no-store, private, max-age=0");
    res.setHeader("pragma", "no-cache");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-security-policy", "default-src 'none'; sandbox");
    res.setHeader("cross-origin-resource-policy", "same-site");
    res.setHeader("referrer-policy", "no-referrer");
    return new StreamableFile(bytes, { type: SCREENSHOT_MIME, length: bytes.length, disposition: `inline; filename="screenshot-${id}.webp"` });
  }
}

/** Admin-only screenshot policy (append-only history). Notices are published under /settings/monitoring/notices. */
@Controller({ path: "settings/screenshots", version: "1" })
export class ScreenshotSettingsController {
  constructor(private readonly settings: ScreenshotSettingsService) {}

  @Get()
  @RequirePermission("settings:manage")
  overview() {
    return this.settings.overview();
  }

  @Put()
  @RequirePermission("settings:manage")
  update(@CurrentUser() user: AuthContext, @Body(new ZodPipe(screenshotSettingsSchema)) body: ScreenshotSettingsInput) {
    return this.settings.update(user, body);
  }

  /** One employee's whole-image blur override: current state and history (newest first). */
  @Get("blur-overrides")
  @RequirePermission("settings:manage")
  blurOverrides(@Query(new ZodPipe(screenshotBlurOverrideQuerySchema)) q: { employeeId: string }) {
    return this.settings.blurOverview(q.employeeId);
  }

  /** Always / never blur this employee's new captures, or `blur: null` to follow the organisation setting again. */
  @Put("blur-overrides/:employeeId")
  @RequirePermission("settings:manage")
  setBlurOverride(
    @CurrentUser() user: AuthContext,
    @Param("employeeId", ParseUUIDPipe) employeeId: string,
    @Body(new ZodPipe(screenshotBlurOverrideSchema)) body: ScreenshotBlurOverrideInput,
  ) {
    return this.settings.setBlurOverride(user, employeeId, body);
  }
}
