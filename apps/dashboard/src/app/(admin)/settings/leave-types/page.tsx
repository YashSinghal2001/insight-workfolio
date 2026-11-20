"use client";

import Link from "next/link";
import { PageHeader } from "@/components/kit";
import { LeaveTypes } from "./leave-types";

/** Leave types (yearly allowance, monthly short-leave quota). Balances and requests stay on the Leave page. */
export default function LeaveTypeSettingsPage() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <PageHeader
        title="Leave types"
        description={<>Balances and requests are on the <Link href="/leave" className="text-brand underline">Leave page</Link>.</>}
      />
      <LeaveTypes />
    </div>
  );
}
