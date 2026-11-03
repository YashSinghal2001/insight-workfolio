import { z } from "zod";
import type { ActivityPeriodTotals, ActivityReportDay, ActivitySummaryResponse, ActivityTimelineItem, EmployeeRef, Paginated } from "./api.js";
import { addDays, localDate, zonedToUtc } from "./timesheet.js";

// ---- Policy -------------------------------------------------------------------------

/** What the desktop agent needs: whether to monitor at all, and how. Decided by the server. */
export interface MonitoringPolicy {
  /** Organization-wide switch. Off = nothing is collected and uploads are refused. */
  enabled: boolean;
  /** How often the foreground application and idle time are sampled. */
  sampleSeconds: number;
  /** No keyboard/mouse input for this long counts as idle (not application usage). */
  idleThresholdSeconds: number;
  /**
   * Applications whose foreground use never counts as idle (e.g. video calls), by recorded identifier:
   * macOS bundle id or Windows exe file name, matched case-insensitively by the desktop. Older desktops ignore it.
   */
  idleExcludedApps: string[];
}

/** Full admin-managed settings (append-only history; see migration 0005). */
export interface MonitoringSettings extends MonitoringPolicy {
  /** Activity intervals older than this are purged, but only once `retentionApproved`. */
  retentionDays: number;
  /** HR/Legal approved the retention period; until then nothing is deleted automatically. */
  retentionApproved: boolean;
  /** Notice every employee must have acknowledged before activity is recorded. */
  noticeVersion: string;
}

/** Proposed defaults (pending HR/Legal approval). Sampling and idle can be overridden by API env. */
export const DEFAULT_NOTICE_VERSION = "2026-10-draft-1";
export const DEFAULT_MONITORING_SETTINGS: MonitoringSettings = {
  enabled: true,
  sampleSeconds: 15,
  idleThresholdSeconds: 300,
  idleExcludedApps: [],
  retentionDays: 30,
  retentionApproved: false,
  noticeVersion: DEFAULT_NOTICE_VERSION,
};
export const DEFAULT_MONITORING_POLICY: MonitoringPolicy = { enabled: true, sampleSeconds: 15, idleThresholdSeconds: 300, idleExcludedApps: [] };

export const SETTINGS_LIMITS = {
  sampleSeconds: { min: 5, max: 300 },
  idleThresholdSeconds: { min: 30, max: 3600 },
  retentionDays: { min: 7, max: 3650 },
} as const;

/** Up to 100 identifiers, trimmed, no duplicates (case-insensitive; the first spelling is kept). */
export const idleExcludedAppsSchema = z
  .array(z.string().trim().min(1).max(255))
  .max(100)
  .transform((v) => v.filter((x, i) => v.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i));

export const monitoringSettingsSchema = z
  .object({
    enabled: z.boolean(),
    sampleSeconds: z.number().int().min(SETTINGS_LIMITS.sampleSeconds.min).max(SETTINGS_LIMITS.sampleSeconds.max),
    idleThresholdSeconds: z.number().int().min(SETTINGS_LIMITS.idleThresholdSeconds.min).max(SETTINGS_LIMITS.idleThresholdSeconds.max),
    retentionDays: z.number().int().min(SETTINGS_LIMITS.retentionDays.min).max(SETTINGS_LIMITS.retentionDays.max),
    retentionApproved: z.boolean(),
    /** Omitted = keep the current list (older clients). */
    idleExcludedApps: idleExcludedAppsSchema.optional(),
    noticeVersion: z.string().min(1).max(64),
    /** Why the change was made; kept in the settings history. */
    reason: z.string().trim().min(1).max(1000),
  })
  .strict()
  .refine((v) => v.idleThresholdSeconds >= 2 * v.sampleSeconds, {
    message: "The idle threshold must be at least two sampling intervals",
    path: ["idleThresholdSeconds"],
  });
export type MonitoringSettingsInput = z.infer<typeof monitoringSettingsSchema>;

/**
 * The employee-visible notice. Stored on the server (append-only, one row per version) so the
 * wording can change without a desktop release; acknowledging is per version.
 */
export interface MonitoringNotice {
  version: string;
  title: string;
  points: string[];
  /** Wording not yet reviewed by HR/Legal; shown as a draft to employees. */
  draft: boolean;
  createdAt: string;
}

export const noticeSchema = z
  .object({
    version: z.string().regex(/^[\w.-]{1,64}$/, "Use 1-64 letters, digits, dots, dashes or underscores"),
    title: z.string().trim().min(1).max(200),
    points: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
    draft: z.boolean(),
  })
  .strict();
export type NoticeInput = z.infer<typeof noticeSchema>;

/** What the desktop agent collects and never collects, shown with the notice and status. */
export const COLLECTED_DATA = {
  collected: [
    "Foreground application name and identifier (e.g. Safari, com.apple.Safari)",
    "Start and end time of each application interval",
    "Idle time: no keyboard or mouse input for the idle threshold, or the screen is locked",
  ],
  never: ["Keystrokes or anything you type", "Clipboard contents", "Window titles or document names", "Websites, URLs or browser history", "Screenshots, unless your organization turns them on and you acknowledge the separate screenshot notice"],
} as const;

// ---- Requests -------------------------------------------------------------------------

export const ACTIVITY_KINDS = ["ACTIVE", "IDLE"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export const ACTIVITY_BATCH_MAX = 500;
/** Timeline and summary queries are limited to this many days. */
export const ACTIVITY_RANGE_MAX_DAYS = 31;

const instant = z.iso.datetime({ offset: true });
/** App names/identifiers only: anything else (titles, URLs, documents) is rejected by `strict()`. */
const appText = z.string().trim().min(1).max(255);

export const activityIntervalSchema = z
  .object({
    /** Client UUID; the idempotency key. */
    id: z.uuid(),
    kind: z.enum(ACTIVITY_KINDS),
    applicationIdentifier: appText.nullable().optional(),
    applicationName: appText.nullable().optional(),
    startedAt: instant,
    endedAt: instant,
  })
  .strict()
  .refine((v) => Date.parse(v.endedAt) > Date.parse(v.startedAt), "endedAt must be after startedAt")
  .refine((v) => Date.parse(v.endedAt) - Date.parse(v.startedAt) <= 24 * 3_600_000, "Interval longer than 24 hours")
  .refine((v) => (v.kind === "ACTIVE" ? !!v.applicationName : !v.applicationName && !v.applicationIdentifier), {
    message: "ACTIVE intervals need an application name; IDLE intervals must not have one",
  });
export type ActivityIntervalInput = z.infer<typeof activityIntervalSchema>;

export const activitySyncSchema = z
  .object({
    /** Device clock at upload; used to correct clock skew like attendance sync. */
    sentAt: instant,
    platform: z.enum(["macos", "windows"]),
    intervals: z.array(activityIntervalSchema).min(1).max(ACTIVITY_BATCH_MAX),
  })
  .strict();
export type ActivitySyncRequest = z.infer<typeof activitySyncSchema>;

export const consentSchema = z.object({ noticeVersion: z.string().min(1).max(64) }).strict();

export const retentionRunSchema = z.object({ confirm: z.literal(true) }).strict();

const DAY_MS = 86_400_000;
export const activityQuerySchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    employeeId: z.uuid().optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .refine((r) => r.from <= r.to, "from must not be after to")
  .refine((r) => Date.parse(r.to) - Date.parse(r.from) <= (ACTIVITY_RANGE_MAX_DAYS - 1) * DAY_MS, `Range is limited to ${ACTIVITY_RANGE_MAX_DAYS} days`);
export type ActivityQuery = z.infer<typeof activityQuerySchema>;

// ---- Aggregation --------------------------------------------------------------------------

export interface ActivityIntervalRecord {
  kind: ActivityKind;
  applicationIdentifier: string | null;
  applicationName: string | null;
  startedAt: string;
  endedAt: string;
}

export interface ActivityAppTotal {
  applicationIdentifier: string | null;
  applicationName: string;
  activeMs: number;
}

export interface ActivityDay {
  date: string;
  activeMs: number;
  idleMs: number;
}

export interface ActivitySummaryTotals {
  activeMs: number;
  idleMs: number;
  applications: ActivityAppTotal[];
  days: ActivityDay[];
}

/**
 * Reference aggregation: totals for local dates [from, to] in `timeZone`. Intervals are split at
 * local midnight and clipped to the range, so no time is counted twice or on the wrong day.
 * Idle time is never app usage. The API aggregates in SQL (no row transfer); its tests check
 * that both agree on large datasets.
 */
export function summarizeActivity(intervals: ActivityIntervalRecord[], opts: { from: string; to: string; timeZone: string }): ActivitySummaryTotals {
  const bounds: { date: string; start: number; end: number }[] = [];
  for (let d = opts.from; d <= opts.to; d = addDays(d, 1)) {
    bounds.push({ date: d, start: Date.parse(zonedToUtc(`${d}T00:00`, opts.timeZone)), end: Date.parse(zonedToUtc(`${addDays(d, 1)}T00:00`, opts.timeZone)) });
  }
  const days = new Map<string, ActivityDay>();
  const apps = new Map<string, ActivityAppTotal>();
  for (const i of intervals) {
    const s = Date.parse(i.startedAt);
    const e = Date.parse(i.endedAt);
    for (const b of bounds) {
      const ms = Math.min(e, b.end) - Math.max(s, b.start);
      if (ms <= 0) continue;
      const day = days.get(b.date) ?? { date: b.date, activeMs: 0, idleMs: 0 };
      if (i.kind === "IDLE") day.idleMs += ms;
      else {
        day.activeMs += ms;
        const key = i.applicationIdentifier ?? `name:${i.applicationName}`;
        const app = apps.get(key) ?? { applicationIdentifier: i.applicationIdentifier, applicationName: i.applicationName ?? "Unknown", activeMs: 0 };
        app.activeMs += ms;
        apps.set(key, app);
      }
      days.set(b.date, day);
    }
  }
  const dayList = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  return {
    activeMs: dayList.reduce((n, d) => n + d.activeMs, 0),
    idleMs: dayList.reduce((n, d) => n + d.idleMs, 0),
    applications: [...apps.values()].sort((a, b) => b.activeMs - a.activeMs),
    days: dayList,
  };
}

/** Local date helper re-exported for clients computing "today". */
export const todayIn = (timeZone: string, now = Date.now()) => localDate(now, timeZone);

// ---- Application productivity labels (F05) ---------------------------------------------------
// Admin rules applied when reports are read, so a rule change also relabels past activity
// (retroactive, unlike Workfolio). No rule: UNCLASSIFIED, never guessed. Idle time is never productive.

export const APPLICATION_CATEGORIES = ["PRODUCTIVE", "NEUTRAL", "UNPRODUCTIVE"] as const;
export type ApplicationCategory = (typeof APPLICATION_CATEGORIES)[number] | "UNCLASSIFIED";
/** IDENTIFIER: the bundle/application id; NAME: the application name. Both exact, case-insensitive. */
export const APPLICATION_MATCH_KINDS = ["IDENTIFIER", "NAME"] as const;
export type ApplicationMatchKind = (typeof APPLICATION_MATCH_KINDS)[number];

export interface ApplicationCategoryRule {
  id: string;
  matchKind: ApplicationMatchKind;
  value: string;
  category: (typeof APPLICATION_CATEGORIES)[number];
  createdAt: string;
  updatedAt: string;
}

export const applicationCategorySchema = z.strictObject({ matchKind: z.enum(APPLICATION_MATCH_KINDS), value: appText, category: z.enum(APPLICATION_CATEGORIES) });
export const applicationCategoryUpdateSchema = z.strictObject({ category: z.enum(APPLICATION_CATEGORIES) });
export type ApplicationCategoryInput = z.infer<typeof applicationCategorySchema>;

/** The rule for an application: an IDENTIFIER rule first, then a NAME rule; otherwise UNCLASSIFIED. */
export function categorizeApplication(
  app: { applicationIdentifier: string | null; applicationName: string | null },
  rules: readonly Pick<ApplicationCategoryRule, "id" | "matchKind" | "value" | "category">[],
): { category: ApplicationCategory; ruleId: string | null } {
  const eq = (a: string | null, b: string) => a !== null && a.toLowerCase() === b.toLowerCase();
  const r = rules.find((x) => x.matchKind === "IDENTIFIER" && eq(app.applicationIdentifier, x.value)) ?? rules.find((x) => x.matchKind === "NAME" && eq(app.applicationName, x.value));
  return r ? { category: r.category, ruleId: r.id } : { category: "UNCLASSIFIED", ruleId: null };
}

/**
 * F05 per team: an employee's label for an application. `teamRules` holds the current rules of each
 * active team the employee is in. Teams with a rule for the app that all agree win; no team rule, or
 * teams that disagree, fall back to the organisation rule (docs/teams.md).
 */
export function categorizeForEmployee(
  app: { applicationIdentifier: string | null; applicationName: string | null },
  orgRules: Parameters<typeof categorizeApplication>[1],
  teamRules: readonly Parameters<typeof categorizeApplication>[1][],
): ApplicationCategory {
  const team = new Set(teamRules.map((r) => categorizeApplication(app, r)).filter((c) => c.ruleId !== null).map((c) => c.category));
  return team.size === 1 ? [...team][0]! : categorizeApplication(app, orgRules).category;
}

/** Additive fields of GET /activity/summary (existing fields are unchanged). */
export interface ActivityCategoryTotals {
  /** ACTIVE time only, split by the application's label. */
  productiveMs: number;
  neutralMs: number;
  unproductiveMs: number;
  unclassifiedMs: number;
  /** productiveMs / clockedInMs; null when nothing was clocked in. */
  productiveShare: number | null;
  /** At least one current rule exists. */
  categoriesConfigured: boolean;
}
export type CategorizedAppTotal = ActivityAppTotal & { category: ApplicationCategory };
/** One day of GET /activity/summary with its label split (additive; same rules as the range totals). */
export type CategorizedActivityDay = ActivityReportDay & Omit<ActivityCategoryTotals, "categoriesConfigured">;
/** GET /activity/summary with the application labels. */
export type CategorizedActivitySummary = Omit<ActivitySummaryResponse, "applications" | "days"> &
  ActivityCategoryTotals & { applications: CategorizedAppTotal[]; days: CategorizedActivityDay[] };

/** GET /activity/timeline item with its label (additive). IDLE intervals have no label (null). */
export type CategorizedTimelineItem = ActivityTimelineItem & { category: ApplicationCategory | null };

// ---- Organisation overview (admin) ---------------------------------------------------------

/** GET /activity/overview: one row per employee, the range applied in each employee's own time zone. */
export const activityOverviewQuerySchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    q: z.string().trim().max(100).optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((r) => r.from <= r.to, "from must not be after to")
  .refine((r) => Date.parse(r.to) - Date.parse(r.from) <= (ACTIVITY_RANGE_MAX_DAYS - 1) * DAY_MS, `Range is limited to ${ACTIVITY_RANGE_MAX_DAYS} days`);
export type ActivityOverviewQuery = z.infer<typeof activityOverviewQuerySchema>;

/** Totals as in /activity/summary; unobservedMs is computed over the whole range. */
export interface ActivityOverviewRow extends ActivityPeriodTotals {
  employee: EmployeeRef;
  /** Productive ACTIVE time; null when no application labels are configured. */
  productiveMs: number | null;
  /** productiveMs / clockedInMs; null when labels are not configured or nothing was clocked in. */
  productiveShare: number | null;
  /** Last activity upload from this employee's agent (any date). */
  lastReceivedAt: string | null;
}
export interface ActivityOverviewResponse extends Paginated<ActivityOverviewRow> {
  from: string;
  to: string;
  categoriesConfigured: boolean;
}
