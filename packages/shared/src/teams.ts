import { z } from "zod";
import { ACTIVITY_RANGE_MAX_DAYS, applicationCategorySchema, type ApplicationCategoryInput, type ApplicationCategoryRule } from "./activity.js";
import type { ActivityPeriodTotals, EmployeeRef, UserRef } from "./api.js";

// ---- Teams (W40) and team heads (W41) --------------------------------------------------------
// An employee may belong to several teams. A team's head (any account) reads only the members of
// the active teams they head (docs/teams.md). Teams are deactivated, never deleted.

const DAY_MS = 86_400_000;
const name = z.string().trim().min(1).max(80);
/** The head's account id (users.id), or null for no head. */
const headUserId = z.uuid().nullable();

export const teamCreateSchema = z.strictObject({ name, headUserId: headUserId.default(null) });
export type TeamCreateInput = z.infer<typeof teamCreateSchema>;

export const teamUpdateSchema = z
  .strictObject({ name: name.optional(), headUserId: headUserId.optional(), active: z.boolean().optional() })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Nothing to change");
export type TeamUpdateInput = z.infer<typeof teamUpdateSchema>;

/** PUT /teams/:id/members: the team's complete member list (employee profile ids). */
export const teamMembersSchema = z.strictObject({ employeeIds: z.array(z.uuid()).max(1000).refine((ids) => new Set(ids).size === ids.length, "Duplicate employee") });
export type TeamMembersInput = z.infer<typeof teamMembersSchema>;

export interface Team {
  id: string;
  name: string;
  active: boolean;
  head: (UserRef & { fullName: string | null }) | null;
  members: EmployeeRef[];
  createdAt: string;
  updatedAt: string;
}

/** F05 per team: a team's own application label (PUT /teams/:id/labels replaces the current one for the same app). */
export const teamLabelSchema = applicationCategorySchema;
export type TeamLabelInput = ApplicationCategoryInput;
export type TeamLabel = Omit<ApplicationCategoryRule, "updatedAt"> & { teamId: string };

/** F05 per team: the members' activity totals for local dates [from, to] (each member in their own zone). */
export const teamProductivityQuerySchema = z
  .strictObject({ from: z.iso.date(), to: z.iso.date() })
  .refine((r) => r.from <= r.to, "from must not be after to")
  .refine((r) => Date.parse(r.to) - Date.parse(r.from) <= (ACTIVITY_RANGE_MAX_DAYS - 1) * DAY_MS, `Range is limited to ${ACTIVITY_RANGE_MAX_DAYS} days`);
export type TeamProductivityQuery = z.infer<typeof teamProductivityQuerySchema>;

export interface TeamProductivityRow extends ActivityPeriodTotals {
  team: { id: string; name: string };
  memberCount: number;
  /** Productive ACTIVE time of all members; null when no application labels are configured. */
  productiveMs: number | null;
  /** productiveMs / clockedInMs; null when labels are not configured or nothing was clocked in. */
  productiveShare: number | null;
}
export interface TeamProductivityResponse {
  from: string;
  to: string;
  categoriesConfigured: boolean;
  items: TeamProductivityRow[];
}
