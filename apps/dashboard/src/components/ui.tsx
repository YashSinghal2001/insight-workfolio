import type { ReactNode } from "react";

export const inputClass =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-60";
export const buttonClass =
  "inline-flex items-center justify-center rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:opacity-90 focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-50";
export const secondaryButtonClass =
  "inline-flex items-center justify-center rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-background focus-visible:ring-2 focus-visible:ring-brand focus-visible:outline-none disabled:opacity-50";

const TONES = {
  error: "border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200",
  warning: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200",
  success: "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
};

export function Notice({ tone, children }: { tone: keyof typeof TONES; children: ReactNode }) {
  return (
    <div role={tone === "error" ? "alert" : "note"} className={`rounded-lg border px-4 py-3 text-sm whitespace-pre-line ${TONES[tone]}`}>
      {children}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-surface">
      {title && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3">
          <h3 className="font-medium">{title}</h3>
          {actions}
        </div>
      )}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export function Badge({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${
        ok ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-gray-500/15 text-muted"
      }`}
    >
      {children}
    </span>
  );
}

/** UTC timestamp rendered in the employee's own timezone. */
export function formatInZone(iso: string | null, timeZone: string) {
  if (!iso) return "—";
  // dateStyle/timeStyle can't be combined with timeZoneName, so the zone is appended.
  return `${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(iso))} (${timeZone})`;
}
