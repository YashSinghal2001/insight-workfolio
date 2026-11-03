"use client";

import { useAuth } from "@/components/auth-provider";
import { EmptyState } from "@/components/kit";

/**
 * W41/F09 "My team": only for the head of an active team. UX gate only; the API scopes every request to
 * the members of the teams the caller heads (404 outside them, 403 for non-heads).
 */
export default function TeamLayout({ children }: { children: React.ReactNode }) {
  const { auth } = useAuth();
  if (auth.status !== "authenticated" || !auth.me.teamHead) {
    return <EmptyState title="This area is for team heads." hint="You do not head an active team. Ask an administrator if you think this is wrong." />;
  }
  return <div className="flex flex-col gap-6">{children}</div>;
}
