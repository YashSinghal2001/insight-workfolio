"use client";

import { useEffect, useState } from "react";
import {
  NOTIFICATION_RECIPIENT_LABEL,
  NOTIFICATION_ROUTES,
  NOTIFICATION_TYPES,
  type NotificationDeliveryStatus,
  type NotificationOverview,
  type NotificationSeverity,
} from "@workfolio/shared";
import { Button, DataTable, EmptyState, ErrorState, PageHeader, SkeletonRows, StatCard, StatGrid, StatusBadge, type Tone } from "@/components/kit";
import { Card, Field, formatInZone, inputClass, Notice } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

type Show = "all" | "failed" | "critical";
const SHOW_LABEL: Record<Show, string> = { all: "All events", failed: "With a failed delivery", critical: "Critical incidents" };
const SEVERITY_TONE: Record<NotificationSeverity, Tone> = { INFO: "info", WARNING: "warning", CRITICAL: "danger" };
const STATUS_TONE: Record<NotificationDeliveryStatus, Tone> = { PENDING: "neutral", PROCESSING: "neutral", RETRYING: "warning", SENT: "success", FAILED: "danger" };
const STATUS_LABEL: Record<NotificationDeliveryStatus, string> = { PENDING: "Waiting", PROCESSING: "Sending", RETRYING: "Retrying", SENT: "Sent", FAILED: "Failed" };
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Email notifications: the email service, who is told about what, and every delivery with its outcome. */
export default function NotificationsPage() {
  const [show, setShow] = useState<Show>("all");
  const [data, setData] = useState<NotificationOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  // The incident an email linked to (?event=<id>): shown first and outlined.
  const [focus, setFocus] = useState<string | null>(null);
  const tz = zone();

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read the link target once, after hydration
    setFocus(new URLSearchParams(window.location.search).get("event"));
  }, []);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on filter change
    setLoading(true);
    setError(null);
    api<NotificationOverview>(`/notifications?show=${show}`)
      .then((d) => !cancelled && setData(d))
      .catch((err) => !cancelled && (setError(errorMessage(err)), setData(null)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [show, reload]);

  async function retry(deliveryId: string) {
    setRetrying(deliveryId);
    setRetryError(null);
    try {
      await api(`/notifications/deliveries/${deliveryId}/retry`, { method: "POST" });
      setReload((n) => n + 1);
    } catch (err) {
      setRetryError(errorMessage(err));
    } finally {
      setRetrying(null);
    }
  }

  const email = data?.email;
  const events = data ? [...data.events].sort((a, b) => Number(b.id === focus) - Number(a.id === focus)) : [];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader
        title="Notifications"
        description="Emails the system sends from the IT mailbox. Recipients are chosen by the server from the event and each account's role; they cannot be set here. Times are in your time zone."
        actions={<Button variant="secondary" onClick={() => setReload((n) => n + 1)}>Refresh</Button>}
      />

      {error && <ErrorState message={error} onRetry={() => setReload((n) => n + 1)} />}
      {loading && !data && <SkeletonRows label="notifications" />}

      {data && email && (
        <>
          {data.counts.criticalUndelivered > 0 && (
            <Notice tone="error">
              {data.counts.criticalUndelivered} critical incident{data.counts.criticalUndelivered === 1 ? " has" : "s have"} not reached anyone by email. They are listed under “Critical incidents” below.
            </Notice>
          )}
          <Card title="Email service">
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
              <dt className="text-muted">Status</dt>
              <dd>
                {email.problem ? <StatusBadge tone={email.provider === "none" ? "neutral" : "danger"}>{email.provider === "none" ? "Not configured" : "Needs attention"}</StatusBadge> : <StatusBadge tone={email.delivers ? "success" : "warning"}>{email.delivers ? "Ready" : "Test mode: nothing is emailed"}</StatusBadge>}
              </dd>
              <dt className="text-muted">Sender</dt>
              <dd>{email.sender ?? "—"}</dd>
              <dt className="text-muted">Provider</dt>
              <dd>{email.provider === "graph-delegated" ? "Microsoft Graph (the OneDrive account's sign-in)" : email.provider === "graph" ? "Microsoft Graph (application)" : email.provider === "mock" ? "Mock (development)" : "None"}</dd>
              {email.provider === "graph-delegated" && (
                <>
                  <dt className="text-muted">Microsoft connection</dt>
                  <dd>{email.connected ? "Connected" : "Not connected"}{email.mailSendGranted === null ? "" : email.mailSendGranted ? " · permission to send mail granted" : " · permission to send mail missing"}</dd>
                </>
              )}
            </dl>
            {email.problem && <p className="mt-3 text-sm text-muted">{email.problem}</p>}
          </Card>

          <StatGrid>
            <StatCard label="Failed deliveries" value={String(data.counts.failed)} hint="Not sent after all attempts" />
            <StatCard label="Waiting or retrying" value={String(data.counts.waiting)} hint="Sent within a minute, or at the next retry" />
            <StatCard label="Critical incidents not delivered" value={String(data.counts.criticalUndelivered)} hint="No recipient received the email" />
          </StatGrid>

          <section aria-label="Events" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="w-64">
                <Field label="Show">
                  <select value={show} className={inputClass} onChange={(e) => setShow(e.target.value as Show)}>
                    {(Object.keys(SHOW_LABEL) as Show[]).map((s) => <option key={s} value={s}>{SHOW_LABEL[s]}</option>)}
                  </select>
                </Field>
              </div>
              <p className="text-sm text-muted" aria-live="polite">{loading ? "Updating…" : `${events.length} event${events.length === 1 ? "" : "s"} (latest 200)`}</p>
            </div>
            {retryError && <Notice tone="error">{retryError}</Notice>}
            {events.length === 0 ? (
              <EmptyState title="No notifications to show." hint={show === "all" ? "Nothing has been recorded yet." : "Try “All events”."} />
            ) : (
              <DataTable label="Notification events" head={["Time", "Event", "Details", "Deliveries"]} minWidth={960}>
                {events.map((e) => (
                  <tr key={e.id} className={`align-top ${e.id === focus ? "outline-2 outline-brand" : ""}`}>
                    <td className="whitespace-nowrap">{formatInZone(e.createdAt, tz)}</td>
                    <td>
                      <StatusBadge tone={SEVERITY_TONE[e.severity]}>{e.severity === "CRITICAL" ? "Critical" : e.severity === "WARNING" ? "Warning" : "Information"}</StatusBadge>
                      <span className="mt-1 block">{NOTIFICATION_ROUTES[e.type]?.label ?? e.type}</span>
                    </td>
                    <td className="text-sm">
                      {e.description}
                      {e.subject && <span className="block text-xs text-muted">Account: {e.subject.email}</span>}
                      <span className="block font-mono text-xs break-all text-muted">ID {e.id}</span>
                    </td>
                    <td>
                      <ul className="flex flex-col gap-2 text-sm">
                        {e.deliveries.map((d) => (
                          <li key={d.id}>
                            <span className="flex flex-wrap items-center gap-2">
                              <StatusBadge tone={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status]}</StatusBadge>
                              <span>{NOTIFICATION_RECIPIENT_LABEL[d.role]}{d.recipient ? `: ${d.recipient}` : ""}</span>
                              {d.status === "FAILED" && d.recipient && (
                                <Button variant="ghost" pending={retrying === d.id} pendingLabel="Queuing…" onClick={() => void retry(d.id)} aria-label={`Send again to ${d.recipient}`}>
                                  Send again
                                </Button>
                              )}
                            </span>
                            <span className="block text-xs text-muted">
                              {d.status === "SENT" ? `Accepted by the mail provider ${formatInZone(d.sentAt, tz)}` : `${d.attempts} attempt${d.attempts === 1 ? "" : "s"}`}
                              {d.lastError ? ` · ${d.lastError}` : ""}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                ))}
              </DataTable>
            )}
          </section>

          <Card title="Who is told about what">
            <p className="mb-3 text-sm text-muted">Fixed by the system. A critical event always goes to both IT and Super Admin accounts; nobody can turn that off.</p>
            <DataTable label="Routing" head={["Event", "Severity", "Recipients"]}>
              <tr>
                <td>Employee invitation</td>
                <td><StatusBadge tone="info">Information</StatusBadge></td>
                <td>Employee (sent when the account is created; see the employee page)</td>
              </tr>
              {NOTIFICATION_TYPES.map((t) => (
                <tr key={t}>
                  <td>{NOTIFICATION_ROUTES[t].label}</td>
                  <td><StatusBadge tone={SEVERITY_TONE[NOTIFICATION_ROUTES[t].severity]}>{NOTIFICATION_ROUTES[t].severity === "CRITICAL" ? "Critical" : NOTIFICATION_ROUTES[t].severity === "WARNING" ? "Warning" : "Information"}</StatusBadge></td>
                  <td>{NOTIFICATION_ROUTES[t].roles.map((r) => (r === "EMPLOYEE" ? "Affected employee" : NOTIFICATION_RECIPIENT_LABEL[r])).join(", ")}</td>
                </tr>
              ))}
            </DataTable>
          </Card>
        </>
      )}
    </div>
  );
}
