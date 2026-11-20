"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { OverviewResponse } from "@workfolio/shared";
import { GlobalFilters, useGlobalFilters } from "@/components/global-filters";
import { PageHeader } from "@/components/kit";
import { api, errorMessage } from "@/lib/api";
import { todayLocal } from "@/lib/global-filters";
import { overviewPath } from "./_components/overview-data";
import {
  AbsentWidget,
  ApprovalsWidget,
  HolidaysWidget,
  KpiStrip,
  LateWidget,
  LeavesWidget,
  MissingClockOutsWidget,
  ScreenshotsWidget,
  TopAppsWidget,
  WorkHoursWidget,
  WorkloadWidget,
  type OverviewLoad,
} from "./_components/overview-widgets";

export default function OverviewPage() {
  const { date, teamId } = useGlobalFilters();
  const [tick, setTick] = useState(0);
  const retry = useCallback(() => setTick((n) => n + 1), []);
  // The result is kept with the request it answers; anything else (new filters, a retry) is still loading.
  const key = `${overviewPath(date, teamId)}#${tick}`;
  const [result, setResult] = useState<{ key: string; load: OverviewLoad } | null>(null);
  const load: OverviewLoad = result?.key === key ? result.load : { status: "loading" };

  useEffect(() => {
    let active = true;
    api<OverviewResponse>(overviewPath(date, teamId)).then(
      (data) => active && setResult({ key, load: { status: "ok", data } }),
      (e) => active && setResult({ key, load: { status: "error", message: errorMessage(e), retry } }),
    );
    return () => {
      active = false;
    };
  }, [key, date, teamId, retry]);

  const generated = load.status === "ok" ? new Date(load.data.generatedAt).toLocaleTimeString("en-GB", { timeStyle: "short" }) : null;
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4">
      <GlobalFilters />
      <PageHeader
        title="Overview"
        description="The selected day at a glance, from recorded attendance only. Day figures use each employee's own time zone."
        actions={generated && <span className="text-xs text-muted">Updated {generated}</span>}
        about={
          <>
            Recorded while employees are clocked in and not on a break: attendance, the foreground application name and idle time.
            Screenshots of the main screen only if turned on in Settings and acknowledged by the employee (off by default). Website
            domains (never page addresses or content) only when website tracking is turned on, approved for production and acknowledged
            by the employee; see <Link href="/websites" className="underline">Websites</Link>. No keystrokes or window titles are collected.
            Late and absent come only from an enabled work schedule; missing clock-outs are flagged, never closed automatically.
            Screenshot thumbnails here load like the gallery and every load is recorded in the access log.
          </>
        }
      />
      <KpiStrip load={load} isToday={date === todayLocal()} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <WorkloadWidget load={load} />
        <TopAppsWidget load={load} />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <LateWidget load={load} />
        <AbsentWidget load={load} />
        <MissingClockOutsWidget load={load} />
      </div>
      <ScreenshotsWidget load={load} />
      <WorkHoursWidget load={load} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <HolidaysWidget load={load} />
        <LeavesWidget load={load} />
        <ApprovalsWidget load={load} />
      </div>
    </div>
  );
}
