"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Employee, Paginated } from "@workfolio/shared";
import { Card, Notice } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

export default function OverviewPage() {
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Paginated<Employee>>("/employees?pageSize=1").then((r) => setTotal(r.total), (e) => setError(errorMessage(e)));
  }, []);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Overview</h1>
        <p className="mt-1 text-sm text-muted">Workforce activity at a glance.</p>
      </div>

      <Notice tone="warning">
        Monitoring is limited to attendance and, while employees are clocked in and not on a break, the foreground application
        name and idle time. Screenshots of the main screen only if turned on in Settings and acknowledged by the employee
        (off by default). No keystrokes, window titles or websites are collected.
      </Notice>

      <Card title="Employee overview">
        {error ? (
          <Notice tone="error">{error}</Notice>
        ) : total === null ? (
          <p role="status" className="text-sm text-muted">Loading…</p>
        ) : total === 0 ? (
          <div className="py-6 text-center">
            <p className="font-medium">No employees enrolled</p>
            <p className="mt-1 text-sm text-muted">
              <Link href="/employees/new" className="text-brand underline">Add your first employee</Link>. No activity data is shown until
              real activity is recorded.
            </p>
          </div>
        ) : (
          <p className="text-sm">
            <span className="text-2xl font-semibold">{total}</span> employee{total === 1 ? "" : "s"} enrolled ·{" "}
            <Link href="/employees" className="text-brand underline">Manage employees</Link> ·{" "}
            <Link href="/attendance" className="text-brand underline">View attendance</Link>
          </p>
        )}
      </Card>
    </div>
  );
}
