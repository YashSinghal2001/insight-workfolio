"use client";

import { can } from "@workfolio/shared";
import { ShellNav, type NavProps, type NavSection } from "@/components/app-shell";
import { useAuth } from "@/components/auth-provider";

/** Admin navigation, grouped. Labels and hrefs are asserted by browser suites (`nav a` text). */
export const ADMIN_NAV: readonly NavSection[] = [
  { title: "Overview", items: [{ label: "Overview", href: "/" }] },
  { title: "People", items: [{ label: "Employees", href: "/employees" }, { label: "Devices", href: "/devices" }, { label: "Teams", href: "/teams" }, { label: "Roles", href: "/roles" }] },
  {
    title: "Time",
    items: [
      { label: "Attendance", href: "/attendance" },
      { label: "Timesheets", href: "/timesheets" },
      { label: "Corrections", href: "/corrections" },
      { label: "Leave", href: "/leave" },
      { label: "Holidays", href: "/holidays" },
    ],
  },
  {
    title: "Monitoring",
    items: [
      { label: "Activity", href: "/activity" },
      { label: "Websites", href: "/websites" },
      { label: "Screenshots", href: "/screenshots" },
    ],
  },
  { title: "Work", items: [{ label: "Projects", href: "/projects" }] },
  { title: "Reports", items: [{ label: "Reports", href: "/reports" }, { label: "Scheduled reports", href: "/reports/scheduled" }, { label: "Alerts", href: "/alerts" }] },
  {
    title: "Administration",
    items: [
      { label: "Audit", href: "/audit" },
      { label: "Notifications", href: "/notifications" },
      { label: "Settings", href: "/settings" },
      { label: "Work schedule", href: "/settings/schedule" },
      { label: "App labels", href: "/settings/labels" },
      { label: "Desktop app updates", href: "/desktop-updates" },
      { label: "My account", href: "/account" },
    ],
  },
];

/** The admin sidebar (`nav#admin-nav[aria-label="Main"]`). Without props it is the desktop sidebar only. */
export function Sidebar(props: NavProps = {}) {
  const { auth } = useAuth();
  // Roles is Super Admin only (the API refuses everyone else); do not offer the link.
  const roles = auth.status === "authenticated" && can(auth.me.user, "roles:manage");
  const sections = roles ? ADMIN_NAV : ADMIN_NAV.map((s) => ({ ...s, items: s.items.filter((i) => i.href !== "/roles") }));
  return <ShellNav id="admin-nav" label="Main" title="Admin" sections={sections} root="/" {...props} />;
}
