"use client";

import { useCallback, useEffect, useState } from "react";
import type { MonitoringSettingsResponse, ScreenshotSettingsResponse } from "@workfolio/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SETTINGS_NAV } from "@/components/sidebar";
import { ErrorState, PageHeader, SkeletonRows, StatCard, StatGrid } from "@/components/kit";
import { api, errorMessage } from "@/lib/api";

const ABOUT: Record<string, string> = {
  "/settings/schedule": "Expected start, grace and workdays: who is late or absent.",
  "/settings/monitoring": "Activity monitoring, idle threshold, notices employees acknowledge, activity retention.",
  "/settings/screenshots": "Screenshot capture, privacy masks, blur, self-view, timelapse and retention.",
  "/settings/labels": "Productive, neutral and unproductive application labels.",
  "/settings/websites": "Website tracking policy and category rules.",
  "/settings/storage": "Where screenshots are stored and the OneDrive connection.",
  "/settings/notifications": "Attendance emails: who is told about clock-ins, late arrivals, absences and more.",
  "/settings/leave-types": "Leave types, yearly allowances and short-leave quotas.",
};

/** Settings home: what is in force now, and where each setting lives. */
export default function SettingsPage() {
  const router = useRouter();
  const [data, setData] = useState<{ monitoring: MonitoringSettingsResponse; shots: ScreenshotSettingsResponse } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The API returns from the OneDrive / Google Drive sign-in to /settings?oneDrive=… (or googleDrive=…): show it on Storage.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.has("oneDrive") || q.has("googleDrive")) router.replace(`/settings/storage?${q}`);
  }, [router]);

  const load = useCallback(() => {
    Promise.all([api<MonitoringSettingsResponse>("/settings/monitoring"), api<ScreenshotSettingsResponse>("/settings/screenshots")]).then(
      ([monitoring, shots]) => (setData({ monitoring, shots }), setError(null)),
      (e) => setError(errorMessage(e)),
    );
  }, []);
  useEffect(load, [load]);

  const e = data?.monitoring.effective;
  const s = data?.shots.effective;
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <PageHeader
        title="Settings"
        about="Activity monitoring settings apply to every desktop within about a minute. Every change is kept with who made it and why. These are configurable defaults pending HR/Legal review, not a statement of legal compliance."
      />
      {error && <ErrorState message={error} onRetry={load} />}
      {!data && !error && <SkeletonRows label="settings" />}
      {e && s && (
        <section aria-labelledby="in-force" className="flex flex-col gap-3">
          <h2 id="in-force" className="text-lg font-semibold">In force now</h2>
          <StatGrid>
            <StatCard label="Idle threshold" value={`${e.idleThresholdSeconds} s`} hint={e.enabled ? "No input this long counts as idle" : "Activity monitoring is off"} href="/settings/monitoring" />
            <StatCard label="Sampling interval" value={`${e.sampleSeconds} s`} hint="How often the foreground app is checked" href="/settings/monitoring" />
            <StatCard label="Screenshots" value={s.enabled ? "Enabled" : "Disabled"} hint={s.enabled ? "After each employee's acknowledgement" : "Nothing is captured"} href="/settings/screenshots" />
            <StatCard label="Screenshot interval" value={`${s.intervalSeconds} s`} hint={s.enabled ? "While clocked in, not on a break" : "Applies once screenshots are enabled"} href="/settings/screenshots" />
          </StatGrid>
          <p className="text-xs text-muted">Organisation values; one person can have their own idle threshold or blur setting on their employee page.</p>
        </section>
      )}
      <nav aria-label="All settings" className="grid gap-3 sm:grid-cols-2">
        {SETTINGS_NAV.filter((i) => i.href !== "/settings").map((i) => (
          <Link key={i.href} href={i.href} className="rounded-lg border border-border bg-surface p-4 hover:border-border-strong focus-visible:outline-2 focus-visible:outline-focus">
            <span className="font-medium text-brand">{i.label}</span>
            <span className="mt-1 block text-sm text-muted">{ABOUT[i.href]}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
