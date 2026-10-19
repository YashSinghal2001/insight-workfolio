import { type INestApplication, ValidationPipe, VersioningType } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { SCREENSHOT_LIMITS, SCREENSHOT_MIME } from "@workfolio/shared";
import { Logger } from "nestjs-pino";
import { AllExceptionsFilter } from "./common/all-exceptions.filter.js";
import type { Env } from "./config/env.js";

/** Shared by main.ts and the e2e tests so both exercise identical wiring. */
export function configureApp(app: INestApplication): void {
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  app.useLogger(app.get(Logger));
  const http = app.getHttpAdapter().getInstance();
  http.disable("x-powered-by");
  // Honour X-Forwarded-For only from a local reverse proxy, so rate limits key on the real client IP.
  http.set("trust proxy", "loopback");
  // URI versioning: /api/v1/... ; new versions are added per controller/route without breaking v1.
  app.setGlobalPrefix("api");
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
  // Activity uploads carry up to 500 intervals; keep a firm cap well above that.
  (app as NestExpressApplication).useBodyParser("json", { limit: "1mb" });
  // Screenshot uploads (PUT /screenshots/:id/content) arrive as raw WebP bytes.
  (app as NestExpressApplication).useBodyParser("raw", { type: SCREENSHOT_MIME, limit: SCREENSHOT_LIMITS.maxBytes });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableCors({ origin: config.get("CORS_ORIGINS"), credentials: true });
  app.enableShutdownHooks();
}
