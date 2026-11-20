"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { leaveTallyLabel, LEAVE_STATUSES, MAX_RANGE_DAYS, type Device, type EmployeeAnalyticsResponse, type EmployeeClockLogEntry } from "@workfolio/shared";
import { BarChart, DonutChart, formatMinutes, formatPercent } from "@/components/charts";
import { activeDevice, OS_LABEL } from "@/components/devices";
import { DataTable, EmptyState, ErrorState, SkeletonRows, StatCard, StatGrid, StatusBadge } from "@/components/kit";
import { RangePicker, type Range } from "@/components/range-picker";
import { Card, formatInZone } from "@/components/ui";

/** A request's state: loading (both null), loaded, or failed. */
export interface Loadable<T> {
  data: T | null;
  error: string | null;
}

const NO_ACTIVITY = "Needs activity access";

function SourceBadge({ e }: { e: EmployeeClockLogEntry }) {
  if (e.open) return <StatusBadge tone="info">Open</StatusBadge>;
  if (e.corrected || e.source === "CORRECTION") return <StatusBadge tone="warning">Corrected</StatusBadge>;
  if (e.source === "OFFLINE_SYNC") return <StatusBadge tone="neutral">Offline sync</StatusBadge>;
  return <StatusBadge tone="success">Desktop</StatusBadge>;
}

/** Overview tab of /employees/[id]: KPIs, charts, clock log, corrections, leave and devices. Each widget handles its own state. */
export function ProfileOverview({
  employeeId,
  timeZone,
  range,
  onRange,
  analytics,
  onRetry,
  devices,
  onEditTab,
}: {
  employeeId: string;
  timeZone: string;
  range: Range;
  onRange: (r: Range) => void;
  analytics: Loadable<EmployeeAnalyticsResponse>;
  onRetry: () => void;
  devices: Loadable<Device[]>;
  onEditTab: () => void;
}) {
  const a = analytics.data;
  const widget = (label: string, body: (d: EmployeeAnalyticsResponse) => ReactNode) =>
    analytics.error ? <ErrorState title={`Could not load ${label}`} message={analytics.error} onRetry={onRetry} /> : a ? body(a) : <SkeletonRows label={label} />;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <RangePicker value={range} onChange={onRange} maxDays={MAX_RANGE_DAYS} timeZone={timeZone} />
        <p className="text-xs text-muted">Dates in the employee&apos;s time zone ({timeZone}).</p>
      </div>

      <section aria-label="Key figures">
        {widget("key figures", (d) => (
          <StatGrid>
            <StatCard label="Total worked" value={formatMinutes(d.kpis.workedMinutes)} hint={`${d.kpis.daysWorked} ${d.kpis.daysWorked === 1 ? "day" : "days"} with a shift; breaks excluded`} />
            <StatCard label="Active time" value={d.kpis.activeMinutes === null ? null : formatMinutes(d.kpis.activeMinutes)} reason={NO_ACTIVITY} hint="Keyboard or mouse use recorded by the desktop app" />
            <StatCard label="Idle time" value={d.kpis.idleShare === null ? null : formatPercent(d.kpis.idleShare)} reason={d.kpis.activeMinutes === null ? NO_ACTIVITY : "No activity recorded"} hint="Share of recorded activity that was idle" />
            <StatCard label="Productive apps" value={d.kpis.productiveShare === null ? null : formatPercent(d.kpis.productiveShare)} reason={d.kpis.activeMinutes === null ? NO_ACTIVITY : "No application labels configured"} hint="Productive app time over clocked-in time" />
            <StatCard label="Typical clock-in" value={d.kpis.typicalFirstInLocal} reason="No shifts in this range" hint="Median first clock-in of the day" />
            <StatCard label="Typical clock-out" value={d.kpis.typicalLastOutLocal} reason="No completed shifts" hint="Median last clock-out of the day" />
          </StatGrid>
        ))}
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="Worked hours per day">
          {widget("worked hours", (d) => (
            <BarChart
              label="Worked and break time per day"
              series={[{ label: "Worked", color: "var(--success)" }, { label: "Break", color: "var(--warning)" }]}
              data={d.days.map((x) => ({ label: x.date.slice(5), values: [x.workedMinutes, x.breakMinutes] }))}
              format={formatMinutes}
              empty="No shifts in this range."
            />
          ))}
        </Card>
        <Card title="Applications used">
          {widget("applications", (d) =>
            d.topApps === null ? (
              <EmptyState title="Not available" hint="Application usage needs activity access." />
            ) : (
              <DonutChart label="Top applications by active time" data={d.topApps.map((x) => ({ label: x.applicationName, value: x.activeMinutes }))} format={formatMinutes} empty="No application activity in this range." />
            ),
          )}
        </Card>
      </div>

      <Card title="Clock-in and clock-out log">
        {widget("clock log", (d) =>
          d.clockLog.length ? (
            <DataTable
              label="Clock-in and clock-out log"
              minWidth={520}
              rows={d.clockLog}
              rowKey={(e) => e.sessionId}
              columns={[
                { header: "Date", cell: (e) => e.date, sortValue: (e) => e.clockInAt },
                { header: "Start", cell: (e) => e.startLocal },
                { header: "End", cell: (e) => e.endLocal ?? "—" },
                { header: "Worked", cell: (e) => `${formatMinutes(e.workedMinutes)}${e.open ? " so far" : ""}`, sortValue: (e) => e.workedMinutes },
                { header: "Break", cell: (e) => formatMinutes(e.breakMinutes) },
                { header: "Source", cell: (e) => <SourceBadge e={e} /> },
              ]}
            />
          ) : (
            <EmptyState title="No shifts in this range" hint="Pick another range above." />
          ),
        )}
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card title="Corrections">
          {widget("corrections", (d) => (
            <div className="flex flex-col gap-2 text-sm">
              <p>
                Requested in range: <span className="font-medium">{d.corrections.PENDING}</span> pending · {d.corrections.APPROVED} approved · {d.corrections.REJECTED} rejected
              </p>
              <Link href={`/corrections?employeeId=${employeeId}`} className="text-brand underline">Open corrections</Link>
            </div>
          ))}
        </Card>
        <Card title="Leave">
          {widget("leave", (d) =>
            d.leave === null ? (
              <p className="text-sm text-muted">Leave needs leave access.</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {LEAVE_STATUSES.filter((s) => s !== "CANCELLED").map((s) => (
                  <li key={s} className="flex justify-between gap-2">
                    <span className="text-muted">{s[0] + s.slice(1).toLowerCase()}</span>
                    <span className="tabular-nums">{leaveTallyLabel(d.leave![s])}</span>
                  </li>
                ))}
              </ul>
            ),
          )}
        </Card>
        <Card title="Devices">
          {devices.error ? (
            <ErrorState title="Could not load devices" message={devices.error} />
          ) : !devices.data ? (
            <SkeletonRows label="devices" />
          ) : (
            <div className="flex flex-col gap-2 text-sm">
              <p>{devices.data.length} registered</p>
              <p className="text-muted">
                {(() => {
                  const active = activeDevice(devices.data);
                  return active ? `Signed in on ${active.deviceName} (${OS_LABEL[active.platform] ?? active.platform}) since ${formatInZone(active.sessionStartedAt, timeZone)}.` : "Not signed in on any device.";
                })()}
              </p>
              <button type="button" onClick={onEditTab} className="self-start text-brand underline">Manage devices</button>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
