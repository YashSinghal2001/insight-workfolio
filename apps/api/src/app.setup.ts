import { type INestApplication, VersioningType } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { SCREENSHOT_LIMITS, SCREENSHOT_MIME } from "@workfolio/shared";
import type { IncomingMessage } from "node:http";
import type { NextFunction, Request, Response } from "express";
import { Logger } from "nestjs-pino";
import { AllExceptionsFilter } from "./common/all-exceptions.filter.js";
import { apiRateLimitPerMinute, IP_CEILING_FACTOR, ipRateLimit } from "./common/rate-limit.js";
import type { Env } from "./config/env.js";

/** Shared by main.ts and the e2e tests so both exercise identical wiring. */
export function configureApp(app: INestApplication): void {
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  app.useLogger(app.get(Logger));
  const http = app.getHttpAdapter().getInstance();
  http.disable("x-powered-by");
  // Responses carry personal data and, for the desktop, tokens: never cached, sniffed or framed.
  // Routes with their own rules (screenshot images) set stricter headers after this.
  // HSTS only in production: there the API is HTTPS-only (Render); a dev/test browser must keep plain-http localhost.
  const hsts = config.get("NODE_ENV", { infer: true }) === "production";
  http.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-frame-options", "DENY");
    if (hsts) res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
    next();
  });
  // Which hops may set X-Forwarded-For, so req.ip (and every per-IP rate limit) is the real client.
  // Default "loopback"; behind Render's proxy TRUST_PROXY=1 (see env.ts).
  http.set("trust proxy", config.get("TRUST_PROXY", { infer: true }));
  // Per-IP abuse ceiling (10 sessions' worth); the per-session limit is in AuthGuard. Off outside production by default.
  const perMinute = apiRateLimitPerMinute(config);
  if (perMinute > 0) http.use(ipRateLimit(perMinute * IP_CEILING_FACTOR));
  // URI versioning: /api/v1/... ; new versions are added per controller/route without breaking v1.
  app.setGlobalPrefix("api");
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
  // Activity uploads carry up to 500 intervals; keep a firm cap well above that.
  (app as NestExpressApplication).useBodyParser("json", { limit: "1mb" });
  // Screenshot uploads arrive as raw WebP bytes. Only that one route reads them; anything else with
  // this content type is left unread instead of being buffered (up to 10 MB) before authentication.
  // Validation is per route (ZodPipe); there are no class-validator DTOs, so no global ValidationPipe.
  (app as NestExpressApplication).useBodyParser("raw", { type: isScreenshotUpload, limit: SCREENSHOT_LIMITS.maxBytes });
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableCors({ origin: config.get("CORS_ORIGINS"), credentials: true, exposedHeaders: ["x-export-rows"] });
  app.enableShutdownHooks();
}

const SCREENSHOT_CONTENT_PATH = /^\/api\/v1\/screenshots\/[^/]+\/content$/;

/** PUT /api/v1/screenshots/:id/content with Content-Type image/webp (parameters allowed). */
function isScreenshotUpload(req: IncomingMessage): boolean {
  return (
    req.method === "PUT" &&
    SCREENSHOT_CONTENT_PATH.test((req.url ?? "").split("?")[0]!) &&
    (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() === SCREENSHOT_MIME
  );
}
