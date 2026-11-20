"use client";

import { useCallback, useEffect, useState } from "react";
import type { MonitoringSettingsResponse, RetentionPreview } from "@workfolio/shared";
import { ErrorState, PageHeader, SkeletonRows } from "@/components/kit";
import { api, errorMessage } from "@/lib/api";
import { History, Notices, PolicyForm, Retention } from "../_parts/sections";

/** Activity monitoring policy, the notices employees acknowledge, activity retention and the change history. */
export default function MonitoringSettingsPage() {
  const [data, setData] = useState<MonitoringSettingsResponse | null>(null);
  const [retention, setRetention] = useState<RetentionPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retentionError, setRetentionError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<MonitoringSettingsResponse>("/settings/monitoring").then((s) => (setData(s), setError(null)), (e) => setError(errorMessage(e)));
    api<RetentionPreview>("/activity/retention").then((r) => (setRetention(r), setRetentionError(null)), (e) => setRetentionError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <PageHeader
        title="Monitoring & notices"
        about="Activity monitoring settings apply to every desktop within about a minute. Every change is kept with who made it and why. These are configurable defaults pending HR/Legal review, not a statement of legal compliance."
      />
      {error && <ErrorState message={error} onRetry={load} />}
      {!data && !error && <SkeletonRows label="monitoring settings" />}
      {data && <PolicyForm data={data} onSaved={load} />}
      {data && <Notices notices={data.notices} onPublished={load} />}
      {retentionError && <ErrorState title="Could not load activity retention" message={retentionError} onRetry={load} />}
      {retention && <Retention preview={retention} onRan={load} />}
      {data && <History data={data} />}
    </div>
  );
}
