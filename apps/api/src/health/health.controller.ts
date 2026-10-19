import { Controller, Get, HttpStatus, Inject, Logger, Res } from "@nestjs/common";
import { pingDatabase, type DatabaseClient } from "@workfolio/database";
import type { HealthResponse, ReadinessResponse } from "@workfolio/shared";
import type { Response } from "express";
import { Public } from "../auth/auth.guard.js";
import { DATABASE } from "../database/database.module.js";

const READY_TIMEOUT_MS = 2000;

@Public()
@Controller({ version: "1" })
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(@Inject(DATABASE) private readonly db: DatabaseClient) {}

  /** Liveness: the process is up and serving requests. Never touches dependencies. */
  @Get("health")
  health(): HealthResponse {
    return { status: "ok", uptimeSeconds: Math.round(process.uptime()), timestamp: new Date().toISOString() };
  }

  /** Readiness: required dependencies are reachable. 503 when any check fails. */
  @Get("ready")
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessResponse> {
    let database: ReadinessResponse["checks"][string];
    try {
      const latencyMs = await Promise.race([
        pingDatabase(this.db),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), READY_TIMEOUT_MS).unref()),
      ]);
      database = { status: "up", latencyMs };
    } catch (err) {
      // Full error goes to the log only; the response stays generic.
      this.logger.warn({ err }, "Readiness check failed: database");
      database = { status: "down", error: "unreachable" };
    }
    const ready = database.status === "up";
    res.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ready ? "ready" : "not_ready", checks: { database }, timestamp: new Date().toISOString() };
  }
}
