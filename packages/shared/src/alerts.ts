import { z } from "zod";
import type { EmployeeRef, UserRef } from "./api.js";

/**
 * Custom alert rules (F06, in-app only; docs/alerts.md). A fixed set of kinds computed from data
 * admins can already see (daily attendance status, activity intervals). Nobody is alerted on an
 * organisation holiday or a day with approved leave.
 */
export const ALERT_RULE_KINDS = ["LATE_CLOCK_IN", "NOT_CLOCKED_IN_BY", "IDLE_SHARE_ABOVE", "NO_ACTIVITY_FOR"] as const;
export type AlertRuleKind = (typeof ALERT_RULE_KINDS)[number];

export const ALERT_RULE_KIND_LABEL: Record<AlertRuleKind, string> = {
  LATE_CLOCK_IN: "Late clock-in (work schedule)",
  NOT_CLOCKED_IN_BY: "Not clocked in by a time on a workday",
  IDLE_SHARE_ABOVE: "Idle share of tracked time above a percentage (previous day)",
  NO_ACTIVITY_FOR: "No active input for some minutes while clocked in",
};

/** IDLE_SHARE_ABOVE ignores days with less tracked time than this (too little data to judge). */
export const IDLE_SHARE_MIN_TRACKED_MINUTES = 60;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM");
const name = z.string().trim().min(1).max(120);

export const createAlertRuleSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("LATE_CLOCK_IN"), name }),
  z.strictObject({ kind: z.literal("NOT_CLOCKED_IN_BY"), name, atTime: hhmm }),
  z.strictObject({ kind: z.literal("IDLE_SHARE_ABOVE"), name, threshold: z.number().int().min(1).max(99) }),
  z.strictObject({ kind: z.literal("NO_ACTIVITY_FOR"), name, threshold: z.number().int().min(5).max(720) }),
]);
export type AlertRuleInput = z.infer<typeof createAlertRuleSchema>;

/** The kind never changes; threshold / atTime are checked against the rule's kind by the API. */
export const updateAlertRuleSchema = z
  .strictObject({ name: name.optional(), active: z.boolean().optional(), threshold: z.number().int().min(1).max(720).optional(), atTime: hhmm.optional() })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Nothing to change");
export type AlertRuleUpdate = z.infer<typeof updateAlertRuleSchema>;

export const listAlertsQuerySchema = z.strictObject({ status: z.enum(["open", "acknowledged", "all"]).default("open") });

export interface AlertRule {
  id: string;
  name: string;
  kind: AlertRuleKind;
  /** Percent (IDLE_SHARE_ABOVE) or minutes (NO_ACTIVITY_FOR); otherwise null. */
  threshold: number | null;
  /** Local HH:MM (NOT_CLOCKED_IN_BY); otherwise null. */
  atTime: string | null;
  active: boolean;
  createdBy: UserRef;
  createdAt: string;
  updatedAt: string;
}

export interface Alert {
  id: string;
  rule: { id: string; name: string; kind: AlertRuleKind };
  employee: EmployeeRef;
  /** The employee's local date the alert is about. */
  date: string;
  detail: string;
  createdAt: string;
  acknowledgedBy: UserRef | null;
  acknowledgedAt: string | null;
}
