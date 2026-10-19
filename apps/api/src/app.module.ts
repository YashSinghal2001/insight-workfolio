import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { LoggerModule } from "nestjs-pino";
import { ActivityController } from "./activity/activity.controller.js";
import { ActivityService } from "./activity/activity.service.js";
import { RetentionService } from "./activity/retention.service.js";
import { AttendanceController } from "./attendance/attendance.controller.js";
import { AttendanceService } from "./attendance/attendance.service.js";
import { CorrectionsController } from "./attendance/corrections.controller.js";
import { CorrectionsService } from "./attendance/corrections.service.js";
import { TimesheetService } from "./attendance/timesheet.service.js";
import { EmployeeLocks } from "./common/employee-locks.js";
import { policyProvider } from "./common/policy.js";
import { AuthController } from "./auth/auth.controller.js";
import { AuthGuard } from "./auth/auth.guard.js";
import { AuthService } from "./auth/auth.service.js";
import { validateEnv, type Env } from "./config/env.js";
import { DatabaseModule } from "./database/database.module.js";
import { DevicesController } from "./devices/devices.controller.js";
import { DevicesService } from "./devices/devices.service.js";
import { EmployeesController } from "./employees/employees.controller.js";
import { EmployeesService } from "./employees/employees.service.js";
import { HealthController } from "./health/health.controller.js";
import { MonitoringSettingsController } from "./settings/monitoring-settings.controller.js";
import { MonitoringSettingsService } from "./settings/monitoring-settings.service.js";
import { ScreenshotSettingsService } from "./screenshots/screenshot-settings.service.js";
import { ScreenshotSettingsController, ScreenshotsController } from "./screenshots/screenshots.controller.js";
import { ScreenshotsService } from "./screenshots/screenshots.service.js";
import { screenshotStorageProvider } from "./screenshots/storage.js";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        pinoHttp: {
          level: config.get("LOG_LEVEL"),
          genReqId: (req) => {
            const header = req.headers["x-request-id"];
            return typeof header === "string" && /^[\w-]{1,64}$/.test(header) ? header : randomUUID();
          },
          // Secret-safe logging: no headers, no query strings (may carry tokens), no bodies.
          serializers: {
            req: (req: { id: string; method: string; url: string }) => ({
              id: req.id,
              method: req.method,
              path: req.url.split("?")[0],
            }),
          },
          redact: {
            paths: [
              'res.headers["set-cookie"]',
              "*.cookie",
              "*.password",
              "*.token",
              "*.authToken",
              "*.accessToken",
              "*.refreshToken",
            ],
            censor: "[REDACTED]",
          },
          transport: config.get("NODE_ENV") === "development" ? { target: "pino-pretty" } : undefined,
        },
      }),
    }),
    DatabaseModule,
  ],
  controllers: [HealthController, AuthController, EmployeesController, DevicesController, AttendanceController, CorrectionsController, ActivityController, MonitoringSettingsController, ScreenshotsController, ScreenshotSettingsController],
  providers: [
    AuthService,
    EmployeesService,
    DevicesService,
    AttendanceService,
    TimesheetService,
    CorrectionsService,
    EmployeeLocks,
    policyProvider,
    MonitoringSettingsService,
    ActivityService,
    RetentionService,
    screenshotStorageProvider,
    ScreenshotSettingsService,
    ScreenshotsService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
