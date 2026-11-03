import { Controller, Get, Query } from "@nestjs/common";
import { auditQuerySchema, type AuditQuery } from "@workfolio/shared";
import { RequirePermission } from "../auth/auth.guard.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { AuditService } from "./audit.service.js";

@Controller({ path: "audit", version: "1" })
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermission("audit:read")
  list(@Query(new ZodPipe(auditQuerySchema)) q: AuditQuery) {
    return this.audit.list(q);
  }
}
