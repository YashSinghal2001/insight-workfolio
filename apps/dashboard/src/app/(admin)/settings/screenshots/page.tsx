"use client";

import { useCallback, useEffect, useState } from "react";
import type { MonitoringSettingsResponse, ScreenshotRetentionPreview, ScreenshotSettingsResponse } from "@workfolio/shared";
import { ErrorState, PageHeader, SkeletonRows } from "@/components/kit";
import { api, errorMessage } from "@/lib/api";
import { Screenshots } from "../_parts/sections";

/** Screenshot capture, privacy masks, blur, self-view, timelapse and screenshot retention. */
export default function ScreenshotSettingsPage() {
  const [data, setData] = useState<{ settings: ScreenshotSettingsResponse; retention: ScreenshotRetentionPreview; notices: MonitoringSettingsResponse["notices"] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([
      api<ScreenshotSettingsResponse>("/settings/screenshots"),
      api<ScreenshotRetentionPreview>("/screenshots/retention"),
      api<MonitoringSettingsResponse>("/settings/monitoring"),
    ]).then(
      ([settings, retention, m]) => (setData({ settings, retention, notices: m.notices }), setError(null)),
      (e) => setError(errorMessage(e)),
    );
  }, []);
  useEffect(load, [load]);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <PageHeader
        title="Screenshots & masks"
        about="Screenshot settings apply to every desktop within about a minute. Every change is kept with who made it and why. Notices are published under Monitoring & notices. These are configurable defaults pending HR/Legal review, not a statement of legal compliance."
      />
      {error && <ErrorState message={error} onRetry={load} />}
      {!data && !error && <SkeletonRows label="screenshot settings" />}
      {data && <Screenshots data={data.settings} retention={data.retention} notices={data.notices} onSaved={load} />}
    </div>
  );
}
