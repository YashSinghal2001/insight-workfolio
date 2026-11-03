import { z } from "zod";

export const CORRECTION_TYPES = ["MISSING_CLOCK_IN", "MISSING_CLOCK_OUT", "BREAK_TIME", "ATTENDANCE_TIME"] as const;
export type CorrectionType = (typeof CORRECTION_TYPES)[number];
export const CORRECTION_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;
export type CorrectionStatus = (typeof CORRECTION_STATUSES)[number];

const instant = z.iso.datetime({ offset: true }).transform((v) => new Date(v).toISOString());
const reason = z.string().trim().min(3, "Please give a reason (at least 3 characters)").max(1000);

/**
 * What an employee may ask to change. All times are UTC instants; clients convert from the
 * employee's time zone (see zonedToUtc). Nothing changes until an admin approves.
 */
export const createCorrectionSchema = z
  .discriminatedUnion("type", [
    // A whole shift was never recorded.
    z.strictObject({ type: z.literal("MISSING_CLOCK_IN"), clockInAt: instant, clockOutAt: instant, reason }),
    // The shift is still open (forgotten clock-out). An open break must be closed too.
    z.strictObject({ type: z.literal("MISSING_CLOCK_OUT"), sessionId: z.uuid(), clockOutAt: instant, breakEndedAt: instant.optional(), reason }),
    z.strictObject({ type: z.literal("BREAK_TIME"), sessionId: z.uuid(), breakId: z.uuid(), startedAt: instant, endedAt: instant, reason }),
    z.strictObject({ type: z.literal("ATTENDANCE_TIME"), sessionId: z.uuid(), clockInAt: instant.optional(), clockOutAt: instant.optional(), reason }),
  ])
  .superRefine((v, ctx) => {
    const pair = (a?: string, b?: string, msg = "End must be after start") => a && b && a >= b && ctx.addIssue({ code: "custom", message: msg });
    if (v.type === "MISSING_CLOCK_IN") pair(v.clockInAt, v.clockOutAt, "Clock-out must be after clock-in");
    if (v.type === "BREAK_TIME") pair(v.startedAt, v.endedAt);
    if (v.type === "ATTENDANCE_TIME") {
      if (!v.clockInAt && !v.clockOutAt) ctx.addIssue({ code: "custom", message: "Give a corrected clock-in or clock-out time" });
      pair(v.clockInAt, v.clockOutAt, "Clock-out must be after clock-in");
    }
  });
export type CreateCorrectionInput = z.input<typeof createCorrectionSchema>;
export type CreateCorrection = z.infer<typeof createCorrectionSchema>;

/** Approving and rejecting both require the reviewer's reason (kept in the audit trail). */
export const reviewCorrectionSchema = z.strictObject({ reason });

export const listCorrectionsQuerySchema = z.object({
  status: z.enum(CORRECTION_STATUSES).optional(),
  employeeId: z.uuid().optional(),
  /** "true": only the caller's own profile (from the session), even for administrators. */
  mine: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
  .refine((q) => !(q.mine && q.employeeId), { message: "Use either mine or employeeId, not both", path: ["mine"] });
