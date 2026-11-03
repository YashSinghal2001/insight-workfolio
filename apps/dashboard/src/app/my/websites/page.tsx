"use client";

import { useState } from "react";
import {
  addDays,
  formatDuration,
  todayIn,
  WEBSITE_DATA,
  WEBSITE_RANGE_MAX_DAYS,
  type WebsiteCategory,
  type WebsitePairingCode,
  type WebsiteStatus,
  type WebsiteUsageResponse,
} from "@workfolio/shared";
import { Button, ConfirmDialog, DataTable, EmptyState, PageHeader, StatusBadge, SuccessNotice, type Tone } from "@/components/kit";
import { dayLabel, useApi, useMe } from "@/components/my-ui";
import { RangePicker, type Range } from "@/components/range-picker";
import { Card, Notice } from "@/components/ui";
import { api, ApiRequestError, errorMessage } from "@/lib/api";
import { errorText, Loaded } from "../_components/states";

const LABEL: Record<WebsiteCategory, { label: string; tone: Tone }> = {
  PRODUCTIVE: { label: "Productive", tone: "success" },
  NEUTRAL: { label: "Neutral", tone: "info" },
  UNPRODUCTIVE: { label: "Unproductive", tone: "warning" },
  UNCLASSIFIED: { label: "Unclassified", tone: "neutral" },
};
type Link = WebsiteStatus["links"][number];
const failure = (err: unknown) => (err instanceof ApiRequestError ? errorText(err.message, err.status) : errorMessage(err));

/** Website activity: the signed-in employee's own status, notice, connected browsers and recorded domains. */
export default function MyWebsitesPage() {
  const tz = useMe().timezone;
  const when = (iso: string) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: tz }).format(new Date(iso));
  const [range, setRange] = useState<Range>(() => ({ from: addDays(todayIn(tz), -6), to: todayIn(tz) }));
  const status = useApi<WebsiteStatus>("/websites/me");
  const usage = useApi<WebsiteUsageResponse>(`/websites/me/usage?from=${range.from}&to=${range.to}`);
  const [code, setCode] = useState<WebsitePairingCode | null>(null);
  const [busy, setBusy] = useState<"consent" | "pair" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [disconnect, setDisconnect] = useState<Link | null>(null);

  async function act(kind: "consent" | "pair", fn: () => Promise<string>) {
    setBusy(kind);
    setError(null);
    try {
      setOk(await fn());
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(null);
      void status.reload();
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="My website activity"
        description={`Only your own records. Domain names and time only, recorded by a browser extension you connect yourself. Times in ${tz}.`}
      />
      <SuccessNotice message={ok} onDismiss={() => setOk(null)} />
      {error && <Notice tone="error">{error}</Notice>}
      <Loaded load={status.load} reload={status.reload} label="your website tracking status" rows={3}>
        {(s) => (
          <>
            <Card title="Website tracking">
              <div className="flex flex-col gap-3 text-sm">
                <p data-testid="my-web-state" className="font-medium">{s.collecting ? "Recording website domain names" : "Not recording"}</p>
                {s.reasons.length > 0 && <ul className="list-disc pl-5 text-muted">{s.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <span>Organization setting: {s.policy.enabled ? "on" : "off"} · notice {s.policy.noticeVersion}{s.notice?.draft ? " (draft)" : ""} ·</span>
                  {s.acknowledgedAt ? <StatusBadge tone="success">Acknowledged {when(s.acknowledgedAt)}</StatusBadge> : <StatusBadge tone="warning">Not acknowledged</StatusBadge>}
                  <span>· records kept {s.policy.retentionDays} days</span>
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div><p className="font-medium">Recorded</p><ul className="list-disc pl-5 text-xs text-muted">{WEBSITE_DATA.collected.map((t) => <li key={t}>{t}</li>)}</ul></div>
                  <div><p className="font-medium">Never recorded</p><ul className="list-disc pl-5 text-xs text-muted">{WEBSITE_DATA.never.map((t) => <li key={t}>{t}</li>)}</ul></div>
                </div>
              </div>
            </Card>

            {s.policy.enabled && !s.acknowledgedAt && s.notice && (
              <Card title={`${s.notice.title}${s.notice.draft ? " (draft)" : ""}`}>
                <ul className="list-disc pl-5 text-sm">{s.notice.points.map((p) => <li key={p}>{p}</li>)}</ul>
                <Button
                  className="mt-3"
                  pending={busy === "consent"}
                  onClick={() => void act("consent", async () => (await api("/websites/consent", { method: "POST", body: { noticeVersion: s.notice!.version } }), "Notice acknowledged."))}
                >
                  I have read this notice
                </Button>
              </Card>
            )}

            <Card title="Connected browsers">
              <div className="flex flex-col gap-3 text-sm">
                {s.links.length === 0 && <p className="text-muted">No browser connected. Nothing is recorded without one.</p>}
                {s.links.length > 0 && (
                  <ul aria-label="My connected browsers" className="flex flex-col divide-y divide-border">
                    {s.links.map((l) => (
                      <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <span className="min-w-0 break-words">
                          {l.label} <span className="text-xs text-muted">connected {when(l.createdAt)} · last contact {l.lastUsedAt ? when(l.lastUsedAt) : "never"}</span>
                        </span>
                        <Button variant="secondary" className="px-3 py-1" onClick={() => setDisconnect(l)} aria-label={`Disconnect ${l.label}`}>Disconnect</Button>
                      </li>
                    ))}
                  </ul>
                )}
                <div>
                  <Button
                    variant="secondary"
                    pending={busy === "pair"}
                    onClick={() => void act("pair", async () => (setCode(await api<WebsitePairingCode>("/websites/links", { method: "POST" })), "Pairing code created."))}
                  >
                    Connect a browser
                  </Button>
                </div>
                {code && (
                  <p>
                    <strong className="font-mono text-lg" data-testid="my-web-code">{code.code}</strong>{" "}
                    <span className="text-xs text-muted">Enter it in the Insight Workfolio browser extension before {when(code.expiresAt)}. It works once.</span>
                  </p>
                )}
              </div>
            </Card>
          </>
        )}
      </Loaded>

      <Card title="Recorded websites">
        <div className="flex flex-col gap-3 text-sm">
          <RangePicker value={range} onChange={setRange} timeZone={tz} maxDays={WEBSITE_RANGE_MAX_DAYS} />
          <Loaded load={usage.load} reload={usage.reload} label="your recorded websites">
            {(u) =>
              u.rows.length === 0 ? (
                <EmptyState title="No website activity recorded in this period." />
              ) : (
                <>
                  <p className="text-xs text-muted">
                    Recorded: {formatDuration(u.totalMs)}. Categories are set by your organization and inferred from the domain; they are not part of the recording.
                  </p>
                  <DataTable label="My recorded websites" head={["Date", "Domain", "Recorded time", "Category (organization)"]}>
                    {u.rows.map((r) => (
                      <tr key={`${r.date}-${r.domain}`}>
                        <td className="whitespace-nowrap">{dayLabel(r.date)}</td>
                        <td className="font-mono break-all">{r.domain}</td>
                        <td className="tabular-nums">{formatDuration(r.durationMs)}</td>
                        <td><StatusBadge tone={LABEL[r.category].tone}>{LABEL[r.category].label}</StatusBadge></td>
                      </tr>
                    ))}
                  </DataTable>
                </>
              )
            }
          </Loaded>
        </div>
      </Card>

      <ConfirmDialog
        open={!!disconnect}
        title="Disconnect this browser?"
        description={disconnect && <>The extension in <strong>{disconnect.label}</strong> is disconnected and can no longer send records. You can connect it again later with a new code.</>}
        confirmLabel="Disconnect"
        tone="danger"
        onConfirm={async () => {
          try {
            await api(`/websites/links/${disconnect!.id}`, { method: "DELETE" });
          } catch (err) {
            throw new Error(failure(err));
          }
          setOk("Browser disconnected.");
          void status.reload();
        }}
        onClose={() => setDisconnect(null)}
      />
    </div>
  );
}
