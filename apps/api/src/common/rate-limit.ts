import { HttpException, HttpStatus } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import type { ApiError } from "@workfolio/shared";
import type { NextFunction, Request, Response } from "express";
import { RateLimiter } from "../auth/crypto.js";
import type { Env } from "../config/env.js";

/** Liveness/readiness probes are never limited (Render and uptime checks poll them). */
const EXEMPT = /^\/api\/v1\/(health|ready)\/?$/;
/** The per-IP ceiling is this many sessions' worth: an office behind one NAT IP shares it. */
export const IP_CEILING_FACTOR = 10;

/** Per-session requests per minute: API_RATE_LIMIT_PER_MINUTE, else 600 in production; 0 = off (default elsewhere). */
export function apiRateLimitPerMinute(config: ConfigService<Env, true>): number {
  return config.get("API_RATE_LIMIT_PER_MINUTE", { infer: true }) ?? (config.get("NODE_ENV", { infer: true }) === "production" ? 600 : 0);
}

const tooManyBody = (path: string): ApiError => ({
  statusCode: 429,
  error: "Too Many Requests",
  message: "Too many requests. Try again later.",
  path,
  timestamp: new Date().toISOString(),
});

/**
 * Abuse ceiling per client IP (keyed by req.ip, so it relies on TRUST_PROXY) on every API request,
 * authenticated or not. Set high because many employees can share one office IP; the real per-user
 * limit is per session, in AuthGuard (sessionRateLimit).
 * ponytail: in-memory fixed window per process; move to Redis/the database if the API runs >1 instance.
 */
export function ipRateLimit(perMinute: number) {
  const limiter = new RateLimiter(perMinute, 60_000);
  return (req: Request, res: Response, next: NextFunction) => {
    if (EXEMPT.test(req.path)) return next();
    const key = req.ip ?? "unknown";
    if (limiter.hit(key)) return next();
    res.setHeader("retry-after", String(limiter.retryAfter(key)));
    res.status(429).json(tooManyBody(req.path));
  };
}

/**
 * Per-session limit for authenticated requests (checked by AuthGuard after authentication); public
 * routes have their own per-IP limits (login, setup-password, extension pairing) plus the IP ceiling.
 * ponytail: in-memory, per process, like RateLimiter.
 */
export class SessionRateLimit {
  private readonly limiter: RateLimiter | null;

  constructor(perMinute: number) {
    this.limiter = perMinute > 0 ? new RateLimiter(perMinute, 60_000) : null;
  }

  /** Throws 429 (Retry-After set on the response) once the session is over its limit. */
  check(sessionId: string, res: Response): void {
    if (!this.limiter || this.limiter.hit(sessionId)) return;
    res.setHeader("retry-after", String(this.limiter.retryAfter(sessionId)));
    throw new HttpException("Too many requests. Try again later.", HttpStatus.TOO_MANY_REQUESTS);
  }
}
