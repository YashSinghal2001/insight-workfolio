"use client";

import { useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/kit";
import { buttonClass } from "@/components/ui";
import { weekRange } from "@/components/range-picker";
import { ActivityOverview } from "../_components/activity-overview";

export default function ReportsPage() {
  const [overviewRange] = useState(() => weekRange());
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader
        title="Reports"
        description="Scheduled email reports (worked hours, late clock-in, absent) are configured under Scheduled reports."
        actions={<Link href="/reports/scheduled" className={buttonClass}>Scheduled reports</Link>}
      />
      <section aria-labelledby="activity-overview-title" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="activity-overview-title" className="text-lg font-semibold">Activity overview (this week)</h2>
          <Link href="/activity" className="text-sm text-brand hover:underline">Open Activity for other ranges</Link>
        </div>
        <p className="text-xs text-muted">Read-only, on this page only: it is not part of the email reports, which never include application activity.</p>
        <ActivityOverview range={overviewRange} />
      </section>
    </div>
  );
}
