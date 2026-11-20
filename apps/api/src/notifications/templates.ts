import { NOTIFICATION_ROUTES, type NotificationRecipientRole, type NotificationSeverity, type NotificationType } from "@workfolio/shared";
import type { MailMessage } from "../reports/mail.js";

/**
 * Notification emails (docs/notifications.md): one layout, the dashboard's own colours (globals.css light theme:
 * brand, danger, warning, info, foreground, muted, border, background). HTML with a plain-text twin.
 * Staff (IT, Super Admin) get the incident facts and a link to the dashboard page; the affected employee gets a
 * fixed sentence about their own account and never the incident description.
 */
const COLOR = { brand: "#2f5bea", background: "#f6f7f9", surface: "#ffffff", foreground: "#14171f", muted: "#5b6272", border: "#e2e5ea" };
const SEVERITY: Record<NotificationSeverity, { label: string; color: string }> = {
  INFO: { label: "Information", color: "#0369a1" },
  WARNING: { label: "Warning", color: "#b45309" },
  CRITICAL: { label: "Critical", color: "#c81e1e" },
};

/** What each event says. `employee` is the whole message to the affected employee. */
const COPY: Record<NotificationType, { staff: string; employee?: { subject: string; body: string } }> = {
  ACCOUNT_ACTIVATED: {
    staff: "An account was activated.",
    employee: { subject: "Your Insight Workfolio account is active", body: "Your account is now active: you chose your password and can sign in." },
  },
  PASSWORD_CHANGED: {
    staff: "An account password was changed.",
    employee: {
      subject: "Your Insight Workfolio password was changed",
      body: "The password of your account was just changed and its other sign-ins were ended. If this was not you, contact IT immediately.",
    },
  },
  SECURITY_ALERT: {
    staff: "A security alert was raised for an account.",
    employee: {
      subject: "Security alert for your Insight Workfolio account",
      body: "One of your sign-ins was ended because of unusual activity. Sign in again to continue. If you did not expect this, contact IT.",
    },
  },
  DEVICE_ISSUE: { staff: "A computer could not be registered for an employee." },
  SCREENSHOT_FAILURE: { staff: "The screenshot service or its storage reported a failure." },
  BACKUP_FAILURE: { staff: "The database backup did not complete." },
  CRITICAL_FAILURE: { staff: "A critical system failure was detected." },
  SECURITY_INCIDENT: {
    staff: "A major security incident was recorded.",
    employee: {
      subject: "Security incident affecting your Insight Workfolio account",
      body: "A security incident affecting your account was detected. IT has been informed and may contact you. Nobody from IT will ever ask you for your password.",
    },
  },
  ONBOARDING_SUMMARY: { staff: "Employee onboarding over the past week." },
  PERIODIC_REPORT: { staff: "A periodic report is ready in the dashboard." },
  ATTENDANCE_CLOCK_IN: { staff: "clocked in." },
  ATTENDANCE_CLOCK_OUT: { staff: "clocked out." },
  LATE_ARRIVAL: { staff: "clocked in after the expected start." },
  ABSENCE: { staff: "has not clocked in on a scheduled workday (absent)." },
  MISSING_CLOCK_OUT: { staff: "has not clocked out." },
  PRODUCTIVITY_ALERT: { staff: "raised a productivity alert." },
};

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** UTC, minute precision: the same instant for every recipient. */
export const stamp = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

export interface RenderInput {
  event: { id: string; type: NotificationType; severity: NotificationSeverity; description: string; createdAt: string };
  role: NotificationRecipientRole;
  to: string;
  /** DASHBOARD_URL. */
  dashboardUrl: string;
  /** MAIL_SENDER: named as the IT contact. */
  sender: string;
}

function layout(p: { heading: string; severity: NotificationSeverity; paragraphs: string[]; facts: [string, string][]; link: { href: string; label: string }; sender: string }): { text: string; html: string } {
  const sev = SEVERITY[p.severity];
  const text = [p.heading, "", ...p.paragraphs, "", ...p.facts.map(([k, v]) => `${k}: ${v}`), ...(p.facts.length ? [""] : []), `${p.link.label}: ${p.link.href}`, "", `Sent by Insight Workfolio (TFF Digital). Questions? Contact IT at ${p.sender}.`].join("\n");
  const facts = p.facts
    .map(([k, v]) => `<tr><th scope="row" align="left" style="padding:6px 16px 6px 0;font-weight:600;color:${COLOR.muted};vertical-align:top;white-space:nowrap">${escapeHtml(k)}</th><td style="padding:6px 0;word-break:break-word">${escapeHtml(v)}</td></tr>`)
    .join("");
  const [href, sender] = [escapeHtml(p.link.href), escapeHtml(p.sender)];
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(p.heading)}</title></head>
<body style="margin:0;padding:0;background:${COLOR.background};font-family:Segoe UI,Helvetica,Arial,sans-serif;color:${COLOR.foreground}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLOR.background};padding:24px 0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:${COLOR.surface};border:1px solid ${COLOR.border};border-radius:8px;overflow:hidden">
<tr><td style="background:${COLOR.brand};padding:20px 32px;color:#ffffff;font-size:20px;font-weight:600">Insight Workfolio</td></tr>
<tr><td style="padding:32px;font-size:15px;line-height:1.6">
<p style="margin:0 0 12px"><span style="display:inline-block;border:1px solid ${sev.color};color:${sev.color};border-radius:4px;padding:2px 8px;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase">${sev.label}</span></p>
<h1 style="margin:0 0 16px;font-size:18px;line-height:1.4">${escapeHtml(p.heading)}</h1>
${p.paragraphs.map((x) => `<p style="margin:0 0 16px">${escapeHtml(x)}</p>`).join("\n")}
${facts ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;font-size:14px;line-height:1.5">${facts}</table>` : ""}
<p style="margin:0 0 16px"><a href="${href}" style="display:inline-block;background:${COLOR.brand};color:#ffffff;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:6px">${escapeHtml(p.link.label)}</a></p>
<p style="margin:0;font-size:13px;color:${COLOR.muted}">If the button does not work, copy this address into your browser:<br><span style="word-break:break-all">${href}</span></p>
</td></tr>
<tr><td style="padding:16px 32px;border-top:1px solid ${COLOR.border};font-size:12px;color:${COLOR.muted}">Sent by Insight Workfolio (TFF Digital). Questions? Contact IT at <a href="mailto:${sender}" style="color:${COLOR.brand}">${sender}</a>.</td></tr>
</table></td></tr></table></body></html>`;
  return { text, html };
}

export function renderNotification({ event, role, to, dashboardUrl, sender }: RenderInput): MailMessage {
  const route = NOTIFICATION_ROUTES[event.type];
  const copy = COPY[event.type];
  if (role === "EMPLOYEE") {
    const e = copy.employee ?? { subject: `${route.label}: Insight Workfolio`, body: "There is an update about your Insight Workfolio account." };
    const body = layout({ heading: e.subject, severity: event.severity, paragraphs: [e.body], facts: [["Time", stamp(event.createdAt)]], link: { href: new URL("/", dashboardUrl).href, label: "Open Insight Workfolio" }, sender });
    return { to, subject: e.subject, ...body };
  }
  const subject = `[${SEVERITY[event.severity].label}] ${route.label}: Insight Workfolio`;
  const body = layout({
    heading: route.label,
    severity: event.severity,
    paragraphs: [copy.staff, event.description],
    facts: [
      ["Incident ID", event.id],
      ["Severity", SEVERITY[event.severity].label],
      ["Category", route.label],
      ["Time", stamp(event.createdAt)],
    ],
    link: { href: new URL(`/notifications?event=${encodeURIComponent(event.id)}`, dashboardUrl).href, label: "Open in the admin dashboard" },
    sender,
  });
  return { to, subject, ...body };
}

/** One attendance event as an email shows it: nothing beyond name, employee code, local time and event type. */
export interface AttendanceItem {
  fullName: string;
  employeeCode: string;
  /** "YYYY-MM-DD HH:mm <zone>" in the employee's own zone. */
  localTime: string;
}

/**
 * Attendance rule emails (docs/notifications.md §9). `items` has one entry (IMMEDIATE) or the day's list (digest).
 * Never screenshots, app or window names, leave reasons, alert details or another team's data.
 */
export function renderAttendance(p: { type: NotificationType; digestDate: string | null; items: AttendanceItem[]; to: string; dashboardUrl: string; sender: string }): MailMessage {
  const label = NOTIFICATION_ROUTES[p.type].label;
  const severity = NOTIFICATION_ROUTES[p.type].severity;
  const link = { href: new URL("/attendance", p.dashboardUrl).href, label: "Open in the admin dashboard" };
  if (p.digestDate === null) {
    const e = p.items[0]!;
    const subject = `${label}: ${e.fullName} (${e.employeeCode})`.replace(/[\r\n]+/g, " ").slice(0, 200);
    const body = layout({ heading: label, severity, paragraphs: [`${e.fullName} ${COPY[p.type].staff}`], facts: [["Employee", e.fullName], ["Employee code", e.employeeCode], ["Local time", e.localTime], ["Event", label]], link, sender: p.sender });
    return { to: p.to, subject, ...body };
  }
  const shown = p.items.slice(0, DIGEST_MAX_ITEMS);
  const more = p.items.length - shown.length;
  const body = layout({
    heading: `${label}: daily digest for ${p.digestDate}`,
    severity,
    paragraphs: [`${p.items.length} event(s) of type "${label}" on ${p.digestDate}.`, ...(more > 0 ? [`The first ${shown.length} are listed; ${more} more are in the dashboard.`] : [])],
    facts: shown.map((e) => [`${e.fullName} (${e.employeeCode})`, e.localTime] as [string, string]),
    link,
    sender: p.sender,
  });
  return { to: p.to, subject: `${label}: daily digest for ${p.digestDate} (${p.items.length})`, ...body };
}
/** ponytail: fixed digest length; a bigger organisation reads the rest in the dashboard. */
export const DIGEST_MAX_ITEMS = 200;
