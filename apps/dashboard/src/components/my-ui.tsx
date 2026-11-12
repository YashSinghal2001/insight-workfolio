"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Employee } from "@workfolio/shared";
import { useAuth } from "@/components/auth-provider";
import { api, ApiRequestError, errorMessage } from "@/lib/api";
import { Notice, secondaryButtonClass } from "@/components/ui";

/**
 * Shared building blocks of the employee panel (/my/*). Identity always comes from the server
 * session (/auth/me); pages never take an employee id from the URL or storage.
 */

/** The signed-in employee (the /my layout renders pages only when the account has a profile). */
export function useMe(): Employee {
  const { auth } = useAuth();
  if (auth.status !== "authenticated" || !auth.me.employee) throw new Error("useMe outside the employee layout");
  return auth.me.employee;
}

export type Load<T> =
  | { state: "loading" }
  | { state: "error"; message: string; status?: number }
  | { state: "ready"; data: T; at: number };

/** GET a path (null = skip) with loading / error / ready states and a manual reload. */
export function useApi<T>(path: string | null) {
  const [load, setLoad] = useState<Load<T>>({ state: "loading" });
  const run = useCallback(async () => {
    if (!path) return;
    setLoad({ state: "loading" });
    try {
      setLoad({ state: "ready", data: await api<T>(path), at: Date.now() });
    } catch (err) {
      setLoad({ state: "error", message: errorMessage(err), status: err instanceof ApiRequestError ? err.status : undefined });
    }
  }, [path]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on path change
    void run();
  }, [run]);
  return { load, reload: run };
}

/** Same component as the kit's (breadcrumbs optional); kept here for existing imports. */
export { PageHeader } from "@/components/kit";

/** Renders the right state for a Load; children only get ready data. */
export function Loaded<T>({ load, reload, label, children }: { load: Load<T>; reload?: () => void; label: string; children: (data: T) => ReactNode }) {
  if (load.state === "loading") return <p role="status" className="text-sm text-muted">Loading {label}…</p>;
  if (load.state === "error") {
    return (
      <div className="flex flex-col items-start gap-2">
        <Notice tone="error">Could not load {label}: {load.message}</Notice>
        {reload && <button type="button" className={`${secondaryButtonClass} px-3 py-1`} onClick={reload}>Try again</button>}
      </div>
    );
  }
  return <>{children(load.data)}</>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted">{children}</p>;
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

/** Time of the last load, in the employee's time zone (the browser's only when the account has no profile). */
export function UpdatedAt({ at }: { at: number }) {
  const { auth } = useAuth();
  const timeZone = auth.status === "authenticated" ? auth.me.employee?.timezone : undefined;
  return <span className="text-xs text-muted">Updated {new Date(at).toLocaleTimeString(undefined, { timeZone })}</span>;
}

/** Simple responsive table: scrolls horizontally on small screens. */
export function Table({ label, head, children }: { label: string; head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table aria-label={label} className="w-full text-left text-sm">
        <thead className="text-xs text-muted">
          <tr>{head.map((h) => <th key={h} scope="col" className="border-b border-border px-2 py-2 font-medium whitespace-nowrap">{h}</th>)}</tr>
        </thead>
        <tbody className="[&_td]:border-b [&_td]:border-border [&_td]:px-2 [&_td]:py-2">{children}</tbody>
      </table>
    </div>
  );
}

/** Time of day in the employee's zone, e.g. "09:05". */
export const timeIn = (iso: string | null, timeZone: string) =>
  iso ? new Intl.DateTimeFormat("en-GB", { timeStyle: "short", timeZone }).format(new Date(iso)) : "—";

/** "Mon 27 Oct 2026" for a local date (YYYY-MM-DD). */
export const dayLabel = (date: string) =>
  new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
