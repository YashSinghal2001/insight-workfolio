import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Res } from "@nestjs/common";
import {
  createReleaseSchema,
  DEVICE_HEADER,
  reportUpdateStatusSchema,
  setReleaseStatusSchema,
  updateReleaseSchema,
  type CreateReleaseInput,
  type ReportUpdateStatusInput,
  type SetReleaseStatusInput,
  type UpdateReleaseInput,
} from "@workfolio/shared";
import type { Response } from "express";
import { CurrentUser, Public, RequirePermission } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { DesktopUpdatesService } from "./desktop-updates.service.js";

const Id = () => Param("id", new ParseUUIDPipe({ version: "4" }));

@Controller({ path: "desktop-updates", version: "1" })
export class DesktopUpdatesController {
  constructor(private readonly updates: DesktopUpdatesService) {}

  /**
   * The Tauri updater endpoint ({{target}}/{{arch}}/{{current_version}}). Public: an app below the minimum
   * version must find its update even signed out. X-Device-Id (optional) only places the installation in
   * a rollout bucket and recognises administrators' test devices; it is hashed and not stored.
   */
  @Public()
  @Get("manifest/:target/:arch/:version")
  async manifest(
    @Param("target") target: string,
    @Param("arch") arch: string,
    @Param("version") version: string,
    @Headers(DEVICE_HEADER) installationId: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const m = await this.updates.manifest(target, arch, version, installationId?.slice(0, 100));
    if (!m) res.status(204);
    return m ?? undefined;
  }

  @Post("status")
  @HttpCode(204)
  @RequirePermission("updates:report")
  report(@CurrentUser() user: AuthContext, @Headers(DEVICE_HEADER) installationId: string | undefined, @Body(new ZodPipe(reportUpdateStatusSchema)) body: ReportUpdateStatusInput) {
    return this.updates.report(user, installationId, body);
  }

  @Get("releases")
  @RequirePermission("updates:manage")
  list() {
    return this.updates.list();
  }

  @Post("releases")
  @RequirePermission("updates:manage")
  create(@CurrentUser() user: AuthContext, @Body(new ZodPipe(createReleaseSchema)) body: CreateReleaseInput) {
    return this.updates.create(user, body);
  }

  @Patch("releases/:id")
  @RequirePermission("updates:manage")
  update(@CurrentUser() user: AuthContext, @Id() id: string, @Body(new ZodPipe(updateReleaseSchema)) body: UpdateReleaseInput) {
    return this.updates.update(user, id, body);
  }

  /** DRAFT / TESTING / PUBLISHED / DISABLED. Publishing (and leaving PUBLISHED other than by disabling) is Super Admin only. */
  @Post("releases/:id/status")
  @HttpCode(200)
  @RequirePermission("updates:manage")
  setStatus(@CurrentUser() user: AuthContext, @Id() id: string, @Body(new ZodPipe(setReleaseStatusSchema)) body: SetReleaseStatusInput) {
    return this.updates.setStatus(user, id, body.status, body.reason);
  }

  @Get("releases/:id/history")
  @RequirePermission("updates:manage")
  history(@Id() id: string) {
    return this.updates.history(id);
  }

  @Get("devices")
  @RequirePermission("updates:manage")
  devices() {
    return this.updates.deviceStatuses();
  }
}
