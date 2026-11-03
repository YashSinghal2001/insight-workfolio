"use client";

import { PLATFORM_ROLE_LABEL } from "@workfolio/shared";
import { useAuth } from "@/components/auth-provider";
import { PageHeader } from "@/components/kit";
import { SessionsCard } from "@/components/sessions-card";
import { Card } from "@/components/ui";

/** The signed-in administrator's own account. Admins may have no employee profile. */
export default function AccountPage() {
  const { auth } = useAuth();
  if (auth.status !== "authenticated") return null;
  const { user, employee } = auth.me;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <PageHeader title="My account" description="Your sign-in details and active sessions." />
      <Card title="Account">
        <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[12rem_1fr]">
          <dt className="text-muted">Email</dt>
          <dd className="break-words">{user.email}</dd>
          <dt className="text-muted">Role</dt>
          <dd>{PLATFORM_ROLE_LABEL[user.platformRole]}</dd>
        </dl>
      </Card>
      <SessionsCard timeZone={employee?.timezone} />
    </div>
  );
}
