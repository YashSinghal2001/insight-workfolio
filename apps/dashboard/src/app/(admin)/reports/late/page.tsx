"use client";

import { PageHeader } from "@/components/kit";
import { GlobalFilters, useGlobalFilters } from "@/components/global-filters";
import { LateTab } from "../../attendance/_components/late";

/** The Attendance page's Late tab as a report (same component, same props). */
export default function LateReport() {
  const { teamId } = useGlobalFilters();
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <GlobalFilters date={false} />
      <PageHeader title="Late clock-ins" description="Clock-ins after the expected start plus grace, newest first (at most 92 days)." />
      <LateTab teamId={teamId} />
    </div>
  );
}
