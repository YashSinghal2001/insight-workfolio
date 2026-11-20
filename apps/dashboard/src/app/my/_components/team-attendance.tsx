import { formatDuration, type LateArrivalsResponse, type MissingClockOutsResponse } from "@workfolio/shared";
import { DataTable, EmptyState, StatusBadge } from "@/components/kit";
import { formatInZone } from "@/components/ui";
import { reasonText } from "@/lib/attendance-ui";

/** Team-head sections of /my/team/attendance (read-only; same team-scoped endpoints as the admin tabs). */
export function LateList({ data }: { data: LateArrivalsResponse }) {
  if (!data.items.length) return <EmptyState title="No late arrivals in these 7 days." hint="Nobody is late without an enabled work schedule." />;
  return (
    <DataTable label="Late arrivals" head={["Member", "Date", "Due by", "First clock-in", "Late by"]} minWidth={560}>
      {data.items.map((r) => (
        <tr key={`${r.employee.id}-${r.date}`}>
          <td>
            <span className="font-medium">{r.employee.fullName}</span>
            <div className="font-mono text-xs text-muted">{r.employee.employeeCode}</div>
          </td>
          <td className="tabular-nums">{r.date}</td>
          <td className="tabular-nums">{r.dueLocal}</td>
          <td className="tabular-nums">{r.firstClockInLocal}</td>
          <td className="tabular-nums">{r.lateMinutes} min</td>
        </tr>
      ))}
    </DataTable>
  );
}

/** Flag only: heads cannot file or approve corrections; the member requests one, an administrator approves. */
export function MissingList({ data }: { data: MissingClockOutsResponse }) {
  if (!data.items.length) return <EmptyState title="No missing clock-outs." hint="Every open shift looks current." />;
  return (
    <DataTable label="Missing clock-outs" head={["Member", "Clocked in", "Open for", "Why flagged", "Correction"]} minWidth={720}>
      {data.items.map((a) => (
        <tr key={a.sessionId}>
          <td>
            <span className="font-medium">{a.employee.fullName}</span>
            <div className="font-mono text-xs text-muted">{a.employee.employeeCode}</div>
          </td>
          <td>{formatInZone(a.clockInAt, a.employee.timezone)}</td>
          <td className="tabular-nums">{formatDuration(a.openForMinutes * 60_000)}</td>
          <td>
            <ul className="flex flex-wrap gap-1">
              {a.reasons.map((r) => {
                const t = reasonText(r, data.thresholds);
                return <li key={r} title={t.explain}><StatusBadge tone="danger">{t.label}</StatusBadge></li>;
              })}
            </ul>
          </td>
          <td>{a.pendingCorrectionId ? <StatusBadge tone="info">Pending review</StatusBadge> : <span className="text-xs text-muted">None requested</span>}</td>
        </tr>
      ))}
    </DataTable>
  );
}
