import Link from "next/link";
import { RISK_TRIGGER_LABEL, type RiskUsersResponse } from "@workfolio/shared";
import { formatMinutes } from "@/components/charts";
import { DataTable, EmptyState, StatusBadge } from "@/components/kit";
import { Card } from "@/components/ui";
import { violatedRules } from "@/lib/activity-apps";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Risky users list + "Rules violated" accordion (server-render safe; data from GET /activity/risk-users). */
export function RiskUsersView({ data }: { data: RiskUsersResponse }) {
  if (data.items.length === 0) {
    return <EmptyState title="No risky users in this range." hint="Nobody triggered an alert rule or worked less than the threshold on scheduled days." />;
  }
  const rules = violatedRules(data.rules);
  return (
    <div className="flex flex-col gap-6">
      <Card title="Rules violated">
        <div className="flex flex-col divide-y divide-border">
          {rules.map((r) => (
            <details key={r.trigger} className="group px-3 py-2" data-trigger={r.trigger}>
              <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 text-sm font-medium">
                <span>{r.label}</span>
                <span className="text-xs text-muted tabular-nums">{plural(r.employees, "employee")} · {plural(r.count, "day")}</span>
              </summary>
              <ul className="mt-2 flex flex-col gap-1 text-sm">
                {data.items
                  .filter((i) => i.triggers.some((t) => t.trigger === r.trigger))
                  .map((i) => (
                    <li key={i.employee.id} className="flex flex-wrap justify-between gap-2">
                      <Link href={`/employees/${i.employee.id}`} className="text-brand hover:underline">{i.employee.fullName}</Link>
                      <span className="tabular-nums text-muted">{plural(i.triggers.find((t) => t.trigger === r.trigger)!.count, "day")}</span>
                    </li>
                  ))}
              </ul>
            </details>
          ))}
        </div>
      </Card>
      <DataTable label="Risky users" head={["Employee", "Triggers", "Days", "Average worked per scheduled day"]} minWidth={640}>
        {data.items.map((i) => (
          <tr key={i.employee.id}>
            <td>
              <Link href={`/employees/${i.employee.id}`} className="font-medium text-brand hover:underline">{i.employee.fullName}</Link>{" "}
              <span className="font-mono text-xs text-muted">{i.employee.employeeCode}</span>
            </td>
            <td>
              <span className="flex flex-wrap gap-1">
                {i.triggers.map((t) => <StatusBadge key={t.trigger} tone={t.trigger === "LESS_WORKING_HOURS" ? "danger" : "warning"}>{RISK_TRIGGER_LABEL[t.trigger]} × {t.count}</StatusBadge>)}
              </span>
            </td>
            <td className="tabular-nums">{i.total}</td>
            <td className="tabular-nums">
              {i.lessHours ? `${formatMinutes(i.lessHours.averageWorkedMinutes)} (threshold ${formatMinutes(i.lessHours.thresholdMinutes)}, ${plural(i.lessHours.scheduledDays, "scheduled day")})` : "—"}
            </td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}
