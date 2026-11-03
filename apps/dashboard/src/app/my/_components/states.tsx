"use client";

import type { ReactNode } from "react";
import { ErrorState, SkeletonRows } from "@/components/kit";
import type { Load } from "@/components/my-ui";

/** What an error status means for the employee, added under the API's own message. */
export function explainStatus(status?: number): string | null {
  if (status === 401) return "Your session has ended. Sign in again to continue.";
  if (status === 403) return "Your account is not allowed to see this, or your organization has turned it off. Ask an administrator if you think this is wrong.";
  if (status === 404) return "Not found. It may have been removed.";
  if (status === 409) return "This conflicts with the current records. Reload and check before trying again.";
  if (status !== undefined && status >= 500) return "The server had a problem. Try again in a moment.";
  return null;
}

export const errorText = (message: string, status?: number) => [message, explainStatus(status)].filter(Boolean).join("\n");

/** Kit version of my-ui's Loaded: skeleton while loading ("Loading {label}…"), ErrorState with retry on failure. */
export function Loaded<T>({ load, reload, label, rows = 2, children }: { load: Load<T>; reload?: () => void; label: string; rows?: number; children: (data: T) => ReactNode }) {
  if (load.state === "loading") return <SkeletonRows label={label} rows={rows} />;
  if (load.state === "error") return <ErrorState title={`Could not load ${label}`} message={errorText(load.message, load.status)} onRetry={reload} />;
  return <>{children(load.data)}</>;
}
