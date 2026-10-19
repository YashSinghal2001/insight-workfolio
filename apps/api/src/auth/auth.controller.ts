import { Body, Controller, Get, HttpCode, Post, Req, Res, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  loginSchema,
  refreshSchema,
  setupPasswordSchema,
  type DesktopLoginResponse,
  type LoginResponse,
  type MeResponse,
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
    const session = await this.auth.login(body.email, body.password, req.ip ?? "unknown");
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
      const session = await this.auth.refresh(token);
      if (body.refreshToken) return session;
      setAuthCookies(res, session, this.secureCookies);
      return { user: session.user };
    } catch (err) {
      if (!body.refreshToken) clearAuthCookies(res, this.secureCookies);
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
  async me(@CurrentUser() user: AuthContext): Promise<MeResponse> {
    return {
      user: { id: user.id, email: user.email, role: user.role },
      employee: await this.employees.findByUserId(user.id),
    };
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
