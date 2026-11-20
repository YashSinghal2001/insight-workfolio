"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PLATFORM_ROLE_LABEL } from "@workfolio/shared";
import { AppShell } from "@/components/app-shell";
import { useAuth } from "@/components/auth-provider";
import { MY_SECTIONS, MyNav } from "@/components/my-nav";
import { buttonClass, secondaryButtonClass } from "@/components/ui";

/** The employee's own dashboard (their data only; every request is authorized again by the API). */
export default function EmployeeLayout({ children }: { children: React.ReactNode }) {
  const { auth, reload, logout } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (auth.status === "anonymous") router.replace(auth.expired ? "/login?expired=1" : "/login");
  }, [auth, router]);

  if (auth.status === "error") {
    return (
      <div role="alert" className="mx-auto mt-24 max-w-sm px-4 text-center">
        <h1 className="font-semibold">Can&apos;t reach Insight Workfolio</h1>
        <p className="mt-1 text-sm text-muted">{auth.message}</p>
        <button type="button" onClick={() => reload()} className={`${buttonClass} mt-4`}>
          Try again
        </button>
      </div>
    );
  }
  if (auth.status !== "authenticated") {
    return <div role="status" className="flex min-h-screen items-center justify-center text-sm text-muted">Checking your session…</div>;
  }
  const { user, employee } = auth.me;
  return (
    <AppShell
      navId="my-nav"
      context="My workspace"
      sections={employee ? MY_SECTIONS(auth.me.teamHead === true) : undefined}
      root="/my"
      nav={employee ? (p) => <MyNav {...p} teamHead={auth.me.teamHead === true} /> : undefined}
      actions={
        <>
          <span className="hidden text-muted xl:inline">{employee ? `${employee.fullName} (${employee.employeeCode})` : user.email}</span>
          <span className="rounded bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand" data-testid="platform-role">{PLATFORM_ROLE_LABEL[user.platformRole]}</span>
          {user.role === "ADMIN" && <Link href="/" className="text-brand hover:underline">Admin dashboard</Link>}
          <button type="button" onClick={() => logout()} className={`${secondaryButtonClass} px-3 py-1`}>Sign out</button>
        </>
      }
    >
      <div className="mx-auto w-full max-w-5xl">
        {employee ? children : <p role="status" className="text-sm text-muted">This account has no employee profile, so there is no personal activity to show.</p>}
      </div>
    </AppShell>
  );
}
