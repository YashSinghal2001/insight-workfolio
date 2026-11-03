import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res, StreamableFile } from "@nestjs/common";
import {
  timelapseContentQuerySchema,
  timelapseCreateSchema,
  timelapseSessionsSchema,
  TIMELAPSE_MIME,
  type TimelapseCreateRequest,
  type TimelapseSessionsQuery,
} from "@workfolio/shared";
import type { Response } from "express";
import { CurrentUser, RequirePermission, TeamScoped } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { TimelapseService } from "./timelapse.service.js";

/**
 * Timelapse videos of one session's stored screenshots. Admins, and team heads for their teams (same as the gallery); the
 * employee comes from the session, never from the request. No file paths or links leave the API.
 */
@Controller({ path: "timelapses", version: "1" })
@RequirePermission("screenshots:read")
@TeamScoped()
export class TimelapseController {
  constructor(private readonly timelapses: TimelapseService) {}

  /** One employee's sessions in a date range, with screenshot counts and the latest video job. */
  @Get()
  sessions(@CurrentUser() user: AuthContext, @Query(new ZodPipe(timelapseSessionsSchema)) q: TimelapseSessionsQuery) {
    return this.timelapses.sessions(q, user);
  }

  /** Queues a video (202), or returns the job already queued/encoding for that session. */
  @Post()
  @HttpCode(202)
  create(@CurrentUser() user: AuthContext, @Body(new ZodPipe(timelapseCreateSchema)) body: TimelapseCreateRequest) {
    return this.timelapses.create(user, body);
  }

  @Get(":id")
  job(@CurrentUser() user: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    return this.timelapses.job(id, user);
  }

  @Post(":id/cancel")
  @HttpCode(200)
  cancel(@CurrentUser() user: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    return this.timelapses.cancel(user, id);
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    await this.timelapses.remove(user, id);
  }

  /** The MP4 through the API: never cached, sandboxed, logged as a view or a download. */
  @Get(":id/content")
  async content(
    @CurrentUser() user: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Query(new ZodPipe(timelapseContentQuerySchema)) q: { download: boolean },
    @Res({ passthrough: true }) res: Response,
  ) {
    const { stream, job } = await this.timelapses.content(user, id, q.download);
    res.setHeader("cache-control", "no-store, private, max-age=0");
    res.setHeader("pragma", "no-cache");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-security-policy", "default-src 'none'; sandbox");
    res.setHeader("cross-origin-resource-policy", "same-site");
    res.setHeader("referrer-policy", "no-referrer");
    // RFC 9530: lets the client check it received exactly the recorded file.
    res.setHeader("repr-digest", `sha-256=:${Buffer.from(job.sha256!, "hex").toString("base64")}:`);
    return new StreamableFile(stream, {
      type: TIMELAPSE_MIME,
      length: job.sizeBytes!,
      disposition: `${q.download ? "attachment" : "inline"}; filename="timelapse-${job.firstCapturedAt?.slice(0, 10) ?? "session"}-${id.slice(0, 8)}.mp4"`,
    });
  }
}
