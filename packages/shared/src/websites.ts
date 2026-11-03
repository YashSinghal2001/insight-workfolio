import { z } from "zod";
import type { EmployeeRef, UserRef } from "./api.js";

/**
 * Website usage (F04): domain names only, recorded by an explicit browser extension the employee
 * connects, only while the organization's website policy is on, the employee has acknowledged the
 * website notice, they are clocked in and not on a break, and (in production) the operator has
 * confirmed HR/Legal approval. Never: paths, queries, titles, page content, history, private windows.
 */
// WHATWG URL (global in Node and browsers); this package compiles without DOM or Node types.
declare const URL: new (input: string) => { hostname: string };

export const DEFAULT_WEBSITE_NOTICE_VERSION = "2026-10-websites-draft-1";
export const WEBSITE_CATEGORIES = ["PRODUCTIVE", "NEUTRAL", "UNPRODUCTIVE"] as const;
export type WebsiteCategory = (typeof WEBSITE_CATEGORIES)[number] | "UNCLASSIFIED";
/** What a rule may assign: a category, or an explicit Unclassified (e.g. to exempt one subdomain). New rules start as Unclassified. */
export const WEBSITE_RULE_CATEGORIES = ["UNCLASSIFIED", ...WEBSITE_CATEGORIES] as const;
export const WEBSITE_MATCHES = ["EXACT", "SUBDOMAINS"] as const;
export type WebsiteMatch = (typeof WEBSITE_MATCHES)[number];
/** One interval covers at most this long; the extension splits longer visits. */
export const WEBSITE_INTERVAL_MAX_SECONDS = 900;
export const WEBSITE_BATCH_MAX = 100;
export const WEBSITE_RANGE_MAX_DAYS = 31;

export const WEBSITE_DATA = {
  collected: [
    "The website's domain name only (e.g. docs.example.com), from the browser tab in front",
    "When you started and stopped using that site, while you are clocked in and not on a break",
    "Which connected browser sent it (the name you gave it when connecting)",
  ],
  never: [
    "Page addresses after the domain (paths), search terms or anything after '?'",
    "Page titles, page content, form entries, passwords or anything you type",
    "Browser history, bookmarks, downloads or cookies",
    "Private or incognito windows (the extension does not run there)",
    "Time while the browser is not in front, you are idle, on a break or clocked out",
  ],
} as const;

/**
 * A website domain as stored: lowercase ASCII (international names in punycode), no trailing dot,
 * a leading "www." removed, at least two labels. Anything else (URLs, paths, ports, IP addresses,
 * "localhost", user info) is not a domain and gives null.
 */
export function normalizeDomain(input: string): string | null {
  if (typeof input !== "string" || input.length > 260 || /[\s/\\?#@:%]/.test(input)) return null;
  let host: string;
  try {
    host = new URL(`http://${input}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.$/, "").replace(/^www\./, "");
  if (host.length > 253 || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) return null;
  const labels = host.split(".");
  if (labels.length < 2 || /^\d+$/.test(labels.at(-1)!)) return null;
  return labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) ? host : null;
}

export interface WebsiteCategoryRule {
  id: string;
  domain: string;
  match: WebsiteMatch;
  category: (typeof WEBSITE_RULE_CATEGORIES)[number];
}

/**
 * The admin rule that applies to a domain. Precedence: an EXACT rule for the domain, then the
 * SUBDOMAINS rule with the longest (most specific) domain that equals or contains it. No rule:
 * UNCLASSIFIED. Never guessed.
 */
export function categorize(domain: string, rules: readonly WebsiteCategoryRule[]): { category: WebsiteCategory; ruleId: string | null } {
  const exact = rules.find((r) => r.match === "EXACT" && r.domain === domain);
  if (exact) return { category: exact.category, ruleId: exact.id };
  const sub = rules
    .filter((r) => r.match === "SUBDOMAINS" && (domain === r.domain || domain.endsWith(`.${r.domain}`)))
    .sort((a, b) => b.domain.length - a.domain.length)[0];
  return sub ? { category: sub.category, ruleId: sub.id } : { category: "UNCLASSIFIED", ruleId: null };
}

const domainField = z.string().transform((v, ctx) => normalizeDomain(v) ?? (ctx.addIssue({ code: "custom", message: "Not a website domain" }), z.NEVER));

export const websitePolicySchema = z.strictObject({
  enabled: z.boolean(),
  retentionDays: z.number().int().min(1).max(365),
  noticeVersion: z.string().regex(/^[\w.-]{1,64}$/),
  reason: z.string().trim().min(3).max(500),
});
export const websiteCategorySchema = z.strictObject({ domain: domainField, match: z.enum(WEBSITE_MATCHES), category: z.enum(WEBSITE_RULE_CATEGORIES).default("UNCLASSIFIED") });
export const websiteCategoryUpdateSchema = z.strictObject({ category: z.enum(WEBSITE_RULE_CATEGORIES) });
export const websitePairSchema = z.strictObject({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{8}$/), label: z.string().trim().min(1).max(60) });
export const websiteIntervalsSchema = z.strictObject({
  sentAt: z.iso.datetime({ offset: true }),
  intervals: z
    .array(z.strictObject({ id: z.uuid(), domain: z.string().max(260), startedAt: z.iso.datetime({ offset: true }), endedAt: z.iso.datetime({ offset: true }) }))
    .min(1)
    .max(WEBSITE_BATCH_MAX),
});
export const websiteRangeSchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    employeeId: z.uuid().optional(),
    category: z.enum(WEBSITE_RULE_CATEGORIES).optional(),
    /** A domain and its subdomains (normalized). */
    domain: domainField.optional(),
  })
  .refine((r) => r.from <= r.to, "from must not be after to")
  .refine((r) => Date.parse(r.to) - Date.parse(r.from) <= (WEBSITE_RANGE_MAX_DAYS - 1) * 86_400_000, `Range is limited to ${WEBSITE_RANGE_MAX_DAYS} days`);

export interface WebsitePolicy {
  enabled: boolean;
  retentionDays: number;
  noticeVersion: string;
  /** Production only: the operator's confirmation (env) that HR/Legal approved collection. */
  productionApproved: boolean;
  changedBy: UserRef | null;
  reason: string | null;
  effectiveAt: string | null;
}

export interface WebsiteStatus {
  policy: WebsitePolicy;
  notice: { version: string; title: string; points: string[]; draft: boolean } | null;
  acknowledgedAt: string | null;
  /** Whether a connected extension may record right now, and if not, why. */
  collecting: boolean;
  reasons: string[];
  links: { id: string; label: string; createdAt: string; lastUsedAt: string | null }[];
}

export interface WebsiteUsageRow {
  domain: string;
  /** Recorded time (sum of intervals). */
  durationMs: number;
  intervals: number;
  /** Inferred from the admin's rules at report time; not part of the recording. */
  category: WebsiteCategory;
}

export interface WebsiteReport {
  from: string;
  to: string;
  totalMs: number;
  unclassifiedMs: number;
  /** Employees with any recorded time for these filters. */
  employeesWithActivity: number;
  byDomain: (WebsiteUsageRow & { employees: number })[];
  byEmployee: { employee: EmployeeRef; durationMs: number; domains: number }[];
  /** One row per employee, local date (employee's zone) and domain. */
  rows: { date: string; employee: EmployeeRef; domain: string; durationMs: number; category: WebsiteCategory }[];
  /** Employees who acknowledged the website notice in force, of all current employees. */
  acknowledged: { count: number; of: number };
}

/** Per employee: whether they acknowledged the website notice in force, and connected browsers. */
export interface WebsiteNotificationStatus {
  policySeq: number | null;
  noticeVersion: string;
  employees: { employee: EmployeeRef; acknowledgedAt: string | null; connectedBrowsers: number }[];
}

/** `GET /websites/me/usage`: the caller's own usage (no employee fields). */
export interface WebsiteUsageResponse {
  from: string;
  to: string;
  totalMs: number;
  unclassifiedMs: number;
  byDomain: WebsiteUsageRow[];
  rows: { date: string; domain: string; durationMs: number; category: WebsiteCategory }[];
}

/** `POST /websites/links`: a one-time code the employee types into the extension. */
export interface WebsitePairingCode {
  code: string;
  expiresAt: string;
}

export interface WebsitePolicyHistoryEntry {
  seq: number;
  enabled: boolean;
  retentionDays: number;
  noticeVersion: string;
  reason: string;
  /** Email of the admin who made the change. */
  changedBy: string;
  effectiveAt: string;
}

/** `GET /websites/policy`. */
export interface WebsitePolicyResponse {
  current: WebsitePolicy & { seq: number | null };
  history: WebsitePolicyHistoryEntry[];
}

/** `GET /websites/audit`: rule changes and retention runs (details are ids, counts and settings). */
export interface WebsiteAuditEntry {
  action: string;
  details: Record<string, unknown>;
  at: string;
  /** Actor email; null for automatic runs. */
  by: string | null;
}

/** `POST /websites/extension/pair`: the extension's bearer token (shown once) and whose browser it is. */
export interface ExtensionPairResponse {
  token: string;
  employee: { fullName: string; employeeCode: string };
}

/** `GET /websites/extension/state`: whether the extension may record now, and its limits. */
export interface ExtensionStateResponse {
  collect: boolean;
  reasons: string[];
  intervalMaxSeconds: number;
  idleSeconds: number;
  employee: { fullName: string; employeeCode: string };
}

/** `POST /websites/extension/intervals`: one result per submitted interval. */
export interface ExtensionIntervalsResponse {
  results: { id: string; status: "ACCEPTED" | "DUPLICATE" | "REJECTED"; reason?: string }[];
}
