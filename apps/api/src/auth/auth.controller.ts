import { Body, Controller, Delete, Get, HttpCode, HttpException, HttpStatus, Param, ParseUUIDPipe, Post, Req, Res, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  loginSchema,
  refreshSchema,
  setupPasswordSchema,
  type DesktopLoginResponse,
  type LoginResponse,
  type MeResponse,
  type RevokeSessionsResponse,
  type SessionInfo,
} from "@workfolio/shared";
import type { Request, Response } from "express";
import type { z } from "zod";
import { ZodPipe } from "../common/zod.pipe.js";
import type { Env } from "../config/env.js";
import { EmployeesService } from "../employees/employees.service.js";
import {
  clearAuthCookies,
  CurrentUser,
  Public,
  readCookie,
  REFRESH_COOKIE,
  RequirePermission,
  setAuthCookies,
} from "./auth.guard.js";
import { type AuthContext, AuthService } from "./auth.service.js";

/**
 * Two transports over one session model:
 * - web (dashboard): tokens only in HttpOnly cookies, never in the body;
 * - desktop: tokens in the body, refresh token kept in the OS credential store by the app.
 */
@Controller({ path: "auth", version: "1" })
export class AuthController {
  private readonly secureCookies: boolean;

  constructor(
    private readonly auth: AuthService,
    private readonly employees: EmployeesService,
    config: ConfigService<Env, true>,
  ) {
    this.secureCookies = config.get("NODE_ENV", { infer: true }) === "production";
  }

  @Public()
  @Post("login")
  @HttpCode(200)
  async login(
    @Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse | DesktopLoginResponse> {
    const session = await this.auth.login(body.email, body.password, req.ip ?? "unknown", body.client === "desktop" ? "DESKTOP" : "WEB", {
      installationId: body.installationId,
      takeover: body.takeover,
    });
    if (body.client === "desktop") return session;
    setAuthCookies(res, session, this.secureCookies);
    return { user: session.user };
  }

  @Public()
  @Post("refresh")
  @HttpCode(200)
  async refresh(
    @Body(new ZodPipe(refreshSchema)) body: z.infer<typeof refreshSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse | DesktopLoginResponse> {
    const token = body.refreshToken ?? readCookie(req, REFRESH_COOKIE);
    if (!token) throw new UnauthorizedException();
    try {
      const session = await this.auth.refresh(token, req.ip ?? "unknown");
      if (body.refreshToken) return session;
      setAuthCookies(res, session, this.secureCookies);
      return { user: session.user };
    } catch (err) {
      // A rate-limited refresh (429) keeps the cookies: the session is still valid, retry later.
      const limited = err instanceof HttpException && err.getStatus() === HttpStatus.TOO_MANY_REQUESTS;
      if (!body.refreshToken && !limited) clearAuthCookies(res, this.secureCookies);
      throw err;
    }
  }

  @Public()
  @Post("logout")
  @HttpCode(204)
  async logout(
    @Body(new ZodPipe(refreshSchema)) body: z.infer<typeof refreshSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(body.refreshToken ?? readCookie(req, REFRESH_COOKIE));
    clearAuthCookies(res, this.secureCookies);
  }

  @Get("me")
  @RequirePermission("profile:read-own")
  async me(@CurrentUser() user: AuthContext): Promise<MeResponse> {
    return {
      user: { id: user.id, email: user.email, role: user.role, platformRole: user.platformRole },
      employee: await this.employees.findByUserId(user.id),
      teamHead: user.teamHead === true,
    };
  }

  // ---- Own sessions (ownership from the authenticated context, never from the request) ----

  @Get("sessions")
  @RequirePermission("sessions:own")
  sessions(@CurrentUser() user: AuthContext): Promise<SessionInfo[]> {
    return this.auth.listSessions(user);
  }

  /** Revoking the current session signs this client out (web: cookies cleared). */
  @Delete("sessions/:id")
  @RequirePermission("sessions:own")
  @HttpCode(204)
  async revokeSession(
    @CurrentUser() user: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.revokeOwnSession(user, id);
    if (id === user.sessionId) clearAuthCookies(res, this.secureCookies);
  }

  @Post("sessions/revoke-others")
  @RequirePermission("sessions:own")
  @HttpCode(200)
  async revokeOthers(@CurrentUser() user: AuthContext): Promise<RevokeSessionsResponse> {
    return { revoked: await this.auth.revokeOwnSessions(user, false) };
  }

  /** Sign out everywhere, this session included. */
  @Post("sessions/revoke-all")
  @RequirePermission("sessions:own")
  @HttpCode(200)
  async revokeAll(@CurrentUser() user: AuthContext, @Res({ passthrough: true }) res: Response): Promise<RevokeSessionsResponse> {
    const revoked = await this.auth.revokeOwnSessions(user, true);
    clearAuthCookies(res, this.secureCookies);
    return { revoked };
  }

  @Public()
  @Post("setup-password")
  @HttpCode(204)
  async setupPassword(
    @Body(new ZodPipe(setupPasswordSchema)) body: z.infer<typeof setupPasswordSchema>,
    @Req() req: Request,
  ): Promise<void> {
    await this.auth.setupPassword(body.token, body.password, req.ip ?? "unknown");
  }
}
