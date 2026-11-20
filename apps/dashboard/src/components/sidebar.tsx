"use client";

import { can } from "@workfolio/shared";
import { ShellNav, type NavProps, type NavSection } from "@/components/app-shell";
import { useAuth } from "@/components/auth-provider";

/**
 * Admin navigation, grouped per the contract route map (docs/IMPLEMENTATION-CONTRACTS.md §6). Only routes that
 * exist are listed; whoever builds a new page adds its one-line entry. Labels and hrefs are asserted by browser
 * suites (`nav a` text). Settings sub-pages live in the Settings sub-menu (SETTINGS_NAV).
 */
export const ADMIN_NAV: readonly NavSection[] = [
  { title: "Realtime", items: [{ label: "Overview", href: "/" }, { label: "Live team", href: "/live-team" }] },
  {
    title: "Attendance",
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
      { label: "Screenshots", href: "/screenshots" },
      { label: "Websites", href: "/websites" },
    ],
  },
  { title: "Work", items: [{ label: "Projects", href: "/projects" }] },
  { title: "Reports", items: [{ label: "Reports", href: "/reports" }, { label: "Alerts", href: "/alerts" }] },
  { title: "People", items: [{ label: "Employees", href: "/employees" }, { label: "Teams", href: "/teams" }, { label: "Devices", href: "/devices" }, { label: "Roles", href: "/roles" }] },
  {
    title: "Admin",
    items: [
      { label: "Notifications", href: "/notifications" },
      { label: "Audit", href: "/audit" },
      { label: "Desktop updates", href: "/desktop-updates" },
      { label: "Settings", href: "/settings" },
      { label: "My account", href: "/account" },
    ],
  },
];

/** Settings sub-menu (`<SubNav>` in app/(admin)/settings/layout.tsx). */
export const SETTINGS_NAV = [
  { label: "General", href: "/settings" },
  { label: "Work schedule", href: "/settings/schedule" },
  { label: "Monitoring & notices", href: "/settings/monitoring" },
  { label: "Screenshots & masks", href: "/settings/screenshots" },
  { label: "App labels", href: "/settings/labels" },
  { label: "Website policy", href: "/settings/websites" },
  { label: "Storage", href: "/settings/storage" },
  { label: "Email & notifications", href: "/settings/notifications" },
  { label: "Leave types", href: "/settings/leave-types" },
] as const;

/** The admin sidebar (`nav#admin-nav[aria-label="Main"]`). Without props it is the desktop sidebar only. */
export function Sidebar(props: NavProps = {}) {
  const { auth } = useAuth();
  // Roles is Super Admin only (the API refuses everyone else); do not offer the link.
  const roles = auth.status === "authenticated" && can(auth.me.user, "roles:manage");
  const sections = roles ? ADMIN_NAV : ADMIN_NAV.map((s) => ({ ...s, items: s.items.filter((i) => i.href !== "/roles") }));
  return <ShellNav id="admin-nav" label="Main" title="Admin" sections={sections} root="/" {...props} />;
}
