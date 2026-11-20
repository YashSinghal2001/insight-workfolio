"use client";

import { ShellNav, type NavProps } from "@/components/app-shell";

/** Employee navigation: own records only. Deliberately separate from the admin sidebar. */
export const MY_NAV = [
  { label: "Dashboard", href: "/my" },
  { label: "Attendance", href: "/my/attendance" },
  { label: "Activity", href: "/my/activity" },
  { label: "Websites", href: "/my/websites" },
  { label: "Screenshots", href: "/my/screenshots" },
  { label: "Projects", href: "/my/projects" },
  { label: "Tasks", href: "/my/tasks" },
  { label: "Leave", href: "/my/leave" },
  { label: "Reports", href: "/my/reports" },
  { label: "Profile", href: "/my/profile" },
] as const;

const [dashboard, attendance, activity, websites, screenshots, projects, tasks, leave, reports, profile] = MY_NAV;
const SECTIONS = [
  { items: [dashboard] },
  { title: "Time", items: [attendance, leave] },
  { title: "My activity", items: [activity, websites, screenshots] },
  { title: "Work", items: [projects, tasks, reports] },
  { title: "Account", items: [profile] },
];

/** W41/F09: shown only to the head of an active team; every request is team-scoped again by the API. */
export const TEAM_NAV = [
  { label: "My team", href: "/my/team" },
  { label: "Team attendance", href: "/my/team/attendance" },
  { label: "Team timesheets", href: "/my/team/timesheets" },
  { label: "Team screenshots", href: "/my/team/screenshots" },
  { label: "Team leave", href: "/my/team/leave" },
] as const;
const WITH_TEAM = [...SECTIONS.slice(0, -1), { title: "My team", items: TEAM_NAV }, SECTIONS.at(-1)!];
export const MY_SECTIONS = (teamHead: boolean) => (teamHead ? WITH_TEAM : SECTIONS);

/** The employee nav (`nav#my-nav[aria-label="My workspace"]`, exactly the 10 MY_NAV links, plus TEAM_NAV for team heads). */
export function MyNav({ teamHead = false, ...props }: NavProps & { teamHead?: boolean } = {}) {
  return <ShellNav id="my-nav" label="My workspace" title="My workspace" sections={MY_SECTIONS(teamHead)} root="/my" {...props} />;
}
