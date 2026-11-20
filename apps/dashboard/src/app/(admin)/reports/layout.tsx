"use client";

import { SubNav } from "@/components/sub-nav";

const REPORTS_NAV = [
  { label: "Activity overview", href: "/reports" },
  { label: "Daily attendance", href: "/reports/daily-attendance" },
  { label: "Monthly attendance", href: "/reports/monthly-attendance" },
  { label: "Monthly in/out", href: "/reports/monthly-in-out" },
  { label: "Late clock-ins", href: "/reports/late" },
  { label: "Overtime", href: "/reports/overtime" },
  { label: "Summary", href: "/reports/summary" },
  { label: "Scheduled reports", href: "/reports/scheduled" },
];

/** Reports sub-menu beside every reports page (an inner column from 1024 px). */
export default function ReportsLayout({ children }: LayoutProps<"/reports">) {
  return (
    <div className="lg:flex lg:gap-6">
      <SubNav label="Reports" items={REPORTS_NAV} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
