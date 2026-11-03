"use client";

import { formatDuration, type ApplicationCategory, type CategorizedActivitySummary } from "@workfolio/shared";
import { StatCard, StatGrid, StatusBadge, type Tone } from "@/components/kit";

export const CATEGORY: Record<ApplicationCategory, { label: string; tone: Tone }> = {
  PRODUCTIVE: { label: "Productive", tone: "success" },
  NEUTRAL: { label: "Neutral", tone: "info" },
  UNPRODUCTIVE: { label: "Unproductive", tone: "warning" },
  UNCLASSIFIED: { label: "Unclassified", tone: "neutral" },
};

export const CategoryBadge = ({ category }: { category?: ApplicationCategory }) =>
  category ? <StatusBadge tone={CATEGORY[category].tone}>{CATEGORY[category].label}</StatusBadge> : null;

export const NOT_LABELLED = "Your organization has not labelled any applications yet, so there is no productive / unproductive split.";

/** Productive share and active time per label, only when the organization has labelled applications. Nothing is guessed. */
export function CategoryTotals({ summary: a, compact }: { summary: CategorizedActivitySummary; compact?: boolean }) {
  if (!a.categoriesConfigured) return <p className="text-xs text-muted">{NOT_LABELLED}</p>;
  const share = a.productiveShare === null ? null : `${Math.round(a.productiveShare * 100)}%`;
  if (compact) {
    return (
      <p className="text-sm">
        Productive share {share ?? "—"} · Productive {formatDuration(a.productiveMs)} · Neutral {formatDuration(a.neutralMs)} · Unproductive {formatDuration(a.unproductiveMs)} · Unclassified{" "}
        {formatDuration(a.unclassifiedMs)}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <StatGrid>
        <StatCard label="Productive share" value={share} reason="Nothing clocked in" hint="Productive time ÷ clocked-in time" />
        <StatCard label="Productive" value={formatDuration(a.productiveMs)} />
        <StatCard label="Neutral" value={formatDuration(a.neutralMs)} />
        <StatCard label="Unproductive" value={formatDuration(a.unproductiveMs)} />
        <StatCard label="Unclassified" value={formatDuration(a.unclassifiedMs)} hint="Applications without a label" />
      </StatGrid>
      <p className="text-xs text-muted">Labels are set by your organization per application and applied when you view this, so they can change. Idle time is never productive.</p>
    </div>
  );
}
