"use client";

import { useState } from "react";
import { formatDuration, localDate, MAX_RANGE_DAYS, totalMs, type Project, type TimeEndReason, type TimeEntry, type TimerState } from "@workfolio/shared";
import { RangePicker, weekRange, type Range } from "@/components/range-picker";
import { DataTable, EmptyState, PageHeader, StatusBadge } from "@/components/kit";
import { dayLabel, timeIn, UpdatedAt, useApi, useMe } from "@/components/my-ui";
import { Card, formatInZone } from "@/components/ui";
import { Loaded } from "../_components/states";

/** Same wording as the desktop app. */
const ENDED: Record<TimeEndReason, string> = { PAUSED: "Paused", STOPPED: "Stopped", BREAK: "Ended by your break", CLOCK_OUT: "Ended by clock-out" };

function CurrentTimer({ tz }: { tz: string }) {
  const { load, reload } = useApi<TimerState>("/task-time/current");
  return (
    <section aria-label="Current timer">
      <Card title="Current timer" actions={load.state === "ready" ? <UpdatedAt at={load.at} /> : undefined}>
        <Loaded load={load} reload={reload} label="your timer">
          {(s) => (
            <div className="flex flex-col gap-2 text-sm">
              {s.running ? (
                <p>
                  <StatusBadge tone="success">Running</StatusBadge> <strong>{s.running.task.title}</strong> · {s.running.project.name}{" "}
                  <span className="text-muted">since {formatInZone(s.running.startedAt, tz)}</span>
                </p>
              ) : (
                <p className="font-medium">No timer running</p>
              )}
              {!s.running && s.paused && (
                <p className="text-muted">Last paused: {s.paused.task.title} · {s.paused.project.name} at {formatInZone(s.paused.endedAt, tz)}</p>
              )}
              <p className="text-xs text-muted">
                Attendance: {s.attendance.clockedIn ? (s.attendance.onBreak ? "clocked in, on a break" : "clocked in") : "not clocked in"}. Timers are started, paused
                and stopped in the Insight Workfolio desktop app (only while clocked in and not on a break); a break or clock-out ends a running timer.
              </p>
            </div>
          )}
        </Loaded>
      </Card>
    </section>
  );
}

function AssignedTasks() {
  const { load, reload } = useApi<Project[]>("/task-time/assignments");
  return (
    <Card title="Assigned tasks">
      <Loaded load={load} reload={reload} label="your tasks">
        {(projects) => {
          const tasks = projects.flatMap((p) => p.tasks.map((t) => ({ ...t, project: p })));
          return tasks.length === 0 ? (
            <EmptyState title="No open tasks on your projects." />
          ) : (
            <DataTable label="My tasks" head={["Task", "Project", "Status"]}>
              {tasks.map((t) => (
                <tr key={t.id}>
                  <td>{t.title}</td>
                  <td>{t.project.name} <span className="font-mono text-xs text-muted">{t.project.code}</span></td>
                  <td><StatusBadge tone={t.status === "OPEN" ? "info" : "neutral"}>{t.status === "OPEN" ? "Open" : "Closed"}</StatusBadge></td>
                </tr>
              ))}
            </DataTable>
          );
        }}
      </Loaded>
    </Card>
  );
}

function Entries({ tz }: { tz: string }) {
  const [range, setRange] = useState<Range>(() => weekRange(0, tz));
  const { load, reload } = useApi<TimeEntry[]>(`/task-time/entries?from=${range.from}&to=${range.to}`);
  return (
    <Card title="Recorded time" actions={load.state === "ready" ? <UpdatedAt at={load.at} /> : undefined}>
      <div className="flex flex-col gap-4">
        <RangePicker value={range} onChange={setRange} timeZone={tz} maxDays={MAX_RANGE_DAYS} />
        <Loaded load={load} reload={reload} label="your time entries">
          {(entries) =>
            entries.length === 0 ? (
              <EmptyState title="No task time recorded in this period." />
            ) : (
              <>
                <p className="text-sm">
                  Total: <strong className="tabular-nums">{formatDuration(totalMs(entries))}</strong>{" "}
                  <span className="text-xs text-muted">(completed entries; times in {tz}). Timer time is wall-clock time, not a productivity measure.</span>
                </p>
                <DataTable label="My time entries" head={["Date", "Project", "Task", "Start", "End", "Duration", "How it ended"]}>
                  {entries.map((e) => (
                    <tr key={e.id}>
                      <td className="whitespace-nowrap">{dayLabel(localDate(Date.parse(e.startedAt), tz))}</td>
                      <td>{e.project.name}</td>
                      <td>{e.task.title}</td>
                      <td className="tabular-nums">{timeIn(e.startedAt, tz)}</td>
                      <td className="tabular-nums">{timeIn(e.endedAt, tz)}</td>
                      <td className="tabular-nums">{e.durationMs === null ? "Running" : formatDuration(e.durationMs)}</td>
                      <td>{e.endReason ? ENDED[e.endReason] : "—"}</td>
                    </tr>
                  ))}
                </DataTable>
              </>
            )
          }
        </Loaded>
      </div>
    </Card>
  );
}

/** The signed-in employee's task timer state, assigned tasks and recorded task time (read-only). */
export default function MyTasksPage() {
  const me = useMe();
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="My tasks" description="Your current timer, the open tasks you can log time on, and the time you recorded." />
      <CurrentTimer tz={me.timezone} />
      <AssignedTasks />
      <Entries tz={me.timezone} />
    </div>
  );
}
