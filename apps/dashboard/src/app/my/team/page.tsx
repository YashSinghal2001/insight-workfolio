"use client";

import Link from "next/link";
import { formatDuration, type AttendanceSummary, type Employee, type Paginated } from "@workfolio/shared";
import { DataTable, EmptyState, PageHeader, StatCard, StatGrid } from "@/components/kit";
import { useApi } from "@/components/my-ui";
import { Loaded } from "../_components/states";

/** Team members and today's counts for the teams the signed-in head leads. */
export default function TeamPage() {
  const members = useApi<Paginated<Employee>>("/employees?pageSize=100");
  const summary = useApi<AttendanceSummary>("/attendance/summary");
  return (
    <>
      <PageHeader title="My team" description="Members of the teams you head. Read-only, except leave decisions. Times use each member's own time zone." />
      <Loaded load={summary.load} reload={summary.reload} label="team summary">
        {(s) => (
          <StatGrid>
            <StatCard label="Members" value={s.totalActiveEmployees} />
            <StatCard label="Working now" value={s.currentlyWorking} hint={`${s.onBreak} on break`} href="/my/team/attendance" />
            <StatCard label="Worked today" value={formatDuration(s.netWorkMsToday)} hint={`${s.notClockedInToday} not clocked in today`} />
            <StatCard label="Pending leave" value={s.pendingLeaveCount} href="/my/team/leave" />
          </StatGrid>
        )}
      </Loaded>
      <Loaded load={members.load} reload={members.reload} label="team members">
        {(page) =>
          page.items.length === 0 ? (
            <EmptyState title="Your team has no members yet." hint="An administrator adds members under People → Teams." />
          ) : (
            <DataTable label="Team members" head={["Member", "Email", "Time zone", ""]} minWidth={640}>
              {page.items.map((e) => (
                <tr key={e.id}>
                  <td>
                    <span className="font-medium">{e.fullName}</span>
                    <div className="font-mono text-xs text-muted">{e.employeeCode}</div>
                  </td>
                  <td>{e.email}</td>
                  <td>{e.timezone}</td>
                  <td className="text-right text-sm">
                    <Link href={`/my/team/screenshots?employeeId=${e.id}`} className="text-brand hover:underline">Screenshots</Link>
                  </td>
                </tr>
              ))}
            </DataTable>
          )
        }
      </Loaded>
    </>
  );
}
