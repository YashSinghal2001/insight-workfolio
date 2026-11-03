import { z } from "zod";
import type { EmployeeRef, UserRef } from "./api.js";
import { employeeCodeSchema } from "./schemas.js";

/**
 * Project and task time tracking (F11). Separate from attendance: a task timer never creates or
 * changes a shift or break. Defaults pending business approval are in docs/project-time.md:
 * admins own projects and tasks; employees log time on open tasks of active projects they are
 * assigned to; one timer at a time; only while clocked in and not on a break; a break or clock-out
 * ends the timer at that recorded time. Timer time is wall-clock time, not a productivity measure.
 */
export const PROJECT_STATUSES = ["ACTIVE", "ARCHIVED"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const TASK_STATUSES = ["OPEN", "CLOSED"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
/** Why a timer entry ended: the employee paused or stopped it, or attendance ended it. */
export const TIME_END_REASONS = ["PAUSED", "STOPPED", "BREAK", "CLOCK_OUT"] as const;
export type TimeEndReason = (typeof TIME_END_REASONS)[number];

const name = z.string().trim().min(1, "Required").max(120);
const description = z.string().trim().max(1000).optional().transform((v) => v || null);

export const createProjectSchema = z.strictObject({ code: employeeCodeSchema, name, description });
export const updateProjectSchema = z
  .strictObject({
    name: name.optional(),
    // Absent: unchanged; "" or null: cleared.
    description: z.string().trim().max(1000).nullable().optional().transform((v) => (v === undefined ? undefined : v || null)),
    status: z.enum(PROJECT_STATUSES).optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined || v.status !== undefined, "Nothing to change");
export const assignEmployeeSchema = z.strictObject({ employeeId: z.uuid() });
export const createTaskSchema = z.strictObject({ title: name });
export const updateTaskSchema = z
  .strictObject({ title: name.optional(), status: z.enum(TASK_STATUSES).optional() })
  .refine((v) => v.title !== undefined || v.status !== undefined, "Nothing to change");
export const startTimerSchema = z.strictObject({ taskId: z.uuid() });

export interface ProjectTask {
  id: string;
  projectId: string;
  title: string;
  status: TaskStatus;
}

export interface Project {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  createdAt: string;
  tasks: ProjectTask[];
  /** Admin view only: employees currently assigned. */
  members?: (EmployeeRef & { assignedAt: string })[];
}

export interface ProjectHistoryItem {
  action: string;
  at: string;
  by: UserRef;
  details: Record<string, unknown>;
}

export interface TimeEntry {
  id: string;
  employee: EmployeeRef;
  project: { id: string; code: string; name: string };
  task: { id: string; title: string };
  /** Server time when the timer started and ended (null while running). */
  startedAt: string;
  endedAt: string | null;
  endReason: TimeEndReason | null;
  /** endedAt − startedAt; null while running. */
  durationMs: number | null;
}

export interface TimerState {
  running: TimeEntry | null;
  /** The latest entry when it was paused and its task can still be resumed. */
  paused: TimeEntry | null;
  attendance: { clockedIn: boolean; onBreak: boolean };
  serverTime: string;
}

export interface ProjectTimeSummary {
  from: string;
  to: string;
  /** Completed entries only, attributed to the employee's local date of the start. */
  byProject: { project: { id: string; code: string; name: string; status: ProjectStatus }; taskMs: number; entries: number; byTask: { task: { id: string; title: string }; taskMs: number; entries: number }[] }[];
  /** Task-timer time and attendance worked time are separate measures; neither is productivity. */
  byEmployee: { employee: EmployeeRef; taskMs: number; entries: number; attendanceNetMs: number }[];
  /** Timers running now (not in the totals). */
  running: number;
}

/**
 * When attendance ends a running timer: the first break still going at or after the timer's start
 * (one synced later may even cover the start), or the clock-out, whichever is earlier; never before
 * the timer started (no negative or invented time). Null while the shift is open and no break followed.
 */
export function attendanceEnd(
  startedAt: string,
  shift: { clockOutAt: string | null; breaks: { startedAt: string; endedAt: string | null }[] },
): { at: string; reason: "BREAK" | "CLOCK_OUT" } | null {
  const brk = shift.breaks.filter((b) => (b.endedAt ?? "9999") > startedAt).map((b) => b.startedAt).sort()[0];
  const end = brk && (!shift.clockOutAt || brk <= shift.clockOutAt) ? { at: brk, reason: "BREAK" as const } : shift.clockOutAt ? { at: shift.clockOutAt, reason: "CLOCK_OUT" as const } : null;
  return end && end.at < startedAt ? { ...end, at: startedAt } : end;
}

/** Sums completed entries; the reference the summary totals are tested against. */
export const totalMs = (entries: readonly Pick<TimeEntry, "durationMs">[]) => entries.reduce((n, e) => n + (e.durationMs ?? 0), 0);
