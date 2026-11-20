"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import type { RiskUsersResponse } from "@workfolio/shared";
import { GlobalFilters, useGlobalFilters } from "@/components/global-filters";
import { ErrorState, PageHeader, SkeletonRows } from "@/components/kit";
import { RangePicker, weekRange, type Range } from "@/components/range-picker";
import { api, errorMessage } from "@/lib/api";
import { RiskUsersView } from "./risk-users-view";

export default function RiskUsersPage() {
  // useSearchParams (global filters) suspends for request-time params under cacheComponents.
  return (
    <Suspense fallback={<SkeletonRows label="risk users" />}>
      <RiskUsers />
    </Suspense>
  );
}

function RiskUsers() {
  const { teamId } = useGlobalFilters();
  // Default: the last four weeks (this week and the three before).
  const [range, setRange] = useState<Range>(() => ({ from: weekRange(-3).from, to: weekRange().to }));
  const [retry, setRetry] = useState(0);
  const key = `${range.from}|${range.to}|${teamId ?? ""}|${retry}`;
  const [state, setState] = useState<{ key: string; data?: RiskUsersResponse; error?: string } | null>(null);

  useEffect(() => {
    let live = true;
    const q = new URLSearchParams({ from: range.from, to: range.to });
    if (teamId) q.set("teamId", teamId);
    api<RiskUsersResponse>(`/activity/risk-users?${q}`).then(
      (data) => live && setState({ key, data }),
      (e) => live && setState({ key, error: errorMessage(e) }),
    );
    return () => void (live = false);
  }, [range, teamId, key]);
  const current = state?.key === key ? state : null;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader
        title="Risk users"
        description="Employees who triggered an alert rule or worked noticeably less than scheduled in the range."
        actions={<Link href="/alerts" className="text-sm text-brand hover:underline">Configure alert rules</Link>}
        about={
          <>
            Computed when you open this page; nothing extra is collected or stored. Two sources: <strong>alerts</strong> raised by your{" "}
            <Link href="/alerts" className="underline">alert rules</Link> in the range (late clock-in, not clocked in by a time, high idle share, no
            activity while clocked in), counted as one per rule kind and day; and <strong>less working hours</strong>: the average worked time per
            scheduled day is below 7/8 of the scheduled day (7 h of 8 h). Scheduled days are the days the work schedule expects work (present, late or
            absent); holidays, approved leave, rest days, days before the employee joined and shifts still open never count, and nothing triggers
            without an enabled work schedule. Dates are each employee&apos;s own local dates. This is a prompt to talk, not a judgement of performance;
            no application names, websites or screenshots are used.
          </>
        }
      />
      <GlobalFilters date={false} />
      <RangePicker value={range} maxDays={92} onChange={setRange} />
      {!current && <SkeletonRows label="risk users" />}
      {current?.error && <ErrorState message={current.error} onRetry={() => setRetry((n) => n + 1)} />}
      {current?.data && <RiskUsersView data={current.data} />}
    </div>
  );
}
