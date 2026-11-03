"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PLATFORM_ROLE_LABEL } from "@workfolio/shared";
import { ApiStatus } from "@/components/api-status";
import { AppShell } from "@/components/app-shell";
import { useAuth } from "@/components/auth-provider";
import { Sidebar } from "@/components/sidebar";
import { buttonClass, secondaryButtonClass } from "@/components/ui";

/** Client-side gate for UX only; every request is authorized again by the API. */
export default function AdminLayout({ children }: LayoutProps<"/">) {
  const { auth, reload, logout } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (auth.status === "anonymous") router.replace(auth.expired ? "/login?expired=1" : "/login");
    if (auth.status === "authenticated" && auth.me.user.role !== "ADMIN") router.replace("/my");
  }, [auth, router]);

  if (auth.status === "loading" || auth.status === "anonymous") {
    return (
      <div role="status" className="flex min-h-screen items-center justify-center text-sm text-muted">
        Checking your session…
      </div>
    );
  }

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

  const { user } = auth.me;
  if (user.role !== "ADMIN") {
    // Employees have their own dashboard; the API refuses them every admin route anyway.
    return (
      <div role="status" className="mx-auto mt-24 max-w-md px-4 text-center text-sm">
        <p>This area is for administrators. Signed in as {user.email}.</p>
        <Link href="/my" className={`${buttonClass} mt-4`}>Open my dashboard</Link>
        <button type="button" onClick={() => logout()} className={`${secondaryButtonClass} mt-4 ml-2`}>
          Sign out
        </button>
      </div>
    );
  }

  return (
    <AppShell
      navId="admin-nav"
      context="Admin"
      nav={(p) => <Sidebar {...p} />}
      actions={
        <>
          <ApiStatus />
          <span className="hidden text-muted lg:inline">{user.email}</span>
          <span className="rounded bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand" data-testid="platform-role">{PLATFORM_ROLE_LABEL[user.platformRole]}</span>
          {auth.me.employee && <Link href="/my" className="text-brand hover:underline">My workspace</Link>}
          <button type="button" onClick={() => logout()} className={`${secondaryButtonClass} px-3 py-1`}>
            Sign out
          </button>
        </>
      }
    >
      {children}
    </AppShell>
  );
}
