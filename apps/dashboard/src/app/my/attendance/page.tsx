"use client";

import { useState } from "react";
import {
  addDays,
  attendanceTotals,
  formatDuration,
  localDate,
  MAX_RANGE_DAYS,
  todayIn,
  weekStart,
  type AttendanceCurrent,
  type AttendanceSession,
  type CorrectionRequest,
  type Paginated,
  type TimesheetResponse,
} from "@workfolio/shared";
import { DataTable, EmptyState, PageHeader, StatCard, StatGrid, StatusBadge, SuccessNotice } from "@/components/kit";
import { dayLabel, timeIn, UpdatedAt, useApi, useMe } from "@/components/my-ui";
import { RangePicker, type Range } from "@/components/range-picker";
import { Card } from "@/components/ui";
import { CORRECTION_TYPE_LABEL as TYPE_LABEL, CorrectionForm } from "../_components/correction-form";
import { Loaded } from "../_components/states";

const PAGE_SIZE = 100;
const FIELD_LABEL: Record<string, string> = { clockInAt: "Clock-in", clockOutAt: "Clock-out", startedAt: "Break start", endedAt: "Break end", breakEndedAt: "Break end" };
const STATUS = { PENDING: { label: "Pending", tone: "warning" }, APPROVED: { label: "Approved", tone: "success" }, REJECTED: { label: "Rejected", tone: "danger" } } as const;

/** Date and time in the employee's zone, e.g. "27 Oct 2026, 09:05". */
const dateTime = (iso: string, timeZone: string) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(iso));

/** Own attendance, timesheet and correction requests. Read-only: recorded by the desktop app. */
export default function MyAttendancePage() {
  const me = useMe();
  const tz = me.timezone;
  const [range, setRange] = useState<Range>(() => {
    const from = weekStart(todayIn(tz));
    return { from, to: addDays(from, 6) };
  });
  const current = useApi<AttendanceCurrent>("/attendance/current");
  const sheet = useApi<TimesheetResponse>(`/attendance/timesheet?from=${range.from}&to=${range.to}`);
  const history = useApi<Paginated<AttendanceSession>>(`/attendance/history?from=${range.from}&to=${range.to}&pageSize=${PAGE_SIZE}`);
  const corrections = useApi<Paginated<CorrectionRequest>>(`/attendance/corrections?mine=true&pageSize=${PAGE_SIZE}`);
  const [ok, setOk] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="My attendance" description={`Times are shown in your time zone (${tz}).`} />
      <p role="note" className="rounded-lg border border-border bg-surface px-4 py-3 text-sm">
        Attendance is recorded by the Insight Workfolio desktop app (clock in, breaks, clock out). It cannot be changed here; to fix a mistake, request a correction below. Nothing changes until an administrator approves it.
      </p>

      <Card title="Right now" actions={current.load.state === "ready" && <UpdatedAt at={current.load.at} />}>
        <Loaded load={current.load} reload={current.reload} label="your attendance state">
          {(c) => <CurrentState current={c} tz={tz} />}
        </Loaded>
      </Card>

      <Card title="Timesheet">
        <div className="flex flex-col gap-4">
          <RangePicker value={range} onChange={setRange} timeZone={tz} maxDays={MAX_RANGE_DAYS} />
          <Loaded load={sheet.load} reload={sheet.reload} label="your timesheet">
            {(s) => <TimesheetView sheet={s} />}
          </Loaded>
        </div>
      </Card>

      <Card title="Attendance history">
        <Loaded load={history.load} reload={history.reload} label="your attendance history">
          {(h) => <HistoryView page={h} tz={tz} />}
        </Loaded>
      </Card>

      <Card title="Request a correction">
        <div className="flex flex-col gap-3">
          <SuccessNotice message={ok} onDismiss={() => setOk(null)} timeoutMs={0} />
          <Loaded load={history.load} reload={history.reload} label="your shifts">
            {(h) => (
              <CorrectionForm
                sessions={h.items}
                tz={tz}
                onCreated={(r) => {
                  setOk(`Correction requested (${TYPE_LABEL[r.type]}). An administrator will review it; your records change only if it is approved.`);
                  void corrections.reload();
                }}
              />
            )}
          </Loaded>
        </div>
      </Card>

      <Card title="Correction requests">
        <Loaded load={corrections.load} reload={corrections.reload} label="your correction requests">
          {(p) => <CorrectionsView items={p.items} total={p.total} tz={tz} />}
        </Loaded>
      </Card>
    </div>
  );
}

function CurrentState({ current, tz }: { current: AttendanceCurrent; tz: string }) {
  const s = current.session;
  const openBreak = s?.breaks.find((b) => !b.endedAt);
  const text =
    current.state === "ON_BREAK"
      ? `On a break since ${openBreak ? timeIn(openBreak.startedAt, tz) : "—"} (shift started ${s ? dateTime(s.clockInAt, tz) : "—"})`
      : current.state === "CLOCKED_IN"
        ? `Clocked in since ${s ? dateTime(s.clockInAt, tz) : "—"} (open shift)`
        : s?.clockOutAt
          ? `Clocked out. Last shift ended ${dateTime(s.clockOutAt, tz)}.`
          : "Clocked out. No shifts recorded yet.";
  return <p data-testid="my-attendance-state" className="text-sm font-medium">{text}</p>;
}

function TimesheetView({ sheet }: { sheet: TimesheetResponse }) {
  const t = sheet.totals;
  return (
    <div className="flex flex-col gap-4">
      <StatGrid>
        <StatCard label="Worked (completed shifts)" value={formatDuration(t.netMs)} />
        <StatCard label="Breaks" value={formatDuration(t.breakMs)} />
        <StatCard label="Shifts" value={t.shifts} hint={t.incompleteDays ? `${t.incompleteDays} day(s) with an open shift, not counted` : undefined} />
      </StatGrid>
      {sheet.days.length === 0 ? (
        <EmptyState title="No shifts in this period." />
      ) : (
        <DataTable label="My timesheet" head={["Date", "Worked", "Breaks", "Sessions", "Notes"]}>
          {sheet.weeks.map((w) => {
            const days = sheet.days.filter((d) => d.date >= w.weekStart && d.date < addDays(w.weekStart, 7));
            if (!days.length) return null;
            return [
              ...days.map((d) => (
                <tr key={d.date}>
                  <td className="whitespace-nowrap">{dayLabel(d.date)}</td>
                  <td className="tabular-nums">{formatDuration(d.netMs)}</td>
                  <td className="tabular-nums">{formatDuration(d.breakMs)}</td>
                  <td className="tabular-nums">{d.shifts}</td>
                  <td className="text-xs text-muted">{[d.incomplete && "Open shift (not counted)", d.corrected && "Corrected", d.offlineShifts > 0 && "Synced offline"].filter(Boolean).join(" · ")}</td>
                </tr>
              )),
              <tr key={`w-${w.weekStart}`} className="font-medium">
                <td className="whitespace-nowrap">Week of {dayLabel(w.weekStart)}</td>
                <td className="tabular-nums">{formatDuration(w.netMs)}</td>
                <td className="tabular-nums">{formatDuration(w.breakMs)}</td>
                <td className="tabular-nums">{w.shifts}</td>
                <td className="text-xs text-muted">Week total</td>
              </tr>,
            ];
          })}
        </DataTable>
      )}
      <p className="text-xs text-muted">Shifts count on the day they started. Open shifts are not counted until you clock out.</p>
    </div>
  );
}

function HistoryView({ page, tz }: { page: Paginated<AttendanceSession>; tz: string }) {
  if (!page.items.length) return <EmptyState title="No work sessions in this period." />;
  return (
    <div className="flex flex-col gap-2">
      <DataTable label="My attendance history" head={["Date", "Clock-in", "Clock-out", "Worked", "Breaks", "Notes"]}>
        {page.items.map((s) => {
          const open = s.status === "OPEN" || !s.clockOutAt;
          const net = open ? null : attendanceTotals({ start: s.clockInAt, end: s.clockOutAt }, s.breaks.map((b) => ({ start: b.startedAt, end: b.endedAt }))).netMs;
          return (
            <tr key={s.id}>
              <td className="whitespace-nowrap">{dayLabel(localDate(s.clockInAt, tz))}</td>
              <td className="tabular-nums">{timeIn(s.clockInAt, tz)}</td>
              <td className="tabular-nums">{open ? <StatusBadge tone="warning">Open</StatusBadge> : dateTime(s.clockOutAt!, tz)}</td>
              <td className="tabular-nums">{net === null ? <span className="text-muted">Not counted (open)</span> : formatDuration(net)}</td>
              <td>
                {s.breaks.length === 0 ? (
                  <span className="text-muted">None</span>
                ) : (
                  <ul className="flex flex-col gap-0.5">
                    {s.breaks.map((b) => (
                      <li key={b.id} className="whitespace-nowrap tabular-nums">
                        {timeIn(b.startedAt, tz)}–{b.endedAt ? `${timeIn(b.endedAt, tz)} (${formatDuration(Date.parse(b.endedAt) - Date.parse(b.startedAt))})` : "ongoing"}
                      </li>
                    ))}
                  </ul>
                )}
              </td>
              <td className="text-xs text-muted">
                {[s.corrected && "Corrected", s.clockInSource === "OFFLINE_SYNC" && "Synced offline", s.clockInSource === "CORRECTION" && "Added by correction"].filter(Boolean).join(" · ")}
              </td>
            </tr>
          );
        })}
      </DataTable>
      {page.total > page.items.length && <p className="text-xs text-muted">Showing the {page.items.length} most recent of {page.total} sessions. Choose a shorter period to see the rest.</p>}
    </div>
  );
}

function CorrectionsView({ items, total, tz }: { items: CorrectionRequest[]; total: number; tz: string }) {
  if (!items.length) return <EmptyState title="You have not requested any corrections." />;
  return (
    <div className="flex flex-col gap-2">
      <DataTable label="My correction requests" head={["Requested", "Type", "Requested change", "Reason", "Status", "Review"]}>
        {items.map((c) => (
          <tr key={c.id}>
            <td className="whitespace-nowrap">{dateTime(c.requestedAt, tz)}</td>
            <td className="whitespace-nowrap">{TYPE_LABEL[c.type]}</td>
            <td>
              <ul className="flex flex-col gap-0.5">
                {Object.entries(c.proposed).map(([k, v]) => <li key={k} className="whitespace-nowrap">{FIELD_LABEL[k] ?? k}: {dateTime(v, tz)}</li>)}
              </ul>
            </td>
            <td className="max-w-xs break-words">{c.reason}</td>
            <td><StatusBadge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</StatusBadge></td>
            <td className="text-xs text-muted">{c.reviewedAt ? `${dateTime(c.reviewedAt, tz)}${c.reviewReason ? `: ${c.reviewReason}` : ""}` : "Not reviewed yet"}</td>
          </tr>
        ))}
      </DataTable>
      {total > PAGE_SIZE && <p className="text-xs text-muted">Showing the {PAGE_SIZE} most recent requests.</p>}
    </div>
  );
}
