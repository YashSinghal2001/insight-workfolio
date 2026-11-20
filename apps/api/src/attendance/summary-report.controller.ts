import { Controller, Get, Query, Res, StreamableFile } from "@nestjs/common";
import { dailyExportFilename, dailyExportQuerySchema, EXPORT_CONTENT_TYPES, summaryReportFilename, summaryReportQuerySchema, type DailyExportQuery, type SummaryReportQuery } from "@workfolio/shared";
import type { Response } from "express";
import { CurrentUser, RequirePermission, TeamScoped } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { SummaryReportService } from "./summary-report.service.js";

@Controller({ path: "attendance", version: "1" })
export class SummaryReportController {
  constructor(private readonly reports: SummaryReportService) {}

  /** Worked days and worked / active / idle / break minutes per employee for [from, to] (≤ 92 days); JSON or XLSX (not stored). */
  @Get("summary-report")
  @RequirePermission("attendance:read-all")
  @TeamScoped()
  async summaryReport(@Query(new ZodPipe(summaryReportQuerySchema)) q: SummaryReportQuery, @Res({ passthrough: true }) res: Response, @CurrentUser() user: AuthContext) {
    if (q.format === "json") return this.reports.report(q, user);
    const { body, rows } = await this.reports.xlsx(q, user);
    res.setHeader("content-type", EXPORT_CONTENT_TYPES.xlsx);
    res.setHeader("x-export-rows", String(rows));
    res.setHeader("content-disposition", `attachment; filename="${summaryReportFilename(q.from, q.to)}"`);
    res.setHeader("cache-control", "no-store, private, max-age=0");
    return new StreamableFile(body);
  }

  /** One tab (worked / late / leave / absent) of the daily attendance report for a local date, as CSV or XLSX. Not stored. */
  @Get("daily/export")
  @RequirePermission("attendance:read-all")
  @TeamScoped()
  async dailyExport(@Query(new ZodPipe(dailyExportQuerySchema)) q: DailyExportQuery, @Res({ passthrough: true }) res: Response, @CurrentUser() user: AuthContext) {
    const { body, rows } = await this.reports.daily(q, user);
    res.setHeader("content-type", EXPORT_CONTENT_TYPES[q.format]);
    res.setHeader("x-export-rows", String(rows));
    res.setHeader("content-disposition", `attachment; filename="${dailyExportFilename(q.date, q.tab, q.format)}"`);
    res.setHeader("cache-control", "no-store, private, max-age=0");
    return q.format === "xlsx" ? new StreamableFile(body as Buffer) : body;
  }
}
