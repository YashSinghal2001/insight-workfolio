"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { ActivityAppHistoryResponse, ActivityAppsResponse } from "@workfolio/shared";
import { BarChart, DonutChart, formatDurationMs, StackedBar } from "@/components/charts";
import { DataTable, EmptyState, ErrorState, SkeletonRows, StatCard, StatGrid, type DataColumn } from "@/components/kit";
import type { Range } from "@/components/range-picker";
import { Card, inputClass } from "@/components/ui";
import { appDonut, categoryShare, historyBars, unreviewed } from "@/lib/activity-apps";
import { api, errorMessage } from "@/lib/api";

export type AppsLoad = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; data: ActivityAppsResponse };
type Row = ActivityAppsResponse["employees"][number];

const employeeHref = (id: string) => `/activity?tab=employee&employeeId=${id}`;

/** Loading / error states shared by the tabs that read GET /activity/apps. */
function Gate({ load, onRetry, children }: { load: AppsLoad; onRetry?: () => void; children: (d: ActivityAppsResponse) => React.ReactNode }) {
  if (load.status === "loading") return <SkeletonRows label="app usage" />;
  if (load.status === "error") return <ErrorState message={load.message} onRetry={onRetry} />;
  return <>{children(load.data)}</>;
}

const LabelsHint = () => (
  <p className="text-xs text-muted">
    No application labels yet: everything is Unclassified. <Link href="/settings/labels" className="underline">Set up application labels</Link>.
  </p>
);

/** Top apps donut (slices coloured by label) and the label share of active time. */
export function SummaryCharts({ load, onRetry }: { load: AppsLoad; onRetry?: () => void }) {
  return (
    <Gate load={load} onRetry={onRetry}>
      {(d) => (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Top applications">
            <DonutChart label="Top applications by active time" data={appDonut(d.applications)} format={formatDurationMs} centerLabel="Active" empty="No application activity in this range." />
          </Card>
          <Card title="Productive, neutral and unproductive share">
            <StackedBar label="Label share of active time" mode="percent" format={formatDurationMs} {...categoryShare(d, 5)} empty="No application activity in this range." />
            {!d.categoriesConfigured && <LabelsHint />}
          </Card>
        </div>
      )}
    </Gate>
  );
}

const COLUMNS: readonly DataColumn<Row>[] = [
  {
    header: "Employee",
    cell: (r) => (
      <>
        <Link href={employeeHref(r.employee.id)} className="font-medium text-brand hover:underline">{r.employee.fullName}</Link>{" "}
        <span className="font-mono text-xs text-muted">{r.employee.employeeCode}</span>
      </>
    ),
    sortValue: (r) => r.employee.fullName,
  },
  { header: "Active", cell: (r) => formatDurationMs(r.activeMs), sortValue: (r) => r.activeMs },
  { header: "Idle", cell: (r) => formatDurationMs(r.idleMs), sortValue: (r) => r.idleMs },
  { header: "Productive", cell: (r) => formatDurationMs(r.categories.PRODUCTIVE), sortValue: (r) => r.categories.PRODUCTIVE },
  { header: "Neutral", cell: (r) => formatDurationMs(r.categories.NEUTRAL), sortValue: (r) => r.categories.NEUTRAL },
  { header: "Unproductive", cell: (r) => formatDurationMs(r.categories.UNPRODUCTIVE), sortValue: (r) => r.categories.UNPRODUCTIVE },
  { header: "Unclassified", cell: (r) => formatDurationMs(r.categories.UNCLASSIFIED), sortValue: (r) => r.categories.UNCLASSIFIED },
  { header: "Top application", cell: (r) => r.topApplication ?? <span className="text-muted">—</span>, sortValue: (r) => r.topApplication },
];

/** Usage per employee, sortable by any column (most active first). */
export function EmployeesTab({ load, onRetry }: { load: AppsLoad; onRetry?: () => void }) {
  return (
    <Gate load={load} onRetry={onRetry}>
      {(d) =>
        d.employees.length === 0 ? (
          <EmptyState title="No employees in this scope." />
        ) : (
          <div className="flex flex-col gap-2">
            {!d.categoriesConfigured && <LabelsHint />}
            <DataTable label="Usage per employee" columns={COLUMNS} rows={d.employees} rowKey={(r) => r.employee.id} defaultSort={{ column: 1, direction: "desc" }} minWidth={880} />
          </div>
        )
      }
    </Gate>
  );
}

/** Apps without a label, largest first; labels are edited in Settings (not here). */
export function ReviewTab({ load, onRetry }: { load: AppsLoad; onRetry?: () => void }) {
  return (
    <Gate load={load} onRetry={onRetry}>
      {(d) => {
        const list = unreviewed(d.applications);
        return (
          <div className="flex flex-col gap-4">
            <StatGrid>
              <StatCard label="Unreviewed applications" value={String(list.length)} hint={`Used in this range without a label (of ${d.applications.length} applications)`} href="/settings/labels" />
              <StatCard label="Unclassified active time" value={formatDurationMs(d.categories.UNCLASSIFIED)} />
            </StatGrid>
            <p className="text-sm">
              Add a label for an application by its ID or name in <Link href="/settings/labels" className="text-brand underline">Settings › App labels</Link>; labels apply to past activity too.
            </p>
            {list.length === 0 ? (
              <EmptyState title="Every application used in this range has a label." />
            ) : (
              <DataTable label="Unreviewed applications" head={["Application", "Application ID", "Active time", "Employees"]} minWidth={560}>
                {list.slice(0, 50).map((a) => (
                  <tr key={a.key}>
                    <td>{a.applicationName}</td>
                    <td className="font-mono text-xs break-all">{a.applicationIdentifier ?? "—"}</td>
                    <td className="tabular-nums">{formatDurationMs(a.activeMs)}</td>
                    <td className="tabular-nums">{a.employees}</td>
                  </tr>
                ))}
              </DataTable>
            )}
          </div>
        );
      }}
    </Gate>
  );
}

/** Pick an application → active time per day (everyone) and per employee per day. */
export function HistoryTab({ load, range, teamId, onRetry }: { load: AppsLoad; range: Range; teamId: string | null; onRetry?: () => void }) {
  const [app, setApp] = useState("");
  const apps = load.status === "ok" ? load.data.applications : [];
  const key = apps.some((a) => a.key === app) ? app : (apps[0]?.key ?? "");
  return (
    <Gate load={load} onRetry={onRetry}>
      {() =>
        apps.length === 0 ? (
          <EmptyState title="No application activity in this range." />
        ) : (
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-muted">Application</span>
              <select value={key} onChange={(e) => setApp(e.target.value)} className={`${inputClass} w-auto max-w-full`} aria-label="Application">
                {apps.map((a) => <option key={a.key} value={a.key}>{a.applicationName} ({formatDurationMs(a.activeMs)})</option>)}
              </select>
            </label>
            <AppHistory key={`${key}|${range.from}|${range.to}|${teamId ?? ""}`} app={key} range={range} teamId={teamId} />
          </div>
        )
      }
    </Gate>
  );
}

function AppHistory({ app, range, teamId }: { app: string; range: Range; teamId: string | null }) {
  const [data, setData] = useState<ActivityAppHistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    const q = new URLSearchParams({ from: range.from, to: range.to, app });
    if (teamId) q.set("teamId", teamId);
    api<ActivityAppHistoryResponse>(`/activity/apps/history?${q}`).then((r) => live && (setData(r), setError(null)), (e) => live && setError(errorMessage(e)));
    return () => void (live = false);
  }, [app, range, teamId, retry]);
  if (error) return <ErrorState message={error} onRetry={() => setRetry((n) => n + 1)} />;
  if (!data) return <SkeletonRows label="app history" />;
  return <AppHistoryView data={data} />;
}

export function AppHistoryView({ data }: { data: ActivityAppHistoryResponse }) {
  const name = data.applicationName ?? data.key;
  return (
    <>
      <Card title={`${name}: active time per day`}>
        <BarChart label={`${name} active time per day`} series={[{ label: "Active time" }]} data={historyBars(data.days)} format={formatDurationMs} empty="Not used in this range." />
      </Card>
      {data.employees.length > 0 && (
        <DataTable label="App history per employee" head={["Employee", "Active time", "Days used"]} minWidth={560}>
          {data.employees.map((e) => (
            <tr key={e.employee.id}>
              <td><Link href={employeeHref(e.employee.id)} className="font-medium text-brand hover:underline">{e.employee.fullName}</Link></td>
              <td className="tabular-nums">{formatDurationMs(e.activeMs)}</td>
              <td className="text-xs">
                <ul className="flex flex-wrap gap-x-3 gap-y-1">
                  {e.days.map((d) => <li key={d.date} className="tabular-nums whitespace-nowrap">{d.date.slice(5)}: {formatDurationMs(d.activeMs)}</li>)}
                </ul>
              </td>
            </tr>
          ))}
        </DataTable>
      )}
      <p className="text-xs text-muted">Dates are each employee&apos;s own local dates. Application names only; no window titles.</p>
    </>
  );
}
