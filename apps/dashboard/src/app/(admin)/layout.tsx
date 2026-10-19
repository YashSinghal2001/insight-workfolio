"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ApiStatus } from "@/components/api-status";
import { useAuth } from "@/components/auth-provider";
import { Sidebar } from "@/components/sidebar";
import { buttonClass, secondaryButtonClass } from "@/components/ui";

/** Client-side gate for UX only; every request is authorized again by the API. */
export default function AdminLayout({ children }: LayoutProps<"/">) {
  const { auth, reload, logout } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (auth.status === "anonymous") router.replace("/login");
  }, [auth.status, router]);

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
    return (
      <div role="alert" className="mx-auto mt-24 max-w-md px-4 text-center">
        <h1 className="text-lg font-semibold">Access denied</h1>
        <p className="mt-2 text-sm text-muted">
          The admin dashboard is for administrators. Signed in as {user.email}. Employees use the Insight
          Workfolio desktop app.
        </p>
        <button type="button" onClick={() => logout()} className={`${secondaryButtonClass} mt-4`}>
          Sign out
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3 md:px-8">
          <p className="text-lg font-semibold">
            Insight <span className="text-brand">Workfolio</span>
          </p>
          <div className="flex flex-wrap items-center gap-4">
            <ApiStatus />
            <span className="hidden text-sm text-muted sm:inline">{user.email}</span>
            <button type="button" onClick={() => logout()} className={`${secondaryButtonClass} px-3 py-1`}>
              Sign out
            </button>
          </div>
        </header>
        <main className="flex-1 px-4 py-6 md:px-8">{children}</main>
      </div>
    </div>
  );
}
