import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { hasPermission, type Permission } from "@workfolio/shared";
import type { Request, Response } from "express";
import { apiRateLimitPerMinute, SessionRateLimit } from "../common/rate-limit.js";
import { readScope } from "../common/scope.js";
import type { Env } from "../config/env.js";
import { ACCESS_TOKEN_TTL_S, type AuthContext, AuthService, SESSION_TTL_MS, type IssuedSession } from "./auth.service.js";

const PUBLIC = "auth:public";
const PERMISSION = "auth:permission";

/** Opts a route out of authentication. Everything else requires a valid session. */
export const Public = () => SetMetadata(PUBLIC, true);
const CSRF_EXEMPT = "csrfExempt";
/**
 * Only for public routes that never read cookies and carry their own one-time credential in the body
 * (browser-extension pairing), so a cross-site request gains nothing. Everything else keeps the check.
 */
export const CsrfExempt = () => SetMetadata(CSRF_EXEMPT, true);
/** Role check via the shared permission map. Resource ownership is checked in services. */
export const RequirePermission = (permission: Permission) => SetMetadata(PERMISSION, permission);
const TEAM_SCOPED = "auth:teamScoped";
/**
 * W41: the route scopes its rows with common/scope.ts, so the head of an active team may call it with a
 * team-head permission (TEAM_HEAD_PERMISSIONS) and gets only their teams' members. Unmarked routes stay
 * role-only.
 */
export const TeamScoped = () => SetMetadata(TEAM_SCOPED, true);
export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<{ user: AuthContext }>().user,
);

// ---- Cookies (dashboard) --------------------------------------------------

export const ACCESS_COOKIE = "wf_access";
export const REFRESH_COOKIE = "wf_refresh";
const REFRESH_PATH = "/api/v1/auth";

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=") || undefined;
  }
}

/**
 * HttpOnly: unreadable by page scripts. SameSite=Strict: never sent on cross-site requests.
 * The refresh cookie is path-scoped to the auth routes so it rides along on nothing else.
 */
export function setAuthCookies(res: Response, session: IssuedSession, secure: boolean): void {
  const base = { httpOnly: true, sameSite: "strict", secure } as const;
  res.cookie(ACCESS_COOKIE, session.accessToken, { ...base, path: "/api", maxAge: ACCESS_TOKEN_TTL_S * 1000 });
  res.cookie(REFRESH_COOKIE, session.refreshToken, { ...base, path: REFRESH_PATH, maxAge: SESSION_TTL_MS });
}

export function clearAuthCookies(res: Response, secure: boolean): void {
  const base = { httpOnly: true, sameSite: "strict", secure } as const;
  res.clearCookie(ACCESS_COOKIE, { ...base, path: "/api" });
  res.clearCookie(REFRESH_COOKIE, { ...base, path: REFRESH_PATH });
}

// ---- Guard ----------------------------------------------------------------

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Global guard: CSRF origin check, then deny-by-default authentication, then permission check. */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly origins: Set<string>;
  /** Per-session request limit (off outside production unless API_RATE_LIMIT_PER_MINUTE is set). */
  readonly sessionLimit: SessionRateLimit;

  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    config: ConfigService<Env, true>,
  ) {
    this.origins = new Set(config.get("CORS_ORIGINS", { infer: true }));
    this.sessionLimit = new SessionRateLimit(apiRateLimitPerMinute(config));
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthContext }>();
    const bearer = /^Bearer ([\w.-]+)$/.exec(req.headers.authorization ?? "")?.[1];

    // CSRF: state-changing requests not carrying a bearer token (i.e. cookie-capable ones)
    // must come from an allow-listed origin. Browsers always send Origin on such requests.
    const targets = [ctx.getHandler(), ctx.getClass()];
    const exempt = this.reflector.getAllAndOverride<boolean>(PUBLIC, targets) && this.reflector.getAllAndOverride<boolean>(CSRF_EXEMPT, targets);
    if (!bearer && !exempt && !SAFE_METHODS.has(req.method) && !this.origins.has(req.headers.origin ?? "")) {
      throw new ForbiddenException("Request origin not allowed");
    }

    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;

    const token = bearer ?? readCookie(req, ACCESS_COOKIE);
    if (!token) throw new UnauthorizedException();
    req.user = await this.auth.authenticate(token);
    this.sessionLimit.check(req.user.sessionId, ctx.switchToHttp().getResponse<Response>());

    const permission = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION, targets);
    const teamRead = permission && this.reflector.getAllAndOverride<boolean>(TEAM_SCOPED, targets) && readScope(req.user, permission) === "team";
    if (permission && !hasPermission(req.user.role, permission) && !teamRead) throw new ForbiddenException("Your role does not allow this action");
    return true;
  }
}
