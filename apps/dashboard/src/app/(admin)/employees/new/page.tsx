"use client";

import { useState } from "react";
import Link from "next/link";
import type { CreateEmployeeResponse } from "@workfolio/shared";
import { EmployeeForm, SetupLinkNotice } from "@/components/employee-form";
import { Card } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

export default function NewEmployeePage() {
  const [created, setCreated] = useState<CreateEmployeeResponse | null>(null);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <Link href="/employees" className="text-sm text-muted hover:underline">← Employees</Link>
        <h1 className="mt-1 text-2xl font-semibold">Add employee</h1>
      </div>

      {created ? (
        <>
          <SetupLinkNotice setup={created.setup} email={created.employee.email} />
          <div className="flex gap-4 text-sm">
            <Link href={`/employees/${created.employee.id}`} className="text-brand underline">View {created.employee.fullName}</Link>
            <button type="button" onClick={() => setCreated(null)} className="text-brand underline">Add another</button>
          </div>
        </>
      ) : (
        <Card>
          <p className="mb-4 text-sm text-muted">
            No password is set here. The employee receives a one-time link to choose their own password.
          </p>
          <EmployeeForm
            submitLabel="Create employee"
            onSubmit={async ({ email, fullName, employeeCode, timezone }) => {
              try {
                setCreated(await api<CreateEmployeeResponse>("/employees", { method: "POST", body: { email, fullName, employeeCode, timezone } }));
                return null;
              } catch (err) {
                return errorMessage(err);
              }
            }}
          />
        </Card>
      )}
    </div>
  );
}
