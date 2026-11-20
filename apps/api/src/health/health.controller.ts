import { Controller, Get, HttpStatus, Inject, Logger, Res } from "@nestjs/common";
import { pingDatabase, type DatabaseClient } from "@workfolio/database";
import type { HealthResponse, ReadinessCheck, ReadinessResponse } from "@workfolio/shared";
import type { Response } from "express";
import { readFileSync } from "node:fs";
import { Public } from "../auth/auth.guard.js";
import { DATABASE } from "../database/database.module.js";
import { FILE_STORAGE, type FileStorage } from "../screenshots/storage.js";

const READY_TIMEOUT_MS = 2000;
/** Never written; a lookup proves the provider authenticates and answers (Graph: token + item GET; Drive: token + list). */
const STORAGE_PROBE_KEY = "readiness-probe";
/** dist/health/ -> apps/api/package.json (the same relative path from src/health/). */
const VERSION = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
/** Only a plain hex commit id is echoed back; anything else in the env is not exposed. */
const COMMIT = /^[0-9a-f]{7,40}$/;

@Public()
@Controller({ version: "1" })
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    @Inject(DATABASE) private readonly db: DatabaseClient,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  /** Liveness: the process is up and serving requests. Never touches dependencies. */
  @Get("health")
  health(): HealthResponse {
    const commit = process.env.WORKFOLIO_BUILD_COMMIT ?? "";
    return {
      status: "ok",
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      version: VERSION,
      commit: COMMIT.test(commit) ? commit : null,
    };
  }

  /** Readiness: required dependencies are reachable. 503 when any check fails. */
  @Get("ready")
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessResponse> {
    const [database, storage] = await Promise.all([
      this.check("database", () => pingDatabase(this.db)),
      this.check("storage", async () => {
        const started = Date.now();
        await this.storage.stat(STORAGE_PROBE_KEY);
        return Date.now() - started;
      }),
    ]);
    const ready = database.status === "up" && storage.status === "up";
    res.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: ready ? "ready" : "not_ready",
      checks: { database, storage: { ...storage, provider: this.storage.provider } },
      timestamp: new Date().toISOString(),
    };
  }

  private async check(name: string, probe: () => Promise<number>): Promise<ReadinessCheck> {
    try {
      const latencyMs = await Promise.race([
        probe(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), READY_TIMEOUT_MS).unref()),
      ]);
      return { status: "up", latencyMs };
    } catch (err) {
      // Full error goes to the log only; the response stays generic (no paths, tokens or provider bodies).
      this.logger.warn({ err }, `Readiness check failed: ${name}`);
      return { status: "down", error: "unreachable" };
    }
  }
}
