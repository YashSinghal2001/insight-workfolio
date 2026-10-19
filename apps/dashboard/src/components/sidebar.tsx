"use client";

import { Suspense } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { label: "Overview", href: "/" },
  { label: "Employees", href: "/employees" },
  { label: "Attendance", href: "/attendance" },
  { label: "Activity", href: "/activity" },
  { label: "Timesheets", href: "/timesheets" },
  { label: "Corrections", href: "/corrections" },
  { label: "Screenshots", href: "/screenshots" },
  { label: "Settings", href: "/settings" },
];

function NavLinks({ pathname }: { pathname: string | null }) {
  return NAV.map(({ label, href }) => {
    const active = href === "/" ? pathname === "/" : pathname?.startsWith(href);
    return (
      <Link
        key={label}
        href={href}
        aria-current={active ? "page" : undefined}
        className={`rounded-md px-3 py-2 text-sm whitespace-nowrap ${
          active ? "bg-brand/10 font-medium text-brand" : "hover:bg-background"
        }`}
      >
        {label}
      </Link>
    );
  });
}

function ActiveNavLinks() {
  return <NavLinks pathname={usePathname()} />;
}

export function Sidebar() {
  return (
    <aside className="border-b border-border bg-surface md:w-56 md:shrink-0 md:border-r md:border-b-0">
      <div className="hidden px-5 py-4 text-sm font-semibold tracking-wide text-muted uppercase md:block">Admin</div>
      <nav aria-label="Main" className="flex gap-1 overflow-x-auto px-3 py-2 md:flex-col md:py-0">
        {/* usePathname suspends under dynamic routes (cacheComponents); fall back to unhighlighted links. */}
        <Suspense fallback={<NavLinks pathname={null} />}>
          <ActiveNavLinks />
        </Suspense>
      </nav>
    </aside>
  );
}
