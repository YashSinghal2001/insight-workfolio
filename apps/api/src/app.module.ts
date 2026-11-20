import { DesktopUpdatesController } from "./desktop-updates/desktop-updates.controller.js";
import { DesktopUpdatesService } from "./desktop-updates/desktop-updates.service.js";
import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { LoggerModule } from "nestjs-pino";
import { ActivityController } from "./activity/activity.controller.js";
import { AlertsController } from "./alerts/alerts.controller.js";
import { AlertsService } from "./alerts/alerts.service.js";
import { ActivityService } from "./activity/activity.service.js";
import { RetentionService } from "./activity/retention.service.js";
import { ActivityCategoriesService } from "./activity/categories.service.js";
import { AuditController } from "./audit/audit.controller.js";
import { AuditService } from "./audit/audit.service.js";
import { AnomaliesController } from "./attendance/anomalies.controller.js";
import { AnomaliesService } from "./attendance/anomalies.service.js";
import { AttendanceController } from "./attendance/attendance.controller.js";
import { AttendanceService } from "./attendance/attendance.service.js";
import { CorrectionsController } from "./attendance/corrections.controller.js";
import { CorrectionsService } from "./attendance/corrections.service.js";
import { TimesheetService } from "./attendance/timesheet.service.js";
import { MonthlyService } from "./attendance/monthly.service.js";
import { EmployeeLocks } from "./common/employee-locks.js";
import { policyProvider } from "./common/policy.js";
import { AuthController } from "./auth/auth.controller.js";
import { AuthGuard } from "./auth/auth.guard.js";
import { AuthService } from "./auth/auth.service.js";
import { validateEnv, type Env } from "./config/env.js";
import { DatabaseModule } from "./database/database.module.js";
import { EmployeeAnalyticsController } from "./employees/analytics.controller.js";
import { EmployeeAnalyticsService } from "./employees/analytics.service.js";
import { DevicesController } from "./devices/devices.controller.js";
import { DevicesService } from "./devices/devices.service.js";
import { EmployeesController } from "./employees/employees.controller.js";
import { EmployeesService } from "./employees/employees.service.js";
import { HealthController } from "./health/health.controller.js";
import { HolidaysController } from "./holidays/holidays.controller.js";
import { HolidaysService } from "./holidays/holidays.service.js";
import { TeamsController } from "./teams/teams.controller.js";
import { TeamsService } from "./teams/teams.service.js";
import { LeaveController } from "./leave/leave.controller.js";
import { LeaveService } from "./leave/leave.service.js";
import { ProjectsController, TaskTimeController } from "./projects/projects.controller.js";
import { ProjectsService } from "./projects/projects.service.js";
import { invitationTransportProvider } from "./employees/invitations.js";
import { mailTransportProvider } from "./reports/mail.js";
import { ReportsController } from "./reports/reports.controller.js";
import { ReportsService } from "./reports/reports.service.js";
import { WebsitesController } from "./websites/websites.controller.js";
import { WebsitesService } from "./websites/websites.service.js";
import { RolesController } from "./roles/roles.controller.js";
import { RolesService } from "./roles/roles.service.js";
import { DailyAttendanceController, ScheduleSettingsController } from "./schedule/schedule.controller.js";
import { ScheduleService } from "./schedule/schedule.service.js";
import { MonitoringSettingsController } from "./settings/monitoring-settings.controller.js";
import { MonitoringSettingsService } from "./settings/monitoring-settings.service.js";
import { EmployeeTrackingController, EmployeeTrackingService } from "./settings/employee-tracking.controller.js";
import { ScreenshotSettingsService } from "./screenshots/screenshot-settings.service.js";
import { ScreenshotSettingsController, ScreenshotsController } from "./screenshots/screenshots.controller.js";
import { ScreenshotsService } from "./screenshots/screenshots.service.js";
import { ONEDRIVE_AUTH, screenshotStorageProvider } from "./screenshots/storage.js";
import { TimelapseController } from "./screenshots/timelapse.controller.js";
import { timelapseEncoderProvider } from "./screenshots/timelapse-encoder.js";
import { TimelapseService } from "./screenshots/timelapse.service.js";
import { GoogleDriveOAuthController, GoogleDriveOAuthService } from "./storage/google-drive-oauth.js";
import { OneDriveController, OneDriveService } from "./storage/onedrive.js";
import { EmailService } from "./notifications/email.service.js";
import { NotificationsController } from "./notifications/notifications.controller.js";
import { NotificationsService } from "./notifications/notifications.service.js";
import { NotificationRulesService } from "./notifications/notification-rules.service.js";

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
  controllers: [AlertsController, HealthController, AuthController, EmployeesController, DevicesController, AttendanceController, CorrectionsController, ActivityController, MonitoringSettingsController, ScreenshotsController, ScreenshotSettingsController, TimelapseController, LeaveController, HolidaysController, TeamsController, ProjectsController, TaskTimeController, ReportsController, WebsitesController, RolesController, AuditController, ScheduleSettingsController, DailyAttendanceController, EmployeeTrackingController, GoogleDriveOAuthController, OneDriveController, DesktopUpdatesController, NotificationsController, AnomaliesController, EmployeeAnalyticsController],
  providers: [
    AlertsService,
    AuthService,
    EmployeesService,
    DevicesService,
    AttendanceService,
    AnomaliesService,
    TimesheetService,
    MonthlyService,
    CorrectionsService,
    EmployeeLocks,
    policyProvider,
    MonitoringSettingsService,
    EmployeeTrackingService,
    ActivityService,
    RetentionService,
    ActivityCategoriesService,
    ScheduleService,
    screenshotStorageProvider,
    ScreenshotSettingsService,
    ScreenshotsService,
    timelapseEncoderProvider,
    TimelapseService,
    LeaveService,
    HolidaysService,
    TeamsService,
    ProjectsService,
    mailTransportProvider,
    invitationTransportProvider,
    EmailService,
    NotificationsService,
    NotificationRulesService,
    ReportsService,
    WebsitesService,
    RolesService,
    AuditService,
    GoogleDriveOAuthService,
    OneDriveService,
    DesktopUpdatesService,
    EmployeeAnalyticsService,
    { provide: ONEDRIVE_AUTH, useExisting: OneDriveService },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
