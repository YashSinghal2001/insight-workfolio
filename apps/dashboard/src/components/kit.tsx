"use client";

/**
 * Shared UI kit for both panels (admin `(admin)/*` and employee `/my/*`). Import from "@/components/kit".
 * Everything is a client component, styled with the theme tokens in globals.css (light + dark).
 *
 * Usage contract (phase-2 pages rely on it):
 * - Layout: the shell (AppShell) already renders <main id="main">. Pages render ONE <h1> via
 *   <PageHeader title description? actions? breadcrumbs?> and wrap content in `mx-auto max-w-6xl flex flex-col gap-6`.
 * - Loading / empty / error: <SkeletonRows label="employees" /> while loading (announces "Loading employees…"),
 *   <EmptyState title hint? action? icon?> for no data, <ErrorState message onRetry?> for failures.
 *   Never fake data: <StatCard label value={null} reason="Not tracked yet" /> renders "—" plus the reason.
 * - Tables: <DataTable label="Employees" head={["Name", …]} minWidth={640}>…<tr/>…</DataTable>. The table
 *   scrolls inside its own wrapper, so the page never scrolls horizontally at 360 px. `label` is the
 *   aria-label (browser suites select tables by it); `caption` adds a visible caption.
 * - Paging: <Pagination page={1} pageCount={n} onPage={setPage} /> (1-based).
 * - Filters: <FilterBar onSubmit?> wraps on mobile; with onSubmit it is a role="search" form.
 * - Destructive actions: <ConfirmDialog open title confirmLabel tone="danger" reason={{ label, minLength }}
 *   onConfirm={async (reason) => …} onClose />. Throwing from onConfirm shows the error inside the dialog;
 *   resolving closes it. Native <dialog>: focus trapped, Escape closes (not while pending), focus returns.
 * - Success feedback: keep <SuccessNotice message={ok} onDismiss={() => setOk(null)} /> mounted
 *   (message null = nothing shown); it is an aria-live polite region.
 * - Tabs: <Tabs label="Views" tabs={[{ id: "today", label: "Today" }]} value onChange idPrefix?>panel</Tabs>
 *   renders buttons `#${idPrefix}-btn-${id}` and the active panel `#${idPrefix}-${id}` (arrow keys, Home, End).
 * - Status: <StatusBadge tone="success|warning|danger|neutral|info">Approved</StatusBadge>.
 * - Buttons: <Button variant="primary|secondary|danger|ghost" pending? disabledReason?>. A disabledReason
 *   disables the button AND shows the reason visibly (and as title / aria-describedby).
 *   Class strings for links styled as buttons: buttonClass, secondaryButtonClass, dangerButtonClass,
 *   ghostButtonClass from "@/components/ui".
 * - Forms: <FormField label hint? error? required?>{(p) => <input {...p} className={inputClass} />}</FormField>
 *   wires id, aria-describedby and aria-invalid.
 */

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import Link from "next/link";
import { buttonClass, dangerButtonClass, ghostButtonClass, inputClass, Notice, secondaryButtonClass } from "@/components/ui";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/* ---------------------------------------------------------------- page header */

export interface Crumb {
  label: string;
  href?: string;
}

export interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumbs?: Crumb[];
}

export function PageHeader({ title, description, actions, breadcrumbs }: PageHeaderProps) {
  return (
    <div className="mb-6 flex flex-col gap-2">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="text-xs text-muted">
          <ol className="flex flex-wrap items-center gap-1">
            {breadcrumbs.map((c, i) => (
              <li key={`${c.label}-${i}`} className="flex items-center gap-1">
                {i > 0 && <span aria-hidden>/</span>}
                {c.href ? (
                  <Link href={c.href} className="hover:text-foreground hover:underline">{c.label}</Link>
                ) : (
                  <span aria-current="page">{c.label}</span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-1 text-sm text-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- loading / empty / error */

export function Skeleton({ className = "h-4 w-full" }: { className?: string }) {
  return <div aria-hidden className={cx("animate-pulse rounded bg-border/70", className)} />;
}

/** Placeholder rows while something loads; announced once as "Loading {label}…". */
export function SkeletonRows({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div role="status" className="flex flex-col gap-3">
      <span className="sr-only">Loading {label}…</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cx("h-10", i % 2 ? "w-11/12" : "w-full")} />
      ))}
    </div>
  );
}

export interface EmptyStateProps {
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}

export function EmptyState({ title, hint, action, icon }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-10 text-center">
      {icon && <div aria-hidden className="text-muted">{icon}</div>}
      <p className="font-medium">{title}</p>
      {hint && <p className="max-w-md text-sm text-muted">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry, title = "Something went wrong" }: { message: string; onRetry?: () => void; title?: string }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-lg border border-danger/40 bg-danger-soft px-4 py-3 text-sm">
      <div>
        <p className="font-medium text-danger">{title}</p>
        <p className="mt-0.5 whitespace-pre-line">{message}</p>
      </div>
      {onRetry && (
        <button type="button" className={`${secondaryButtonClass} bg-surface px-3 py-1`} onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- stats */

export interface StatCardProps {
  label: string;
  /** null/undefined = not available: renders "—" and the reason. Never pass a made-up number. */
  value: ReactNode | null | undefined;
  hint?: ReactNode;
  /** Why the value is missing (shown only when value is null/undefined). */
  reason?: string;
  href?: string;
}

export function StatCard({ label, value, hint, reason, href }: StatCardProps) {
  const missing = value === null || value === undefined;
  const body = (
    <>
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{missing ? <span aria-label="Not available">—</span> : value}</p>
      {missing && reason ? <p className="mt-1 text-xs text-muted">{reason}</p> : hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </>
  );
  const cls = "block rounded-lg border border-border bg-surface px-4 py-3 shadow-xs";
  return href ? (
    <Link href={href} className={`${cls} transition-colors hover:border-brand/50`}>{body}</Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2 lg:grid-cols-4">{children}</div>;
}

/* ---------------------------------------------------------------- table */

export interface DataTableProps {
  /** Accessible name (aria-label); browser suites select tables by it. */
  label: string;
  caption?: ReactNode;
  /** Column headers; omit to render your own <thead> inside children. */
  head?: ReactNode[];
  /** Minimum table width in px before the wrapper scrolls (default 0 = natural). */
  minWidth?: number;
  stickyHeader?: boolean;
  children: ReactNode;
}

export function DataTable({ label, caption, head, minWidth, stickyHeader, children }: DataTableProps) {
  return (
    // relative: visually hidden (absolute) header text stays inside the scroll box instead of widening the page.
    <div className={cx("relative max-w-full overflow-x-auto rounded-lg border border-border bg-surface", stickyHeader && "max-h-[70vh] overflow-y-auto")}>
      <table aria-label={label} className="w-full text-left text-sm" style={minWidth ? { minWidth } : undefined}>
        {caption && <caption className="px-4 pt-3 text-left text-sm text-muted">{caption}</caption>}
        {head && (
          <thead className={cx("bg-surface-muted text-xs text-muted", stickyHeader && "sticky top-0 z-10")}>
            <tr>
              {head.map((h, i) => (
                <th key={i} scope="col" className="border-b border-border px-4 py-2.5 font-medium whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
        )}
        <tbody className="[&_td]:border-b [&_td]:border-border [&_td]:px-4 [&_td]:py-2.5 [&_tr:last-child_td]:border-0">{children}</tbody>
      </table>
    </div>
  );
}

/* ---------------------------------------------------------------- pagination */

export function Pagination({ page, pageCount, onPage, label = "Pagination" }: { page: number; pageCount: number; onPage: (page: number) => void; label?: string }) {
  const last = Math.max(1, pageCount);
  return (
    <nav aria-label={label} className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <button type="button" className={`${secondaryButtonClass} px-3 py-1.5`} disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </button>
      <span aria-live="polite" className="text-muted">Page {Math.min(page, last)} of {last}</span>
      <button type="button" className={`${secondaryButtonClass} px-3 py-1.5`} disabled={page >= last} onClick={() => onPage(page + 1)}>
        Next
      </button>
    </nav>
  );
}

/* ---------------------------------------------------------------- filter bar */

export function FilterBar({ children, label = "Filters", onSubmit }: { children: ReactNode; label?: string; onSubmit?: (e: FormEvent<HTMLFormElement>) => void }) {
  const cls = "flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface px-4 py-3 [&>*]:min-w-0";
  return onSubmit ? (
    <form role="search" aria-label={label} className={cls} onSubmit={(e) => (e.preventDefault(), onSubmit(e))}>{children}</form>
  ) : (
    <div role="group" aria-label={label} className={cls}>{children}</div>
  );
}

/* ---------------------------------------------------------------- confirm dialog */

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  /** Ask for a reason; confirm stays disabled until it has minLength characters (trimmed). */
  reason?: { label: string; minLength?: number; maxLength?: number; placeholder?: string };
  /** Resolve to close; throw to show the error in the dialog. */
  onConfirm: (reason?: string) => void | Promise<void>;
  onClose: () => void;
}

export function ConfirmDialog({ open, title, description, confirmLabel, cancelLabel = "Cancel", tone = "default", reason, onConfirm, onClose }: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      returnTo.current = document.activeElement as HTMLElement | null;
      setText("");
      setError(null);
      setPending(false);
      d.showModal();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  const min = reason?.minLength ?? 1;
  const reasonOk = !reason || text.trim().length >= min;

  async function confirm(e: FormEvent) {
    e.preventDefault();
    if (!reasonOk || pending) return;
    setPending(true);
    setError(null);
    try {
      await onConfirm(reason ? text.trim() : undefined);
      setPending(false);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The action failed. Try again.");
      setPending(false);
    }
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby={`${id}-t`}
      aria-describedby={description ? `${id}-d` : undefined}
      onCancel={(e) => pending && e.preventDefault()}
      onClose={() => {
        if (open) onClose();
        returnTo.current?.focus?.();
      }}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border border-border bg-surface p-0 text-foreground shadow-xl backdrop:bg-black/50"
    >
      {open && (
        <form onSubmit={confirm} className="flex flex-col gap-4 p-5">
          <h2 id={`${id}-t`} className="text-lg font-semibold">{title}</h2>
          {description && <div id={`${id}-d`} className="text-sm text-muted">{description}</div>}
          {reason && (
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">{reason.label}</span>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                required
                minLength={min}
                maxLength={reason.maxLength}
                placeholder={reason.placeholder}
                rows={3}
                aria-describedby={`${id}-h`}
                className={inputClass}
              />
              <span id={`${id}-h`} className="text-xs text-muted">At least {min} character{min === 1 ? "" : "s"}.</span>
            </label>
          )}
          {error && <Notice tone="error">{error}</Notice>}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className={secondaryButtonClass} disabled={pending} onClick={() => onClose()}>
              {cancelLabel}
            </button>
            <button type="submit" className={tone === "danger" ? dangerButtonClass : buttonClass} disabled={!reasonOk || pending} aria-busy={pending}>
              {pending ? "Working…" : confirmLabel}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}

/* ---------------------------------------------------------------- success feedback */

/** Keep mounted; set message to show it (announced politely). Auto-dismisses after `timeoutMs` if onDismiss is given. */
export function SuccessNotice({ message, onDismiss, timeoutMs = 6000 }: { message: string | null; onDismiss?: () => void; timeoutMs?: number }) {
  useEffect(() => {
    if (!message || !onDismiss || !timeoutMs) return;
    const t = setTimeout(onDismiss, timeoutMs);
    return () => clearTimeout(t);
  }, [message, onDismiss, timeoutMs]);
  return (
    <div aria-live="polite" aria-atomic="true">
      {message && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-success/40 bg-success-soft px-4 py-3 text-sm">
          <span>{message}</span>
          {onDismiss && (
            <button type="button" onClick={onDismiss} className="text-xs text-muted underline hover:text-foreground">
              Dismiss
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- tabs */

export interface TabsProps<T extends string> {
  label: string;
  tabs: readonly { id: T; label: ReactNode }[];
  value: T;
  onChange: (id: T) => void;
  /** Element ids: `${idPrefix}-btn-${id}` (tab) and `${idPrefix}-${id}` (panel). Default "tab". */
  idPrefix?: string;
  children?: ReactNode;
}

export function Tabs<T extends string>({ label, tabs, value, onChange, idPrefix = "tab", children }: TabsProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const i = tabs.findIndex((t) => t.id === value);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const t = tabs[(next + tabs.length) % tabs.length]!;
    onChange(t.id);
    listRef.current?.querySelector<HTMLButtonElement>(`#${CSS.escape(`${idPrefix}-btn-${t.id}`)}`)?.focus();
  }
  return (
    <div className="flex flex-col gap-4">
      <div ref={listRef} role="tablist" aria-label={label} onKeyDown={onKeyDown} className="flex max-w-full gap-1 overflow-x-auto border-b border-border">
        {tabs.map((t) => {
          const active = t.id === value;
          return (
            <button
              key={t.id}
              id={`${idPrefix}-btn-${t.id}`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`${idPrefix}-${t.id}`}
              tabIndex={active ? 0 : -1}
              onClick={() => onChange(t.id)}
              className={cx(
                "-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
                active ? "border-brand text-brand" : "border-transparent text-muted hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {children !== undefined && (
        <div role="tabpanel" id={`${idPrefix}-${value}`} aria-labelledby={`${idPrefix}-btn-${value}`} tabIndex={0} className="focus-visible:outline-none">
          {children}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- status badge */

export type Tone = "success" | "warning" | "danger" | "neutral" | "info";

const BADGE: Record<Tone, string> = {
  success: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  warning: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  danger: "bg-red-500/15 text-red-700 dark:text-red-300",
  neutral: "bg-zinc-500/15 text-muted",
  info: "bg-sky-500/15 text-sky-800 dark:text-sky-300",
};

export function StatusBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${BADGE[tone]}`}>{children}</span>;
}

/* ---------------------------------------------------------------- button */

const VARIANT = { primary: buttonClass, secondary: secondaryButtonClass, danger: dangerButtonClass, ghost: ghostButtonClass };

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof VARIANT;
  /** Shows "pendingLabel" (default "Working…") and disables the button. */
  pending?: boolean;
  pendingLabel?: string;
  /** Disables the button and shows why (visible hint + title + aria-describedby). */
  disabledReason?: string | null;
}

export function Button({ variant = "primary", pending, pendingLabel = "Working…", disabledReason, className, disabled, children, type = "button", ...rest }: ButtonProps) {
  const id = useId();
  const button = (
    <button
      {...rest}
      type={type}
      disabled={disabled || pending || !!disabledReason}
      aria-busy={pending || undefined}
      title={disabledReason ?? rest.title}
      aria-describedby={disabledReason ? `${id}-why` : rest["aria-describedby"]}
      className={cx(VARIANT[variant], className)}
    >
      {pending ? pendingLabel : children}
    </button>
  );
  if (!disabledReason) return button;
  return (
    <span className="inline-flex flex-col items-start gap-1">
      {button}
      <span id={`${id}-why`} className="text-xs text-muted">{disabledReason}</span>
    </span>
  );
}

/* ---------------------------------------------------------------- form field */

export interface FieldControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  required?: boolean;
}

export function FormField({ label, hint, error, required, children }: { label: string; hint?: ReactNode; error?: string | null; required?: boolean; children: (props: FieldControlProps) => ReactNode }) {
  const id = useId();
  const describedBy = [hint && `${id}-hint`, error && `${id}-err`].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label htmlFor={id} className="font-medium">
        {label}
        {required && <span aria-hidden className="text-danger"> *</span>}
      </label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined, required })}
      {hint && <span id={`${id}-hint`} className="text-xs text-muted">{hint}</span>}
      {error && <span id={`${id}-err`} className="text-xs font-medium text-danger">{error}</span>}
    </div>
  );
}
